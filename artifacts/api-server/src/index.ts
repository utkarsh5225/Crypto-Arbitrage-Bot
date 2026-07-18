import app from "./app";
import { logger } from "./lib/logger";
import { startScanner } from "./lib/scanner";

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

app.listen(port, host, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ host, port }, "Server listening");

  // Start the triangular arbitrage scanner
  startScanner().catch((scannerErr) => {
    logger.error({ err: scannerErr }, "Scanner failed to start");
  });
});
