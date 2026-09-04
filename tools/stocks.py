#!/usr/bin/env python3
"""Enumerate every tokenized stock on Robinhood Chain, from the issuer itself.

Robinhood deploys all stock tokens from one factory, which emits
    Deployed(bytes32 indexed uid, address stock, string name, string symbol)
Paging that event gives the complete registry, so the crawler stops guessing
from a hand-written ticker list and covers the whole chain.

Writes data/stocks.json: [{t, a, name}]
"""
import json, os, subprocess, sys, time
from urllib.parse import urlencode

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
FACTORY = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")
API = "https://robinhoodchain.blockscout.com/api/v2"

def get(url, tries=4):
    for i in range(tries):
        out = subprocess.run(
            ["curl", "-s", "--max-time", "25", "-H", "User-Agent: " + UA,
             "-H", "Accept: application/json", url],
            capture_output=True, text=True).stdout
        try:
            j = json.loads(out)
            if isinstance(j, dict) and j:
                return j
        except Exception:
            pass
        time.sleep(1.2 * (i + 1))
    return {}

def main():
    seen, out, page = set(), [], None
    while True:
        url = API + "/addresses/" + FACTORY + "/logs"
        if page:
            url += "?" + urlencode(page)
        d = get(url)
        items = d.get("items") or []
        if not items:
            break
        for it in items:
            dec = it.get("decoded") or {}
            if not dec.get("method_call", "").startswith("Deployed("):
                continue
            p = {x["name"]: x["value"] for x in dec.get("parameters") or []}
            a = (p.get("stock") or "").lower()
            sym = (p.get("symbol") or "").strip()
            if a and sym and a not in seen:
                seen.add(a)
                out.append({"t": sym.upper(), "a": p["stock"], "name": p.get("name") or sym})
        page = d.get("next_page_params")
        print("  ...%d stock tokens" % len(out), file=sys.stderr)
        if not page:
            break
        time.sleep(0.15)

    out.sort(key=lambda r: r["t"])
    os.makedirs(DATA, exist_ok=True)
    json.dump(out, open(os.path.join(DATA, "stocks.json"), "w"), indent=1)
    print("\nregistry: %d tokenized stocks" % len(out), file=sys.stderr)
    print("  " + ", ".join(r["t"] for r in out[:24]) + " ...", file=sys.stderr)

if __name__ == "__main__":
    main()
