"""
Test of "Combined Scalping Strategies" - Strategies 1, 3 and 4.
READ-ONLY: public Binance futures klines, no keys, no orders.

  S1  9/21 EMA crossover + RSI(14) filter 40-60, stop at swing low/high, 1:2 R:R
  S3  Heikin-Ashi flat-bottom/top + MACD(12,26,9) cross + StochRSI cross from
      oversold/overbought; exit when an opposing wick appears
  S4  VWAP + Bollinger(20,2): mean reversion to VWAP, and VWAP-bounce to band

Execution is always at the NEXT bar's open (no look-ahead). Stops are checked
before targets within a bar (pessimistic). Costs: USD-M futures taker 5 bps per
side = 10 bps round trip, charged on every trade.

The headline number is GROSS (pre-fee) edge: that isolates whether the signal
predicts anything at all, separately from whether it can pay the fee.
"""
import json
import os
import statistics
import urllib.request

FUT = "https://fapi.binance.com/fapi/v1/klines"
TAKER_BPS = 5.0
ROUND_TRIP = 2 * TAKER_BPS
SYMBOLS = os.environ.get("SYMBOLS", "BTCUSDT,ETHUSDT,SOLUSDT").split(",")
TFS = os.environ.get("TFS", "1m,5m").split(",")
BARS = int(os.environ.get("BARS", "4500"))
MAX_HOLD = 40


def fetch(symbol, interval, n=BARS):
    out, end = [], None
    while len(out) < n:
        u = f"{FUT}?symbol={symbol}&interval={interval}&limit=1500"
        if end:
            u += f"&endTime={end}"
        r = json.load(urllib.request.urlopen(u, timeout=30))
        if not r:
            break
        out = r + out
        end = r[0][0] - 1
        if len(r) < 1500:
            break
    rows = out[-n:]
    return [{"t": int(x[0]), "o": float(x[1]), "h": float(x[2]),
             "l": float(x[3]), "c": float(x[4]), "v": float(x[5])} for x in rows]


# ---------------------------------------------------------------- indicators
def ema(v, n):
    k, out, p = 2 / (n + 1), [], None
    for x in v:
        p = x if p is None else x * k + p * (1 - k)
        out.append(p)
    return out


def rsi(v, n=14):
    out = [None] * len(v)
    ag = al = 0.0
    for i in range(1, len(v)):
        d = v[i] - v[i - 1]
        g, l = max(d, 0.0), max(-d, 0.0)
        if i <= n:
            ag += g; al += l
            if i == n:
                ag /= n; al /= n
                out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
        else:
            ag = (ag * (n - 1) + g) / n
            al = (al * (n - 1) + l) / n
            out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def macd(v, f=12, s=26, sig=9):
    ef, es = ema(v, f), ema(v, s)
    line = [a - b for a, b in zip(ef, es)]
    signal = ema(line, sig)
    return line, signal, [a - b for a, b in zip(line, signal)]


def stoch_rsi(v, rn=14, sn=14, k=3, d=3):
    r = rsi(v, rn)
    raw = []
    for i in range(len(r)):
        w = [x for x in r[max(0, i - sn + 1):i + 1] if x is not None]
        if len(w) < sn or r[i] is None or max(w) == min(w):
            raw.append(None)
        else:
            raw.append((r[i] - min(w)) / (max(w) - min(w)) * 100)
    def smooth(a, n):
        o = []
        for i in range(len(a)):
            w = [x for x in a[max(0, i - n + 1):i + 1] if x is not None]
            o.append(statistics.fmean(w) if len(w) == n else None)
        return o
    K = smooth(raw, k)
    return K, smooth(K, d)


def bollinger(v, n=20, k=2.0):
    mid, up, lo = [], [], []
    for i in range(len(v)):
        if i < n - 1:
            mid.append(None); up.append(None); lo.append(None); continue
        w = v[i - n + 1:i + 1]
        m, sd = statistics.fmean(w), statistics.pstdev(w)
        mid.append(m); up.append(m + k * sd); lo.append(m - k * sd)
    return mid, up, lo


def heikin_ashi(bars):
    ha = []
    for i, b in enumerate(bars):
        hc = (b["o"] + b["h"] + b["l"] + b["c"]) / 4
        ho = (bars[0]["o"] + bars[0]["c"]) / 2 if i == 0 else (ha[-1]["o"] + ha[-1]["c"]) / 2
        ha.append({"o": ho, "c": hc,
                   "h": max(b["h"], ho, hc), "l": min(b["l"], ho, hc)})
    return ha


def session_vwap(bars):
    out, cpv, cv, day = [], 0.0, 0.0, None
    for b in bars:
        d = b["t"] // 86400000
        if d != day:
            day, cpv, cv = d, 0.0, 0.0
        tp = (b["h"] + b["l"] + b["c"]) / 3
        cpv += tp * b["v"]; cv += b["v"]
        out.append(cpv / cv if cv > 0 else b["c"])
    return out


# ---------------------------------------------------------------- simulator
def simulate(bars, signals, rr=2.0):
    """signals: list of (i, side, stop_price). Enter at bars[i+1] open."""
    trades = []
    last_exit = -1
    for i, side, stop in signals:
        if i <= last_exit or i + 1 >= len(bars):
            continue
        entry = bars[i + 1]["o"]
        risk = (entry - stop) if side == "long" else (stop - entry)
        if risk <= 0:
            continue
        target = entry + rr * risk if side == "long" else entry - rr * risk
        outcome, px = None, None
        for j in range(i + 1, min(i + 1 + MAX_HOLD, len(bars))):
            hi, lo = bars[j]["h"], bars[j]["l"]
            if side == "long":
                if lo <= stop: outcome, px = "loss", stop; break
                if hi >= target: outcome, px = "win", target; break
            else:
                if hi >= stop: outcome, px = "loss", stop; break
                if lo <= target: outcome, px = "win", target; break
            last_j = j
        if outcome is None:
            j = min(i + MAX_HOLD, len(bars) - 1)
            outcome, px = "timeout", bars[j]["c"]
        gross = ((px - entry) / entry if side == "long" else (entry - px) / entry) * 1e4
        trades.append({"gross": gross, "net": gross - ROUND_TRIP,
                       "risk": risk / entry * 1e4, "outcome": outcome})
        last_exit = j
    return trades


# ---------------------------------------------------------------- strategies
def strat1(bars):
    """9/21 EMA cross + RSI 40-60 filter. Stop = 10-bar swing low/high."""
    c = [b["c"] for b in bars]
    e9, e21, r = ema(c, 9), ema(c, 21), rsi(c, 14)
    sig = []
    for i in range(25, len(bars) - 1):
        if r[i] is None or not (40 <= r[i] <= 60):
            continue
        up = e9[i] > e21[i] and e9[i - 1] <= e21[i - 1]
        dn = e9[i] < e21[i] and e9[i - 1] >= e21[i - 1]
        if up:
            sig.append((i, "long", min(b["l"] for b in bars[i - 10:i + 1])))
        elif dn:
            sig.append((i, "short", max(b["h"] for b in bars[i - 10:i + 1])))
    return sig


def strat3(bars):
    """Heikin-Ashi flat-bottom/top + MACD cross + StochRSI from extreme."""
    c = [b["c"] for b in bars]
    ha = heikin_ashi(bars)
    _, _, hist = macd(c)
    K, D = stoch_rsi(c)
    sig = []
    for i in range(40, len(bars) - 1):
        if K[i] is None or D[i] is None or K[i - 1] is None:
            continue
        body = abs(ha[i]["c"] - ha[i]["o"]) or 1e-12
        lower_w = min(ha[i]["o"], ha[i]["c"]) - ha[i]["l"]
        upper_w = ha[i]["h"] - max(ha[i]["o"], ha[i]["c"])
        green = ha[i]["c"] > ha[i]["o"]
        red = ha[i]["c"] < ha[i]["o"]
        macd_up = hist[i] > 0 and hist[i - 1] <= 0
        macd_dn = hist[i] < 0 and hist[i - 1] >= 0
        st_up = K[i] > D[i] and K[i - 1] <= D[i - 1] and K[i - 1] < 20
        st_dn = K[i] < D[i] and K[i - 1] >= D[i - 1] and K[i - 1] > 80
        if green and lower_w <= 0.1 * body and macd_up and st_up:
            sig.append((i, "long", min(b["l"] for b in bars[i - 5:i + 1])))
        elif red and upper_w <= 0.1 * body and macd_dn and st_dn:
            sig.append((i, "short", max(b["h"] for b in bars[i - 5:i + 1])))
    return sig


def strat4(bars):
    """VWAP + Bollinger: mean reversion to VWAP, and VWAP bounce to band."""
    c = [b["c"] for b in bars]
    mid, up, lo = bollinger(c, 20, 2.0)
    vw = session_vwap(bars)
    sig = []
    for i in range(25, len(bars) - 1):
        if up[i] is None:
            continue
        # mean reversion: pierce band while on the far side of VWAP
        if bars[i]["l"] <= lo[i] and c[i] < vw[i] and c[i] > bars[i]["o"]:
            sig.append((i, "long", bars[i]["l"] * 0.9995))
        elif bars[i]["h"] >= up[i] and c[i] > vw[i] and c[i] < bars[i]["o"]:
            sig.append((i, "short", bars[i]["h"] * 1.0005))
        # VWAP bounce: pullback touches VWAP in an established trend
        elif (c[i] > vw[i] and bars[i]["l"] <= vw[i] and c[i] > bars[i]["o"]
              and c[i - 5] > vw[i - 5]):
            sig.append((i, "long", min(bars[i]["l"], vw[i]) * 0.9995))
        elif (c[i] < vw[i] and bars[i]["h"] >= vw[i] and c[i] < bars[i]["o"]
              and c[i - 5] < vw[i - 5]):
            sig.append((i, "short", max(bars[i]["h"], vw[i]) * 1.0005))
    return sig


STRATS = [("S1 EMA 9/21 + RSI", strat1),
          ("S3 HeikinAshi+MACD+StochRSI", strat3),
          ("S4 VWAP + Bollinger", strat4)]

print("Combined Scalping Strategies 1, 3, 4 — as documented")
print(f"Costs: {TAKER_BPS} bps taker/side = {ROUND_TRIP:.0f} bps round trip, "
      f"1:2 R:R, max hold {MAX_HOLD} bars\n")

summary = []
for tf in TFS:
    for sym in SYMBOLS:
        sym = sym.strip()
        try:
            bars = fetch(sym, tf.strip())
        except Exception as e:
            print(f"{sym} {tf}: fetch failed {e}"); continue
        print(f"--- {sym} {tf} ({len(bars)} bars) ---")
        print(f"{'strategy':<30}{'trades':>7}{'win%':>7}{'medR':>7}"
              f"{'GROSS':>9}{'NET':>9}{'total%':>9}")
        for name, fn in STRATS:
            t = simulate(bars, fn(bars))
            if not t:
                print(f"{name:<30}{0:>7}"); continue
            w = sum(1 for x in t if x["outcome"] == "win") / len(t) * 100
            g = statistics.fmean([x["gross"] for x in t])
            n = statistics.fmean([x["net"] for x in t])
            mr = statistics.median([x["risk"] for x in t])
            tot = sum(x["net"] for x in t) / 100
            summary.append({"s": name, "tf": tf, "sym": sym, "g": g, "n": n, "N": len(t)})
            print(f"{name:<30}{len(t):>7}{w:>6.1f}%{mr:>7.1f}"
                  f"{g:>9.2f}{n:>9.2f}{tot:>8.2f}%")
        print()

print("GROSS = avg per-trade bps BEFORE fees (does the signal predict anything?)")
print("NET   = after 10 bps round trip\n")
print("=== VERDICT ===")
for name, _ in STRATS:
    rows = [r for r in summary if r["s"] == name]
    if not rows:
        continue
    gm = statistics.fmean([r["g"] for r in rows])
    nm = statistics.fmean([r["n"] for r in rows])
    posg = sum(1 for r in rows if r["g"] > 0)
    posn = sum(1 for r in rows if r["n"] > 0)
    print(f"{name:<30} avg GROSS {gm:+6.2f} bps | avg NET {nm:+6.2f} bps | "
          f"gross>0 in {posg}/{len(rows)} | net>0 in {posn}/{len(rows)}")
print(f"\nA signal needs GROSS > {ROUND_TRIP:.0f} bps to be tradeable at all.")
