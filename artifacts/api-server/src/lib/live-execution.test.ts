import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeLiveTrade,
  LiveTradeError,
  type ExecutionDeps,
  type TriangleForExecution,
} from "./live-execution";

// ---------------------------------------------------------------------------
// Test fakes — no network, fully deterministic
// ---------------------------------------------------------------------------

interface Scripted {
  executedQty: string;
  cummulativeQuoteQty: string;
  status?: string;
  fills?: { commission: string; commissionAsset: string }[];
}

/** Build injectable deps with a scripted client and generous (no-op) filters. */
function makeDeps(usdtFree: number, scripts: Scripted[]) {
  const calls: { symbol: string; side: string; qty: any }[] = [];
  let i = 0;
  const deps: ExecutionDeps = {
    makeClient: () => ({
      async getAccount() {
        return {
          canTrade: true,
          balances: [{ asset: "USDT", free: String(usdtFree), locked: "0" }],
        };
      },
      async placeMarketOrder(symbol, side, qty) {
        const s = scripts[i] ?? scripts[scripts.length - 1];
        i += 1;
        calls.push({ symbol, side, qty });
        return {
          orderId: 1000 + i,
          symbol,
          side,
          status: s.status ?? "FILLED",
          executedQty: s.executedQty,
          cummulativeQuoteQty: s.cummulativeQuoteQty,
          fills: (s.fills ?? []).map((f) => ({ price: "0", qty: "0", ...f })),
          transactTime: 1_700_000_000_000,
        };
      },
    }),
    getFilters: () => ({
      quotePrecision: 8,
      basePrecision: 8,
      lotStepSize: 0,
      minNotional: 0,
      minQty: 0,
    }),
  };
  return { deps, calls };
}

// USDT → BTC → ETH → USDT, buy / buy / sell
const TRI: TriangleForExecution = {
  path: ["USDT", "BTC", "ETH", "USDT"],
  symbols: ["BTCUSDT", "ETHBTC", "ETHUSDT"],
  buys: [true, true, false],
};

const EXPECTED = [50000, 0.06, 3050];

// ---------------------------------------------------------------------------

test("executeLiveTrade: happy path returns net profit and 3 orders", async () => {
  const { deps, calls } = makeDeps(2000, [
    { executedQty: "0.02", cummulativeQuoteQty: "1000" }, // BUY BTC @ 50000
    { executedQty: "0.3333", cummulativeQuoteQty: "0.02" }, // BUY ETH with 0.02 BTC
    { executedQty: "0.3333", cummulativeQuoteQty: "1016.5" }, // SELL ETH → 1016.5 USDT
  ]);

  const result = await executeLiveTrade(TRI, "op1", 1000, "k", "s", false, EXPECTED, 0.01, deps);

  assert.equal(calls.length, 3);
  assert.equal(result.orderIds.length, 3);
  assert.equal(result.liveOrders.length, 3);
  assert.ok(Math.abs(result.finalAmount - 1016.5) < 1e-6);
  assert.ok(Math.abs(result.netProfitUsd - 16.5) < 1e-6);
});

test("executeLiveTrade: subtracts base-asset commission before threading", async () => {
  const { deps, calls } = makeDeps(2000, [
    // BUY 0.02 BTC but 0.00002 BTC taken as commission → 0.01998 available
    {
      executedQty: "0.02",
      cummulativeQuoteQty: "1000",
      fills: [{ commission: "0.00002", commissionAsset: "BTC" }],
    },
    { executedQty: "0.3", cummulativeQuoteQty: "0.01998" },
    { executedQty: "0.3", cummulativeQuoteQty: "1010" },
  ]);

  await executeLiveTrade(TRI, "op2", 1000, "k", "s", false, EXPECTED, 0, deps);

  // Leg 2 must be sized off the net BTC (0.01998), not the gross 0.02.
  assert.deepEqual(calls[1].qty, { quoteOrderQty: 0.01998 });
});

test("executeLiveTrade: aborts before any order when USDT balance is short", async () => {
  const { deps, calls } = makeDeps(500, [
    { executedQty: "0.02", cummulativeQuoteQty: "1000" },
  ]);

  await assert.rejects(
    () => executeLiveTrade(TRI, "op3", 1000, "k", "s", false, EXPECTED, 0, deps),
    (err: unknown) => {
      assert.ok(err instanceof LiveTradeError);
      assert.equal(err.failedLeg, 0);
      assert.match(err.message, /Insufficient USDT/);
      return true;
    },
  );
  assert.equal(calls.length, 0); // no orders placed
});

test("executeLiveTrade: zero-fill mid-leg aborts and unwinds the stranded asset", async () => {
  const { deps, calls } = makeDeps(2000, [
    { executedQty: "0.02", cummulativeQuoteQty: "1000" }, // leg 1 BUY BTC ok
    { executedQty: "0", cummulativeQuoteQty: "0", status: "EXPIRED" }, // leg 2 no fill
    { executedQty: "0.02", cummulativeQuoteQty: "999" }, // unwind SELL BTCUSDT
  ]);

  await assert.rejects(
    () => executeLiveTrade(TRI, "op4", 1000, "k", "s", false, EXPECTED, 0, deps),
    (err: unknown) => {
      assert.ok(err instanceof LiveTradeError);
      assert.equal(err.failedLeg, 2);
      assert.ok(err.unwindOrder, "expected an unwind order");
      assert.equal(err.unwindOrder!.symbol, "BTCUSDT");
      assert.equal(err.unwindOrder!.side, "SELL");
      return true;
    },
  );
  // leg1, leg2 (failed), unwind
  assert.equal(calls.length, 3);
  assert.equal(calls[2].symbol, "BTCUSDT");
});

test("executeLiveTrade: aborts and unwinds when a leg slips past the limit", async () => {
  const { deps } = makeDeps(2000, [
    // BUY fills at 51000 vs expected 50000 → 2% adverse, over the 0.5% limit
    { executedQty: "0.019607843", cummulativeQuoteQty: "1000" },
    { executedQty: "0.019", cummulativeQuoteQty: "998" }, // unwind SELL BTCUSDT
  ]);

  await assert.rejects(
    () => executeLiveTrade(TRI, "op5", 1000, "k", "s", false, EXPECTED, 0.005, deps),
    (err: unknown) => {
      assert.ok(err instanceof LiveTradeError);
      assert.equal(err.failedLeg, 1);
      assert.match(err.message, /slippage/i);
      assert.ok(err.unwindOrder, "expected an unwind order");
      assert.equal(err.unwindOrder!.symbol, "BTCUSDT");
      return true;
    },
  );
});
