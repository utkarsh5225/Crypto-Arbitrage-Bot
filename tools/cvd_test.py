"""
Test of "Strategy 2 - Order Flow and CVD Arbitrage" (Binance Futures, 1m).
READ-ONLY: public endpoints, no keys, no orders.

Strategy as documented:
  - price pierces a liquidity level making a new local extreme
  - CVD fails to confirm (bearish: price higher high, CVD lower high; and mirror)
  - enter MARKET on the reversal bar
  - stop 1-2 ticks beyond the rejection wick ("extremely tight")
  - take profit at 1:2 R:R
  - claimed 60-70% win rate

CVD is computed exactly, not approximated: Binance klines expose
takerBuyBaseAssetVolume (field 9), so for each bar
    delta = takerBuyVol - (volume - takerBuyVol) = 2*takerBuyVol - volume
which is precisely (aggressive buys - aggressive sells). CVD = cumulative delta.

Costs: USD-M futures taker 5 bps per side (entry + exit = 10 bps), applied to
every trade. Entry is a market order per the document, and stop/target exits are
market orders too.
"""
import json
import os
import urllib.request

FUT = "https://fapi.binance.com/fapi/v1/klines"
TAKER_BPS = float(os.environ.get("TAKER_BPS", "5.0"))
ROUND_TRIP = 2 * TAKER_BPS
SYMBOLS = os.environ.get("SYMBOLS", "BTCUSDT,ETHUSDT,SOLUSDT").split(",")
BARS = int(os.environ.get("BARS", "4500"))
RR = 2.0                      # document: minimum 1:2 risk-reward
MAX_HOLD = 30                 # bars; a scalp that hasn't resolved is dead


def fetch(symbol, interval="1m", n=BARS):
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
    return out[-n:]


def build(rows):
    bars = []
    cvd = 0.0
    for r in rows:
        o, h, l, c = float(r[1]), float(r[2]), float(r[3]), float(r[4])
        vol, tbuy = float(r[5]), float(r[9])
        delta = 2 * tbuy - vol            # aggressive buys - aggressive sells
        cvd += delta
        bars.append({"o": o, "h": h, "l": l, "c": c, "delta": delta, "cvd": cvd})
    return bars


def run(bars, lookback, buffer_bps=1.0):
    """Divergence detection + simulation. Returns trade list."""
    trades = []
    i = lookback
    while i < len(bars) - 2:
        b = bars[i]
        win_h = [x["h"] for x in bars[i - lookback:i]]
        win_l = [x["l"] for x in bars[i - lookback:i]]
        win_cvd = [x["cvd"] for x in bars[i - lookback:i]]

        short = b["h"] > max(win_h) and b["cvd"] < max(win_cvd)   # price HH, CVD fails
        long_ = b["l"] < min(win_l) and b["cvd"] > min(win_cvd)   # price LL, CVD holds

        if not (short or long_):
            i += 1
            continue

        entry = bars[i + 1]["o"]
        buf = entry * buffer_bps / 1e4
        if short:
            stop = b["h"] + buf
            risk = stop - entry
            if risk <= 0:
                i += 1; continue
            target = entry - RR * risk
        else:
            stop = b["l"] - buf
            risk = entry - stop
            if risk <= 0:
                i += 1; continue
            target = entry + RR * risk

        outcome, exit_px = None, None
        for j in range(i + 1, min(i + 1 + MAX_HOLD, len(bars))):
            hi, lo = bars[j]["h"], bars[j]["l"]
            if short:
                if hi >= stop:            # stop checked first = pessimistic
                    outcome, exit_px = "loss", stop; break
                if lo <= target:
                    outcome, exit_px = "win", target; break
            else:
                if lo <= stop:
                    outcome, exit_px = "loss", stop; break
                if hi >= target:
                    outcome, exit_px = "win", target; break
        if outcome is None:
            outcome, exit_px = "timeout", bars[min(i + MAX_HOLD, len(bars) - 1)]["c"]

        gross = ((entry - exit_px) / entry if short else (exit_px - entry) / entry) * 1e4
        trades.append({
            "gross_bps": gross,
            "net_bps": gross - ROUND_TRIP,
            "risk_bps": risk / entry * 1e4,
            "outcome": outcome,
        })
        i += MAX_HOLD  # no overlapping positions
    return trades


print("Order Flow / CVD divergence strategy — as documented")
print(f"Costs: {TAKER_BPS} bps taker/side -> {ROUND_TRIP:.0f} bps round trip")
print(f"R:R {RR:.0f}:1, max hold {MAX_HOLD} bars, 1m bars, stop beyond wick\n")

for sym in SYMBOLS:
    sym = sym.strip()
    try:
        bars = build(fetch(sym))
    except Exception as e:
        print(f"{sym}: fetch failed {e}"); continue
    print(f"--- {sym}  ({len(bars)} 1m bars) ---")
    print(f"{'lookback':>9}{'trades':>8}{'win%':>7}{'medRisk':>9}"
          f"{'grossBps':>10}{'netBps':>9}{'total%':>9}")
    for lb in (10, 20, 30):
        t = run(bars, lb)
        if not t:
            print(f"{lb:>9}{0:>8}"); continue
        wins = sum(1 for x in t if x["outcome"] == "win")
        wr = wins / len(t) * 100
        g = sum(x["gross_bps"] for x in t) / len(t)
        n = sum(x["net_bps"] for x in t) / len(t)
        med_risk = sorted(x["risk_bps"] for x in t)[len(t) // 2]
        total = sum(x["net_bps"] for x in t) / 100
        print(f"{lb:>9}{len(t):>8}{wr:>6.1f}%{med_risk:>9.1f}"
              f"{g:>10.2f}{n:>9.2f}{total:>8.2f}%")
    print()

print("grossBps = avg per-trade result BEFORE fees; netBps = after 10 bps round trip")
print("medRisk  = median stop distance in bps (the document says 'extremely tight')")
print("\nBreak-even check: at the claimed 65% win rate and 1:2 R:R,")
print(f"EV = 0.65*(2R) - 0.35*R - {ROUND_TRIP:.0f} = 0.95R - {ROUND_TRIP:.0f} bps")
print(f"  -> requires stop R >= {ROUND_TRIP/0.95:.1f} bps just to break even.")
