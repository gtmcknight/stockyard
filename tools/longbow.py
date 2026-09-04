#!/usr/bin/env python3
"""Pull Longbow's index of Robinhood Chain memes and their stock anchors.

Dexscreener's token-pairs endpoint caps at roughly 30 pools per token, so the
long tail behind a popular ticker is invisible to us. Longbow runs a launchpad
for exactly these coins and publishes its own index, which is not truncated.
At time of writing it knows about five times as many stock-anchored memes as
we were finding on our own.

Two feeds:
  /api/longbow  the coins Longbow itself launched, so the pad label is certain
  /api/pools    every stock-anchored meme it tracks, whoever launched it,
                each carrying the anchor token it trades against

Writes data/longbow.json. Everything downstream treats it as a hint: a coin
only reaches the map if Dexscreener confirms a real pool against a real
tokenized stock.
"""
import json, os, subprocess, sys, datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
BASE = "https://longbow.gg"

# Longbow's own shorthand for the other pads it sees, mapped to our labels.
PAD = {"long": "Long", "pair": "Pair.fund", "pons": "Pons"}


def get(path, tries=3):
    for i in range(tries):
        out = subprocess.run(
            ["curl", "-s", "--max-time", "40", "-H", "Accept: application/json",
             BASE + path],
            capture_output=True, text=True).stdout
        try:
            return json.loads(out)
        except Exception:
            pass
    return None


def main():
    launched = get("/api/longbow") or {}
    pools = get("/api/pools") or {}

    coins = pools.get("coins") or []
    if not coins:
        print("longbow: no pool data, leaving the last snapshot alone", file=sys.stderr)
        return 1

    # anchor token -> the memes Longbow has seen trading against it
    anchors = {}
    pads = {}
    for c in coins:
        a = (c.get("address") or "").lower()
        anchor = (c.get("anchorAddress") or "").lower()
        if not a or not anchor:
            continue
        anchors.setdefault(anchor, []).append(a)
        pad = PAD.get((c.get("launchpad") or "").lower())
        if pad:
            pads[a] = pad

    # a coin Longbow launched is Longbow's, whatever the heuristics guess later
    own = 0
    for c in launched.get("coins") or []:
        a = (c.get("address") or "").lower()
        if a:
            pads[a] = "Longbow"
            own += 1

    blob = {
        "asOf": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "anchors": anchors,
        "pads": pads,
    }
    os.makedirs(DATA, exist_ok=True)
    out = os.path.join(DATA, "longbow.json")
    with open(out, "w") as f:
        json.dump(blob, f, separators=(",", ":"))

    print("longbow: %d memes across %d anchors, %d launched by Longbow itself"
          % (len(coins), len(anchors), own), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
