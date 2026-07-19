import { Router, type IRouter } from "express";
import { store } from "../lib/store";
import {
  hasCredentials,
  getMaskedKey,
  setCredentials,
} from "../lib/credentials";
import { createClient } from "../lib/binance-client";
import {
  hasLlmCredentials,
  getMaskedLlmKey,
  setLlmCredentials,
  clearLlmCredentials,
  testLlmCredentials,
  DEFAULT_MODEL,
} from "../lib/llm-credentials";
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
    useTestnet?: unknown;
    maxSlippagePct?: unknown;
    slippageBudgetPct?: unknown;
    maxQuoteAgeMs?: unknown;
  };

  if (typeof body.feeRate === "number" && body.feeRate > 0 && body.feeRate < 1) {
    // Guard against an unrealistically low fee that would make the profitability
    // math (and the depth-aware entry gate) optimistic and trade at a real loss.
    // 0.075% is the Binance spot taker floor WITH the BNB discount; anything
    // below that is not achievable, so clamp up rather than silently accept it.
    const MIN_REALISTIC_FEE_RATE = 0.00075;
    if (body.feeRate < MIN_REALISTIC_FEE_RATE) {
      logger.warn(
        { requested: body.feeRate, clampedTo: MIN_REALISTIC_FEE_RATE },
        "feeRate below realistic Binance taker floor — clamping up for safety",
      );
      store.config.feeRate = MIN_REALISTIC_FEE_RATE;
    } else {
      store.config.feeRate = body.feeRate;
    }
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
  if (typeof body.maxSlippagePct === "number" && body.maxSlippagePct >= 0 && body.maxSlippagePct < 1) {
    store.config.maxSlippagePct = body.maxSlippagePct;
  }
  if (
    typeof body.slippageBudgetPct === "number" &&
    body.slippageBudgetPct >= 0 &&
    body.slippageBudgetPct < 1
  ) {
    store.config.slippageBudgetPct = body.slippageBudgetPct;
  }
  // Max age of the stalest leg's quote before a triangle is rejected (0 = off).
  if (typeof body.maxQuoteAgeMs === "number" && body.maxQuoteAgeMs >= 0) {
    store.config.maxQuoteAgeMs = body.maxQuoteAgeMs;
  }

  // Testnet toggle — only allowed while paper trading, since production and
  // testnet use different API keys and different funds. Flipping networks
  // mid-live-trading would silently invalidate the active credentials.
  if (typeof body.useTestnet === "boolean") {
    if (body.useTestnet !== store.config.useTestnet && store.config.tradingMode === "live") {
      res.status(400).json({
        error: "Cannot switch Testnet on/off while Live mode is active — switch to Paper mode first",
      });
      return;
    }
    store.config.useTestnet = body.useTestnet;
    logger.info({ useTestnet: body.useTestnet }, "Testnet mode changed");
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

  // Durably save sizing/safety limits — otherwise a restart silently reverts
  // them to code defaults (e.g. notional back to 1000) while staying live.
  store.persistConfig();

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

  // Validate credentials by calling GET /api/v3/account on the active network
  // (testnet keys only authenticate against testnet, and vice-versa).
  const client = createClient(apiKey, apiSecret, store.config.useTestnet);
  let result: { valid: boolean; canTrade: boolean };
  try {
    result = await client.testCredentials();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Could not reach Binance to validate credentials: ${msg}` });
    return;
  }

  if (!result.valid) {
    res.status(401).json({ error: "Binance rejected the credentials — check your API key and secret" });
    return;
  }

  setCredentials(apiKey, apiSecret);
  logger.info({ canTrade: result.canTrade }, "Binance credentials saved and validated");

  res.json({
    configured: true,
    canTrade: result.canTrade,
    maskedKey: getMaskedKey(),
    warning: result.canTrade ? undefined : "Credentials saved, but Spot Trading is not enabled on this API key. Enable it in Binance → API Management to place live orders.",
  });
});

// ---------------------------------------------------------------------------
// DeepSeek (LLM) API key — same handling rules as the Binance keys: encrypted
// at rest, never logged, never returned in full.
// ---------------------------------------------------------------------------

/** GET /api/config/llm — status only, never the key itself */
router.get("/config/llm", (_req, res) => {
  res.json({
    configured: hasLlmCredentials(),
    maskedKey: getMaskedLlmKey(),
    model: DEFAULT_MODEL,
  });
});

/** POST /api/config/llm — validate against DeepSeek, then store encrypted */
router.post("/config/llm", async (req, res) => {
  const body = req.body as { apiKey?: unknown };
  if (typeof body.apiKey !== "string" || body.apiKey.trim().length === 0) {
    res.status(400).json({ error: "apiKey is required" });
    return;
  }
  const apiKey = body.apiKey.trim();

  const result = await testLlmCredentials(apiKey);
  if (!result.valid) {
    // result.error never contains the key.
    res.status(401).json({ error: `DeepSeek rejected the key: ${result.error}` });
    return;
  }

  setLlmCredentials(apiKey);
  // Log the outcome only — never the key or any part of it.
  logger.info({ models: result.models }, "DeepSeek API key saved and validated");

  res.json({
    configured: true,
    maskedKey: getMaskedLlmKey(),
    model: DEFAULT_MODEL,
    models: result.models,
  });
});

/** DELETE /api/config/llm — remove the stored key */
router.delete("/config/llm", (_req, res) => {
  clearLlmCredentials();
  logger.info("DeepSeek API key cleared");
  res.json({ configured: false });
});

export default router;
