import { randomUUID } from "crypto";

export interface BotConfig {
  feeRate: number;
  minProfitThreshold: number;
  notionalSize: number;
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
}

export interface TopOpportunity {
  path: string[];
  symbols: string[];
  grossProfitPct: number;
  netProfitPct: number;
  timestamp: string; // ISO string
}

const MAX_OPPORTUNITIES = 500;
const MAX_TRADES = 500;
const TOP_N = 5;

class Store {
  config: BotConfig = {
    feeRate: 0.001,
    minProfitThreshold: 0.001,
    notionalSize: 1000,
  };

  opportunities: ArbitrageOpportunity[] = [];
  trades: PaperTrade[] = [];

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
    return full;
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

  /** Called by the scanner with the best candidates from the last 2s window */
  setTopScan(candidates: TopOpportunity[]): void {
    // Sort descending by netProfitPct and keep top N
    this.topScan = candidates
      .sort((a, b) => b.netProfitPct - a.netProfitPct)
      .slice(0, TOP_N);

    // Merge into topToday: insert each candidate, resort, trim
    for (const c of this.topScan) {
      // Replace an existing entry for the same path if the new one is better
      const key = c.path.join("/");
      const existing = this.topToday.findIndex(
        (t) => t.path.join("/") === key
      );
      if (existing !== -1) {
        if (c.netProfitPct > this.topToday[existing].netProfitPct) {
          this.topToday[existing] = c;
        }
      } else {
        // Only add if it would make the top N, or we have fewer than N
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
    };
  }
}

export const store = new Store();
