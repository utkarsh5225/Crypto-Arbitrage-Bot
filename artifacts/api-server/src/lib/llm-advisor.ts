/**
 * DeepSeek trade-decision advisor.
 *
 * Feeds recent futures market context to the LLM and parses a structured
 * decision back. Deliberately narrow: it returns a decision, it does not place
 * orders. Execution and scoring live in llm-trader.ts.
 *
 * The API key is passed in per call and is never logged.
 */

import { logger } from "./logger";
import { DEEPSEEK_BASE_URL } from "./llm-credentials";

const FUT_KLINES = "https://fapi.binance.com/fapi/v1/klines";

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** taker buy base volume — lets us hand the model real order-flow delta */
  tb: number;
}

export interface LlmDecision {
  action: "long" | "short" | "flat";
  /** stop distance from entry, in basis points */
  stopBps: number;
  /** take-profit distance from entry, in basis points */
  targetBps: number;
  /** model's self-reported confidence 0-1 (recorded, never trusted) */
  confidence: number;
  reason: string;
}

/** Public endpoint, no auth. */
export async function fetchFuturesKlines(
  symbol: string,
  interval = "1m",
  limit = 60,
): Promise<Bar[]> {
  const res = await fetch(
    `${FUT_KLINES}?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
  const rows = (await res.json()) as unknown[][];
  return rows.map((r) => ({
    t: Number(r[0]),
    o: parseFloat(String(r[1])),
    h: parseFloat(String(r[2])),
    l: parseFloat(String(r[3])),
    c: parseFloat(String(r[4])),
    v: parseFloat(String(r[5])),
    tb: parseFloat(String(r[9])),
  }));
}

/**
 * Compact, token-cheap market summary. Prices are given as basis-point moves
 * relative to the latest close rather than absolute levels — this keeps the
 * prompt small AND avoids handing the model a literal price it might recognise
 * from its training data.
 */
export function buildContext(symbol: string, bars: Bar[]): string {
  const last = bars[bars.length - 1];
  const ref = last.c;
  const recent = bars.slice(-30);

  const rows = recent.map((b) => {
    const bp = (x: number) => (((x - ref) / ref) * 1e4).toFixed(1);
    const delta = 2 * b.tb - b.v; // aggressive buys - aggressive sells
    const dPct = b.v > 0 ? ((delta / b.v) * 100).toFixed(0) : "0";
    return `${bp(b.o)},${bp(b.h)},${bp(b.l)},${bp(b.c)},${dPct}`;
  });

  const closes = recent.map((b) => b.c);
  const ret5 = ((closes[closes.length - 1] / closes[closes.length - 6] - 1) * 1e4).toFixed(1);
  const ret15 = ((closes[closes.length - 1] / closes[closes.length - 16] - 1) * 1e4).toFixed(1);
  const rng = recent.map((b) => ((b.h - b.l) / b.c) * 1e4);
  const avgRng = (rng.reduce((a, b) => a + b, 0) / rng.length).toFixed(1);

  return [
    `Symbol: ${symbol} (USD-M perpetual futures), 1-minute bars.`,
    `All prices are basis points relative to the latest close (0.0 = latest close).`,
    `Columns: open,high,low,close,orderflow_delta_pct`,
    `orderflow_delta_pct = (aggressive buy vol - aggressive sell vol) / total vol * 100`,
    ``,
    rows.join("\n"),
    ``,
    `Last 5-bar return: ${ret5} bps. Last 15-bar return: ${ret15} bps.`,
    `Average 1m bar range: ${avgRng} bps.`,
    `Round-trip trading cost: 10 bps. A trade must clear that to be profitable.`,
  ].join("\n");
}

const SYSTEM_PROMPT = `You are a futures scalping assistant. You will be shown recent 1-minute bars as basis-point offsets plus order-flow delta.

Reply with ONLY a JSON object:
{"action":"long"|"short"|"flat","stop_bps":<number>,"target_bps":<number>,"confidence":<0-1>,"reason":"<max 20 words>"}

Rules:
- stop_bps and target_bps are distances from entry in basis points, both positive.
- Round-trip cost is 10 bps. If you cannot justify a target meaningfully above that, return "flat".
- Prefer "flat" when there is no clear signal. Flat is a valid and often correct answer.`;

/**
 * Ask DeepSeek for a decision. Returns null on any failure — a broken or
 * unparseable response must never be silently coerced into a trade.
 */
export async function getDecision(
  apiKey: string,
  model: string,
  context: string,
): Promise<{ decision: LlmDecision | null; raw?: string; error?: string; ms: number }> {
  const started = Date.now();
  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: context },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const ms = Date.now() - started;
    if (!res.ok) {
      const body = await res.text();
      // Never log the key; body may contain an error message only.
      return { decision: null, error: `DeepSeek HTTP ${res.status}: ${body.slice(0, 200)}`, ms };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { decision: null, raw, error: "response was not valid JSON", ms };
    }

    const action = String(parsed["action"] ?? "").toLowerCase();
    if (!["long", "short", "flat"].includes(action)) {
      return { decision: null, raw, error: `bad action: ${action}`, ms };
    }

    const stopBps = Number(parsed["stop_bps"]);
    const targetBps = Number(parsed["target_bps"]);
    if (action !== "flat" && (!(stopBps > 0) || !(targetBps > 0))) {
      return { decision: null, raw, error: "stop_bps/target_bps must be positive", ms };
    }

    return {
      decision: {
        action: action as LlmDecision["action"],
        stopBps: stopBps > 0 ? stopBps : 0,
        targetBps: targetBps > 0 ? targetBps : 0,
        confidence: Math.max(0, Math.min(1, Number(parsed["confidence"]) || 0)),
        reason: String(parsed["reason"] ?? "").slice(0, 200),
      },
      raw,
      ms,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "DeepSeek request failed");
    return { decision: null, error: msg, ms: Date.now() - started };
  }
}
