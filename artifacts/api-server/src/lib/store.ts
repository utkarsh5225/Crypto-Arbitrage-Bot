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
  /**
   * Reject a triangle if any of its three legs was quoted more than this many
   * milliseconds ago (0 disables).
   *
   * The scanner re-evaluates a triangle whenever any ONE leg ticks, reading the
   * other two from cache. On an illiquid pair that has not traded in a while,
   * that compares a live price against a stale one — which manufactures a
   * phantom edge roughly equal to the price drift. Requiring all three legs to
   * be recent is what makes a quoted edge meaningful.
   */
  maxQuoteAgeMs: number;

  // ── DeepSeek (LLM) scalping — PAPER ONLY ──────────────────────────────────
  /** Master switch for the LLM decision loop. */
  llmEnabled: boolean;
  /** Perpetual symbol the LLM trades (legacy single-symbol field). */
  llmSymbol: string;
  /** Symbols selected from DeepSeek's picks. Empty = fall back to llmSymbol. */
  llmSymbols: string[];
  /** Seconds between decisions (min 30; 60 = the 1m scalping cadence). */
  llmIntervalSec: number;
  /** Hard cap on simulated trades per day, so a chatty model cannot spam. */
  llmMaxTradesPerDay: number;
  /**
   * Whether the decision prompt states the 10 bps round-trip cost.
   * true  = model declines almost every 1m setup (correct, but yields no data)
   * false = model trades freely, as a typical "AI trading bot" would, which is
   *         what lets the coin-flip scoreboard actually measure it
   */
  llmCostAware: boolean;
  /**
   * Model used for trade decisions.
   *
   * Measured: deepseek-v4-pro is a REASONING model and timed out at 60s on
   * every call, which is unusable on a 60s decision loop. It is still
   * selectable for longer intervals; the fast model is the default.
   */
  llmDecisionModel: string;
  /**
   * Minimum reward:risk the model is allowed to trade.
   *
   * Measured over its first 34 decisions the model chose reward < risk 27 times
   * (avg R:R 0.76, most often 0.50), producing many small wins and occasional
   * losses ~3x larger. The prompt alone is not enough — this is enforced in
   * code before a position opens.
   */
  llmMinRiskReward: number;
  /**
   * On a sub-minimum R:R: false = widen the target to meet the minimum
   * (keeps the model's direction, default), true = reject the decision entirely
   * (cleaner read of its unmodified judgement, but discards most trades).
   */
  llmRejectLowRR: boolean;
  /**
   * Minimum stop distance as a multiple of the recent average 1m bar range.
   *
   * Measured: 8 of the first 10 trades were stopped out, average hold 2.6
   * minutes and several within a single bar - the stops were sitting inside
   * ordinary noise. This floors them against actual volatility.
   */
  llmMinStopVolMult: number;
}

/** One completed LLM paper trade, with its coin-flip control. */
export interface LlmTrade {
  id: string;
  symbol: string;
  side: "long" | "short";
  entry: number;
  exit: number;
  grossBps: number;
  netBps: number;
  /**
   * Expected result of choosing the direction at random = mean of the model's
   * side and the mirrored counterfactual. Compare netBps against this.
   */
  ctrlNetBps: number;
  /** The mirrored (opposite-side) counterfactual result, net of cost. */
  oppNetBps?: number;
  how: string;
  bars: number;
  reason: string;
  confidence: number;
  openedAt: number;
  closedAt: number;
  /** What the model asked for vs what was actually traded after R:R enforcement. */
  requestedTargetBps?: number;
  enforcedTargetBps?: number;
  stopBps?: number;
  /** Latest in-trade review the model gave, if any. */
  lastReview?: string;
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
  /**
   * The honest edge: net profit after replaying the trade against real
   * order-book depth (VWAP) and fees — i.e. what the trade would actually be
   * worth, versus `netProfitPct` which is priced at an optimistic top-of-book.
   *
   * Only set for live-mode candidates that reached the depth gate; left
   * undefined for paper opportunities, which take no depth snapshot.
   */
  depthNetPct?: number | null;
  /**
   * Age (ms) of the STALEST of the three legs' quotes when this was evaluated.
   * A large value means the "edge" is likely an artifact of comparing a fresh
   * price against an out-of-date one rather than a real dislocation.
   */
  maxLegAgeMs?: number;
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
  /**
   * Full operator config (sizing + safety limits). Optional so older store.json
   * files without it still load; missing fields fall back to code defaults.
   * Without this, a restart silently reverted notional/limits to defaults while
   * staying in whatever trading mode was saved.
   */
  config?: Partial<BotConfig>;
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
    maxQuoteAgeMs: 1000,
    llmEnabled: false,
    llmSymbol: "BTCUSDT",
    llmSymbols: [],
    llmIntervalSec: 60,
    llmMaxTradesPerDay: 200,
    llmCostAware: false,
    llmDecisionModel: "deepseek-chat",
    llmMinRiskReward: 2.0,
    llmRejectLowRR: false,
    llmMinStopVolMult: 2.0,
  };

  /** Latest coin picks returned by DeepSeek, awaiting operator selection. */
  llmPicks: { symbol: string; reason: string; confidence: number }[] = [];
  llmPicksAt = 0;
  /** Per-trade discussion threads, keyed by trade id. */
  llmDiscussions: Record<string, { role: "user" | "assistant"; content: string; at: number }[]> = {};

  llmTrades: LlmTrade[] = [];
  llmSkips = 0;
  llmCalls = 0;
  llmLatencyMsTotal = 0;
  /** How often the model proposed reward < risk and had to be corrected. */
  llmRrAdjusted = 0;
  llmRrRejected = 0;
  llmReviews = 0;
  llmStopWidened = 0;

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

    // Restore the operator config (sizing + safety limits) on top of the code
    // defaults, so a restart cannot silently widen notional or loss limits.
    // Merged (not replaced) so fields added in later versions keep their default.
    // The dailyLossUsd / tradingMode / useTestnet blocks below still run and take
    // precedence — they carry extra logic (day-boundary reset, explicit restore).
    if (saved.config) {
      this.config = { ...this.config, ...saved.config };
    }

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
        config: this.config,
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

  // ── LLM paper-trading record ───────────────────────────────────────────────

  addLlmTrade(t: LlmTrade): void {
    this.llmTrades.unshift(t);
    if (this.llmTrades.length > 500) this.llmTrades.pop();
    this._scheduleSave();
  }

  addLlmSkip(): void {
    this.llmSkips += 1;
  }

  bumpRrAdjusted(): void { this.llmRrAdjusted += 1; }
  bumpRrRejected(): void { this.llmRrRejected += 1; }
  bumpLlmReviews(): void { this.llmReviews += 1; }
  bumpStopWidened(): void { this.llmStopWidened += 1; }

  bumpLlmCalls(ms: number): void {
    this.llmCalls += 1;
    this.llmLatencyMsTotal += ms;
  }

  /**
   * Scoring. The headline is `edgeVsRandom`: the model's average net result
   * minus a same-instant coin-flip taken with identical stop/target levels.
   * If that is not clearly positive, the model has no edge — however confident
   * or articulate its stated reasoning was.
   */
  getLlmStats() {
    const bucket = (xs: LlmTrade[]) => ({
      n: xs.length,
      avgNetBps: xs.length ? xs.reduce((a, b) => a + b.netBps, 0) / xs.length : 0,
      winRate: xs.length ? xs.filter((x) => x.netBps > 0).length / xs.length : 0,
    });
    const t = this.llmTrades;
    const n = t.length;
    const dayAgo = Date.now() - 86400_000;
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const net = mean(t.map((x) => x.netBps));
    const ctrl = mean(t.map((x) => x.ctrlNetBps));
    return {
      trades: n,
      today: t.filter((x) => x.closedAt > dayAgo).length,
      skips: this.llmSkips,
      calls: this.llmCalls,
      avgLatencyMs: this.llmCalls ? Math.round(this.llmLatencyMsTotal / this.llmCalls) : 0,
      winRate: n ? t.filter((x) => x.netBps > 0).length / n : 0,
      avgGrossBps: mean(t.map((x) => x.grossBps)),
      avgNetBps: net,
      avgRandomNetBps: ctrl,
      edgeVsRandom: net - ctrl,
      totalNetBps: t.reduce((a, b) => a + b.netBps, 0),
      roundTripCostBps: 10,
      longs: t.filter((x) => x.side === "long").length,
      shorts: t.filter((x) => x.side === "short").length,
      avgOppNetBps: n ? mean(t.map((x) => x.oppNetBps ?? 0)) : 0,
      stopWidened: this.llmStopWidened,
      rrAdjusted: this.llmRrAdjusted,
      rrRejected: this.llmRrRejected,
      reviews: this.llmReviews,
      minRiskReward: this.config.llmMinRiskReward,
      // Does the model's self-reported confidence predict anything? Measured,
      // not assumed — if these buckets do not separate, confidence is decorative
      // and should not be used to gate trades.
      byConfidence: [
        { band: "<0.5", ...bucket(t.filter((x) => x.confidence < 0.5)) },
        { band: "0.5-0.7", ...bucket(t.filter((x) => x.confidence >= 0.5 && x.confidence < 0.7)) },
        { band: ">=0.7", ...bucket(t.filter((x) => x.confidence >= 0.7)) },
      ],
    };
  }

  /**
   * Persist the config after an operator change. Routes that mutate
   * `store.config` directly must call this, otherwise the change lives only in
   * memory and is lost on the next restart.
   */
  persistConfig(): void {
    this._scheduleSave();
  }

  /**
   * Manually zero the daily-loss counter. Useful when a stale accumulated loss
   * (e.g. from earlier misconfigured runs) is holding the daily-loss guard down
   * and immediately reverting Live mode to Paper. Does not touch the limit.
   */
  resetDailyLoss(): number {
    const previous = this.config.dailyLossUsd;
    this.config.dailyLossUsd = 0;
    this.currentDay = new Date().toDateString();
    this._scheduleSave();
    return previous;
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
