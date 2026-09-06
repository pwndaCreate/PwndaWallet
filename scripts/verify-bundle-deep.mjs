// Deep verification of src-tauri/binaries/*.enc — decrypt, decompress, hash,
// and read the engine identity out of the grove payload.
//
// # Why this exists, separately from check-bundle-payloads.mjs
//
// That script is the build gate: it answers "is a payload of the right name and
// shape present, and is it named in the manifest". It is deliberately cheap,
// because it runs on every `tauri:build`. It therefore CANNOT answer two
// questions that matter just as much:
//
//   1. Does bundle-key.bin actually decrypt this payload?
//      On 2026-09-04 `bundle-binaries.mjs --only=grove` minted a fresh key while
//      leaving miners.enc encrypted under the old one. Nothing failed. The gate
//      printed `OK miners 32.9 MB miners.enc`, because a file of the right name
//      and size was sitting there. The failure would first have surfaced as a
//      decrypt error inside bundle.rs on an end user's machine, the first time
//      they opted into mining. AES-GCM's auth tag makes this checkable: a
//      successful decrypt IS the proof that the key belongs to the payload.
//
//   2. Which ENGINE is inside the grove payload?
//      `bundle-binaries.mjs --runtime-src <dir>` will pack whatever directory it
//      is pointed at, and defaults to `.swap-sidecar-work/runtime` — the
//      DEPLOYED node, which is intentionally not upgraded in step with the patch
//      series. So "the repo has patch N" and "the installer ships patch N" are
//      independent facts. This reads pwnda-grove.json out of the actual tar and
//      prints the identity, so they can be compared rather than assumed.
//
// This is the same failure class apply-engine-patches.mjs was written for: an
// artifact that does not contain what the repo says it does, with nothing
// checking.
//
// USAGE
//   node scripts/verify-bundle-deep.mjs [win32|linux]
//
// Exits 0 when every payload decrypts, its tar matches the manifest's
// tar_sha256, and (for grove) an engine identity was found. Non-zero otherwise.

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash, createDecipheriv } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const LOG = "[bundle-deep]";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO, "src-tauri", "binaries");
const TARGET = process.argv[2] || "win32";

// Use the SAME tools bundle-binaries.mjs uses. On Windows that is Git's GNU
// tar/xz, and GNU tar reads `C:\path` as a remote `host:path` spec -- it fails
// with "Cannot connect to C: resolve failed", which has nothing to do with the
// archive. --force-local turns that off. Found the hard way: the first run of
// this script reported "no pwnda-grove.json in the payload" when the real cause
// was tar never opening the file at all.
const WIN32_TOOLS = {
  // Forward slashes on purpose: Node accepts them on Windows, and they keep
  // this list free of the backslash-escaping traps that produced a bogus
  // "Invalid Unicode escape sequence" while this file was being written.
  tar: [
    "C:/Program Files/Git/usr/bin/tar.exe",
    "C:/Program Files (x86)/Git/usr/bin/tar.exe",
  ],
  xz: [
    "C:/Program Files/Git/mingw64/bin/xz.exe",
    "C:/Program Files (x86)/Git/mingw64/bin/xz.exe",
  ],
};
async function resolveTool(name) {
  if (process.platform === "win32") {
    const { access } = await import("node:fs/promises");
    for (const c of WIN32_TOOLS[name] ?? []) {
      try { await access(c); return c; } catch { /* next */ }
    }
  }
  return name;
}
let TAR_BIN = "tar";
let XZ_BIN = "xz";
const LOCAL = process.platform === "win32" ? ["--force-local"] : [];

/** The stamp's path inside the tar. `runtime/` is the in-tar name on every
 *  platform — bundle-binaries.mjs renames the source dir at tar time precisely
 *  so this holds (see its `rename` handling). */
const STAMP_ENTRY = "runtime/Lib/site-packages/pwnda-grove.json";

async function main() {
  TAR_BIN = await resolveTool("tar");
  XZ_BIN = await resolveTool("xz");

  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(OUT_DIR, "bundle-manifest.json"), "utf8")
    );
  } catch (e) {
    console.error(`${LOG} cannot read bundle-manifest.json: ${e.message}`);
    console.error(`${LOG} build the bundles first: node scripts/bundle-binaries.mjs ${TARGET}`);
    process.exit(1);
  }

  if (manifest.target !== TARGET) {
    console.error(`${LOG} manifest is for target "${manifest.target}", asked for "${TARGET}"`);
    process.exit(1);
  }

  let key;
  try {
    key = await readFile(path.join(OUT_DIR, "bundle-key.bin"));
  } catch (e) {
    console.error(`${LOG} cannot read bundle-key.bin: ${e.message}`);
    process.exit(1);
  }
  if (key.length !== 32) {
    console.error(`${LOG} bundle-key.bin is ${key.length} bytes, expected 32`);
    process.exit(1);
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "pwnda-bundle-deep-"));
  let failures = 0;
  let identity = null;

  try {
    for (const entry of manifest.payloads || []) {
      const encPath = path.join(OUT_DIR, entry.enc_file);
      let enc;
      try {
        enc = await readFile(encPath);
      } catch (e) {
        console.error(`${LOG} FAIL ${entry.name}: ${entry.enc_file} unreadable (${e.message})`);
        failures++;
        continue;
      }

      // .enc = nonce(12) || ciphertext || tag(16)
      if (enc.length < 12 + 16) {
        console.error(`${LOG} FAIL ${entry.name}: ${enc.length} bytes is too short to be nonce+tag`);
        failures++;
        continue;
      }
      const nonce = enc.subarray(0, 12);
      const tag = enc.subarray(enc.length - 16);
      const ct = enc.subarray(12, enc.length - 16);

      let xzBytes;
      try {
        const d = createDecipheriv("aes-256-gcm", key, nonce);
        d.setAuthTag(tag);
        xzBytes = Buffer.concat([d.update(ct), d.final()]);
      } catch {
        // GCM's tag check is the whole point: this is what a stale key looks
        // like, and it is invisible to a presence-only check.
        console.error(
          `${LOG} FAIL ${entry.name}: does not decrypt under bundle-key.bin ` +
            `(GCM tag mismatch). The usual cause is a partial rebuild that ` +
            `re-minted the key while leaving this payload on the old one.`
        );
        failures++;
        continue;
      }

      const xzPath = path.join(tmp, `${entry.name}.tar.xz`);
      const tarPath = path.join(tmp, `${entry.name}.tar`);
      await writeFile(xzPath, xzBytes);
      try {
        await execFileP(XZ_BIN, ["-d", "-f", xzPath], { maxBuffer: 8 * 1024 * 1024 });
      } catch (e) {
        console.error(`${LOG} FAIL ${entry.name}: xz -d failed (${e.message})`);
        failures++;
        continue;
      }

      const tarBytes = await readFile(tarPath);
      const sha = createHash("sha256").update(tarBytes).digest("hex");
      if (sha !== entry.tar_sha256) {
        console.error(`${LOG} FAIL ${entry.name}: tar_sha256 mismatch`);
        console.error(`${LOG}        manifest ${entry.tar_sha256}`);
        console.error(`${LOG}        actual   ${sha}`);
        failures++;
        continue;
      }

      let extra = "";
      if (entry.name === "grove") {
        // List first, so "tar could not run" and "the stamp is not in the
        // archive" are reported as the different problems they are.
        let names;
        try {
          const { stdout } = await execFileP(
            TAR_BIN, [...LOCAL, "-tf", tarPath], { maxBuffer: 256 * 1024 * 1024 }
          );
          names = stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((n) => n.replace(/\\/g, "/"));
        } catch (e) {
          console.error(
            `${LOG} FAIL grove: could not list the tar (${String(e.message).split(/\r?\n/)[0]})`
          );
          console.error(`${LOG}        this is a TOOLING failure, not a statement about the payload`);
          failures++;
          continue;
        }
        const hit = names.find((n) => n.replace(/^\.\//, "") === STAMP_ENTRY);
        if (!hit) {
          console.error(
            `${LOG} FAIL grove: ${STAMP_ENTRY} is not in the payload — the packed ` +
              `runtime carries no Grove identity, so which patch level it holds ` +
              `cannot be established from the artifact.`
          );
          const near = names.filter((n) => n.includes("pwnda-grove")).slice(0, 3);
          if (near.length) console.error(`${LOG}        nearby: ${near.join(", ")}`);
          console.error(`${LOG}        top-level: ${[...new Set(names.map((n) => n.split("/")[0]))].slice(0, 6).join(", ")}`);
          failures++;
          continue;
        }
        // Which COINS the payload carries. On 2026-09-04 dogecoin and dash were
        // staged in every dev tree and in no installer, and nothing said so --
        // "the bundle built fine" was true and told you nothing about coverage.
        // Naming them here makes a thinner release visible at verify time
        // instead of when a user tries to trade the missing coin.
        const coins = [
          ...new Set(
            names
              .map((n) => /(?:^|\/)bin\/([^/]+)\//.exec(n)?.[1])
              .filter((c) => typeof c === "string"),
          ),
        ].sort();
        if (coins.length) {
          console.log(`${LOG}      coins (${coins.length}): ${coins.join(", ")}`);
        } else {
          console.error(`${LOG} FAIL grove: no bin/<coin>/ entries in the payload`);
          failures++;
          continue;
        }

        try {
          const { stdout } = await execFileP(
            TAR_BIN, [...LOCAL, "-xOf", tarPath, hit], { maxBuffer: 4 * 1024 * 1024 }
          );
          const stamp = JSON.parse(stdout);
          identity = stamp.id || null;
          extra = `  engine: ${identity}`;
        } catch (e) {
          console.error(
            `${LOG} FAIL grove: ${hit} is present but unreadable (${String(e.message).split(/\r?\n/)[0]})`
          );
          failures++;
          continue;
        }
      }

      console.log(
        `${LOG} OK   ${entry.name.padEnd(7)} decrypts, tar sha matches` +
          ` (${(tarBytes.length / 1048576).toFixed(1)} MB)${extra}`
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`${LOG} ${failures} payload(s) FAILED deep verification`);
    process.exit(1);
  }
  console.log(
    `${LOG} all ${(manifest.payloads || []).length} payload(s) verified for ${TARGET}` +
      (identity ? ` — an installer built now ships ${identity}` : "")
  );
}

main().catch((e) => {
  console.error(`${LOG} ${e.stack || e}`);
  process.exit(1);
});
