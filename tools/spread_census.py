"""
Phase 1 — spread census for market-making viability (READ-ONLY, no keys).

Market making earns the spread but pays MAKER fees on both sides. A pair is only
viable if:      average spread  >  2 x maker fee

Binance spot retail maker ~0.10% (10 bps), ~0.075% (7.5 bps) with BNB, so the
round-trip cost is ~20 bps (~15 bps with BNB).

Samples GET /api/v3/ticker/bookTicker (ALL symbols in ONE call, so each sample is
a single instant - this avoids the staleness artifact that produced every phantom
in the arbitrage work). Also pulls 24h stats once, because a wide spread on a
pair nobody trades is unfillable: you would post a quote and never get hit.
"""
import json
import time
import urllib.request
from statistics import median

SAMPLE_SECONDS = int(__import__("os").environ.get("SAMPLE_SECONDS", "900"))
INTERVAL = 5
MAKER_BPS = 10.0            # retail maker, one side
MAKER_BPS_BNB = 7.5         # with BNB discount, one side
ROUNDTRIP_BPS = 2 * MAKER_BPS        # 20
ROUNDTRIP_BPS_BNB = 2 * MAKER_BPS_BNB  # 15
QUOTE = "USDT"              # user holds USDT

def get(url):
    return json.load(urllib.request.urlopen(url, timeout=30))

info = get("https://api.binance.com/api/v3/exchangeInfo")
tradable = {s["symbol"]: (s["baseAsset"], s["quoteAsset"])
            for s in info["symbols"] if s["status"] == "TRADING"}
usdt_syms = {s for s, (b, q) in tradable.items() if q == QUOTE}
print(f"TRADING symbols: {len(tradable)}   {QUOTE}-quoted: {len(usdt_syms)}")

spreads = {}   # symbol -> [bps, ...]
sizes = {}     # symbol -> [min(bid,ask) notional in USDT, ...]
stamps = []

deadline = time.time() + SAMPLE_SECONDS
n = 0
while time.time() < deadline:
    t0 = time.time()
    try:
        rows = get("https://api.binance.com/api/v3/ticker/bookTicker")
    except Exception as e:
        print("sample failed:", e)
        time.sleep(INTERVAL)
        continue
    stamps.append(t0)
    n += 1
    for r in rows:
        sym = r["symbol"]
        if sym not in usdt_syms:
            continue
        try:
            bid, ask = float(r["bidPrice"]), float(r["askPrice"])
            bq, aq = float(r["bidQty"]), float(r["askQty"])
        except (TypeError, ValueError):
            continue
        if bid <= 0 or ask <= 0 or ask < bid:
            continue
        mid = (bid + ask) / 2
        spreads.setdefault(sym, []).append((ask - bid) / mid * 10_000)
        sizes.setdefault(sym, []).append(min(bid * bq, ask * aq))
    time.sleep(max(0, INTERVAL - (time.time() - t0)))

dur = (stamps[-1] - stamps[0]) if len(stamps) > 1 else 0
print(f"samples: {n} over {dur/60:.1f} min "
      f"(interval ~{dur/max(n-1,1):.1f}s)\n")

# One-shot activity check: a wide spread nobody trades is unfillable.
act = {}
for r in get("https://api.binance.com/api/v3/ticker/24hr"):
    if r["symbol"] in usdt_syms:
        act[r["symbol"]] = (int(r.get("count") or 0), float(r.get("quoteVolume") or 0))

rows = []
for sym, sp in spreads.items():
    if len(sp) < max(3, n // 2):     # require decent coverage
        continue
    sp_sorted = sorted(sp)
    med = median(sp_sorted)
    viable = sum(1 for x in sp if x > ROUNDTRIP_BPS) / len(sp) * 100
    viable_bnb = sum(1 for x in sp if x > ROUNDTRIP_BPS_BNB) / len(sp) * 100
    trades, qvol = act.get(sym, (0, 0.0))
    rows.append({
        "sym": sym, "med": med,
        "p25": sp_sorted[len(sp_sorted)//4],
        "p75": sp_sorted[3*len(sp_sorted)//4],
        "viable": viable, "viable_bnb": viable_bnb,
        "size": median(sizes[sym]),
        "trades": trades, "qvol": qvol,
    })

rows.sort(key=lambda r: -r["med"])

print(f"=== Widest median spreads ({QUOTE} pairs) ===")
print(f"{'SYMBOL':<14}{'med_bps':>8}{'p25':>8}{'p75':>8}"
      f"{'%>20bps':>9}{'%>15bps':>9}{'top$':>10}{'trades/24h':>12}")
for r in rows[:20]:
    print(f"{r['sym']:<14}{r['med']:>8.1f}{r['p25']:>8.1f}{r['p75']:>8.1f}"
          f"{r['viable']:>8.0f}%{r['viable_bnb']:>8.0f}%"
          f"{r['size']:>10.0f}{r['trades']:>12,}")

print(f"\n=== Reference: most-traded {QUOTE} pairs ===")
for r in sorted(rows, key=lambda r: -r["trades"])[:8]:
    print(f"{r['sym']:<14}{r['med']:>8.1f} bps median spread   "
          f"{r['trades']:>12,} trades/24h   top${r['size']:,.0f}")

# Verdict: needs BOTH a spread wider than the fee AND enough flow to get filled.
MIN_TRADES = 5000     # ~3.5 trades/min average
MIN_SIZE = 20         # user's notional is $10
win = [r for r in rows
       if r["med"] > ROUNDTRIP_BPS and r["trades"] >= MIN_TRADES and r["size"] >= MIN_SIZE]
win_bnb = [r for r in rows
           if r["med"] > ROUNDTRIP_BPS_BNB and r["trades"] >= MIN_TRADES and r["size"] >= MIN_SIZE]

print(f"\n=== VERDICT ===")
print(f"{QUOTE} pairs analysed                                : {len(rows)}")
print(f"median spread > 20 bps (retail maker round trip) : "
      f"{sum(1 for r in rows if r['med'] > ROUNDTRIP_BPS)}")
print(f"  ...AND >= {MIN_TRADES:,} trades/24h AND >= ${MIN_SIZE} top-of-book : {len(win)}")
print(f"median spread > 15 bps (with BNB discount)       : "
      f"{sum(1 for r in rows if r['med'] > ROUNDTRIP_BPS_BNB)}")
print(f"  ...AND activity/size filters                  : {len(win_bnb)}")
if win_bnb:
    print("\nCandidates that clear spread AND activity AND size:")
    for r in sorted(win_bnb, key=lambda r: -r["med"])[:15]:
        net = r["med"] - ROUNDTRIP_BPS_BNB
        print(f"  {r['sym']:<14} med {r['med']:.1f} bps  net~{net:+.1f} bps/round-trip"
              f"  {r['trades']:,} trades/24h  top${r['size']:,.0f}")
else:
    print("\nNo pair clears spread + activity + size. Market making is not")
    print("viable at retail maker fees on this venue.")
