import type { AllocationItem, Loan, Plan, StrategyConfig } from './types.ts';

/**
 * Expected NET annual return for a loan: the gross rate minus the assumed annual
 * default/loss rate for its grade. Returns null (with a reason) when the loan
 * fails the config filters.
 */
export function scoreLoan(
  loan: Loan,
  cfg: StrategyConfig,
): { expectedNetPct: number } | { rejected: string } {
  if (loan.interestRatePct < cfg.minInterestRatePct) {
    return { rejected: `rate ${loan.interestRatePct}% < min ${cfg.minInterestRatePct}%` };
  }
  if (loan.tenureMonths > cfg.maxTenureMonths) {
    return { rejected: `tenure ${loan.tenureMonths}m > max ${cfg.maxTenureMonths}m` };
  }
  const gradeCap = cfg.gradeCapsPct[loan.grade] ?? cfg.gradeCapsPct.unknown ?? 0;
  if (gradeCap <= 0) {
    return { rejected: `grade ${loan.grade} capped at 0%` };
  }
  const defaultRate = cfg.assumedDefaultRatesPct[loan.grade] ?? cfg.assumedDefaultRatesPct.unknown ?? 15;
  const expectedNetPct = loan.interestRatePct - defaultRate;
  if (expectedNetPct <= 0) {
    return { rejected: `expected net ${expectedNetPct.toFixed(1)}% <= 0 after assumed defaults` };
  }
  return { expectedNetPct };
}

function floorToLot(amount: number, lot: number): number {
  return Math.floor(amount / lot) * lot;
}

/**
 * Greedy allocation that maximises expected net return under the caps:
 * rank loans by expected net return, then fill each as far as the per-loan,
 * per-borrower, per-grade and budget limits allow. Diversification comes from
 * the caps rather than from spreading thin: with maxPerLoanINR small relative
 * to the budget, the plan naturally lands across many loans.
 */
export function buildPlan(loans: Loan[], budgetINR: number, cfg: StrategyConfig): Plan {
  const scored: Array<{ loan: Loan; expectedNetPct: number }> = [];
  const skipped: Plan['skipped'] = [];

  for (const loan of loans) {
    const s = scoreLoan(loan, cfg);
    if ('rejected' in s) skipped.push({ loan, reason: s.rejected });
    else scored.push({ loan, expectedNetPct: s.expectedNetPct });
  }

  // Highest expected net return first; longer tenure breaks ties last (money locked longer).
  scored.sort((a, b) => b.expectedNetPct - a.expectedNetPct || a.loan.tenureMonths - b.loan.tenureMonths);

  const items: AllocationItem[] = [];
  const gradeSpent = new Map<string, number>();
  const borrowerSpent = new Map<string, number>();
  let remaining = floorToLot(budgetINR, cfg.lotSizeINR);

  for (const { loan, expectedNetPct } of scored) {
    if (remaining < cfg.lotSizeINR) break;
    const gradeCapINR = ((cfg.gradeCapsPct[loan.grade] ?? cfg.gradeCapsPct.unknown ?? 0) / 100) * budgetINR;
    const gradeRoom = gradeCapINR - (gradeSpent.get(loan.grade) ?? 0);
    const borrowerRoom = cfg.maxPerBorrowerINR - (borrowerSpent.get(loan.borrowerId) ?? 0);
    const amount = floorToLot(
      Math.min(cfg.maxPerLoanINR, loan.fundableINR, remaining, gradeRoom, borrowerRoom),
      cfg.lotSizeINR,
    );
    if (amount < cfg.lotSizeINR) {
      skipped.push({ loan, reason: 'caps left no room (grade/borrower/budget)' });
      continue;
    }
    items.push({ loan, amountINR: amount, expectedNetPct });
    remaining -= amount;
    gradeSpent.set(loan.grade, (gradeSpent.get(loan.grade) ?? 0) + amount);
    borrowerSpent.set(loan.borrowerId, (borrowerSpent.get(loan.borrowerId) ?? 0) + amount);
  }

  const totalINR = items.reduce((s, i) => s + i.amountINR, 0);
  const weightedGrossPct =
    totalINR > 0 ? items.reduce((s, i) => s + i.loan.interestRatePct * i.amountINR, 0) / totalINR : 0;
  const weightedNetPct =
    totalINR > 0 ? items.reduce((s, i) => s + i.expectedNetPct * i.amountINR, 0) / totalINR : 0;

  return { items, totalINR, weightedGrossPct, weightedNetPct, skipped };
}
