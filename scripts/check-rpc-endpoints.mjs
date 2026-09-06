#!/usr/bin/env node
/**
 * Probe every endpoint in `src/wallets/chain-rpcs.ts` and report which are
 * alive, which are dead, and — most importantly — whether each chain's FIRST
 * endpoint works.
 *
 * Usage:
 *   node scripts/check-rpc-endpoints.mjs            # report, exit 0 unless a primary is dead
 *   node scripts/check-rpc-endpoints.mjs --strict   # also fail if ANY endpoint is dead
 *   node scripts/check-rpc-endpoints.mjs --json     # machine-readable
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The endpoint lists were hand-audited on 2026-05-06 and recorded in
 * RPC_AUDIT.md. By 2026-08-13 — one re-probe later — two of ETH's four
 * endpoints had died, and both were ordered AHEAD of the two that still
 * worked. Every ETH balance read burned a failed request first, and the only
 * signal was that the wallet "felt slow".
 *
 * A hand audit is a snapshot of a system that changes without telling you.
 * This script makes the snapshot repeatable, so the answer to "are these
 * still good?" is a command instead of an afternoon.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ THE RESULTS CAREFULLY — two traps this script tries to avoid:
 *
 * 1. SELF-INFLICTED RATE LIMITS. Probing 54 endpoints concurrently made
 *    blockchair IP-blacklist us (HTTP 430) and BlockCypher return 429 — and
 *    an earlier concurrent run reported bsc.drpc.org as 429 when, probed
 *    alone, it returns 200. So requests are issued SEQUENTIALLY with a delay.
 *    Slower, but a false "dead" reading is worse than a slow script: it would
 *    get a working endpoint demoted.
 *
 * 2. WRONG PROBE SHAPE. Stellar Horizon is REST, not JSON-RPC — POSTing
 *    JSON-RPC at it returns 405 and looks dead. Sui uses its own method
 *    names. Each `probe` kind below sends what that endpoint actually
 *    expects, and 4xx-that-proves-liveness is treated as ALIVE (a server that
 *    says "method not found" is a server that is up).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src", "wallets", "chain-rpcs.ts");

const STRICT = process.argv.includes("--strict");
const JSON_OUT = process.argv.includes("--json");

/** Delay between probes. See trap #1 above. */
const SPACING_MS = 400;
const TIMEOUT_MS = 10_000;

/** Parse RPC_DEFAULTS out of the TS source (no bundler needed). */
function parseChains() {
  const s = readFileSync(SRC, "utf8");
  const seg = s.slice(s.indexOf("export const RPC_DEFAULTS"));
  const keys = [...seg.matchAll(/\n {2}([A-Z0-9_]+):\s*\{/g)].map((m) => ({
    at: m.index,
    key: m[1],
  }));
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const body = seg.slice(keys[i].at, keys[i + 1]?.at ?? seg.length);
    const probe = /probe:\s*"(\w+)"/.exec(body)?.[1] ?? "evm";
    const block = /defaults:\s*\[([\s\S]*?)\n {4}\]/.exec(body);
    if (!block) continue;
    const urls = [...block[1].matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
    if (urls.length) out.push({ chain: keys[i].key, probe, urls });
  }
  return out;
}

const jsonRpc = (method, params = []) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});

/** Build the request each probe kind actually expects. */
function requestFor(kind, url) {
  const base = url.replace(/\/$/, "");
  switch (kind) {
    case "evm":
      // Stellar + Sui are labelled "evm" in the config for convenience but
      // are not EVM. Detect by host so we send something they understand.
      if (base.includes("horizon.stellar")) return [`${base}/ledgers?limit=1`, {}];
      if (base.includes("sui.io") || base.includes("sui-mainnet"))
        return [base, jsonRpc("sui_getChainIdentifier")];
      return [base, jsonRpc("eth_blockNumber")];
    case "solana":
      return [base, jsonRpc("getSlot")];
    case "near":
      return [base, jsonRpc("status")];
    case "esplora":
      return [`${base}/blocks/tip/height`, {}];
    case "blockchair":
      return [/\/(stats|health)$/.test(base) ? base : `${base}/stats`, {}];
    default:
      return [base, {}];
  }
}

/**
 * Classify a probe result.
 *
 * ALIVE means "this host is up and would serve a real request". A 4xx that
 * only reflects OUR probe (wrong method, unknown JSON-RPC method) still proves
 * liveness. A rate-limit is reported separately — it is neither proof of death
 * nor of health, and must never trigger a demotion on its own.
 */
function classify(status, bodyText) {
  // Check the BODY before the status. A provider that has paywalled the chain
  // answers with a perfectly healthy-looking 200 or 400 and puts the refusal
  // in the JSON-RPC error — e.g. solana.drpc.org returns HTTP 400 with
  // "chain is not available on free plan, please upgrade". Classifying that by
  // status alone marked it ALIVE (4xx = "host responded"), which is true and
  // useless: it will never serve us a balance.
  if (/not available on free plan|please upgrade|API key is not allowed|API key required/i.test(bodyText))
    return { state: "DEAD", why: "provider refuses this chain (plan/key)" };
  // An API that has been retired answers politely and uselessly. Sui shut off
  // JSON-RPC on its public fullnodes: every method returns -32601 with
  // "JSON-RPC on public fullnodes has been deprecated", and the host serves
  // HTTP 200 throughout. The `Method not found` rule below read that as
  // "host up, my probe used the wrong method name" — true of the host, wrong
  // about the endpoint, and it let a chain whose balances could not load at
  // all be reported as healthy.
  if (/deprecat|has been (removed|retired|sunset)|migrate to/i.test(bodyText))
    return { state: "DEAD", why: "API deprecated by the provider" };
  if (status === 0) return { state: "DEAD", why: "no response / connection failed" };
  if (status === 429 || status === 430)
    return { state: "RATELIMIT", why: `HTTP ${status} — retry alone before trusting` };
  if (status === 521 || status === 522 || status === 523)
    return { state: "DEAD", why: `HTTP ${status} — origin down` };
  if (status === 402 || status === 403)
    return { state: "DEAD", why: `HTTP ${status} — paywalled / key required` };
  if (status === 404) return { state: "DEAD", why: "HTTP 404 — endpoint gone" };
  if (status === 405) return { state: "ALIVE", why: "405 — wrong method, host up" };
  if (status >= 200 && status < 300) {
    // Only means "host up" when the DEPRECATION check above didn't fire —
    // otherwise it's the polite face of a retired API.
    if (/Method not found/i.test(bodyText))
      return { state: "ALIVE", why: "method-not-found — host up" };
    return { state: "ALIVE", why: "" };
  }
  if (status >= 400 && status < 500)
    return { state: "ALIVE", why: `HTTP ${status} — host responded` };
  return { state: "DEAD", why: `HTTP ${status}` };
}

async function probe(kind, url) {
  const [target, init] = requestFor(kind, url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(target, { ...init, signal: ctrl.signal });
    const body = await res.text().catch(() => "");
    return { status: res.status, ms: Date.now() - t0, body: body.slice(0, 300) };
  } catch {
    return { status: 0, ms: Date.now() - t0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chains = parseChains();
  const total = chains.reduce((n, c) => n + c.urls.length, 0);
  if (!JSON_OUT) {
    console.log(`[check-rpc] probing ${total} endpoints across ${chains.length} chains`);
    console.log(`[check-rpc] sequential, ${SPACING_MS}ms apart — a burst rate-limits us and`);
    console.log(`[check-rpc] would report healthy endpoints as dead\n`);
  }

  const results = [];
  for (const { chain, probe: kind, urls } of chains) {
    for (let i = 0; i < urls.length; i++) {
      const r = await probe(kind, urls[i]);
      const c = classify(r.status, r.body);
      results.push({ chain, url: urls[i], index: i, ...r, ...c, body: undefined });
      if (!JSON_OUT) {
        const mark = c.state === "ALIVE" ? "ok  " : c.state === "RATELIMIT" ? "rate" : "DEAD";
        const primary = i === 0 ? " <- PRIMARY" : "";
        console.log(
          `  ${mark}  ${chain.padEnd(8)} [${i}] ${urls[i].slice(0, 46).padEnd(46)} ` +
            `${String(r.status).padStart(3)} ${String(r.ms).padStart(5)}ms` +
            `${c.why ? "  " + c.why : ""}${primary}`
        );
      }
      await sleep(SPACING_MS);
    }
  }

  const deadPrimaries = results.filter((r) => r.index === 0 && r.state === "DEAD");
  const deadAny = results.filter((r) => r.state === "DEAD");
  // A chain whose only ALIVE endpoint is its primary has no real redundancy.
  const noFallback = chains
    .map(({ chain }) => {
      const rows = results.filter((r) => r.chain === chain);
      const alive = rows.filter((r) => r.state === "ALIVE");
      return { chain, alive: alive.length, total: rows.length };
    })
    .filter((c) => c.alive <= 1);

  if (JSON_OUT) {
    console.log(JSON.stringify({ results, deadPrimaries, noFallback }, null, 2));
  } else {
    console.log(`\n[check-rpc] ${results.length - deadAny.length}/${results.length} alive`);
    if (noFallback.length) {
      console.log(`\n[check-rpc] chains with NO working fallback (primary is a single point of failure):`);
      for (const c of noFallback)
        console.log(`    ${c.chain}: ${c.alive} of ${c.total} endpoints alive`);
    }
    if (deadPrimaries.length) {
      console.log(`\n[check-rpc] DEAD PRIMARY — every read pays a failed request first:`);
      for (const r of deadPrimaries) console.log(`    ${r.chain} [0] ${r.url} — ${r.why}`);
    }
    if (deadAny.length && !deadPrimaries.length) {
      console.log(`\n[check-rpc] dead fallbacks (no immediate cost, but they are not real redundancy):`);
      for (const r of deadAny) console.log(`    ${r.chain} [${r.index}] ${r.url} — ${r.why}`);
    }
  }

  // Exit non-zero only for a dead PRIMARY by default: that's the condition
  // that silently degrades every balance read. Dead fallbacks are worth
  // knowing about but shouldn't block a build on a flaky day.
  if (deadPrimaries.length) process.exit(1);
  if (STRICT && deadAny.length) process.exit(1);
}

main().catch((e) => {
  console.error("[check-rpc] fatal:", e);
  process.exit(1);
});
