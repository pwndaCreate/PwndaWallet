#!/usr/bin/env node
// scripts/check-bundle-payloads.mjs
//
// BUILD GATE for the encrypted binary bundles (binary-bundling-plan).
// Producer: scripts/bundle-binaries.mjs. Consumer: src-tauri/src/bundle.rs.
//
// # Why this exists
//
// `tauri.conf.json` ships `bundle.resources: ["binaries/*"]`, so an installer
// carries whatever happens to be sitting in `src-tauri/binaries/` when
// `tauri build` runs. Those payloads are gitignored and produced at release time
// — and until 2026-08-29 **nothing invoked the producer**: not `tauri:build`, not
// `build:linux`, not `release-local.ps1`, not CI.
//
// So the default outcome of building a release was an installer with no
// `grove.enc` and no `miners.enc`, and the failure was invisible until a real
// user opted into swap or mining and got "this build does not ship a bundled
// swap engine". A missing bundle is a BUILD DEFECT, not a runtime limitation,
// and it belongs at build time where it costs nothing to fix.
//
// # What it checks, and why each one
//
//  1. `bundle-manifest.json` exists and parses           — the consumer reads it first
//  2. every required payload is listed AND on disk       — a manifest entry with no
//                                                          file is the exact shape that
//                                                          makes `bundle_has` lie
//  3. `bundle-key.bin` is exactly 32 bytes               — AES-256; a truncated key
//                                                          fails only at extract time
//  4. `tar_sha256` is a real 64-hex digest               — the integrity gate must be
//                                                          usable, not a placeholder
//  5. the manifest's `target` matches the platform       — `release-local.ps1` stages
//     being built                                          Windows and Linux payloads
//                                                          through the SAME paths, so a
//                                                          stale bundle from the other
//                                                          platform is a live hazard,
//                                                          not a hypothetical one
//
// Check 5 is the one worth keeping honest about: without it this script would
// happily pass a Linux `grove.enc` embedded in a Windows MSI, which is precisely
// the mix-up the release script already warns about in prose for the wallet-rpc
// payloads.
//
// # The escape hatch
//
// A developer building locally without a staged runtime is a legitimate case, so
// `PWNDA_ALLOW_UNBUNDLED=1` downgrades failure to a loud warning. It is opt-IN by
// an explicit environment variable and it prints what the resulting installer
// will not be able to do — the point is that shipping without the bundle becomes
// a decision somebody made, rather than the silent default it used to be.
//
// Usage:
//   node scripts/check-bundle-payloads.mjs <win32|linux> [--payloads=grove,miners]

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const LOG = "[bundle-check]";
const BIN_DIR = path.join(REPO, "src-tauri", "binaries");

const argv = process.argv.slice(2);
const TARGET = argv.find((a) => a === "win32" || a === "linux");
if (!TARGET) {
  console.error(`${LOG} usage: node scripts/check-bundle-payloads.mjs <win32|linux> [--payloads=grove,miners]`);
  process.exit(2);
}
const payloadsArg = argv.find((a) => a.startsWith("--payloads="));
const REQUIRED = (payloadsArg ? payloadsArg.slice("--payloads=".length) : "grove,miners")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOW_UNBUNDLED = process.env.PWNDA_ALLOW_UNBUNDLED === "1";
const problems = [];

async function sizeOf(p) {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
}

async function main() {
  const manifestPath = path.join(BIN_DIR, "bundle-manifest.json");
  let manifest = null;
  const rawManifest = await readFile(manifestPath, "utf8").catch(() => null);

  if (rawManifest === null) {
    problems.push(`no bundle-manifest.json in src-tauri/binaries/`);
  } else {
    try {
      manifest = JSON.parse(rawManifest);
    } catch (e) {
      problems.push(`bundle-manifest.json does not parse: ${e.message}`);
    }
  }

  if (manifest) {
    if (manifest.schema !== "pwnda.binary-bundle/1") {
      problems.push(`manifest schema is ${JSON.stringify(manifest.schema)}, expected "pwnda.binary-bundle/1"`);
    }
    // Check 5 — the cross-platform mix-up guard.
    if (manifest.target !== TARGET) {
      problems.push(
        `manifest was built for target "${manifest.target}" but this build is "${TARGET}" — ` +
          `re-run: node scripts/bundle-binaries.mjs ${TARGET}`
      );
    }

    const listed = new Map((manifest.payloads ?? []).map((p) => [p.name, p]));
    for (const name of REQUIRED) {
      const entry = listed.get(name);
      if (!entry) {
        problems.push(`payload "${name}" is not in the manifest`);
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(entry.tar_sha256 ?? "")) {
        problems.push(`payload "${name}" has no usable tar_sha256 (the integrity gate)`);
      }
      const encPath = path.join(BIN_DIR, entry.enc_file ?? `${name}.enc`);
      const size = await sizeOf(encPath);
      if (size === null) {
        problems.push(`payload "${name}" is listed but ${path.relative(REPO, encPath)} is missing`);
      } else if (size < 1024) {
        problems.push(`payload "${name}" is only ${size} bytes — truncated or a placeholder`);
      } else {
        console.log(`${LOG} OK   ${name.padEnd(7)} ${(size / 1048576).toFixed(1)} MB  ${entry.enc_file}`);
      }
    }
  }

  const keySize = await sizeOf(path.join(BIN_DIR, "bundle-key.bin"));
  if (keySize === null) {
    problems.push(`bundle-key.bin is missing`);
  } else if (keySize !== 32) {
    problems.push(`bundle-key.bin is ${keySize} bytes, expected exactly 32 (AES-256)`);
  }

  if (problems.length === 0) {
    console.log(`${LOG} all ${REQUIRED.length} payload(s) present and well-formed for ${TARGET}`);
    return;
  }

  const header = ALLOW_UNBUNDLED ? "WARNING" : "FATAL";
  console.error(`${LOG} ${header}: the build is not carrying its binary bundles.`);
  for (const p of problems) console.error(`${LOG}   - ${p}`);
  console.error(`${LOG}`);
  console.error(`${LOG} An installer built now would ship WITHOUT them, which means:`);
  console.error(`${LOG}   * opting into the swap engine fails with no offline route to a runtime`);
  console.error(`${LOG}   * miners must be downloaded, so a blocked network breaks mining opt-in`);
  console.error(`${LOG}`);
  console.error(`${LOG} Fix: node scripts/bundle-binaries.mjs ${TARGET}`);
  console.error(`${LOG}   (needs a staged runtime + coin binaries + fetched miners — see`);
  console.error(`${LOG}    binary-bundling-plan.md § producing the bundles)`);

  if (ALLOW_UNBUNDLED) {
    console.error(`${LOG} PWNDA_ALLOW_UNBUNDLED=1 set — continuing anyway. This build is NOT distributable.`);
    return;
  }
  console.error(`${LOG} Set PWNDA_ALLOW_UNBUNDLED=1 to build anyway (local/dev only).`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`${LOG} FAILED: ${e?.stack || e}`);
  process.exit(1);
});
