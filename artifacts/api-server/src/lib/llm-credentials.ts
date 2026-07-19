/**
 * DeepSeek (LLM) API key storage.
 *
 * Deliberately mirrors the Binance credential module: same AES-256-GCM
 * envelope, same encryption key (CREDENTIALS_ENCRYPTION_KEY, else the shared
 * `.credentials-key` file), same rule that the secret is NEVER logged and NEVER
 * returned by an API route — only a masked form.
 *
 * Priority order:
 *   1. DEEPSEEK_API_KEY environment variable
 *   2. .llm-credentials.json written by POST /api/config/llm
 *
 * The crypto helpers are intentionally duplicated from credentials.ts rather
 * than refactored into a shared module: credentials.ts guards live trading keys
 * and has no test coverage, so an untested refactor of it is not worth the risk
 * for this feature.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { logger } from "./logger";

const LLM_CREDS_FILE = path.join(process.cwd(), ".llm-credentials.json");
const KEY_FILE = path.join(process.cwd(), ".credentials-key");

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-chat";

interface LlmCredentials {
  apiKey: string;
  model: string;
}

interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

let cached: LlmCredentials | null = null;
let loaded = false;

function getEncryptionKey(): Buffer {
  const envKey = process.env["CREDENTIALS_ENCRYPTION_KEY"];
  if (envKey && envKey.length > 0) {
    return crypto.createHash("sha256").update(envKey).digest();
  }
  try {
    const existing = fs.readFileSync(KEY_FILE);
    if (existing.length >= 32) return existing.subarray(0, 32);
  } catch {
    // fall through and create one
  }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  } catch (err) {
    logger.warn({ err }, "Could not persist encryption key — using ephemeral key");
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

function loadFromFile(): LlmCredentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(LLM_CREDS_FILE, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EncryptedEnvelope>;
    if (parsed.v === 1 && parsed.iv && parsed.tag && parsed.data) {
      const c = JSON.parse(decrypt(parsed as EncryptedEnvelope)) as Partial<LlmCredentials>;
      if (c.apiKey) return { apiKey: c.apiKey, model: c.model || DEFAULT_MODEL };
    }
  } catch (err) {
    logger.warn({ err }, "Could not read persisted LLM credentials — ignoring file");
  }
  return null;
}

export function getLlmCredentials(): LlmCredentials | null {
  if (cached) return cached;
  if (loaded) return null;

  const envKey = process.env["DEEPSEEK_API_KEY"];
  if (envKey) {
    cached = { apiKey: envKey, model: process.env["DEEPSEEK_MODEL"] || DEFAULT_MODEL };
    loaded = true;
    return cached;
  }
  cached = loadFromFile();
  loaded = true;
  return cached;
}

export function setLlmCredentials(apiKey: string, model = DEFAULT_MODEL): void {
  cached = { apiKey, model };
  loaded = true;
  try {
    // 0600: the file holds a live API secret.
    fs.writeFileSync(LLM_CREDS_FILE, encrypt(JSON.stringify({ apiKey, model })), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (err) {
    logger.warn({ err }, "Could not persist LLM credentials — stored in memory only");
  }
}

export function clearLlmCredentials(): void {
  cached = null;
  loaded = true;
  delete process.env["DEEPSEEK_API_KEY"];
  try {
    fs.unlinkSync(LLM_CREDS_FILE);
  } catch {
    // may not exist
  }
}

export function hasLlmCredentials(): boolean {
  return getLlmCredentials() !== null;
}

export function getMaskedLlmKey(): string | undefined {
  const c = getLlmCredentials();
  if (!c) return undefined;
  const k = c.apiKey;
  if (k.length <= 8) return "***";
  return `${k.slice(0, 4)}***${k.slice(-4)}`;
}

/**
 * Verify a key by listing models (cheap, no tokens billed). Returns validity
 * plus the model list size so the UI can show something concrete.
 * The key is sent only to DeepSeek and never logged.
 */
export async function testLlmCredentials(
  apiKey: string,
): Promise<{ valid: boolean; models?: number; error?: string }> {
  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: "Key rejected by DeepSeek (401/403)" };
    }
    if (!res.ok) {
      return { valid: false, error: `DeepSeek returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as { data?: unknown[] };
    return { valid: true, models: Array.isArray(body.data) ? body.data.length : undefined };
  } catch (err) {
    // Never include the key in the error path.
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
