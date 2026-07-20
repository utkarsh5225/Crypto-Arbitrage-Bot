"""Do 1-minute breakouts/breakdowns have directional edge after retail fees?

Run before the breakout filter was built (2026-07-20). Result, 4541 breaks
across 8 majors, lookback 20, hold 10 bars, cost 10 bps taker round trip:

    all breaks                  4541    -0.19 gross    -10.19 net
    strong break (>10% range)   2384    -0.79          -10.79
    volume surge >2x            1671    -1.73          -11.73
    strong break + volume       1182    -1.92          -11.92

Following a break is a coin flip (median 0.00); fading it is too (+0.19).
The textbook confirmation filters make it WORSE, consistent with the most
convincing setups being the most crowded. The breakout filter in the bot is
therefore an instrument for isolating and scoring breakout trades — not a
strategy with measured edge.
"""
import json, urllib.request, statistics as st, time

COST = 10.0
SYMS = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT","ADAUSDT","LINKUSDT"]
LOOKBACK = 20
HOLD = 10
PAGES = 5  # 5 x 1000 bars of 1m per symbol ~ 3.5 days each


def kl(sym, iv, end=None, n=1000):
    u = "https://fapi.binance.com/fapi/v1/klines?symbol=%s&interval=%s&limit=%d" % (sym, iv, n)
    if end:
        u += "&endTime=%d" % end
    return json.load(urllib.request.urlopen(u, timeout=25))


def history(sym, iv, pages):
    out, end = [], None
    for _ in range(pages):
        try:
            b = kl(sym, iv, end)
        except Exception:
            break
        if not b:
            break
        out = b + out
        end = int(b[0][0]) - 1
        time.sleep(0.12)
    return out


def main():
    buckets = {}

    def add(name, x):
        buckets.setdefault(name, []).append(x)

    span = 0
    for s in SYMS:
        bars = history(s, "1m", PAGES)
        if len(bars) < 200:
            continue
        span += len(bars)
        h = [float(b[2]) for b in bars]
        l = [float(b[3]) for b in bars]
        c = [float(b[4]) for b in bars]
        v = [float(b[5]) for b in bars]
        for i in range(LOOKBACK, len(c) - HOLD - 1):
            hh = max(h[i - LOOKBACK:i]); ll = min(l[i - LOOKBACK:i])
            rng = hh - ll
            if rng <= 0:
                continue
            sig = 1 if c[i] > hh else (-1 if c[i] < ll else 0)
            if not sig:
                continue
            fwd = ((c[i + HOLD] - c[i]) / c[i]) * 1e4 * sig
            margin = (c[i] - hh) / rng if sig > 0 else (ll - c[i]) / rng
            vavg = sum(v[i - LOOKBACK:i]) / LOOKBACK
            vs = v[i] / vavg if vavg > 0 else 0
            add("all breaks", fwd)
            add("strong break (>10% of range)" if margin > 0.10 else "marginal break", fwd)
            add("volume surge >2x" if vs > 2 else "no volume surge", fwd)
            if margin > 0.10 and vs > 2:
                add("strong break + volume", fwd)

    print("sample: %d 1m bars, %d symbols; hold %d, lookback %d, cost %.0f bps" % (
        span, len(SYMS), HOLD, LOOKBACK, COST))
    print("%-32s %7s %9s %9s %9s" % ("filter", "n", "avgDir", "medDir", "netFollow"))
    for k in ["all breaks", "strong break (>10% of range)", "marginal break",
              "volume surge >2x", "no volume surge", "strong break + volume"]:
        d = buckets.get(k)
        if not d:
            continue
        a = sum(d) / len(d)
        print("%-32s %7d %9.2f %9.2f %9.2f" % (k, len(d), a, st.median(d), a - COST))
    d = buckets.get("all breaks", [])
    if d:
        a = sum(d) / len(d)
        print("\nFOLLOW: %+6.2f gross -> %+6.2f net   FADE: %+6.2f gross -> %+6.2f net" % (
            a, a - COST, -a, -a - COST))


if __name__ == "__main__":
    main()
