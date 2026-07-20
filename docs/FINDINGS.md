# Findings: eight strategies, measured

Every trading strategy attempted in this project was measured before it was
trusted, and none of them had an edge that survived costs. This document is the
record, so that strategy number nine starts from evidence instead of from
scratch.

**Total real money lost: $0.** Everything below was established with public
market data and paper trading.

## The results

| # | Strategy | Sample | Gross edge | Cost to clear | Verdict |
|---|---|---|---|---|---|
| 1 | Triangular arbitrage (spot) | continuous scan | +4.3 bps | 30 bps | dead |
| 2 | 4-leg arbitrage (spot) | 194,876 paths | 0 profitable paths | 40 bps | dead |
| 3 | Market making (spot) | markout @5s | -9.7 bps | 10 bps maker | dead |
| 4 | Funding carry (spot-perp) | 6 symbols, 30d | 0 of 6 positive | ~20 bps/cycle | dead |
| 5 | Order flow / CVD (PDF) | 1m futures | ~±1 bps | 10 bps | dead |
| 6 | Combined S1/S3/S4 (PDF) | months, OOS split | ~±1 bps | 10 bps | dead |
| 7 | LLM discretionary scalping | 9 paper trades | -3.1 bps | 10 bps | dead |
| 8 | 1m breakout scalping | 3,490 breaks + 7 live | +2.8 bps best case | 7 bps | dead |

Scripts for each are in [`tools/`](../tools) — see [`tools/README.md`](../tools/README.md).

## The common cause

Not one of these failed because the idea was implemented badly, or because the
signal needed more tuning. **Every single one produced a gross edge of roughly
0-3 bps and faced a round-trip cost of 7-30 bps.**

The constraint is arithmetic, not skill:

```
median 1-minute bar range on liquid majors :  4.0 bps
cheapest realistic round trip              :  7.0 bps
```

The typical move is smaller than the toll to capture it. No signal fixes that,
because the signal is not what is broken.

## Why 7 bps is the floor

USD-M futures retail tier (verify against the current schedule — these change):

```
taker  5 bps/side        maker  2 bps/side

entry maker + target maker  =  ~4 bps    best case, requires the limit to fill
entry maker + STOPPED OUT   =  ~7 bps    a stop is a market order, always taker
entry taker + exit taker    =  10 bps    the naive round trip
```

7 bps is the honest planning number, because most scalps exit at their stop, and
**a stop can never be a maker fill**. Assuming 4 bps means assuming you are never
wrong.

Maker entry was implemented and does help — but it is not free. A resting limit
fills preferentially when the market comes *to* you, which correlates with the
trade going against you. The bot tracks every unfilled entry as a "ghost" and
records what it would have returned, specifically so this bias is measured rather
than assumed away.

## The horizon table

The one axis where the ratio inverts ([`tools/horizon.py`](../tools/horizon.py)):

| horizon | median move | vs 7 bps | vs 10 bps | pct of bars moving > 10 bps |
|---|---|---|---|---|
| 1m | 3.0-3.7 bps | 0.5 | 0.3 | 10-11% |
| 5m | 5.3-5.5 bps | 0.8 | 0.6 | 26% |
| 15m | 10.1 bps | 1.4 | 1.0 | 50% |
| 1h | 23.3 bps | 3.3 | 2.3 | 75% |
| 4h | 51.7-52.0 bps | 7.4 | 5.2 | 88% |

Ranges are two runs a few hours apart — the medians drift with the tape, the
shape does not. The script prints its own ratio against a 10 bps taker round
trip; the 7 bps column is the maker-entry figure used elsewhere in this
document. Re-run it for current numbers rather than trusting these.

At 1m, only ~10% of bars move more than the fee **at perfect timing** — and
perfect timing is not available. Costs stop being decisive somewhere around the
15m-1h mark. That does not mean edge exists there; it means the question becomes
askable.

## Strategy 8 in detail — because it is the most thoroughly killed

The final attempt was 1-minute breakout scalping with a professional grading
checklist and maker entry. Every escape route was tested.

**Widening the stops does not help.** Win rate is pinned at ~25% regardless:

```
stop  15 bps -> avgNet  -8.34     stop  60 bps -> avgNet -11.48
stop  20 bps -> avgNet  -8.92     stop  80 bps -> avgNet -11.50
stop  30 bps -> avgNet -10.49     stop 120 bps -> avgNet -11.21
```

Wider stops are *worse*, not better. (Adverse excursion after a break: p50 14.7
bps, p75 26.7, p90 44.0 — so a stop wide enough to survive is also wide enough to
make the target unreachable.)

**No reward:risk ratio helps** (stop 20 bps, cost 7):

```
R:R      0.25   0.50   0.75   1.00   1.50   2.00   3.00
follow  -7.59  -7.82  -8.03  -8.30  -8.53  -8.92  -9.75
fade    -7.02  -6.23  -5.85  -5.72  -4.91  -4.67  -4.42
```

**Fading beats following, and still loses.** Best configuration found anywhere:
stop 60 bps, R:R 0.75, fading — **-3.18 bps**. At zero cost the same setup makes
+2.82 bps. That gap is the entire finding.

**The textbook filters make it worse**, which was the most surprising result
(4,497 breaks):

```
compressed range before break  +0.45  |  expanded          -0.41
small break bar (<1.5x ATR)    +0.47  |  impulsive bar     -0.92
weak close                     +0.41  |  conviction close  -0.32
volume surge >2x               -1.73  |  no surge          +0.70
loud combo (expanded + big bar)-1.62  <- the classic "textbook" breakout
```

The break that looks most convincing performs worst — consistent with it being
the most crowded entry, where you are the exit liquidity.

**Live paper results** (7 trades, frozen 2026-07-20):

```
avgNetBps        -19.82      winRate           14%
avgGrossBps      -12.82      avgCostBps         7.0
edgeVsRandom     -12.08      avgOppNetBps      +4.33
fillRate           91%       avgNonFillWouldBe +12.57  (n=1, too small to lean on)
```

`avgOppNetBps` being positive while the model's own side is deeply negative means
the mirror of its trades was profitable — the live data and the backtest
independently agree that fading beat following. Both still lose after costs.

## Two things we got wrong, recorded so they are not repeated

**Enforcing reward > risk was right for one problem and wrong for another.** The
model was proposing R:R of 0.76 on average — risking more than it stood to make —
so a 2.0 minimum was enforced. That fixed a real pathology. But on a
mean-reverting signal, demanding 2:1 requires price to travel twice as far *for*
you as against you, which the R:R sweep shows makes results monotonically worse.
A risk rule that is correct in general can be wrong for a specific signal.

**Reviewing open positions every 60 seconds caused churn, not risk management.**
Six of the first nine trades were closed by the model itself after ~90 seconds
for +0.31 bps gross, then charged the full round trip — 49% of the total loss,
from a feature added to help. An LLM asked "should you exit?" every minute
eventually says yes. Fixed with a minimum hold and an exit gate enforced in code,
because stating the rule in the prompt was ignored 27 times out of 34.

## Methods worth reusing

These are the parts that earned their keep, and a future attempt should plug into
them rather than rebuild:

- **Mirrored counterfactual (`edgeVsRandom`).** Every trade also runs the
  opposite side at the same instant with the same levels. A rising market makes
  any long look smart; this asks whether the *direction* beat a coin flip. It
  replaced an actual coin-flip control that duplicated the model's side about
  half the time and carried no information in those cases.
- **Ghost tracking for non-fills.** Unfilled maker entries are followed to their
  stop/target and recorded, so the adverse-selection bias in maker fills is
  visible instead of flattering the results.
- **Permutation tests and out-of-sample splits**
  ([`tools/rigorous_test.py`](../tools/rigorous_test.py)) — the difference
  between an edge and a lucky window.
- **Measure before building.** Strategy 8 was measured in about twenty minutes
  and returned -0.19 bps gross *before* a line of it was written. That turned
  what could have been weeks of work into an afternoon, and the same habit is why
  this document exists instead of a trading loss.

## What would have to change

Stated as falsifiable conditions rather than hopes. 1-minute scalping becomes
worth revisiting if **either**:

1. **The fee floor drops materially** — a VIP tier, fee rebate, or maker-only
   structure that puts the realistic round trip near 2 bps. The best measured
   configuration (+2.82 bps gross) would then be genuinely positive rather than
   3 bps short.
2. **The instrument changes** — a venue or symbol whose typical 1-minute move is
   several multiples of its spread. The test is one line of `horizon.py`: compare
   median move against round-trip cost, and only proceed if the ratio clearly
   exceeds 1.

Absent one of those, the honest expectation for any 1m strategy on these venues
is a loss roughly equal to the fees paid.

## Status

The DeepSeek loop is **stopped** (`llmEnabled: false`). The measurement rig —
breakout detection, the grading dossier, maker-fill simulation, counterfactual
scoring, the stats split by setup and break quality — is left fully intact and
working. It is a good instrument attached to a signal that does not exist.
Point it at a better question.
