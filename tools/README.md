# Running the crawl from a machine

Dexscreener sits behind Cloudflare, and a Worker's outbound requests leave through
Cloudflare's shared egress. The budget is not ours and it is mostly spent:

| crawling from | rate | requests refused |
|---|---|---|
| the Worker | 230/min | 414 of 700 |
| an ordinary connection | 276/min | 0 of 90 |

That is not a pacing problem and nothing inside the Worker fixes it. A full crawl
from the Worker took 378 seconds, abandoned 149 requests when it ran out of time,
and published 90 of 203 tickers from the previous snapshot. The same code from a
laptop takes 142 seconds and drops nothing.

So the crawl runs here, and the Worker serves. It is the same code either way:
`tools/crawl.mjs` imports the Worker's own functions and swaps the KV binding for
Cloudflare's REST API. There is no second implementation to keep in step, which is
what let the Python tools drift out of date.

## Setup

    cp .env.example .env       # then fill in CF_ACCOUNT_ID and CF_API_TOKEN
    npm --prefix worker install
    node tools/crawl.mjs pools

The token needs one permission: **Account > Workers KV Storage > Edit**.

## Running it

    node tools/crawl.mjs loop

Pools every 10 minutes, share prices hourly, the stock registry daily. Leave it
running. Single jobs are `pools`, `quotes`, `registry` and `longbow`.

## Handover

A successful pools run writes a heartbeat to KV. While it is under 25 minutes old
the Worker's own cron stands down, so the two never crawl at once. Stop the loop
and the Worker picks the crawl back up within two ticks, rate limited and partly
stale but alive.

`GET /api/status` says which one is crawling:

    "crawler": "external" | "worker"
