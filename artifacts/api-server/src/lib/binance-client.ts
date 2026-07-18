/**
 * Minimal signed Binance REST API client.
 *
 * Signing contract (Binance docs §Authentication):
 *   signature = HMAC-SHA256(secret, totalParams)
 *   totalParams = all query-string parameters concatenated in the order they
 *                 appear, INCLUDING timestamp and recvWindow.
 *
 * For POST endpoints (e.g. POST /api/v3/order) Binance accepts all parameters
 * as query-string fields — no request body required. We send everything in the
 * query string so the signed canonical string is unambiguous and matches what
 * the server receives byte-for-byte.
 */

import crypto from "crypto";
import { logger } from "./logger";

/** Production Spot REST endpoint (real funds). */
const MAINNET_BASE_URL = "https://api.binance.com";
/** Spot Testnet REST endpoint (fake funds) — same /api/v3 paths as production. */
const TESTNET_BASE_URL = "https://testnet.binance.vision";
const RECV_WINDOW = 5000;

// ---------------------------------------------------------------------------
// Server-time synchronisation
//
// Signed requests carry a `timestamp` that Binance rejects with error -1021 if
// it drifts outside recvWindow of the exchange clock. Container clocks can
// wander, so we sync once per endpoint against GET /api/v3/time (public) and
// apply the offset to every timestamp, refreshing periodically.
// ---------------------------------------------------------------------------

const TIME_SYNC_TTL_MS = 5 * 60 * 1000;

/** baseUrl → (serverTime - localTime) in ms. */
const timeOffsets = new Map<string, number>();
/** baseUrl → last successful sync timestamp (local ms). */
const timeSyncedAt = new Map<string, number>();
/** baseUrl → in-flight sync promise, so concurrent callers share one fetch. */
const timeSyncInFlight = new Map<string, Promise<void>>();

async function syncServerTime(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v3/time`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`time sync HTTP ${res.status}`);
  const { serverTime } = (await res.json()) as { serverTime: number };
  timeOffsets.set(baseUrl, serverTime - Date.now());
  timeSyncedAt.set(baseUrl, Date.now());
  logger.debug({ baseUrl, offsetMs: timeOffsets.get(baseUrl) }, "Binance server time synced");
}

/**
 * Ensure a fresh-enough clock offset for `baseUrl`. Best-effort: if the sync
 * fetch fails we log and fall back to the last known (or zero) offset rather
 * than blocking trading.
 */
async function ensureTimeSync(baseUrl: string): Promise<void> {
  const last = timeSyncedAt.get(baseUrl) ?? 0;
  if (Date.now() - last < TIME_SYNC_TTL_MS) return;

  let inflight = timeSyncInFlight.get(baseUrl);
  if (!inflight) {
    inflight = syncServerTime(baseUrl)
      .catch((err) => {
        logger.warn({ err, baseUrl }, "Binance time sync failed — using last known offset");
      })
      .finally(() => {
        timeSyncInFlight.delete(baseUrl);
      });
    timeSyncInFlight.set(baseUrl, inflight);
  }
  await inflight;
}

export interface BinanceFill {
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
}

export interface BinanceOrderResult {
  orderId: number;
  symbol: string;
  side: "BUY" | "SELL";
  status: string;
  executedQty: string;
  cummulativeQuoteQty: string; // note: Binance typo is intentional
  fills: BinanceFill[];
  transactTime: number;
}

export interface BinanceBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface BinanceAccount {
  balances: BinanceBalance[];
  canTrade: boolean;
}

export class BinanceClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    useTestnet = false,
  ) {
    this.baseUrl = useTestnet ? TESTNET_BASE_URL : MAINNET_BASE_URL;
  }

  /** HMAC-SHA256 of the canonical query string. */
  private sign(canonicalString: string): string {
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(canonicalString)
      .digest("hex");
  }

  /**
   * Issue a signed request.
   *
   * ALL parameters (including those that would logically be a POST body) are
   * placed in the query string so the canonical string sent to HMAC exactly
   * matches the parameters Binance sees.  The request body is always empty.
   */
  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<T> {
    // Align our timestamp with the exchange clock to avoid -1021 rejections.
    await ensureTimeSync(this.baseUrl);
    const offset = timeOffsets.get(this.baseUrl) ?? 0;

    const allParams: Record<string, string | number> = {
      ...params,
      timestamp: Date.now() + offset,
      recvWindow: RECV_WINDOW,
    };

    // Build canonical query string — preserve insertion order so the signature
    // covers the string in exactly the order we'll append it to the URL.
    const canonicalQS = Object.entries(allParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const signature = this.sign(canonicalQS);
    const url = `${this.baseUrl}${path}?${canonicalQS}&signature=${signature}`;

    logger.debug({ method, path, params: Object.keys(allParams) }, "Binance API request");

    const res = await fetch(url, {
      method,
      headers: {
        "X-MBX-APIKEY": this.apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    const text = await res.text();

    if (!res.ok) {
      logger.error({ status: res.status, body: text, path }, "Binance API error");
      throw new Error(`Binance ${res.status}: ${text}`);
    }

    return JSON.parse(text) as T;
  }

  /**
   * Place a MARKET order.
   *
   * For BUY legs:  pass { quoteOrderQty }  — spend this many quote units (e.g. USDT)
   * For SELL legs: pass { quantity }       — sell this many base units (e.g. BTC)
   *
   * Binance returns executedQty (base received/sold) and cummulativeQuoteQty
   * (quote spent/received).  live-execution.ts uses these to thread the
   * running balance through the 3 legs.
   */
  async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    qty: { quoteOrderQty: number } | { quantity: number },
  ): Promise<BinanceOrderResult> {
    const params: Record<string, string | number> = {
      symbol,
      side,
      type: "MARKET",
    };

    if ("quoteOrderQty" in qty) {
      // Precision is already applied by the caller (live-execution.ts roundQuote).
      // Pass the value as-is; additional rounding here would override symbol-specific
      // quotePrecision and corrupt non-USDT quote amounts.
      params["quoteOrderQty"] = qty.quoteOrderQty;
    } else {
      // Precision is already applied by the caller (live-execution.ts roundToStep).
      params["quantity"] = qty.quantity;
    }

    return this.request<BinanceOrderResult>("POST", "/api/v3/order", params);
  }

  /**
   * Fetch account information including non-zero balances.
   * Also used by testCredentials() to validate the key/secret pair.
   */
  async getAccount(): Promise<BinanceAccount> {
    return this.request<BinanceAccount>("GET", "/api/v3/account");
  }

  /**
   * Returns true when the key/secret can successfully authenticate.
   * A rejected 401/403 response returns false; network errors propagate.
   */
  /**
   * Returns { valid: true } if the key/secret authenticate successfully.
   * `canTrade` reflects whether Spot Trading is enabled on the key —
   * valid credentials with canTrade=false can still be saved so the user
   * can verify balances; live order placement will warn at trade time.
   */
  async testCredentials(): Promise<{ valid: boolean; canTrade: boolean }> {
    try {
      const account = await this.getAccount();
      return { valid: true, canTrade: account.canTrade };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.includes("403") || msg.includes("-2014") || msg.includes("-2015")) {
        return { valid: false, canTrade: false };
      }
      throw err;
    }
  }
}

/**
 * Factory: builds a BinanceClient from the provided credentials.
 * Pass `useTestnet = true` to route requests to the Spot Testnet endpoint.
 * Note: testnet issues its OWN API key/secret (from testnet.binance.vision) —
 * production keys will be rejected there and vice-versa.
 */
export function createClient(
  apiKey: string,
  apiSecret: string,
  useTestnet = false,
): BinanceClient {
  return new BinanceClient(apiKey, apiSecret, useTestnet);
}
