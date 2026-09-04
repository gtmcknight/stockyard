# Stockyard

A live map of every memecoin on Robinhood Chain that trades against a tokenized stock.

On Robinhood Chain a meme can be paired directly against a tokenized equity, so buying the meme
means first acquiring the stock. That makes a meme rally into real onchain demand for the share.
Nobody has mapped it. The best public count was 27 pairs across 22 tickers.

## Run it

```
./run.sh
```

Pulls fresh data if the last snapshot is over 10 minutes old, then serves on
<http://localhost:8787> and opens a browser.

```
./run.sh --fresh    force a fresh pull first
./run.sh --serve    skip the pull, serve what is on disk
PORT=9000 ./run.sh  different port
```

The pull takes about three minutes and hits Dexscreener's public API plus Longbow's.
No keys, no accounts.

## What you are looking at

Each rectangle is a tokenized stock, sized by the money riding on it. Toggle **LIQ / VOL / STOCK**
to resize by meme liquidity, meme 24h volume, or the stock token's own liquidity. The whole map
rearranges, which is the useful part.

Tiles inside each rectangle are the individual memes, tinted by 24h move. Click any rectangle for
the full roster with logos, age, trade count, X links, and orphan flags.

**Orphan** means liquidity over $2K with no X account or fewer than 20 trades in 24 hours. That is
a coin nobody is running, which is the loudest complaint in the meta right now.

## Layout

```
tools/longbow.py  Longbow's untruncated index of stock-anchored memes, cached to
                  data/longbow.json. Run before pull.py
tools/pull.py     the crawler. two passes: locate stock tokens, then union three query
                  forms per token, topped up from the Longbow index
tools/repair.py   re-runs any ticker that came back empty
data/page.json    the snapshot the page reads
index.html        the map. no build step, no framework
run.sh            pull and serve
```

## Why Longbow is a source

Dexscreener's `token-pairs` endpoint caps at roughly 30 pools per token, so behind a
busy ticker most of the roster is invisible and the searches only partly fill it in.
Longbow runs a launchpad for these coins and publishes its own index, which is not
truncated. Adding it took the map from 1,309 memes and $50M of meme liquidity to
3,662 and $129M, and surfaced things like GME/GME doing $20M a day that we had been
missing entirely.

It is treated as a hint, never as truth. A coin Longbow names still only reaches the
map once Dexscreener confirms a real pool against a real tokenized stock, so the
standard for being on the map has not moved. Longbow also names the pad for the coins
it launched itself, which beats guessing from a contract name: `Longbow` and `Long`
(app.long.xyz) are different launchpads, and the name heuristic used to merge them.

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
curl "https://stockyard.<subdomain>.workers.dev/api/refresh?job=registry"
curl "https://stockyard.<subdomain>.workers.dev/api/refresh?job=longbow"
curl "https://stockyard.<subdomain>.workers.dev/api/refresh?job=quotes"
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
| `*/5 * * * *` | pools | liquidity, volume and price move constantly |
| `7 * * * *` | share prices | only meaningful while markets are open |
| `23 6 * * *` | stock registry | Robinhood adds tokens in batches, not hourly |

The hourly job also writes one dated snapshot to KV with a 31-day TTL, so charts get
a real history instead of four timeframe deltas stitched together.

### Endpoints

- `/` the page
- `/api/map.json` the current snapshot, edge cached 60s
- `/api/refresh?job=pools|quotes|registry` run a job by hand

## Layout

```
public/index.html    the page. no build step, no framework
public/data/         local dev copy of the snapshot (gitignored)
worker/src/index.js  the Worker: three crons, KV, static assets
worker/wrangler.jsonc
tools/pull.py        the same crawl in Python, for local runs
tools/stocks.py      enumerates every tokenized stock from the issuer's events
tools/launchpad.py   resolves which launchpad each token came from, cached
data/                snapshots and caches the Python tools write
run.sh               pull and serve locally
```

## Not done yet

- History-backed charts. The Worker records daily snapshots now, so this unlocks
  itself in about a week: real sparklines, leader flips, new-launch detection.
- Identifying "RWA", the second-biggest launchpad by volume of memes. It is a
  contract literally named `RWAERC20Launchpad` and the brand behind it is unverified.
- Float capture: what share of each tokenized stock is locked inside meme pools.
  Nobody publishes it and every input is already in the snapshot.
