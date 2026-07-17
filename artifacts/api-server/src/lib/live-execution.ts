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
 *  - Any single-leg failure aborts the remaining legs (no auto-unwind)
 *  - Daily loss limit is checked before execution; see scanner.ts
 */

import { createClient, type BinanceOrderResult } from "./binance-client";
import { getSymbolFilters } from "./scanner";
import { type LiveOrder } from "./store";
import { logger } from "./logger";

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
// Precision helpers
// ---------------------------------------------------------------------------

/**
 * Round DOWN a base-asset quantity to the nearest valid lot-size step.
 * If stepSize is 0 (no filter), fall back to `basePrecision` decimal places.
 *
 * Examples:
 *   roundToStep(0.123456789, 0.001, 8) → 0.123   (step = 0.001)
 *   roundToStep(0.123456789, 0,    8) → 0.12345678  (no step, use precision)
 */
function roundToStep(value: number, stepSize: number, basePrecision: number): number {
  if (stepSize > 0) {
    // Count decimal places in stepSize to avoid floating-point drift
    const stepDecimals = Math.max(0, Math.round(-Math.log10(stepSize)));
    const factor = Math.pow(10, stepDecimals);
    return Math.floor(value * factor) / factor;
  }
  // No step constraint — use base precision
  const factor = Math.pow(10, basePrecision);
  return Math.floor(value * factor) / factor;
}

/**
 * Round DOWN a quote-asset amount to the number of decimal places
 * specified by the symbol's quotePrecision.
 *
 * Always floor (never round up) to avoid spending more than intended.
 *
 * Examples (BTCUSDT quotePrecision = 8, ETHBTC quotePrecision = 8):
 *   roundQuote(123.4567891, 8) → 123.45678910  (no change needed)
 *   roundQuote(123.4567891, 2) → 123.45         (USDT pairs: 2 decimal places)
 */
function roundQuote(value: number, quotePrecision: number): number {
  const factor = Math.pow(10, quotePrecision);
  return Math.floor(value * factor) / factor;
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
export async function executeLiveTrade(
  tri: TriangleForExecution,
  opportunityId: string,
  notionalSize: number,
  apiKey: string,
  apiSecret: string,
): Promise<LiveTradeResult> {
  if (tri.path[0] !== "USDT") {
    throw new Error(
      `Live trading only supports USDT-starting triangles (got ${tri.path[0]})`,
    );
  }

  const client = createClient(apiKey, apiSecret);
  const orderIds: number[] = [];
  const fillPrices: number[] = [];
  const liveOrders: LiveOrder[] = [];

  let currentAmount = notionalSize; // starts as USDT
  const pathLabel = tri.path.join("→");

  for (let i = 0; i < 3; i++) {
    const symbol = tri.symbols[i];
    const buy = tri.buys[i];
    const side = buy ? "BUY" : "SELL";
    const filters = getSymbolFilters(symbol);

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
      throw new Error(
        `Leg ${i + 1} (${symbol} ${side}): rounded amount is zero after precision adjustment ` +
        `(raw=${currentAmount}, stepSize=${filters.lotStepSize}, quotePrecision=${filters.quotePrecision})`,
      );
    }

    let order: BinanceOrderResult;
    try {
      order = await client.placeMarketOrder(symbol, side, orderQty);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Leg ${i + 1} (${symbol} ${side}) failed: ${msg}`);
    }

    const fillPrice = avgFillPrice(order);
    orderIds.push(order.orderId);
    fillPrices.push(fillPrice);

    liveOrders.push({
      orderId: order.orderId,
      symbol,
      side,
      executedQty: parseFloat(order.executedQty),
      avgPrice: fillPrice,
      status: order.status,
      timestamp: new Date(order.transactTime).toISOString(),
      leg: i + 1,
      trianglePath: pathLabel,
    });

    // Thread the running amount to the next leg
    if (buy) {
      // Received base asset from the BUY
      currentAmount = parseFloat(order.executedQty);
    } else {
      // Received quote asset from the SELL
      currentAmount = parseFloat(order.cummulativeQuoteQty);
    }

    logger.info(
      { leg: i + 1, symbol, orderId: order.orderId, outgoingAmount: currentAmount },
      "Live trade leg settled",
    );
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
