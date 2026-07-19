import { test } from "node:test";
import assert from "node:assert/strict";
import {
  roundToStep,
  roundQuote,
  sumCommissionInAsset,
  adverseSlippage,
  checkTriangleMinimums,
  simulateTriangleVWAP,
  walkBuy,
  walkSell,
  type DepthBook,
} from "./precision";

// ---------------------------------------------------------------------------
// roundToStep — base-quantity rounding for SELL legs
// ---------------------------------------------------------------------------

test("roundToStep floors to the step size", () => {
  assert.equal(roundToStep(0.123456789, 0.001, 8), 0.123);
  assert.equal(roundToStep(1.9999, 0.01, 8), 1.99);
  assert.equal(roundToStep(5, 1, 8), 5);
});

test("roundToStep falls back to basePrecision when step is 0", () => {
  assert.equal(roundToStep(0.123456789, 0, 8), 0.12345678);
  assert.equal(roundToStep(0.123456789, 0, 2), 0.12);
});

test("roundToStep never rounds up (would overspend the balance)", () => {
  // 0.29999999 with step 0.1 must floor to 0.2, not 0.3
  assert.equal(roundToStep(0.29999999, 0.1, 8), 0.2);
});

test("roundToStep handles coarse integer steps", () => {
  assert.equal(roundToStep(1234.5, 10, 0), 1230);
});

test("roundToStep handles non-power-of-ten steps", () => {
  assert.equal(roundToStep(0.17, 0.05, 8), 0.15);
  assert.equal(roundToStep(0.15, 0.05, 8), 0.15); // exact boundary, no FP drop
  assert.equal(roundToStep(7, 5, 0), 5);
});

test("roundToStep keeps an exact multiple intact despite FP", () => {
  // 0.3 / 0.1 = 2.9999999999999996 in IEEE-754 — must not floor to 0.2
  assert.equal(roundToStep(0.3, 0.1, 8), 0.3);
});

// ---------------------------------------------------------------------------
// roundQuote — quote-amount rounding for BUY legs
// ---------------------------------------------------------------------------

test("roundQuote floors to the quote precision", () => {
  assert.equal(roundQuote(123.4567891, 2), 123.45);
  assert.equal(roundQuote(123.4567891, 4), 123.4567);
  assert.equal(roundQuote(999.999, 0), 999);
});

// ---------------------------------------------------------------------------
// sumCommissionInAsset — commission threading
// ---------------------------------------------------------------------------

test("sumCommissionInAsset sums only same-asset fees", () => {
  const fills = [
    { commission: "0.001", commissionAsset: "BTC" },
    { commission: "0.002", commissionAsset: "BTC" },
    { commission: "0.5", commissionAsset: "BNB" }, // paid in BNB — must be ignored
  ];
  assert.equal(sumCommissionInAsset(fills, "BTC"), 0.003);
  assert.equal(sumCommissionInAsset(fills, "BNB"), 0.5);
  assert.equal(sumCommissionInAsset(fills, "ETH"), 0);
});

test("sumCommissionInAsset tolerates missing/empty fills", () => {
  assert.equal(sumCommissionInAsset(undefined, "BTC"), 0);
  assert.equal(sumCommissionInAsset([], "BTC"), 0);
});

// ---------------------------------------------------------------------------
// adverseSlippage — market-order price protection
// ---------------------------------------------------------------------------

test("adverseSlippage is positive only when the fill is worse", () => {
  // BUY: paying more than expected is adverse
  assert.ok(Math.abs(adverseSlippage(true, 100, 101) - 0.01) < 1e-9);
  assert.equal(adverseSlippage(true, 100, 99), 0); // paid less — favorable

  // SELL: receiving less than expected is adverse
  assert.ok(Math.abs(adverseSlippage(false, 100, 98) - 0.02) < 1e-9);
  assert.equal(adverseSlippage(false, 100, 101), 0); // got more — favorable
});

test("adverseSlippage guards against non-positive prices", () => {
  assert.equal(adverseSlippage(true, 0, 100), 0);
  assert.equal(adverseSlippage(true, 100, 0), 0);
});

// ---------------------------------------------------------------------------
// checkTriangleMinimums — MIN_NOTIONAL / LOT_SIZE guard
// ---------------------------------------------------------------------------

const NO_MIN = { minNotional: 0, minQty: 0 };

test("checkTriangleMinimums passes when every leg clears", () => {
  // USDT→BTC→ETH→USDT, buy/buy/sell, notional 1000
  const v = checkTriangleMinimums(
    [true, true, false],
    [50000, 0.05, 3000],
    1000,
    [NO_MIN, NO_MIN, NO_MIN],
  );
  assert.equal(v, null);
});

test("checkTriangleMinimums flags a BUY leg below minNotional", () => {
  // Leg 1 spends 5 USDT but the pair requires 10
  const v = checkTriangleMinimums(
    [true, false, false],
    [50000, 3000, 1],
    5,
    [{ minNotional: 10, minQty: 0 }, NO_MIN, NO_MIN],
  );
  assert.equal(v?.leg, 1);
  assert.equal(v?.reason, "minNotional");
  assert.equal(v?.min, 10);
});

test("checkTriangleMinimums flags a SELL leg below minQty", () => {
  // Leg 1 buys ~0.0002 BTC; leg 2 sells it but minQty is 0.001
  const v = checkTriangleMinimums(
    [true, false, false],
    [50000, 3000, 1],
    10, // 10 USDT / 50000 = 0.0002 BTC
    [NO_MIN, { minNotional: 0, minQty: 0.001 }, NO_MIN],
  );
  assert.equal(v?.leg, 2);
  assert.equal(v?.reason, "minQty");
});

test("checkTriangleMinimums reports the FIRST violating leg", () => {
  const v = checkTriangleMinimums(
    [true, true, false],
    [50000, 0.05, 3000],
    1000,
    [{ minNotional: 2000, minQty: 0 }, { minNotional: 2000, minQty: 0 }, NO_MIN],
  );
  assert.equal(v?.leg, 1);
});

// ---------------------------------------------------------------------------
// walkBuy / walkSell — order-book VWAP walking
// ---------------------------------------------------------------------------

test("walkBuy fills within a single deep level", () => {
  // Spend 1000 USDT at 50000 with 100 BTC available → 0.02 BTC, no walking.
  assert.ok(Math.abs(walkBuy([["50000", "100"]], 1000)! - 0.02) < 1e-12);
});

test("walkBuy walks multiple levels (impact) and returns less than top-of-book", () => {
  // 0.01 BTC at 50000 (=500 USDT) then the rest at 50100.
  const base = walkBuy([["50000", "0.01"], ["50100", "1"]], 1000)!;
  // top-of-book would give 1000/50000 = 0.02; walking must yield strictly less.
  assert.ok(base < 0.02);
  assert.ok(Math.abs(base - (0.01 + 500 / 50100)) < 1e-12);
});

test("walkBuy returns null when depth is insufficient", () => {
  // Only 50 USDT of depth available for a 1000 USDT order.
  assert.equal(walkBuy([["50000", "0.001"]], 1000), null);
});

test("walkSell fills within a single deep level", () => {
  // Sell 0.3333 ETH at bid 3060 with 1000 ETH bid depth.
  assert.ok(Math.abs(walkSell([["3060", "1000"]], 1 / 3)! - 1020) < 1e-9);
});

test("walkSell returns null when depth is insufficient", () => {
  assert.equal(walkSell([["3060", "0.1"]], 1), null);
});

// ---------------------------------------------------------------------------
// simulateTriangleVWAP — depth-aware triangle profit
// ---------------------------------------------------------------------------

// USDT→BTC→ETH→USDT, buy/buy/sell, with deep single-level books.
const DEEP_BOOKS: DepthBook[] = [
  { bids: [], asks: [["50000", "100"]] }, // BTCUSDT: buy BTC with USDT
  { bids: [], asks: [["0.06", "1000"]] }, // ETHBTC:  buy ETH with BTC
  { bids: [["3060", "1000"]], asks: [] }, // ETHUSDT: sell ETH for USDT
];

test("simulateTriangleVWAP: zero-fee profit matches the book math", () => {
  const sim = simulateTriangleVWAP(DEEP_BOOKS, [true, true, false], 1000, 0)!;
  // 1000/50000=0.02 BTC → /0.06=0.3333 ETH → *3060=1020 USDT
  assert.ok(Math.abs(sim.finalAmount - 1020) < 1e-6);
  assert.ok(Math.abs(sim.netUsd - 20) < 1e-6);
  assert.ok(Math.abs(sim.netPct - 0.02) < 1e-9);
});

test("simulateTriangleVWAP: taker fees reduce the edge on every leg", () => {
  const gross = simulateTriangleVWAP(DEEP_BOOKS, [true, true, false], 1000, 0)!;
  const net = simulateTriangleVWAP(DEEP_BOOKS, [true, true, false], 1000, 0.001)!;
  assert.ok(net.netPct < gross.netPct);
  // 0.999^3 compounding on a 1020 gross → ~1016.9 net
  assert.ok(Math.abs(net.finalAmount - 1020 * 0.999 ** 3) < 1e-6);
});

test("simulateTriangleVWAP: thin books cut the edge vs deep books", () => {
  // Same prices, but leg 1 only has 0.01 BTC at the top before a worse level.
  const thin: DepthBook[] = [
    { bids: [], asks: [["50000", "0.01"], ["50500", "100"]] },
    { bids: [], asks: [["0.06", "1000"]] },
    { bids: [["3060", "1000"]], asks: [] },
  ];
  const deep = simulateTriangleVWAP(DEEP_BOOKS, [true, true, false], 1000, 0.001)!;
  const shallow = simulateTriangleVWAP(thin, [true, true, false], 1000, 0.001)!;
  assert.ok(shallow.netPct < deep.netPct);
});

test("simulateTriangleVWAP: returns null when any leg lacks depth", () => {
  const noDepth: DepthBook[] = [
    { bids: [], asks: [["50000", "0.001"]] }, // only 50 USDT of depth
    { bids: [], asks: [["0.06", "1000"]] },
    { bids: [["3060", "1000"]], asks: [] },
  ];
  assert.equal(simulateTriangleVWAP(noDepth, [true, true, false], 1000, 0.001), null);
});

test("simulateTriangleVWAP: guards bad inputs", () => {
  assert.equal(simulateTriangleVWAP(DEEP_BOOKS, [true, true, false], 0, 0.001), null);
  assert.equal(simulateTriangleVWAP(DEEP_BOOKS.slice(0, 2), [true, true, false], 1000, 0.001), null);
});
