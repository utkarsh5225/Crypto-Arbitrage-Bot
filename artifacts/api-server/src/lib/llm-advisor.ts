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

// ---------------------------------------------------------------------------
// Coin selection — "which coin is best to trade right now?"
// ---------------------------------------------------------------------------

const FUT_24H = "https://fapi.binance.com/fapi/v1/ticker/24hr";

export interface CoinPick {
  symbol: string;
  reason: string;
  confidence: number;
}

/**
 * Build a compact market survey of the most liquid perpetuals so the model has
 * something concrete to choose between. Restricted to high-volume USDT perps —
 * illiquid symbols have spreads that swallow any scalp (measured: wide-spread
 * alts need >90% directional accuracy to break even).
 */
export async function buildMarketSurvey(top = 25): Promise<{ text: string; symbols: string[] }> {
  const res = await fetch(FUT_24H, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`24hr HTTP ${res.status}`);
  const rows = (await res.json()) as Record<string, string>[];

  const usdt = rows
    .filter((r) => r["symbol"]?.endsWith("USDT"))
    .map((r) => ({
      symbol: r["symbol"]!,
      changePct: parseFloat(r["priceChangePercent"] ?? "0"),
      quoteVol: parseFloat(r["quoteVolume"] ?? "0"),
      high: parseFloat(r["highPrice"] ?? "0"),
      low: parseFloat(r["lowPrice"] ?? "0"),
      last: parseFloat(r["lastPrice"] ?? "0"),
      trades: parseInt(r["count"] ?? "0", 10),
    }))
    .filter((r) => r.quoteVol > 0 && r.last > 0)
    .sort((a, b) => b.quoteVol - a.quoteVol)
    .slice(0, top);

  const lines = usdt.map((r) => {
    const rangePct = r.low > 0 ? ((r.high - r.low) / r.low) * 100 : 0;
    const vol = r.quoteVol >= 1e9
      ? `${(r.quoteVol / 1e9).toFixed(1)}B`
      : `${(r.quoteVol / 1e6).toFixed(0)}M`;
    return `${r.symbol},${r.changePct.toFixed(2)}%,${rangePct.toFixed(2)}%,${vol},${r.trades}`;
  });

  return {
    text: [
      "Most liquid USD-M perpetuals, last 24h.",
      "Columns: symbol,24h_change,24h_range,quote_volume,trade_count",
      "",
      lines.join("\n"),
    ].join("\n"),
    symbols: usdt.map((r) => r.symbol),
  };
}

const PICK_PROMPT = `You are helping choose which perpetual futures to scalp on a 1-minute timeframe.

You will see the most liquid USD-M perps with 24h stats.

Reply with ONLY JSON:
{"picks":[{"symbol":"<SYMBOL>","reason":"<max 15 words>","confidence":<0-1>}, ... exactly 5 ...]}

Choose the 5 you judge most tradeable right now. Only pick symbols from the list.
Round-trip trading cost is 10 bps, so favour symbols whose typical movement can
clear that. Be honest in the confidence field — low is fine.`;

/** Ask the model for its 5 best symbols to trade now. */
export async function suggestCoins(
  apiKey: string,
  model: string,
): Promise<{ picks: CoinPick[]; error?: string; ms: number }> {
  const started = Date.now();
  let survey: { text: string; symbols: string[] };
  try {
    survey = await buildMarketSurvey();
  } catch (err) {
    return { picks: [], error: `market survey failed: ${String(err)}`, ms: Date.now() - started };
  }

  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: PICK_PROMPT },
          { role: "user", content: survey.text },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      return { picks: [], error: `DeepSeek HTTP ${res.status}`, ms };
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { picks?: unknown[] };
    const allowed = new Set(survey.symbols);

    const picks: CoinPick[] = (parsed.picks ?? [])
      .map((p) => p as Record<string, unknown>)
      .map((p) => ({
        symbol: String(p["symbol"] ?? "").toUpperCase(),
        reason: String(p["reason"] ?? "").slice(0, 160),
        confidence: Math.max(0, Math.min(1, Number(p["confidence"]) || 0)),
      }))
      // never let the model invent a symbol that is not actually tradeable
      .filter((p) => allowed.has(p.symbol))
      .slice(0, 5);

    return { picks, ms };
  } catch (err) {
    return { picks: [], error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------
// Trade discussion — ask the model about a specific decision
// ---------------------------------------------------------------------------

export async function discussTrade(
  apiKey: string,
  model: string,
  tradeContext: string,
  question: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
): Promise<{ answer: string | null; error?: string; ms: number }> {
  const started = Date.now();
  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are discussing a specific paper trade with the operator. Be concise and " +
              "concrete. Round-trip cost is 10 bps — factor it in. If the trade was a losing " +
              "one or the reasoning was weak, say so plainly rather than rationalising it.",
          },
          { role: "user", content: `Trade under discussion:\n${tradeContext}` },
          ...history,
          { role: "user", content: question },
        ],
        temperature: 0.4,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const ms = Date.now() - started;
    if (!res.ok) return { answer: null, error: `DeepSeek HTTP ${res.status}`, ms };
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return { answer: json.choices?.[0]?.message?.content ?? "", ms };
  } catch (err) {
    return { answer: null, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

const JSON_SHAPE = `Reply with ONLY a JSON object:
{"action":"long"|"short"|"flat","stop_bps":<number>,"target_bps":<number>,"confidence":<0-1>,"reason":"<max 20 words>"}
stop_bps and target_bps are distances from entry in basis points, both positive.`;

/**
 * Cost-aware prompt. Tells the model what a round trip actually costs and that
 * flat is an acceptable answer. In practice this makes it decline nearly every
 * 1-minute setup, which is arithmetically correct (median 1m move ~1.4-2.6 bps
 * vs 10 bps cost) but produces no data to score.
 */
const PROMPT_COST_AWARE = `You are a futures scalping assistant. You will be shown recent 1-minute bars as basis-point offsets plus order-flow delta.

${JSON_SHAPE}

Rules:
- Round-trip cost is 10 bps. If you cannot justify a target meaningfully above that, return "flat".
- Prefer "flat" when there is no clear signal. Flat is a valid and often correct answer.`;

/**
 * Naive prompt — no cost constraint, matching how a typical "AI trading bot"
 * is actually built. This one WILL trade, which is the point: it generates the
 * decisions needed to score the model against the coin-flip control.
 */
const PROMPT_NAIVE = `You are an expert futures scalper trading the 1-minute timeframe. You will be shown recent 1-minute bars as basis-point offsets plus order-flow delta.

${JSON_SHAPE}

Rules:
- Read the price action and order-flow delta and make a directional call.
- Set a stop and a target that fit the recent volatility.
- Only return "flat" if the data is genuinely unreadable.`;

export function systemPromptFor(costAware: boolean): string {
  return costAware ? PROMPT_COST_AWARE : PROMPT_NAIVE;
}

const SYSTEM_PROMPT = PROMPT_COST_AWARE;

/**
 * Ask DeepSeek for a decision. Returns null on any failure — a broken or
 * unparseable response must never be silently coerced into a trade.
 */
export async function getDecision(
  apiKey: string,
  model: string,
  context: string,
  costAware = true,
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
          { role: "system", content: systemPromptFor(costAware) },
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
