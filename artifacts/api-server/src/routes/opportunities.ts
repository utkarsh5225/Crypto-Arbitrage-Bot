import { Router, type IRouter } from "express";
import { store } from "../lib/store";

const router: IRouter = Router();

router.get("/opportunities", (req, res) => {
  const limit = Math.min(
    parseInt(String(req.query["limit"] ?? "50"), 10) || 50,
    200,
  );
  const offset = Math.max(
    parseInt(String(req.query["offset"] ?? "0"), 10) || 0,
    0,
  );

  const slice = store.opportunities.slice(offset, offset + limit).map((opp) => ({
    ...opp,
    timestamp: opp.timestamp.toISOString(),
  }));

  res.json({ data: slice, total: store.opportunities.length });
});

export default router;
