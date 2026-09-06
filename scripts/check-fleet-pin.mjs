#!/usr/bin/env node
//
// Verifies that every `@fleet-sdk/*` dependency in `package.json` is pinned to
// an EXACT version (no `^`, `~`, `>=`, or other operator). Pre-1.0 Fleet SDK
// ships breaking changes inside its 0.X.0 line and bundles every monorepo
// package together — even a tilde range can pull a change that silently alters
// Ergo address derivation. Pinning hard is the load-bearing safety net.
//
// Background + upgrade playbook:
//   PwndaWalletVault/wiki/entities/Ergo.md   (§Upgrading @fleet-sdk/* dependencies)
//   PwndaWalletVault/wiki/synthesis/ergo-integration-plan.md   (§Procedure #1)
//
// A prebuild guard: runs in `npm run prebuild`. Exits non-zero on any
// unpinned `@fleet-sdk/*` decl.
//
// Currently a no-op until PR-6 of [[ergo-integration-plan]] adds the deps.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const PKG_PATH = resolve(repoRoot, "package.json");
const FLEET_PREFIX = "@fleet-sdk/";
const RANGE_OPERATORS = /^[\^~><=]/;

function main() {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
  } catch (e) {
    console.error(`[fleet-pin] failed to read ${PKG_PATH}: ${e.message}`);
    process.exit(2);
  }

  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const problems = [];
  let pinnedCount = 0;

  for (const section of sections) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (!name.startsWith(FLEET_PREFIX)) continue;
      if (typeof version !== "string") continue;
      const trimmed = version.trim();
      if (RANGE_OPERATORS.test(trimmed) || trimmed === "*" || trimmed.includes(" ") || trimmed.includes("||")) {
        problems.push(
          `${section}.${name} must be pinned to an exact version (got "${version}")`
        );
      } else {
        pinnedCount += 1;
      }
    }
  }

  if (problems.length > 0) {
    console.error("[fleet-pin] unpinned @fleet-sdk/* dependency detected:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\nReason: pre-1.0 Fleet SDK ships breaking changes in 0.X.0 bumps."
    );
    console.error(
      "Even a tilde range (~0.12.0) can subtly alter Ergo address derivation."
    );
    console.error(
      "Pin to an exact version (no ^, ~, >=) and bump intentionally via the"
    );
    console.error(
      "upgrade playbook in PwndaWalletVault/wiki/entities/Ergo.md."
    );
    process.exit(1);
  }

  if (pinnedCount === 0) {
    console.log("[fleet-pin] ok — no @fleet-sdk/* deps declared yet");
  } else {
    console.log(`[fleet-pin] ok — ${pinnedCount} @fleet-sdk/* dep(s) exact-pinned`);
  }
}

main();
