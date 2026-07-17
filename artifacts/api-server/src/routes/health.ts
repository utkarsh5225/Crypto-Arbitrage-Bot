import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/** Returns this server's own outgoing IP — the address Binance sees. */
router.get("/my-ip", async (_req, res) => {
  try {
    const r = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(5_000),
    });
    const { ip } = (await r.json()) as { ip: string };
    res.json({ ip });
  } catch {
    res.status(502).json({ error: "Could not determine outgoing IP" });
  }
});

export default router;
