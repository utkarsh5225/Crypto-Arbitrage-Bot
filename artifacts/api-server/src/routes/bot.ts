import { Router, type IRouter } from "express";
import { store } from "../lib/store";
import { sseManager } from "../lib/sse-manager";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** POST /api/bot/kill — emergency kill switch: revert to paper mode immediately */
router.post("/bot/kill", (_req, res) => {
  const waslive = store.config.tradingMode === "live";
  store.config.tradingMode = "paper";

  logger.warn("Kill switch triggered — reverted to paper mode");

  // Persist immediately — a kill switch that a restart could undo is not a
  // kill switch.
  store.persistConfig();

  // Broadcast updated stats so dashboard reflects mode change immediately
  sseManager.broadcast("stats", store.getStats());

  res.json({
    tradingMode: store.config.tradingMode,
    message: waslive
      ? "Kill switch activated. Bot reverted to paper mode."
      : "Bot was already in paper mode.",
  });
});

/**
 * POST /api/bot/reset-daily-loss — zero the accumulated daily-loss counter.
 * Lets the operator clear a stale loss that is holding the daily-loss guard
 * down (and instantly reverting Live to Paper). Does not change the limit.
 */
router.post("/bot/reset-daily-loss", (_req, res) => {
  const previous = store.resetDailyLoss();

  logger.info({ previousDailyLossUsd: previous }, "Daily-loss counter reset to zero");

  // Broadcast updated stats so the dashboard reflects the reset immediately.
  sseManager.broadcast("stats", store.getStats());

  res.json({
    dailyLossUsd: store.config.dailyLossUsd,
    previousDailyLossUsd: previous,
    message: `Daily-loss counter reset (was ${previous.toFixed(2)} USD).`,
  });
});

export default router;
