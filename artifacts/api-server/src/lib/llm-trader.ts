/**
 * DeepSeek scalping loop.
 *
 * Every `llmIntervalSec` it: pulls recent 1m futures bars -> asks DeepSeek for a
 * decision -> opens a simulated position -> tracks it to stop/target/timeout ->
 * records the outcome with realistic futures costs.
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
  type Bar,
} from "./llm-advisor";

/** USD-M futures taker, both sides. Same figure used across the analysis tools. */
const ROUND_TRIP_BPS = 10;
const MAX_HOLD_BARS = 30;

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
  /** coin-flip control taken at the same instant with the same levels */
  ctrlSide: "long" | "short";
  ctrlStop: number;
  ctrlTarget: number;
  ctrlOpen: boolean;
  ctrlResultBps?: number;
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
}

const open: OpenPosition[] = [];

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

function resolveCtrl(p: OpenPosition, bar: Bar): number | null {
  if (!p.ctrlOpen) return null;
  if (p.ctrlSide === "long") {
    if (bar.l <= p.ctrlStop) return ((p.ctrlStop - p.entry) / p.entry) * 1e4;
    if (bar.h >= p.ctrlTarget) return ((p.ctrlTarget - p.entry) / p.entry) * 1e4;
  } else {
    if (bar.h >= p.ctrlStop) return ((p.entry - p.ctrlStop) / p.entry) * 1e4;
    if (bar.l <= p.ctrlTarget) return ((p.entry - p.ctrlTarget) / p.entry) * 1e4;
  }
  return null;
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

    if (p.ctrlOpen) {
      const c = resolveCtrl(p, bar);
      if (c !== null) { p.ctrlResultBps = c - ROUND_TRIP_BPS; p.ctrlOpen = false; }
    }

    const r = resolveOne(p, bar);
    let exitPx: number | null = null;
    let how = "";
    if (r.done) { exitPx = r.px!; how = r.how!; }
    else if (p.bars >= MAX_HOLD_BARS) { exitPx = bar.c; how = "timeout"; }
    if (exitPx === null) continue;

    const grossBps =
      ((p.side === "long" ? exitPx - p.entry : p.entry - exitPx) / p.entry) * 1e4;
    const netBps = grossBps - ROUND_TRIP_BPS;

    if (p.ctrlOpen) {
      // control never resolved either — mark it to the same close for fairness
      const cg = ((p.ctrlSide === "long" ? bar.c - p.entry : p.entry - bar.c) / p.entry) * 1e4;
      p.ctrlResultBps = cg - ROUND_TRIP_BPS;
      p.ctrlOpen = false;
    }

    store.addLlmTrade({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entry: p.entry,
      exit: exitPx,
      grossBps,
      netBps,
      ctrlNetBps: p.ctrlResultBps ?? 0,
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
  if (p.ctrlOpen) {
    // Mark the control to the same instant so the comparison stays fair.
    const cg = ((p.ctrlSide === "long" ? px - p.entry : p.entry - px) / p.entry) * 1e4;
    p.ctrlResultBps = cg - ROUND_TRIP_BPS;
    p.ctrlOpen = false;
  }
  store.addLlmTrade({
    id: p.id, symbol: p.symbol, side: p.side, entry: p.entry, exit: px,
    grossBps, netBps: grossBps - ROUND_TRIP_BPS,
    ctrlNetBps: p.ctrlResultBps ?? 0,
    how, bars: p.bars, reason: p.reason, confidence: p.confidence,
    openedAt: p.openedAt, closedAt: Date.now(),
    requestedTargetBps: p.requestedTargetBps,
    enforcedTargetBps: p.targetBps,
    stopBps: p.stopBps,
    lastReview: p.lastReview,
  });
  const i = open.indexOf(p);
  if (i >= 0) open.splice(i, 1);
  sseManager.broadcast("llm_stats", store.getLlmStats());
}

/** Symbols the operator selected from DeepSeek's picks (falls back to the single field). */
function activeSymbols(): string[] {
  const sel = store.config.llmSymbols;
  return sel && sel.length > 0 ? sel : [store.config.llmSymbol];
}

async function tickSymbol(symbol: string, creds: { apiKey: string; model: string }): Promise<void> {
  const cfg = store.config;
  const bars = await fetchFuturesKlines(symbol, "1m", 60);
  updateOpen(bars, symbol);

  const enrichment = await buildEnrichment(symbol).catch(() => "");
  const ctx = buildContext(symbol, bars) + enrichment;

  // ── Manage an already-open position rather than ignoring it ────────────────
  const held = open.find((p) => p.symbol === symbol);
  if (held) {
    const { review, error: rErr, ms: rMs } = await reviewPosition(
      creds.apiKey, creds.model, ctx,
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
      return;
    }
    store.bumpLlmReviews();
    held.lastReview = `${review.action}: ${review.reason}`;
    held.lastReviewAt = Date.now();

    if (review.action === "exit") {
      closeNow(held, held.lastPrice ?? held.entry, "llm_exit");
      logger.info({ symbol, reason: review.reason }, "DeepSeek closed its own position");
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
    return;
  }

  // hard cap so a chatty model cannot rack up unlimited (simulated) cost
  if (store.getLlmStats().today >= cfg.llmMaxTradesPerDay) return;

  const { decision, error, ms } = await getDecision(
    creds.apiKey, creds.model, ctx, cfg.llmCostAware, cfg.llmMinRiskReward,
  );

  store.bumpLlmCalls(ms);
  if (!decision) {
    logger.warn({ symbol, error, ms }, "DeepSeek decision unusable — skipping");
    return;
  }
  if (decision.action === "flat") {
    store.addLlmSkip();
    logger.info({ symbol, reason: decision.reason }, "DeepSeek: flat");
    sseManager.broadcast("llm_stats", store.getLlmStats());
    return;
  }

  {
    const last = bars[bars.length - 1];
    const entry = last.c;

    // ── Enforce reward > risk ────────────────────────────────────────────────
    // Measured over its first 34 decisions the model proposed reward < risk 27
    // times (avg R:R 0.76, most often 0.50). That produced many small wins and
    // occasional losses ~3x larger — a 78% win rate that barely broke even.
    // Stating it in the prompt is not enough, so it is enforced here.
    const minRR = cfg.llmMinRiskReward;
    const requestedTargetBps = decision.targetBps;
    let targetBps = decision.targetBps;
    const requiredTarget = decision.stopBps * minRR;

    if (targetBps < requiredTarget) {
      if (cfg.llmRejectLowRR) {
        store.bumpRrRejected();
        logger.warn(
          { symbol, stopBps: decision.stopBps, requestedTargetBps,
            requiredTarget, rr: +(targetBps / decision.stopBps).toFixed(2) },
          "Rejected trade — reward below the minimum risk:reward",
        );
        return;
      }
      targetBps = requiredTarget;
      store.bumpRrAdjusted();
      logger.info(
        { symbol, stopBps: decision.stopBps, requestedTargetBps,
          enforcedTargetBps: targetBps,
          requestedRR: +(requestedTargetBps / decision.stopBps).toFixed(2),
          enforcedRR: minRR },
        "Widened target to meet the minimum risk:reward",
      );
    }

    const stopD = (decision.stopBps / 1e4) * entry;
    const tgtD = (targetBps / 1e4) * entry;
    const side = decision.action;
    const ctrlSide: "long" | "short" = Math.random() < 0.5 ? "long" : "short";

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
      ctrlSide,
      ctrlStop: ctrlSide === "long" ? entry - stopD : entry + stopD,
      ctrlTarget: ctrlSide === "long" ? entry + tgtD : entry - tgtD,
      ctrlOpen: true,
      lastPrice: entry,
      unrealBps: 0,
      stopBps: decision.stopBps,
      targetBps,
      requestedTargetBps,
    });

    logger.info(
      { symbol, side, stopBps: decision.stopBps, targetBps,
        rr: +(targetBps / decision.stopBps).toFixed(2),
        confidence: decision.confidence, reason: decision.reason },
      "DeepSeek paper position opened",
    );
    sseManager.broadcast("llm_stats", store.getLlmStats());
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  if (!store.config.llmEnabled) return;
  const creds = getLlmCredentials();
  if (!creds) return;

  inFlight = true;
  try {
    // Sequential, not parallel: keeps API usage predictable and avoids racing
    // several decisions against the same per-day cap.
    for (const symbol of activeSymbols()) {
      try {
        await tickSymbol(symbol, creds);
      } catch (err) {
        logger.warn(
          { symbol, err: err instanceof Error ? err.message : String(err) },
          "LLM tick failed for symbol",
        );
      }
    }
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
