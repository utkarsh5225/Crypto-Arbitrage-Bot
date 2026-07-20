import type { Server } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { startLlmTrader, stopLlmTrader } from "./lib/llm-trader";
import { store } from "./lib/store";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Bind address. Defaults to loopback so the dashboard (which has no auth and
// can place real orders) is never exposed on a public interface — reach it via
// an SSH tunnel. Set HOST=0.0.0.0 only behind an authenticating reverse proxy.
const host = process.env["HOST"] ?? "127.0.0.1";

const server: Server = app.listen(port, host, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ host, port }, "Server listening");

  // Start the DeepSeek decision loop. It is a no-op until llmEnabled is set and
  // a key is configured, and it only ever paper-trades.
  startLlmTrader();
});

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// On SIGTERM/SIGINT (e.g. `systemctl restart`): stop the decision loop, flush
// state to disk, close the server, and exit. A hard timeout guarantees we still
// exit. (The arbitrage scanner and its in-flight-trade drain were removed with
// the arb engine — the LLM loop only paper-trades, so there is nothing to
// settle on the exchange.)
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutdown signal received — draining");

  stopLlmTrader();

  store.flush();
  logger.info("Store flushed to disk");

  server.close(() => {
    logger.info("HTTP server closed — exiting");
    process.exit(0);
  });

  // Hard cap so a hung connection can't block the exit.
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
