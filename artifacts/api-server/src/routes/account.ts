import { Router, type IRouter } from "express";
import { getCredentials, hasCredentials } from "../lib/credentials";
import { createClient } from "../lib/binance-client";
import { store } from "../lib/store";
/**
 * Asset -> USDT price, fetched directly from the public ticker endpoint.
 *
 * This previously came from the arbitrage scanner's in-memory price map. With
 * the scanner removed there is no live feed to read from, so we pull prices on
 * demand. Cached briefly because the balances view is polled.
 */
let priceCache: { at: number; map: Map<string, number> } = { at: 0, map: new Map() };

async function getUsdtPrices(): Promise<Map<string, number>> {
  if (Date.now() - priceCache.at < 15_000 && priceCache.map.size > 0) {
    return priceCache.map;
  }
  const map = new Map<string, number>();
  map.set("USDT", 1);
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price", {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const rows = (await res.json()) as { symbol: string; price: string }[];
      for (const r of rows) {
        if (r.symbol.endsWith("USDT") && !r.symbol.startsWith("USDT")) {
          const p = parseFloat(r.price);
          if (p > 0) map.set(r.symbol.slice(0, -4), p);
        }
      }
      priceCache = { at: Date.now(), map };
    }
  } catch {
    // Best effort: balances still render, just without USD valuation.
  }
  return map;
}
import { logger } from "../lib/logger";

const router: IRouter = Router();

function requireLiveMode(res: any): boolean {
  if (!hasCredentials()) {
    res.status(403).json({ error: "Binance credentials not configured" });
    return false;
  }
  if (store.config.tradingMode !== "live") {
    res.status(403).json({ error: "Account data is only available in Live mode" });
    return false;
  }
  return true;
}

/** GET /api/account/balances — non-zero asset balances + estimated USDT value */
router.get("/account/balances", async (_req, res) => {
  if (!requireLiveMode(res)) return;

  const creds = getCredentials()!;
  const client = createClient(creds.apiKey, creds.apiSecret, store.config.useTestnet);

  try {
    const account = await client.getAccount();
    const usdtPrices = await getUsdtPrices();

    const balances = account.balances
      .map((b) => {
        const free = parseFloat(b.free);
        const locked = parseFloat(b.locked);
        const total = free + locked;
        if (total === 0) return null;

        let usdtValue: number | undefined;
        if (b.asset === "USDT") {
          usdtValue = total;
        } else {
          const price = usdtPrices.get(b.asset);
          if (price !== undefined) usdtValue = total * price;
        }

        return { asset: b.asset, free, locked, usdtValue };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .sort((a, b) => (b.usdtValue ?? 0) - (a.usdtValue ?? 0));

    const totalUsdtValue = balances.reduce(
      (sum, b) => sum + (b.usdtValue ?? 0),
      0,
    );

    res.json({ balances, totalUsdtValue, updatedAt: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, "Failed to fetch account balances");
    res.status(502).json({ error: "Failed to fetch account balances from Binance" });
  }
});

/** GET /api/account/orders — last 20 bot-placed orders from store */
router.get("/account/orders", (_req, res) => {
  if (!requireLiveMode(res)) return;
  res.json({ orders: store.getLiveOrders(20) });
});

export default router;
