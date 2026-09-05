// Stockyard: every memecoin on Robinhood Chain that trades against a tokenized stock.
//
// The page is a static file. Everything live is one JSON blob in KV, rebuilt on a
// schedule, so a visitor never waits on an upstream API and we never pay for one.
//
// Three crons, tiered by how fast each thing actually changes:
//   */5 * * * *   pools. Liquidity, volume and price move constantly.
//   7 * * * *     real-world stock prices. Only meaningful while markets are open.
//   23 6 * * *    the stock registry. Robinhood adds tokens in batches, not hourly.
//
// Every source is unauthenticated: Dexscreener for pools, Yahoo for share prices,
// Blockscout for the registry. No keys, no accounts, no per-request cost.

const UA = "stockyard (+https://stockyard.rhps.fun)";
// Blockscout sits behind Cloudflare and serves a challenge page to non-browser
// agents, so registry and launchpad lookups have to look like a browser.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const QUOTES = new Set(["USDG", "USDC", "WETH", "ETH", "USDT"]);

// Not memecoins. Their "market cap" is a huge fixed supply times a price that a
// near-empty pool invented, which puts fictional billions at the top of a list.
const NOT_MEMES = new Set([
  "USDG", "WUSDG", "USDC", "WUSDC", "USDT", "WUSDT", "DAI", "WDAI", "USDS", "USDE",
  "FRAX", "LUSD", "PYUSD", "RLUSD", "USD1", "FDUSD", "TUSD", "USDP", "GUSD", "USDY",
  "WETH", "ETH", "WBTC", "CBBTC", "TBTC", "WSTETH", "STETH", "RETH", "WEETH", "EZETH",
]);

const MIN_LIQ = 1000;        // a pool with nothing in it is not a market

// A token's launchpad never changes, so it is resolved once and cached forever.
// Known launcher and deployer contracts, keyed by address.
const PADS = {
  "0x22e99278308b393ea1260859b181ad7e78f5eeed": "Long",
  "0x3711cea4feade896c913c68f01eda97cb06d1a42": "Pons",
  "0x8660a7f019c7943b0b0a91b8e39aff3b6db6ae62": "Pair.fund",
  "0x18e674231a58c239dc7daedcffe15ec3a24cff5c": "Hookr",
  "0x6544af3524a8d9135eb5765cece6e514d85d615b": "o1",
};
// Doppler is shared plumbing several pads build on, so it never names the pad itself
const SHARED = new Set(["0x1b37d3a72082029c44b35b604ea473617580b69a"]);
const PLUMBING = new Set(["0x0000000071727de22e5e9d8baf0edac6f37da032"]); // ERC-4337 entry point
const PAD_PREFIX = [["pons", "Pons"], ["long", "Long"], ["hookr", "Hookr"],
                    ["pair", "Pair.fund"], ["rwa", "o1"], ["doppler", "Doppler"],
                    ["sushi", "Sushi"]];
const PAD_GENERIC = new Set(["transparentupgradeableproxy", "erc1967proxy", "proxy",
                             "uerc20", "beaconproxy", "erc20", "token", "standardtoken",
                             "launchpad", "equitytoken"]);

function padName(raw) {
  if (!raw) return null;
  const k = raw.toLowerCase().trim();
  for (const [pre, label] of PAD_PREFIX) if (k.startsWith(pre)) return label;
  if (PAD_GENERIC.has(k)) return null;
  const n = raw.replace(/Launchpad|Launcher|LaunchDeployer|LaunchToken|Deployer|ERC1967Proxy|Factory|ERC20/g, "").trim();
  return n || null;
}

// Three hops, cheapest first: the deployer contract, the creation transaction's
// target, then the mint transaction for proxy clones that carry no creation record.
async function resolvePad(env, addr) {
  const a = await getJSON(`${env.EXPLORER_API}/addresses/${addr}`);
  if (!a) return null;
  const creator = (a.creator_address_hash || "").toLowerCase();
  if (creator && PADS[creator]) return PADS[creator];
  if (creator && !SHARED.has(creator)) {
    const info = await getJSON(`${env.EXPLORER_API}/addresses/${creator}`);
    if (info?.is_contract === false) return "self";
    const n = padName(info?.name);
    if (n) return n;
  }
  const tx = a.creation_transaction_hash;
  if (tx) {
    const t = await getJSON(`${env.EXPLORER_API}/transactions/${tx}`);
    const to = (t?.to?.hash || "").toLowerCase();
    if (PADS[to]) return PADS[to];
    if (to && !PLUMBING.has(to)) {
      const n = padName(t?.to?.name);
      if (n) return n;
    }
  }
  for (const im of a.implementations || []) {
    const n = (im.name || "").toLowerCase();
    if (n === "dopplererc20v1") return "Doppler";
  }
  return null;
}

// Chip away at whatever is still unknown, a few per run, so coverage climbs
// instead of decaying as new coins launch.
async function resolveNewPads(env, rows, cache, budget = 12) {
  const todo = [];
  for (const r of rows) for (const m of r.m) {
    const a = (m.a || "").toLowerCase();
    if (a && !cache[a] && todo.length < budget) todo.push(a);
  }
  if (!todo.length) return 0;
  const found = await pooled(todo, 4, (a) => resolvePad(env, a));
  let n = 0;
  todo.forEach((a, i) => { if (found[i]) { cache[a] = found[i]; n++; } });
  if (n) await env.SY.put(KEY.pads, JSON.stringify(cache));
  return n;
}
const KEY = {
  snapshot: "snapshot",       // what the page reads
  registry: "registry",       // every tokenized stock, from the issuer
  pads: "launchpads",         // token address -> launchpad, resolved once and kept
  longbow: "longbow",         // anchor token -> the memes Longbow sees riding it
  history: (d) => `history:${d}`,
  lock: "lock:pools",         // held while a crawl runs, so ticks cannot overlap
  lastRun: "lastrun",         // stats from the most recent crawl, cron included
};

// ---------------------------------------------------------------- fetch helpers

// Dexscreener allows roughly 300 requests a minute. Pulling the Longbow tail
// pushed us past that, and a 429 that outlives its retries drops a whole chunk
// of a roster with no error, so every call is paced through one gate and the
// ones we still lose are counted rather than swallowed.
let _gate = 0;
let _lost = 0, _lost429 = 0, _lostBad = 0, _lostErr = 0;
async function paced() {
  const now = Date.now();
  const at = Math.max(now, _gate);
  _gate = at + 260;
  if (at > now) await sleep(at - now);
}

async function getJSON(url, tries = 3) {
  // Five tries with a rising backoff meant 61 rate-limited requests spent eight
  // minutes asleep, which is what pushed a run past its own cron interval and
  // got it cancelled. Three quick tries, then let the pacer do the work.
  const ds = url.includes("dexscreener");
  if (ds) tries = 3;
  const browser = url.includes("blockscout");
  const headers = browser
    ? { "User-Agent": BROWSER_UA, Accept: "application/json" }
    : { "User-Agent": UA };
  let last = "";
  for (let i = 0; i < tries; i++) {
    // pace every attempt, not just the first: an unpaced retry storm is what
    // pushes us back over the limit and loses the chunk for good
    if (ds) await paced();
    try {
      const r = await fetch(url, { headers });
      if (r.status === 429) {
        last = "429";
        await sleep(500 * (i + 1));
        continue;
      }
      if (r.ok) return await r.json();
      last = "http" + r.status;
    } catch (_) {
      last = "throw";
    }
    await sleep(300 * (i + 1));
  }
  if (ds) {
    _lost++;
    if (last === "429") _lost429++;
    else if (last === "throw") _lostErr++;
    else _lostBad++;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dexscreener allows roughly 300 requests a minute. Workers will happily fire all
// 200 at once, so cap the concurrency rather than getting rate limited.
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// ---------------------------------------------------------------- the registry

// Robinhood deploys every tokenized stock from one contract and emits an event per
// token, so the complete list comes from the issuer rather than a guessed ticker list.
async function buildRegistry(env) {
  const seen = new Set();
  const out = [];
  let url = `${env.EXPLORER_API}/addresses/${env.STOCK_FACTORY}/logs`;
  for (let page = 0; page < 40 && url; page++) {
    const d = await getJSON(url);
    const items = d?.items || [];
    if (!items.length) break;
    for (const it of items) {
      const call = it?.decoded?.method_call || "";
      if (!call.startsWith("Deployed(")) continue;
      const p = Object.fromEntries((it.decoded.parameters || []).map((x) => [x.name, x.value]));
      const a = (p.stock || "").toLowerCase();
      const sym = (p.symbol || "").trim().toUpperCase();
      if (!a || !sym || seen.has(a)) continue;
      seen.add(a);
      out.push({ t: sym, a: p.stock, name: p.name || sym });
    }
    const np = d?.next_page_params;
    url = np ? `${env.EXPLORER_API}/addresses/${env.STOCK_FACTORY}/logs?${new URLSearchParams(np)}` : null;
    await sleep(120);
  }
  out.sort((x, y) => (x.t < y.t ? -1 : 1));
  if (out.length) await env.SY.put(KEY.registry, JSON.stringify(out));
  return out;
}

// ---------------------------------------------------------------- longbow

// Dexscreener's token-pairs endpoint caps at ~30 pools, so behind a busy ticker
// most of the roster never reaches us. Longbow runs a launchpad for exactly
// these coins and publishes an index that is not truncated, which roughly
// triples what we can see. It is only a hint: a coin still reaches the map only
// once Dexscreener confirms a real pool against a real tokenized stock.
const LONGBOW_PAD = { long: "Long", pair: "Pair.fund", pons: "Pons" };

async function refreshLongbow(env) {
  const [pools, launched] = await Promise.all([
    getJSON("https://longbow.gg/api/pools"),
    getJSON("https://longbow.gg/api/longbow"),
  ]);
  const coins = pools?.coins || [];
  if (!coins.length) return { ok: false, why: "no longbow data" };

  const anchors = {};
  const pads = {};
  for (const c of coins) {
    const a = (c.address || "").toLowerCase();
    const anchor = (c.anchorAddress || "").toLowerCase();
    if (!a || !anchor) continue;
    (anchors[anchor] ||= []).push(a);
    const pad = LONGBOW_PAD[(c.launchpad || "").toLowerCase()];
    if (pad) pads[a] = pad;
  }
  // a coin Longbow launched is Longbow's, whatever the name heuristics guess
  for (const c of launched?.coins || []) {
    const a = (c.address || "").toLowerCase();
    if (a) pads[a] = "Longbow";
  }

  await env.SY.put(KEY.longbow, JSON.stringify(anchors));

  const known = JSON.parse((await env.SY.get(KEY.pads)) || "{}");
  let added = 0;
  for (const [a, pad] of Object.entries(pads)) {
    if (known[a] !== pad && (pad === "Longbow" || !known[a])) { known[a] = pad; added++; }
  }
  if (added) await env.SY.put(KEY.pads, JSON.stringify(known));

  return { ok: true, memes: coins.length, anchors: Object.keys(anchors).length, padsAdded: added };
}

/**
 * Ask Dexscreener about every coin Longbow names, once, in batches of 30.
 * Batching per stock wasted half of each request on anchors with a short tail;
 * doing it globally cuts the crawl by roughly a hundred requests.
 * Returns anchor address -> the pairs riding it.
 */
async function longbowTail(env, reg) {
  const lb = JSON.parse((await env.SY.get(KEY.longbow)) || "{}");
  const inReg = new Set(reg.map((e) => (e.a || "").toLowerCase()));
  const want = new Set();
  for (const [anchor, list] of Object.entries(lb)) {
    if (inReg.has(anchor)) for (const a of list) want.add(a);
  }

  const addrs = [...want];
  const byAnchor = new Map();
  for (let i = 0; i < addrs.length; i += 30) {
    const d = await getJSON(
      `https://api.dexscreener.com/latest/dex/tokens/${addrs.slice(i, i + 30).join(",")}`);
    for (const p of d?.pairs || []) {
      const q = (p.quoteToken?.address || "").toLowerCase();
      if (!inReg.has(q)) continue;
      if (!byAnchor.has(q)) byAnchor.set(q, []);
      byAnchor.get(q).push(p);
    }
  }
  return byAnchor;
}

// ---------------------------------------------------------------- pools

// Every pool where this stock token is the quote is a memecoin riding it. The
// token-pairs endpoint caps at ~30 pools, so the searches fill in the long tail.
function absorb(memes, pairs, addr) {
  const now = Date.now();
  for (const p of pairs || []) {
    if (p.chainId && p.chainId !== "robinhood") continue;
    const b = p.baseToken || {};
    const q = p.quoteToken || {};
    if ((q.address || "").toLowerCase() !== addr.toLowerCase()) continue;
    const sym = b.symbol;
    if (!sym || sym.length > 18) continue;
    const up = sym.toUpperCase();
    if (QUOTES.has(up) || NOT_MEMES.has(up)) continue;
    const key = (b.address || sym).toLowerCase();

    let m = memes.get(key);
    if (!m) {
      m = {
        s: sym, a: b.address, l: 0, v: 0, tx: 0,
        cs: [null, null, null, null], vs: [0, 0, 0, 0],
        _cn: [0, 0, 0, 0], _cw: [0, 0, 0, 0],
        mc: p.marketCap || 0, x: null, w: null, age: null,
        img: p.info?.imageUrl || null, u: p.url || null, seen: new Set(),
      };
      memes.set(key, m);
    }
    const pid = p.pairAddress || Math.random();
    if (m.seen.has(pid)) continue;
    m.seen.add(pid);

    const liq = p.liquidity?.usd || 0;
    m.l += liq;
    m.v += p.volume?.h24 || 0;
    m.tx += (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);
    ["m5", "h1", "h6", "h24"].forEach((k, i) => {
      m.vs[i] += p.volume?.[k] || 0;
      const c = p.priceChange?.[k];
      if (c != null && liq) { m._cn[i] += c * liq; m._cw[i] += liq; }
    });
    if (!m.img && p.info?.imageUrl) m.img = p.info.imageUrl;
    if (!m.u && p.url) m.u = p.url;
    for (const s of p.info?.socials || []) if (s.type === "twitter" && !m.x) m.x = s.url;
    for (const w of p.info?.websites || []) if (!m.w) m.w = w.url;
    if (p.pairCreatedAt) {
      const days = Math.round(((now - p.pairCreatedAt) / 86400000) * 10) / 10;
      m.age = m.age == null ? days : Math.min(m.age, days);
    }
    if ((p.marketCap || 0) > (m.mc || 0)) m.mc = p.marketCap;
  }
}

async function stockRow(entry, tailPairs = null) {
  const { t, a: addr } = entry;
  const memes = new Map();
  let sl = 0, sv = 0, price = null, img = null;

  const tp = await getJSON(`https://api.dexscreener.com/token-pairs/v1/robinhood/${addr}`);
  if (Array.isArray(tp)) {
    absorb(memes, tp, addr);
    for (const p of tp) {
      const b = p.baseToken || {}, q = p.quoteToken || {};
      if ((b.address || "").toLowerCase() === addr.toLowerCase() &&
          QUOTES.has((q.symbol || "").toUpperCase())) {
        sl += p.liquidity?.usd || 0;
        sv += p.volume?.h24 || 0;
        price = price || p.priceUsd;
        img = img || p.info?.imageUrl;
      }
    }
  }
  const bare = t.replace(/\./g, "");
  for (const query of [`${bare}%20robinhood`, `${bare}%20USDG`]) {
    const d = await getJSON(`https://api.dexscreener.com/latest/dex/search?q=${query}`);
    if (d?.pairs) absorb(memes, d.pairs, addr);
  }

  // the tail Dexscreener truncated, named by Longbow and already fetched
  if (tailPairs) absorb(memes, tailPairs, addr);

  const list = [...memes.values()].filter((m) => m.l >= MIN_LIQ);
  for (const m of list) {
    for (let i = 0; i < 4; i++) {
      m.cs[i] = m._cw[i] ? Math.round((m._cn[i] / m._cw[i]) * 10) / 10 : null;
      m.vs[i] = Math.round(m.vs[i]);
    }
    m.c = m.cs[3];
    delete m._cn; delete m._cw; delete m.seen;
    m.l = Math.round(m.l); m.v = Math.round(m.v); m.mc = Math.round(m.mc || 0);
  }
  list.sort((x, y) => y.l - x.l);

  const ml = list.reduce((s, m) => s + m.l, 0);
  const mv = list.reduce((s, m) => s + m.v, 0);
  const cs = [0, 1, 2, 3].map((i) => {
    let n = 0, d = 0;
    for (const m of list) if (m.cs[i] != null && m.l) { n += m.cs[i] * m.l; d += m.l; }
    return d ? Math.round((n / d) * 10) / 10 : null;
  });
  const vs = [0, 1, 2, 3].map((i) => list.reduce((s, m) => s + m.vs[i], 0));

  return {
    t, name: entry.name || t, a: addr, img, p: price,
    sl: Math.round(sl), sv: Math.round(sv),
    ml: Math.round(ml), mv: Math.round(mv),
    n: list.length, c: cs[3], cs, vs,
    // real liquidity, but almost nobody trading it
    orph: list.filter((m) => m.l > 2000 && m.tx < 20).length,
    m: list.slice(0, 14),
  };
}

// ---------------------------------------------------------------- share prices

// The intraday series lets the stock be compared over the same windows as the memes.
async function quote(t) {
  const d = await getJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=5m&range=1d`
  );
  const res = d?.chart?.result?.[0];
  if (!res) return { tp: null, tprev: null, scs: [null, null, null, null] };
  const px = res.meta?.regularMarketPrice ?? null;
  const prev = res.meta?.chartPreviousClose ?? res.meta?.previousClose ?? null;
  const closes = (res.indicators?.quote?.[0]?.close || []).filter((c) => c != null);
  const back = (n) => {
    if (!closes.length || px == null) return null;
    const ref = closes.length > n ? closes[closes.length - n] : closes[0];
    return ref ? Math.round((px / ref - 1) * 10000) / 100 : null;
  };
  // 5-minute bars: 1 back is five minutes, 12 an hour, 72 six hours
  return {
    tp: px, tprev: prev,
    scs: [back(1), back(12), back(72), px && prev ? Math.round((px / prev - 1) * 10000) / 100 : null],
  };
}

// ---------------------------------------------------------------- jobs

async function refreshPools(env, force = false) {
  const reg = JSON.parse((await env.SY.get(KEY.registry)) || "[]");
  if (!reg.length) return { ok: false, why: "no registry yet" };

  // Two crawls at once each get half of Dexscreener's budget and both come back
  // short, which is how the snapshot started oscillating. One at a time.
  const now = Date.now();
  const until = Number((await env.SY.get(KEY.lock)) || 0);
  if (!force && until > now) {
    return { ok: false, why: "a refresh is already running", freeAt: new Date(until).toISOString() };
  }
  await env.SY.put(KEY.lock, String(now + 9 * 60 * 1000), { expirationTtl: 600 });

  _lost = _lost429 = _lostBad = _lostErr = 0;
  const tail = await longbowTail(env, reg);
  const rows = await pooled(reg, 6, (e) => stockRow(e, tail.get((e.a || "").toLowerCase())));
  const pads = JSON.parse((await env.SY.get(KEY.pads)) || "{}");
  const resolved = await resolveNewPads(env, rows, pads);
  for (const r of rows) for (const m of r.m) {
    const pad = pads[(m.a || "").toLowerCase()];
    if (pad) m.lp = pad;
  }

  // carry forward the share prices, which run on their own slower schedule
  const prev = JSON.parse((await env.SY.get(KEY.snapshot)) || "null");
  if (prev) {
    const byT = new Map(prev.rows.map((r) => [r.t, r]));
    for (const r of rows) {
      const old = byT.get(r.t);
      if (!old) continue;
      r.tp = old.tp; r.tprev = old.tprev; r.scs = old.scs; r.dp = old.dp;
    }
  }

  rows.sort((a, b) => b.ml - a.ml);
  const blob = { asOf: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", rows };
  await env.SY.put(KEY.snapshot, JSON.stringify(blob));
  await env.SY.put(KEY.lock, "0", { expirationTtl: 60 });

  const stats = {
    ok: true, stocks: rows.length,
    memes: rows.reduce((s, r) => s + r.n, 0),
    padsResolved: resolved,
    padsKnown: Object.keys(pads).length,
    // requests Dexscreener never answered. Anything above zero means the
    // snapshot is missing part of some roster.
    droppedRequests: _lost,
    dropReasons: { rateLimited: _lost429, badStatus: _lostBad, network: _lostErr },
    // a cron run has nowhere to return this to, so keep it where we can read it
    trigger: force ? "manual" : "cron",
    startedAt: new Date(now).toISOString(),
    tookSeconds: Math.round((Date.now() - now) / 1000),
  };
  await env.SY.put(KEY.lastRun, JSON.stringify(stats));
  return stats;
}

async function refreshQuotes(env) {
  const blob = JSON.parse((await env.SY.get(KEY.snapshot)) || "null");
  if (!blob) return { ok: false, why: "no snapshot yet" };

  const qs = await pooled(blob.rows, 6, (r) => quote(r.t));
  const kept = [];
  blob.rows.forEach((r, i) => {
    const { tp, tprev, scs } = qs[i];
    r.tp = tp; r.tprev = tprev; r.scs = scs; r.dp = null;
    const on = parseFloat(r.p || 0);
    if (tp && on) {
      const ratio = on / tp;
      // A tokenized stock tracks its share. A wild gap means the ticker matched a
      // memecoin of the same name, not the stock token.
      if (ratio > 1.35 || ratio < 0.74) return;
      // a price off a near-empty pool is noise, not a peg reading
      if ((r.sl || 0) >= 25000) r.dp = Math.round((ratio - 1) * 10000) / 100;
    }
    kept.push(r);
  });

  blob.rows = kept;
  blob.asOf = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  await env.SY.put(KEY.snapshot, JSON.stringify(blob));

  // one snapshot a day, kept for a month, so charts get a real history
  const day = new Date().toISOString().slice(0, 10);
  await env.SY.put(
    KEY.history(day),
    JSON.stringify(kept.map((r) => ({ t: r.t, ml: r.ml, mv: r.mv, n: r.n, top: r.m[0]?.s || null }))),
    { expirationTtl: 60 * 60 * 24 * 31 }
  );
  return { ok: true, quoted: kept.length, dropped: blob.rows.length - kept.length };
}

// ---------------------------------------------------------------- worker

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    if (cron === "23 6 * * *")
      ctx.waitUntil(buildRegistry(env).then(() => refreshLongbow(env)).then(() => refreshPools(env)));
    else if (cron === "7 * * * *") ctx.waitUntil(refreshQuotes(env));
    else ctx.waitUntil(refreshPools(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/map.json") {
      const blob = await env.SY.get(KEY.snapshot);
      if (!blob) return json({ error: "no snapshot yet" }, 503);
      return new Response(blob, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=60, s-maxage=60",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // manual kick, handy before the first cron fires
    if (url.pathname === "/api/status") {
      return json({
        lastRun: JSON.parse((await env.SY.get(KEY.lastRun)) || "null"),
        lockUntil: Number((await env.SY.get(KEY.lock)) || 0) || null,
      });
    }

    if (url.pathname === "/api/refresh") {
      const job = url.searchParams.get("job");
      const run = job === "registry" ? buildRegistry(env)
                : job === "quotes"   ? refreshQuotes(env)
                : job === "longbow"  ? refreshLongbow(env)
                : refreshPools(env, url.searchParams.get("force") === "1");
      return json(await run);
    }

    // Cloudflare's asset handler omits the charset on HTML, which mangles any
    // character above ASCII in the page. Put it back.
    const res = await env.ASSETS.fetch(req);
    const ct = res.headers.get("content-type") || "";
    if (ct.startsWith("text/html") && !ct.includes("charset")) {
      const out = new Response(res.body, res);
      out.headers.set("content-type", "text/html; charset=utf-8");
      return out;
    }
    return res;
  },
};

const json = (o, status = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
