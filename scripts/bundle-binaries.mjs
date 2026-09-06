#!/usr/bin/env node
// scripts/bundle-binaries.mjs
//
// RELEASE-TIME producer for the encrypted binary bundles (binary-bundling-plan).
// The CONSUMER side is src-tauri/src/bundle.rs.
//
// Ships the AV-sensitive binaries INSIDE the installer, dormant until opt-in:
//   * miners  (xmrig, lolMiner, SRBMiner-MULTI)  -> extracted into <app-data>/miners
//   * grove   (Python/BasicSwap runtime + 5 coin daemons: particl, bitcoin,
//              litecoin, bitcoincash, monero) -> extracted into
//              <app-data>/swap-sidecar/ (i.e. runtime/ + bin/<coin>/)
//
// Per payload:  tar -> xz -9 -> AES-256-GCM(nonce || ciphertext+tag)  ->  <name>.enc
// Plus:         bundle-manifest.json (enc_file + tar_sha256 gate) and
//               bundle-key.bin (a PER-BUILD random 32-byte key, PLAINTEXT).
//
// THE KEY IS OBFUSCATION, NOT SECURITY. The binaries are public downloads; the
// key ships beside the blobs. Its only job is to raise entropy so an AV
// archive-unpacker cannot recurse into a .enc and match a miner signature inside
// the installer. Trust is the SHA256 gate on the decompressed tar, not the
// cipher. Per-build-random so a leaked key never covers a future build.
//
// Output (ALL gitignored — binaries/keys are never committed):
//   src-tauri/binaries/miners.enc
//   src-tauri/binaries/grove.enc
//   src-tauri/binaries/bundle-manifest.json
//   src-tauri/binaries/bundle-key.bin
//
// Usage:
//   node scripts/bundle-binaries.mjs <win32|linux> [--only=miners|grove]
//        [--miners-src DIR] [--grove-bin DIR] [--runtime-src DIR] [--out DIR]
//
// SOURCE LAYOUT (staged by the existing fetch scripts):
//   --miners-src  : dir holding the extracted miner files (fetch-miners.mjs
//                   stages src/mining on win32, src-tauri/resources/miners-linux
//                   on linux). Default picks by platform.
//   --grove-bin   : dir holding <coin>/<binaries> (fetch-swap-runtime stages the
//                   coin cores). Default .swap-sidecar-work/bin.
//   --runtime-src : the assembled Python/BasicSwap runtime tree. Default
//                   .swap-sidecar-work/runtime.
//
// Needs `tar` and `xz` on PATH (Git-for-Windows / Linux both ship them). Fails
// loudly if either is missing — a silent fallback would ship an unencrypted or
// uncompressed bundle.

import { readFileSync } from "node:fs";
import { mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { createHash, randomBytes, createCipheriv } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const LOG = "[bundle]";

// ---- args -------------------------------------------------------------------
//
// This module is IMPORTED as well as run: `assemble-linux-grove.mjs` reads its
// coin tables rather than keeping a second copy (2026-09-06 — the copy had
// drifted and broke the Linux release). So the CLI half only fires when this
// file IS the entry point; an import gets the tables and nothing else.
const IS_CLI = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();

const argv = process.argv.slice(2);
const TARGET = argv.find((a) => a === "win32" || a === "linux");
if (IS_CLI && !TARGET) {
  console.error(`${LOG} usage: node scripts/bundle-binaries.mjs <win32|linux> [--only=miners|grove] [--miners-src DIR] [--grove-bin DIR] [--runtime-src DIR] [--out DIR]`);
  process.exit(2);
}
const argVal = (flag, dflt) => {
  const a = argv.find((x) => x.startsWith(`${flag}=`)) || (() => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? `${flag}=${argv[i + 1]}` : undefined;
  })();
  return a ? a.slice(a.indexOf("=") + 1) : dflt;
};
const ONLY = argVal("--only", null); // "miners" | "grove" | null(both)
const FORCE = argv.includes("--force"); // rebuild even when the input stamp matches
const EXE = TARGET === "win32" ? ".exe" : "";
const OUT_DIR = path.resolve(argVal("--out", path.join(REPO, "src-tauri", "binaries")));
const MINERS_SRC = path.resolve(
  argVal("--miners-src", TARGET === "win32" ? path.join(REPO, "src", "mining") : path.join(REPO, "src-tauri", "resources", "miners-linux"))
);
const GROVE_BIN = path.resolve(argVal("--grove-bin", path.join(REPO, ".swap-sidecar-work", "bin")));
const RUNTIME_SRC = path.resolve(argVal("--runtime-src", path.join(REPO, ".swap-sidecar-work", "runtime")));
const TMP = path.join(REPO, ".cache", "bundle-build");

// ---- payload definitions ----------------------------------------------------
// Exactly the files each payload ships. Coin binary lists mirror
// fetch-swap-runtime.mjs; miner files mirror miners-manifest.json (extract_all
// miners keep their whole staged folder).
export const COIN_BINARIES = {
  particl: ["particld", "particl-cli", "particl-tx", "particl-wallet"],
  bitcoin: ["bitcoind", "bitcoin-cli", "bitcoin-tx", "bitcoin-wallet"],
  litecoin: ["litecoind", "litecoin-cli", "litecoin-tx", "litecoin-wallet"],
  bitcoincash: ["bitcoind", "bitcoin-cli", "bitcoin-tx", "bitcoin-wallet"],
  monero: ["monerod", "monero-wallet-rpc"],
  // PWNDA 2026-09-04: zephyr. Same daemon+wallet-rpc pair shape as monero
  // (Zephyr is a Monero fork). Get-SwapCoinBinaries.ps1 stages exactly these
  // two out of the release archive -- deliberately not zephyr-wallet-cli,
  // which nothing uses and which would otherwise be encrypted into every
  // installer.
  zephyr: ["zephyrd", "zephyr-wallet-rpc"],
  // PWNDA 2026-09-04: dogecoin + dash. Both were STAGED and GPG-verified by
  // Get-SwapCoinBinaries.ps1 and present in every dev tree (7 exes each), and
  // both were missing from BUNDLED_COINS with no comment saying so -- so they
  // worked on the operator's machine and would have been absent from every
  // shipped installer. Exactly the zephyr defect this file's own guard was
  // written for, twice more, undetected because that guard compared this file
  // against itself. Same four-binary shape as bitcoin; -qt, -util and test_*
  // are deliberately excluded (unused, and -qt alone is ~30 MB per coin).
  dogecoin: ["dogecoind", "dogecoin-cli", "dogecoin-tx", "dogecoin-wallet"],
  dash: ["dashd", "dash-cli", "dash-tx", "dash-wallet"],
  // PWNDA 2026-09-04: zano, unit A5. NOT a stock download -- the swap engine's
  // scratch wallet needs `generate_from_keys`, which upstream Zano does not
  // have, so this is the locally BUILT patched binary from
  // scripts/swap/zano-build/ (hyle-team/zano @ ee3de1e5 + the vendored patch).
  // Verified patched, not stock, by string-probing the built binary against the
  // stock one we already ship: generate_from_keys FOUND vs absent, with
  // getbalance present in both as the control proving the probe discriminates.
  // The two OpenSSL DLLs are listed because the build is STATIC=FALSE.
  zano: [
    "zanod",
    "simplewallet",
    "libcrypto-3-x64.dll",
    "libssl-3-x64.dll",
  ],
};

/**
 * Engine coins that are KNOWINGLY not bundled, with the reason.
 *
 * Being in this map is a decision; being in neither this map nor
 * BUNDLED_COINS is an accident, and the guard below is what tells them apart.
 */
const NOT_BUNDLED = {
  // (empty) Every coin the engine can run is bundled as of 2026-09-04, when
  // unit A5's patched Zano wallet was finally built. Keep the map: an entry
  // here is a DECLARED omission with a reason, which is what the guard below
  // distinguishes from an accidental one.
};

/**
 * Coins a given PLATFORM cannot ship, with the reason. Same contract as
 * `NOT_BUNDLED` — a declaration is a decision, silence is a bug — but scoped
 * to the target rather than to the product.
 *
 * # Why this had to exist (2026-09-06)
 *
 * `assemble-linux-grove.mjs` carried its own copy of `COIN_BINARIES` with a
 * comment saying it was "kept in sync by inspection". It was not: the bundler
 * gained zephyr, dogecoin, dash and zano on 2026-09-04 and the assembler kept
 * its five, so a Linux release staged 5 coins, the bundler demanded 9, and the
 * build died on the first one it could not find:
 *
 *     [assemble-linux-grove] all 5 coins present as Linux binaries
 *     [bundle] grove source missing: linux-grove/bin/zephyr/zephyrd
 *
 * That is the THIRD time this file's own lists have drifted from a sibling —
 * after the zephyr defect the v1 guard was written for and the dogecoin/dash
 * pair that v2 caught. The pattern is always the same: one fact in two places,
 * synchronised by a comment. So the assembler now IMPORTS these tables (the
 * reason it did not was "that script has no exports", which this commit
 * removes), and the platform's own gaps are declared here where the guard can
 * see them.
 *
 * These four are absent from `.swap-sidecar-work/linux-stage/cores` — a
 * hand-staged tree, per swap-runtime.json's "Staged, not assembled" note. Zano
 * additionally has no Linux release at all (`fetch-sidecars.mjs` says so on
 * every run: "zano: skipped (Windows-only; no pinned Linux archive)").
 */
const NOT_BUNDLED_FOR = {
  linux: {
    zephyr: "no Linux binaries staged in .swap-sidecar-work/linux-stage/cores",
    dogecoin: "no Linux binaries staged in .swap-sidecar-work/linux-stage/cores",
    dash: "no Linux binaries staged in .swap-sidecar-work/linux-stage/cores",
    zano: "Windows-only: no pinned Linux archive, and the patched wallet is a Windows build",
  },
};

/**
 * The coins a target actually ships. Exported so
 * `assemble-linux-grove.mjs` stages exactly this set instead of mirroring it.
 */
export function bundledCoinsFor(target) {
  const skip = NOT_BUNDLED_FOR[target] ?? {};
  return BUNDLED_COINS.filter((c) => !skip[c]);
}

export const BUNDLED_COINS = [
  "particl",
  "bitcoin",
  "litecoin",
  "bitcoincash",
  "monero",
  "zephyr",
  "dogecoin",
  "dash",
  "zano",
];

// ── Paired-site guard, v2 (2026-09-04) ──────────────────────────────────────
//
// v1 of this guard was written for the zephyr defect: the fetch catalog knew
// zephyr in 25 places, this file knew it in none, so its binaries were staged,
// hash-verified, and then silently not shipped. v1 read:
//
//     for (const coin of BUNDLED_COINS) if (!COIN_BINARIES[coin]) throw
//
// **That check could not fail for the reason it was written.** It compares this
// file's two lists against EACH OTHER, so it only catches a coin present in one
// of them. A coin missing from BOTH -- which is precisely what "the bundler has
// never heard of this coin" looks like -- satisfies it silently.
//
// It was not hypothetical. On 2026-09-04, with v1 in place and green, DOGECOIN
// and DASH were staged and GPG-verified in every dev tree (7 exes each) and in
// neither list, so they worked on the operator's machine and would have been
// absent from every shipped installer. The guard written to stop exactly that
// watched it happen twice.
//
// v2 compares against the ENGINE's own coin list -- `WALLET_SIDECAR_COINS` in
// swap_sidecar.rs -- which is the real other half of the fact. Every coin the
// node can run must be either bundled or explicitly declared unbundled with a
// reason. Silence is the bug; a declaration is a decision.
const ENGINE_COINS = (() => {
  const rs = path.join(REPO, "src-tauri", "src", "swap_sidecar.rs");
  let src;
  try {
    src = readFileSync(rs, "utf8");
  } catch (e) {
    throw new Error(
      `${LOG} cannot read ${rs} to cross-check the coin list (${e.message}). ` +
        `Refusing to build a bundle whose coverage cannot be verified.`,
    );
  }
  const m = src.match(/pub const WALLET_SIDECAR_COINS: &\[&str\] = &\[([\s\S]*?)\];/);
  if (!m) {
    throw new Error(
      `${LOG} WALLET_SIDECAR_COINS not found in swap_sidecar.rs. It was renamed ` +
        `or reshaped; update this guard rather than deleting it -- an unchecked ` +
        `bundle silently ships fewer coins than the engine offers.`,
    );
  }
  const coins = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  if (coins.length === 0) throw new Error(`${LOG} parsed an empty WALLET_SIDECAR_COINS`);
  return coins;
})();

for (const coin of BUNDLED_COINS) {
  if (!COIN_BINARIES[coin]) {
    throw new Error(
      `bundle-binaries: "${coin}" is in BUNDLED_COINS but has no COIN_BINARIES ` +
        `entry. These two lists are one fact in two places -- add the binary ` +
        `names, or drop the coin.`,
    );
  }
}

for (const coin of ENGINE_COINS) {
  if (BUNDLED_COINS.includes(coin)) continue;
  if (NOT_BUNDLED[coin]) {
    console.warn(`${LOG} NOT bundling "${coin}": ${NOT_BUNDLED[coin]}`);
    continue;
  }
  throw new Error(
    `bundle-binaries: the swap engine can run "${coin}" (WALLET_SIDECAR_COINS in ` +
      `swap_sidecar.rs) but this bundler neither ships it nor declares why. A user ` +
      `would see it offered in DEX COINS and be told "no daemon binary is seeded" ` +
      `-- on a machine where the dev tree has the binary and the installer does ` +
      `not. Add it to COIN_BINARIES + BUNDLED_COINS, or add a NOT_BUNDLED["${coin}"] ` +
      `reason.`,
  );
}

for (const coin of Object.keys(NOT_BUNDLED)) {
  if (!ENGINE_COINS.includes(coin)) {
    throw new Error(
      `bundle-binaries: NOT_BUNDLED["${coin}"] names a coin the engine cannot run. ` +
        `Stale entry -- remove it, so the exemption list cannot hide a real gap.`,
    );
  }
}

// Same rule for the per-platform exemptions: a stale one hides a real gap just
// as well as a missing one does.
for (const [target, skips] of Object.entries(NOT_BUNDLED_FOR)) {
  for (const coin of Object.keys(skips)) {
    if (!BUNDLED_COINS.includes(coin)) {
      throw new Error(
        `bundle-binaries: NOT_BUNDLED_FOR.${target}["${coin}"] exempts a coin that is ` +
          `not bundled anywhere. Stale entry -- remove it.`,
      );
    }
  }
}
const MINERS = ["xmrig", "lolMiner", "SRBMiner-MULTI"];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Resolve `tar` and `xz` to a binary GUARANTEED to be GNU-compatible, on
 * Windows — never trust bare PATH lookup there.
 *
 * # Two real failures traced to this on 2026-08-29
 *
 * A release run failed with `FATAL: 'xz' not on PATH`, even though `xz.exe`
 * was genuinely installed (`C:\Program Files\Git\mingw64\bin\xz.exe`,
 * confirmed via `Get-Command` in the SAME PowerShell session that had just
 * failed). PATH changes only apply to processes started AFTER the change —
 * a long-lived terminal window keeps whatever PATH existed when it opened,
 * so "the tool is installed" and "this shell can find it" are different
 * facts, and this script's `toolOnPath` conflated them into one FATAL
 * message that pointed at the wrong fix (it looks like a missing install,
 * not a stale shell).
 *
 * Worse, and silent until traced: this script's `tar` calls were resolving
 * to `C:\Windows\System32\tar.exe` — Windows' own bundled bsdtar
 * (libarchive), present on every Windows 10 1803+ install by default, which
 * `toolOnPath`'s `tar --version` check happily accepts. bsdtar does not
 * support `--force-local` OR `--transform` — both required unconditionally
 * by `buildPayload` — confirmed by hand:
 *   `tar.exe --force-local --version` -> "Option --force-local is not supported"
 *   `tar.exe --transform 's,...,'`    -> "Option --transform is not supported"
 * This would have failed the very first real archive build, immediately
 * after the xz problem was fixed — a second outage waiting behind the first,
 * on every Windows machine where System32's tar resolves ahead of Git's (the
 * default on any machine that has not put Git's tar earlier on PATH, which
 * is most of them, since Windows ships tar.exe unconditionally).
 *
 * So on win32 this checks Git-for-Windows' own binaries by ABSOLUTE PATH
 * first — known-good, confirmed to be GNU tar 1.35 and to accept
 * `--force-local`/`--transform` — before ever falling back to bare `tar`/
 * `xz` PATH lookup. The two live in DIFFERENT Git subdirectories
 * (`usr\bin\tar.exe` vs `mingw64\bin\xz.exe`; Git's `usr\bin` does not ship
 * its own `xz.exe`), so both are checked independently rather than assumed
 * to share one directory.
 */
const WIN32_TOOL_CANDIDATES = {
  tar: [
    "C:\\Program Files\\Git\\usr\\bin\\tar.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\tar.exe",
  ],
  xz: [
    "C:\\Program Files\\Git\\mingw64\\bin\\xz.exe",
    "C:\\Program Files (x86)\\Git\\mingw64\\bin\\xz.exe",
  ],
};

async function resolveTool(name) {
  if (process.platform === "win32") {
    for (const candidate of WIN32_TOOL_CANDIDATES[name] ?? []) {
      if (await exists(candidate)) return candidate;
    }
  }
  return name; // bare command name — PATH lookup (correct on Linux already)
}

async function toolOnPath(resolvedPath) {
  try { await execFileP(resolvedPath, ["--version"]); return true; } catch { return false; }
}

/** Escape one path segment for use inside a GNU tar --transform s,,, expression. */
function escapeForTransform(seg) {
  return seg.replace(/[.*+?^${}()|[\]\\,]/g, "\\$&");
}

/**
 * Build one payload: assemble a file list, tar (from a base dir), xz, encrypt.
 *
 * `rename` maps a source-relative top-level entry to the FIXED name the
 * archive should carry it under, e.g. `{ "linux-runtime": "runtime" }`.
 *
 * # Why renaming happens at tar time, not by copying the source first
 *
 * Added 2026-08-29 wiring the Linux Grove bundle. The assembled Linux Python
 * runtime (`.swap-sidecar-work/linux-runtime`) contains a real POSIX symlink
 * (`bin/python -> python3.12`, part of the upstream python-build-standalone
 * archive) that a WSL-created reparse point leaves in a form Node's `fs`
 * bindings — and even Git Bash's own `cp` — cannot read or recreate on this
 * filesystem (`EACCES`/`EINVAL` on lstat; `cp` refuses to create the copy),
 * yet the real `tar` binary reads and archives it correctly, verified by hand
 * (`tar -tvf` shows the symlink target intact). So the archive is built
 * DIRECTLY from the original source directories, whatever they are named on
 * disk, and `--transform` corrects only the recorded path inside the tar. No
 * step here ever tries to reproduce the symlink as a second on-disk file.
 *
 * This also removes a latent fragility that predates Linux entirely: before
 * this, the in-tar layout was whatever `path.basename(RUNTIME_SRC)` happened
 * to be, so a renamed source directory would silently change what the Rust
 * consumer needs to find after extraction. The canonical names are enforced
 * at packaging time now, not inherited from the filesystem.
 */
/**
 * A stamp describing this payload's INPUTS, cheaply.
 *
 * Path + size + mtime of every entry, plus the rename map and the target. Not a
 * content hash: the miners payload is 418 MB and Grove is 565 MB, so hashing to
 * decide whether to compress would cost most of what compressing costs.
 * Size+mtime is the same staleness test `make` has used for fifty years, and
 * these inputs are FETCHED artifacts — `fetch-miners` and `fetch-sidecars`
 * rewrite them whenever a version moves, which moves the mtime.
 *
 * Measured 2026-09-06: `bundle:win` is 94 s, and the Linux side repeats the
 * same work on a larger tree. That is ~4 minutes per release spent producing
 * bytes identical to the ones already on disk.
 */
async function inputStamp({ name, baseDir, entries, rename }) {
  const parts = [`target=${TARGET}`, `name=${name}`, `rename=${JSON.stringify(rename ?? null)}`];
  const walk = async (rel) => {
    const full = path.join(baseDir, rel);
    let st;
    try {
      st = await stat(full);
    } catch {
      parts.push(`${rel}\tMISSING`);
      return;
    }
    if (st.isDirectory()) {
      const kids = (await readdir(full)).sort();
      for (const k of kids) await walk(path.join(rel, k));
      return;
    }
    parts.push(`${rel}\t${st.size}\t${Math.floor(st.mtimeMs)}`);
  };
  for (const e of [...entries].sort()) await walk(e);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

async function buildPayload({ name, baseDir, entries, key, rename }) {
  const listFile = path.join(TMP, `${name}.list`);
  const tarFile = path.join(TMP, `${name}.tar`);
  const xzFile = `${tarFile}.xz`;

  // Unchanged inputs produce byte-identical output, so do not spend 90 s
  // proving it. `--force` bypasses; a changed stamp rebuilds; a missing .enc
  // or a missing previous entry rebuilds.
  const stampFile = path.join(OUT_DIR, `.${name}.stamp`);
  const stamp = await inputStamp({ name, baseDir, entries, rename });
  if (!FORCE) {
    const prevEnc = path.join(OUT_DIR, `${name}.enc`);
    let prev = null;
    try {
      prev = JSON.parse(await readFile(stampFile, "utf8"));
    } catch {}
    if (prev && prev.stamp === stamp && (await exists(prevEnc))) {
      console.log(`${LOG}   ${name.padEnd(8)} unchanged — reusing ${name}.enc (${(prev.encBytes / 1048576).toFixed(1)}MB); --force to rebuild`);
      return { name, enc_file: `${name}.enc`, tar_sha256: prev.tar_sha256 };
    }
  }

  await writeFile(listFile, entries.join("\n") + "\n", "utf8");

  const tarArgs = ["--force-local", "-C", baseDir];
  if (rename) {
    // Two plain substitutions per rename, not one with a `(/|$)` alternation
    // group — GNU tar's --transform is BASIC regex by default, where `(` `)`
    // `|` are literal characters unless backslash-escaped. Verified by hand:
    // the grouped form fails with "back reference out of range" (the `\1` it
    // needs was never a real capture, just literal text tar could not match),
    // while two independent substitutions — one for the bare directory entry,
    // one for its contents — need no grouping at all and were confirmed to
    // produce the exact intended tar listing.
    for (const [from, to] of Object.entries(rename)) {
      const f = escapeForTransform(from);
      const t = escapeForTransform(to);
      tarArgs.push("--transform", `s,^${f}$,${t},`);
      tarArgs.push("--transform", `s,^${f}/,${t}/,`);
    }
  }
  // GNU tar reads a leading drive letter (G:) as a remote host — --force-local
  // is REQUIRED on Windows and harmless on Linux paths without a colon. The
  // archive is created from baseDir so in-tar paths are exactly `entries`,
  // renamed per `rename` above where one is given.
  tarArgs.push("-cf", tarFile, "-T", listFile);
  await execFileP(TAR_BIN, tarArgs, {
    maxBuffer: 64 * 1024 * 1024,
  });
  const tarBytes = await readFile(tarFile);
  const tarSha = createHash("sha256").update(tarBytes).digest("hex");

  await execFileP(XZ_BIN, ["-9", "-T0", "-f", "-k", tarFile], { maxBuffer: 8 * 1024 * 1024 });
  const xzBytes = await readFile(xzFile);

  // AES-256-GCM; .enc = nonce(12) || ciphertext || tag(16)
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(xzBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  const enc = Buffer.concat([nonce, ct, tag]);
  const encName = `${name}.enc`;
  await writeFile(path.join(OUT_DIR, encName), enc);
  // Only after the payload is on disk: a stamp written before the write would
  // let a failed run mark the next one as up to date.
  await writeFile(
    path.join(OUT_DIR, `.${name}.stamp`),
    JSON.stringify({ stamp, tar_sha256: tarSha, encBytes: enc.length }, null, 2),
    "utf8"
  );

  await rm(listFile, { force: true });
  await rm(tarFile, { force: true });
  await rm(xzFile, { force: true });

  console.log(
    `${LOG}   ${encName.padEnd(12)} tar ${(tarBytes.length / 1048576).toFixed(1)}MB -> xz ${(xzBytes.length / 1048576).toFixed(1)}MB -> enc ${(enc.length / 1048576).toFixed(1)}MB`
  );
  return { name, enc_file: encName, tar_sha256: tarSha };
}

/** Resolved once in `main`, read by every `buildPayload` call. */
let TAR_BIN = "tar";
let XZ_BIN = "xz";

async function main() {
  TAR_BIN = await resolveTool("tar");
  XZ_BIN = await resolveTool("xz");

  if (!(await toolOnPath(TAR_BIN))) {
    console.error(
      `${LOG} FATAL: '${TAR_BIN}' did not run. If this looks installed and ` +
        `this is a long-lived terminal, PATH may have changed since it opened ` +
        `— PATH updates only apply to NEW processes, not existing shells. Open ` +
        `a fresh terminal and retry before assuming anything else is wrong.`
    );
    process.exit(1);
  }
  if (process.platform === "win32" && TAR_BIN === "tar") {
    // resolveTool only falls through to the bare name when neither known Git
    // path exists, so if we are HERE on Windows, whatever `tar` resolves to
    // on PATH is untrusted — and the overwhelmingly likely candidate is
    // Windows' own bundled bsdtar (C:\Windows\System32\tar.exe, present by
    // default since Windows 10 1803), which rejects --force-local and
    // --transform outright. Confirmed by hand 2026-08-29:
    //   tar.exe --force-local --version -> "Option --force-local is not supported"
    // Checking for it explicitly here means the error names the real cause
    // instead of surfacing 30 seconds later as a cryptic tar failure mid-build.
    const { stdout, stderr } = await execFileP(TAR_BIN, ["--version"]).catch((e) => ({
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    }));
    if (/bsdtar|libarchive/i.test(stdout + stderr)) {
      console.error(
        `${LOG} FATAL: 'tar' on PATH is Windows' bundled bsdtar, which does not ` +
          `support --force-local or --transform (both required here). Neither ` +
          `known Git-for-Windows tar.exe was found at:\n` +
          WIN32_TOOL_CANDIDATES.tar.map((p) => `${LOG}   ${p}\n`).join("") +
          `${LOG} Install Git for Windows, or put its usr\\bin ahead of ` +
          `System32 on PATH, then retry.`
      );
      process.exit(1);
    }
  }
  if (!(await toolOnPath(XZ_BIN))) {
    console.error(
      `${LOG} FATAL: '${XZ_BIN}' did not run (needed for xz -9). If this looks ` +
        `installed and this is a long-lived terminal, PATH may have changed ` +
        `since it opened — open a fresh terminal and retry before assuming ` +
        `anything else is wrong.`
    );
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  console.log(`${LOG} target=${TARGET} out=${path.relative(REPO, OUT_DIR)}`);
  // A partial rebuild (--only) must NOT mint a fresh key. The payload it is not
  // rebuilding stays on disk encrypted under the OLD key, so a new one makes
  // that file permanently undecryptable -- silently: nothing fails at bundle
  // time, and the installer only breaks when a user opts into that feature.
  // Hit for real on 2026-09-04 running `--only=grove` to repack the engine.
  const KEY_PATH = path.join(OUT_DIR, "bundle-key.bin");
  let key;
  if (ONLY && (await exists(KEY_PATH))) {
    key = await readFile(KEY_PATH);
    if (key.length !== 32) {
      console.error(`${LOG} existing bundle-key.bin is ${key.length} bytes, expected 32 — refusing a partial rebuild against it; re-run without --only`);
      process.exit(1);
    }
    console.log(`${LOG} --only=${ONLY}: reusing the existing key so the payload(s) not rebuilt stay decryptable`);
  } else {
    key = randomBytes(32); // per-build, plaintext (obfuscation, not security)
  }
  const payloads = [];

  const doMiners = ONLY !== "grove";
  const doGrove = ONLY !== "miners";

  // --- miners payload: whole staged miner dir -> extracted into <app-data>/miners
  if (doMiners) {
    if (!(await exists(MINERS_SRC))) {
      console.error(`${LOG} miners source missing: ${MINERS_SRC} (run: node scripts/fetch-miners.mjs ${TARGET})`);
      process.exit(1);
    }
    // Ship every file in the staged miners dir EXCEPT known non-binaries; the
    // three exes + SRBMiner's DLLs all live flat here after fetch-miners.
    const all = await readdir(MINERS_SRC);
    const skip = new Set([".gitignore", ".gitkeep"]);
    const entries = all.filter((f) => !skip.has(f));
    // sanity: the three executables must be present
    for (const m of MINERS) {
      if (!(await exists(path.join(MINERS_SRC, `${m}${EXE}`)))) {
        console.error(`${LOG} miners source is missing ${m}${EXE} in ${MINERS_SRC}`);
        process.exit(1);
      }
    }
    console.log(`${LOG} miners: ${entries.length} files from ${path.relative(REPO, MINERS_SRC)}`);
    payloads.push(await buildPayload({ name: "miners", baseDir: MINERS_SRC, entries, key }));
  }

  // --- grove payload: runtime/ + bin/<coin>/<binaries> -> extracted into
  //     <app-data>/swap-sidecar/ . runtime and bin share the parent
  //     .swap-sidecar-work, so one baseDir (that parent) covers both.
  //
  // The IN-TAR names are always the literal "runtime" and "bin" — see
  // `buildPayload`'s `rename` doc for why this is enforced at tar time
  // instead of assumed from the source directories' own basenames. On
  // Windows this is a no-op transform (the sources are already named that);
  // on Linux the runtime source is `.swap-sidecar-work/linux-runtime` and
  // must still land as `runtime/` after extraction, or `swap_sidecar.rs`'s
  // `runtime_dir()` finds nothing.
  if (doGrove) {
    if (!(await exists(RUNTIME_SRC))) {
      console.error(`${LOG} runtime source missing: ${RUNTIME_SRC} (assemble it first — see fetch-swap-runtime.mjs / assemble-linux-grove.mjs)`);
      process.exit(1);
    }
    const groveBase = path.dirname(RUNTIME_SRC);
    const runtimeRel = path.basename(RUNTIME_SRC); // e.g. "runtime" (win32) or "linux-runtime"
    const binRel = path.relative(groveBase, GROVE_BIN); // e.g. "bin" or "linux-grove/bin"
    const entries = [runtimeRel];
    // The PLATFORM's set, not the product's — see `NOT_BUNDLED_FOR`. Demanding
    // a coin the target cannot stage is what failed the 2026-09-06 Linux
    // release on `zephyr/zephyrd`.
    const coinsForTarget = bundledCoinsFor(TARGET);
    for (const coin of coinsForTarget) {
      for (const b of COIN_BINARIES[coin]) {
        // A name that already carries an extension is taken verbatim. Zano's
        // build is STATIC=FALSE, so libcrypto/libssl must ship BESIDE the
        // .exe or the shipped daemon cannot start -- and appending ".exe" to
        // a ".dll" would have produced "libssl-3-x64.dll.exe", a file that
        // does not exist, failing the build loudly rather than silently. Loud
        // is right; expressible is better.
        const rel = path.join(binRel, coin, /\.[a-z0-9]+$/i.test(b) ? b : `${b}${EXE}`);
        if (!(await exists(path.join(groveBase, rel)))) {
          console.error(`${LOG} grove source missing: ${rel} under ${groveBase}`);
          process.exit(1);
        }
        entries.push(rel.split(path.sep).join("/"));
      }
    }
    const skipped = BUNDLED_COINS.filter((c) => !coinsForTarget.includes(c));
    console.log(
      `${LOG} grove: runtime + ${coinsForTarget.length} coins from ${path.relative(REPO, groveBase)}` +
        (skipped.length ? ` (not on ${TARGET}: ${skipped.join(", ")})` : ""),
    );
    const rename = {};
    if (runtimeRel !== "runtime") rename[runtimeRel] = "runtime";
    if (binRel.split(path.sep).join("/") !== "bin") rename[binRel.split(path.sep).join("/")] = "bin";
    payloads.push(
      await buildPayload({
        name: "grove",
        baseDir: groveBase,
        entries,
        key,
        rename: Object.keys(rename).length ? rename : undefined,
      })
    );
  }

  // --- manifest + key
  // `--only` rebuilds ONE payload; the manifest must still describe both, or
  // check-bundle-payloads.mjs rejects the build ("payload X is not in the
  // manifest"). Carry forward any entry we did not rebuild whose .enc is still
  // on disk, rather than replacing the list wholesale.
  let payloadsOut = payloads;
  if (ONLY) {
    const prevPath = path.join(OUT_DIR, "bundle-manifest.json");
    if (await exists(prevPath)) {
      let prev = null;
      try {
        prev = JSON.parse(await readFile(prevPath, "utf8"));
      } catch (e) {
        console.error(`${LOG} existing bundle-manifest.json is unreadable (${e.message}) — re-run without --only`);
        process.exit(1);
      }
      // A payload built for a DIFFERENT target must never be carried into
      // this one's manifest (2026-09-06). `release-local.ps1` builds Windows
      // and then Linux into this same directory, so after a release the
      // Linux `miners.enc` sits beside a Windows `grove.enc`; a later
      // `--only=grove win32` then rewrote the manifest to `target: win32`
      // while carrying the Linux miners entry forward, and `check-bundle`
      // passed it — it verifies presence and shape, not provenance. The
      // installer would have shipped Linux miners to Windows users.
      if (prev.target && prev.target !== TARGET) {
        console.error(
          `${LOG} refusing --only: the payloads on disk were built for "${prev.target}" ` +
            `and this run targets "${TARGET}". Carrying one forward would put a ` +
            `${prev.target} payload in a ${TARGET} installer. Re-run without --only.`,
        );
        process.exit(1);
      }
      const rebuilt = new Set(payloads.map((p) => p.name));
      const carried = [];
      for (const entry of prev.payloads || []) {
        if (rebuilt.has(entry.name)) continue;
        if (!(await exists(path.join(OUT_DIR, entry.enc_file)))) {
          console.warn(`${LOG} dropping manifest entry "${entry.name}": ${entry.enc_file} is not on disk`);
          continue;
        }
        carried.push(entry);
        console.log(`${LOG} carrying forward payload "${entry.name}" (not rebuilt this run)`);
      }
      payloadsOut = [...carried, ...payloads];
    }
  }

  const manifest = {
    schema: "pwnda.binary-bundle/1",
    target: TARGET,
    generated: new Date().toISOString().slice(0, 10),
    generatedBy: "scripts/bundle-binaries.mjs",
    _what: "Encrypted binary bundles for offline-reliable opt-in. Key in bundle-key.bin is PLAINTEXT and is obfuscation (AV-unpack evasion), not security — the binaries are public. Integrity gate is tar_sha256, verified after decrypt+decompress, before any write. Consumer: src-tauri/src/bundle.rs.",
    payloads: payloadsOut,
  };
  await writeFile(path.join(OUT_DIR, "bundle-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeFile(path.join(OUT_DIR, "bundle-key.bin"), key);
  await rm(TMP, { recursive: true, force: true });

  console.log(`${LOG} wrote ${payloads.length} payload(s), manifest lists ${payloadsOut.length} + bundle-manifest.json + bundle-key.bin`);
  console.log(`${LOG} REMINDER: bundle-*.enc / bundle-key.bin / bundle-manifest.json must be gitignored.`);
}

if (IS_CLI) main().catch((e) => {
  console.error(`${LOG} FAILED: ${e?.stack || e}`);
  process.exit(1);
});
