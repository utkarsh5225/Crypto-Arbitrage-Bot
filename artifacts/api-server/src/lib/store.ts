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

const MAX_OPPORTUNITIES = 500;
const MAX_TRADES = 500;

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
    };
  }
}

export const store = new Store();
