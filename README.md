# Stockyard

A live map of every memecoin on Robinhood Chain that trades against a tokenized stock.

On Robinhood Chain a meme can be paired directly against a tokenized equity, so buying
the meme means first acquiring the stock. A meme rally becomes real onchain demand for
the share. Nobody had mapped it; the best public count was 27 pairs across 22 tickers.

**<https://stockyard.rhps.fun>**

Currently tracking **1,672 memecoins across 108 tokenized stocks**, holding $58.6M of
liquidity and trading $179M in 24 hours, with another $2.2B parked in pools nobody
trades.

## Reading it

One row per stock: the ticker and its move, the three deepest memes riding it, the rest
of the roster on the right. Click a coin to copy its contract, click the stock for the
full roster and a month of history.

**Parked** is a pool holding real money that nobody traded 1% of in a day. That is a
deposit, not a market, so nothing counts it except its own line. On this chain it is
most of the money.

A **crown** means one coin holds the majority of both the liquidity and the trading on
its stock, against three or more rivals. Liquidity a team can buy; volume costs a fee
every round trip.

## Running it

The crawl needs nothing but an ordinary internet connection.

```
npm --prefix worker install
node tools/crawl.mjs pools     # all 203 tickers, about 150 seconds
node tools/crawl.mjs loop      # pools every 10m, quotes hourly, registry daily
```

Writing the result needs Cloudflare credentials: copy `.env.example` to `.env`. To just
look at a snapshot already on disk, `./run.sh --serve`.

## How it works

A page of static HTML reads one JSON blob from Workers KV. Something rebuilds that blob
every ten minutes. Three things about that are worth knowing.

**The crawl does not run on the Worker.** Dexscreener sits behind Cloudflare and a
Worker's requests leave through Cloudflare's shared egress, so the budget is not ours:
the same crawl that drops nothing from an ordinary connection at 276 requests a minute
lost 414 of 700 from the Worker. It runs on a machine instead, sharing one
implementation rather than a second copy that drifts. `tools/crawl.mjs` imports the
Worker's own functions and swaps the KV binding for Cloudflare's REST API. A heartbeat
tells the Worker to stand down; stop the loop and it takes the crawl back.

**A pool is read from both ends.** Dexscreener decides which side is base and which is
quote, and once a coin is deep enough that others trade against it the orientation
flips: `LLY/FATCOIN`, `AMC/MEME`. Reading one side dropped both, and they are the two
largest live markets on the chain.

**Three sources, because no one of them is complete.** Dexscreener confirms every pool
and is the only one with the four timeframes the page sorts on, but truncates a roster
at ~30 pools. Longbow publishes the whole chain in one request and fills the rest.
Blockscout gives the stock registry and launchpads, Yahoo the real share prices.

The reasoning behind each rule lives next to the code in `worker/src/index.js`.

## Deploying

```
cd worker
npx wrangler kv namespace create SY   # paste the id into wrangler.jsonc
npx wrangler secret put REFRESH_KEY   # /api/refresh is off without one
npx wrangler deploy
```

Needs the Workers paid plan: a refresh makes ~200 subrequests and the free tier caps at
50. Prime KV by running `node tools/crawl.mjs registry` then `pools`.

Endpoints: `/api/map.json`, `/api/history.json`, `/api/status`, and `/api/refresh`,
which needs `Authorization: Bearer $REFRESH_KEY`.

## Layout

```
public/index.html    the page. no build step, no framework
worker/src/index.js  the crawl, the crons, KV, static assets
tools/crawl.mjs      runs that same crawl from a machine
tools/kv.mjs         the KV binding, against Cloudflare's REST API
tools/*.py           the original Python crawl, retired
```

## What it turned up

**A meme can become a quote asset and vanish.** `LLY/FATCOIN` and `AMC/MEME` were
invisible to a map that claimed to count everything: $4.6M of liquidity and $36M a day.

**Most of the money is not a market.** $2.2B sits in pools nobody traded 1% of in a day.
The largest held $22M against sixteen trades.

**Stocks trade against stocks here too.** 43 pools, $7.8M, mostly `QQQ/SPY`. Out of
scope for a meme map, and as far as we can tell also unmapped.

## Not done yet

- Float capture: what share of each tokenized stock is locked inside meme pools. Every
  input is already in the snapshot.
- Impersonation. LONG marks coins whose onchain config does not match the pad they
  claim, which caught the largest parked pool on the chain. That verdict should be here.
- "RWA", the second-biggest launchpad by meme volume, is a contract named
  `RWAERC20Launchpad` and the brand behind it is unverified.

## Licence

MIT.
