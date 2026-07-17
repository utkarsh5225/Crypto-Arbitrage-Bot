import { Router, type IRouter } from "express";
import { store } from "../lib/store";
import {
  hasCredentials,
  getMaskedKey,
  setCredentials,
} from "../lib/credentials";
import { createClient } from "../lib/binance-client";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/config", (_req, res) => {
  res.json(store.config);
});

router.put("/config", (req, res) => {
  const body = req.body as {
    feeRate?: unknown;
    minProfitThreshold?: unknown;
    notionalSize?: unknown;
    tradingMode?: unknown;
    maxNotionalPerTrade?: unknown;
    dailyLossLimitUsd?: unknown;
  };

  if (typeof body.feeRate === "number" && body.feeRate > 0 && body.feeRate < 1) {
    store.config.feeRate = body.feeRate;
  }
  if (
    typeof body.minProfitThreshold === "number" &&
    body.minProfitThreshold > 0 &&
    body.minProfitThreshold < 1
  ) {
    store.config.minProfitThreshold = body.minProfitThreshold;
  }
  if (typeof body.notionalSize === "number" && body.notionalSize > 0) {
    store.config.notionalSize = body.notionalSize;
  }
  if (typeof body.maxNotionalPerTrade === "number" && body.maxNotionalPerTrade > 0) {
    store.config.maxNotionalPerTrade = body.maxNotionalPerTrade;
  }
  if (typeof body.dailyLossLimitUsd === "number" && body.dailyLossLimitUsd >= 0) {
    store.config.dailyLossLimitUsd = body.dailyLossLimitUsd;
  }

  // Trading mode switch — requires credentials to enable live
  if (body.tradingMode === "live" || body.tradingMode === "paper") {
    if (body.tradingMode === "live" && !hasCredentials()) {
      res.status(400).json({
        error: "Cannot enable live mode: Binance credentials are not configured",
      });
      return;
    }
    store.config.tradingMode = body.tradingMode;
    logger.info({ tradingMode: body.tradingMode }, "Trading mode changed");
  }

  res.json(store.config);
});

/** GET /api/config/credentials — returns credential status (never values) */
router.get("/config/credentials", (_req, res) => {
  res.json({
    configured: hasCredentials(),
    maskedKey: getMaskedKey(),
  });
});

/** POST /api/config/credentials — stores credentials and optionally validates them */
router.post("/config/credentials", async (req, res) => {
  const body = req.body as { apiKey?: unknown; apiSecret?: unknown };

  if (
    typeof body.apiKey !== "string" ||
    typeof body.apiSecret !== "string" ||
    body.apiKey.trim().length === 0 ||
    body.apiSecret.trim().length === 0
  ) {
    res.status(400).json({ error: "apiKey and apiSecret are required strings" });
    return;
  }

  const apiKey = body.apiKey.trim();
  const apiSecret = body.apiSecret.trim();

  // Validate credentials by calling GET /api/v3/account
  const client = createClient(apiKey, apiSecret);
  const valid = await client.testCredentials().catch(() => false);
  if (!valid) {
    res.status(401).json({ error: "Binance rejected the credentials — check your API key and secret" });
    return;
  }

  setCredentials(apiKey, apiSecret);
  logger.info("Binance credentials saved and validated");

  res.json({
    configured: true,
    maskedKey: getMaskedKey(),
  });
});

export default router;
