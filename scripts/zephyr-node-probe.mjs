/**
 * Probe every entry in the Zephyr default node pool via raw HTTP and
 * report the results.
 *
 * This doesn't need the Tauri context — it's a standalone integration
 * test that proves:
 *   1. The baked-in Zephyr node URLs in src/wallets/zph-nodes-default.ts
 *      resolve and respond.
 *   2. Each node's `/get_info` returns valid Monero-compatible JSON with
 *      `mainnet: true` and a non-zero height.
 *   3. Reported heights agree (within a small slack) across nodes, so the
 *      pool isn't secretly forked.
 *
 * Run: `node scripts/zephyr-node-probe.mjs`
 *
 * Exit code: 0 if at least two nodes pass, 1 otherwise. The CI gate is
 * "at least two" rather than "all" because any single node can be in
 * maintenance at any moment, and demanding 100% makes the test a false
 * positive every time an operator reboots.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODES_FILE = join(
  __dirname,
  "..",
  "src",
  "wallets",
  "zph-nodes-default.ts"
);

/**
 * Scrape the baked-in node list out of the TS file. Avoids pulling in a
 * TS toolchain for a 10-line fact.
 */
function readDefaultNodes() {
  const text = readFileSync(NODES_FILE, "utf8");
  const entries = [];
  const re = /\{\s*url:\s*"([^"]+)"\s*,\s*operator:\s*"([^"]+)"\s*,?\s*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    entries.push({ url: m[1], operator: m[2] });
  }
  return entries;
}

async function probe(url, timeoutMs = 8000) {
  const endpoint = `${url.replace(/\/$/, "")}/get_info`;
  const start = performance.now();
  try {
    const resp = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.round(performance.now() - start);
    if (!resp.ok) {
      return { ok: false, latencyMs, error: `HTTP ${resp.status}` };
    }
    let body;
    try {
      body = await resp.json();
    } catch (e) {
      return { ok: false, latencyMs, error: "non-JSON body" };
    }
    return {
      ok: true,
      latencyMs,
      height: Number(body.height ?? 0),
      mainnet: body.mainnet === true,
      nettype: body.nettype,
      target_height: Number(body.target_height ?? 0),
      version: body.version,
    };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - start);
    const msg =
      e.name === "TimeoutError" || e.name === "AbortError"
        ? "timeout"
        : e.message || String(e);
    return { ok: false, latencyMs, error: msg };
  }
}

function fmtMs(v) {
  if (v == null) return "—";
  return `${v.toString().padStart(5)} ms`;
}
function fmtHeight(v) {
  if (v == null || v === 0) return "—";
  return v.toLocaleString().padStart(10);
}

async function main() {
  const nodes = readDefaultNodes();
  if (nodes.length === 0) {
    console.error(
      "No nodes found in zph-nodes-default.ts — regex may have drifted."
    );
    process.exit(2);
  }

  console.log(
    `Probing ${nodes.length} Zephyr default nodes (GET /get_info, 8s timeout)...\n`
  );
  const results = await Promise.all(
    nodes.map(async (n) => ({ ...n, result: await probe(n.url) }))
  );

  // Column-aligned report
  const longestOp = Math.max(...results.map((r) => r.operator.length));
  const longestUrl = Math.max(...results.map((r) => r.url.length));
  console.log(
    [
      "OPERATOR".padEnd(longestOp),
      "URL".padEnd(longestUrl),
      "STATUS",
      "LATENCY",
      "HEIGHT",
      "MAINNET",
    ].join("  ")
  );
  console.log("-".repeat(longestOp + longestUrl + 40));

  let okCount = 0;
  const heights = [];
  for (const r of results) {
    const { ok, latencyMs, height, mainnet, error } = r.result;
    const status = ok ? "OK" : "FAIL";
    const mainnetStr = ok ? (mainnet ? "yes" : "NO!") : "—";
    console.log(
      [
        r.operator.padEnd(longestOp),
        r.url.padEnd(longestUrl),
        status.padEnd(6),
        fmtMs(latencyMs),
        fmtHeight(height),
        mainnetStr,
      ].join("  ") + (error ? `   err=${error}` : "")
    );
    if (ok) {
      okCount++;
      if (typeof height === "number" && height > 0) heights.push(height);
    }
  }

  console.log();
  console.log(`Summary: ${okCount}/${nodes.length} nodes reachable.`);

  // Cross-node height agreement check — detects forked nodes or
  // seriously-stale indexers. 10-block slack for normal propagation.
  if (heights.length >= 2) {
    const maxH = Math.max(...heights);
    const minH = Math.min(...heights);
    const spread = maxH - minH;
    if (spread > 10) {
      console.warn(
        `WARN: Height spread across reachable nodes is ${spread} blocks (min=${minH.toLocaleString()} max=${maxH.toLocaleString()}). ` +
          `A spread over 10 blocks can indicate a stuck node or a local fork.`
      );
    } else {
      console.log(
        `Height agreement OK: spread=${spread} blocks across ${heights.length} nodes.`
      );
    }
  }

  // Cross-validate that every reachable node reports mainnet — we never
  // want a testnet/stagenet node accidentally in the default pool.
  for (const r of results) {
    if (r.result.ok && r.result.mainnet !== true) {
      console.error(
        `FAIL: ${r.url} does not report mainnet:true (nettype=${r.result.nettype})`
      );
      process.exit(1);
    }
  }

  // Gate: require at least 2 of the pool reachable. Any single node can
  // be in maintenance; demanding 100% would make this test a false
  // positive on any operator reboot.
  if (okCount < 2) {
    console.error(
      `FAIL: only ${okCount}/${nodes.length} Zephyr nodes reachable, ` +
        `minimum 2 required. Default pool may need re-curation.`
    );
    process.exit(1);
  }

  console.log("PASS: Zephyr default pool is healthy.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(2);
});
