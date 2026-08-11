/** A loan listing from the LenDenClub manual-lending marketplace, normalized. */
export interface Loan {
  id: string;
  borrowerId: string;
  /** Gross annual interest rate offered to lenders, in percent. */
  interestRatePct: number;
  tenureMonths: number;
  /** How much of the loan is still open for funding, in INR. */
  fundableINR: number;
  /** Platform risk grade / category (e.g. "A".."E"). "unknown" when absent. */
  grade: string;
  purpose?: string;
  /** Original payload, kept for debugging field mappings. */
  raw: unknown;
}

export interface StrategyConfig {
  /** Max to lend into a single loan, INR. */
  maxPerLoanINR: number;
  /** Max exposure to a single borrower, INR (RBI hard cap is 50,000). */
  maxPerBorrowerINR: number;
  /** Loans below this gross rate are skipped. */
  minInterestRatePct: number;
  /** Loans longer than this are skipped. */
  maxTenureMonths: number;
  /** Lending happens in multiples of this (LenDenClub lot is typically Rs. 250). */
  lotSizeINR: number;
  /** Per-grade cap as % of the run budget, e.g. { "A": 100, "B": 50 }. */
  gradeCapsPct: Record<string, number>;
  /** Assumed annual default/loss rate per grade in %, used to compute expected NET return. */
  assumedDefaultRatesPct: Record<string, number>;
}

export interface ApiConfig {
  /** e.g. "https://api.lendenclub.com" — capture the real host from DevTools. */
  baseUrl: string;
  endpoints: {
    sendOtp: string;
    verifyOtp: string;
    loans: string;
    balance: string;
    invest: string;
  };
  /** Extra headers every request needs (device ids, api keys the web app sends, etc.). */
  extraHeaders: Record<string, string>;
}

export interface BotConfig {
  mobileNumber: string;
  /** Total amount this run is allowed to deploy, INR. */
  budgetINR: number;
  /** false = dry run (default). Only invests when this is true AND you confirm at the prompt. */
  live: boolean;
  strategy: StrategyConfig;
  api: ApiConfig;
}

export interface AllocationItem {
  loan: Loan;
  amountINR: number;
  /** Expected net annual return %, after the assumed default rate for its grade. */
  expectedNetPct: number;
}

export interface Plan {
  items: AllocationItem[];
  totalINR: number;
  /** Budget-weighted gross interest rate of the plan. */
  weightedGrossPct: number;
  /** Budget-weighted expected net return after assumed defaults. */
  weightedNetPct: number;
  /** Loans that were filtered out, with the reason, for transparency. */
  skipped: Array<{ loan: Loan; reason: string }>;
}
