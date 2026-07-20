# Crypto trading research bot

A paper-trading and measurement rig for crypto strategies, running on Binance
public data. It has never placed a real order.

## Read this first

**[`docs/FINDINGS.md`](docs/FINDINGS.md) — eight strategies were measured here
and none of them had an edge that survived costs.**

That document exists so a ninth attempt starts from evidence. The short version:
every strategy tried produced a gross edge of roughly 0-3 bps against a
round-trip cost of 7-30 bps, and the median 1-minute move on liquid majors is
4 bps. The constraint has been arithmetic, not implementation quality.

Before building anything new, run `python3 tools/horizon.py` against the intended
instrument and timeframe. If the median move is not a clear multiple of the
round-trip cost, the answer is already known.

## What is here

```
artifacts/api-server/     Node/TypeScript API + the DeepSeek decision loop
artifacts/arb-dashboard/  React dashboard (signals, stats, measurement panels)
tools/                    Read-only analysis scripts - see tools/README.md
docs/FINDINGS.md          The consolidated research record
DEPLOYMENT.md             VPS setup and systemd service
```

## Current state

The DeepSeek loop is **stopped** (`llmEnabled: false`). The measurement rig is
left intact and working: breakout detection with a grading dossier, maker-fill
simulation with ghost tracking for unfilled entries, a mirrored counterfactual
that scores every trade against the opposite side, and stats split by setup and
break quality.

It is a working instrument attached to a signal that does not exist. Point it at
a better question rather than rebuilding it.

## Safety notes

- Paper only. No exchange-order code path is wired to the LLM loop.
- Credentials are AES-256-GCM encrypted at rest and never logged or returned by
  any route. `.llm-credentials.json` and `.credentials-key` are gitignored —
  keep it that way.
- The analysis scripts in `tools/` take no keys and place no orders.
