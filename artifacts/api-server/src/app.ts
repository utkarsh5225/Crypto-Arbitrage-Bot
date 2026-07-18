import fs from "fs";
import path from "path";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ---------------------------------------------------------------------------
// Static dashboard (single-process deploy)
//
// When the built dashboard is present, serve it from the same origin as the
// API so the SPA's relative `/api` calls and SSE stream work without CORS or a
// reverse proxy. Set PUBLIC_DIR to override the location; by default we look
// for the dashboard build relative to the server's working directory.
// If the build is absent (e.g. API-only dev), this block is skipped.
// ---------------------------------------------------------------------------

const publicDir =
  process.env["PUBLIC_DIR"] ??
  path.resolve(process.cwd(), "..", "arb-dashboard", "dist", "public");

if (fs.existsSync(path.join(publicDir, "index.html"))) {
  app.use(express.static(publicDir));

  // SPA fallback — serve index.html for any non-API GET so client-side routing
  // works on deep links / refreshes. The negative lookahead keeps /api/* (incl.
  // the SSE stream) flowing to the router above.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  logger.info({ publicDir }, "Serving dashboard from static build");
} else {
  logger.warn(
    { publicDir },
    "Dashboard build not found — running API-only. Build the dashboard or set PUBLIC_DIR.",
  );
}

export default app;
