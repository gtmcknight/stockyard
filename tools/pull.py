#!/usr/bin/env python3
"""Pull every Robinhood Chain memecoin that is paired against a tokenized stock.

Two passes:
  1. find each stock token's contract address (dexscreener search)
  2. ask dexscreener for that token's COMPLETE pool list (token-pairs endpoint)

Writes data/page.json for the page to read.
"""
import json, os, subprocess, sys, time, datetime, threading, concurrent.futures as cf

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
QUOTES = {"USDG", "USDC", "WETH", "ETH", "USDT"}
# not memecoins: stables, wrapped assets, and the chain's own plumbing. Their
# "market cap" is supply times a price set by a near-empty pool.
NOT_MEMES = {
    "USDG", "WUSDG", "USDC", "WUSDC", "USDT", "WUSDT", "DAI", "WDAI", "USDS", "USDE",
    "FRAX", "LUSD", "PYUSD", "RLUSD", "USD1", "FDUSD", "TUSD", "USDP", "GUSD", "USDY",
    "WETH", "ETH", "WBTC", "CBBTC", "TBTC", "WSTETH", "STETH", "RETH", "WEETH", "EZETH",
}
# a pool with no liquidity is not a market. Dust pools distort every count.
MIN_LIQ = 1000
# a pool holding real liquidity that nobody traded one percent of in a day
PARKED_LIQ = 2000
PARKED_TURN = 0.01

TICKERS = """
AAPL MSFT NVDA AMZN GOOGL GOOG META TSLA BRK.B AVGO LLY JPM V UNH XOM MA JNJ PG
COST HD MRK ABBV CVX ADBE PEP KO WMT CRM BAC NFLX AMD TMO ACN LIN MCD CSCO ABT
DIS ORCL WFC INTC INTU VZ TXN DHR QCOM PM CAT AMGN NEE COP UNP LOW SPGI IBM RTX
GE HON BA NKE UPS SBUX BLK GS AXP DE MDT MS ELV LMT PLD SYK ADP TJX CVS MDLZ
CI SCHW MMC ETN AMT REGN CB ZTS SLB BSX PGR BDX SO EOG DUK CME MO ITW AON APD
NOC ICE CSX PYPL FDX MU EQIX WM SHW MCK PNC USB CL TGT HUM GD EMR NSC MPC PSX
VLO ROP AJG MAR AEP ORLY MSI SRE TT AZO CTAS PCAR ADSK ADI KLAC LRCX AMAT SNPS
CDNS PANW CRWD ZS OKTA NET DDOG SNOW MDB TWLO TEAM WDAY VEEV HUBS ZM DOCU
COIN HOOD SQ SOFI AFRM UPST LC ALLY DFS COF
RBLX U EA TTWO ATVI SPOT PINS SNAP RDDT MTCH BMBL DASH UBER LYFT ABNB EXPE BKNG
SHOP ETSY EBAY W CHWY CVNA CARG KMX AN LAD
PLTR AI BBAI SOUN IONQ RGTI QUBT ARQQ QBTS
TSM ASML ARM SMCI DELL HPQ HPE NTAP STX WDC SNDK MRVL ON NXPI SWKS QRVO TER
RIVN LCID NIO XPEV LI F GM STLA TM HMC
FSLR ENPH SEDG RUN PLUG BE CHPT QS BLNK
LUNR RKLB ASTS SPIR PL BKSY SPCX MNTS ACHR JOBY EH EVTL
MARA RIOT CLSK HUT BITF CIFR WULF APLD CORZ IREN BTBT GREE HIVE
MRNA BNTX NVAX PFE VRTX GILD BIIB ALNY SRPT RARE FOLD IONS
HIMS TDOC DOCS OSCR CLOV ALHC AGL
GME AMC BB BBBY KOSS EXPR NOK SIRI SNDL TLRY CGC ACB HEXO
CRCL FIGMA FIG CRWV NBIS OKLO SMR NNE LEU CCJ UUUU DNN NXE
SPY QQQ IWM DIA VOO VTI ARKK ARKG XLE XLF XLK XLV XLI XLY XLP XLU XLB XLRE
GLD SLV GDX GDXJ USO UNG TLT HYG LQD EEM EFA VEA VWO SCHD JEPI QYLD TQQQ SQQQ
SOXL SOXS SPXL UPRO TMF UVXY VXX
BABA JD PDD BIDU NTES TCOM BILI IQ TME ZTO YUMC LI XPEV
WMT COST TGT DG DLTR KR ACI SFM BJ
MCD SBUX CMG YUM QSR WEN JACK PZZA DPZ DRI TXRH
KO PEP MNST CELH KDP STZ TAP BF.B DEO
NKE LULU UAA DECK ONON SKX CROX BIRD VFC RL PVH
DIS NFLX WBD PARA CMCSA T VZ TMUS CHTR FOX LYV MSGS RSI DKNG PENN CZR MGM LVS WYNN
JPM BAC WFC C GS MS SCHW BLK BX KKR APO ARES OWL TPG
BRK.B PGR ALL TRV AIG MET PRU AFL HIG CINF
UNH CI CVS HUM ELV MOH CNC
JNJ PFE MRK ABBV BMY LLY AMGN GILD REGN VRTX ZTS
XOM CVX COP EOG PXD OXY DVN FANG HES MRO APA SLB HAL BKR
NEE DUK SO D AEP EXC SRE XEL ED PEG WEC ES AEE CMS
CAT DE HON GE MMM EMR ETN PH ITW ROK DOV IR CMI PCAR
""".split()

# dexscreener allows ~300 requests/min per endpoint. Stay under it and back off on 429.
_lock = threading.Lock()
_next = [0.0]
_GAP = 0.22

def _throttle():
    with _lock:
        now = time.time()
        wait = max(0.0, _next[0] - now)
        _next[0] = max(now, _next[0]) + _GAP
    if wait:
        time.sleep(wait)

def sh(url, tries=5):
    for attempt in range(tries):
        _throttle()
        out = subprocess.run(
            ["curl", "-s", "-w", "\n__HTTP%{http_code}", "--max-time", "25", url],
            capture_output=True, text=True).stdout
        body, _, code = out.rpartition("\n__HTTP")
        if code.strip() == "429":
            time.sleep(2.5 * (attempt + 1))
            continue
        try:
            return json.loads(body)
        except Exception:
            time.sleep(1.0 + attempt)
    return None

def find_stock(t):
    """Return (ticker, address, liq, vol, price) for the tokenized stock, or None."""
    d = sh("https://api.dexscreener.com/latest/dex/search?q=%s%%20USDG" % t.replace(".", ""))
    if not d:
        return None
    liq = vol = 0.0
    addr = price = img = None
    for p in d.get("pairs") or []:
        if p.get("chainId") != "robinhood":
            continue
        b, q = p.get("baseToken") or {}, p.get("quoteToken") or {}
        if b.get("symbol", "").upper() == t and q.get("symbol", "").upper() in QUOTES:
            liq += (p.get("liquidity") or {}).get("usd") or 0
            vol += (p.get("volume") or {}).get("h24") or 0
            addr = addr or b.get("address")
            price = price or p.get("priceUsd")
            img = img or (p.get("info") or {}).get("imageUrl")
    return (t, addr, liq, vol, price, img) if addr else None

def _absorb(memes, pairs, addr, reg=()):
    """Every pool pairing this stock with a memecoin, in either orientation.

    Dexscreener decides which side is base and which is quote, and once a meme is
    deep enough to be quoted against itself the orientation flips: LLY/FATCOIN is
    filed with the stock as the base. Reading only the quote side dropped those
    pools entirely. Mirrors absorb() in worker/src/index.js.
    """
    now = time.time() * 1000
    want = (addr or "").lower()
    for p in pairs or []:
        if p.get("chainId") not in (None, "robinhood"):
            continue
        base, quote = p.get("baseToken") or {}, p.get("quoteToken") or {}
        ba = (base.get("address") or "").lower()
        qa = (quote.get("address") or "").lower()
        flipped = ba == want
        if not flipped and qa != want:
            continue
        b = quote if flipped else base
        # both sides in the registry is a stock traded against a stock, not a meme
        if (qa if flipped else ba) in reg:
            continue
        key = (b.get("address") or b.get("symbol") or "").lower()
        s = b.get("symbol")
        if not s or len(s) > 18 or s.upper() in QUOTES or s.upper() in NOT_MEMES or not key:
            continue
        info = p.get("info") or {}
        tx = (p.get("txns") or {}).get("h24") or {}
        m = memes.get(key)
        if m is None:
            m = memes[key] = {"s": s, "a": b.get("address"), "l": 0.0, "v": 0.0,
                              "c": None,
                              "cs": [None, None, None, None], "vs": [0.0, 0.0, 0.0, 0.0],
                              "_cw": [0.0, 0.0, 0.0, 0.0], "_cn": [0.0, 0.0, 0.0, 0.0],
                              "mc": 0, "x": None, "w": None,
                              "tx": 0, "age": None, "img": None, "u": p.get("url"),
                              "_inv": 0, "_seen": set()}
        pid = p.get("pairAddress") or id(p)
        if pid in m["_seen"]:
            continue
        m["_seen"].add(pid)
        pl = (p.get("liquidity") or {}).get("usd") or 0
        m["l"] += pl
        m["v"] += (p.get("volume") or {}).get("h24") or 0
        vol, chg = p.get("volume") or {}, p.get("priceChange") or {}
        for i, k in enumerate(("m5", "h1", "h6", "h24")):
            m["vs"][i] += vol.get(k) or 0
            cv = chg.get(k)
            # a price move belongs to the base side, so on a flipped pair it is
            # the stock moving against the meme. The meme's own move is the inverse.
            # Past a 99% move either way the reciprocal is arithmetic on a rounding
            # error rather than a price, so there is nothing to invert.
            if cv is not None and flipped:
                r = 1 + cv / 100.0
                cv = (1 / r - 1) * 100 if 0.01 <= r <= 100 else None
            # Dexscreener sometimes reports a move no pool can hold: a day-old
            # $1.6k pool that traded $47 came back at +5.75e20%. A thousandfold
            # in a day is already past anything real on this chain.
            if cv is not None and abs(cv) > 1e5:
                cv = None
            if cv is not None and pl:
                m["_cn"][i] += cv * pl
                m["_cw"][i] += pl
        m["tx"] += (tx.get("buys") or 0) + (tx.get("sells") or 0)
        if not m.get("u"):
            m["u"] = p.get("url")
        if p.get("pairCreatedAt"):
            days = round((now - p["pairCreatedAt"]) / 86400000.0, 1)
            m["age"] = days if m["age"] is None else min(m["age"], days)
        # marketCap, the logo and the socials all describe the base token, so on a
        # flipped pair they belong to the stock, not the meme. Filled in later.
        if flipped:
            m["_inv"] += 1
            continue
        if not m["img"]:
            m["img"] = info.get("imageUrl")
        for soc in info.get("socials") or []:
            if soc.get("type") == "twitter" and not m["x"]:
                m["x"] = soc.get("url")
        for web in info.get("websites") or []:
            if not m["w"]:
                m["w"] = web.get("url")
        if (p.get("marketCap") or 0) > (m.get("mc") or 0):
            m["mc"] = p.get("marketCap")


def _fill_flipped(memes):
    """A meme only ever seen as the quote side has no market cap, logo or socials
    yet, because everything Dexscreener attaches to a pair describes its base
    token. It is a handful of coins, so one batched lookup of their own pools
    fills them in."""
    if not memes:
        return
    want = {}
    for m in memes:
        want.setdefault((m["a"] or "").lower(), []).append(m)
    addrs = [a for a in want if a]
    for i in range(0, len(addrs), 30):
        d = sh("https://api.dexscreener.com/latest/dex/tokens/%s" % ",".join(addrs[i:i + 30]))
        for p in (d or {}).get("pairs") or []:
            for m in want.get(((p.get("baseToken") or {}).get("address") or "").lower(), []):
                info = p.get("info") or {}
                if (p.get("marketCap") or 0) > (m.get("mc") or 0):
                    m["mc"] = p.get("marketCap")
                if not m["img"]:
                    m["img"] = info.get("imageUrl")
                for soc in info.get("socials") or []:
                    if soc.get("type") == "twitter" and not m["x"]:
                        m["x"] = soc.get("url")
                for web in info.get("websites") or []:
                    if not m["w"]:
                        m["w"] = web.get("url")


def roster(t, addr, known=(), reg=()):
    """Every pool where this stock token is the QUOTE, unioned across four sources.

    token-pairs caps at roughly 30 pools and the searches only partly fill the
    long tail, so behind a busy ticker most of the roster stays hidden. Longbow
    publishes an untruncated index of the same coins; we ask Dexscreener about
    the ones it names that we have not already seen, so every meme on the map is
    still a pool Dexscreener confirms.
    """
    memes = {}
    tp = sh("https://api.dexscreener.com/token-pairs/v1/robinhood/%s" % addr)
    if isinstance(tp, list):
        _absorb(memes, tp, addr, reg)
    for q in ("%s%%20robinhood" % t.replace(".", ""), "%s%%20USDG" % t.replace(".", "")):
        d = sh("https://api.dexscreener.com/latest/dex/search?q=%s" % q)
        if isinstance(d, dict):
            _absorb(memes, d.get("pairs"), addr, reg)
    tail = [a for a in known if a not in memes]
    for i in range(0, len(tail), 30):
        d = sh("https://api.dexscreener.com/latest/dex/tokens/%s" % ",".join(tail[i:i + 30]))
        if isinstance(d, dict):
            _absorb(memes, d.get("pairs"), addr, reg)
    memes = {k: v for k, v in memes.items() if (v["l"] or 0) >= MIN_LIQ}
    _fill_flipped([m for m in memes.values() if m["_inv"]])
    for m in memes.values():
        m.pop("_seen", None)
        m.pop("_inv", None)
        for i in range(4):
            m["cs"][i] = round(m["_cn"][i] / m["_cw"][i], 1) if m["_cw"][i] else None
            m["vs"][i] = round(m["vs"][i])
        m.pop("_cn", None); m.pop("_cw", None)
        m["c"] = m["cs"][3]
    return sorted(memes.values(), key=lambda m: -m["l"])


def tradfi(t):
    """Real-world quote plus an intraday series, so the stock can be compared
    over the same windows as the memes. Free and unauthenticated."""
    out = subprocess.run(
        ["curl", "-s", "--max-time", "20", "-H", "User-Agent: Mozilla/5.0",
         "https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=5m&range=1d" % t],
        capture_output=True, text=True).stdout
    try:
        res = json.loads(out)["chart"]["result"][0]
        meta = res.get("meta") or {}
        px = meta.get("regularMarketPrice")
        prev = meta.get("chartPreviousClose") or meta.get("previousClose")
        closes = [c for c in ((res.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
                  if c is not None]
        # 5m bars: 1 back = 5 minutes, 12 = an hour, 72 = six hours
        def back(n):
            if not closes or px is None:
                return None
            ref = closes[-n] if len(closes) > n else closes[0]
            return round((px / ref - 1) * 100, 2) if ref else None
        series = [back(1), back(12), back(72),
                  (round((px / prev - 1) * 100, 2) if (px and prev) else None)]
        return px, prev, series
    except Exception:
        return None, None, [None] * 4


def classify(memes, ml):
    """Has anyone actually won this ticker yet?

    open      no meme has a market cap over $250K. Nobody has run it.
    contested a runner exists but holds under 55% of the ticker's meme liquidity.
    held      one meme holds the majority.
    """
    if not memes:
        return "empty", 0.0, 0
    top = memes[0]
    dom = (top["l"] / ml) if ml else 0.0
    cap = max((m.get("mc") or 0) for m in memes)
    if cap < 250000:
        return "open", dom, cap
    return ("held" if dom >= 0.55 else "contested"), dom, cap


def longbow():
    """Longbow's index of stock-anchored memes, keyed by anchor token.

    Optional. A missing file just means we run on Dexscreener alone.
    """
    path = os.path.join(DATA, "longbow.json")
    if not os.path.exists(path):
        print("no data/longbow.json. run tools/longbow.py for the full tail",
              file=sys.stderr)
        return {}
    try:
        return json.load(open(path)).get("anchors") or {}
    except Exception:
        return {}


def registry():
    """Every tokenized stock, straight from the issuer's own Deployed events."""
    path = os.path.join(DATA, "stocks.json")
    if not os.path.exists(path):
        print("no data/stocks.json. run tools/stocks.py first", file=sys.stderr)
        return []
    return json.load(open(path))


def market(entry):
    """Pool stats for one stock token, addressed directly rather than searched."""
    t, addr = entry["t"], entry["a"]
    liq = vol = 0.0
    price = img = None
    d = sh("https://api.dexscreener.com/token-pairs/v1/robinhood/%s" % addr)
    pairs = d if isinstance(d, list) else []
    for p in pairs:
        b, q = p.get("baseToken") or {}, p.get("quoteToken") or {}
        if (b.get("address") or "").lower() == addr.lower() and \
           q.get("symbol", "").upper() in QUOTES:
            liq += (p.get("liquidity") or {}).get("usd") or 0
            vol += (p.get("volume") or {}).get("h24") or 0
            price = price or p.get("priceUsd")
            img = img or (p.get("info") or {}).get("imageUrl")
    return (t, addr, liq, vol, price, img)


def main():
    reg = registry()
    lb = longbow()
    if lb:
        print("longbow index: %d memes across %d anchors"
              % (sum(len(v) for v in lb.values()), len(lb)), file=sys.stderr)
    print("phase 1: %d tokenized stocks in the registry" % len(reg), file=sys.stderr)
    found = []
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for i, r in enumerate(ex.map(market, reg)):
            found.append(r)
            if i % 50 == 0:
                print("  ...%d/%d" % (i, len(reg)), file=sys.stderr)
    print("phase 1 done: %d stock markets" % len(found), file=sys.stderr)
    # a pool with a registry token on both sides is a stock traded against a
    # stock, not a meme riding one
    reg_addrs = {(e.get("a") or "").lower() for e in reg if e.get("a")}
    reg_addrs |= {(r[1] or "").lower() for r in found if r[1]}
    reg_addrs.discard("")

    print("phase 2: pulling complete meme rosters", file=sys.stderr)
    rows = []
    def one(r):
        t, addr, liq, vol, price, img = r
        return (t, addr, liq, vol, price, img,
                roster(t, addr, lb.get((addr or "").lower(), []), reg_addrs))
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for i, (t, addr, liq, vol, price, img, memes) in enumerate(ex.map(one, found)):
            # Parked money: real liquidity in a pool nobody traded one percent of in
            # a day. It is a deposit, not a market, so it is counted on its own and
            # kept out of every total. Mirrors the rule in worker/src/index.js.
            for m in memes:
                if m["l"] >= PARKED_LIQ and m["v"] < m["l"] * PARKED_TURN:
                    m["q"] = 1
            memes.sort(key=lambda m: (m.get("q", 0), -m["l"]))
            live = [m for m in memes if not m.get("q")]

            ml = sum(m["l"] for m in live)
            mv = sum(m["v"] for m in live)
            pl = sum(m["l"] for m in memes if m.get("q"))
            mmc = sum((m.get("mc") or 0) for m in live)
            num = den = 0.0
            cs = [None] * 4
            vs = [0] * 4
            for i in range(4):
                n2 = d2 = 0.0
                for m in live:
                    vs[i] += m["vs"][i]
                    cv = m["cs"][i]
                    if cv is not None and m["l"]:
                        n2 += cv * m["l"]; d2 += m["l"]
                cs[i] = round(n2 / d2, 1) if d2 else None
            for m in live:
                if m.get("c") is not None and m["l"]:
                    num += m["c"] * m["l"]; den += m["l"]
            state, dom, cap = classify(live, ml)
            rows.append({
                "t": t, "a": addr, "sl": round(liq), "sv": round(vol), "img": img,
                "p": price, "ml": round(ml), "mv": round(mv), "pl": round(pl),
                "n": len(live), "nq": len(memes) - len(live),
                "c": round(num / den, 1) if den else None,
                "cs": cs, "vs": vs, "mmc": round(mmc),
                "st": state, "dom": round(dom, 3), "top": round(cap),
                "m": [{k: (round(v) if k in ("l", "v") and v else v) for k, v in m.items()}
                      for m in memes[:14]],
            })
            if i % 25 == 0:
                print("  ...%d/%d" % (i, len(found)), file=sys.stderr)

    print("phase 3: tradfi quotes", file=sys.stderr)
    def quote(r):
        px, prev, series = tradfi(r["t"])
        return r, px, prev, series
    bad = []
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        for r, px, prev, series in ex.map(quote, rows):
            r["tp"] = px
            r["tprev"] = prev
            r["scs"] = series
            r["dp"] = None
            try:
                on = float(r.get("p") or 0)
            except Exception:
                on = 0.0
            if px and on:
                ratio = on / px
                # a tokenized stock tracks its share. A wild gap means we matched a
                # memecoin whose symbol happens to equal the ticker, not the stock token.
                if ratio > 1.35 or ratio < 0.74:
                    bad.append((r["t"], round((ratio - 1) * 100, 1)))
                    r["mismatch"] = True
                else:
                    r["dp"] = round((ratio - 1) * 100, 2)
            # a price off a near-empty pool is noise, not a peg reading
            if (r.get("sl") or 0) < 25000:
                r["dp"] = None
    if bad:
        print("dropped %d symbol collisions: %s" % (len(bad), bad), file=sys.stderr)
    rows = [r for r in rows if not r.get("mismatch")]

    rows.sort(key=lambda r: -r["ml"])
    os.makedirs(DATA, exist_ok=True)
    blob = {
        "asOf": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "rows": rows,
    }
    out = os.path.join(DATA, "page.json")
    with open(out, "w") as f:
        json.dump(blob, f, separators=(",", ":"))
    print("\nwrote %s  (%d stocks, %d memes, $%s meme liq, $%s 24h vol)" % (
        out, len([r for r in rows if r["n"]]),
        sum(r["n"] for r in rows),
        format(sum(r["ml"] for r in rows), ",.0f"),
        format(sum(r["mv"] for r in rows), ",.0f")), file=sys.stderr)
    bare = [r for r in rows if not r["n"]]
    bare.sort(key=lambda r: -(r["sl"] or 0))
    print("tickers with no real meme: %d  (biggest stock markets: %s)" % (
        len(bare), ", ".join("%s $%s" % (r["t"], format(r["sl"], ",.0f")) for r in bare[:6])),
        file=sys.stderr)

if __name__ == "__main__":
    main()
