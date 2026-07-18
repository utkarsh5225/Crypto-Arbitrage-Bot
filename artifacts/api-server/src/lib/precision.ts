/**
 * Pure, dependency-free numeric helpers for live execution.
 *
 * Kept in their own module (no scanner / ws / crypto imports) so the
 * money-critical math is unit-testable in isolation.
 */

/** Number of decimal places in a step size (handles scientific notation). */
function decimalPlaces(step: number): number {
  if (Number.isInteger(step)) return 0;
  const str = step.toString();
  if (str.includes("e-")) {
    const [mantissa, exp] = str.split("e-");
    const mantissaDecimals = (mantissa.split(".")[1] ?? "").length;
    return mantissaDecimals + parseInt(exp, 10);
  }
  return (str.split(".")[1] ?? "").length;
}

/**
 * Round DOWN a base-asset quantity to the nearest valid lot-size step.
 * Works for ANY step (0.001, 0.05, 1, 10, …), not just powers of ten.
 * If stepSize is 0 (no filter), fall back to `basePrecision` decimal places.
 *
 *   roundToStep(0.123456789, 0.001, 8) → 0.123
 *   roundToStep(0.17,        0.05,  8) → 0.15
 *   roundToStep(1234.5,      10,    0) → 1230
 *   roundToStep(0.123456789, 0,     8) → 0.12345678
 */
export function roundToStep(value: number, stepSize: number, basePrecision: number): number {
  if (stepSize > 0) {
    // Floor to the nearest multiple of stepSize. The small epsilon absorbs
    // floating-point error so a value that is exactly on a step boundary
    // (e.g. 0.3 / 0.1 = 2.9999999999996) is not pushed a step too low.
    const multiples = Math.floor(value / stepSize + 1e-9);
    const result = multiples * stepSize;
    // Clean residual FP drift by snapping to the step's decimal places.
    return Number(result.toFixed(Math.min(decimalPlaces(stepSize), 12)));
  }
  const factor = Math.pow(10, basePrecision);
  return Math.floor(value * factor) / factor;
}

/**
 * Round DOWN a quote-asset amount to `quotePrecision` decimal places.
 * Always floors so we never spend more than intended.
 */
export function roundQuote(value: number, quotePrecision: number): number {
  const factor = Math.pow(10, quotePrecision);
  return Math.floor(value * factor) / factor;
}

/** A single Binance fill's fee fields (subset). */
export interface FillCommission {
  commission: string;
  commissionAsset: string;
}

/**
 * Sum of commissions charged in a specific asset across an order's fills.
 * Only same-asset commissions reduce the balance we can thread forward;
 * BNB-paid fees do not touch the received asset.
 */
export function sumCommissionInAsset(
  fills: FillCommission[] | undefined,
  asset: string,
): number {
  if (!fills?.length) return 0;
  let total = 0;
  for (const f of fills) {
    if (f.commissionAsset === asset) total += parseFloat(f.commission) || 0;
  }
  return total;
}

/**
 * Adverse slippage fraction for a filled leg, or 0 if the fill was at/better
 * than expected.
 *
 *  - BUY  leg: adverse when the fill price is HIGHER than expected (paid more).
 *  - SELL leg: adverse when the fill price is LOWER than expected (received less).
 *
 * Returns e.g. 0.004 for 0.4% adverse slippage. Non-positive expected prices
 * yield 0 (nothing to compare against).
 */
export function adverseSlippage(buy: boolean, expected: number, actual: number): number {
  if (!(expected > 0) || !(actual > 0)) return 0;
  const frac = buy ? (actual - expected) / expected : (expected - actual) / expected;
  return frac > 0 ? frac : 0;
}

export interface LegFilterMinimums {
  minNotional: number;
  minQty: number;
}

export interface MinimumViolation {
  leg: number; // 1-based
  reason: "minNotional" | "minQty";
  value: number;
  min: number;
}

/**
 * Simulate a triangle's per-leg order size (in each pair's quote asset for
 * NOTIONAL, and base units for a SELL's minQty) from a starting notional,
 * using the book prices, and return the first leg that would fall below a
 * Binance minimum — or null if all legs clear.
 *
 * `prices[i]` is the ask for a BUY leg and the bid for a SELL leg.
 */
export function checkTriangleMinimums(
  buys: boolean[],
  prices: number[],
  notional: number,
  filters: LegFilterMinimums[],
): MinimumViolation | null {
  let amount = notional;
  for (let i = 0; i < buys.length; i++) {
    const price = prices[i];
    const f = filters[i];
    const legNotional = buys[i] ? amount : amount * price;
    if (f.minNotional > 0 && legNotional < f.minNotional) {
      return { leg: i + 1, reason: "minNotional", value: legNotional, min: f.minNotional };
    }
    // A SELL places a base-quantity order (`amount`), subject to LOT_SIZE minQty.
    if (!buys[i] && f.minQty > 0 && amount < f.minQty) {
      return { leg: i + 1, reason: "minQty", value: amount, min: f.minQty };
    }
    amount = buys[i] ? amount / price : amount * price;
  }
  return null;
}
