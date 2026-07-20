"""
Phase 2 - adverse selection / markout analysis (READ-ONLY, no keys, no orders).

Phase 1 showed pairs whose spread beats the maker fee. That says nothing about
whether you KEEP the spread. A resting bid fills precisely when sellers are
hitting it - i.e. when price is coming down - so the question is where price is
a few seconds AFTER your fill.

Method (standard markout):
  At each sample i, assume a resting bid at the then-best bid B_i.
  Treat it as FILLED if the mid trades down to <= B_i within the next h seconds.
  Markout = (mid_{i+h} - B_i) / mid_i, in bps.

Markout is measured against the mid, so it ALREADY includes the half-spread you
earned by buying below mid. Therefore:
    markout > 0  -> you were paid to provide liquidity
    markout < 0  -> adverse selection more than ate the spread
Subtract the one-side maker fee (~10 bps retail, ~7.5 with BNB) for the net.

Symmetric logic for a resting ask.
"""
import json
import os
import time
import urllib.request
from statistics import median, mean

SAMPLE_SECONDS = int(os.environ.get("SAMPLE_SECONDS", "600"))
INTERVAL = 1.0
HORIZONS = [5, 15, 60]        # seconds after the fill
MAKER_BPS = 10.0
MAKER_BPS_BNB = 7.5
MIN_TRADES = 5000
MIN_SPREAD_BPS = 15.0
MIN_TOP_USD = 20.0

def get(url):
    return json.load(urllib.request.urlopen(url, timeout=30))

info = get("https://api.binance.com/api/v3/exchangeInfo")
usdt = {s["symbol"] for s in info["symbols"]
        if s["status"] == "TRADING" and s["quoteAsset"] == "USDT"}

act = {r["symbol"]: int(r.get("count") or 0)
       for r in get("https://api.binance.com/api/v3/ticker/24hr")
       if r["symbol"] in usdt}

# Seed candidates from one snapshot: active enough + spread beats the fee.
seed = get("https://api.binance.com/api/v3/ticker/bookTicker")
cands = []
for r in seed:
    s = r["symbol"]
    if s not in usdt or act.get(s, 0) < MIN_TRADES:
        continue
    bid, ask = float(r["bidPrice"]), float(r["askPrice"])
    bq, aq = float(r["bidQty"]), float(r["askQty"])
    if bid <= 0 or ask <= 0 or ask < bid:
        continue
    mid = (bid + ask) / 2
    sp = (ask - bid) / mid * 1e4
    if sp >= MIN_SPREAD_BPS and min(bid * bq, ask * aq) >= MIN_TOP_USD:
        cands.append(s)
cands = set(cands)
print(f"candidates (>= {MIN_TRADES:,} trades/24h, >= {MIN_SPREAD_BPS} bps, "
      f">= ${MIN_TOP_USD} top): {len(cands)}")

bids = {s: [] for s in cands}
asks = {s: [] for s in cands}
mids = {s: [] for s in cands}

deadline = time.time() + SAMPLE_SECONDS
n = 0
while time.time() < deadline:
    t0 = time.time()
    try:
        rows = get("https://api.binance.com/api/v3/ticker/bookTicker")
    except Exception:
        time.sleep(INTERVAL); continue
    n += 1
    for r in rows:
        s = r["symbol"]
        if s not in cands:
            continue
        b, a = float(r["bidPrice"]), float(r["askPrice"])
        if b <= 0 or a <= 0 or a < b:
            b = a = 0.0
        bids[s].append(b); asks[s].append(a)
        mids[s].append((a + b) / 2 if b > 0 else 0.0)
    time.sleep(max(0, INTERVAL - (time.time() - t0)))

print(f"samples: {n} at ~{INTERVAL}s -> {n*INTERVAL/60:.1f} min\n")

def markouts(s, h):
    B, A, M = bids[s], asks[s], mids[s]
    bid_mk, ask_mk = [], []
    for i in range(len(M) - h):
        m0 = M[i]
        if m0 <= 0 or B[i] <= 0:
            continue
        win = [x for x in M[i+1:i+h+1] if x > 0]
        if len(win) < h // 2:
            continue
        mE = M[i+h]
        if mE <= 0:
            continue
        if min(win) <= B[i]:                       # resting bid would fill
            bid_mk.append((mE - B[i]) / m0 * 1e4)
        if max(win) >= A[i]:                       # resting ask would fill
            ask_mk.append((A[i] - mE) / m0 * 1e4)
    return bid_mk, ask_mk

results = []
for s in sorted(cands):
    M, B, A = mids[s], bids[s], asks[s]
    sp = [ (A[i]-B[i])/M[i]*1e4 for i in range(len(M)) if M[i] > 0 and B[i] > 0 ]
    if len(sp) < n // 2:
        continue
    row = {"sym": s, "spread": median(sp), "half": median(sp)/2, "trades": act.get(s, 0)}
    for h in HORIZONS:
        bmk, amk = markouts(s, h)
        allmk = bmk + amk
        row[f"n{h}"] = len(allmk)
        row[f"mk{h}"] = mean(allmk) if allmk else None
        row[f"md{h}"] = median(allmk) if allmk else None
    results.append(row)

results.sort(key=lambda r: -(r.get("mk15") if r.get("mk15") is not None else -1e9))

print("Markout = value captured per fill, measured vs mid (half-spread INCLUDED).")
print("Positive = paid to provide liquidity. Subtract ~10 bps maker fee for net.\n")
hdr = f"{'SYMBOL':<14}{'spread':>8}{'half':>7}"
for h in HORIZONS:
    hdr += f"{'mk'+str(h)+'s':>9}{'n':>7}"
print(hdr)
for r in results[:25]:
    line = f"{r['sym']:<14}{r['spread']:>8.1f}{r['half']:>7.1f}"
    for h in HORIZONS:
        mk = r.get(f"mk{h}")
        line += (f"{mk:>9.1f}" if mk is not None else f"{'--':>9}") + f"{r.get('n'+str(h),0):>7}"
    print(line)

print("\n=== VERDICT ===")
for h in HORIZONS:
    vals = [r[f"mk{h}"] for r in results if r.get(f"mk{h}") is not None]
    if not vals:
        continue
    pos = [v for v in vals if v > 0]
    beats = [v for v in vals if v > MAKER_BPS]
    beats_bnb = [v for v in vals if v > MAKER_BPS_BNB]
    print(f"horizon {h:>2}s : pairs={len(vals):<4} "
          f"mean markout={mean(vals):+7.2f} bps   "
          f"positive={len(pos):<4} >{MAKER_BPS:g}bps={len(beats):<4} "
          f">{MAKER_BPS_BNB:g}bps={len(beats_bnb)}")
