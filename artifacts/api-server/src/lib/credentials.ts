/**
 * Binance API credential storage.
 *
 * Priority order:
 *   1. BINANCE_API_KEY / BINANCE_API_SECRET environment variables (set by user as Replit secrets)
 *   2. .binance-credentials.json file written by the /api/config/credentials POST endpoint
 *
 * The persisted file is encrypted at rest with AES-256-GCM. The key comes from
 * the CREDENTIALS_ENCRYPTION_KEY env var when set; otherwise a random key is
 * generated once and stored in `.credentials-key` (mode 0600) beside it. Legacy
 * plaintext credential files are transparently read and re-saved encrypted.
 *
 * Credentials are never logged or included in API responses — only a masked key is returned.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { logger } from "./logger";

const CREDS_FILE = path.join(process.cwd(), ".binance-credentials.json");
const KEY_FILE = path.join(process.cwd(), ".credentials-key");

interface Credentials {
  apiKey: string;
  apiSecret: string;
}

/** Encrypted-file envelope (v1 = AES-256-GCM). */
interface EncryptedEnvelope {
  v: 1;
  iv: string; // base64
  tag: string; // base64
  data: string; // base64
}

// Runtime cache — cleared only by setCredentials
let cached: Credentials | null = null;
let loaded = false;

/**
 * Resolve the 32-byte encryption key. Prefers CREDENTIALS_ENCRYPTION_KEY
 * (hashed to 32 bytes); otherwise reads/creates a persisted random key file.
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env["CREDENTIALS_ENCRYPTION_KEY"];
  if (envKey && envKey.length > 0) {
    return crypto.createHash("sha256").update(envKey).digest();
  }
  try {
    const existing = fs.readFileSync(KEY_FILE);
    if (existing.length >= 32) return existing.subarray(0, 32);
  } catch {
    // Key file missing — generate a new one below.
  }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  } catch (err) {
    logger.warn({ err }, "Could not persist credential encryption key — using ephemeral key");
  }
  return key;
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(envelope);
}

function decrypt(envelope: EncryptedEnvelope): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]).toString("utf-8");
}

function loadFromFile(): Credentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(CREDS_FILE, "utf-8");
  } catch {
    return null; // File doesn't exist — not an error
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Credentials> & Partial<EncryptedEnvelope>;

    // Encrypted envelope
    if (parsed.v === 1 && parsed.iv && parsed.tag && parsed.data) {
      const creds = JSON.parse(decrypt(parsed as EncryptedEnvelope)) as Partial<Credentials>;
      if (creds.apiKey && creds.apiSecret) {
        return { apiKey: creds.apiKey, apiSecret: creds.apiSecret };
      }
      return null;
    }

    // Legacy plaintext — migrate to encrypted on next save
    if (parsed.apiKey && parsed.apiSecret) {
      const creds = { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret };
      try {
        fs.writeFileSync(CREDS_FILE, encrypt(JSON.stringify(creds)), "utf-8");
        logger.info("Migrated plaintext credentials file to encrypted format");
      } catch (err) {
        logger.warn({ err }, "Could not migrate credentials file to encrypted format");
      }
      return creds;
    }
  } catch (err) {
    logger.warn({ err }, "Could not read persisted credentials — ignoring file");
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

  // Persist to file for restart-survival — encrypted at rest.
  try {
    fs.writeFileSync(CREDS_FILE, encrypt(JSON.stringify({ apiKey, apiSecret })), "utf-8");
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
