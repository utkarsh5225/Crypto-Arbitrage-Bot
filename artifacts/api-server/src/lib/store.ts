import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface BotConfig {
  feeRate: number;
  minProfitThreshold: number;
  notionalSize: number;
  tradingMode: "paper" | "live";
  maxNotionalPerTrade: number;
  dailyLossLimitUsd: number;
  dailyLossUsd: number; // read-only; managed internally
  useTestnet: boolean; // route live orders/account to Binance Spot Testnet
  maxSlippagePct: number; // abort a live triangle if a leg slips past this (0 disables)
  /**
   * Extra edge required, on top of minProfitThreshold, at the depth-aware entry
   * gate — a cushion for the residual drift between the depth snapshot and the
   * actual fill. A live trade only fires if the VWAP-simulated net edge clears
   * `minProfitThreshold + slippageBudgetPct`.
   */
  slippageBudgetPct: number;
}

export interface ArbitrageOpportunity {
  id: string;
  timestamp: Date;
  path: string[];
  symbols: string[];
  prices: number[];
  grossProfitPct: number;
  netProfitPct: number;
  wasPaperTraded: boolean;
}

export interface PaperTrade {
  id: string;
  opportunityId: string;
  timestamp: Date;
  path: string[];
  symbols: string[];
  prices: number[];
  notionalSize: number;
  grossProfitUsd: number;
  netProfitUsd: number;
  netProfitPct: number;
  mode?: "paper" | "live";
  orderIds?: number[];
  fillPrices?: number[];
}

export interface TopOpportunity {
  path: string[];
  symbols: string[];
  grossProfitPct: number;
  netProfitPct: number;
  timestamp: string; // ISO string
}

export interface LiveOrder {
  orderId: number;
  symbol: string;
  side: "BUY" | "SELL";
  executedQty: number;
  avgPrice: number;
  status: string;
  timestamp: string; // ISO string
  leg: number; // 1, 2, or 3
  trianglePath: string; // "USDT→BTC→ETH→USDT"
}

const MAX_OPPORTUNITIES = 500;
const MAX_TRADES = 500;
const MAX_LIVE_ORDERS = 200;
const TOP_N = 5;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const DATA_DIR = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "store.json");

/** What we write to / read from disk — only the durable subset. */
interface PersistedState {
  trades: PaperTrade[];
  opportunities: ArbitrageOpportunity[];
  liveOrders: LiveOrder[];
  totalOpportunities: number;
  totalTrades: number;
  totalProfitUsd: number;
  winningTrades: number;
  paperProfitUsd: number;
  liveProfitUsd: number;
  topToday: TopOpportunity[];
  dailyLossUsd: number;
  tradingMode: "paper" | "live";
  useTestnet: boolean;
  currentDay: string;
}

function loadPersistedState(): PersistedState | null {
  try {
    if (!existsSync(DATA_FILE)) return null;
    const raw = readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as PersistedState;
    // Rehydrate Date objects in trades and opportunities
    parsed.trades = (parsed.trades ?? []).map((t) => ({
      ...t,
      timestamp: new Date(t.timestamp),
    }));
    parsed.opportunities = (parsed.opportunities ?? []).map((o) => ({
      ...o,
      timestamp: new Date(o.timestamp),
    }));
    return parsed;
  } catch (err) {
    // Corrupted or missing — start fresh
    console.warn("[store] Failed to load persisted state, starting fresh:", err);
    return null;
  }
}

class Store {
  config: BotConfig = {
    feeRate: 0.001,
    minProfitThreshold: 0.001,
    notionalSize: 1000,
    tradingMode: "paper",
    maxNotionalPerTrade: 1000,
    dailyLossLimitUsd: 50,
    dailyLossUsd: 0,
    useTestnet: false,
    maxSlippagePct: 0.005,
    slippageBudgetPct: 0.002,
  };

  opportunities: ArbitrageOpportunity[] = [];
  trades: PaperTrade[] = [];
  liveOrders: LiveOrder[] = [];

  totalOpportunities = 0;
  totalTrades = 0;
  totalProfitUsd = 0;
  winningTrades = 0; // trades with netProfitUsd > 0
  paperProfitUsd = 0; // cumulative P&L from paper trades only
  liveProfitUsd = 0; // cumulative P&L from live trades only
  pairsTracked = 0;
  pathsEvaluated = 0;
  scannerConnected = false;
  startTime = Date.now();

  // Top 5 of today — best by netProfitPct seen since start
  topToday: TopOpportunity[] = [];

  // Top 5 from the current scan window — set by the scanner each broadcast
  topScan: TopOpportunity[] = [];

  // Daily loss reset tracking
  private currentDay = new Date().toDateString();

  // Rolling rate tracking
  private pathWindowCount = 0;
  private pathWindowStart = Date.now();
  private pathsPerSecondValue = 0;
  private oppTimestamps: number[] = [];

  // Debounce handle for disk writes
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this._restoreFromDisk();
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  private _restoreFromDisk(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
    } catch {
      // ignore
    }

    const saved = loadPersistedState();
    if (!saved) return;

    // Restore durable fields
    this.trades = saved.trades ?? [];
    this.opportunities = saved.opportunities ?? [];
    this.liveOrders = saved.liveOrders ?? [];
    this.totalOpportunities = saved.totalOpportunities ?? 0;
    this.totalTrades = saved.totalTrades ?? 0;
    this.totalProfitUsd = saved.totalProfitUsd ?? 0;
    this.winningTrades = saved.winningTrades ?? 0;
    this.paperProfitUsd = saved.paperProfitUsd ?? 0;
    this.liveProfitUsd = saved.liveProfitUsd ?? 0;
    this.topToday = saved.topToday ?? [];
    this.currentDay = saved.currentDay ?? new Date().toDateString();

    // Restore daily loss tracking — reset at day boundary
    const today = new Date().toDateString();
    if (saved.currentDay === today) {
      this.config.dailyLossUsd = saved.dailyLossUsd ?? 0;
    } else {
      // New day — reset daily loss
      this.config.dailyLossUsd = 0;
      this.currentDay = today;
    }

    // Restore trading mode
    if (saved.tradingMode) {
      this.config.tradingMode = saved.tradingMode;
    }

    // Restore testnet flag
    if (typeof saved.useTestnet === "boolean") {
      this.config.useTestnet = saved.useTestnet;
    }

    console.info(
      `[store] Restored ${this.trades.length} trades, ${this.opportunities.length} opportunities from disk.`,
    );
  }

  /** Schedule a debounced write — coalesces rapid mutations into one write. */
  private _scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this._flushToDisk();
    }, 500);
  }

  private _flushToDisk(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const state: PersistedState = {
        trades: this.trades,
        opportunities: this.opportunities,
        liveOrders: this.liveOrders,
        totalOpportunities: this.totalOpportunities,
        totalTrades: this.totalTrades,
        totalProfitUsd: this.totalProfitUsd,
        winningTrades: this.winningTrades,
        paperProfitUsd: this.paperProfitUsd,
        liveProfitUsd: this.liveProfitUsd,
        topToday: this.topToday,
        dailyLossUsd: this.config.dailyLossUsd,
        tradingMode: this.config.tradingMode,
        useTestnet: this.config.useTestnet,
        currentDay: this.currentDay,
      };
      writeFileSync(DATA_FILE, JSON.stringify(state), "utf-8");
    } catch (err) {
      console.error("[store] Failed to persist state to disk:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  addOpportunity(opp: Omit<ArbitrageOpportunity, "id">): ArbitrageOpportunity {
    const full: ArbitrageOpportunity = { ...opp, id: randomUUID() };
    this.opportunities.unshift(full);
    if (this.opportunities.length > MAX_OPPORTUNITIES) this.opportunities.pop();
    this.totalOpportunities++;
    this.oppTimestamps.push(Date.now());
    this._scheduleSave();
    return full;
  }

  addTrade(trade: Omit<PaperTrade, "id">): PaperTrade {
    const full: PaperTrade = { ...trade, id: randomUUID() };
    this.trades.unshift(full);
    if (this.trades.length > MAX_TRADES) this.trades.pop();
    this.totalTrades++;
    this.totalProfitUsd += trade.netProfitUsd;
    if (trade.netProfitUsd > 0) this.winningTrades++;

    // Track paper vs live P&L separately so the two are never conflated.
    if (trade.mode === "live") {
      this.liveProfitUsd += trade.netProfitUsd;
      // Track daily loss for live trades
      if (trade.netProfitUsd < 0) {
        this.config.dailyLossUsd += Math.abs(trade.netProfitUsd);
      }
    } else {
      this.paperProfitUsd += trade.netProfitUsd;
    }

    this._scheduleSave();
    return full;
  }

  /** Force an immediate synchronous write — used on graceful shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this._flushToDisk();
  }

  addLiveOrders(orders: LiveOrder[]): void {
    this.liveOrders.unshift(...orders);
    if (this.liveOrders.length > MAX_LIVE_ORDERS) {
      this.liveOrders.length = MAX_LIVE_ORDERS;
    }
    this._scheduleSave();
  }

  getLiveOrders(limit = 20): LiveOrder[] {
    return this.liveOrders.slice(0, limit);
  }

  incrementPaths(n: number): void {
    this.pathsEvaluated += n;
    this.pathWindowCount += n;
    const now = Date.now();
    const elapsed = (now - this.pathWindowStart) / 1000;
    if (elapsed >= 1) {
      this.pathsPerSecondValue = this.pathWindowCount / elapsed;
      this.pathWindowCount = 0;
      this.pathWindowStart = now;
    }
  }

  /** Check if the daily loss limit has been exceeded; auto-revert to paper if so. */
  checkDailyLossLimit(): boolean {
    // Reset at day boundary
    const today = new Date().toDateString();
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.config.dailyLossUsd = 0;
      this._scheduleSave();
    }

    if (
      this.config.tradingMode === "live" &&
      this.config.dailyLossLimitUsd > 0 &&
      this.config.dailyLossUsd >= this.config.dailyLossLimitUsd
    ) {
      this.config.tradingMode = "paper";
      this._scheduleSave();
      return true; // Limit hit — caller should broadcast alert
    }
    return false;
  }

  /** Called by the scanner with the best candidates from the last 2s window */
  setTopScan(candidates: TopOpportunity[]): void {
    // Sort descending by netProfitPct and keep top N
    this.topScan = candidates
      .sort((a, b) => b.netProfitPct - a.netProfitPct)
      .slice(0, TOP_N);

    // Merge into topToday: insert each candidate, resort, trim
    let topTodayChanged = false;
    for (const c of this.topScan) {
      const key = c.path.join("/");
      const existing = this.topToday.findIndex(
        (t) => t.path.join("/") === key,
      );
      if (existing !== -1) {
        if (c.netProfitPct > this.topToday[existing].netProfitPct) {
          this.topToday[existing] = c;
          topTodayChanged = true;
        }
      } else {
        if (
          this.topToday.length < TOP_N ||
          c.netProfitPct > this.topToday[this.topToday.length - 1].netProfitPct
        ) {
          this.topToday.push(c);
          topTodayChanged = true;
        }
      }
      this.topToday.sort((a, b) => b.netProfitPct - a.netProfitPct);
      if (this.topToday.length > TOP_N) this.topToday.length = TOP_N;
    }

    if (topTodayChanged) this._scheduleSave();
  }

  getStats() {
    const now = Date.now();
    const cutoff = now - 60_000;
    this.oppTimestamps = this.oppTimestamps.filter((t) => t > cutoff);

    return {
      totalOpportunities: this.totalOpportunities,
      totalTrades: this.totalTrades,
      totalProfitUsd: this.totalProfitUsd,
      paperProfitUsd: this.paperProfitUsd,
      liveProfitUsd: this.liveProfitUsd,
      winRate: this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0,
      pairsTracked: this.pairsTracked,
      pathsEvaluated: this.pathsEvaluated,
      pathsPerSecond: Math.round(this.pathsPerSecondValue),
      scannerConnected: this.scannerConnected,
      uptimeSeconds: (now - this.startTime) / 1000,
      opportunitiesPerMinute: this.oppTimestamps.length,
      topScan: this.topScan,
      topToday: this.topToday,
      tradingMode: this.config.tradingMode,
      dailyLossUsd: this.config.dailyLossUsd,
    };
  }
}

export const store = new Store();
