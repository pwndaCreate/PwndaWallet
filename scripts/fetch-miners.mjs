#!/usr/bin/env node
// scripts/fetch-miners.mjs
//
// LOCAL / DEV prefetch of platform-correct miner binaries. Convenience for
// offline or air-gapped development — the shipped app does NOT rely on this.
// Miners are NOT bundled and NOT committed (pure-wallet de-bundle, 2026-07-06);
// the real distribution path is the in-app download-on-demand into
// <app-data>/miners (see src-tauri/src/miners.rs::download_miner). Every
// output directory below is gitignored, so running this never re-commits a
// binary.
//
// Usage:
//   node scripts/fetch-miners.mjs            # auto-detect host OS
//   node scripts/fetch-miners.mjs win32      # force Windows variant
//   node scripts/fetch-miners.mjs linux      # force Linux variant
//
// Output layout (both gitignored):
//   src/mining/                              (Windows staging)
//   src-tauri/resources/miners-linux/        (Linux staging)
//
// SHA256 hashes are pinned in scripts/miners-manifest.json. Mismatch aborts
// the extraction — never silently fall back to an unverified binary.
//
// See PwndaWalletVault/wiki/synthesis/linux-port-plan.md §4.2.

import { mkdir, writeFile, chmod, readFile, rm, stat, cp, copyFile, readdir } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "scripts", "miners-manifest.json");

const TARGET = process.argv[2] ?? process.platform; // "win32" | "linux"
if (TARGET !== "win32" && TARGET !== "linux") {
  console.error(`[fetch-miners] unsupported target "${TARGET}" (use win32 or linux)`);
  process.exit(1);
}

const STAGING_DIR =
  TARGET === "win32"
    ? path.join(REPO_ROOT, "src", "mining")
    : path.join(REPO_ROOT, "src-tauri", "resources", "miners-linux");

const TMP_DIR = path.join(REPO_ROOT, ".cache", "miners-fetch", TARGET);

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function download(url, dest) {
  console.log(`[fetch-miners]   GET ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed (${res.status}): ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function verify(filePath, expectedSha256, minerName) {
  if (expectedSha256.startsWith("TODO_")) {
    console.warn(
      `[fetch-miners]   ⚠ ${minerName}: SHA256 not pinned (${expectedSha256}). ` +
      `Fill scripts/miners-manifest.json with the correct hash before shipping.`
    );
    return; // allow during initial bring-up; CI/release flow should reject this
  }
  const actual = await sha256(filePath);
  if (actual !== expectedSha256) {
    throw new Error(
      `SHA256 mismatch for ${minerName}: expected ${expectedSha256}, got ${actual}`
    );
  }
  console.log(`[fetch-miners]   ✓ sha256 verified`);
}

async function extractZip(zipPath, outDir) {
  // PowerShell on Windows, unzip on Linux. Both are in the host PATH by default.
  if (TARGET === "win32") {
    // Use PowerShell Expand-Archive
    await execFileP("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`,
    ]);
  } else {
    // Linux side: zip files are rare (SRBMiner Windows-only ships zip); use unzip
    await execFileP("unzip", ["-oq", zipPath, "-d", outDir]);
  }
}

async function extractTarGz(tarPath, outDir) {
  await mkdir(outDir, { recursive: true });
  if (TARGET === "win32") {
    // tar.exe is in modern Windows 10+ ships
    await execFileP("tar", ["-xzf", tarPath, "-C", outDir]);
  } else {
    await execFileP("tar", ["-xzf", tarPath, "-C", outDir]);
  }
}

async function processOne(name, spec) {
  const platformSpec = spec[TARGET];
  if (!platformSpec) {
    console.log(`[fetch-miners] skip ${name}: no ${TARGET} entry in manifest`);
    return;
  }
  console.log(`[fetch-miners] ${name} v${spec.version} (${TARGET})`);

  await mkdir(TMP_DIR, { recursive: true });
  const archiveName = path.basename(new URL(platformSpec.url).pathname);
  const archivePath = path.join(TMP_DIR, archiveName);
  const extractDir = path.join(TMP_DIR, `${name}-extracted`);

  if (!(await exists(archivePath))) {
    await download(platformSpec.url, archivePath);
  } else {
    console.log(`[fetch-miners]   cached: ${archivePath}`);
  }

  await verify(archivePath, platformSpec.sha256, name);

  await rm(extractDir, { recursive: true, force: true });
  if (archiveName.endsWith(".zip")) {
    await extractZip(archivePath, extractDir);
  } else if (archiveName.endsWith(".tar.gz") || archiveName.endsWith(".tgz")) {
    await extractTarGz(archivePath, extractDir);
  } else {
    throw new Error(`unknown archive format: ${archiveName}`);
  }

  await mkdir(STAGING_DIR, { recursive: true });

  if (platformSpec.extract_all) {
    // Flatten the extracted tree directly into the staging dir. This
    // matches the runtime extraction behavior in `miners.rs::extract_miner_from_zip`
    // which also flattens via `Path::file_name()`. Used for SRBMiner +
    // Rigel which ship support files (config .sh launchers, .reg fixes,
    // README etc.) alongside the binary; the runtime expects all of them
    // at the top level of `miners_dir`.
    //
    // The manifest's `subdir` field is the version-pinned root inside the
    // archive (e.g. `SRBMiner-Multi-3-2-8`); we copy the *contents* of that
    // dir directly into staging, not the dir itself.
    const src = platformSpec.subdir
      ? path.join(extractDir, platformSpec.subdir)
      : extractDir;
    let copiedCount = 0;
    for await (const file of walkFiles(src)) {
      const dest = path.join(STAGING_DIR, file.relName);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(file.absPath, dest);
      copiedCount++;
    }
    if (TARGET === "linux") {
      // The miner binary's exact name is the manifest key (e.g.
      // "SRBMiner-MULTI" or "rigel"). It lives at STAGING_DIR/<name> after
      // flatten and needs +x. Best-effort: ignore if the archive doesn't
      // contain exactly that name.
      const candidate = path.join(STAGING_DIR, name);
      try {
        await chmod(candidate, 0o755);
      } catch {
        // archives may use a different binary name; user can chmod manually
      }
    }
    console.log(`[fetch-miners]   → ${copiedCount} files into ${path.relative(REPO_ROOT, STAGING_DIR)}/`);
  } else if (platformSpec.extract) {
    const srcRel = platformSpec.extract;
    const src = path.join(extractDir, srcRel);
    const destName = path.basename(srcRel);
    const dest = path.join(STAGING_DIR, destName);
    await rm(dest, { force: true });
    await copyFile(src, dest);
    if (TARGET === "linux") {
      await chmod(dest, 0o755);
    }
    console.log(`[fetch-miners]   → ${path.relative(REPO_ROOT, dest)}`);
  } else {
    throw new Error(`manifest entry for ${name}/${TARGET} has neither 'extract' nor 'extract_all'`);
  }
}

/** Walk every file under `root`, yielding `{absPath, relName}` for each.
 *  Subdirectories are preserved in `relName` so callers can choose to flatten
 *  via `path.basename(relName)` or keep structure. We flatten in extract_all
 *  to match the runtime behavior. */
async function* walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      // Flatten: yield with just the file basename, mirroring miners.rs
      // `Path::file_name()` flattening.
      yield { absPath: full, relName: entry.name };
    }
  }
}

async function main() {
  console.log(`[fetch-miners] target=${TARGET}, staging=${path.relative(REPO_ROOT, STAGING_DIR)}`);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  for (const [name, spec] of Object.entries(manifest.miners)) {
    try {
      await processOne(name, spec);
    } catch (err) {
      console.error(`[fetch-miners] ${name} failed: ${err.message}`);
      process.exitCode = 1;
    }
  }
  if (process.exitCode === 1) {
    console.error("[fetch-miners] one or more miners failed; see above.");
  } else {
    console.log("[fetch-miners] done.");
  }
}

main().catch(err => {
  console.error("[fetch-miners] fatal:", err);
  process.exit(1);
});
