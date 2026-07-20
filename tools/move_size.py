"""
Move-size study: are short-horizon moves even big enough to scalp?  READ-ONLY.

The decisive question for scalping is not "which strategy" - it is whether the
price moves further than the cost of trading it. If the typical 1-minute move is
smaller than the round-trip cost, scalping that horizon is arithmetically dead
regardless of signal quality.

For a symmetric scalp capturing +/- m bps at cost c bps:
    EV = m*(2p - 1) - c        ->    break-even accuracy p = (1 + c/m) / 2
If c >= m, required accuracy is >= 100% : impossible, full stop.

Costs use USD-M FUTURES rates (taker ~5 bps/side) plus each symbol's MEASURED
live spread, rather than the pessimistic spot numbers used earlier.
"""
import json
import os
import statistics
import urllib.request

FUT = "https://fapi.binance.com"
TAKER_BPS = float(os.environ.get("FUT_TAKER_BPS", "5.0"))   # per side
SYMBOLS = os.environ.get(
    "SYMBOLS", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT").split(",")
INTERVALS = ["1m", "5m", "15m"]
BARS = 1500


def get(url):
    return json.load(urllib.request.urlopen(url, timeout=30))


def pct(sorted_vals, q):
    if not sorted_vals:
        return 0.0
    i = min(len(sorted_vals) - 1, max(0, int(q * len(sorted_vals))))
    return sorted_vals[i]


# Measured live spread per symbol (one call, all symbols)
spreads = {}
for r in get(f"{FUT}/fapi/v1/ticker/bookTicker"):
    s = r["symbol"]
    try:
        b, a = float(r["bidPrice"]), float(r["askPrice"])
    except (TypeError, ValueError):
        continue
    if b > 0 and a > 0:
        spreads[s] = (a - b) / ((a + b) / 2) * 1e4

print("Move-size study — USD-M perpetuals")
print(f"Fee assumption: {TAKER_BPS} bps taker per side "
      f"(round trip {2*TAKER_BPS:.0f} bps + spread)\n")

print(f"{'SYMBOL':<10}{'intv':>5}{'spread':>8}{'cost':>7}"
      f"{'medMove':>9}{'p75':>8}{'p90':>8}{'medRange':>10}{'%>cost':>8}{'needAcc':>9}")

rows = []
for sym in SYMBOLS:
    sym = sym.strip()
    sp = spreads.get(sym, 1.0)
    cost = 2 * TAKER_BPS + sp        # in + out taker, plus crossing the spread
    for iv in INTERVALS:
        try:
            k = get(f"{FUT}/fapi/v1/klines?symbol={sym}&interval={iv}&limit={BARS}")
        except Exception as e:
            print(f"{sym:<10}{iv:>5}  fetch failed: {e}")
            continue
        closes = [float(r[4]) for r in k]
        highs = [float(r[2]) for r in k]
        lows = [float(r[3]) for r in k]

        # realistic blind scalp: close-to-close absolute move
        moves = [abs(closes[i] / closes[i - 1] - 1) * 1e4
                 for i in range(1, len(closes)) if closes[i - 1] > 0]
        # perfect-timing ceiling: full high-low range of the bar
        rng = [(highs[i] - lows[i]) / closes[i] * 1e4
               for i in range(len(closes)) if closes[i] > 0]
        if not moves:
            continue
        ms = sorted(moves)
        med = statistics.median(ms)
        over = sum(1 for m in moves if m > cost) / len(moves) * 100
        need = (1 + cost / med) / 2 * 100 if med > 0 else float("inf")

        rows.append({"sym": sym, "iv": iv, "cost": cost, "med": med,
                     "need": need, "over": over})
        need_s = f"{need:.1f}%" if need <= 100 else "IMPOSSIBLE"
        print(f"{sym:<10}{iv:>5}{sp:>8.2f}{cost:>7.1f}"
              f"{med:>9.1f}{pct(ms,0.75):>8.1f}{pct(ms,0.90):>8.1f}"
              f"{statistics.median(sorted(rng)):>10.1f}{over:>7.0f}%{need_s:>9}")

print("\n  medMove  = median |close-to-close| move, bps  (what a blind scalp captures)")
print("  medRange = median bar high-low, bps           (PERFECT timing ceiling)")
print("  needAcc  = directional accuracy required to break even at that horizon")

print("\n=== VERDICT ===")
for iv in INTERVALS:
    sub = [r for r in rows if r["iv"] == iv]
    if not sub:
        continue
    poss = [r for r in sub if r["need"] <= 100]
    best = min(sub, key=lambda r: r["need"])
    print(f"{iv:>4}: {len(poss)}/{len(sub)} symbols mathematically possible; "
          f"best = {best['sym']} needs {min(best['need'],999):.1f}% accuracy")
print("\nFor reference, published price-prediction results on public OHLCV")
print("typically reach 50-52% directional accuracy.")
