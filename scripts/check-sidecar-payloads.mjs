#!/usr/bin/env node
// scripts/check-sidecar-payloads.mjs
//
// BUILD GATE for the bundled wallet binaries (Monero, Zephyr, Zano, Xelis).
// Producer: scripts/fetch-sidecars.mjs. Consumer:
// src-tauri/src/wallet_rpc_common.rs::extract_bundled_sidecar.
//
// # Why this exists
//
// `check-bundle-payloads.mjs` gates the encrypted miners and swap-engine
// bundles and nothing else. The wallet payloads had no gate, so two failures
// were silent until a user hit them:
//
//  * Xelis was added to fetch-sidecars.mjs on 2026-09-15, but the staged set on
//    the dev machine dated from 2026-09-13. Nothing noticed, and the wallet told
//    the user to "Download it from Settings first", a control that does not
//    exist (log.md, 2026-09-16).
//  * Windows and Linux stage through the SAME paths (Tauri 2 has no per-OS
//    resources), and the Linux half of a release runs last. The tree is then
//    left holding Linux payloads, which a Windows run rejects wholesale.
//
// # What it checks
//
//  1. `sidecars.json` exists, parses, and its `platform` is the target.
//  2. All four wallets are listed, each with the binary name this platform
//     needs, a real SHA256, and a real size.
//  3. Each `<name>.gz` is on disk and not a placeholder.
//  4. (default; `--shallow` skips it) each payload gunzips to exactly the bytes
//     the manifest describes: same SHA256, same length. This is the check the
//     app runs before it writes a binary, so failing it here means that wallet
//     would fall back to a download.
//
// # Modes
//
//   node scripts/check-sidecar-payloads.mjs [win32|linux] [--shallow]
//   node scripts/check-sidecar-payloads.mjs --warn     # shallow, never fails,
//                                                      # silent when fine (npm predev)
//
// The target defaults to the host platform.
//
// `PWNDA_ALLOW_UNBUNDLED=1` downgrades failure to a warning, as in
// check-bundle-payloads.mjs.

import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIDECAR_PAYLOADS, binaryFileName } from "./lib/sidecar-payloads.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const LOG = "[sidecar-check]";
const BIN_DIR = path.join(REPO, "src-tauri", "binaries");

const argv = process.argv.slice(2);
const WARN_ONLY = argv.includes("--warn");
const SHALLOW = WARN_ONLY || argv.includes("--shallow");
const TARGET =
  argv.find((a) => a === "win32" || a === "linux") ??
  (process.platform === "win32" ? "win32" : "linux");
const ALLOW_UNBUNDLED = process.env.PWNDA_ALLOW_UNBUNDLED === "1";

/** Smallest real payload. Every wallet binary here is well over this. */
const MIN_GZ_BYTES = 1024 * 1024;

export async function checkSidecarPayloads({ binDir, target, shallow }) {
  const problems = [];
  const ok = [];
  const raw = await readFile(path.join(binDir, "sidecars.json"), "utf8").catch(() => null);
  if (raw === null) {
    problems.push("no sidecars.json in src-tauri/binaries/");
    return { problems, ok };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    problems.push(`sidecars.json does not parse: ${e.message}`);
    return { problems, ok };
  }
  if (manifest.platform !== target) {
    problems.push(
      `sidecars.json is staged for "${manifest.platform}" but this build is "${target}" — ` +
        `the app rejects every bundled wallet binary for another platform`
    );
    return { problems, ok };
  }

  for (const p of SIDECAR_PAYLOADS) {
    const entry = manifest[p.id];
    if (!entry) {
      problems.push(`${p.id}: not in sidecars.json`);
      continue;
    }
    const want = binaryFileName(p, target);
    if (entry.binary !== want) {
      problems.push(`${p.id}: manifest names binary "${entry.binary}", this platform needs "${want}"`);
    }
    if (!entry.version) problems.push(`${p.id}: no version (the updater compares against it)`);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) problems.push(`${p.id}: no usable sha256`);
    if (!(entry.bytes > MIN_GZ_BYTES)) problems.push(`${p.id}: implausible size ${entry.bytes}`);

    const gzPath = path.join(binDir, `${p.gz}.gz`);
    const size = await stat(gzPath).then((s) => s.size).catch(() => null);
    if (size === null) {
      problems.push(`${p.id}: ${p.gz}.gz is missing`);
      continue;
    }
    if (size < MIN_GZ_BYTES) {
      problems.push(`${p.id}: ${p.gz}.gz is only ${size} bytes — truncated or a placeholder`);
      continue;
    }
    if (!shallow) {
      let bytes;
      try {
        bytes = gunzipSync(await readFile(gzPath));
      } catch (e) {
        problems.push(`${p.id}: ${p.gz}.gz does not gunzip: ${e.message}`);
        continue;
      }
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== entry.sha256) {
        problems.push(`${p.id}: payload sha256 ${sha} != manifest ${entry.sha256}`);
        continue;
      }
      if (bytes.length !== entry.bytes) {
        problems.push(`${p.id}: payload is ${bytes.length} bytes, manifest says ${entry.bytes}`);
        continue;
      }
    }
    ok.push(`${p.id.padEnd(6)} ${entry.version.padEnd(24)} ${want} (${(size / 1048576).toFixed(1)} MB gz)`);
  }
  return { problems, ok };
}

async function main() {
  const { problems, ok } = await checkSidecarPayloads({ binDir: BIN_DIR, target: TARGET, shallow: SHALLOW });
  if (problems.length === 0) {
    // `--warn` runs before every `npm run dev`; say nothing when all is well.
    if (WARN_ONLY) return;
    for (const line of ok) console.log(`${LOG} OK   ${line}${SHALLOW ? "" : "  sha256 verified"}`);
    console.log(`${LOG} all ${SIDECAR_PAYLOADS.length} wallet binaries staged for ${TARGET}`);
    return;
  }

  const fatal = !WARN_ONLY && !ALLOW_UNBUNDLED;
  console.error(`${LOG} ${fatal ? "FATAL" : "WARNING"}: the bundled wallet binaries are not ready for ${TARGET}.`);
  for (const p of problems) console.error(`${LOG}   - ${p}`);
  console.error(`${LOG} A build now ships without them: those wallets download their binary on first`);
  console.error(`${LOG} use, and a blocked network leaves them unable to open.`);
  console.error(`${LOG} Fix: node scripts/fetch-sidecars.mjs ${TARGET}`);
  if (!fatal) return;
  console.error(`${LOG} Set PWNDA_ALLOW_UNBUNDLED=1 to build anyway (local/dev only).`);
  process.exit(1);
}

// Run only as a script, so the test can import `checkSidecarPayloads`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG} FAILED: ${e?.stack || e}`);
    process.exit(WARN_ONLY ? 0 : 1);
  });
}
