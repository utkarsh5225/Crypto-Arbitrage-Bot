import { randomUUID } from "crypto";

export interface BotConfig {
  feeRate: number;
  minProfitThreshold: number;
  notionalSize: number;
  tradingMode: "paper" | "live";
  maxNotionalPerTrade: number;
  dailyLossLimitUsd: number;
  dailyLossUsd: number; // read-only; managed internally
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

class Store {
  config: BotConfig = {
    feeRate: 0.001,
    minProfitThreshold: 0.001,
    notionalSize: 1000,
    tradingMode: "paper",
    maxNotionalPerTrade: 1000,
    dailyLossLimitUsd: 50,
    dailyLossUsd: 0,
  };

  opportunities: ArbitrageOpportunity[] = [];
  trades: PaperTrade[] = [];
  liveOrders: LiveOrder[] = [];

  totalOpportunities = 0;
  totalTrades = 0;
  totalProfitUsd = 0;
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

  addOpportunity(opp: Omit<ArbitrageOpportunity, "id">): ArbitrageOpportunity {
    const full: ArbitrageOpportunity = { ...opp, id: randomUUID() };
    this.opportunities.unshift(full);
    if (this.opportunities.length > MAX_OPPORTUNITIES) this.opportunities.pop();
    this.totalOpportunities++;
    this.oppTimestamps.push(Date.now());
    return full;
  }

  addTrade(trade: Omit<PaperTrade, "id">): PaperTrade {
    const full: PaperTrade = { ...trade, id: randomUUID() };
    this.trades.unshift(full);
    if (this.trades.length > MAX_TRADES) this.trades.pop();
    this.totalTrades++;
    this.totalProfitUsd += trade.netProfitUsd;

    // Track daily loss for live trades
    if (trade.mode === "live" && trade.netProfitUsd < 0) {
      this.config.dailyLossUsd += Math.abs(trade.netProfitUsd);
    }

    return full;
  }

  addLiveOrders(orders: LiveOrder[]): void {
    this.liveOrders.unshift(...orders);
    if (this.liveOrders.length > MAX_LIVE_ORDERS) {
      this.liveOrders.length = MAX_LIVE_ORDERS;
    }
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
    }

    if (
      this.config.tradingMode === "live" &&
      this.config.dailyLossLimitUsd > 0 &&
      this.config.dailyLossUsd >= this.config.dailyLossLimitUsd
    ) {
      this.config.tradingMode = "paper";
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
    for (const c of this.topScan) {
      const key = c.path.join("/");
      const existing = this.topToday.findIndex(
        (t) => t.path.join("/") === key,
      );
      if (existing !== -1) {
        if (c.netProfitPct > this.topToday[existing].netProfitPct) {
          this.topToday[existing] = c;
        }
      } else {
        if (
          this.topToday.length < TOP_N ||
          c.netProfitPct > this.topToday[this.topToday.length - 1].netProfitPct
        ) {
          this.topToday.push(c);
        }
      }
      this.topToday.sort((a, b) => b.netProfitPct - a.netProfitPct);
      if (this.topToday.length > TOP_N) this.topToday.length = TOP_N;
    }
  }

  getStats() {
    const now = Date.now();
    const cutoff = now - 60_000;
    this.oppTimestamps = this.oppTimestamps.filter((t) => t > cutoff);

    return {
      totalOpportunities: this.totalOpportunities,
      totalTrades: this.totalTrades,
      totalProfitUsd: this.totalProfitUsd,
      winRate: this.totalTrades > 0 ? 1.0 : 0,
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
