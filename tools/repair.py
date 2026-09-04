#!/usr/bin/env python3
"""Re-fetch any stock that came back with zero memes, and fall back to search."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pull import sh, roster, QUOTES, DATA

blob = json.load(open(os.path.join(DATA, "page.json")))
rows = blob["rows"]
empty = [r for r in rows if not r["n"]]
print("retrying %d empty tickers" % len(empty), file=sys.stderr)

def by_search(t, addr):
    d = sh("https://api.dexscreener.com/latest/dex/search?q=%s" % t)
    if not isinstance(d, dict):
        return []
    memes = {}
    now = time.time() * 1000
    for p in d.get("pairs") or []:
        if p.get("chainId") != "robinhood":
            continue
        b, q = p.get("baseToken") or {}, p.get("quoteToken") or {}
        if (q.get("address") or "").lower() != (addr or "").lower():
            continue
        s = b.get("symbol")
        if not s or len(s) > 18 or s.upper() in QUOTES:
            continue
        info = p.get("info") or {}
        tx = (p.get("txns") or {}).get("h24") or {}
        m = memes.setdefault(s, {"s": s, "a": b.get("address"), "l": 0.0, "v": 0.0,
                                 "c": (p.get("priceChange") or {}).get("h24"),
                                 "mc": p.get("marketCap"), "x": None, "w": None,
                                 "tx": 0, "age": None, "img": info.get("imageUrl")})
        m["l"] += (p.get("liquidity") or {}).get("usd") or 0
        m["v"] += (p.get("volume") or {}).get("h24") or 0
        m["tx"] += (tx.get("buys") or 0) + (tx.get("sells") or 0)
        for soc in info.get("socials") or []:
            if soc.get("type") == "twitter" and not m["x"]:
                m["x"] = soc.get("url")
        for web in info.get("websites") or []:
            if not m["w"]:
                m["w"] = web.get("url")
        if p.get("pairCreatedAt"):
            days = round((now - p["pairCreatedAt"]) / 86400000.0, 1)
            m["age"] = days if m["age"] is None else min(m["age"], days)
    return sorted(memes.values(), key=lambda m: -m["l"])

fixed = 0
for r in empty:
    memes = roster(r["t"], r["a"]) or by_search(r["t"], r["a"])
    if not memes:
        continue
    ml = sum(m["l"] for m in memes); mv = sum(m["v"] for m in memes)
    num = den = 0.0
    for m in memes:
        if m.get("c") is not None and m["l"]:
            num += m["c"] * m["l"]; den += m["l"]
    r["m"] = [{k: (round(v) if k in ("l", "v") and v else v) for k, v in m.items()} for m in memes[:14]]
    r["n"] = len(memes); r["ml"] = round(ml); r["mv"] = round(mv)
    r["c"] = round(num / den, 1) if den else None
    r["orph"] = len([m for m in memes if m["l"] > 2000 and (not m["x"] or m["tx"] < 20)])
    fixed += 1
    print("  %-6s -> %d memes, $%s liq" % (r["t"], r["n"], format(r["ml"], ",")), file=sys.stderr)

rows.sort(key=lambda r: -r["ml"])
json.dump(blob, open(os.path.join(DATA, "page.json"), "w"), separators=(",", ":"))
print("repaired %d" % fixed, file=sys.stderr)
