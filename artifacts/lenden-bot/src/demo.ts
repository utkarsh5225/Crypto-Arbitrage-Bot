import type { Loan } from './types.ts';

/**
 * Synthetic marketplace for --demo runs, so the strategy and the CLI flow can be
 * exercised end-to-end without credentials or network access. Deterministic on
 * purpose — no randomness, so repeated runs are comparable.
 */
export function demoLoans(): Loan[] {
  const specs: Array<[string, string, number, number, number, string, string]> = [
    ['L-1001', 'B-501', 24.0, 6, 40_000, 'C', 'Working capital'],
    ['L-1002', 'B-502', 15.5, 12, 25_000, 'A', 'Medical'],
    ['L-1003', 'B-503', 18.0, 9, 60_000, 'B', 'Education'],
    ['L-1004', 'B-504', 30.0, 3, 15_000, 'D', 'Consumer purchase'],
    ['L-1005', 'B-505', 13.0, 24, 80_000, 'A', 'Home improvement'],
    ['L-1006', 'B-506', 21.0, 12, 35_000, 'B', 'Business expansion'],
    ['L-1007', 'B-507', 27.5, 6, 20_000, 'C', 'Travel'],
    ['L-1008', 'B-508', 11.0, 18, 50_000, 'A', 'Debt consolidation'],
    ['L-1009', 'B-503', 19.5, 6, 30_000, 'B', 'Education (2nd loan)'],
    ['L-1010', 'B-510', 35.0, 12, 10_000, 'E', 'Unsecured personal'],
    ['L-1011', 'B-511', 22.0, 36, 45_000, 'B', 'Vehicle'],
    ['L-1012', 'B-512', 16.5, 12, 5_000, 'unknown', 'Unclassified'],
  ];
  return specs.map(([id, borrowerId, rate, tenure, fundable, grade, purpose]) => ({
    id,
    borrowerId,
    interestRatePct: rate,
    tenureMonths: tenure,
    fundableINR: fundable,
    grade,
    purpose,
    raw: { demo: true },
  }));
}
