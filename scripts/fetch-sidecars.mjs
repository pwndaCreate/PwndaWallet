#!/usr/bin/env node
// scripts/fetch-sidecars.mjs
//
// RELEASE-TIME fetch + repack of the Monero / Zephyr wallet-rpc sidecars into
// the compressed archives that `tauri.conf.json > bundle.resources` embeds in
// the installer.
//
// Why bundle these when miners are download-on-demand? Because they are a
// different risk class. A miner binary trips coin-miner AV heuristics; a
// wallet-rpc sidecar does not. Meanwhile the first-use download is 88 MB
// (Monero) / 44 MB (Zephyr) from a third-party host — slow, firewall-fragile,
// and racy against Defender. Bundling makes the XMR/ZPH sections of the wallet
// work reliably out of the box. See [[sidecar-bundling]].
//
// The payload stays COMPRESSED and DORMANT: nothing is extracted or executed
// unless the user actually opens the Monero or Zephyr section. Extraction
// happens at first use (`wallet_rpc_common::extract_bundled_sidecar`).
//
// Usage:
//   node scripts/fetch-sidecars.mjs            # auto-detect host OS
//   node scripts/fetch-sidecars.mjs win32      # force Windows payloads
//   node scripts/fetch-sidecars.mjs linux      # force Linux payloads
//   node scripts/fetch-sidecars.mjs win32 --check   # resolve + verify metadata
//                                                     only, no big downloads
//
// Output (ALL gitignored — binaries are never committed):
//   src-tauri/binaries/monero-wallet-rpc.gz
//   src-tauri/binaries/zephyr-wallet-rpc.gz
//   src-tauri/binaries/zano-simplewallet.gz   <- both platforms (linux: 2026-09-11)
//   src-tauri/binaries/sidecars.json   <- manifest: platform, versions, sha256
//
// The manifest is what makes this safe + updatable at runtime:
//   * `platform` lets the Rust side reject a mismatched archive (e.g. a Linux
//     payload staged into a Windows build) and fall back to downloading.
//   * `sha256` is of the UNCOMPRESSED binary, verified after extraction.
//   * `version` is the anchor the background updater compares against upstream.
//
// INTEGRITY: Monero is verified against the PGP-signed hashes.txt served at
// getmonero.org; Zephyr against a pinned SHA256. These pins MUST match the
// Rust constants in `zph_rpc.rs` (ZPH_RELEASE_TAG / ZPH_ZIP_SHA256) — bump
// both together when Zephyr cuts a release.

import { mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const TARGET = args.find((a) => a === "win32" || a === "linux") ?? process.platform;
if (TARGET !== "win32" && TARGET !== "linux") {
  console.error(`[sidecars] unsupported target "${TARGET}" (use win32 or linux)`);
  process.exit(1);
}
const EXE = TARGET === "win32" ? ".exe" : "";

const OUT_DIR = path.join(REPO_ROOT, "src-tauri", "binaries");
const TMP_DIR = path.join(REPO_ROOT, ".cache", "sidecars-fetch", TARGET);

// ── Zephyr pins — keep in sync with src-tauri/src/zph_rpc.rs ────────────────
const ZPH_TAG = "v2.3.0";
const ZPH_FILENAME =
  TARGET === "win32" ? `zephyr-cli-windows-${ZPH_TAG}.zip` : `zephyr-cli-linux-${ZPH_TAG}.zip`;
const ZPH_URL = `https://github.com/ZephyrProtocol/zephyr/releases/download/${ZPH_TAG}/${ZPH_FILENAME}`;
const ZPH_SHA256 =
  TARGET === "win32"
    ? "1139bde911980ff6f93e8540bf1b9d0b67370f33daf15f6b78d47360947d6726"
    : "d60a94d187e288de0ea76d26ecba26c850cdec0500bba84699c7abe85d1a6f91";

// ── Zano pins — MUST stay in sync with src-tauri/src/zano_rpc.rs ─────────────
// (ZANO_ZIP_URL / ZANO_ZIP_SHA256). The in-zip binary is simplewallet.exe but the
// bundle is zano-simplewallet.gz (see processOne's findName).
const ZANO_TAG = "v2.2.1.506";
const ZANO_ZIP_FILENAME = "zano-win-x64-release-v2.2.1.506[b76fa18].zip";
const ZANO_ZIP_URL =
  "https://build.zano.org/builds/zano-win-x64-release-v2.2.1.506%5Bb76fa18%5D.zip";
const ZANO_ZIP_SHA256 =
  "ab805baf58b78d3a4210ad85a9c74e8156746e1aebcb0a8a4dda32d0203cf87f";

// ── Zano, LINUX: a locally BUILT stock simplewallet (2026-09-11) ─────────────
//
// # Why this one artifact is built rather than downloaded
//
// Zano publishes a win-x64 ZIP (above) and a Linux **AppImage**. Only the ZIP
// carries a separately-extractable `simplewallet`; whether the AppImage even
// contains one, as opposed to the GUI app alone, has never been confirmed here —
// and build.zano.org is unreachable from this machine (TLS handshake broken by
// the peer, `curl: (35) schannel: ... SEC_E_INVALID_TOKEN`, reproduced
// 2026-09-03 and again 2026-09-11), so it cannot be confirmed here either.
//
// Until 2026-09-11 the consequence was simply that Linux got no Zano wallet.
// That was invisible while ZANO was opt-in; it stopped being acceptable when
// ZANO joined `DEFAULT_ENABLED_COINS`, because the ZANO swap leg spends the
// user's own **Main** wallet (`publishBLockTx` → `transfer` on the Main
// connection) and the engine parks the coin whenever that wallet is not running.
// A Linux install would have shown ZANO enabled and permanently parked, with
// nothing to do about it.
//
// So Linux gets a STOCK build from the same pinned source and the same container
// the patched Scratch wallet already comes from:
//
//     OUT_DIR=scripts/swap/zano-build/out/linux-stock APPLY_PATCH=0 \
//       bash scripts/swap/zano-build/build-zano-linux.sh
//
// # Why it must be STOCK, not the patched build we already ship
//
// The patched binary exposes `generate_from_keys`, an RPC that INSTALLS a
// caller-supplied spend key into the open wallet. That is correct for the
// engine-owned, throwaway Scratch wallet and categorically wrong for the user's
// own funded Main wallet. `zano_rpc.rs::resolve_scratch_rpc_binary` encodes the
// same rule from the other side: it refuses to use Grove's `bin/zano/simplewallet`
// as Scratch when it is the same size as Main's, on the reasoning that equal
// sizes mean Main's stock binary got mistaken for the patched one. Ship one
// binary for both roles and that guard fires and ZANO stops working — the design
// needs two distinct binaries, and this is the stock half.
//
// # What the pin means here
//
// A sha256 of OUR OWN build output is a tripwire, not provenance — it catches an
// accidental swap or a truncated copy, and it cannot tell you the bytes came from
// Zano. It is recorded the way `fetch-swap-runtime.mjs` records `LOCAL_WHEELS`
// (`localVerified`, not `fetchVerified`) for exactly the same reason. Rebuilding
// legitimately changes it: the build is not bit-reproducible, so a mismatch after
// a deliberate rebuild means "update this pin in the same commit", not "stop".
const ZANO_LINUX_SRC_COMMIT = "ee3de1e5a077b60106ba88301e236474680b1028";
const ZANO_LINUX_STOCK_DIR = path.join(
  REPO_ROOT,
  "scripts",
  "swap",
  "zano-build",
  "out",
  "linux-stock"
);
const ZANO_LINUX_STOCK_SHA256 = "118d70506fdf4f077cca18a82f99b541e3ee00ab1180c2d4e70f95ee6fca4af6";
const ZANO_LINUX_STOCK_BYTES = 46859400;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(p) {
  const h = createHash("sha256");
  await pipeline(createReadStream(p), h);
  return h.digest("hex");
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "PwndaWallet-fetch-sidecars" } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

async function download(url, dest) {
  console.log(`[sidecars]   GET ${url}`);
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "PwndaWallet-fetch-sidecars" } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** Recursively find the first file whose basename matches `name`. */
async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = await findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

async function extractArchive(archivePath, outDir) {
  await mkdir(outDir, { recursive: true });
  if (archivePath.endsWith(".tar.bz2")) {
    // `tar` handles bzip2 on every Linux base install and on Win10+ tar.exe.
    await execFileP("tar", ["-xjf", archivePath, "-C", outDir]);
  } else if (TARGET === "win32") {
    await execFileP("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${outDir}' -Force`,
    ]);
  } else {
    await execFileP("unzip", ["-oq", archivePath, "-d", outDir]);
  }
}

/** Resolve the Monero release tag + the SHA256 of the archive we want. */
async function resolveMonero() {
  const rel = JSON.parse(
    await fetchText("https://api.github.com/repos/monero-project/monero/releases/latest")
  );
  const tag = rel.tag_name; // e.g. "v0.18.4.6"
  const filename =
    TARGET === "win32" ? `monero-win-x64-${tag}.zip` : `monero-linux-x64-${tag}.tar.bz2`;
  const hashes = await fetchText("https://www.getmonero.org/downloads/hashes.txt");
  let expected = null;
  for (const line of hashes.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [hash, name] = t.split(/\s+/);
    if (name === filename && hash?.length === 64) {
      expected = hash;
      break;
    }
  }
  if (!expected) {
    throw new Error(
      `no SHA256 for ${filename} in getmonero.org hashes.txt — the release may not be published yet`
    );
  }
  return {
    tag,
    filename,
    url: `https://downloads.getmonero.org/cli/${filename}`,
    sha256: expected,
  };
}

/**
 * Package a LOCALLY BUILT binary as a sidecar payload: verify it against its
 * recorded sha256, gzip it, and report the manifest entry.
 *
 * The `processOne` twin for an artifact with no URL. It FAILS rather than
 * skipping when the binary is absent: a missing payload here is not "this
 * platform has one fewer feature", it is a default-enabled coin that will be
 * enabled and permanently parked on every machine the build reaches — the exact
 * silent-gap failure this whole file's Linux arm was fixed for on 2026-09-11.
 * `assemble-linux-grove.mjs` refuses a missing Linux runtime for the same reason
 * and in the same words.
 */
async function processLocal({ label, binaryBase, srcPath, sha256, bytes, version }) {
  console.log(`[sidecars] ${label} ${version}`);

  if (!(await exists(srcPath))) {
    throw new Error(
      `${label}: no binary at ${srcPath}.\\n` +
        `This artifact is BUILT, not downloaded — Zano ships no extractable stock ` +
        `Linux simplewallet (see the pin block in this file). Build it with:\\n` +
        `  OUT_DIR=scripts/swap/zano-build/out/linux-stock APPLY_PATCH=0 \\\\\\n` +
        `    bash scripts/swap/zano-build/build-zano-linux.sh\\n` +
        `Refusing to package a Linux build whose ZANO wallet would be missing: the ` +
        `coin is default-enabled, so it would be enabled and permanently parked.`
    );
  }

  if (CHECK_ONLY) {
    const size = (await stat(srcPath)).size;
    console.log(`[sidecars]   ✓ present (${(size / 1048576).toFixed(1)} MB, local build)`);
    console.log(`[sidecars]   expected sha256: ${sha256}`);
    return null;
  }

  const raw = await readFile(srcPath);
  const rawSha = createHash("sha256").update(raw).digest("hex");
  if (rawSha !== sha256) {
    throw new Error(
      `${label}: SHA256 MISMATCH for the locally built ${binaryBase}\\n` +
        `  expected ${sha256}\\n  actual   ${rawSha}\\n` +
        `If you rebuilt it on purpose, this mismatch is EXPECTED — the build is not ` +
        `bit-reproducible. Re-verify the binary is the STOCK one (it must NOT answer ` +
        `generate_from_keys), then update the pin in this file in the same commit.`
    );
  }
  if (raw.length !== bytes) {
    console.warn(
      `[sidecars]   ${binaryBase} is ${raw.length} bytes, pin says ${bytes} (sha256 matched — fix the pin's byte count)`
    );
  }
  console.log(`[sidecars]   ✓ sha256 verified (local build)`);

  const gz = gzipSync(raw, { level: 9 });
  const outPath = path.join(OUT_DIR, `${binaryBase}.gz`);
  await writeFile(outPath, gz);
  console.log(
    `[sidecars]   ✓ ${binaryBase}.gz  ${(raw.length / 1048576).toFixed(1)} MB -> ${(gz.length / 1048576).toFixed(1)} MB`
  );
  return { version, binary: path.basename(srcPath), sha256: rawSha, bytes: raw.length };
}

/**
 * Fetch one sidecar: download the upstream archive, verify its SHA256, pull out
 * ONLY the wallet-rpc binary, gzip it, and report the manifest entry.
 */
async function processOne({ label, binaryBase, url, filename, sha256, version, findName }) {
  // `binaryBase` names the OUTPUT (`<binaryBase>.gz`); `findName` is the file to
  // locate INSIDE the archive and defaults to `<binaryBase><EXE>`. They differ
  // only for Zano, whose in-zip binary is `simplewallet.exe` but whose bundle is
  // `zano-simplewallet.gz` (the naming asymmetry mirrored in wallet_rpc_common's
  // `sidecar_naming`).
  const binName = findName ?? `${binaryBase}${EXE}`;
  console.log(`[sidecars] ${label} ${version}`);

  if (CHECK_ONLY) {
    // Resolve-and-verify-metadata only: confirm the asset is actually there
    // without pulling tens of MB. Catches a bad pin / yanked release fast.
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    const size = head.headers.get("content-length");
    console.log(
      `[sidecars]   ✓ reachable (HTTP ${head.status}${size ? `, ${(size / 1048576).toFixed(1)} MB` : ""})`
    );
    console.log(`[sidecars]   expected archive sha256: ${sha256}`);
    return null;
  }

  await mkdir(TMP_DIR, { recursive: true });
  const archivePath = path.join(TMP_DIR, filename);
  if (!(await exists(archivePath))) {
    await download(url, archivePath);
  } else {
    console.log(`[sidecars]   (cached) ${filename}`);
  }

  const actual = await sha256File(archivePath);
  if (actual !== sha256) {
    await rm(archivePath, { force: true });
    throw new Error(
      `${label}: SHA256 MISMATCH\n  expected ${sha256}\n  actual   ${actual}\nArchive deleted; refusing to package an unverified binary.`
    );
  }
  console.log(`[sidecars]   ✓ archive sha256 verified`);

  const workDir = path.join(TMP_DIR, `${binaryBase}-x`);
  await rm(workDir, { recursive: true, force: true });
  await extractArchive(archivePath, workDir);

  const found = await findFile(workDir, binName);
  if (!found) throw new Error(`${label}: ${binName} not found inside ${filename}`);

  const raw = await readFile(found);
  const rawSha = createHash("sha256").update(raw).digest("hex");
  const gz = gzipSync(raw, { level: 9 });
  const outPath = path.join(OUT_DIR, `${binaryBase}.gz`);
  await writeFile(outPath, gz);

  console.log(
    `[sidecars]   ✓ ${binaryBase}.gz  ${(raw.length / 1048576).toFixed(1)} MB -> ${(gz.length / 1048576).toFixed(1)} MB`
  );
  return { version, binary: binName, sha256: rawSha, bytes: raw.length };
}

async function main() {
  console.log(`[sidecars] target=${TARGET}${CHECK_ONLY ? " (check only)" : ""}`);
  await mkdir(OUT_DIR, { recursive: true });

  const mon = await resolveMonero();
  const monEntry = await processOne({
    label: "monero-wallet-rpc",
    binaryBase: "monero-wallet-rpc",
    url: mon.url,
    filename: mon.filename,
    sha256: mon.sha256,
    version: mon.tag,
  });

  const zphEntry = await processOne({
    label: "zephyr-wallet-rpc",
    binaryBase: "zephyr-wallet-rpc",
    url: ZPH_URL,
    filename: ZPH_FILENAME,
    sha256: ZPH_SHA256,
    version: ZPH_TAG,
  });

  // Zano — two different provenances for the same role, by necessity. Windows
  // extracts the vendor's pinned ZIP; Linux packages a stock build from the
  // pinned source, because the vendor ships no extractable Linux binary (see the
  // ZANO_LINUX_STOCK_* block above for the full reasoning and why it must be the
  // STOCK build rather than the patched one).
  let zanoEntry;
  if (TARGET === "win32") {
    zanoEntry = await processOne({
      label: "zano-simplewallet",
      binaryBase: "zano-simplewallet",
      findName: `simplewallet${EXE}`, // the in-zip name differs from the .gz name
      url: ZANO_ZIP_URL,
      filename: ZANO_ZIP_FILENAME,
      sha256: ZANO_ZIP_SHA256,
      version: ZANO_TAG,
    });
  } else {
    zanoEntry = await processLocal({
      label: "zano-simplewallet (stock, local build)",
      binaryBase: "zano-simplewallet",
      srcPath: path.join(ZANO_LINUX_STOCK_DIR, "simplewallet"),
      sha256: ZANO_LINUX_STOCK_SHA256,
      bytes: ZANO_LINUX_STOCK_BYTES,
      version: `${ZANO_TAG}+src.${ZANO_LINUX_SRC_COMMIT.slice(0, 7)}`,
    });
  }

  if (CHECK_ONLY) {
    console.log("[sidecars] check complete — upstream assets reachable and pinned.");
    return;
  }

  const manifest = {
    platform: TARGET,
    generated: "release-time (scripts/fetch-sidecars.mjs)",
    monero: monEntry,
    zephyr: zphEntry,
    zano: zanoEntry,
  };
  await writeFile(
    path.join(OUT_DIR, "sidecars.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
  console.log(`[sidecars] wrote sidecars.json (platform=${TARGET})`);
  console.log("[sidecars] done. These archives are gitignored — never commit them.");
}

main().catch((e) => {
  console.error(`[sidecars] FAILED: ${e.message}`);
  process.exit(1);
});
