"""
Decisive read-only test: do 4-leg paths beat 3-leg paths?

Uses ONE bookTicker snapshot for every symbol, so all prices are from the same
instant -- this removes the stale-quote problem entirely. Buys cross the ask,
sells cross the bid, so real spread cost is included. Fees charged per leg.

Top-of-book only (no depth walking), so these numbers are an OPTIMISTIC UPPER
BOUND. Anything that cannot clear costs here certainly cannot in reality.
"""
import json
import urllib.request
from collections import defaultdict

FEE = 0.001
START = "USDT"

raw = json.load(urllib.request.urlopen(
    "https://api.binance.com/api/v3/ticker/bookTicker", timeout=60))
info = json.load(urllib.request.urlopen(
    "https://api.binance.com/api/v3/exchangeInfo", timeout=60))

tradable = {s["symbol"]: (s["baseAsset"], s["quoteAsset"])
            for s in info["symbols"] if s["status"] == "TRADING"}

book = {}
for t in raw:
    sym = t["symbol"]
    if sym not in tradable:
        continue
    bid, ask = float(t["bidPrice"]), float(t["askPrice"])
    if bid > 0 and ask > 0:
        book[sym] = (bid, ask)

# asset -> list of (neighbour, symbol, asset_is_base)
adj = defaultdict(list)
for sym, (b, q) in tradable.items():
    if sym not in book:
        continue
    adj[b].append((q, sym, True))   # hold base -> sell for quote
    adj[q].append((b, sym, False))  # hold quote -> buy base

def step(amount, sym, asset_is_base):
    """Convert `amount` across one leg, crossing the spread, minus fee."""
    bid, ask = book[sym]
    if asset_is_base:
        out = amount * bid      # sell base at bid
    else:
        out = amount / ask      # buy base with quote at ask
    return out * (1.0 - FEE)

def search(depth):
    """Best net return for paths of `depth` legs starting+ending at START."""
    results = []

    def walk(asset, amount, legs, path):
        if len(legs) == depth:
            if asset == START:
                results.append((amount - 1.0, list(path)))
            return
        # prune: on the final leg only consider neighbours that return to START
        for nxt, sym, is_base in adj[asset]:
            if len(legs) == depth - 1 and nxt != START:
                continue
            if nxt in path[1:]:      # no revisiting intermediates
                continue
            if nxt == START and len(legs) != depth - 1:
                continue
            walk(nxt, step(amount, sym, is_base), legs + [sym], path + [nxt])

    walk(START, 1.0, [], [START])
    results.sort(key=lambda r: -r[0])
    return results

for depth in (3, 4):
    res = search(depth)
    pos = [r for r in res if r[0] > 0]
    print(f"=== {depth}-leg paths from {START} ===")
    print(f"  paths evaluated : {len(res):,}")
    print(f"  net-positive    : {len(pos):,}")
    if res:
        print(f"  best net edge   : {res[0][0]*100:+.4f}%   {' -> '.join(res[0][1])}")
        for edge, path in res[1:4]:
            print(f"                    {edge*100:+.4f}%   {' -> '.join(path)}")
    print()
