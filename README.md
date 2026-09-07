# Stockyard

A live map of every memecoin on Robinhood Chain that trades against a tokenized stock.

On Robinhood Chain a meme can be paired directly against a tokenized equity, so buying the meme
means first acquiring the stock. That makes a meme rally into real onchain demand for the share.
Nobody has mapped it. The best public count was 27 pairs across 22 tickers.

<https://stockyard.rhps.fun>

Currently tracking **1,672 memecoins across 108 tokenized stocks**, holding $58.6M of
liquidity and trading $179M in 24 hours, with another $2.2B parked in pools nobody
trades. The three busiest are AMC at $37.2M led by MEME, NVDA at $23.9M led by AI, and
SPY at $18.7M led by PAIR.

## What you are looking at

One row per tokenized stock: the ticker and its own move on the left, the three deepest memes
riding it in the middle, the rest of the roster on the right. Sort by meme liquidity, meme 24h
volume, meme move, or how close each ticker is to being won outright.

Hover a coin for its 24h shape, click it to copy the contract, click the stock for the full roster,
the onchain price, how far it sits from the real one, and a chart of the last month.

**Parked** marks a pool holding real liquidity that nobody traded one percent of in a day. That is
a deposit, not a market, and on this chain it is close to half the money: the single largest pool
held $22M against sixteen trades in 24 hours. Parked coins stay in the roster and are counted on
their own line. Nothing else on the page counts them, which is why the leader of a ticker is the
coin people trade rather than the one with the deepest deposit.

A **crown** means one coin holds both the majority of the liquidity and the majority of the trading
on its stock, against three or more rivals. Liquidity alone is something a team can buy; volume
costs a fee every round trip.

## Run it

The crawl needs nothing but an ordinary internet connection. No keys, no accounts.

```
npm --prefix worker install
node tools/crawl.mjs pools
```

All 203 tickers in about 150 seconds. Writing the result anywhere needs Cloudflare
credentials, so to just look at the page against a snapshot on disk:

```
./run.sh --serve    serve public/ on http://localhost:8787
PORT=9000 ./run.sh  different port
```

## Where the data comes from

| Source | For |
|---|---|
| Blockscout | the stock registry, and which launchpad deployed each token |
| Dexscreener | pools, liquidity, volume, price moves, some logos |
| Longbow | the roster tail Dexscreener truncates, plus logos for its own coins |
| LONG | a logo for most coins on the chain, fetched by the browser (see below) |
| Yahoo Finance | real-world share prices |
| Financial Modeling Prep | stock logos |

### Why Longbow is a source

Dexscreener's `token-pairs` endpoint caps at roughly 30 pools per token, so behind a
busy ticker most of the roster is invisible and the searches only partly fill it in.
Longbow runs a launchpad for these coins and publishes its own index, which is not
truncated. Adding it roughly tripled the map.

It is treated as a hint, never as truth. A coin Longbow names still only reaches the
map once Dexscreener confirms a real pool against a real tokenized stock, so the
standard for being on the map has not moved. Longbow also names the pad for the coins
it launched itself, which beats guessing from a contract name: `Longbow` and `Long`
(app.long.xyz) are different launchpads, and the name heuristic used to merge them.

### Why a pool is read from both ends

Dexscreener decides which side of a pool is the base token and which is the quote,
and the map used to assume the tokenized stock was always the quote. That holds until
a meme gets deep enough to be quoted against itself. FATCOIN is: six other coins trade
against it, so Dexscreener files its Eli Lilly pool as `LLY/FATCOIN` with the stock as
the base, and the map dropped it. Same for `AMC/MEME`. Those two pools alone were
$4.6M of liquidity and $36M of 24h volume, about a third of everything the map
reported, sitting outside it.

A pool now counts if the stock is on either side. Two things follow from reading one
backwards. A pair with a registry token on both sides is a stock traded against a
stock, not a meme riding one, so it is skipped. And everything Dexscreener attaches to
a pair describes its base token, which on a flipped pair is the stock: taking the price
move as given would have shown the stock's move against the meme rather than the
meme's, and taking the market cap and logo would have put Eli Lilly's on FATCOIN. The
move is inverted, and the rest is filled in afterwards from the meme's own pools in one
batched lookup.

### Why logos need three sources, and why one of them is resolved in the browser

Dexscreener only carries an image for a coin someone paid it to enhance, which is about
a third of the map, so most of the page was two grey initials. Longbow publishes a logo
for nearly every coin it launched, which the Worker caches into KV. LONG stores one for
most coins on the chain regardless of pad, at `storage.long.xyz/tokens/<address>.<ext>`,
and that covers 293 of the 319 coins the other two miss.

That last one cannot be fetched from the Worker. The host answers every server-side
request with a 403 bot page, including curl carrying a complete browser header set, so
the block is on the connection rather than the headers and there is nothing to spoof. A
real browser is served normally. The extension is also not derivable, so the page walks
`jpg`, `png`, `webp` itself and gives up to initials. Every avatar renders those initials
underneath the image, so a pending request is never an empty box.

## Where the crawl runs

The Worker cannot do this crawl. Dexscreener sits behind Cloudflare and a Worker's
requests leave through Cloudflare's shared egress, so the budget is not ours: the
same crawl that drops nothing from an ordinary connection at 276 requests a minute
lost 414 of 700 from the Worker at a slower rate. Pacing it does not help, because
even at 58 requests a minute one in six still came back refused.

So the crawl runs on a machine and the Worker serves what it writes. Same code both
ways: `tools/crawl.mjs` imports the Worker's own crawl functions and swaps the KV
binding for Cloudflare's REST API. See `tools/README.md`.

    node tools/crawl.mjs loop

A successful run heartbeats into KV. While that is fresh the Worker's cron stands
down; stop the loop and it takes the crawl back within two ticks, degraded but
alive. `/api/status` reports which one is running.

## Deploying to Cloudflare

The page is a static file; everything live is one JSON blob in KV that three crons
rebuild. No API keys anywhere, so hosting is the only cost (~$5/mo Workers paid plan,
needed because a refresh makes ~200 subrequests and the free tier caps at 50).

```
cd worker
npx wrangler login                    # needs Workers + KV scopes, see below
npx wrangler kv namespace create SY   # paste the id into wrangler.jsonc
npx wrangler deploy
```

Then prime it, since the crons only fill KV going forward:

```
npx wrangler secret put REFRESH_KEY   # any random string; /api/refresh is off without it
K=<that key>
curl -H "Authorization: Bearer $K" "https://stockyard.<subdomain>.workers.dev/api/refresh?job=registry"
curl -H "Authorization: Bearer $K" "https://stockyard.<subdomain>.workers.dev/api/refresh?job=longbow"
curl -H "Authorization: Bearer $K" "https://stockyard.<subdomain>.workers.dev/api/refresh?job=quotes"
npx wrangler kv key put --binding SY launchpads --path ../data/launchpads.json --remote
```

The launchpad cache is resolved locally by `tools/launchpad.py` and uploaded, because
it needs several Blockscout hops per token and never changes once known.

### If wrangler says "Authentication error [code: 10000]"

The OAuth token is missing Workers scopes. `npx wrangler logout && npx wrangler login`
and make sure the consent screen includes **Workers Scripts (write)** and
**Workers KV Storage (write)**.

### The three crons

| Schedule | Job | Why that often |
|---|---|---|
| `*/10 * * * *` | pools | liquidity, volume and price move constantly |
| `7 * * * *` | share prices | only meaningful while markets are open |
| `23 6 * * *` | stock registry | Robinhood adds tokens in batches, not hourly |

The hourly job also writes one dated snapshot with a 31-day TTL and rolls it into a
single chart blob, so the detail sheet draws a real month rather than four timeframe
deltas stitched together. On its first run the rollup reads back whatever dated
snapshots are still inside their TTL, so the charts do not start from empty.

### Endpoints

- `/` the page
- `/api/map.json` the current snapshot, edge cached 60s
- `/api/history.json` the last 30 days, edge cached 10m
- `/api/status` what the last crawl did, including logo and launchpad coverage
- `/api/refresh?job=pools|quotes|registry|longbow` run a job by hand. Needs a key:
  one kick is ~700 Dexscreener requests and `force=1` skips the lock that keeps two
  crawls apart, so it fails closed. `wrangler secret put REFRESH_KEY`, then pass it
  as `Authorization: Bearer <key>` or `?key=`. Unset means the endpoint is off.

## Layout

```
public/index.html    the page. no build step, no framework
public/data/         local dev copy of the snapshot (gitignored)
worker/src/index.js  the Worker: three crons, KV, static assets
worker/wrangler.jsonc
tools/pull.py        the same crawl in Python, for local runs
tools/stocks.py      enumerates every tokenized stock from the issuer's events
tools/launchpad.py   resolves which launchpad each token came from, cached
tools/longbow.py     Longbow's untruncated index, cached. Run before pull.py
tools/repair.py      re-runs any ticker that came back empty
data/                snapshots and caches the Python tools write
run.sh               pull and serve locally
```

## Not done yet

- `tools/pull.py` is the old standalone Python crawl. `tools/crawl.mjs` replaced it
  by running the Worker's code directly, so the Python copy no longer has to be kept
  in step and `./run.sh` is only for looking at a snapshot offline.
- Identifying "RWA", the second-biggest launchpad by volume of memes. It is a
  contract literally named `RWAERC20Launchpad` and the brand behind it is unverified.
- Float capture: what share of each tokenized stock is locked inside meme pools.
  Nobody publishes it and every input is already in the snapshot.
- Impersonation. LONG's own token page marks coins that were not launched through it
  and whose onchain config does not match, which caught the largest parked pool on the
  chain. That verdict is not in the snapshot and it should be.

## What it turned up

Three things the map found that were not visible before it existed.

**A meme can become a quote asset, and then it disappears.** Dexscreener decides which
side of a pool is base and which is quote. Once a coin is deep enough that others trade
against it, the orientation flips and its stock pool is filed the other way round:
`LLY/FATCOIN`, `AMC/MEME`. Reading only one side dropped both, and they are the two
largest live markets on the chain, $4.6M of liquidity and $36M a day.

**Most of the money is not a market.** $2.2B sits in pools nobody traded one percent of
in a day. The single largest held $22M against sixteen trades. That is a deposit, so
nothing on the page counts it except its own line.

**Stocks trade against stocks here too.** 43 pools, $7.8M, mostly `QQQ/SPY`. Out of scope
for a meme map, and as far as we can tell also unmapped.

## Licence

MIT.
