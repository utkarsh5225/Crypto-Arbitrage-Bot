# Analysis tools

Read-only measurement scripts. None of them take API keys, and none of them
place orders — they read public Binance endpoints and print numbers.

Each was written to kill a specific idea before it got built. The headline
result is recorded here; the method is in each script's own docstring. The
consolidated write-up is [`docs/FINDINGS.md`](../docs/FINDINGS.md).

Run any of them with `python3 tools/<name>.py` (no arguments, no setup).

| Script | Measured | Result |
|---|---|---|
| `spread_census.py` | Spread vs maker fee across all spot pairs | Pairs whose spread beats the fee exist, but see `adverse_selection.py` |
| `adverse_selection.py` | Markout after a simulated passive fill | **-9.7 bps @5s** vs 10 bps maker fee — market making dead |
| `fourleg_test.py` | Do 4-leg arb paths beat 3-leg? | 194,876 paths from one snapshot, **0 profitable** |
| `funding_test.py` | Spot-perp cash-and-carry over 30d | **0 of 6 symbols** positive after a full cycle |
| `move_size.py` | Is the typical move bigger than the cost? | Break-even accuracy exceeds 100% at 1m — arithmetically dead |
| `horizon.py` | Median move by timeframe vs 7 bps cost | 1m **3.7 bps** → 4h **51.7 bps**; ratio only clears 1.0 at ~15m |
| `backtest.py` | General harness: costs, permutation, OOS on by default | Infrastructure — used by the strategy tests below |
| `cvd_test.py` | Order flow / CVD divergence (PDF strategy 2) | Gross edge **~±1 bps**; claimed 60-70% win rate not reproduced |
| `combined_test.py` | EMA+RSI, Heikin-Ashi+MACD, VWAP+Bollinger (PDF 1/3/4) | Gross edge **~±1 bps** across all three |
| `rigorous_test.py` | Re-test of S1 and S4 with permutation + period stability | No edge that persists across periods |
| `breakout_test.py` | 1m range breakouts, with the professional filter set | **-0.19 bps** gross; textbook filters made it *worse* |

## The pattern

Every script above ends the same way: a gross edge of roughly 0-3 bps against a
round-trip cost of 7-30 bps. The strategies did not fail on implementation
quality — they failed on arithmetic that no amount of tuning reaches.

Before building strategy number nine, run `horizon.py` against the intended
instrument and timeframe. If the median move is not a clear multiple of the
round-trip cost, the rest of the work is already decided.
