import { Router, type IRouter } from "express";
import { store } from "../lib/store";

const router: IRouter = Router();

router.get("/config", (_req, res) => {
  res.json(store.config);
});

router.put("/config", (req, res) => {
  const body = req.body as {
    feeRate?: unknown;
    minProfitThreshold?: unknown;
    notionalSize?: unknown;
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

  res.json(store.config);
});

export default router;
