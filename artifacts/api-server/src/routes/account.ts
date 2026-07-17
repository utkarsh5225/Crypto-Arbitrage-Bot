import { Router, type IRouter } from "express";
import { getCredentials, hasCredentials } from "../lib/credentials";
import { createClient } from "../lib/binance-client";
import { store } from "../lib/store";
import { getUsdtPrices } from "../lib/scanner";
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
  const client = createClient(creds.apiKey, creds.apiSecret);

  try {
    const account = await client.getAccount();
    const usdtPrices = getUsdtPrices();

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
