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

// Dexscreener answers the batch token endpoint with at most thirty pairs, however
// many addresses were asked about. Four deep tokens fill that on their own.
const DS_PAIR_CAP = 30;
// How many to ask about at once. Thirty saturates often enough that re-asking
// the halves costs more than the bigger batch saved: measured over 224 real
// addresses it is 0.16 requests each at thirty against 0.13 at sixteen, and
// sixteen saturates half as often. Six is worse again, for the obvious reason.
const TAIL_BATCH = 16;
// and a ceiling, so a run of coins that all turn out to be deep cannot eat a
// crawl. At the rate above the whole roster is about four hundred, so this is
// headroom rather than a budget: reaching it means something has changed.
const TAIL_ASKS = 600;
// what the splitting actually cost, because a guess at it is not worth having
let _tailAsks = 0;

// Parked money. A pool holding real liquidity that nobody traded one percent of
// in a day is not a market, it is a deposit. The distinction matters because the
// biggest of them dwarfs everything real on the chain: one $22M pool with sixteen
// trades in it was 27% of every dollar this map reported, and it decided which
// stock led the page. Parked coins stay in the roster, but they do not count as
// liquidity riding a stock and they never speak for one.
const PARKED_LIQ = 2000;     // below this, a dead pool is too small to distort anything
const PARKED_TURN = 0.01;    // 24h volume as a share of liquidity
const parked = (m) => m.l >= PARKED_LIQ && m.v < m.l * PARKED_TURN;

// One-sided money. Uniswap's own term: a position whose range excludes the
// current price is "out of range" and "single-sided", holding one token and not
// the other. Uniswap shows it per position, we need it per pool and per stock,
// and neither aggregator does that. Dexscreener's API carries both side amounts
// but its UI only ever shows the two added together, and GeckoTerminal publishes
// one reserve_in_usd total and does not index this chain anyway.
//
// The exact test is whether the pool's current tick sits inside a position's
// range. That is an RPC call per pool against the v4 PoolManager, which the
// crawl cannot afford across 1,600 coins, so the reserves are the cheap proxy
// for it: a pool out of range holds one asset, and that shows up as a stock
// side of nothing.
//
// Liquidity is two assets, and the whole claim of this map is
// that a meme pool is demand for the stock it rides. A pool whose stock side has
// been bought out holds none of it. SHROOM/MRNA is $46k of liquidity and 187
// trades against 0.0002 MRNA: a real market, still buyable with the share, but
// not one dollar of MRNA is locked in it. Counting it as stock riding MRNA is
// counting SHROOM twice. So read the stock side of every pool and say what is
// actually there.
//
// This is a reading, not a property. Concentrated liquidity holds one asset at
// the edge of its range, so a pool empty of the stock today can hold it again
// tomorrow on a price move alone. The flag says what the pool is holding now,
// which is the only thing anyone can trade against now.
// The line is where the data puts it, not where it looked round. Across 511
// measured pools the stock side is bimodal: 73 sit under a tenth of a percent,
// 220 sit near half, and between them is a thin even smear with no structure in
// it. The spike decays out by about half a percent, so that is the cut. 2% swept
// in fifty more pools that are thin rather than empty, which is a different
// thing and not one this flag should be claiming.
const ONESIDED = 0.005;      // stock side as a share of the pool
// and only trust the verdict once most of a coin's liquidity has been read: a
// coin carried in from Longbow has no reserves at all, which is not the same
// thing as a coin whose reserves are empty
const SIDES_SEEN = 0.5;

// A token's launchpad never changes, so it is resolved once and cached forever.
// Known launcher and deployer contracts, keyed by address.
const PADS = {
  "0x22e99278308b393ea1260859b181ad7e78f5eeed": "Long",
  "0x3711cea4feade896c913c68f01eda97cb06d1a42": "Pons",
  "0x8660a7f019c7943b0b0a91b8e39aff3b6db6ae62": "Pair.fund",
  "0x18e674231a58c239dc7daedcffe15ec3a24cff5c": "Hookr",
  "0x6544af3524a8d9135eb5765cece6e514d85d615b": "o1",
  // o1's factory. Onchain it is called RWAERC20LaunchpadFactory, which names the
  // asset class and not the operator, so the label used to be a guess. Every coin
  // it launches carries the answer in its own contractURI: {"launchpad":"o1
  // Launchpad","launchpadUrl":"https://launch.o1.exchange"}, identical across the
  // twelve largest, launched by twelve different wallets. o1.exchange is a live
  // trading terminal, @o1_exchange.
  "0xe64ac4113848bbc1a6dde1a6d1da96720a36f297": "o1",
  // airlocks.xyz, verified onchain as AirlockLaunchpad and named as the launchpad
  // by the site's own frontend config.
  "0x6215f027cd66410c3a0cb5548036698e8b7cf1dd": "Airlock",
  // Doppler's core contract is also called Airlock, and a coin that went through
  // it is not an airlocks.xyz coin. Naming the address keeps the two apart: without
  // this the contract's name wins and both pads read "Airlock".
  "0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862": "Doppler",
};
// Doppler is shared plumbing several pads build on, so it never names the pad itself
const SHARED = new Set(["0x1b37d3a72082029c44b35b604ea473617580b69a"]);
const PLUMBING = new Set(["0x0000000071727de22e5e9d8baf0edac6f37da032"]); // ERC-4337 entry point
const PAD_PREFIX = [["pons", "Pons"], ["long", "Long"], ["hookr", "Hookr"],
                    // every RWA*Launchpad contract on this chain is o1's, see above
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
// ---------------------------------------------------------------- logos

// Dexscreener only carries a logo for a coin someone paid it to enhance, which is
// under a third of the map, so the rest of the page was initials in grey boxes.
// Two sources fill it in, and they sit on opposite sides on purpose:
//
//   Longbow publishes a logo for nearly every coin it launched, from a plain JSON
//   endpoint. Those are taken here and cached in KV, so they ship with the snapshot.
//
//   LONG stores one for most coins on the chain, whatever pad launched them, at
//   storage.long.xyz/tokens/<address>.<ext>. That host refuses every server-side
//   request: a Worker, and curl carrying a complete browser header set, both get
//   the same 403 bot page, so the block is on the connection rather than the
//   headers and there is nothing to spoof. A real browser is served normally, so
//   the page walks the three extensions itself and the Worker does not try. This
//   was measured before it was relied on: 293 of the 319 coins with no Dexscreener
//   logo have one there, which is the difference between a third of the map and
//   nearly all of it.

const KEY = {
  snapshot: "snapshot",       // what the page reads
  registry: "registry",       // every tokenized stock, from the issuer
  pads: "launchpads",         // token address -> launchpad, resolved once and kept
  longbow: "longbow",         // anchor token -> the memes Longbow sees riding it
  lbstats: "lbstats",         // and what Longbow says each of them is worth
  images: "images",           // token address -> its logo, resolved once and kept
  history: (d) => `history:${d}`,
  chart: "chart",             // the dated snapshots rolled into one blob the page can read
  crawler: "crawler",         // heartbeat from the machine crawling off-platform
  lock: "lock:pools",         // held while a crawl runs, so ticks cannot overlap
  lastRun: "lastrun",         // stats from the most recent crawl, cron included
  chain: "chainpools",        // pools read off the chain, and how far back we have read
};

// ---------------------------------------------------------------- fetch helpers

// Dexscreener rate limits by IP, and a Worker's requests leave through Cloudflare's
// shared egress, so the budget is not ours alone: the same crawl that loses nothing
// from a laptop at 276 requests a minute lost 424 of ~700 from here. A fixed gate
// cannot see that happening, and three blind retries each turn one refusal into
// three more requests against a limit that is already full.
//
// So the gate widens when answers come back 429 and narrows again as they stop.
// Every concurrent fetch shares it, which is the point: they back off together
// rather than each retrying into the same wall.
// On Workers these are survival settings. Run the same crawl from an ordinary IP
// and none of it is needed: 90 requests at 276/min came back without a single
// refusal from a laptop while the Worker was losing 414 of 700 at a slower rate.
// So they are settings rather than constants, and the runner turns them off.
let PACE_MIN = 260, PACE_MAX = 1200, DEADLINE_MS = 6 * 60 * 1000;
export function setLimits({ pace, paceMax, deadlineMs } = {}) {
  if (pace) PACE_MIN = pace;
  if (paceMax) PACE_MAX = paceMax;
  if (deadlineMs) DEADLINE_MS = deadlineMs;
}
let _gate = 0, _pace = PACE_MIN, _throttles = 0;
let _lost = 0, _lost429 = 0, _lostBad = 0, _lostErr = 0, _lostLate = 0;
let _deadline = Infinity;

// Returns false when this call's slot in the queue falls past the deadline. That
// matters more than it looks: the last time this crawl slept its way through a
// rate limit the run outlived its own cron interval and was cancelled, losing
// everything it had. Backing off is only safe while something still enforces an
// end, so the gate refuses to hand out a slot it cannot reach in time and the
// caller gives up rather than sleeping into the void.
async function paced() {
  const now = Date.now();
  const at = Math.max(now, _gate);
  if (at > _deadline) return false;
  _gate = at + _pace;
  if (at > now) await sleep(at - now);
  return true;
}
// a refusal: slow everyone down, and hold the gate shut long enough to matter
function throttled() {
  _throttles++;
  _pace = Math.min(PACE_MAX, Math.round(_pace * 1.4));
  _gate = Math.max(_gate, Date.now() + _pace * 3);
}
// answers are landing again, so give the pace back, slower than it was taken
function eased() {
  if (_pace > PACE_MIN) _pace = Math.max(PACE_MIN, Math.round(_pace * 0.95));
}

async function getJSON(url, tries = 3) {
  // Five tries with a rising backoff meant 61 rate-limited requests spent eight
  // minutes asleep, which is what pushed a run past its own cron interval and
  // got it cancelled. Two tries now, because the gate above absorbs the pressure
  // a third try used to add, and a roster we still lose is carried forward from
  // the last snapshot rather than published as a zero.
  const ds = url.includes("dexscreener");
  if (ds) tries = 2;
  const browser = url.includes("blockscout");
  const headers = browser
    ? { "User-Agent": BROWSER_UA, Accept: "application/json" }
    : { "User-Agent": UA };
  let last = "";
  for (let i = 0; i < tries; i++) {
    // pace every attempt, not just the first: an unpaced retry storm is what
    // pushes us back over the limit and loses the chunk for good
    if (ds && !(await paced())) { last = "deadline"; break; }
    try {
      const r = await fetch(url, { headers });
      if (r.status === 429) {
        last = "429";
        if (ds) throttled();
        continue;
      }
      if (r.ok) {
        if (ds) eased();
        return await r.json();
      }
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
    else if (last === "deadline") _lostLate++;
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
  // The factory emits Deployed(bytes32 uid, address stock, string name, string
  // symbol) once per tokenized stock, so its own log is the roster. Only uid is
  // indexed; the address and both strings sit in data.
  //
  // Read straight off the chain rather than through the explorer's index. The
  // factory has a couple of hundred logs in its whole life, so one address
  // filtered eth_getLogs answers for all of it: no paging, no window to walk.
  // The explorer went behind a challenge and started returning an interstitial
  // where the JSON used to be, which read here as a roster of nothing.
  const url = env.PUBLIC_RPC;
  if (!url) return [];

  let logs;
  try {
    const latest = await rpcCall(url, "eth_blockNumber", []);
    logs = await rpcCall(url, "eth_getLogs", [{
      fromBlock: "0x0", toBlock: latest, address: env.STOCK_FACTORY,
      topics: [DEPLOYED],
    }]);
  } catch { return []; }

  // the addresses already on file keep the casing they were stored with, so a
  // roster read a new way does not rewrite every row of the snapshot
  const was = new Map();
  for (const e of JSON.parse((await env.SY.get(KEY.registry)) || "[]")) {
    if (e.a) was.set(e.a.toLowerCase(), e.a);
  }

  const seen = new Set();
  const out = [];
  for (const l of logs || []) {
    const d = l.data || "";
    if (d.length < 2 + 3 * 64) continue;
    const a = "0x" + word(d, 0).slice(24);
    const name = abiString(d, parseInt(word(d, 1), 16));
    const sym = (abiString(d, parseInt(word(d, 2), 16)) || "").trim().toUpperCase();
    if (!sym || seen.has(a)) continue;
    seen.add(a);
    out.push({ t: sym, a: was.get(a) || a, name: name || sym });
  }

  out.sort((x, y) => (x.t < y.t ? -1 : 1));
  if (out.length) await env.SY.put(KEY.registry, JSON.stringify(out));
  return out;
}

// ---------------------------------------------------------------- longbow

// Dexscreener's token-pairs endpoint caps at ~30 pools, so behind a busy ticker
// most of the roster never reaches us. Longbow runs a launchpad for exactly
// these coins and publishes an index that is not truncated, in one request for
// the whole chain: 3,188 coins across 154 anchors, with liquidity, 24h volume
// and 24h move on each. Spot-checked against our own crawl it agrees inside
// timing noise, PEPTIDES at $173,591 against $177,091, EARN at $353,960 against
// $356,119, and it is Dexscreener-sourced anyway on 2,957 of those 3,188.
//
// So it is now more than a discovery hint: where Dexscreener returns a pool, that
// still wins, and where Dexscreener truncated the roster Longbow's numbers stand
// in rather than the coin being dropped. What it cannot do is replace Dexscreener,
// because it only carries a 24h window and the page sorts on four.
const LONGBOW_PAD = { long: "Long", pair: "Pair.fund", pons: "Pons" };

async function refreshLongbow(env) {
  const [pools, launched] = await Promise.all([
    getJSON("https://longbow.gg/api/pools"),
    getJSON("https://longbow.gg/api/longbow"),
  ]);
  const coins = pools?.coins || [];
  if (!coins.length) return { ok: false, why: "no longbow data" };

  const anchors = {};
  const stats = {};
  const pads = {};
  for (const c of coins) {
    const a = (c.address || "").toLowerCase();
    const anchor = (c.anchorAddress || "").toLowerCase();
    if (!a || !anchor) continue;
    (anchors[anchor] ||= []).push(a);
    const pad = LONGBOW_PAD[(c.launchpad || "").toLowerCase()];
    if (pad) pads[a] = pad;
    // the numbers, kept in the same shape a meme reaches the page in
    (stats[anchor] ||= []).push({
      a, s: c.symbol || "",
      l: Math.round(c.liquidity || 0),
      v: Math.round(c.vol24 || 0),
      c: typeof c.change24 === "number" ? Math.round(c.change24 * 10) / 10 : null,
      h1: typeof c.d1h === "number" ? c.d1h : null,
      mc: Math.round(c.fdv || 0),
    });
  }
  await env.SY.put(KEY.lbstats, JSON.stringify(stats));
  // a coin Longbow launched is Longbow's, whatever the name heuristics guess.
  // It also publishes a logo for nearly all of them, which is free and certain,
  // so take it rather than probing for one later.
  const logos = {};
  for (const c of launched?.coins || []) {
    const a = (c.address || "").toLowerCase();
    if (!a) continue;
    pads[a] = "Longbow";
    if (c.image) logos[a] = c.image;
  }

  const imgs = JSON.parse((await env.SY.get(KEY.images)) || "{}");
  let logosAdded = 0;
  for (const [a, url] of Object.entries(logos)) {
    if (!imgs[a]) { imgs[a] = url; logosAdded++; }
  }
  if (logosAdded) await env.SY.put(KEY.images, JSON.stringify(imgs));

  await env.SY.put(KEY.longbow, JSON.stringify(anchors));

  const known = JSON.parse((await env.SY.get(KEY.pads)) || "{}");
  let added = 0;
  for (const [a, pad] of Object.entries(pads)) {
    if (known[a] !== pad && (pad === "Longbow" || !known[a])) { known[a] = pad; added++; }
  }
  if (added) await env.SY.put(KEY.pads, JSON.stringify(known));

  return { ok: true, memes: coins.length, anchors: Object.keys(anchors).length,
           padsAdded: added, logosAdded };
}

/**
 * Ask Dexscreener about every coin the other sources name, once, in batches of
 * 30. Batching per stock wasted half of each request on anchors with a short
 * tail; doing it globally cuts the crawl by roughly a hundred requests.
 *
 * Three lists go in. Longbow's, which is the whole chain as Longbow sees it.
 * Every address the chain scan has already confirmed holds a pool, which is the
 * part that has to be asked about every run or it falls off the map. And a slice
 * of the queue the chain scan is still working through, which is what makes a
 * coin no indexer carries appear here at all.
 *
 * Returns anchor address -> the pairs riding it.
 */
async function longbowTail(env, reg) {
  const lb = JSON.parse((await env.SY.get(KEY.longbow)) || "{}");
  const inReg = new Set(reg.map((e) => (e.a || "").toLowerCase()));

  // The chain's addresses go first. Longbow's coins have three other ways onto
  // the map, the per-stock roster and both searches; these have this one. If the
  // ceiling below is ever reached it should land on the list that can afford it.
  const want = new Set();
  const st = JSON.parse((await env.SY.get(KEY.chain)) || "null");
  const asked = st ? st.q.slice(0, CHAIN_CONFIRM) : [];
  if (st) {
    for (const a of Object.keys(st.live)) want.add(a);
    for (const a of asked) want.add(a);
  }
  for (const [anchor, list] of Object.entries(lb)) {
    if (inReg.has(anchor)) for (const a of list) want.add(a);
  }

  const addrs = [...want];
  const byAnchor = new Map();
  // an address only counts as live once a pool of its own comes back, so the
  // queue drains into a verdict either way and never grows on a guess
  const confirmed = new Set();
  let asks = 0;
  const take = (p) => {
    // either side can be the stock, same as absorb
    const q = (p.quoteToken?.address || "").toLowerCase();
    const b = (p.baseToken?.address || "").toLowerCase();
    const anchor = inReg.has(q) ? q : inReg.has(b) ? b : null;
    if (!anchor) return;
    confirmed.add(anchor === q ? b : q);
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
    byAnchor.get(anchor).push(p);
  };
  const covered = new Set();
  const ask = async (list) => {
    if (!list.length || asks >= TAIL_ASKS) return;
    asks++;
    const d = await getJSON(
      `https://api.dexscreener.com/latest/dex/tokens/${list.join(",")}`);
    const pairs = d?.pairs || [];
    // A full answer is a truncated one. Asked about four tokens this endpoint
    // returned thirty pairs and none of RTRD's seven, because the deeper tokens
    // in the batch spent the whole allowance. The cap is on pairs, not on
    // addresses, so the batch size is only ever a guess at how many pools the
    // batch will turn out to have. Saturation is the only signal that the guess
    // was wrong, so split and ask again until an answer comes back short.
    if (pairs.length >= DS_PAIR_CAP && list.length > 1) {
      const half = Math.ceil(list.length / 2);
      await ask(list.slice(0, half));
      await ask(list.slice(half));
      return;
    }
    for (const p of pairs) take(p);
    // answered for, as opposed to merely queued behind a ceiling
    for (const a of list) covered.add(a);
  };
  for (let i = 0; i < addrs.length; i += TAIL_BATCH) {
    await ask(addrs.slice(i, i + TAIL_BATCH));
  }
  _tailAsks = asks;

  // The ones that turned out to hold a pool are kept and asked about every run
  // from here; the rest are dropped, so a queue of dead launches does not become
  // a permanent tax on the crawl. Only what was actually answered for leaves the
  // queue: draining on the slice instead would throw away, unasked, whatever the
  // ceiling stopped short of.
  if (st && asked.length) {
    let drained = 0;
    for (const a of asked) {
      if (!covered.has(a)) continue;
      drained++;
      if (confirmed.has(a)) st.live[a] = 1;
    }
    if (drained) {
      st.q = st.q.filter((a) => !covered.has(a));
      await env.SY.put(KEY.chain, JSON.stringify(st));
    }
  }
  return byAnchor;
}

// ---------------------------------------------------------------- the chain

/**
 * Where the roster actually comes from.
 *
 * Dexscreener's roster endpoint caps at thirty pools and does not rank them by
 * anything useful. Asked for RDDT it returned a pool holding $125 and left out
 * RTRD, which holds $20k and trades $220k a day. Both searches came back capped
 * too, and Longbow had never heard of it. Onchain RDDT has 462 pools against
 * 396 counterparties. No indexer is going to hand us that list.
 *
 * A pool announces itself when it opens, and every shape indexes both of its
 * tokens: Uniswap v4 puts them in Initialize, v2 in PairCreated, v3 in
 * PoolCreated. Matching on the topic instead of on a factory address means a pad
 * that deploys its own factory is picked up without anyone having to notice. On
 * one 60k-block window that is 925 v4 pools from a single manager, 146 v2 from
 * four factories and 21 v3 from three.
 *
 * Nothing here is trusted. An address found this way is only ever a question put
 * to Dexscreener, which decides whether a pool exists and what is in it. Anyone
 * can emit a lookalike event; the cost of one is a wasted lookup.
 */
const POOL_EVENTS = [
  // Initialize(PoolId id, Currency currency0, Currency currency1, ...)
  { topic: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438", at: [2, 3] },
  // PairCreated(address indexed token0, address indexed token1, address pair, uint)
  { topic: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9", at: [1, 2] },
  // PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, ...)
  { topic: "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118", at: [1, 2] },
];

// 900k blocks came back over the node's log limit and 300k returned four
// thousand pools in one answer. 50k is well inside both, and at a tenth of a
// second per block it is an hour and a half of chain.
const CHAIN_SPAN = 50000;
// New pools first, always. The backfill is whatever is left of the budget, and
// it walks down from wherever the last run stopped.
const CHAIN_WINDOWS = 1;
// Discovery is cheap and confirming is not, so the queue drains at a fixed rate
// rather than all at once. Dexscreener takes thirty addresses a request.
const CHAIN_CONFIRM = 600;

// The public RPC refuses a caller going flat out, which matters more here than
// it looks: a refused window that still moved the cursor would leave a hole in
// the history nothing ever goes back for. So it waits and asks again, and a
// window that will not answer is left where it is for the next run.
async function rpcCall(url, method, params, tries = 4) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 700 * i));
    let j;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!r.ok) { last = String(r.status); continue; }
      j = await r.json();
    } catch (e) { last = String(e.message).slice(0, 60); continue; }
    if (!j.error) return j.result;
    last = JSON.stringify(j.error).slice(0, 90);
    // a query too big for the node will be too big however often it is asked
    if (!/limit|rate|429|busy|timed out/i.test(last)) break;
  }
  throw new Error(`rpc ${method}: ${last}`);
}

// one window, all three pool shapes, addresses that pair with a stock we know.
// Answers whether it got through, because the caller only moves its cursor past
// a window every shape actually answered for.
// Deployed(bytes32,address,string,string) on the stock factory
const DEPLOYED = "0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6";

// the two bits of ABI decoding the roster needs: a 32 byte word, and a string
// read from the offset one of those words points at
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const abiString = (hex, off) => {
  const at = 2 + off * 2;
  const len = parseInt(hex.slice(at, at + 64), 16);
  if (!Number.isFinite(len) || len <= 0) return "";
  const body = hex.slice(at + 64, at + 64 + len * 2);
  // no Buffer here: this file runs in the Worker too, without nodejs_compat
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
};

async function scanWindow(url, from, to, inReg) {
  const found = new Set();
  let ok = true;
  for (const ev of POOL_EVENTS) {
    let logs;
    try {
      logs = await rpcCall(url, "eth_getLogs", [{
        fromBlock: "0x" + Math.max(0, from).toString(16),
        toBlock: "0x" + to.toString(16),
        topics: [ev.topic],
      }]);
    } catch { ok = false; continue; }
    for (const l of logs || []) {
      const a = ("0x" + (l.topics[ev.at[0]] || "").slice(26)).toLowerCase();
      const b = ("0x" + (l.topics[ev.at[1]] || "").slice(26)).toLowerCase();
      // one side has to be a stock and the other is then the coin riding it
      if (inReg.has(a) && !inReg.has(b)) found.add(b);
      else if (inReg.has(b) && !inReg.has(a)) found.add(a);
    }
  }
  return { found, ok };
}

/**
 * Walk the chain for pools, forward from the last run and then backward into
 * history, and keep the addresses. Returns nothing the crawl reads directly:
 * the list lands in KV and `longbowTail` asks Dexscreener about it.
 */
async function discoverPools(env, reg, windows = CHAIN_WINDOWS) {
  const url = env.PUBLIC_RPC;
  if (!url) return { ok: false, why: "no PUBLIC_RPC" };
  const inReg = new Set(reg.map((e) => (e.a || "").toLowerCase()));

  const st = JSON.parse((await env.SY.get(KEY.chain)) || "null")
    || { head: 0, tail: 0, q: [], live: {} };
  st.q ||= []; st.live ||= {};

  let latest;
  try { latest = parseInt(await rpcCall(url, "eth_blockNumber", []), 16); }
  catch (e) { return { ok: false, why: String(e.message).slice(0, 80) }; }

  const queued = new Set(st.q);
  let added = 0;
  const keep = (found) => {
    for (const a of found) {
      if (st.live[a] || queued.has(a)) continue;
      queued.add(a); st.q.push(a); added++;
    }
  };

  // first run has no cursor, so it starts at the head and digs from there
  if (!st.head) { st.head = st.tail = latest; }

  // forward: everything opened since the last run. Usually one small window.
  let forward = 0, missed = 0;
  if (latest > st.head) {
    for (let from = st.head; from < latest; from += CHAIN_SPAN) {
      const to = Math.min(latest, from + CHAIN_SPAN);
      const w = await scanWindow(url, from, to, inReg);
      keep(w.found);
      if (!w.ok) { missed++; break; }   // leave the cursor, come back for it
      st.head = to;
      forward++;
      if (forward >= 20) break;   // a long outage catches up over several runs
    }
  }

  // backward: the history, a window at a time, until it reaches the genesis end
  let back = 0;
  while (back < windows && st.tail > 0) {
    const to = st.tail;
    const from = Math.max(0, to - CHAIN_SPAN);
    const w = await scanWindow(url, from, to, inReg);
    keep(w.found);
    if (!w.ok) { missed++; break; }
    st.tail = from;
    back++;
  }

  await env.SY.put(KEY.chain, JSON.stringify(st));
  return {
    ok: true, added, missed, queued: st.q.length, live: Object.keys(st.live).length,
    head: st.head, tail: st.tail,
    backfilled: st.tail === 0 ? 1 : Math.round(((latest - st.tail) / latest) * 100) / 100,
  };
}

// ---------------------------------------------------------------- pools

// Every pool pairing this stock token with a memecoin is that meme riding it.
// Dexscreener picks which side is base and which is quote, and once a meme gets
// deep enough to be quoted against itself the orientation flips: LLY/FATCOIN is
// filed with the stock as the base. Reading only the quote side lost those pools
// entirely, including the two largest live markets on the chain. So match either
// side, and when the meme is the quote, read the pair backwards.
//
// The token-pairs endpoint caps at ~30 pools, so the searches fill in the tail.
function absorb(memes, pairs, addr, reg) {
  const now = Date.now();
  const want = addr.toLowerCase();
  for (const p of pairs || []) {
    if (p.chainId && p.chainId !== "robinhood") continue;
    const base = p.baseToken || {};
    const quote = p.quoteToken || {};
    const ba = (base.address || "").toLowerCase();
    const qa = (quote.address || "").toLowerCase();
    // the stock has to be one of the two sides, and only one of them
    const flipped = ba === want;
    if (!flipped && qa !== want) continue;
    const b = flipped ? quote : base;
    // both sides in the registry is a stock traded against a stock, not a meme
    if (reg && reg.has(flipped ? qa : ba)) continue;
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
        mc: 0, x: null, w: null, age: null,
        img: null, u: p.url || null, seen: new Set(), _inv: 0,
        // shares of the stock sitting in this coin's pools, and the liquidity
        // we were able to read a side of at all
        _sa: 0, _sal: 0,
      };
      memes.set(key, m);
    }
    const pid = p.pairAddress || Math.random();
    if (m.seen.has(pid)) continue;
    m.seen.add(pid);

    const liq = p.liquidity?.usd || 0;
    m.l += liq;
    // How much of the stock this pool is actually holding, counted in shares.
    // Taking it as dollars off liquidity.usd looked simpler and was wrong: that
    // total is the base side plus whatever Dexscreener could price, so a quote
    // it cannot price reads as an empty pool. The side amounts are reserves and
    // mean the same thing whoever is base. Priced later, where the row knows
    // what a share costs.
    const sa = flipped ? p.liquidity?.base : p.liquidity?.quote;
    if (liq > 0 && sa != null && Number.isFinite(Number(sa))) {
      m._sa += Number(sa);
      m._sal += liq;
    }
    m.v += p.volume?.h24 || 0;
    m.tx += (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);
    ["m5", "h1", "h6", "h24"].forEach((k, i) => {
      m.vs[i] += p.volume?.[k] || 0;
      // a price move is the base side's, so on a flipped pair it is the stock
      // moving against the meme. The meme's own move is the inverse. Past a 99%
      // move either way the reciprocal is arithmetic on a rounding error rather
      // than a price, so there is nothing to invert.
      let c = p.priceChange?.[k];
      if (c != null && flipped) {
        const r = 1 + c / 100;
        c = r >= 0.01 && r <= 100 ? (1 / r - 1) * 100 : null;
      }
      // Dexscreener sometimes reports a move no pool can hold. A day-old $1.6k
      // pool that traded $47 came back at +5.75e20%, and a single one of those
      // in a liquidity-weighted average put +14220078066% on the whole AMZN row.
      // A thousandfold in a day is already past anything real on this chain.
      if (c != null && !(Number.isFinite(c) && Math.abs(c) <= 1e5)) c = null;
      if (c != null && liq) { m._cn[i] += c * liq; m._cw[i] += liq; }
    });
    if (!m.u && p.url) m.u = p.url;
    if (p.pairCreatedAt) {
      const days = Math.round(((now - p.pairCreatedAt) / 86400000) * 10) / 10;
      m.age = m.age == null ? days : Math.min(m.age, days);
    }
    // marketCap, the logo and the socials all describe the base token, so on a
    // flipped pair they belong to the stock. Taking them there would have put
    // Eli Lilly's market cap and logo on FATCOIN. Enrich those separately.
    if (flipped) { m._inv++; continue; }
    if (!m.img && p.info?.imageUrl) m.img = p.info.imageUrl;
    for (const s of p.info?.socials || []) if (s.type === "twitter" && !m.x) m.x = s.url;
    for (const w of p.info?.websites || []) if (!m.w) m.w = w.url;
    // No FDV here, though it was tried. Market cap counts circulating supply and
    // FDV counts all of it, so the gap is supply that has not landed. On this
    // chain there is no gap: across 296 pairs FDV equalled market cap every
    // time, because these are fixed-supply launches. A column that is provably
    // always a copy of the one beside it is not worth the width.
    if ((p.marketCap || 0) > (m.mc || 0)) m.mc = p.marketCap;
  }
}

/**
 * A meme only ever seen as the quote side has no market cap, logo or socials yet,
 * because everything Dexscreener attaches to a pair describes its base token. It
 * is a handful of coins, so one batched lookup of their own pools fills them in.
 */
async function enrichFlipped(rows) {
  const need = new Map();
  for (const r of rows) for (const m of r.m) {
    if (!m._inv) continue;
    const a = (m.a || "").toLowerCase();
    if (!a) continue;
    if (!need.has(a)) need.set(a, []);
    need.get(a).push(m);
  }
  const addrs = [...need.keys()];
  for (let i = 0; i < addrs.length; i += 30) {
    const d = await getJSON(
      `https://api.dexscreener.com/latest/dex/tokens/${addrs.slice(i, i + 30).join(",")}`);
    for (const p of d?.pairs || []) {
      const a = (p.baseToken?.address || "").toLowerCase();
      const list = need.get(a);
      if (!list) continue;
      for (const m of list) {
        if ((p.marketCap || 0) > (m.mc || 0)) m.mc = Math.round(p.marketCap);
        if (!m.img && p.info?.imageUrl) m.img = p.info.imageUrl;
        for (const s of p.info?.socials || []) if (s.type === "twitter" && !m.x) m.x = s.url;
        for (const w of p.info?.websites || []) if (!m.w) m.w = w.url;
      }
    }
  }
  for (const r of rows) for (const m of r.m) delete m._inv;
}

// Everything Dexscreener returned is already in `memes`. This adds the coins it
// never showed us, with Longbow's numbers, and touches nothing that Dexscreener
// did return: a confirmed pool always beats a published one. The filled-in coins
// carry a 24h window only, which is what they are worth to the page anyway since
// only the top of a roster is ever drawn.
function fillFromLongbow(memes, coins) {
  let added = 0;
  for (const c of coins || []) {
    if (!c.a || memes.has(c.a) || !c.l) continue;
    if (NOT_MEMES.has((c.s || "").toUpperCase())) continue;
    const m = {
      s: c.s, a: c.a, l: c.l, v: c.v, tx: 0,
      cs: [null, null, null, null], vs: [0, 0, c.h1 != null ? 0 : 0, c.v],
      _cn: [0, 0, 0, 0], _cw: [0, 0, 0, 0],
      mc: c.mc || 0, x: null, w: null, age: null,
      img: null, u: null, seen: new Set(), _lb: 1,
      _sa: 0, _sal: 0,
    };
    // go through the same weighted average the crawled coins do, so one code
    // path decides what a move is worth
    if (c.c != null) { m._cn[3] = c.c * c.l; m._cw[3] = c.l; }
    if (c.h1 != null) { m._cn[1] = c.h1 * c.l; m._cw[1] = c.l; }
    memes.set(c.a, m);
    added++;
  }
  return added;
}

async function stockRow(entry, tailPairs = null, reg = null, lbCoins = null) {
  const { t, a: addr } = entry;
  const memes = new Map();
  let sl = 0, sv = 0, price = null, img = null;
  // what this ticker asked for and did not get. A roster assembled from a
  // refused request is short by an unknown amount, so the caller needs to know
  // rather than publishing whatever came back.
  let lost = 0;
  // past the deadline this ticker is not crawled at all. It still has to be a
  // complete row, because everything downstream reads m and the totals.
  if (Date.now() > _deadline) {
    return {
      t, name: entry.name || t, a: addr, img: null, p: null,
      sl: 0, sv: 0, ml: 0, mv: 0, pl: 0, sk: null, no: 0, n: 0, nq: 0,
      c: null, cs: [null, null, null, null], vs: [0, 0, 0, 0], m: [], lost: 3,
    };
  }

  const tp = await getJSON(`https://api.dexscreener.com/token-pairs/v1/robinhood/${addr}`);
  if (!Array.isArray(tp)) lost++;
  if (Array.isArray(tp)) {
    absorb(memes, tp, addr, reg);
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
    if (d?.pairs) absorb(memes, d.pairs, addr, reg);
    else lost++;
  }

  // the tail Dexscreener truncated, named by Longbow and already fetched
  if (tailPairs) absorb(memes, tailPairs, addr, reg);
  // and the rest of that tail, which Dexscreener never showed us at all
  const fromLb = fillFromLongbow(memes, lbCoins);

  const list = [...memes.values()].filter((m) => m.l >= MIN_LIQ);
  const px = Number(price) || 0;
  for (const m of list) {
    for (let i = 0; i < 4; i++) {
      m.cs[i] = m._cw[i] ? Math.round((m._cn[i] / m._cw[i]) * 10) / 10 : null;
      m.vs[i] = Math.round(m.vs[i]);
    }
    m.c = m.cs[3];
    // the stock this coin actually holds, in dollars. Reported only once the
    // pools we read cover most of its liquidity, so silence is unread rather
    // than empty, and only with a share price to value it against.
    if (px && m._sal > 0 && m._sal >= m.l * SIDES_SEEN) {
      const held = m._sa * px;
      m.sk = Math.round(held);
      if (held < m._sal * ONESIDED) m.o = 1;
    }
    delete m._sa; delete m._sal;
    delete m._cn; delete m._cw; delete m.seen;
    if (!m._inv) delete m._inv;
    if (!m._lb) delete m._lb;
    m.l = Math.round(m.l); m.v = Math.round(m.v); m.mc = Math.round(m.mc || 0);
  }
  for (const m of list) if (parked(m)) m.q = 1;
  // live coins first, then by liquidity. A parked pool can be the deepest on a
  // ticker and still not be the one that won it, so it never takes the podium.
  list.sort((x, y) => (x.q || 0) - (y.q || 0) || y.l - x.l);

  const live = list.filter((m) => !m.q);
  const ml = live.reduce((s, m) => s + m.l, 0);
  const mv = live.reduce((s, m) => s + m.v, 0);
  // weight the ticker's move by the pools that actually trade. Weighting it by a
  // parked pool means a price nobody paid moves the whole row.
  const cs = [0, 1, 2, 3].map((i) => {
    let n = 0, d = 0;
    for (const m of live) if (m.cs[i] != null && m.l) { n += m.cs[i] * m.l; d += m.l; }
    return d ? Math.round((n / d) * 10) / 10 : null;
  });
  const vs = [0, 1, 2, 3].map((i) => live.reduce((s, m) => s + m.vs[i], 0));

  return {
    t, name: entry.name || t, a: addr, img, p: price,
    sl: Math.round(sl), sv: Math.round(sv),
    ml: Math.round(ml), mv: Math.round(mv),
    // liquidity sitting in pools nobody trades, reported rather than hidden
    pl: Math.round(list.reduce((s, m) => s + (m.q ? m.l : 0), 0)),
    // the stock itself, locked inside meme pools. Float capture, in dollars.
    // Parked pools count here where they do not count as market: money nobody
    // trades is still money nobody can sell, and the share is still in it.
    sk: Math.round(list.reduce((s, m) => s + (m.sk || 0), 0)),
    // coins on this row whose stock side has been bought out entirely
    no: list.filter((m) => m.o).length,
    n: live.length, nq: list.length - live.length,
    c: cs[3], cs, vs,
    m: list.slice(0, 14),
    // coins on this row standing on Longbow's numbers rather than a pool we saw
    lb: list.filter((m) => m._lb).length,
    lost,
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

// This egress cannot crawl 203 tickers in a ten minute tick. Measured from a
// Worker, roughly 350 Dexscreener requests land before the refusals take over,
// and crawling everything wants 700. Trying anyway did not produce a fresher
// page, it produced a wrong one: one run left 109 rows stale holding $54.4M of
// the $56.4M on the page, every visible row among them, with no way to tell.
//
// The whole registry is crawled every tick. What changed is the order, and that
// turns out to decide the outcome: the deadline cuts whatever is left when the
// budget runs out, and until now that was whichever tickers the registry happened
// to list last. One run left 109 rows stale holding $54.4M of the $56.4M on the
// page, every visible row among them.
//
// Deepest first, so what the page shows is what gets crawled first and the tail is
// what goes short. New tickers jump the queue because there is no old row to fall
// back on if they are missed.
function crawlPlan(reg, prev) {
  const liq = new Map((prev?.rows || []).map((r) => [r.t, r.ml || 0]));
  const fresh = reg.filter((e) => !liq.has(e.t));
  const seen = reg.filter((e) => liq.has(e.t));
  seen.sort((a, b) => (liq.get(b.t) || 0) - (liq.get(a.t) || 0));
  return { list: [...fresh, ...seen] };
}

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

  _lost = _lost429 = _lostBad = _lostErr = _lostLate = _throttles = _tailAsks = 0;
  _pace = PACE_MIN;
  // Backing off is only safe if the crawl still ends. Past this the remaining
  // tickers are left alone and carried forward, which beats a run that outlives
  // its own lock and publishes half a map.
  _deadline = now + DEADLINE_MS;

  const prev = JSON.parse((await env.SY.get(KEY.snapshot)) || "null");
  const plan = crawlPlan(reg, prev);

  // one request for the whole chain, so it is cheap enough to take every run
  // rather than once a day as it was when it only named coins
  await refreshLongbow(env);
  const lbStats = JSON.parse((await env.SY.get(KEY.lbstats)) || "{}");

  // the chain, before the tail fetch, so anything opened since the last run is
  // in the same batch as everything else rather than a run behind it
  const chain = await discoverPools(env, reg);

  const tail = await longbowTail(env, reg);
  const regSet = new Set(reg.map((e) => (e.a || "").toLowerCase()));
  const fresh = await pooled(plan.list, 6, (e) => {
    const a = (e.a || "").toLowerCase();
    return stockRow(e, tail.get(a), regSet, lbStats[a]);
  });
  await enrichFlipped(fresh);

  // the tickers this tick left alone keep their last good row
  for (const r of fresh) r.ts = now;
  const done = new Map(fresh.map((r) => [r.t, r]));
  const was = new Map((prev?.rows || []).map((r) => [r.t, r]));
  let carried = 0;
  const rows = reg.map((e) => {
    const r = done.get(e.t);
    if (r) return r;
    const old = was.get(e.t);
    if (old) { carried++; return { ...old, sr: 1 }; }
    return {
      t: e.t, name: e.name || e.t, a: e.a, img: null, p: null,
      sl: 0, sv: 0, ml: 0, mv: 0, pl: 0, sk: null, no: 0, n: 0, nq: 0,
      c: null, cs: [null, null, null, null], vs: [0, 0, 0, 0], m: [],
    };
  });
  const pads = JSON.parse((await env.SY.get(KEY.pads)) || "{}");
  const imgs = JSON.parse((await env.SY.get(KEY.images)) || "{}");
  const resolved = await resolveNewPads(env, rows, pads);
  for (const r of rows) for (const m of r.m) {
    const a = (m.a || "").toLowerCase();
    const pad = pads[a];
    if (pad) m.lp = pad;
    if (!m.img && imgs[a]) m.img = imgs[a];
  }

  // carry forward the share prices, which run on their own slower schedule
  if (prev) {
    for (const r of rows) {
      const old = was.get(r.t);
      if (!old) continue;
      r.tp = old.tp; r.tprev = old.tprev; r.scs = old.scs; r.dp = old.dp;

      // A roster built on a refused request is short by an unknown amount, and
      // once it came back at zero: LLY lost every call in one run and published
      // no memes at all, on a stock carrying a million dollars of them. There is
      // no way to tell a short roster from a real one after the fact, so a
      // ticker that lost anything does not get published. It keeps the last row
      // that was assembled from complete answers, and says so.
      if (r.lost) {
        for (const k of ["ml", "mv", "pl", "n", "nq", "c", "cs", "vs", "m", "ts"]) r[k] = old[k];
        r.sr = 1;
        carried++;
      }
      delete r.lost;
    }
  }
  for (const r of rows) delete r.lost;

  rows.sort((a, b) => b.ml - a.ml);
  const blob = { asOf: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", rows };
  await env.SY.put(KEY.snapshot, JSON.stringify(blob));
  await env.SY.put(KEY.lock, "0", { expirationTtl: 60 });

  const stats = {
    ok: true, stocks: rows.length,
    memes: rows.reduce((s, r) => s + r.n, 0),
    padsResolved: resolved,
    padsKnown: Object.keys(pads).length,
    chain,
    tailAsks: _tailAsks,
    // memes reaching the page with a logo already attached. The rest resolve in
    // the browser against LONG's store, which no server-side call can reach.
    logoCoverage: (() => {
      let have = 0, all = 0;
      for (const r of rows) for (const m of r.m) { all++; if (m.img) have++; }
      return all ? Math.round((have / all) * 100) + "%" : "0%";
    })(),
    // requests Dexscreener never answered. Anything above zero means the
    // snapshot is missing part of some roster.
    droppedRequests: _lost,
    dropReasons: { rateLimited: _lost429, badStatus: _lostBad, network: _lostErr,
                   outOfTime: _lostLate },
    // how hard the gate had to widen, and how many rosters that still cost us
    throttles: _throttles,
    finalPaceMs: _pace,
    hitDeadline: Date.now() > _deadline,
    // tickers publishing the previous snapshot's roster because this crawl's
    // came back short. Zero is the healthy number.
    staleRows: carried,
    // what this tick actually went and asked about
    crawled: plan.list.length,
    // the whole point of the sweep: how far behind the furthest-behind row is
    staleMinutes: (() => {
      let oldest = now;
      for (const r of rows) if (r.ts && r.ts < oldest) oldest = r.ts;
      return Math.round((now - oldest) / 60000);
    })(),
    rowsNeverCrawled: rows.filter((r) => !r.ts).length,
    // memes on the page standing on Longbow's numbers because Dexscreener
    // truncated the roster before it reached them
    memesFromLongbow: rows.reduce((n, r) => n + (r.lb || 0), 0),
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
    JSON.stringify(kept.map((r) => ({ t: r.t, ml: r.ml, pl: r.pl, mv: r.mv, n: r.n, top: r.m[0]?.s || null }))),
    { expirationTtl: 60 * 60 * 24 * 31 }
  );
  const days = await rollChart(env, day, kept);
  return { ok: true, quoted: kept.length, dropped: blob.rows.length - kept.length, days };
}

// The dated snapshots are the record; this is the shape a chart wants. One blob,
// series aligned to one list of days, so the page fetches history once instead of
// thirty times. Money is kept in thousands because a sparkline cannot see a dollar.
const HISTORY_DAYS = 30;

async function rollChart(env, day, rows) {
  let c = JSON.parse((await env.SY.get(KEY.chart)) || 'null');
  // the dated snapshots predate this rollup, so the first run reads them back in
  // rather than starting the charts from today with a month already on disk
  if (!c) c = await backfillChart(env, day);

  let i = c.days.indexOf(day);
  if (i < 0) { c.days.push(day); i = c.days.length - 1; }

  const K = (n) => (n == null ? null : Math.round(n / 1000));
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.t);
    const e = (c.rows[r.t] ||= { ml: [], pl: [], n: [], top: [] });
    // a ticker that appeared late starts with holes rather than a flat line at zero
    while (e.ml.length < i) { e.ml.push(null); e.pl.push(null); e.n.push(null); e.top.push(null); }
    e.ml[i] = K(r.ml); e.pl[i] = K(r.pl); e.n[i] = r.n; e.top[i] = r.m?.[0]?.s || null;
  }
  // a ticker that dropped off today gets a hole too, not yesterday's number repeated
  for (const [t, e] of Object.entries(c.rows)) {
    if (seen.has(t)) continue;
    while (e.ml.length <= i) { e.ml.push(null); e.pl.push(null); e.n.push(null); e.top.push(null); }
  }

  const drop = c.days.length - HISTORY_DAYS;
  if (drop > 0) {
    c.days = c.days.slice(drop);
    for (const e of Object.values(c.rows)) {
      for (const k of ["ml", "pl", "n", "top"]) e[k] = e[k].slice(drop);
    }
  }
  // a ticker with nothing left in the window is gone
  for (const [t, e] of Object.entries(c.rows)) {
    if (e.ml.every((v) => v == null)) delete c.rows[t];
  }

  await env.SY.put(KEY.chart, JSON.stringify(c));
  return c.days.length;
}

// Read whatever dated snapshots are still inside their 31-day TTL and lay them
// out in the chart's shape. Runs once, the first time the rollup is missing.
//
// Only days written after the parked-pool rule landed are usable. Before it, ml
// counted every pool including the ones nobody trades, so an older day sits two
// to three times higher for reasons that have nothing to do with the market: the
// chart drew a 60% collapse where the only thing that changed was the definition.
// A snapshot carrying pl was written under the current rule; one without was not.
async function backfillChart(env, today) {
  const c = { days: [], rows: {} };
  const K = (n) => (n == null ? null : Math.round(n / 1000));
  const t0 = Date.parse(today + "T00:00:00Z");
  const dates = [];
  for (let back = HISTORY_DAYS; back > 0; back--)
    dates.push(new Date(t0 - back * 86400000).toISOString().slice(0, 10));

  const blobs = await pooled(dates, 6, (d) => env.SY.get(KEY.history(d)));
  dates.forEach((d, k) => {
    if (!blobs[k]) return;
    let list;
    try { list = JSON.parse(blobs[k]); } catch (_) { return; }
    if (!Array.isArray(list) || !list.length) return;
    if (!list.some((r) => r.pl !== undefined)) return;   // pre-rule, not comparable
    const i = c.days.length;
    c.days.push(d);
    for (const r of list) {
      const e = (c.rows[r.t] ||= { ml: [], pl: [], n: [], top: [] });
      while (e.ml.length < i) { e.ml.push(null); e.pl.push(null); e.n.push(null); e.top.push(null); }
      e.ml[i] = K(r.ml); e.pl[i] = K(r.pl); e.n[i] = r.n; e.top[i] = r.top || null;
    }
    for (const e of Object.values(c.rows)) {
      while (e.ml.length <= i) { e.ml.push(null); e.pl.push(null); e.n.push(null); e.top.push(null); }
    }
  });
  return c;
}

// ---------------------------------------------------------------- worker

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    // A Worker crawling Dexscreener loses roughly half its requests to a rate
    // limit it does not own, so when a machine with an ordinary IP is doing the
    // crawl the Worker stays out of the way. It is still the fallback: miss two
    // heartbeats and it picks the crawl back up on its own, degraded but alive.
    const beat = Number((await env.SY.get(KEY.crawler)) || 0);
    const handedOff = Date.now() - beat < 25 * 60 * 1000;

    if (cron === "23 6 * * *") {
      ctx.waitUntil(buildRegistry(env).then(() => refreshLongbow(env))
        .then(() => (handedOff ? null : refreshPools(env))));
    } else if (cron === "7 * * * *") {
      ctx.waitUntil(refreshQuotes(env));
    } else if (!handedOff) {
      ctx.waitUntil(refreshPools(env));
    }
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

    if (url.pathname === "/api/history.json") {
      const blob = await env.SY.get(KEY.chart);
      if (!blob) return json({ days: [], rows: {} });
      return new Response(blob, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=600, s-maxage=600",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // manual kick, handy before the first cron fires
    if (url.pathname === "/api/status") {
      const beat = Number((await env.SY.get(KEY.crawler)) || 0);
      return json({
        lastRun: JSON.parse((await env.SY.get(KEY.lastRun)) || "null"),
        lockUntil: Number((await env.SY.get(KEY.lock)) || 0) || null,
        // which of the two hosts is doing the crawling right now
        crawler: beat && Date.now() - beat < 25 * 60 * 1000 ? "external" : "worker",
        crawlerSeen: beat ? new Date(beat).toISOString() : null,
      });
    }

    // Kicking a job by hand costs about 700 Dexscreener requests and force=1
    // skips the lock that stops two crawls running at once, so this cannot be
    // open to the internet. It fails closed: no REFRESH_KEY set, no endpoint.
    //   wrangler secret put REFRESH_KEY
    if (url.pathname === "/api/refresh") {
      const want = env.REFRESH_KEY;
      if (!want) return json({ error: "refresh disabled: no REFRESH_KEY set" }, 503);
      const got = (req.headers.get("authorization") || "").replace(/^Bearer /, "") ||
                  url.searchParams.get("key") || "";
      // constant time enough for a value this size, and never says which part failed
      if (got.length !== want.length ||
          !got.split("").every((c, i) => c === want[i])) {
        return json({ error: "unauthorized" }, 401);
      }
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

// The crawl is one implementation with two hosts: the Worker runs it on a cron,
// and tools/crawl.mjs runs it from a machine with an ordinary IP where nothing
// throttles it. Keeping a second copy in another language is what let the Python
// tools drift out of date, so there is no second copy.
export { refreshPools, refreshQuotes, refreshLongbow, buildRegistry, discoverPools, KEY };
