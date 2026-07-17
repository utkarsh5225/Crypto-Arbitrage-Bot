import { Router, type IRouter } from "express";
import { store } from "../lib/store";

const router: IRouter = Router();

router.get("/trades", (req, res) => {
  const limit = Math.min(
    parseInt(String(req.query["limit"] ?? "50"), 10) || 50,
    200,
  );
  const offset = Math.max(
    parseInt(String(req.query["offset"] ?? "0"), 10) || 0,
    0,
  );

  const slice = store.trades.slice(offset, offset + limit).map((trade) => ({
    ...trade,
    timestamp: trade.timestamp.toISOString(),
  }));

  res.json({ data: slice, total: store.trades.length });
});

export default router;
