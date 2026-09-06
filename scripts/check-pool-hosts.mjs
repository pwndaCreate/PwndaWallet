#!/usr/bin/env node
//
// Verifies that the smoke-test host allowlist stays in sync with the
// pool registry the frontend ships:
//
//   src-tauri/src/pool_ping.rs   (Rust: ALLOWED_POOL_HOSTS)
//   src/features/mining/pools.ts (TS: per-pool endpoint URLs)
//
// Drift produces the user-visible "smoke test ✗ dns fail" bug class —
// the probe short-circuits with `stage="config"` for any host not on
// the allowlist, even though the real miner would connect fine. See
// PwndaWalletVault/wiki/synthesis/pool-host-allowlist-sync-fix.md for
// the original bug report (2026-05-23 HeroMiners ERG) and the design
// rationale for this guard.
//
// Exits non-zero on any mismatch so the build fails. Wired into both
// `prebuild` and `prebuild:lite` in package.json.
//
// Two-parser-and-diff structure: parse the same list out of both the Rust
// and TS sources, then assert they match.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const RUST_PATH = resolve(repoRoot, "src-tauri/src/pool_ping.rs");
const TS_PATH = resolve(repoRoot, "src/features/mining/pools.ts");

/**
 * Pull the contents of the `ALLOWED_POOL_HOSTS: &[&str] = &[ ... ];`
 * block out of pool_ping.rs and collect bare hostname strings.
 *
 * Tolerant of comments and whitespace inside the block — picks up only
 * double-quoted string literals.
 */
function parseRustAllowlist(source) {
  const blockMatch = source.match(
    /ALLOWED_POOL_HOSTS\s*:\s*&\[\s*&\s*str\s*\]\s*=\s*&\[([\s\S]*?)\];/
  );
  if (!blockMatch) {
    throw new Error(
      `Could not locate ALLOWED_POOL_HOSTS block in ${RUST_PATH}`
    );
  }
  const block = blockMatch[1];
  const out = new Set();
  for (const m of block.matchAll(/"([^"]+)"/g)) {
    out.add(m[1].toLowerCase());
  }
  if (out.size === 0) {
    throw new Error(`No entries inside ALLOWED_POOL_HOSTS at ${RUST_PATH}`);
  }
  return out;
}

/**
 * Strip the four scheme prefixes the Rust `parse_endpoint` accepts and
 * return the bare host (no port, lowercase, trailing dot removed —
 * matching the normalization `is_host_allowed` performs).
 */
function endpointHost(endpoint) {
  let s = endpoint.trim();
  for (const scheme of ["stratum+ssl://", "stratum+tcp://", "ssl://", "tcp://"]) {
    if (s.startsWith(scheme)) {
      s = s.slice(scheme.length);
      break;
    }
  }
  const colon = s.lastIndexOf(":");
  if (colon !== -1) s = s.slice(0, colon);
  return s.replace(/\.$/, "").toLowerCase();
}

/**
 * Walk pools.ts and pull every `endpoint: "..."` literal. Returns the
 * unique set of hosts referenced by any pool entry.
 */
function parseTsHosts(source) {
  const out = new Set();
  for (const m of source.matchAll(/endpoint\s*:\s*"([^"]+)"/g)) {
    const host = endpointHost(m[1]);
    if (host) out.add(host);
  }
  if (out.size === 0) {
    throw new Error(`No endpoint literals found in ${TS_PATH}`);
  }
  return out;
}

function main() {
  let rustSrc;
  let tsSrc;
  try {
    rustSrc = readFileSync(RUST_PATH, "utf8");
    tsSrc = readFileSync(TS_PATH, "utf8");
  } catch (e) {
    console.error(`[pool-hosts] failed to read sources: ${e.message}`);
    process.exit(2);
  }

  const rust = parseRustAllowlist(rustSrc);
  const ts = parseTsHosts(tsSrc);

  const missingFromRust = [...ts].filter((h) => !rust.has(h)).sort();
  const orphanInRust = [...rust].filter((h) => !ts.has(h)).sort();

  if (missingFromRust.length === 0 && orphanInRust.length === 0) {
    console.log(
      `[pool-hosts] ok — ${rust.size} hosts in sync (${[...rust].sort().join(", ")})`
    );
    return;
  }

  console.error("[pool-hosts] mismatch detected:");
  for (const h of missingFromRust) {
    console.error(`  - MISSING from Rust allowlist: ${h}`);
  }
  for (const h of orphanInRust) {
    console.error(`  - ORPHAN in Rust allowlist (no pool uses it): ${h}`);
  }
  console.error("");
  console.error(
    "Update ALLOWED_POOL_HOSTS in src-tauri/src/pool_ping.rs to match"
  );
  console.error(`the endpoints in ${TS_PATH}, then re-run.`);
  process.exit(1);
}

main();
