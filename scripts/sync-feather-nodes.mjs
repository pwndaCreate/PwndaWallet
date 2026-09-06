// Regenerate src/wallets/xmr-nodes-feather.ts from feather-wallet/feather-nodes.
//
// Feather's nodes.yaml is manually curated by the Feather Wallet team — inclusion
// requires operator responsiveness, no RPC payments, and a privacy-community
// track record; removal follows unreachable/RPC-paying/misconfigured hosts.
// Mirroring that list keeps PwndaWallet's baked-in trusted pool honest without
// us having to vet operators ourselves.
//
// Usage:
//     node scripts/sync-feather-nodes.mjs
//
// Tolerant of fetch failure: if the HTTP request 404s or the network is down
// the existing generated file is left untouched and the script exits 0, so a
// `prebuild` hook never breaks an offline build.
//
// Output: src/wallets/xmr-nodes-feather.ts (overwrites in place).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FEATHER_YAML_URL =
  "https://raw.githubusercontent.com/feather-wallet/feather-nodes/master/nodes.yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "wallets", "xmr-nodes-feather.ts");

// --------------------------------------------------------------------------
// Minimal YAML parser scoped to feather-nodes' known-shape document.
// The real file is:
//     <network>:          # mainnet / testnet / stagenet
//       <transport>:      # tor / i2p / clearnet
//         <operator>:
//           - host:port
//           - host:port
// We only need (mainnet, clearnet) rows, and we skip anything else cleanly.
// Comments (#...) and blank lines are ignored.
// --------------------------------------------------------------------------

function parseFeatherYaml(text) {
  const out = { mainnet: {}, testnet: {}, stagenet: {} };

  let curNet = null;
  let curTransport = null;
  let curOperator = null;

  for (const rawLine of text.split(/\r?\n/)) {
    // Strip comments and trailing whitespace; leading whitespace is meaningful.
    const hashIdx = rawLine.indexOf("#");
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).replace(/\s+$/, "");
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();

    // List item under the current (net, transport, operator).
    if (body.startsWith("- ")) {
      if (!curNet || !curTransport || !curOperator) continue;
      const value = body.slice(2).trim().replace(/^['"]|['"]$/g, "");
      if (!value) continue;
      const bucket =
        (out[curNet][curTransport] ||= {}),
        list = (bucket[curOperator] ||= []);
      list.push(value);
      continue;
    }

    // Map key. Indent tells us which level this is at.
    const colon = body.indexOf(":");
    if (colon < 0) continue;
    const key = body.slice(0, colon).trim();
    const after = body.slice(colon + 1).trim();

    if (indent === 0) {
      curNet = key in out ? key : null;
      curTransport = null;
      curOperator = null;
    } else if (indent === 2) {
      curTransport = key;
      curOperator = null;
    } else if (indent === 4) {
      curOperator = key;
      // If the operator has an inline value (rare), treat it as a single entry.
      if (after && after !== "|" && after !== ">") {
        const bucket = (out[curNet || "mainnet"][curTransport] ||= {});
        (bucket[curOperator] ||= []).push(after.replace(/^['"]|['"]$/g, ""));
      }
    }
    // Deeper indents (6+) appear only as list items, handled above.
  }

  return out;
}

// --------------------------------------------------------------------------
// Entry
// --------------------------------------------------------------------------

async function fetchYaml() {
  const resp = await fetch(FEATHER_YAML_URL, {
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": "PwndaWallet-node-sync/1.0" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  return resp.text();
}

function buildNodeList(parsed) {
  // Mainnet clearnet only. Tor/I2P nodes need a SOCKS proxy we don't wire up
  // today; adding that is out of scope for this sync.
  const clearnet = parsed?.mainnet?.clearnet ?? {};
  const rows = [];
  for (const [operator, hosts] of Object.entries(clearnet)) {
    for (const hostPort of hosts) {
      // hostPort looks like "host:port". Default scheme is http — Feather's
      // list is HTTP for the vast majority of entries; the few HTTPS ones
      // appear with explicit `https://` prefix.
      let url;
      if (/^https?:\/\//i.test(hostPort)) {
        url = hostPort.replace(/\/$/, "");
      } else {
        url = `http://${hostPort}`;
      }
      rows.push({ url, operator });
    }
  }
  // Deterministic order — sort by operator then URL so diffs are readable.
  rows.sort((a, b) =>
    a.operator === b.operator
      ? a.url.localeCompare(b.url)
      : a.operator.localeCompare(b.operator)
  );
  return rows;
}

function renderTs(nodes, sourceVersion) {
  const entries = nodes
    .map(
      (n) =>
        `  { url: ${JSON.stringify(n.url)}, operator: ${JSON.stringify(
          n.operator
        )} },`
    )
    .join("\n");
  return `// THIS FILE IS AUTO-GENERATED. DO NOT EDIT BY HAND.
//
// Regenerate with:   node scripts/sync-feather-nodes.mjs
//
// Source:   ${FEATHER_YAML_URL}
// Synced:   ${new Date().toISOString()}
// Entries:  ${nodes.length} mainnet/clearnet nodes
// ${sourceVersion ? "Commit:   " + sourceVersion : ""}
//
// Feather's curation criteria (paraphrased from feather-wallet/feather-nodes
// README): operator contactable, no RPC payments, consistent tip sync, not on
// a non-consensus fork, community trust intact. We inherit that vetting here.

export interface FeatherNode {
  url: string;
  operator: string;
}

export const FEATHER_NODES: ReadonlyArray<FeatherNode> = [
${entries}
];
`;
}

async function main() {
  let yaml;
  try {
    yaml = await fetchYaml();
  } catch (e) {
    console.warn(
      `[sync-feather-nodes] fetch failed (${e?.message ?? e}); keeping existing ${OUT_PATH}`
    );
    return; // tolerant: let offline builds continue with whatever is on disk
  }

  const parsed = parseFeatherYaml(yaml);
  const nodes = buildNodeList(parsed);
  if (nodes.length === 0) {
    console.warn(
      "[sync-feather-nodes] parsed 0 mainnet clearnet nodes — YAML format may have changed. Aborting without overwrite."
    );
    process.exitCode = 1;
    return;
  }
  const rendered = renderTs(nodes);
  await writeFile(OUT_PATH, rendered, "utf8");
  console.log(
    `[sync-feather-nodes] wrote ${nodes.length} nodes to ${OUT_PATH}`
  );
}

main().catch((e) => {
  console.error("[sync-feather-nodes] fatal:", e);
  process.exitCode = 1;
});
