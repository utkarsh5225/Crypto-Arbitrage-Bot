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
  getLlmCredentials,
  getMaskedLlmKey,
  setLlmCredentials,
  clearLlmCredentials,
  testLlmCredentials,
  DEFAULT_MODEL,
} from "../lib/llm-credentials";
import { suggestCoins, discussTrade } from "../lib/llm-advisor";
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
    llmEnabled?: unknown;
    llmSymbol?: unknown;
    llmIntervalSec?: unknown;
    llmMaxTradesPerDay?: unknown;
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
  // ── LLM loop (paper only) ────────────────────────────────────────────────
  if (typeof body.llmEnabled === "boolean") {
    if (body.llmEnabled && !hasLlmCredentials()) {
      res.status(400).json({ error: "Cannot enable the LLM loop: no DeepSeek API key configured" });
      return;
    }
    store.config.llmEnabled = body.llmEnabled;
    logger.info({ llmEnabled: body.llmEnabled }, "LLM loop toggled");
  }
  if (typeof body.llmSymbol === "string" && /^[A-Z0-9]{4,20}$/.test(body.llmSymbol)) {
    store.config.llmSymbol = body.llmSymbol;
  }
  if (typeof body.llmIntervalSec === "number" && body.llmIntervalSec >= 30) {
    store.config.llmIntervalSec = body.llmIntervalSec;
  }
  if (typeof body.llmMaxTradesPerDay === "number" && body.llmMaxTradesPerDay > 0) {
    store.config.llmMaxTradesPerDay = body.llmMaxTradesPerDay;
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

/**
 * POST /api/llm/suggest — ask DeepSeek which 5 coins look best to trade now.
 * Returns picks for the operator to choose from; does NOT start trading.
 */
router.post("/llm/suggest", async (_req, res) => {
  const creds = getLlmCredentials();
  if (!creds) {
    res.status(400).json({ error: "No DeepSeek API key configured" });
    return;
  }
  const { picks, error, ms } = await suggestCoins(creds.apiKey, creds.model);
  if (!picks.length) {
    res.status(502).json({ error: error || "DeepSeek returned no usable picks" });
    return;
  }
  store.llmPicks = picks;
  store.llmPicksAt = Date.now();
  logger.info({ count: picks.length, ms }, "DeepSeek coin picks received");
  res.json({ picks, ms, at: store.llmPicksAt });
});

/** GET /api/llm/picks — last set of picks */
router.get("/llm/picks", (_req, res) => {
  res.json({ picks: store.llmPicks, at: store.llmPicksAt, selected: store.config.llmSymbols });
});

/**
 * POST /api/llm/select — choose which picked symbols to trade, and optionally
 * start the loop in the same call.
 */
router.post("/llm/select", (req, res) => {
  const body = req.body as { symbols?: unknown; start?: unknown };
  if (!Array.isArray(body.symbols) || body.symbols.length === 0) {
    res.status(400).json({ error: "symbols must be a non-empty array" });
    return;
  }
  const valid = body.symbols
    .map((s) => String(s).toUpperCase())
    .filter((s) => /^[A-Z0-9]{4,20}$/.test(s));
  if (!valid.length) {
    res.status(400).json({ error: "no valid symbols supplied" });
    return;
  }
  store.config.llmSymbols = valid;
  if (body.start === true) {
    if (!hasLlmCredentials()) {
      res.status(400).json({ error: "No DeepSeek API key configured" });
      return;
    }
    store.config.llmEnabled = true;
  }
  store.persistConfig();
  logger.info({ symbols: valid, started: body.start === true }, "LLM symbols selected");
  res.json({ symbols: valid, llmEnabled: store.config.llmEnabled });
});

/**
 * POST /api/llm/discuss — talk to DeepSeek about a specific paper trade.
 * Keeps a per-trade thread so the conversation has continuity.
 */
router.post("/llm/discuss", async (req, res) => {
  const body = req.body as { tradeId?: unknown; question?: unknown };
  if (typeof body.tradeId !== "string" || typeof body.question !== "string" || !body.question.trim()) {
    res.status(400).json({ error: "tradeId and question are required" });
    return;
  }
  const creds = getLlmCredentials();
  if (!creds) {
    res.status(400).json({ error: "No DeepSeek API key configured" });
    return;
  }
  const trade = store.llmTrades.find((t) => t.id === body.tradeId);
  if (!trade) {
    res.status(404).json({ error: "trade not found" });
    return;
  }

  const ctx = [
    `Symbol: ${trade.symbol}`,
    `Side: ${trade.side}`,
    `Entry: ${trade.entry}  Exit: ${trade.exit}  (${trade.how})`,
    `Gross: ${trade.grossBps.toFixed(1)} bps | Net after 10 bps cost: ${trade.netBps.toFixed(1)} bps`,
    `A same-instant coin flip with identical stop/target returned: ${trade.ctrlNetBps.toFixed(1)} bps`,
    `Bars held: ${trade.bars}`,
    `Your original reasoning for this trade was: "${trade.reason}"`,
  ].join("\n");

  const thread = store.llmDiscussions[trade.id] ?? [];
  const history = thread.map((m) => ({ role: m.role, content: m.content }));
  const { answer, error, ms } = await discussTrade(
    creds.apiKey, creds.model, ctx, body.question.trim(), history,
  );
  if (answer === null) {
    res.status(502).json({ error: error || "DeepSeek did not respond" });
    return;
  }
  thread.push({ role: "user", content: body.question.trim(), at: Date.now() });
  thread.push({ role: "assistant", content: answer, at: Date.now() });
  store.llmDiscussions[trade.id] = thread.slice(-20);
  logger.info({ tradeId: trade.id, ms }, "LLM trade discussion exchange");
  res.json({ answer, thread: store.llmDiscussions[trade.id] });
});

/** GET /api/llm/discuss/:id — existing thread for a trade */
router.get("/llm/discuss/:id", (req, res) => {
  res.json({ thread: store.llmDiscussions[String(req.params["id"])] ?? [] });
});

/** GET /api/llm/stats — scoring for the DeepSeek paper loop */
router.get("/llm/stats", (_req, res) => {
  res.json(store.getLlmStats());
});

/** GET /api/llm/trades — recent LLM paper trades (newest first) */
router.get("/llm/trades", (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10) || 50));
  res.json({ data: store.llmTrades.slice(0, limit) });
});

/** DELETE /api/config/llm — remove the stored key */
router.delete("/config/llm", (_req, res) => {
  clearLlmCredentials();
  logger.info("DeepSeek API key cleared");
  res.json({ configured: false });
});

export default router;
