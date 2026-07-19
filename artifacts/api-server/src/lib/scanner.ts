import WebSocket from "ws";
import { logger } from "./logger";
import { store, type TopOpportunity } from "./store";
import { sseManager } from "./sse-manager";
import { getCredentials } from "./credentials";
import { createClient } from "./binance-client";
import { executeLiveTrade, LiveTradeError } from "./live-execution";
import { checkTriangleMinimums, simulateTriangleVWAP } from "./precision";

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
  /**
   * Minimum order value in the QUOTE asset, from the NOTIONAL (or MIN_NOTIONAL)
   * filter. Binance rejects any order whose price×quantity is below this.
   * 0 means no minimum was published for the symbol.
   */
  minNotional: number;
  /**
   * Minimum BASE quantity from MARKET_LOT_SIZE (or LOT_SIZE fallback), applied
   * to quantity-based (SELL) orders. 0 means no minimum was published.
   */
  minQty: number;
}

const symbolFilters = new Map<string, SymbolFilters>();

/**
 * Returns precision/lot-size filters for a symbol.
 * Falls back to conservative defaults (8/8 decimal, no step) if the symbol
 * was not found in exchange info.
 */
export function getSymbolFilters(symbol: string): SymbolFilters {
  return (
    symbolFilters.get(symbol) ?? {
      quotePrecision: 8,
      basePrecision: 8,
      lotStepSize: 0,
      minNotional: 0,
      minQty: 0,
    }
  );
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

/**
 * True while a live triangle is executing. Only one live trade may be in flight
 * at a time — concurrent triangles would each assume the full notional of USDT
 * is available and double-spend the same bankroll. Set before firing and
 * cleared when the trade settles (success or failure).
 */
let liveTradeInFlight = false;

/** Cleared on graceful shutdown so no new live trades start while draining. */
let acceptingTrades = true;

/** Stop accepting new live trades (called on SIGTERM before the store flush). */
export function stopTrading(): void {
  acceptingTrades = false;
  logger.info("Scanner will no longer start new live trades (shutdown)");
}

/** Whether a live trade is currently mid-execution — lets shutdown wait for it. */
export function isLiveTradeInFlight(): boolean {
  return liveTradeInFlight;
}

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

/**
 * Pre-flight MIN_NOTIONAL guard.
 *
 * Simulates the notional value (in each pair's quote asset) that every leg of
 * the triangle would carry for a given starting USDT notional, using the exact
 * book prices captured in `evalTriangle`. Returns the first leg whose order
 * value would fall below Binance's published minimum, or null if all legs pass.
 *
 * This runs BEFORE any order is placed so a shrinking triangle can be skipped
 * instead of being rejected mid-execution (which would strand an intermediate
 * asset).
 */
function findSubMinNotionalLeg(
  tri: Triangle,
  prices: number[],
  notional: number,
): { leg: number; symbol: string; reason: string; value: number; min: number } | null {
  const filters = tri.symbols.map((s) => getSymbolFilters(s));
  const violation = checkTriangleMinimums(tri.buys, prices, notional, filters);
  if (!violation) return null;
  return { ...violation, symbol: tri.symbols[violation.leg - 1] };
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
        // Only one live triangle may execute at a time — otherwise concurrent
        // paths double-spend the same USDT bankroll. Skip (without cooldown) so
        // this or another path can fire on the next tick once the lock frees.
        // Also stop starting new trades once shutdown has begun.
        if (liveTradeInFlight || !acceptingTrades) continue;

        const tradeNotional = Math.min(notionalSize, store.config.maxNotionalPerTrade);

        // Pre-flight MIN_NOTIONAL / minQty guard — skip triangles that would be
        // rejected mid-execution (which would strand an intermediate asset).
        // Applies a cooldown so we don't re-evaluate the same failing path every tick.
        const subMin = findSubMinNotionalLeg(tri, result.prices, tradeNotional);
        if (subMin) {
          recentlyTraded.set(pathKey, Date.now());
          logger.warn(
            { path: pathKey, ...subMin },
            "Skipping live trade — leg below Binance minimum",
          );
          continue;
        }

        // Unwind-safety: only trade triangles whose intermediate assets each have
        // a direct {asset}USDT pair, so a mid-triangle failure can always be
        // converted back to USDT instead of stranding an unrecoverable position.
        const midAsset = tri.path[1];
        const endAsset = tri.path[2];
        if (!symbolFilters.has(`${midAsset}USDT`) || !symbolFilters.has(`${endAsset}USDT`)) {
          recentlyTraded.set(pathKey, Date.now());
          logger.warn(
            { path: pathKey, midAsset, endAsset },
            "Skipping live trade — intermediate asset has no direct USDT unwind pair",
          );
          continue;
        }

        // Per-trade daily-loss headroom guard: don't even start a trade whose
        // plausible worst-case loss (taker fees on all legs + entry and unwind
        // slippage) could push past the remaining daily-loss budget. The
        // post-trade check would otherwise only catch the breach AFTER the
        // overshoot has already been booked.
        if (store.config.dailyLossLimitUsd > 0) {
          const remaining = store.config.dailyLossLimitUsd - store.config.dailyLossUsd;
          const worstCaseLossUsd =
            (3 * store.config.feeRate + 2 * store.config.maxSlippagePct) * tradeNotional;
          if (worstCaseLossUsd > remaining) {
            recentlyTraded.set(pathKey, Date.now());
            logger.warn(
              { path: pathKey, remaining, worstCaseLossUsd },
              "Skipping live trade — insufficient daily-loss headroom for worst-case",
            );
            continue;
          }
        }

        // Take the in-flight lock synchronously so the next WS message can't
        // double-fire the same bankroll, then run the depth-aware entry gate and
        // (only if it clears) the trade — all off the hot WS message handler.
        recentlyTraded.set(pathKey, Date.now());
        liveTradeInFlight = true;
        void fireLiveTrade(tri, tradeNotional, creds, result);

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
// Live trade firing — depth-aware entry gate + execution
// ---------------------------------------------------------------------------

/**
 * Depth-aware entry gate. The scanner's top-of-book scan is optimistic: a real
 * MARKET order for the full notional walks the book. So before committing, pull
 * a live order-book snapshot for the 3 legs and replay the triangle at the
 * volume-weighted fill for the intended size, net of taker fees. The trade only
 * clears if that realistic edge beats `minProfitThreshold + slippageBudgetPct`.
 *
 * Depth is fetched from the same venue (testnet/production) the order will hit.
 */
async function evaluateDepthGate(
  tri: Triangle,
  tradeNotional: number,
  creds: { apiKey: string; apiSecret: string },
): Promise<{ ok: boolean; reason: string; depthNetPct: number | null }> {
  const { feeRate, minProfitThreshold, slippageBudgetPct, useTestnet } = store.config;
  const client = createClient(creds.apiKey, creds.apiSecret, useTestnet);

  let books;
  try {
    books = await Promise.all(tri.symbols.map((s) => client.getDepth(s, 100)));
  } catch (err) {
    return {
      ok: false,
      reason: `depth snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      depthNetPct: null,
    };
  }

  const sim = simulateTriangleVWAP(books, tri.buys, tradeNotional, feeRate);
  if (!sim) {
    return { ok: false, reason: "insufficient order-book depth for size", depthNetPct: null };
  }

  const required = minProfitThreshold + slippageBudgetPct;
  if (sim.netPct < required) {
    return {
      ok: false,
      reason: `depth-adjusted net ${(sim.netPct * 100).toFixed(3)}% < required ${(required * 100).toFixed(3)}%`,
      depthNetPct: sim.netPct,
    };
  }
  return { ok: true, reason: "ok", depthNetPct: sim.netPct };
}

/**
 * Run the depth gate and, if it clears, execute the live triangle and record the
 * outcome. Always releases the in-flight lock in `finally`. Never throws — a
 * failure is logged/persisted and, after MAX_CONSECUTIVE_FAILURES in a row,
 * auto-reverts to paper mode.
 */
async function fireLiveTrade(
  tri: Triangle,
  tradeNotional: number,
  creds: { apiKey: string; apiSecret: string },
  result: { grossPct: number; netPct: number; prices: number[] },
): Promise<void> {
  const opp = store.addOpportunity({
    timestamp: new Date(),
    path: [...tri.path],
    symbols: [...tri.symbols],
    prices: result.prices,
    grossProfitPct: result.grossPct,
    netProfitPct: result.netPct,
    wasPaperTraded: false,
  });

  try {
    // ── Depth-aware entry gate ──────────────────────────────────────────────
    const gate = await evaluateDepthGate(tri, tradeNotional, creds);
    if (!gate.ok) {
      logger.warn(
        {
          path: tri.path.join("→"),
          topOfBookNetPct: result.netPct,
          depthNetPct: gate.depthNetPct,
          reason: gate.reason,
        },
        "Skipping live trade — edge below depth-adjusted cost",
      );
      sseManager.broadcast("opportunity", { ...opp, timestamp: opp.timestamp.toISOString() });
      return;
    }

    const liveResult = await executeLiveTrade(
      tri,
      opp.id,
      tradeNotional,
      creds.apiKey,
      creds.apiSecret,
      store.config.useTestnet,
      result.prices,
      store.config.maxSlippagePct,
    );

    // ── Success ─────────────────────────────────────────────────────────────
    consecutiveLiveFailures = 0;

    const trade = store.addTrade({
      opportunityId: opp.id,
      timestamp: new Date(),
      path: [...tri.path],
      symbols: [...tri.symbols],
      prices: liveResult.fillPrices,
      notionalSize: tradeNotional,
      // Realised net is exact (final USDT − notional). Report gross as net plus
      // the assumed fee drag so the dashboard's gross/net columns stay
      // consistent with how paper trades are recorded.
      grossProfitUsd: liveResult.netProfitUsd + 3 * store.config.feeRate * tradeNotional,
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

    sseManager.broadcast("opportunity", { ...opp, timestamp: opp.timestamp.toISOString() });
    sseManager.broadcast("trade", { ...trade, timestamp: trade.timestamp.toISOString() });
  } catch (err) {
    // ── Failure ─────────────────────────────────────────────────────────────
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, path: tri.path.join("→") }, "Live trade failed");

    // LiveTradeError carries structured detail: which leg failed, the legs that
    // DID fill, and the outcome of the unwind attempt.
    const structured = err instanceof LiveTradeError ? err : null;
    const legMatch = errorMsg.match(/Leg (\d+)/);
    const failedLeg = structured
      ? structured.failedLeg
      : legMatch
        ? parseInt(legMatch[1], 10)
        : 0;
    const unwindOrder = structured ? structured.unwindOrder : null;
    const unwindError = structured ? structured.unwindError : undefined;
    const filledOrders = structured ? structured.filledOrders : [];

    // Persist the partial fills, the unwind order (if any), and a sentinel ERROR
    // marker — newest first, so they read top-to-bottom in the dashboard.
    const historyEntries: typeof filledOrders = [];
    if (unwindOrder) historyEntries.push(unwindOrder);
    historyEntries.push({
      orderId: -Date.now(),
      symbol: tri.symbols[Math.max(0, failedLeg - 1)] ?? tri.symbols[0],
      side: tri.buys[Math.max(0, failedLeg - 1)] ? "BUY" : "SELL",
      executedQty: 0,
      avgPrice: 0,
      status: "ERROR",
      timestamp: new Date().toISOString(),
      leg: failedLeg || 1,
      trianglePath: tri.path.join("→"),
    });
    // filledOrders are chronological (leg 1..n); reverse so newest-first.
    for (const o of [...filledOrders].reverse()) historyEntries.push(o);
    store.addLiveOrders(historyEntries);

    sseManager.broadcast("live_trade_failed", {
      path: tri.path,
      failedLeg,
      error: errorMsg,
      unwound: unwindOrder !== null,
      unwindError,
      timestamp: new Date().toISOString(),
    });

    sseManager.broadcast("opportunity", { ...opp, timestamp: opp.timestamp.toISOString() });

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
  } finally {
    // Release the lock so the next opportunity can fire.
    liveTradeInFlight = false;
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
        filters: {
          filterType: string;
          stepSize?: string;
          minQty?: string;
          minNotional?: string;
          notional?: string;
        }[];
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

      // Both MARKET_LOT_SIZE and LOT_SIZE constrain a market order's quantity,
      // and BOTH must be satisfied. MARKET_LOT_SIZE.stepSize is frequently
      // "0.00000000" (no extra market-specific step), but that does NOT lift the
      // base LOT_SIZE step. Take the coarser (larger) non-zero step, which is a
      // multiple of the finer one and therefore valid for both filters.
      const marketLot = s.filters.find((f) => f.filterType === "MARKET_LOT_SIZE");
      const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
      const marketStep = parseFloat(marketLot?.stepSize ?? "0") || 0;
      const lotStep = parseFloat(lot?.stepSize ?? "0") || 0;
      const lotStepSize = Math.max(marketStep, lotStep);
      const marketMinQty = parseFloat(marketLot?.minQty ?? "0") || 0;
      const lotMinQty = parseFloat(lot?.minQty ?? "0") || 0;
      const minQty = Math.max(marketMinQty, lotMinQty);

      // Minimum order value in the quote asset. Newer exchange info uses the
      // NOTIONAL filter (field `minNotional`); older uses MIN_NOTIONAL.
      const notionalFilter =
        s.filters.find((f) => f.filterType === "NOTIONAL") ??
        s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
      const rawMinNotional = notionalFilter?.minNotional ?? notionalFilter?.notional ?? "0";
      const minNotional = parseFloat(rawMinNotional);

      symbolFilters.set(s.symbol, {
        quotePrecision: s.quotePrecision,
        basePrecision: s.baseAssetPrecision,
        lotStepSize: isNaN(lotStepSize) ? 0 : lotStepSize,
        minNotional: isNaN(minNotional) ? 0 : minNotional,
        minQty: isNaN(minQty) ? 0 : minQty,
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

  // Periodically refresh exchange info so symbol filters (minNotional, step
  // sizes) stay current on long-running deployments. Best-effort: a failed
  // refresh keeps the last-known filters.
  setInterval(() => {
    loadExchangeInfo().catch((err) => {
      logger.warn({ err }, "Periodic exchange-info refresh failed — keeping last-known filters");
    });
  }, 60 * 60 * 1000);
}
