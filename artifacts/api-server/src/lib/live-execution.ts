/**
 * Live trade execution — fires real Binance market orders for all 3 legs of a triangle.
 *
 * Quantity precision rules (per Binance filter docs):
 *  - BUY  leg: send quoteOrderQty  → round DOWN to `quotePrecision` decimal places
 *  - SELL leg: send quantity        → round DOWN to nearest `lotStepSize` multiple
 *                                     (falling back to `basePrecision` if stepSize = 0)
 *
 * Safety rules:
 *  - Only USDT-starting triangles are supported (the first leg always spends USDT,
 *    so the initial notional is unambiguous)
 *  - A pre-trade balance check ensures enough USDT is available before firing
 *  - A single-leg failure aborts the remaining legs and best-effort unwinds any
 *    stranded intermediate asset back to USDT
 *  - Daily loss limit is checked before execution; see scanner.ts
 */

import { createClient, type BinanceOrderResult, type BinanceAccount } from "./binance-client";
import { getSymbolFilters, type SymbolFilters } from "./scanner";
import { type LiveOrder } from "./store";
import { logger } from "./logger";
import { roundToStep, roundQuote, sumCommissionInAsset, adverseSlippage } from "./precision";

/**
 * The subset of the Binance client the executor needs. Declared as an interface
 * so tests can inject a fake without touching the network.
 */
export interface ExecClient {
  placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    qty: { quoteOrderQty: number } | { quantity: number },
  ): Promise<BinanceOrderResult>;
  getAccount(): Promise<BinanceAccount>;
}

/** Injectable dependencies — real implementations by default, fakes in tests. */
export interface ExecutionDeps {
  makeClient: (apiKey: string, apiSecret: string, useTestnet: boolean) => ExecClient;
  getFilters: (symbol: string) => SymbolFilters;
}

const defaultDeps: ExecutionDeps = {
  makeClient: (apiKey, apiSecret, useTestnet) => createClient(apiKey, apiSecret, useTestnet),
  getFilters: getSymbolFilters,
};

/**
 * Thrown when a triangle aborts mid-execution. Carries the legs that DID fill,
 * plus the outcome of the best-effort unwind that converts any stranded
 * intermediate asset back to USDT, so the caller can record everything in the
 * order history.
 */
export class LiveTradeError extends Error {
  constructor(
    message: string,
    public readonly failedLeg: number,
    public readonly filledOrders: LiveOrder[],
    public readonly unwindOrder: LiveOrder | null,
    public readonly unwindError?: string,
  ) {
    super(message);
    this.name = "LiveTradeError";
  }
}

export interface TriangleForExecution {
  path: string[]; // e.g. ["USDT","BTC","ETH","USDT"]
  symbols: [string, string, string];
  buys: [boolean, boolean, boolean];
}

export interface LiveTradeResult {
  orderIds: number[];
  fillPrices: number[];
  finalAmount: number;
  netProfitUsd: number;
  netProfitPct: number;
  liveOrders: LiveOrder[];
}

// ---------------------------------------------------------------------------
// Average fill price
// ---------------------------------------------------------------------------

function avgFillPrice(order: BinanceOrderResult): number {
  const qty = parseFloat(order.executedQty);
  const quote = parseFloat(order.cummulativeQuoteQty);
  if (qty === 0) return 0;
  return quote / qty;
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

/**
 * Execute all 3 legs of a triangle sequentially.
 *
 * Leg threading:
 *   BUY  leg → receive base  → `executedQty`          is the amount for the next leg
 *   SELL leg → receive quote → `cummulativeQuoteQty`   is the amount for the next leg
 *
 * Returns the trade result on success; throws on any leg failure.
 */
/**
 * Best-effort unwind: convert a stranded intermediate asset back to USDT after
 * a triangle aborts. Places a MARKET SELL on `${asset}USDT` for the amount we
 * are holding. Returns the resulting LiveOrder, or null (with a reason logged)
 * if the conversion could not be attempted or failed.
 *
 * This is intentionally forgiving — an unwind failure must never mask the
 * original leg failure, so it only ever returns null instead of throwing.
 */
async function attemptUnwind(
  client: ExecClient,
  asset: string,
  amount: number,
  pathLabel: string,
  failedLeg: number,
  getFilters: ExecutionDeps["getFilters"],
): Promise<{ order: LiveOrder | null; error?: string }> {
  if (asset === "USDT") {
    // Nothing was converted yet (leg 1 failed) — no position to unwind.
    return { order: null };
  }

  const symbol = `${asset}USDT`;
  const filters = getFilters(symbol);
  const qty = roundToStep(amount, filters.lotStepSize, filters.basePrecision);

  if (qty <= 0) {
    const error = `Unwind skipped: ${amount} ${asset} rounds to zero on ${symbol}`;
    logger.warn({ asset, amount, symbol }, error);
    return { order: null, error };
  }

  logger.warn(
    { asset, symbol, qty, path: pathLabel, failedLeg },
    "Attempting to unwind stranded asset back to USDT",
  );

  try {
    const order = await client.placeMarketOrder(symbol, "SELL", { quantity: qty });
    const liveOrder: LiveOrder = {
      orderId: order.orderId,
      symbol,
      side: "SELL",
      executedQty: parseFloat(order.executedQty),
      avgPrice: avgFillPrice(order),
      status: `UNWIND_${order.status}`,
      timestamp: new Date(order.transactTime).toISOString(),
      leg: failedLeg,
      trianglePath: `${pathLabel} (unwind)`,
    };
    logger.info(
      { symbol, orderId: order.orderId, recoveredUsdt: order.cummulativeQuoteQty },
      "Unwind complete — stranded asset converted back to USDT",
    );
    return { order: liveOrder };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ err, symbol, asset, qty }, "Unwind failed — position left open");
    return { order: null, error };
  }
}

export async function executeLiveTrade(
  tri: TriangleForExecution,
  opportunityId: string,
  notionalSize: number,
  apiKey: string,
  apiSecret: string,
  useTestnet = false,
  /** Per-leg book prices the opportunity was quoted at (ask for BUY, bid for SELL). */
  expectedPrices: number[] = [],
  /** Max adverse slippage per leg before aborting (fraction, e.g. 0.005 = 0.5%). 0 disables. */
  maxSlippage = 0,
  deps: ExecutionDeps = defaultDeps,
): Promise<LiveTradeResult> {
  if (tri.path[0] !== "USDT") {
    throw new Error(
      `Live trading only supports USDT-starting triangles (got ${tri.path[0]})`,
    );
  }

  const client = deps.makeClient(apiKey, apiSecret, useTestnet);
  const orderIds: number[] = [];
  const fillPrices: number[] = [];
  const liveOrders: LiveOrder[] = [];

  // ── Pre-trade balance check ────────────────────────────────────────────────
  // Confirm the account actually holds enough USDT before placing any order, so
  // we fail fast with a clear reason instead of a cryptic -2010 on leg 1.
  let account: BinanceAccount;
  try {
    account = await client.getAccount();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LiveTradeError(`Pre-trade balance check failed: ${msg}`, 0, [], null);
  }
  const usdtFree = parseFloat(account.balances.find((b) => b.asset === "USDT")?.free ?? "0");
  if (usdtFree < notionalSize) {
    throw new LiveTradeError(
      `Insufficient USDT balance: have ${usdtFree.toFixed(2)}, need ${notionalSize.toFixed(2)}`,
      0,
      [],
      null,
    );
  }

  let currentAmount = notionalSize; // starts as USDT
  const pathLabel = tri.path.join("→");

  for (let i = 0; i < 3; i++) {
    const symbol = tri.symbols[i];
    const buy = tri.buys[i];
    const side = buy ? "BUY" : "SELL";
    const filters = deps.getFilters(symbol);
    // Asset held going INTO this leg — what would be stranded if the leg fails.
    const heldAsset = tri.path[i];

    /** Abort the triangle, attempting to unwind whatever we are still holding. */
    const abort = async (reason: string): Promise<never> => {
      const { order, error } = await attemptUnwind(
        client,
        heldAsset,
        currentAmount,
        pathLabel,
        i + 1,
        deps.getFilters,
      );
      throw new LiveTradeError(
        `Leg ${i + 1} (${symbol} ${side}) failed: ${reason}`,
        i + 1,
        liveOrders,
        order,
        error,
      );
    };

    let roundedAmount: number;
    let orderQty: { quoteOrderQty: number } | { quantity: number };

    if (buy) {
      // Spending quote to receive base → use quoteOrderQty
      roundedAmount = roundQuote(currentAmount, filters.quotePrecision);
      orderQty = { quoteOrderQty: roundedAmount };
    } else {
      // Selling base to receive quote → use quantity (base amount)
      roundedAmount = roundToStep(currentAmount, filters.lotStepSize, filters.basePrecision);
      orderQty = { quantity: roundedAmount };
    }

    logger.info(
      {
        leg: i + 1,
        symbol,
        side,
        rawAmount: currentAmount,
        roundedAmount,
        filters,
        path: pathLabel,
      },
      "Executing live trade leg",
    );

    if (roundedAmount <= 0) {
      // No order placed yet — the held asset is unchanged, so unwind it.
      await abort(
        `rounded amount is zero after precision adjustment ` +
          `(raw=${currentAmount}, stepSize=${filters.lotStepSize}, quotePrecision=${filters.quotePrecision})`,
      );
    }

    let order: BinanceOrderResult;
    try {
      order = await client.placeMarketOrder(symbol, side, orderQty);
    } catch (err) {
      // Order rejected / network error — nothing filled, held asset unchanged.
      const msg = err instanceof Error ? err.message : String(err);
      await abort(msg);
      return undefined as never; // unreachable; keeps the type checker happy
    }

    // ── Fill verification ────────────────────────────────────────────────────
    // A MARKET order can EXPIRE or be REJECTED with zero fill (e.g. no
    // liquidity). Threading a zero amount into the next leg would corrupt the
    // whole triangle, so treat any zero-fill as a leg failure and unwind.
    const executedQty = parseFloat(order.executedQty);
    if (!(executedQty > 0)) {
      await abort(
        `order did not fill (status=${order.status}, executedQty=${order.executedQty})`,
      );
    }
    if (order.status !== "FILLED") {
      // Partial fill: continue with the ACTUAL executed amounts below, but flag
      // it — the remaining legs will size off real fills, not the request.
      logger.warn(
        { leg: i + 1, symbol, status: order.status, executedQty },
        "Leg only partially filled — continuing with actual executed amount",
      );
    }

    const fillPrice = avgFillPrice(order);
    orderIds.push(order.orderId);
    fillPrices.push(fillPrice);

    liveOrders.push({
      orderId: order.orderId,
      symbol,
      side,
      executedQty,
      avgPrice: fillPrice,
      status: order.status,
      timestamp: new Date(order.transactTime).toISOString(),
      leg: i + 1,
      trianglePath: pathLabel,
    });

    // Thread the running amount to the next leg — the ACTUAL fill, net of any
    // commission taken from the asset we just received.
    const receivedAsset = tri.path[i + 1];
    const grossReceived = buy ? executedQty : parseFloat(order.cummulativeQuoteQty);
    const commission = sumCommissionInAsset(order.fills, receivedAsset);
    currentAmount = Math.max(0, grossReceived - commission);

    logger.info(
      {
        leg: i + 1,
        symbol,
        orderId: order.orderId,
        grossReceived,
        commission,
        commissionAsset: receivedAsset,
        outgoingAmount: currentAmount,
      },
      "Live trade leg settled",
    );

    // ── Slippage guard ───────────────────────────────────────────────────────
    // Market orders can fill worse than the top-of-book price the opportunity
    // was quoted at. If a non-final leg slipped past the limit, bail out early
    // and unwind the asset we now hold rather than committing the rest of the
    // triangle to a trade that is no longer profitable.
    if (maxSlippage > 0 && i < 2) {
      const slip = adverseSlippage(buy, expectedPrices[i] ?? 0, fillPrice);
      if (slip > maxSlippage) {
        logger.warn(
          { leg: i + 1, symbol, expected: expectedPrices[i], actual: fillPrice, slip, maxSlippage },
          "Leg exceeded slippage limit — aborting triangle and unwinding",
        );
        const { order: unwindOrder, error } = await attemptUnwind(
          client,
          receivedAsset,
          currentAmount,
          pathLabel,
          i + 1,
          deps.getFilters,
        );
        throw new LiveTradeError(
          `Leg ${i + 1} (${symbol} ${side}) slippage ${(slip * 100).toFixed(2)}% exceeded limit ${(maxSlippage * 100).toFixed(2)}%`,
          i + 1,
          liveOrders,
          unwindOrder,
          error,
        );
      }
    }
  }

  const netProfitUsd = currentAmount - notionalSize;
  const netProfitPct = netProfitUsd / notionalSize;

  logger.info(
    { path: pathLabel, netProfitUsd, netProfitPct, orderIds },
    "Live triangle trade complete",
  );

  return {
    orderIds,
    fillPrices,
    finalAmount: currentAmount,
    netProfitUsd,
    netProfitPct,
    liveOrders,
  };
}
