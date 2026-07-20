"""
Honest-by-default strategy backtest harness.  READ-ONLY, no API keys, no orders.

Written after measuring two strategies to destruction on Binance spot:
  - triangular arb : +0.043% raw edge vs 0.30% taker cost  -> dead
  - market making  : -9.7 bps markout @5s vs 10 bps maker  -> dead
Both died on ~20 bps round-trip cost, not on idea quality. So this harness makes
costs and self-deception impossible to skip rather than opt-in.

Three things kill retail backtests, and all three are ON by default here:
  1. ignoring costs            -> fees + spread charged on every entry AND exit
  2. mistaking noise for edge  -> permutation test vs random entries
  3. overfitting               -> out-of-sample split reported separately

Usage:
    python3 backtest.py                  # runs the built-in verification suite
    (or import and call run(...) with your own signal function)

Signal contract:
    def my_rule(bars, ind) -> list[int]   # 1 = want to be long on that bar, 0 = flat
Entries/exits execute at the NEXT bar's open, so a causal signal cannot peek.
"""
import json
import os
import random
import statistics
import urllib.request
from typing import Callable, Optional

CACHE_DIR = os.environ.get("BT_CACHE", "/tmp/bt_cache")
SPOT_KLINES = "https://api.binance.com/api/v3/klines"
FUT_KLINES = "https://fapi.binance.com/fapi/v1/klines"

# ---------------------------------------------------------------------------
# Cost model - measured, not guessed.
# Spot and USD-M futures have materially different fees; using the spot numbers
# on a futures rule judges it roughly twice as harshly as reality.
# ---------------------------------------------------------------------------
TAKER_BPS = 10.0          # Binance SPOT retail taker, one side (7.5 with BNB)
DEFAULT_SPREAD_BPS = 5.0  # crossed on each side; override per symbol

FUT_TAKER_BPS = 5.0       # USD-M FUTURES taker, one side
FUT_SPREAD_BPS = 1.0      # liquid perps quote ~0.02-1.4 bps; measure per symbol


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------
def fetch_klines(symbol: str, interval: str = "1h", limit_bars: int = 5000,
                 market: str = "spot") -> list[dict]:
    """Binance public klines, paginated + cached. market = 'spot' | 'futures'."""
    if market not in ("spot", "futures"):
        raise ValueError("market must be 'spot' or 'futures'")
    base = SPOT_KLINES if market == "spot" else FUT_KLINES
    page = 1000 if market == "spot" else 1500

    os.makedirs(CACHE_DIR, exist_ok=True)
    # market is part of the key so spot and futures data can never collide
    cache = os.path.join(CACHE_DIR, f"{market}_{symbol}_{interval}_{limit_bars}.json")
    if os.path.exists(cache):
        with open(cache) as f:
            return json.load(f)

    out: list[dict] = []
    end = None
    while len(out) < limit_bars:
        url = f"{base}?symbol={symbol}&interval={interval}&limit={page}"
        if end:
            url += f"&endTime={end}"
        rows = json.load(urllib.request.urlopen(url, timeout=30))
        if not rows:
            break
        batch = [{
            "t": r[0], "o": float(r[1]), "h": float(r[2]),
            "l": float(r[3]), "c": float(r[4]), "v": float(r[5]),
        } for r in rows]
        out = batch + out
        end = rows[0][0] - 1
        if len(rows) < page:
            break
    out = out[-limit_bars:]
    with open(cache, "w") as f:
        json.dump(out, f)
    return out


# ---------------------------------------------------------------------------
# Causal indicators (value at i uses only bars 0..i)
# ---------------------------------------------------------------------------
def sma(vals: list[float], n: int) -> list[Optional[float]]:
    out, run = [], 0.0
    for i, v in enumerate(vals):
        run += v
        if i >= n:
            run -= vals[i - n]
        out.append(run / n if i >= n - 1 else None)
    return out


def ema(vals: list[float], n: int) -> list[Optional[float]]:
    k, out, prev = 2 / (n + 1), [], None
    for v in vals:
        prev = v if prev is None else v * k + prev * (1 - k)
        out.append(prev)
    return out


def rsi(vals: list[float], n: int = 14) -> list[Optional[float]]:
    out: list[Optional[float]] = [None] * len(vals)
    gains, losses = 0.0, 0.0
    for i in range(1, len(vals)):
        d = vals[i] - vals[i - 1]
        g, l = max(d, 0.0), max(-d, 0.0)
        if i <= n:
            gains += g; losses += l
            if i == n:
                ag, al = gains / n, losses / n
                out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
        else:
            ag = (ag * (n - 1) + g) / n
            al = (al * (n - 1) + l) / n
            out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def roll_return(vals: list[float], n: int) -> list[Optional[float]]:
    return [None if i < n or vals[i - n] == 0 else vals[i] / vals[i - n] - 1
            for i in range(len(vals))]


def zscore(vals: list[float], n: int) -> list[Optional[float]]:
    out: list[Optional[float]] = []
    for i in range(len(vals)):
        if i < n:
            out.append(None); continue
        w = vals[i - n:i]
        sd = statistics.pstdev(w)
        out.append(None if sd == 0 else (vals[i] - statistics.fmean(w)) / sd)
    return out


def indicators(bars: list[dict]) -> dict:
    c = [b["c"] for b in bars]
    v = [b["v"] for b in bars]
    return {
        "close": c, "vol": v,
        "sma": lambda n: sma(c, n), "ema": lambda n: ema(c, n),
        "rsi": lambda n=14: rsi(c, n), "ret": lambda n: roll_return(c, n),
        "volz": lambda n=20: zscore(v, n),
    }


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
def simulate(bars, want_long, fee_bps, spread_bps,
             stop_loss=None, take_profit=None, max_hold=None):
    """Execute at the NEXT bar's open. Returns (equity_curve, trades)."""
    cost = (fee_bps + spread_bps / 2) / 1e4   # charged per side
    eq, equity = [1.0], 1.0
    pos_price = None
    held = 0
    trades = []

    for i in range(len(bars) - 1):
        nxt = bars[i + 1]["o"]

        if pos_price is not None:
            held += 1
            r = nxt / pos_price - 1
            hit = (
                (stop_loss is not None and r <= -stop_loss) or
                (take_profit is not None and r >= take_profit) or
                (max_hold is not None and held >= max_hold) or
                not want_long[i]
            )
            if hit:
                net = (1 + r) * (1 - cost) - 1        # exit cost
                equity *= (1 + net)
                trades.append({"ret": net, "bars": held})
                pos_price, held = None, 0
        elif want_long[i]:
            pos_price = nxt * (1 + cost)              # entry cost
            held = 0
        eq.append(equity)

    if pos_price is not None:                          # close at final bar
        r = bars[-1]["c"] / pos_price - 1
        net = (1 + r) * (1 - cost) - 1
        equity *= (1 + net)
        trades.append({"ret": net, "bars": held})
        eq.append(equity)
    return eq, trades


def max_drawdown(eq: list[float]) -> float:
    peak, mdd = eq[0], 0.0
    for v in eq:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    return mdd


def permutation_test(bars, trades, fee_bps, spread_bps, n=1000, seed=7):
    """Random entries matching the strategy's trade count AND hold durations.
    A rule that cannot beat shuffled entries has found noise, not an edge."""
    if not trades:
        return None
    rng = random.Random(seed)
    holds = [max(1, t["bars"]) for t in trades]
    # If holds are so long that random entries cannot be placed, the test is not
    # meaningful - say so rather than silently returning a flattering 0%.
    if any(len(bars) - h - 2 <= 1 for h in holds):
        return None
    cost = (fee_bps + spread_bps / 2) / 1e4
    results = []
    for _ in range(n):
        equity = 1.0
        for h in holds:
            i = rng.randrange(0, len(bars) - h - 2)
            entry = bars[i + 1]["o"] * (1 + cost)
            exit_ = bars[min(i + 1 + h, len(bars) - 1)]["o"]
            equity *= (1 + ((exit_ / entry) * (1 - cost) - 1))
        results.append(equity - 1)
    return results


def report(name, bars, want_long, fee_bps=TAKER_BPS, spread_bps=DEFAULT_SPREAD_BPS,
           stop_loss=None, take_profit=None, max_hold=None, permutations=1000):
    if fee_bps == 0 and spread_bps == 0:
        print("  !! WARNING: costs disabled - results are fiction !!")

    eq, trades = simulate(bars, want_long, fee_bps, spread_bps,
                          stop_loss, take_profit, max_hold)
    net = eq[-1] - 1
    bh = bars[-1]["c"] / bars[0]["o"] - 1
    wins = [t for t in trades if t["ret"] > 0]
    rt_cost_bps = 2 * (fee_bps + spread_bps / 2)

    print(f"\n=== {name} ===")
    print(f"  bars                : {len(bars)}")
    print(f"  net return (costed) : {net*100:+.2f}%")
    print(f"  buy & hold          : {bh*100:+.2f}%")
    print(f"  trades              : {len(trades)}")
    if trades:
        per = statistics.fmean([t["ret"] for t in trades]) * 1e4
        print(f"  win rate            : {len(wins)/len(trades)*100:.1f}%")
        print(f"  avg return / trade  : {per:+.1f} bps   (round-trip cost {rt_cost_bps:.1f} bps)")
        print(f"  avg hold            : {statistics.fmean([t['bars'] for t in trades]):.1f} bars")
    print(f"  max drawdown        : {max_drawdown(eq)*100:.2f}%")
    print(f"  exposure            : {sum(1 for x in want_long if x)/len(want_long)*100:.1f}%")

    perm = permutation_test(bars, trades, fee_bps, spread_bps, permutations)
    if perm:
        better = sum(1 for p in perm if p >= net)
        pct = 100 * (1 - better / len(perm))
        print(f"  vs {len(perm)} random entries (same count & holds):")
        print(f"      random median   : {statistics.median(perm)*100:+.2f}%")
        print(f"      strategy beats  : {pct:.1f}% of them", end="")
        print("   <-- indistinguishable from noise" if pct < 95 else "   <-- beats noise")
    else:
        print("  vs random entries   : n/a (too few trades, or holds too long to shuffle)")
    return net


def run(name, bars, rule: Callable, split=0.7, **kw):
    """Full report: in-sample, out-of-sample, and the look-ahead check."""
    ind = indicators(bars)
    want = rule(bars, ind)
    cut = int(len(bars) * split)

    report(f"{name} — FULL", bars, want, **kw)
    report(f"{name} — in-sample (first {int(split*100)}%)", bars[:cut], want[:cut], **kw)
    report(f"{name} — OUT-OF-SAMPLE (last {int((1-split)*100)}%)", bars[cut:], want[cut:], **kw)
    print("\n  ^ if in-sample looks good and out-of-sample does not, that is overfitting.")


# ---------------------------------------------------------------------------
# Verification suite (see plan: null, buy&hold, look-ahead)
# ---------------------------------------------------------------------------
def rule_random(bars, ind):
    rng = random.Random(42)
    return [1 if rng.random() < 0.3 else 0 for _ in bars]


def rule_always_long(bars, ind):
    return [1] * len(bars)


def rule_lookahead_CHEAT(bars, ind):
    """Deliberately peeks at the next bar. Must look impossibly good -> proves
    the harness would flag a look-ahead bug rather than hide it."""
    return [1 if i + 1 < len(bars) and bars[i + 1]["c"] > bars[i]["c"] else 0
            for i in range(len(bars))]


if __name__ == "__main__":
    sym = os.environ.get("BT_SYMBOL", "BTCUSDT")
    bars = fetch_klines(sym, os.environ.get("BT_INTERVAL", "1h"), 5000)
    print(f"{sym}: {len(bars)} bars loaded")

    print("\n########## VERIFICATION ##########")
    print("\n--- 1. NULL: random entries. Must show ~no edge and NOT beat noise.")
    report("random", bars, rule_random(bars, None))

    print("\n--- 2. ALWAYS LONG: must ~= buy & hold minus one round trip.")
    report("always-long", bars, rule_always_long(bars, None))

    print("\n--- 3. LOOK-AHEAD CHEAT: must look absurdly good (proves detection).")
    report("lookahead-cheat", bars, rule_lookahead_CHEAT(bars, None), permutations=200)
