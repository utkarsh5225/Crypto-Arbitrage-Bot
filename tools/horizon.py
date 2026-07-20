"""How big is the typical move at each horizon, versus the 10 bps round-trip toll?

The bot trades a 1m cadence. If the median move over its holding period is
smaller than the fee, no amount of directional skill can win: you would have to
be right by MORE than the toll, nearly every time.
"""
import json, urllib.request, statistics as st

COST = 10.0
SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"]


def kl(sym, iv, n=500):
    u = f"https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit={n}"
    return json.load(urllib.request.urlopen(u, timeout=20))


print(f"{'horizon':>8} {'medMove':>9} {'p75':>8} {'p90':>8} {'med/cost':>9} {'pct>cost':>9}")
print("-" * 58)
for iv in ["1m", "5m", "15m", "1h", "4h"]:
    allm = []
    for s in SYMS:
        try:
            bars = kl(s, iv)
        except Exception:
            continue
        # open-to-close move in bps: what a perfectly-timed entry could capture
        for b in bars:
            o = float(b[1]); c = float(b[4])
            if o > 0:
                allm.append(abs((c - o) / o) * 1e4)
    if not allm:
        continue
    allm.sort()
    med = st.median(allm)
    p75 = allm[int(len(allm) * 0.75)]
    p90 = allm[int(len(allm) * 0.90)]
    over = 100 * sum(1 for m in allm if m > COST) / len(allm)
    print(f"{iv:>8} {med:9.1f} {p75:8.1f} {p90:8.1f} {med / COST:9.2f} {over:8.0f}%")

print()
print("med/cost < 1 means the typical move does not even cover the fee.")
print("Note this is PERFECT timing - the real ceiling is well below it.")
