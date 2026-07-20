"""
Spot-perp funding (cash-and-carry) measurement.  READ-ONLY, no keys, no orders.

The trade: long spot + short perpetual = delta-neutral. You collect the funding
rate that perp longs pay shorts, settled every 8h.

Unlike the two strategies already measured to destruction, this is neither a
latency race (8h cycle) nor a prediction (funding is published in advance). So
it can be measured honestly from public history.

Costs charged for a FULL cycle (open both legs, close both legs):
    spot taker in + out  +  futures taker in + out
Verify current fee schedules - these change and may be stale.

What this does NOT model: liquidation of the futures leg, margin buffers, or
exchange minimum notionals. Those are the practical killers for a small account.
"""
import json
import os
import statistics
import time
import urllib.request

SPOT_TAKER_BPS = 10.0     # Binance spot taker, one side
FUT_TAKER_BPS = 5.0       # USD-M futures taker, one side
CYCLE_COST_BPS = 2 * SPOT_TAKER_BPS + 2 * FUT_TAKER_BPS   # open + close, both legs

SYMBOLS = os.environ.get(
    "SYMBOLS", "BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,XRPUSDT,BNBUSDT"
).split(",")
DAYS = int(os.environ.get("DAYS", "180"))


def get(url):
    for _ in range(3):
        try:
            return json.load(urllib.request.urlopen(url, timeout=30))
        except Exception:
            time.sleep(1)
    return None


def funding_history(symbol, days):
    """Paginate /fapi/v1/fundingRate back `days`. Returns [(ms, rate), ...]."""
    end = int(time.time() * 1000)
    start = end - days * 86400_000
    out, cursor = [], start
    while True:
        url = (f"https://fapi.binance.com/fapi/v1/fundingRate?symbol={symbol}"
               f"&startTime={cursor}&limit=1000")
        rows = get(url)
        if not rows:
            break
        out += [(int(r["fundingTime"]), float(r["fundingRate"])) for r in rows]
        if len(rows) < 1000:
            break
        nxt = rows[-1]["fundingTime"] + 1
        if nxt <= cursor:
            break
        cursor = nxt
    # dedupe + sort
    seen, clean = set(), []
    for t, r in sorted(out):
        if t not in seen and t >= start:
            seen.add(t); clean.append((t, r))
    return clean


def analyse(symbol, days):
    f = funding_history(symbol, days)
    if len(f) < 10:
        return None
    rates = [r for _, r in f]
    span_days = (f[-1][0] - f[0][0]) / 86400_000 or 1

    total = sum(rates)                       # fraction of notional collected
    per_day = total / span_days
    gross_apr = per_day * 365 * 100
    neg = sum(1 for r in rates if r < 0)

    # worst drawdown of the cumulative funding stream (how long/deep underwater)
    cum, peak, mdd = 0.0, 0.0, 0.0
    for r in rates:
        cum += r
        peak = max(peak, cum)
        mdd = min(mdd, cum - peak)

    # days to recover the full-cycle cost at the observed average rate
    bpd = per_day * 1e4
    breakeven = (CYCLE_COST_BPS / bpd) if bpd > 0 else float("inf")

    row = {
        "sym": symbol, "n": len(rates), "days": span_days,
        "gross_apr": gross_apr, "neg_pct": neg / len(rates) * 100,
        "bpd": bpd, "mdd_bps": mdd * 1e4, "breakeven_days": breakeven,
        "med_bps": statistics.median(rates) * 1e4,
    }
    # net return for fixed holds (collect funding, pay one full cycle of fees)
    for hold in (7, 30, 90):
        row[f"net{hold}"] = (per_day * hold * 1e4) - CYCLE_COST_BPS
    return row


print(f"Spot-perp funding study — last {DAYS} days")
print(f"Full-cycle cost: {CYCLE_COST_BPS:.0f} bps "
      f"(spot {SPOT_TAKER_BPS}x2 + futures {FUT_TAKER_BPS}x2)\n")

rows = []
for s in SYMBOLS:
    r = analyse(s.strip(), DAYS)
    if r:
        rows.append(r)
        print(f"  loaded {r['sym']:<10} {r['n']:>4} settlements over {r['days']:.0f}d")
    else:
        print(f"  {s}: no data")

if not rows:
    raise SystemExit("no data")

print(f"\n{'SYMBOL':<10}{'grossAPR':>10}{'bps/day':>9}{'med_bps':>9}"
      f"{'%neg':>7}{'worstDD':>9}{'BE_days':>9}")
for r in sorted(rows, key=lambda x: -x["gross_apr"]):
    be = f"{r['breakeven_days']:.1f}" if r["breakeven_days"] < 1e6 else "never"
    print(f"{r['sym']:<10}{r['gross_apr']:>9.2f}%{r['bpd']:>9.2f}{r['med_bps']:>9.2f}"
          f"{r['neg_pct']:>6.0f}%{r['mdd_bps']:>9.1f}{be:>9}")

print(f"\nNet return after ONE full cycle of fees ({CYCLE_COST_BPS:.0f} bps):")
print(f"{'SYMBOL':<10}{'hold 7d':>12}{'hold 30d':>12}{'hold 90d':>12}")
for r in sorted(rows, key=lambda x: -x["net30"]):
    print(f"{r['sym']:<10}{r['net7']:>+11.1f}b{r['net30']:>+11.1f}b{r['net90']:>+11.1f}b")

print("\n=== VERDICT ===")
prof30 = [r for r in rows if r["net30"] > 0]
print(f"symbols with POSITIVE net after fees on a 30-day hold : "
      f"{len(prof30)}/{len(rows)}")
if prof30:
    best = max(prof30, key=lambda r: r["net30"])
    print(f"best 30-day hold : {best['sym']} {best['net30']:+.1f} bps "
          f"({best['net30']/100:+.2f}% on notional, ~{best['gross_apr']:.1f}% APR gross)")
print("\nNOT modelled: futures liquidation, margin buffer, exchange minimum")
print("notionals. Those decide whether this is practical at small size.")
