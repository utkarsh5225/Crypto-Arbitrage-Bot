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

  // Broadcast updated stats so dashboard reflects mode change immediately
  sseManager.broadcast("stats", store.getStats());

  res.json({
    tradingMode: store.config.tradingMode,
    message: waslive
      ? "Kill switch activated. Bot reverted to paper mode."
      : "Bot was already in paper mode.",
  });
});

export default router;
