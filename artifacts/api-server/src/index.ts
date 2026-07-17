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

app.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start the triangular arbitrage scanner
  startScanner().catch((scannerErr) => {
    logger.error({ err: scannerErr }, "Scanner failed to start");
  });
});
