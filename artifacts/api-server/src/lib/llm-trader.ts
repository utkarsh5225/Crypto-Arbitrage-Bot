/**
 * DeepSeek scalping loop.
 *
 * Every `llmIntervalSec` it: maintains its own pool of candidate symbols ->
 * manages whatever is already open -> fills any free position slots by pulling
 * recent 1m futures bars and asking DeepSeek for a decision -> tracks each
 * position to stop/target/timeout -> records the outcome with realistic
 * futures costs.
 *
 * The operator sets HOW MANY symbols may be held at once (`llmMaxConcurrent`);
 * the bot decides WHICH. Manual selection was removed as the default because a
 * pick goes stale as soon as the market moves, and a stale pick is not a pick.
 *
 * PAPER ONLY. This module never places an exchange order. Live futures
 * execution is intentionally not implemented until the recorded decisions show
 * an edge — see the scoring below.
 *
 * Every decision is scored against a COIN-FLIP baseline taken at the same
 * instant with the same stop/target. That is the number that matters: if the
 * model cannot beat a random direction, it has no edge, however fluent it is.
 */

import { logger } from "./logger";
import { store } from "./store";
import { sseManager } from "./sse-manager";
import { getLlmCredentials } from "./llm-credentials";
import {
  fetchFuturesKlines,
  buildContext,
  buildEnrichment,
  getDecision,
  reviewPosition,
  suggestCoins,
  type Bar,
} from "./llm-advisor";

/**
 * Fee model, USD-M futures retail tier.
 *
 * The flat 10 bps round trip (taker both ways) was 77% of all losses over the
 * first 9 trades, so entries now rest at the touch as maker orders. The costs
 * are asymmetric ON PURPOSE and must stay that way:
 *
 *   maker entry + target hit   2 + 2 = ~4 bps   (target is a resting limit)
 *   maker entry + stopped out  2 + 5 = ~7 bps   (a stop is a market order —
 *                                                it is NEVER a maker fill)
 *
 * With llmMakerEntry off, both sides cross: 5 + 5 = the original 10.
 */
const TAKER_BPS = 5;
const MAKER_BPS = 2;
const MAX_HOLD_BARS = 30;

function entryCost(makerEntry: boolean): number {
  return makerEntry ? MAKER_BPS : TAKER_BPS;
}
/** Only a target exit can be a maker fill; stops, timeouts and manual exits cross. */
function exitCost(makerEntry: boolean, how: string): number {
  return how === "target" ? entryCost(makerEntry) : TAKER_BPS;
}
function roundTrip(makerEntry: boolean, how: string): number {
  return entryCost(makerEntry) + exitCost(makerEntry, how);
}

let timer: NodeJS.Timeout | null = null;
let markTimer: NodeJS.Timeout | null = null;
let inFlight = false;

/** How often open positions are re-marked for display (independent of the LLM). */
const MARK_REFRESH_MS = 5_000;

export interface OpenPosition {
  id: string;
  symbol: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  openedAt: number;
  bars: number;
  reason: string;
  confidence: number;
  /**
   * COUNTERFACTUAL control: the mirrored position (opposite side, same levels)
   * run in parallel.
   *
   * This replaced a coin-flip control, which duplicated the model's own side
   * roughly half the time — measured at 8 of 10 trades — and those duplicates
   * carried zero information because the result was identical. Always running
   * the opposite side makes EVERY trade informative, so the edge metric
   * converges about 4x faster.
   *
   * A random direction's expected result is the mean of the two, so:
   *   edge = modelNet - (modelNet + oppNet)/2 = (modelNet - oppNet)/2
   */
  oppStop: number;
  oppTarget: number;
  oppOpen: boolean;
  oppResultBps?: number;
  /** Latest mark price + unrealised move, refreshed each tick for the UI. */
  lastPrice?: number;
  unrealBps?: number;
  /** Distances actually traded, kept so the UI can show them directly. */
  stopBps: number;
  targetBps: number;
  /** What the model originally asked for, before R:R enforcement. */
  requestedTargetBps?: number;
  /** Latest in-trade review from the model. */
  lastReview?: string;
  lastReviewAt?: number;
  /** Entered via resting limit (maker) — decides the fee charged on each exit. */
  makerEntry: boolean;
  /** What triggered the entry, when the breakout filter is on. */
  setup?: "breakout" | "breakdown";
}

/**
 * A decision waiting for its entry limit to fill.
 *
 * The maker saving is only real if the order actually fills, and fills are
 * adversely selected: the market coming back to the limit correlates with the
 * trade going wrong. So a timed-out entry is not discarded — it becomes a
 * GHOST that is tracked to its stop/target and recorded as what the trade
 * would have returned. If the ghosts outperform the fills, maker entry is a
 * mirage and the stats will show it.
 */
interface PendingEntry {
  symbol: string;
  side: "long" | "short";
  limit: number;
  stopBps: number;
  targetBps: number;
  requestedTargetBps?: number;
  reason: string;
  confidence: number;
  setup?: "breakout" | "breakdown";
  barsWaiting: number;
  placedAt: number;
}

/** An unfilled entry, simulated as if it had filled, for the non-fill record. */
interface GhostPosition {
  symbol: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  bars: number;
}

const open: OpenPosition[] = [];
const pending: PendingEntry[] = [];
const ghosts: GhostPosition[] = [];

function resolveOne(p: OpenPosition, bar: Bar): { done: boolean; px?: number; how?: string } {
  if (p.side === "long") {
    if (bar.l <= p.stop) return { done: true, px: p.stop, how: "stop" };
    if (bar.h >= p.target) return { done: true, px: p.target, how: "target" };
  } else {
    if (bar.h >= p.stop) return { done: true, px: p.stop, how: "stop" };
    if (bar.l <= p.target) return { done: true, px: p.target, how: "target" };
  }
  return { done: false };
}

/**
 * Resolve the mirrored (opposite-side) counterfactual against this bar.
 * Returns gross bps and HOW it closed, so the caller can charge the identical
 * maker/taker cost model as the real side — charging the control a different
 * fee would silently bias edgeVsRandom.
 */
function resolveOpp(p: OpenPosition, bar: Bar): { bps: number; how: string } | null {
  if (!p.oppOpen) return null;
  const oppSide = p.side === "long" ? "short" : "long";
  if (oppSide === "long") {
    if (bar.l <= p.oppStop) return { bps: ((p.oppStop - p.entry) / p.entry) * 1e4, how: "stop" };
    if (bar.h >= p.oppTarget) return { bps: ((p.oppTarget - p.entry) / p.entry) * 1e4, how: "target" };
  } else {
    if (bar.h >= p.oppStop) return { bps: ((p.entry - p.oppStop) / p.entry) * 1e4, how: "stop" };
    if (bar.l <= p.oppTarget) return { bps: ((p.entry - p.oppTarget) / p.entry) * 1e4, how: "target" };
  }
  return null;
}

/** Mark the opposite side to a price (a market close, so always taker out). */
function markOpp(p: OpenPosition, px: number): number {
  const oppSide = p.side === "long" ? "short" : "long";
  const g = ((oppSide === "long" ? px - p.entry : p.entry - px) / p.entry) * 1e4;
  return g - (entryCost(p.makerEntry) + TAKER_BPS);
}

/** Advance this symbol's open positions against its latest bar; close finished ones. */
function updateOpen(bars: Bar[], symbol: string): void {
  const bar = bars[bars.length - 1];
  for (let i = open.length - 1; i >= 0; i--) {
    const p = open[i];
    if (p.symbol !== symbol) continue;   // only mark against its own market
    p.bars += 1;

    // Keep a live mark so the dashboard can show the open signal's P&L.
    p.lastPrice = bar.c;
    p.unrealBps =
      ((p.side === "long" ? bar.c - p.entry : p.entry - bar.c) / p.entry) * 1e4;

    if (p.oppOpen) {
      const c = resolveOpp(p, bar);
      if (c !== null) {
        p.oppResultBps = c.bps - roundTrip(p.makerEntry, c.how);
        p.oppOpen = false;
      }
    }

    const r = resolveOne(p, bar);
    let exitPx: number | null = null;
    let how = "";
    if (r.done) { exitPx = r.px!; how = r.how!; }
    else if (p.bars >= MAX_HOLD_BARS) { exitPx = bar.c; how = "timeout"; }
    if (exitPx === null) continue;

    const grossBps =
      ((p.side === "long" ? exitPx - p.entry : p.entry - exitPx) / p.entry) * 1e4;
    const cost = roundTrip(p.makerEntry, how);
    const netBps = grossBps - cost;

    if (p.oppOpen) {
      // Counterfactual still open — mark it at the same instant for fairness.
      p.oppResultBps = markOpp(p, exitPx);
      p.oppOpen = false;
    }

    store.addLlmTrade({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entry: p.entry,
      exit: exitPx,
      grossBps,
      netBps,
      // A random direction's expectation is the mean of the two outcomes.
      ctrlNetBps: (netBps + (p.oppResultBps ?? 0)) / 2,
      oppNetBps: p.oppResultBps ?? 0,
      how,
      bars: p.bars,
      reason: p.reason,
      confidence: p.confidence,
      openedAt: p.openedAt,
      closedAt: Date.now(),
      requestedTargetBps: p.requestedTargetBps,
      enforcedTargetBps: p.targetBps,
      stopBps: p.stopBps,
      lastReview: p.lastReview,
      setup: p.setup,
      costBps: cost,
    });
    logger.info(
      { symbol: p.symbol, side: p.side, how, grossBps: grossBps.toFixed(1), netBps: netBps.toFixed(1) },
      "LLM paper trade closed",
    );
    open.splice(i, 1);
    sseManager.broadcast("llm_stats", store.getLlmStats());
  }
}

/**
 * Re-mark open positions against the live price.
 *
 * The decision loop only runs every `llmIntervalSec` (60s by default), so
 * without this the displayed price and unrealised P&L sat frozen for a whole
 * minute at a time. This is display-only and makes no LLM call.
 *
 * Stop/target RESOLUTION deliberately stays on the 1m bar in updateOpen(),
 * which uses the bar's high/low and therefore catches intrabar wicks that a
 * 5-second poll would miss.
 */
async function refreshMarks(): Promise<void> {
  if (open.length === 0) return;
  try {
    const res = await fetch("https://fapi.binance.com/fapi/v1/ticker/price", {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return;
    const rows = (await res.json()) as { symbol: string; price: string }[];
    const px = new Map(rows.map((r) => [r.symbol, parseFloat(r.price)]));

    let changed = false;
    for (const p of open) {
      const now = px.get(p.symbol);
      if (!now || !(now > 0)) continue;
      p.lastPrice = now;
      p.unrealBps = ((p.side === "long" ? now - p.entry : p.entry - now) / p.entry) * 1e4;
      changed = true;
    }
    if (changed) sseManager.broadcast("llm_open", getOpenLlmPositions());
  } catch {
    // Best effort — a missed refresh just leaves the previous mark in place.
  }
}

/** Close a position immediately at `px` and record it (used by the model's own exit). */
function closeNow(p: OpenPosition, px: number, how: string): void {
  const grossBps = ((p.side === "long" ? px - p.entry : p.entry - px) / p.entry) * 1e4;
  if (p.oppOpen) {
    p.oppResultBps = markOpp(p, px);
    p.oppOpen = false;
  }
  const cost = entryCost(p.makerEntry) + TAKER_BPS;
  const netB = grossBps - cost;
  store.addLlmTrade({
    id: p.id, symbol: p.symbol, side: p.side, entry: p.entry, exit: px,
    grossBps, netBps: netB,
    ctrlNetBps: (netB + (p.oppResultBps ?? 0)) / 2,
    oppNetBps: p.oppResultBps ?? 0,
    how, bars: p.bars, reason: p.reason, confidence: p.confidence,
    openedAt: p.openedAt, closedAt: Date.now(),
    requestedTargetBps: p.requestedTargetBps,
    enforcedTargetBps: p.targetBps,
    stopBps: p.stopBps,
    lastReview: p.lastReview,
    setup: p.setup,
    costBps: cost,
  });
  const i = open.indexOf(p);
  if (i >= 0) open.splice(i, 1);
  sseManager.broadcast("llm_stats", store.getLlmStats());
}

/**
 * Break state of the LATEST bar against the prior `lookback` bars' extremes.
 *
 * Computed from bars the tick already fetched — costs nothing. Measured before
 * building (tools/breakout_test.py, n=4541): following a 1m break averaged
 * -0.19 bps gross, i.e. a coin flip. The filter gates WHEN a decision may be
 * made, never WHICH WAY — forcing the break direction would bake in an edge
 * the data says is not there.
 */
function detectBreak(
  bars: Bar[],
  lookback: number,
): { setup: "breakout" | "breakdown"; marginPct: number; volMult: number } | null {
  if (bars.length < lookback + 1) return null;
  const last = bars[bars.length - 1];
  const prior = bars.slice(-lookback - 1, -1);
  const hh = Math.max(...prior.map((b) => b.h));
  const ll = Math.min(...prior.map((b) => b.l));
  const range = hh - ll;
  if (range <= 0) return null;
  const avgVol = prior.reduce((a, b) => a + b.v, 0) / prior.length;
  const volMult = avgVol > 0 ? last.v / avgVol : 0;
  if (last.c > hh) {
    return { setup: "breakout", marginPct: ((last.c - hh) / range) * 100, volMult };
  }
  if (last.c < ll) {
    return { setup: "breakdown", marginPct: ((ll - last.c) / range) * 100, volMult };
  }
  return null;
}

/**
 * Advance pending entry limits and ghost positions against this symbol's
 * latest bar. Runs before updateOpen so a fill starts being tracked on the
 * next tick, not retroactively against the bar that filled it.
 */
function advancePendingAndGhosts(bars: Bar[], symbol: string): void {
  const bar = bars[bars.length - 1];
  const cfg = store.config;

  for (let i = pending.length - 1; i >= 0; i--) {
    const q = pending[i];
    if (q.symbol !== symbol) continue;
    q.barsWaiting += 1;

    const filled = q.side === "long" ? bar.l <= q.limit : bar.h >= q.limit;
    if (filled) {
      const stopD = (q.stopBps / 1e4) * q.limit;
      const tgtD = (q.targetBps / 1e4) * q.limit;
      open.push({
        id: `${Date.now()}`,
        symbol: q.symbol,
        side: q.side,
        entry: q.limit,
        stop: q.side === "long" ? q.limit - stopD : q.limit + stopD,
        target: q.side === "long" ? q.limit + tgtD : q.limit - tgtD,
        openedAt: Date.now(),
        bars: 0,
        reason: q.reason,
        confidence: q.confidence,
        oppStop: q.side === "long" ? q.limit + stopD : q.limit - stopD,
        oppTarget: q.side === "long" ? q.limit - tgtD : q.limit + tgtD,
        oppOpen: true,
        lastPrice: q.limit,
        unrealBps: 0,
        stopBps: q.stopBps,
        targetBps: q.targetBps,
        requestedTargetBps: q.requestedTargetBps,
        makerEntry: true,
        setup: q.setup,
      });
      store.recordEntryFill();
      pending.splice(i, 1);
      logger.info({ symbol, side: q.side, limit: q.limit, waited: q.barsWaiting },
        "Entry limit filled (maker)");
      continue;
    }

    if (q.barsWaiting >= cfg.llmMakerFillTimeoutBars) {
      // The trade never happened — but its outcome still matters. Track the
      // ghost so the non-fill record can say what got away.
      const stopD = (q.stopBps / 1e4) * q.limit;
      const tgtD = (q.targetBps / 1e4) * q.limit;
      ghosts.push({
        symbol: q.symbol,
        side: q.side,
        entry: q.limit,
        stop: q.side === "long" ? q.limit - stopD : q.limit + stopD,
        target: q.side === "long" ? q.limit + tgtD : q.limit - tgtD,
        bars: 0,
      });
      pending.splice(i, 1);
      logger.info({ symbol, side: q.side, waited: q.barsWaiting },
        "Entry limit timed out unfilled — tracking as ghost");
    }
  }

  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i];
    if (g.symbol !== symbol) continue;
    g.bars += 1;
    let gross: number | null = null;
    let how = "";
    if (g.side === "long") {
      if (bar.l <= g.stop) { gross = ((g.stop - g.entry) / g.entry) * 1e4; how = "stop"; }
      else if (bar.h >= g.target) { gross = ((g.target - g.entry) / g.entry) * 1e4; how = "target"; }
    } else {
      if (bar.h >= g.stop) { gross = ((g.entry - g.stop) / g.entry) * 1e4; how = "stop"; }
      else if (bar.l <= g.target) { gross = ((g.entry - g.target) / g.entry) * 1e4; how = "target"; }
    }
    if (gross === null && g.bars >= MAX_HOLD_BARS) {
      gross = ((g.side === "long" ? bar.c - g.entry : g.entry - bar.c) / g.entry) * 1e4;
      how = "timeout";
    }
    if (gross === null) continue;
    const net = gross - roundTrip(true, how);
    store.recordEntryNonFill(net);
    ghosts.splice(i, 1);
    logger.info({ symbol, side: g.side, how, wouldHaveNetBps: +net.toFixed(1) },
      "Ghost resolved — this is what the unfilled entry would have returned");
  }
}

/** Symbols currently holding a position (deduped — one symbol can only be held once). */
function heldSymbols(): string[] {
  return [...new Set(open.map((p) => p.symbol))];
}

/**
 * Symbols that need their bars advanced every tick even with no open position:
 * pending limits must get their fill/timeout checked and ghosts must resolve,
 * or an unscanned symbol would leave them frozen.
 */
function managedSymbols(): string[] {
  return [...new Set([
    ...open.map((p) => p.symbol),
    ...pending.map((q) => q.symbol),
    ...ghosts.map((g) => g.symbol),
  ])];
}

/**
 * The symbols the bot may consider this tick.
 *
 * Auto mode uses the pool it picked for itself; manual mode uses the operator's
 * selection, with the legacy single-symbol field as the last fallback.
 */
function candidatePool(): string[] {
  if (store.config.llmAutoPick && store.llmPicks.length > 0) {
    return store.llmPicks.map((p) => p.symbol);
  }
  const sel = store.config.llmSymbols;
  return sel && sel.length > 0 ? sel : [store.config.llmSymbol];
}

let repickInFlight = false;

/**
 * Refresh the candidate pool when it is empty or stale.
 *
 * The pool is deliberately LARGER than the number of slots (3x, clamped 5..12)
 * so the bot has something to choose between rather than being forced into
 * whatever it named first. Symbols with an open position are always retained —
 * dropping one from the pool would orphan a live position from its analysis.
 */
async function ensureCandidates(creds: { apiKey: string; model: string }): Promise<void> {
  const cfg = store.config;
  if (!cfg.llmAutoPick) return;

  const ageMin = (Date.now() - store.llmPicksAt) / 60_000;
  if (store.llmPicks.length > 0 && ageMin < cfg.llmRepickMinutes) return;
  if (repickInFlight) return;

  repickInFlight = true;
  try {
    const want = Math.min(12, Math.max(5, cfg.llmMaxConcurrent * 3));
    const { picks, error, ms } = await suggestCoins(creds.apiKey, creds.model, want);
    store.bumpLlmCalls(ms);

    if (picks.length === 0) {
      // Keep trading the previous pool rather than going dark on a bad response.
      logger.warn({ error }, "Auto-pick returned no candidates — keeping the previous pool");
      return;
    }

    const merged = [...picks];
    for (const h of heldSymbols()) {
      if (!merged.some((p) => p.symbol === h)) {
        merged.push({ symbol: h, reason: "retained — position open", confidence: 0 });
      }
    }

    store.llmPicks = merged;
    store.llmPicksAt = Date.now();
    store.config.llmSymbols = merged.map((p) => p.symbol);
    logger.info(
      { symbols: merged.map((p) => p.symbol).join(","), ms },
      "Auto-picked candidate pool",
    );
    sseManager.broadcast("llm_picks", { picks: merged, at: store.llmPicksAt });
  } finally {
    repickInFlight = false;
  }
}

type TickResult = "opened" | "none";

/**
 * One symbol, one tick.
 *
 * `allowEntry` is the slot gate: when false this only manages an existing
 * position and will never open a new one. Checked BEFORE the decision call so a
 * full book costs no API tokens.
 */
async function tickSymbol(
  symbol: string,
  creds: { apiKey: string; model: string },
  allowEntry: boolean,
): Promise<TickResult> {
  const cfg = store.config;
  const bars = await fetchFuturesKlines(symbol, "1m", 60);
  advancePendingAndGhosts(bars, symbol);
  updateOpen(bars, symbol);

  // A pending limit already commits this symbol (and a slot) — no new decision.
  if (pending.some((q) => q.symbol === symbol)) return "none";

  const enrichment = await buildEnrichment(symbol).catch(() => "");
  const costLine = cfg.llmMakerEntry
    ? `Round-trip cost: ~${2 * MAKER_BPS} bps if your target is hit (maker in, maker out), ` +
      `~${MAKER_BPS + TAKER_BPS} bps if stopped or exited early (a stop is a market order). ` +
      `Your entry rests at the touch and may not fill.`
    : undefined;
  const ctx = buildContext(symbol, bars, costLine) + enrichment;

  // ── Manage an already-open position rather than ignoring it ────────────────
  const held = open.find((p) => p.symbol === symbol);
  if (held) {
    // ── Minimum hold ─────────────────────────────────────────────────────────
    // Do not even ASK before this. The review call is not free of consequence:
    // an LLM asked "should you exit?" every 60 seconds eventually says yes, and
    // each yes costs the 10 bps round trip. Reviewing a position with a 300 bps
    // stop after one minute is asking about noise.
    if (held.bars < cfg.llmMinHoldBars) return "none";

    const { review, error: rErr, ms: rMs } = await reviewPosition(
      creds.apiKey, cfg.llmDecisionModel || creds.model, ctx,
      {
        symbol: held.symbol, side: held.side, entry: held.entry,
        lastPrice: held.lastPrice ?? held.entry, unrealBps: held.unrealBps ?? 0,
        barsHeld: held.bars, stopBps: held.stopBps, targetBps: held.targetBps,
        originalReason: held.reason,
      },
    );
    store.bumpLlmCalls(rMs);
    if (!review) {
      logger.warn({ symbol, error: rErr }, "Position review unusable — holding");
      return "none";
    }
    store.bumpLlmReviews();
    held.lastReview = `${review.action}: ${review.reason}`;
    held.lastReviewAt = Date.now();

    if (review.action === "exit") {
      // ── Exit gate ──────────────────────────────────────────────────────────
      // Enforced here, not just stated in the prompt — the same lesson as the
      // R:R rule, which the model ignored 27 times out of 34 when it was only
      // asked nicely.
      //
      // An exit is allowed when the thesis is genuinely breaking (price has
      // travelled a meaningful fraction of the way to the stop) or when the
      // profit clearly clears the round trip. Anything else is churn: the six
      // early exits so far averaged +0.31 bps gross and -9.69 bps net.
      const unreal = held.unrealBps ?? 0;
      const adverseEnough = unreal <= -held.stopBps * cfg.llmExitMinAdverseFrac;
      const profitEnough = unreal >= (entryCost(held.makerEntry) + TAKER_BPS) * 2;

      if (adverseEnough || profitEnough) {
        closeNow(held, held.lastPrice ?? held.entry, "llm_exit");
        logger.info({ symbol, unrealBps: +unreal.toFixed(1), reason: review.reason },
          "DeepSeek closed its own position");
      } else {
        store.bumpExitsBlocked();
        held.lastReview = `exit blocked (noise): ${review.reason}`;
        logger.info(
          { symbol, unrealBps: +unreal.toFixed(1), stopBps: +held.stopBps.toFixed(1),
            needAdverseBps: +(-held.stopBps * cfg.llmExitMinAdverseFrac).toFixed(1),
            reason: review.reason },
          "Blocked exit — move is inside the model's own stop distance",
        );
      }
    } else if (review.action === "tighten_stop" && review.newStopBps) {
      // Only ever reduce risk. Widening a stop turns a small loss into a large
      // one — exactly the failure mode the R:R enforcement exists to prevent.
      if (review.newStopBps < held.stopBps) {
        const d = (review.newStopBps / 1e4) * held.entry;
        held.stop = held.side === "long" ? held.entry - d : held.entry + d;
        held.stopBps = review.newStopBps;
        logger.info({ symbol, newStopBps: review.newStopBps, reason: review.reason }, "DeepSeek tightened its stop");
      } else {
        logger.warn(
          { symbol, requested: review.newStopBps, current: held.stopBps },
          "Ignored stop change — model tried to WIDEN the stop",
        );
      }
    }
    sseManager.broadcast("llm_stats", store.getLlmStats());
    return "none";
  }

  // No free slot — do not spend a decision call we could not act on.
  if (!allowEntry) return "none";

  // hard cap so a chatty model cannot rack up unlimited (simulated) cost
  if (store.getLlmStats().today >= cfg.llmMaxTradesPerDay) return "none";

  // ── Breakout gate ──────────────────────────────────────────────────────────
  // Checked BEFORE the decision call: a symbol that is not breaking costs zero
  // tokens. The gate decides WHEN a decision may happen — the model still
  // chooses the side and may still say flat, because following and fading a
  // break both measured as coin flips (tools/breakout_test.py).
  const brk = detectBreak(bars, cfg.llmBreakoutLookback);
  if (cfg.llmBreakoutOnly && !brk) return "none";

  let decisionCtx = ctx;
  if (brk) {
    decisionCtx += `
BREAK: this bar closed ${brk.setup === "breakout" ? "ABOVE the high" : "BELOW the low"} ` +
      `of the prior ${cfg.llmBreakoutLookback} bars (${brk.setup}), clearing the range by ` +
      `${brk.marginPct.toFixed(0)}% of its width on ${brk.volMult.toFixed(1)}x average volume. ` +
      `Historically a 1m break continues or reverses about equally often — judge from the full picture.`;
  }

  const { decision, error, ms } = await getDecision(
    creds.apiKey, cfg.llmDecisionModel || creds.model, decisionCtx,
    cfg.llmCostAware, cfg.llmMinRiskReward,
  );

  store.bumpLlmCalls(ms);
  if (!decision) {
    logger.warn({ symbol, error, ms }, "DeepSeek decision unusable — skipping");
    return "none";
  }
  if (decision.action === "flat") {
    store.addLlmSkip();
    logger.info({ symbol, reason: decision.reason }, "DeepSeek: flat");
    sseManager.broadcast("llm_stats", store.getLlmStats());
    return "none";
  }

  {
    const last = bars[bars.length - 1];
    const entry = last.c;

    // ── Enforce reward > risk ────────────────────────────────────────────────
    // Measured over its first 34 decisions the model proposed reward < risk 27
    // times (avg R:R 0.76, most often 0.50). That produced many small wins and
    // occasional losses ~3x larger — a 78% win rate that barely broke even.
    // Stating it in the prompt is not enough, so it is enforced here.
    // ── Floor the stop against real volatility ───────────────────────────────
    // 8 of the first 10 trades stopped out, average hold 2.6 minutes and several
    // inside a single bar: the stops were being placed inside ordinary noise.
    const recent = bars.slice(-20);
    const avgRangeBps =
      recent.reduce((a, b) => a + ((b.h - b.l) / b.c) * 1e4, 0) / Math.max(1, recent.length);
    const minStopBps = avgRangeBps * cfg.llmMinStopVolMult;
    let stopBps = decision.stopBps;
    if (stopBps < minStopBps) {
      logger.info(
        { symbol, requestedStopBps: stopBps, enforcedStopBps: +minStopBps.toFixed(1),
          avgRangeBps: +avgRangeBps.toFixed(1), mult: cfg.llmMinStopVolMult },
        "Widened stop to clear recent volatility",
      );
      stopBps = minStopBps;
      store.bumpStopWidened();
    }

    // ── Hard stop cap ────────────────────────────────────────────────────────
    // REJECT rather than clamp: clamping would place a stop tighter than the
    // volatility floor just said was survivable — the worst of both settings.
    if (stopBps > cfg.llmMaxStopBps) {
      store.bumpStopCapRejected();
      logger.warn(
        { symbol, stopBps: +stopBps.toFixed(1), maxStopBps: cfg.llmMaxStopBps },
        "Rejected trade — required stop exceeds the maximum",
      );
      return "none";
    }

    const minRR = cfg.llmMinRiskReward;
    const requestedTargetBps = decision.targetBps;
    let targetBps = decision.targetBps;
    const requiredTarget = stopBps * minRR;

    if (targetBps < requiredTarget) {
      if (cfg.llmRejectLowRR) {
        store.bumpRrRejected();
        logger.warn(
          { symbol, stopBps, requestedTargetBps,
            requiredTarget, rr: +(targetBps / stopBps).toFixed(2) },
          "Rejected trade — reward below the minimum risk:reward",
        );
        return "none";
      }
      targetBps = requiredTarget;
      store.bumpRrAdjusted();
      logger.info(
        { symbol, stopBps, requestedTargetBps,
          enforcedTargetBps: targetBps,
          requestedRR: +(requestedTargetBps / stopBps).toFixed(2),
          enforcedRR: minRR },
        "Widened target to meet the minimum risk:reward",
      );
    }

    const side = decision.action;

    if (cfg.llmMakerEntry) {
      // Rest at the touch and wait. The position opens only if the market
      // trades back to the limit; otherwise it times out into a ghost.
      pending.push({
        symbol,
        side,
        limit: entry,
        stopBps,
        targetBps,
        requestedTargetBps,
        reason: decision.reason,
        confidence: decision.confidence,
        setup: brk?.setup,
        barsWaiting: 0,
        placedAt: Date.now(),
      });
      logger.info(
        { symbol, side, limit: entry, stopBps: +stopBps.toFixed(1),
          targetBps: +targetBps.toFixed(1), setup: brk?.setup,
          confidence: decision.confidence, reason: decision.reason },
        "Entry limit placed (maker) — waiting for a fill",
      );
      sseManager.broadcast("llm_stats", store.getLlmStats());
      // The slot is committed even though the position is not open yet.
      return "opened";
    }

    const stopD = (stopBps / 1e4) * entry;
    const tgtD = (targetBps / 1e4) * entry;

    open.push({
      id: `${Date.now()}`,
      symbol,
      side,
      entry,
      stop: side === "long" ? entry - stopD : entry + stopD,
      target: side === "long" ? entry + tgtD : entry - tgtD,
      openedAt: Date.now(),
      bars: 0,
      reason: decision.reason,
      confidence: decision.confidence,
      // Mirrored counterfactual: opposite side, same distances.
      oppStop: side === "long" ? entry + stopD : entry - stopD,
      oppTarget: side === "long" ? entry - tgtD : entry + tgtD,
      oppOpen: true,
      lastPrice: entry,
      unrealBps: 0,
      stopBps,
      targetBps,
      requestedTargetBps,
      makerEntry: false,
      setup: brk?.setup,
    });

    logger.info(
      { symbol, side, stopBps, targetBps,
        rr: +(targetBps / stopBps).toFixed(2),
        confidence: decision.confidence, reason: decision.reason },
      "DeepSeek paper position opened",
    );
    sseManager.broadcast("llm_stats", store.getLlmStats());
    return "opened";
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  if (!store.config.llmEnabled) return;
  const creds = getLlmCredentials();
  if (!creds) return;

  inFlight = true;
  try {
    const cfg = store.config;
    await ensureCandidates(creds).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Auto-pick failed");
    });

    const run = async (symbol: string, allowEntry: boolean): Promise<TickResult> => {
      try {
        return await tickSymbol(symbol, creds, allowEntry);
      } catch (err) {
        logger.warn(
          { symbol, err: err instanceof Error ? err.message : String(err) },
          "LLM tick failed for symbol",
        );
        return "none";
      }
    };

    // ── 1. Manage what is already committed ──────────────────────────────────
    // Unconditional and first: open positions need stops/targets resolved,
    // pending limits need fill/timeout checks, ghosts need resolving —
    // whether or not there is room for anything new.
    for (const symbol of managedSymbols()) await run(symbol, false);

    // ── 2. Fill free slots ───────────────────────────────────────────────────
    // A pending limit holds a slot: it can become a position at any bar.
    const free0 = Math.max(0, cfg.llmMaxConcurrent - open.length - pending.length);
    if (free0 === 0) return;

    const pool = candidatePool().filter(
      (s) => !open.some((p) => p.symbol === s) && !pending.some((q) => q.symbol === s),
    );
    if (pool.length === 0) return;

    // Bounded scan: at most 2 look-ups per free slot, from a rotating cursor.
    // Without the bound a 12-symbol pool would cost 12 decision calls every
    // minute; the cursor makes sure the ones not reached this tick are the
    // ones reached first next tick, so no candidate is starved.
    const budget = Math.min(pool.length, free0 * 2);
    let free = free0;
    for (let i = 0; i < budget && free > 0; i++) {
      const symbol = pool[(store.llmScanCursor + i) % pool.length];
      if (await run(symbol, true) === "opened") free -= 1;
    }
    store.llmScanCursor = (store.llmScanCursor + budget) % pool.length;
  } finally {
    inFlight = false;
  }
}

export function startLlmTrader(): void {
  if (timer) return;
  const sec = Math.max(30, store.config.llmIntervalSec);
  timer = setInterval(() => { void tick(); }, sec * 1000);
  // Independent of the decision cadence so open positions show a live price.
  markTimer = setInterval(() => { void refreshMarks(); }, MARK_REFRESH_MS);
  logger.info(
    { intervalSec: sec, markRefreshMs: MARK_REFRESH_MS },
    "LLM trader started (PAPER only)",
  );
}

export function stopLlmTrader(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (markTimer) { clearInterval(markTimer); markTimer = null; }
}

export function getOpenLlmPositions(): OpenPosition[] {
  return open;
}

export function getPendingLlmEntries(): PendingEntry[] {
  return pending;
}
