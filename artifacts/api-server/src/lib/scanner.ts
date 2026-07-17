import WebSocket from "ws";
import { logger } from "./logger";
import { store } from "./store";
import { sseManager } from "./sse-manager";

interface PriceEntry {
  bid: number;
  ask: number;
}

interface TradingPair {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
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
// Instead, open multiple WS connections each subscribing to ≤500 symbols.
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";
const BINANCE_EXCHANGE_URL = "https://api.binance.com/api/v3/exchangeInfo";
const MAX_SYMBOLS_PER_CONNECTION = 500; // safely under Binance's 1024-stream limit

const priceMap = new Map<string, PriceEntry>();
let symbolToTriangles = new Map<string, Triangle[]>();
let exchangeInfoLoaded = false;

let wsConns: WebSocket[] = [];
let reconnectTimer: NodeJS.Timeout | null = null;

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
      // buy1: we go start → mid; true if mid is the base of p1 (we buy mid)
      const buy1 = p1.baseAsset === mid;

      for (const p2 of adj.get(mid) ?? []) {
        if (p2.symbol === p1.symbol) continue;
        const end = p2.baseAsset === mid ? p2.quoteAsset : p2.baseAsset;
        if (end === start || end === mid) continue;

        // Closing leg: end → start
        const p3 =
          lookup.get(`${end}/${start}`) ?? lookup.get(`${start}/${end}`);
        if (!p3 || p3.symbol === p1.symbol || p3.symbol === p2.symbol) continue;

        // Deduplicate by ordered path (we already iterate all start/mid/end combos)
        const key = `${start}/${mid}/${end}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // buy2: we go mid → end; true if end is the base of p2
        const buy2 = p2.baseAsset === end;
        // buy3: we go end → start; true if start is the base of p3
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
      // Buying base with quote currency: pay ask
      prices.push(entry.ask);
      amount /= entry.ask;
    } else {
      // Selling base for quote currency: receive bid
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

function checkSymbol(symbol: string): void {
  const triangles = symbolToTriangles.get(symbol);
  if (!triangles?.length) return;

  const { minProfitThreshold, notionalSize } = store.config;
  store.incrementPaths(triangles.length);

  for (const tri of triangles) {
    const result = evalTriangle(tri);
    if (!result || result.netPct < minProfitThreshold) continue;

    // Record opportunity
    const opp = store.addOpportunity({
      timestamp: new Date(),
      path: [...tri.path],
      symbols: [...tri.symbols],
      prices: result.prices,
      grossProfitPct: result.grossPct,
      netProfitPct: result.netPct,
      wasPaperTraded: false,
    });

    // Auto paper-trade
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
    });

    opp.wasPaperTraded = true;

    // Broadcast real-time events
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
      }[];
    };

    const activePairs: TradingPair[] = data.symbols
      .filter((s) => s.status === "TRADING")
      .map((s) => ({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
      }));

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
// WebSocket — multiple connections, one per chunk of ≤500 symbols
// ---------------------------------------------------------------------------

let activeSymbols: string[] = [];
let connectedCount = 0; // how many of the current connections are open

function handleMessage(raw: Buffer): void {
  try {
    const msg = JSON.parse(raw.toString()) as {
      s?: string;
      b?: string;
      a?: string;
    };
    if (!msg.s) return; // subscription confirmation or other control frame
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
    // Replace this shard after delay
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

  // Close any existing connections
  for (const ws of wsConns) {
    try { ws.terminate(); } catch { /* ignore */ }
  }
  wsConns = [];
  connectedCount = 0;

  // Chunk symbols and open one connection per chunk
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

  // Collect all unique symbols that participate in at least one triangle
  activeSymbols = [...symbolToTriangles.keys()];
  logger.info({ count: activeSymbols.length }, "Subscribing to triangle symbols");

  connectWS();

  // Broadcast stats every 2 seconds
  setInterval(() => {
    sseManager.broadcast("stats", store.getStats());
  }, 2_000);

  // SSE heartbeat to keep connections alive
  setInterval(() => {
    sseManager.heartbeat();
  }, 30_000);
}
