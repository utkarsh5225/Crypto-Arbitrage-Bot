import WebSocket from "ws";
import { logger } from "./logger";
import { store, type TopOpportunity } from "./store";
import { sseManager } from "./sse-manager";
import { getCredentials } from "./credentials";
import { executeLiveTrade } from "./live-execution";

interface PriceEntry {
  bid: number;
  ask: number;
}

interface TradingPair {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

/**
 * Per-symbol filter data extracted from Binance exchange info.
 * Used by live-execution.ts to apply correct quantity precision for each leg.
 */
export interface SymbolFilters {
  /** Decimal places for the quote asset (used for quoteOrderQty in BUY orders). */
  quotePrecision: number;
  /** Decimal places for the base asset quantity (used for quantity in SELL orders). */
  basePrecision: number;
  /**
   * Step size for base quantity from MARKET_LOT_SIZE (or LOT_SIZE fallback).
   * 0 means no constraint beyond basePrecision.
   */
  lotStepSize: number;
}

const symbolFilters = new Map<string, SymbolFilters>();

/**
 * Returns precision/lot-size filters for a symbol.
 * Falls back to conservative defaults (8/8 decimal, no step) if the symbol
 * was not found in exchange info.
 */
export function getSymbolFilters(symbol: string): SymbolFilters {
  return symbolFilters.get(symbol) ?? { quotePrecision: 8, basePrecision: 8, lotStepSize: 0 };
}

interface Triangle {
  /** Full path including return: e.g. ["USDT","BTC","ETH","USDT"] */
  path: string[];
  /** 3 trading pair symbols */
  symbols: [string, string, string];
  /**
   * Direction for each leg.
   * true  = buy base with quote  → use ASK price; amount /= ask
   * false = sell base get quote  → use BID price; amount *= bid
   */
  buys: [boolean, boolean, boolean];
}

const BASE_CURRENCIES = ["USDT", "BTC", "ETH", "BNB"] as const;
// The all-symbols !bookTicker stream is silently blocked on shared IPs.
// Instead, open multiple WS connections each subscribing to ≤200 symbols.
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";
const BINANCE_EXCHANGE_URL = "https://api.binance.com/api/v3/exchangeInfo";
const MAX_SYMBOLS_PER_CONNECTION = 200; // 247 stayed stable; 500 gets dropped — keep well under that

// Cooldown: don't trade the same triangle within this window to avoid rapid-fire doubles
const TRADE_COOLDOWN_MS = 5_000;

// Auto-kill after this many consecutive live trade failures
const MAX_CONSECUTIVE_FAILURES = 3;

/** Counts back-to-back live trade failures; reset to 0 on any success. */
let consecutiveLiveFailures = 0;

const priceMap = new Map<string, PriceEntry>();
let symbolToTriangles = new Map<string, Triangle[]>();
let exchangeInfoLoaded = false;

let wsConns: WebSocket[] = [];
let reconnectTimer: NodeJS.Timeout | null = null;

/** Per-triangle cooldown: path key → last traded timestamp */
const recentlyTraded = new Map<string, number>();

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Returns a map of asset → USDT mid-price for all XUSDT pairs currently tracked.
 * Used by the account balances route to estimate portfolio value.
 */
export function getUsdtPrices(): Map<string, number> {
  const result = new Map<string, number>();
  result.set("USDT", 1);
  for (const [symbol, entry] of priceMap) {
    if (symbol.endsWith("USDT") && !symbol.startsWith("USDT")) {
      const asset = symbol.slice(0, -4);
      const mid = (entry.bid + entry.ask) / 2;
      if (mid > 0) result.set(asset, mid);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Triangle building
// ---------------------------------------------------------------------------

function buildIndex(pairs: TradingPair[]): Map<string, Triangle[]> {
  // lookup: "A/B" → pair (regardless of which is base/quote)
  const lookup = new Map<string, TradingPair>();
  for (const p of pairs) {
    lookup.set(`${p.baseAsset}/${p.quoteAsset}`, p);
    lookup.set(`${p.quoteAsset}/${p.baseAsset}`, p);
  }

  // adjacency: currency → all pairs that include it
  const adj = new Map<string, TradingPair[]>();
  for (const p of pairs) {
    for (const c of [p.baseAsset, p.quoteAsset]) {
      if (!adj.has(c)) adj.set(c, []);
      adj.get(c)!.push(p);
    }
  }

  const index = new Map<string, Triangle[]>();
  const seen = new Set<string>();
  let total = 0;

  for (const start of BASE_CURRENCIES) {
    for (const p1 of adj.get(start) ?? []) {
      const mid = p1.baseAsset === start ? p1.quoteAsset : p1.baseAsset;
      const buy1 = p1.baseAsset === mid;

      for (const p2 of adj.get(mid) ?? []) {
        if (p2.symbol === p1.symbol) continue;
        const end = p2.baseAsset === mid ? p2.quoteAsset : p2.baseAsset;
        if (end === start || end === mid) continue;

        const p3 =
          lookup.get(`${end}/${start}`) ?? lookup.get(`${start}/${end}`);
        if (!p3 || p3.symbol === p1.symbol || p3.symbol === p2.symbol) continue;

        const key = `${start}/${mid}/${end}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const buy2 = p2.baseAsset === end;
        const buy3 = p3.baseAsset === start;

        const tri: Triangle = {
          path: [start, mid, end, start],
          symbols: [p1.symbol, p2.symbol, p3.symbol],
          buys: [buy1, buy2, buy3],
        };

        for (const sym of tri.symbols) {
          if (!index.has(sym)) index.set(sym, []);
          index.get(sym)!.push(tri);
        }
        total++;
      }
    }
  }

  logger.info({ triangles: total }, "Triangle index built");
  return index;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function evalTriangle(
  tri: Triangle,
): { grossPct: number; netPct: number; prices: number[] } | null {
  const { feeRate } = store.config;
  let amount = 1.0;
  const prices: number[] = [];

  for (let i = 0; i < 3; i++) {
    const entry = priceMap.get(tri.symbols[i]);
    if (!entry || entry.ask === 0 || entry.bid === 0) return null;

    if (tri.buys[i]) {
      prices.push(entry.ask);
      amount /= entry.ask;
    } else {
      prices.push(entry.bid);
      amount *= entry.bid;
    }
  }

  const grossPct = amount - 1;
  const netPct = grossPct - 3 * feeRate;
  return { grossPct, netPct, prices };
}

// ---------------------------------------------------------------------------
// Symbol update handler
// ---------------------------------------------------------------------------

// Tracks the best result per triangle path within the current 2-second window.
const windowCandidates = new Map<string, TopOpportunity>();

function checkSymbol(symbol: string): void {
  const triangles = symbolToTriangles.get(symbol);
  if (!triangles?.length) return;

  const { minProfitThreshold, notionalSize } = store.config;
  store.incrementPaths(triangles.length);

  const now = new Date().toISOString();

  for (const tri of triangles) {
    const result = evalTriangle(tri);
    if (!result) continue;

    // ── Window-best tracking (always, regardless of threshold) ──────────────
    const pathKey = `${tri.path[0]}/${tri.path[1]}/${tri.path[2]}`;
    const prev = windowCandidates.get(pathKey);
    if (!prev || result.netPct > prev.netProfitPct) {
      windowCandidates.set(pathKey, {
        path: [...tri.path],
        symbols: [...tri.symbols],
        grossProfitPct: result.grossPct,
        netProfitPct: result.netPct,
        timestamp: now,
      });
    }

    // ── Below threshold — skip trade execution ───────────────────────────────
    if (result.netPct < minProfitThreshold) continue;

    // ── Per-path cooldown ────────────────────────────────────────────────────
    const lastTraded = recentlyTraded.get(pathKey) ?? 0;
    if (Date.now() - lastTraded < TRADE_COOLDOWN_MS) continue;

    // ── Live mode ────────────────────────────────────────────────────────────
    if (store.config.tradingMode === "live") {
      const creds = getCredentials();

      // Only USDT-starting triangles are supported for live trading
      if (!creds || tri.path[0] !== "USDT") continue;

      // Check / enforce daily loss limit before firing
      if (store.checkDailyLossLimit()) {
        logger.warn("Daily loss limit reached — reverted to paper mode");
        sseManager.broadcast("stats", store.getStats());
        // tradingMode is now 'paper'; fall through to paper logic below
      } else {
        // Mark cooldown and record opportunity before async execution
        recentlyTraded.set(pathKey, Date.now());
        const opp = store.addOpportunity({
          timestamp: new Date(),
          path: [...tri.path],
          symbols: [...tri.symbols],
          prices: result.prices,
          grossProfitPct: result.grossPct,
          netProfitPct: result.netPct,
          wasPaperTraded: false,
        });

        const tradeNotional = Math.min(notionalSize, store.config.maxNotionalPerTrade);

        // Fire live trade asynchronously — never block the WS message handler
        executeLiveTrade(tri, opp.id, tradeNotional, creds.apiKey, creds.apiSecret)
          .then((liveResult) => {
            // Success — reset consecutive failure counter
            consecutiveLiveFailures = 0;

            const trade = store.addTrade({
              opportunityId: opp.id,
              timestamp: new Date(),
              path: [...tri.path],
              symbols: [...tri.symbols],
              prices: liveResult.fillPrices,
              notionalSize: tradeNotional,
              grossProfitUsd: liveResult.netProfitUsd, // can't separate gross/net after fills
              netProfitUsd: liveResult.netProfitUsd,
              netProfitPct: liveResult.netProfitPct,
              mode: "live",
              orderIds: liveResult.orderIds,
              fillPrices: liveResult.fillPrices,
            });

            store.addLiveOrders(liveResult.liveOrders);
            opp.wasPaperTraded = true;

            // Re-check loss limit after trade settles
            if (store.checkDailyLossLimit()) {
              logger.warn("Daily loss limit hit after trade — reverted to paper mode");
              sseManager.broadcast("stats", store.getStats());
            }

            sseManager.broadcast("opportunity", {
              ...opp,
              timestamp: opp.timestamp.toISOString(),
            });
            sseManager.broadcast("trade", {
              ...trade,
              timestamp: trade.timestamp.toISOString(),
            });
          })
          .catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error({ err, path: tri.path.join("→") }, "Live trade failed");

            // Parse which leg failed from the error message ("Leg N (…) failed: …")
            const legMatch = errorMsg.match(/Leg (\d+)/);
            const failedLeg = legMatch ? parseInt(legMatch[1], 10) : 0;

            // Record a sentinel entry in Order History so the failure is visible
            store.addLiveOrders([{
              orderId: -Date.now(),
              symbol: tri.symbols[Math.max(0, failedLeg - 1)] ?? tri.symbols[0],
              side: tri.buys[Math.max(0, failedLeg - 1)] ? "BUY" : "SELL",
              executedQty: 0,
              avgPrice: 0,
              status: "ERROR",
              timestamp: new Date().toISOString(),
              leg: failedLeg || 1,
              trianglePath: tri.path.join("→"),
            }]);

            // Broadcast the failure event so the dashboard can alert the user
            sseManager.broadcast("live_trade_failed", {
              path: tri.path,
              failedLeg,
              error: errorMsg,
              timestamp: new Date().toISOString(),
            });

            // Broadcast the opportunity even on failure so user can see it was spotted
            sseManager.broadcast("opportunity", {
              ...opp,
              timestamp: opp.timestamp.toISOString(),
            });

            // Auto-kill after MAX_CONSECUTIVE_FAILURES back-to-back failures
            consecutiveLiveFailures++;
            if (consecutiveLiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              consecutiveLiveFailures = 0;
              if (store.config.tradingMode === "live") {
                store.config.tradingMode = "paper";
                logger.warn(
                  { failures: MAX_CONSECUTIVE_FAILURES },
                  "Auto-kill triggered after consecutive live trade failures — reverted to paper mode",
                );
                sseManager.broadcast("stats", store.getStats());
              }
            }
          });

        continue; // Do not fall through to paper trade
      }
    }

    // ── Paper mode ───────────────────────────────────────────────────────────
    recentlyTraded.set(pathKey, Date.now());

    const opp = store.addOpportunity({
      timestamp: new Date(),
      path: [...tri.path],
      symbols: [...tri.symbols],
      prices: result.prices,
      grossProfitPct: result.grossPct,
      netProfitPct: result.netPct,
      wasPaperTraded: false,
    });

    const trade = store.addTrade({
      opportunityId: opp.id,
      timestamp: new Date(),
      path: [...tri.path],
      symbols: [...tri.symbols],
      prices: result.prices,
      notionalSize,
      grossProfitUsd: result.grossPct * notionalSize,
      netProfitUsd: result.netPct * notionalSize,
      netProfitPct: result.netPct,
      mode: "paper",
    });

    opp.wasPaperTraded = true;

    sseManager.broadcast("opportunity", {
      ...opp,
      timestamp: opp.timestamp.toISOString(),
    });
    sseManager.broadcast("trade", {
      ...trade,
      timestamp: trade.timestamp.toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Exchange info
// ---------------------------------------------------------------------------

async function loadExchangeInfo(): Promise<boolean> {
  try {
    logger.info("Fetching Binance exchange info...");
    const res = await fetch(BINANCE_EXCHANGE_URL, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as {
      symbols: {
        symbol: string;
        status: string;
        baseAsset: string;
        quoteAsset: string;
        baseAssetPrecision: number;
        quotePrecision: number;
        filters: { filterType: string; stepSize?: string; minQty?: string }[];
      }[];
    };

    const activePairs: TradingPair[] = [];

    for (const s of data.symbols) {
      if (s.status !== "TRADING") continue;

      activePairs.push({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
      });

      // Extract quantity precision from MARKET_LOT_SIZE (preferred for MARKET
      // orders) falling back to LOT_SIZE.  A stepSize of "0.00000000" means the
      // exchange imposes no step constraint — in that case we use basePrecision.
      const marketLot = s.filters.find((f) => f.filterType === "MARKET_LOT_SIZE");
      const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
      const rawStep = marketLot?.stepSize ?? lot?.stepSize ?? "0";
      const lotStepSize = parseFloat(rawStep);

      symbolFilters.set(s.symbol, {
        quotePrecision: s.quotePrecision,
        basePrecision: s.baseAssetPrecision,
        lotStepSize: isNaN(lotStepSize) ? 0 : lotStepSize,
      });
    }

    store.pairsTracked = activePairs.length;
    symbolToTriangles = buildIndex(activePairs);
    exchangeInfoLoaded = true;
    logger.info({ pairs: activePairs.length }, "Exchange info loaded");
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to load exchange info");
    return false;
  }
}

// ---------------------------------------------------------------------------
// WebSocket — multiple connections, one per chunk of ≤200 symbols
// ---------------------------------------------------------------------------

let activeSymbols: string[] = [];
let connectedCount = 0;

function handleMessage(raw: Buffer): void {
  try {
    const msg = JSON.parse(raw.toString()) as {
      s?: string;
      b?: string;
      a?: string;
    };
    if (!msg.s) return;
    const bid = parseFloat(msg.b!);
    const ask = parseFloat(msg.a!);
    if (!isNaN(bid) && !isNaN(ask)) {
      priceMap.set(msg.s, { bid, ask });
      if (exchangeInfoLoaded) checkSymbol(msg.s);
    }
  } catch {
    // ignore malformed messages
  }
}

function openConnection(symbols: string[], connIndex: number): WebSocket {
  const ws = new WebSocket(BINANCE_WS_BASE);

  ws.on("open", () => {
    const streams = symbols.map((s) => `${s.toLowerCase()}@bookTicker`);
    ws.send(JSON.stringify({ method: "SUBSCRIBE", params: streams, id: connIndex + 1 }));
    connectedCount++;
    logger.info({ connIndex, symbols: symbols.length, total: connectedCount }, "WS shard connected");
    if (connectedCount === wsConns.length) {
      store.scannerConnected = true;
      sseManager.broadcast("scanner_status", { connected: true });
    }
  });

  ws.on("message", handleMessage);

  ws.on("close", () => {
    connectedCount = Math.max(0, connectedCount - 1);
    logger.warn({ connIndex, connectedCount }, "WS shard closed, reconnecting in 5s...");
    if (connectedCount === 0) {
      store.scannerConnected = false;
      sseManager.broadcast("scanner_status", { connected: false });
    }
    reconnectTimer = setTimeout(() => {
      wsConns[connIndex] = openConnection(symbols, connIndex);
    }, 5_000);
  });

  ws.on("error", (err) => {
    logger.error({ err, connIndex }, "WS shard error");
  });

  return ws;
}

function connectWS(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  for (const ws of wsConns) {
    try { ws.terminate(); } catch { /* ignore */ }
  }
  wsConns = [];
  connectedCount = 0;

  for (let i = 0; i < activeSymbols.length; i += MAX_SYMBOLS_PER_CONNECTION) {
    const chunk = activeSymbols.slice(i, i + MAX_SYMBOLS_PER_CONNECTION);
    wsConns.push(openConnection(chunk, wsConns.length));
  }

  logger.info({ connections: wsConns.length, totalSymbols: activeSymbols.length }, "Connecting to Binance WebSocket shards...");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function startScanner(): Promise<void> {
  store.startTime = Date.now();

  const loaded = await loadExchangeInfo();
  if (!loaded) {
    logger.warn("Exchange info failed, will retry every 30s");
    const retryInterval = setInterval(async () => {
      if (exchangeInfoLoaded) {
        clearInterval(retryInterval);
        return;
      }
      await loadExchangeInfo();
    }, 30_000);
  }

  activeSymbols = [...symbolToTriangles.keys()];
  logger.info({ count: activeSymbols.length }, "Subscribing to triangle symbols");

  connectWS();

  // Broadcast stats every 2 seconds, flushing the window candidates first
  setInterval(() => {
    const candidates = [...windowCandidates.values()];
    windowCandidates.clear();
    store.setTopScan(candidates);

    // Check daily loss limit on each tick
    if (store.checkDailyLossLimit()) {
      logger.warn("Daily loss limit reached on stats tick — reverted to paper mode");
    }

    sseManager.broadcast("stats", store.getStats());
  }, 2_000);

  // SSE heartbeat to keep connections alive
  setInterval(() => {
    sseManager.heartbeat();
  }, 30_000);
}
