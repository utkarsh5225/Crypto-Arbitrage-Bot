import { test } from "node:test";
import assert from "node:assert/strict";
import {
  roundToStep,
  roundQuote,
  sumCommissionInAsset,
  adverseSlippage,
  checkTriangleMinimums,
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
