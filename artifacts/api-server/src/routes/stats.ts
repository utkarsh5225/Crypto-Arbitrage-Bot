import { Router, type IRouter } from "express";
import { store } from "../lib/store";

const router: IRouter = Router();

router.get("/stats", (_req, res) => {
  res.json(store.getStats());
});

export default router;
