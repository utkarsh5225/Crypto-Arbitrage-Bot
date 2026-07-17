/**
 * Binance API credential storage.
 *
 * Priority order:
 *   1. BINANCE_API_KEY / BINANCE_API_SECRET environment variables (set by user as Replit secrets)
 *   2. .binance-credentials.json file written by the /api/config/credentials POST endpoint
 *
 * Credentials are never logged or included in API responses — only a masked key is returned.
 */

import fs from "fs";
import path from "path";
import { logger } from "./logger";

const CREDS_FILE = path.join(process.cwd(), ".binance-credentials.json");

interface Credentials {
  apiKey: string;
  apiSecret: string;
}

// Runtime cache — cleared only by setCredentials
let cached: Credentials | null = null;
let loaded = false;

function loadFromFile(): Credentials | null {
  try {
    const raw = fs.readFileSync(CREDS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (parsed.apiKey && parsed.apiSecret) {
      return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret };
    }
  } catch {
    // File doesn't exist or is malformed — not an error
  }
  return null;
}

export function getCredentials(): Credentials | null {
  if (cached) return cached;
  if (loaded) return null; // Already checked, found nothing

  // 1. Try environment variables (Replit secrets)
  const envKey = process.env["BINANCE_API_KEY"];
  const envSecret = process.env["BINANCE_API_SECRET"];
  if (envKey && envSecret) {
    cached = { apiKey: envKey, apiSecret: envSecret };
    loaded = true;
    return cached;
  }

  // 2. Try persisted file
  const fromFile = loadFromFile();
  if (fromFile) {
    cached = fromFile;
    // Mirror into process.env so any code that reads env directly also works
    process.env["BINANCE_API_KEY"] = fromFile.apiKey;
    process.env["BINANCE_API_SECRET"] = fromFile.apiSecret;
  }

  loaded = true;
  return cached;
}

export function setCredentials(apiKey: string, apiSecret: string): void {
  // Update runtime cache
  cached = { apiKey, apiSecret };
  loaded = true;

  // Mirror into process.env
  process.env["BINANCE_API_KEY"] = apiKey;
  process.env["BINANCE_API_SECRET"] = apiSecret;

  // Persist to file for restart-survival
  try {
    fs.writeFileSync(
      CREDS_FILE,
      JSON.stringify({ apiKey, apiSecret }, null, 2),
      "utf-8",
    );
  } catch (err) {
    logger.warn({ err }, "Could not persist credentials to file — stored in memory only");
  }
}

export function clearCredentials(): void {
  cached = null;
  loaded = true;
  delete process.env["BINANCE_API_KEY"];
  delete process.env["BINANCE_API_SECRET"];
  try {
    fs.unlinkSync(CREDS_FILE);
  } catch {
    // File may not exist
  }
}

export function hasCredentials(): boolean {
  return getCredentials() !== null;
}

export function getMaskedKey(): string | undefined {
  const creds = getCredentials();
  if (!creds) return undefined;
  const k = creds.apiKey;
  if (k.length <= 8) return "***";
  return `${k.slice(0, 4)}***${k.slice(-4)}`;
}
