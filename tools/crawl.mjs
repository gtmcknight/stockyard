#!/usr/bin/env node
/**
 * Runs the Worker's crawl from this machine.
 *
 * Dexscreener sits behind Cloudflare and a Worker's requests leave through
 * Cloudflare's shared egress, so the same crawl that loses nothing from an
 * ordinary connection lost 414 of 700 requests from the Worker. Nothing inside
 * the Worker fixes that. This runs the identical code from an IP that is ours,
 * at full speed, and writes the result to the same KV the page reads.
 *
 *   node tools/crawl.mjs pools      the map. every 10 minutes
 *   node tools/crawl.mjs quotes     real-world share prices. hourly
 *   node tools/crawl.mjs registry   the tokenized stock list. daily
 *   node tools/crawl.mjs longbow    the launchpad index. folded into pools
 *   node tools/crawl.mjs loop       all of the above, on their own schedules
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kv } from "./kv.mjs";
import {
  refreshPools, refreshQuotes, refreshLongbow, buildRegistry, setLimits,
} from "../worker/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// .env, without a dependency
for (const line of readFileSync(join(here, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing ${k} in .env`); process.exit(1); }
  return v;
};

const env = {
  SY: kv({
    accountId: need("CF_ACCOUNT_ID"),
    namespaceId: need("CF_KV_NAMESPACE_ID"),
    token: need("CF_API_TOKEN"),
  }),
  // the same values wrangler.jsonc gives the Worker
  EXPLORER_API: process.env.EXPLORER_API || "https://robinhoodchain.blockscout.com/api/v2",
  STOCK_FACTORY: process.env.STOCK_FACTORY || "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046",
};

// nothing is throttling us here, so the pacing exists only to be a good citizen
setLimits({
  pace: Number(process.env.PACE_MS || 120),
  paceMax: Number(process.env.PACE_MAX_MS || 600),
  deadlineMs: Number(process.env.DEADLINE_MS || 15 * 60 * 1000),
});

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(stamp(), ...a);

async function run(job) {
  const t0 = Date.now();
  try {
    const out =
      job === "pools"    ? await refreshPools(env, true)   // force: this machine is the crawler
    : job === "quotes"   ? await refreshQuotes(env)
    : job === "registry" ? await buildRegistry(env)
    : job === "longbow"  ? await refreshLongbow(env)
    : null;
    if (!out) { console.error(`unknown job: ${job}`); process.exit(1); }
    // tell the Worker this machine is alive, so its cron stays out of the way.
    // Stop the loop and it takes the crawl back within two ticks.
    if (job === "pools" && out.ok) await env.SY.put("crawler", String(Date.now()));
    const secs = Math.round((Date.now() - t0) / 1000);
    say(`${job} ${out.ok ? "ok" : "failed"} in ${secs}s`,
        JSON.stringify(out.ok ? summarise(job, out) : out));
    return out;
  } catch (e) {
    say(`${job} threw:`, e.message);
    return { ok: false, why: e.message };
  }
}

// the numbers worth seeing every ten minutes, not the whole stats blob
function summarise(job, o) {
  if (job !== "pools") return o;
  return {
    stocks: o.stocks, memes: o.memes, fromLongbow: o.memesFromLongbow,
    dropped: o.droppedRequests, stale: o.staleRows, hitDeadline: o.hitDeadline,
  };
}

const EVERY = { pools: 10 * 60e3, quotes: 60 * 60e3, registry: 24 * 60 * 60e3 };

async function loop() {
  say("crawling from this machine. pools every 10m, quotes hourly, registry daily");
  const last = { pools: 0, quotes: 0, registry: 0 };
  // the registry has to exist before the first crawl can use it
  if (!(await env.SY.get("registry"))) await run("registry");
  for (;;) {
    const now = Date.now();
    for (const job of ["registry", "quotes", "pools"]) {
      if (now - last[job] >= EVERY[job]) { last[job] = now; await run(job); }
    }
    await new Promise((r) => setTimeout(r, 20e3));
  }
}

const job = process.argv[2] || "pools";
if (job === "loop") await loop();
else { const o = await run(job); process.exit(o.ok ? 0 : 1); }
