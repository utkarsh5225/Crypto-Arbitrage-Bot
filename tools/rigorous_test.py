"""
Rigorous re-test of Strategy 1 (EMA 9/21 + RSI) and Strategy 4 (VWAP + Bollinger).
READ-ONLY: public Binance futures klines, no keys, no orders.

Fixes the weaknesses of the first pass:
  - long history (months, not days) instead of a single 3-day regime
  - period-stability check: the edge must persist across consecutive chunks
  - permutation test vs random entries with matched count/holds/sides
  - slippage charged ON TOP of fees (stops slip; assuming exact fills flatters)

Note on method: S1 and S4 have NO fitted parameters (EMA 9/21, RSI 40-60,
BB 20/2 are all fixed). Walk-forward *training* is therefore meaningless - there
is nothing to fit. For parameter-free rules the correct tests are out-of-period
stability and a permutation baseline, which is what this does.
"""
import json
import os
import random
import statistics
import time
import urllib.request

FUT = "https://fapi.binance.com/fapi/v1/klines"
CACHE = "/tmp/rig_cache"
TAKER_BPS = 5.0
SLIP_BPS = 1.0                                   # per side, on top of fees
ROUND_TRIP = 2 * TAKER_BPS + 2 * SLIP_BPS        # 12 bps
MAX_HOLD = 40
CHUNKS = 6
PERMS = 500


def fetch(symbol, interval, days):
    os.makedirs(CACHE, exist_ok=True)
    cf = f"{CACHE}/{symbol}_{interval}_{days}.json"
    if os.path.exists(cf):
        return json.load(open(cf))
    per_day = {"1m": 1440, "5m": 288, "15m": 96}[interval]
    want = days * per_day
    out, end = [], None
    while len(out) < want:
        u = f"{FUT}?symbol={symbol}&interval={interval}&limit=1500"
        if end:
            u += f"&endTime={end}"
        try:
            r = json.load(urllib.request.urlopen(u, timeout=30))
        except Exception:
            time.sleep(2); continue
        if not r:
            break
        out = r + out
        end = r[0][0] - 1
        if len(r) < 1500:
            break
    rows = out[-want:]
    bars = [{"t": int(x[0]), "o": float(x[1]), "h": float(x[2]),
             "l": float(x[3]), "c": float(x[4]), "v": float(x[5])} for x in rows]
    json.dump(bars, open(cf, "w"))
    return bars


def ema(v, n):
    k, o, p = 2 / (n + 1), [], None
    for x in v:
        p = x if p is None else x * k + p * (1 - k)
        o.append(p)
    return o


def rsi(v, n=14):
    out = [None] * len(v); ag = al = 0.0
    for i in range(1, len(v)):
        d = v[i] - v[i - 1]; g, l = max(d, 0.0), max(-d, 0.0)
        if i <= n:
            ag += g; al += l
            if i == n:
                ag /= n; al /= n
                out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
        else:
            ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n
            out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def bollinger(v, n=20, k=2.0):
    mid, up, lo = [], [], []
    for i in range(len(v)):
        if i < n - 1:
            mid.append(None); up.append(None); lo.append(None); continue
        w = v[i - n + 1:i + 1]
        m, sd = statistics.fmean(w), statistics.pstdev(w)
        mid.append(m); up.append(m + k * sd); lo.append(m - k * sd)
    return mid, up, lo


def session_vwap(bars):
    o, cpv, cv, day = [], 0.0, 0.0, None
    for b in bars:
        d = b["t"] // 86400000
        if d != day:
            day, cpv, cv = d, 0.0, 0.0
        tp = (b["h"] + b["l"] + b["c"]) / 3
        cpv += tp * b["v"]; cv += b["v"]
        o.append(cpv / cv if cv > 0 else b["c"])
    return o


def strat1(bars):
    c = [b["c"] for b in bars]
    e9, e21, r = ema(c, 9), ema(c, 21), rsi(c, 14)
    s = []
    for i in range(25, len(bars) - 1):
        if r[i] is None or not (40 <= r[i] <= 60):
            continue
        if e9[i] > e21[i] and e9[i - 1] <= e21[i - 1]:
            s.append((i, "long", min(b["l"] for b in bars[i - 10:i + 1])))
        elif e9[i] < e21[i] and e9[i - 1] >= e21[i - 1]:
            s.append((i, "short", max(b["h"] for b in bars[i - 10:i + 1])))
    return s


def strat4(bars):
    c = [b["c"] for b in bars]
    _, up, lo = bollinger(c, 20, 2.0)
    vw = session_vwap(bars)
    s = []
    for i in range(25, len(bars) - 1):
        if up[i] is None:
            continue
        if bars[i]["l"] <= lo[i] and c[i] < vw[i] and c[i] > bars[i]["o"]:
            s.append((i, "long", bars[i]["l"] * 0.9995))
        elif bars[i]["h"] >= up[i] and c[i] > vw[i] and c[i] < bars[i]["o"]:
            s.append((i, "short", bars[i]["h"] * 1.0005))
        elif (c[i] > vw[i] and bars[i]["l"] <= vw[i] and c[i] > bars[i]["o"]
              and c[i - 5] > vw[i - 5]):
            s.append((i, "long", min(bars[i]["l"], vw[i]) * 0.9995))
        elif (c[i] < vw[i] and bars[i]["h"] >= vw[i] and c[i] < bars[i]["o"]
              and c[i - 5] < vw[i - 5]):
            s.append((i, "short", max(bars[i]["h"], vw[i]) * 1.0005))
    return s


def simulate(bars, signals, rr=2.0, lo_i=0, hi_i=None):
    hi_i = len(bars) if hi_i is None else hi_i
    trades, last = [], lo_i - 1
    for i, side, stop in signals:
        if i < lo_i or i >= hi_i - 1 or i <= last:
            continue
        entry = bars[i + 1]["o"]
        risk = (entry - stop) if side == "long" else (stop - entry)
        if risk <= 0:
            continue
        tgt = entry + rr * risk if side == "long" else entry - rr * risk
        out, px, j = None, None, i + 1
        for j in range(i + 1, min(i + 1 + MAX_HOLD, hi_i)):
            h, l = bars[j]["h"], bars[j]["l"]
            if side == "long":
                if l <= stop: out, px = "loss", stop; break
                if h >= tgt: out, px = "win", tgt; break
            else:
                if h >= stop: out, px = "loss", stop; break
                if l <= tgt: out, px = "win", tgt; break
        if out is None:
            j = min(i + MAX_HOLD, hi_i - 1); out, px = "timeout", bars[j]["c"]
        g = ((px - entry) / entry if side == "long" else (entry - px) / entry) * 1e4
        trades.append({"g": g, "n": g - ROUND_TRIP, "hold": j - i,
                       "side": side, "out": out})
        last = j
    return trades


def permutation(bars, trades, n=PERMS, seed=11):
    """Random entries, matched trade count / holds / side mix."""
    if len(trades) < 10:
        return None
    rng = random.Random(seed)
    holds = [max(1, t["hold"]) for t in trades]
    sides = [t["side"] for t in trades]
    res = []
    for _ in range(n):
        tot = 0.0
        for h, sd in zip(holds, sides):
            if len(bars) - h - 3 <= 30:
                continue
            i = rng.randrange(25, len(bars) - h - 3)
            e = bars[i + 1]["o"]; x = bars[i + 1 + h]["c"]
            g = ((x - e) / e if sd == "long" else (e - x) / e) * 1e4
            tot += g
        res.append(tot / max(1, len(holds)))
    return res


STRATS = [("S1 EMA9/21+RSI", strat1), ("S4 VWAP+Bollinger", strat4)]
JOBS = [("BTCUSDT", "1m", 60), ("ETHUSDT", "1m", 60),
        ("BTCUSDT", "5m", 365), ("ETHUSDT", "5m", 365)]

print("RIGOROUS RE-TEST — long history, period stability, permutation, slippage")
print(f"Cost: {TAKER_BPS}bps taker x2 + {SLIP_BPS}bps slippage x2 = "
      f"{ROUND_TRIP:.0f} bps round trip\n")

for sym, tf, days in JOBS:
    bars = fetch(sym, tf, days)
    span = (bars[-1]["t"] - bars[0]["t"]) / 86400000
    print(f"===== {sym} {tf} — {len(bars):,} bars, {span:.0f} days =====")
    for name, fn in STRATS:
        sig = fn(bars)
        tr = simulate(bars, sig)
        if len(tr) < 10:
            print(f"  {name}: only {len(tr)} trades — skipped"); continue
        g = statistics.fmean([t["g"] for t in tr])
        n = statistics.fmean([t["n"] for t in tr])
        wr = sum(1 for t in tr if t["out"] == "win") / len(tr) * 100
        print(f"  {name}: {len(tr):,} trades | win {wr:.1f}% | "
              f"GROSS {g:+.2f} bps | NET {n:+.2f} bps | total {sum(t['n'] for t in tr)/100:+.1f}%")

        # period stability - does the edge persist across consecutive chunks?
        step = len(bars) // CHUNKS
        chunk_g = []
        for ci in range(CHUNKS):
            ct = simulate(bars, sig, lo_i=ci * step, hi_i=(ci + 1) * step)
            chunk_g.append(statistics.fmean([t["g"] for t in ct]) if len(ct) >= 5 else None)
        shown = " ".join(f"{x:+.1f}" if x is not None else "  --" for x in chunk_g)
        pos = sum(1 for x in chunk_g if x is not None and x > 0)
        tot = sum(1 for x in chunk_g if x is not None)
        print(f"      gross by period : {shown}   (positive in {pos}/{tot})")

        # permutation baseline
        perm = permutation(bars, tr)
        if perm:
            better = sum(1 for p in perm if p >= g)
            pct = 100 * (1 - better / len(perm))
            print(f"      vs {len(perm)} random-entry runs: median {statistics.median(perm):+.2f} bps"
                  f" | strategy beats {pct:.1f}%"
                  + ("  <-- NOISE" if pct < 95 else "  <-- beats noise"))
    print()

print(f"A signal must show GROSS > {ROUND_TRIP:.0f} bps to be tradeable.")
print("A real edge should also be positive in MOST periods and beat >95% of")
print("random-entry runs. Sign-flipping across periods = noise.")
