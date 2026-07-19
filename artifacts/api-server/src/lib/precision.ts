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

// ---------------------------------------------------------------------------
// Depth-aware (VWAP) triangle simulation
//
// The scanner's `evalTriangle` predicts profit from TOP-OF-BOOK prices only.
// A real MARKET order walks the book, so a fixed notional fills at a
// volume-weighted price that is worse than the top — which is exactly how
// "profitable" quotes turn into realised losses. These helpers replay the 3
// legs against a real order-book snapshot so the entry decision reflects the
// price we would actually get for the intended size, net of taker fees.
// ---------------------------------------------------------------------------

/** One side of an order book: [price, quantity] string tuples, best level first. */
export interface DepthBook {
  /** Descending by price (best/highest first). */
  bids: [string, string][];
  /** Ascending by price (best/lowest first). */
  asks: [string, string][];
}

export interface VwapSim {
  /** Realised net return as a fraction of notional (e.g. 0.0012 = +0.12%). */
  netPct: number;
  /** Realised net profit in the starting (USDT) unit. */
  netUsd: number;
  /** Final USDT amount after all 3 legs. */
  finalAmount: number;
}

/**
 * Spend `quoteToSpend` walking ASKS (price ascending). Returns the base amount
 * received, or null if the book lacks the depth to fill the whole size (we must
 * never assume liquidity that isn't there).
 */
export function walkBuy(asks: [string, string][], quoteToSpend: number): number | null {
  let remaining = quoteToSpend;
  let base = 0;
  for (const [pStr, qStr] of asks) {
    const price = parseFloat(pStr);
    const qty = parseFloat(qStr);
    if (!(price > 0) || !(qty > 0)) continue;
    const levelQuote = price * qty;
    if (levelQuote >= remaining) {
      base += remaining / price;
      remaining = 0;
      break;
    }
    base += qty;
    remaining -= levelQuote;
  }
  if (remaining > 1e-9) return null; // insufficient depth
  return base;
}

/**
 * Sell `baseToSell` walking BIDS (price descending). Returns the quote amount
 * received, or null if the book lacks the depth to fill the whole size.
 */
export function walkSell(bids: [string, string][], baseToSell: number): number | null {
  let remaining = baseToSell;
  let quote = 0;
  for (const [pStr, qStr] of bids) {
    const price = parseFloat(pStr);
    const qty = parseFloat(qStr);
    if (!(price > 0) || !(qty > 0)) continue;
    if (qty >= remaining) {
      quote += remaining * price;
      remaining = 0;
      break;
    }
    quote += qty * price;
    remaining -= qty;
  }
  if (remaining > 1e-9) return null; // insufficient depth
  return quote;
}

/**
 * Replay a 3-leg triangle against real order-book depth, walking each book to
 * the volume-weighted fill for `notional` and deducting `feeRate` on the asset
 * received at every leg (matching how Binance charges taker fees and how
 * live-execution threads net-of-commission amounts forward).
 *
 * Returns null if any leg lacks the depth to fill the size — the caller should
 * then skip the trade rather than execute into a book that can't absorb it.
 *
 * `books[i]` is the order book for leg i's symbol; `buys[i]` is its direction
 * (BUY spends quote→receives base; SELL sells base→receives quote). Books are
 * Binance-ordered (bids high→low, asks low→high).
 */
export function simulateTriangleVWAP(
  books: DepthBook[],
  buys: boolean[],
  notional: number,
  feeRate: number,
): VwapSim | null {
  if (books.length < 3 || !(notional > 0)) return null;
  let amount = notional; // starts as USDT (the quote asset of leg 1)
  for (let i = 0; i < 3; i++) {
    const book = books[i];
    if (!book) return null;
    const received = buys[i]
      ? walkBuy(book.asks ?? [], amount)
      : walkSell(book.bids ?? [], amount);
    if (received === null) return null;
    amount = received * (1 - feeRate);
    if (!(amount > 0)) return null;
  }
  const netUsd = amount - notional;
  return { netPct: netUsd / notional, netUsd, finalAmount: amount };
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
