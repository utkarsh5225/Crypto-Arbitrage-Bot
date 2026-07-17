import { Router, type IRouter } from "express";
import { sseManager } from "../lib/sse-manager";
import { store } from "../lib/store";

const router: IRouter = Router();

router.get("/stream", (req, res) => {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send a keepalive comment
  res.write(":ok\n\n");

  // Push current state immediately so the client renders before the 2s stats interval
  const stats = store.getStats();
  res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
  res.write(
    `event: scanner_status\ndata: ${JSON.stringify({ connected: store.scannerConnected })}\n\n`,
  );

  // Register with SSE manager for future broadcasts
  sseManager.addClient(res);

  // Clean up on disconnect
  req.on("close", () => sseManager.removeClient(res));
  req.on("error", () => sseManager.removeClient(res));
});

export default router;
