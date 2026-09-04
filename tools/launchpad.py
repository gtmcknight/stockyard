#!/usr/bin/env python3
"""Resolve which launchpad each token was created on, and cache it forever.

Two hops:
  1. the token's deployer contract, whose name usually names the pad
  2. if the deployer is shared infrastructure (Doppler), the creation
     transaction's target, which is the pad's own launcher contract

A token's launchpad never changes, so results are cached in
data/launchpads.json and only new tokens cost a request.
"""
import json, os, subprocess, sys, threading, time, concurrent.futures as cf

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(DATA, "launchpads.json")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")
API = "https://robinhoodchain.blockscout.com/api/v2"
RPC = "https://rpc.mainnet.chain.robinhood.com"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO = "0x" + "0" * 64
_head = [None]

# deployer or launcher contract -> the name people use
KNOWN = {
    "0x22e99278308b393ea1260859b181ad7e78f5eeed": "Long",
    # Airlock is Doppler's own entry contract, so a token that lands there was
    # launched with Doppler directly rather than through a branded pad
    "airlock": "Doppler",
    "0x3711cea4feade896c913c68f01eda97cb06d1a42": "Pons",
    "0x8660a7f019c7943b0b0a91b8e39aff3b6db6ae62": "Pair.fund",
    "0x18e674231a58c239dc7daedcffe15ec3a24cff5c": "Hookr",
}
# deployers that several pads share, so they need the second hop
SHARED = {"0x1b37d3a72082029c44b35b604ea473617580b69a"}     # DopplerERC20V1Factory
# smart-wallet plumbing, never the pad itself
PLUMBING = {"0x0000000071727de22e5e9d8baf0edac6f37da032"}   # ERC-4337 EntryPoint

_lock = threading.Lock()
_next = [0.0]

def _throttle(gap=0.12):
    with _lock:
        now = time.time()
        wait = max(0.0, _next[0] - now)
        _next[0] = max(now, _next[0]) + gap
    if wait:
        time.sleep(wait)

def bs(path, tries=3):
    for i in range(tries):
        _throttle()
        out = subprocess.run(
            ["curl", "-s", "--max-time", "20", "-H", "User-Agent: " + UA,
             "-H", "Accept: application/json", API + path],
            capture_output=True, text=True).stdout
        try:
            j = json.loads(out)
            if isinstance(j, dict) and j:
                return j
        except Exception:
            pass
        time.sleep(1.0 * (i + 1))
    return {}

# contract names that describe plumbing, not a launchpad
GENERIC = {"transparentupgradeableproxy", "erc1967proxy", "proxy", "uerc20",
           "beaconproxy", "erc20", "token", "standardtoken"}

IMPL = {
    "dopplererc20v1": "Doppler",
    "stock": "StockV4",
}

CLEAN = {
    "rwaerc20launchpad": "o1",
    "lunchv4pairimmutable": "Pair.fund",
    "standardtokenv4stockv3": "StockV4",
    "airlock": "Doppler",
}

def rpc(method, params, timeout="40"):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    out = subprocess.run(
        ["curl", "-s", "--max-time", timeout, "-X", "POST",
         "-H", "content-type: application/json", "--data", body, RPC],
        capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {}

def head_block():
    if _head[0] is None:
        r = rpc("eth_blockNumber", [], "15")
        _head[0] = int(r["result"], 16) if r.get("result") else 0
    return _head[0]

def by_mint(addr):
    """Proxy clones carry no creation record, so find the mint and see who asked for it."""
    head = head_block()
    if not head:
        return None
    for span in (6_000_000, 26_000_000, 70_000_000):
        r = rpc("eth_getLogs", [{"address": addr, "fromBlock": hex(max(0, head - span)),
                                 "toBlock": hex(head), "topics": [TRANSFER, ZERO]}])
        logs = r.get("result") or []
        if not logs:
            continue
        first = min(logs, key=lambda l: int(l["blockNumber"], 16))
        t = rpc("eth_getTransactionByHash", [first["transactionHash"]], "20").get("result") or {}
        to = (t.get("to") or "").lower()
        if to in KNOWN:
            return KNOWN[to]
        if to and to not in PLUMBING:
            info = bs("/addresses/" + to)
            nm = pretty(info.get("name"))
            if nm:
                return nm
        return None
    return None

PREFIX = (("pons", "Pons"), ("longbow", "Longbow"), ("long", "Long"), ("hookr", "Hookr"),
          ("pair", "Pair.fund"), ("doppler", "Doppler"), ("sushi", "Sushi"),
          ("rwa", "o1"))

def pretty(name):
    if not name:
        return None
    key = name.lower().strip()
    for pre, label in PREFIX:
        if key.startswith(pre):
            return label
    if key in CLEAN:
        return CLEAN[key]
    if key in GENERIC:
        return None
    n = name.replace("Launchpad", "").replace("Launcher", "") \
            .replace("LaunchDeployer", "").replace("LaunchToken", "") \
            .replace("Deployer", "").replace("ERC1967Proxy", "") \
            .replace("Factory", "").replace("ERC20", "").strip()
    return n or None

def from_impl(a):
    """No creation record at all. Name the tooling from the proxy implementation."""
    for im in a.get("implementations") or []:
        nm = (im.get("name") or "").lower().strip()
        if nm in IMPL:
            return IMPL[nm]
    return None

def resolve(addr):
    a = bs("/addresses/" + addr)
    creator = (a.get("creator_address_hash") or "").lower()
    if not creator:
        return by_mint(addr) or from_impl(a)
    if creator in KNOWN:
        return KNOWN[creator]
    if a.get("creator_address_hash") and creator not in SHARED:
        info = bs("/addresses/" + creator)
        if info.get("is_contract") is False:
            return "self"
        nm = pretty(info.get("name"))
        if nm:
            return nm
    tx = a.get("creation_transaction_hash")
    if tx:
        t = bs("/transactions/" + tx)
        to = (t.get("to") or {})
        h = (to.get("hash") or "").lower()
        if h in KNOWN:
            return KNOWN[h]
        if h and h not in PLUMBING:
            nm = pretty(to.get("name"))
            if nm:
                return nm
    return by_mint(addr) or from_impl(a)

def main():
    cache = {}
    if os.path.exists(CACHE):
        cache = json.load(open(CACHE))
    page = json.load(open(os.path.join(DATA, "page.json")))

    # Longbow names the pad for every coin it launched, and its own view of the
    # other pads. That beats guessing from a contract name, so it wins.
    lb = os.path.join(DATA, "longbow.json")
    if os.path.exists(lb):
        try:
            pads = json.load(open(lb)).get("pads") or {}
        except Exception:
            pads = {}
        for a, pad in pads.items():
            if pad == "Longbow" or not cache.get(a):
                cache[a] = pad
        print("seeded %d launchpad labels from longbow" % len(pads), file=sys.stderr)

    want = []
    for r in page["rows"]:
        for m in r["m"]:
            a = (m.get("a") or "").lower()
            if a and not cache.get(a):
                want.append(a)
    want = sorted(set(want))
    print("cached %d, resolving %d new" % (len(cache), len(want)), file=sys.stderr)

    done = 0
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        for a, pad in zip(want, ex.map(resolve, want)):
            if pad:
                cache[a] = pad
            done += 1
            if done % 50 == 0:
                print("  ...%d/%d" % (done, len(want)), file=sys.stderr)
                json.dump(cache, open(CACHE, "w"))
    json.dump(cache, open(CACHE, "w"))

    # stamp it onto the page data
    hit = 0
    for r in page["rows"]:
        for m in r["m"]:
            pad = cache.get((m.get("a") or "").lower())
            if pad:
                m["lp"] = pad
                hit += 1
    json.dump(page, open(os.path.join(DATA, "page.json"), "w"), separators=(",", ":"))

    import collections
    c = collections.Counter(v for v in cache.values() if v)
    print("\nlabelled %d of %d memes" % (hit, sum(len(r["m"]) for r in page["rows"])), file=sys.stderr)
    for k, v in c.most_common(12):
        print("  %-16s %d" % (k, v), file=sys.stderr)

if __name__ == "__main__":
    main()
