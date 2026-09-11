#!/usr/bin/env node
// scripts/assemble-linux-grove.mjs
//
// Stages the Linux coin-daemon binaries into a canonical `linux-grove/bin/`
// tree, and verifies the Linux Python/BasicSwap runtime is complete — the two
// prerequisites `bundle-binaries.mjs linux` needs before it can produce a
// working `grove.enc`.
//
// # Why the runtime itself is NOT copied here
//
// The assembled Linux runtime (`.swap-sidecar-work/linux-runtime`, a
// python-build-standalone `install_only` tree with BasicSwap pip-installed
// into it) contains a real POSIX symlink — `bin/python -> python3.12`, part
// of the upstream archive. On this machine that symlink was created by WSL as
// an NTFS reparse point that Node's `fs` bindings and Git Bash's own `cp`
// cannot read or recreate (`EACCES`/`EINVAL` on lstat; `cp` refuses to create
// the copy) — confirmed by hand, twice, before writing this script. The real
// `tar` binary reads it correctly, so `bundle-binaries.mjs` now archives the
// runtime DIRECTLY from `.swap-sidecar-work/linux-runtime` (no copy) and
// renames it to `runtime/` inside the tar via `--transform`. See that
// script's `buildPayload` doc for the full account.
//
// So this script's only filesystem work is copying the FIVE COIN BINARIES
// (plain ELF files, no symlinks, unaffected by any of the above) into one
// place with the coins-in-one-place. If the coin sources ever gain the same
// symlink problem, the fix is the same: point bundle-binaries.mjs at the
// original location and let it rename at tar time, not here.
//
// # Provenance of the two coins this had to fetch new
//
// particl / litecoin / monero were already staged under
// `.swap-sidecar-work/linux-stage/cores/` by an earlier, undocumented manual
// process. bitcoin / bitcoincash were not — both were fetched and verified
// 2026-08-29, against SHA256 hashes read from the SAME signed, multi-platform
// release manifests already staged alongside this repo's WINDOWS bitcoin /
// bitcoincash zips (`bitcoin-win-29.4-build-hebasto.assert`,
// `SHA256SUMS.Calin_Culianu`) — the identical hash source that already
// vouches for the Windows binaries shipping today, extended to their Linux
// sibling line in the same file, rather than a freshly-trusted download.
// See PwndaWalletVault/log.md 2026-08-29 for the full record.
//
// Usage:
//   node scripts/assemble-linux-grove.mjs [--check]
//     --check   verify sources exist and report; copy nothing
//
// Idempotent: safe to re-run. Never touches .swap-sidecar-work/runtime or
// .swap-sidecar-work/bin (the WINDOWS sources bundle:win reads).

import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
import {
  BUNDLED_COINS as ALL_BUNDLED_COINS,
  COIN_BINARIES as ALL_COIN_BINARIES,
  bundledCoinsFor,
} from "./bundle-binaries.mjs";

const LOG = "[assemble-linux-grove]";

export const LINUX_RUNTIME_SRC = path.join(REPO, ".swap-sidecar-work", "linux-runtime");
const CORES_SRC = path.join(REPO, ".swap-sidecar-work", "linux-stage", "cores");
export const LINUX_GROVE_BIN = path.join(REPO, ".swap-sidecar-work", "linux-grove", "bin");

// IMPORTED from bundle-binaries.mjs, not mirrored (2026-09-06).
//
// This block used to be a hand-kept copy of that file's tables, with a comment
// saying it was "kept in sync by inspection, not by import, since that script
// has no exports". It was not in sync: the bundler gained zephyr, dogecoin,
// dash and zano on 2026-09-04 and this copy kept its five, so a Linux release
// staged 5 coins, the bundler demanded 9, and the build failed on
// `linux-grove/bin/zephyr/zephyrd`.
//
// One fact in two places, synchronised by a comment, is the same shape that
// produced the zephyr defect the bundler's v1 guard was written for and the
// dogecoin/dash pair its v2 guard caught. The fix is the one the old comment
// said was unavailable: the tables are exported now, so this stages exactly
// what the bundler will ask for — including which coins this PLATFORM omits
// and why (`NOT_BUNDLED_FOR` there).
const LINUX_COINS = bundledCoinsFor("linux");
const COIN_BINARIES = Object.fromEntries(
  LINUX_COINS.map((c) => [c, ALL_COIN_BINARIES[c]]),
);

const CHECK_ONLY = process.argv.includes("--check");

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`${LOG} runtime (read in place, not copied): ${path.relative(REPO, LINUX_RUNTIME_SRC)}`);
  console.log(`${LOG} cores source: ${path.relative(REPO, CORES_SRC)}`);

  if (!(await exists(LINUX_RUNTIME_SRC))) {
    console.error(
      `${LOG} FATAL: no assembled Linux runtime at ${LINUX_RUNTIME_SRC}. This is a ` +
        `hand-built Python+BasicSwap tree (see swap-runtime.json's "Staged, not ` +
        `assembled" note) — it is not produced by an npm script.`
    );
    process.exit(1);
  }
  // A real regular directory (not the bin/python symlink — that path is
  // deliberately never touched by this script; see the module header).
  // basicswap's own package directory is proof the runtime is not just a bare
  // interpreter.
  const basicswapPkg = path.join(LINUX_RUNTIME_SRC, "lib", "python3.12", "site-packages", "basicswap");
  if (!(await exists(basicswapPkg))) {
    console.error(`${LOG} FATAL: ${basicswapPkg} missing — this runtime does not have BasicSwap installed`);
    process.exit(1);
  }

  // ── Patch-level parity with Windows ────────────────────────────────────
  //
  // Linux shipped Grove p19 for ten days while Windows shipped p27, and three
  // Linux bundles were advertised on the download page carrying the older
  // engine. The cause was that `apply-engine-patches.mjs` identified a runtime
  // by `python.exe` + `Lib/site-packages`, so the POSIX tree was invisible to
  // it and every "patched, success" run had simply never looked at Linux.
  //
  // That predicate is fixed. This is the gate that makes the fix hold: the two
  // runtimes' patch levels are COMPARED at build time, and a difference stops
  // the build. Fixing the enumerator prevents the accident; only a comparison
  // prevents it silently recurring for some other reason.
  //
  // A deliberate divergence is DECLARED here with a reason, the same shape as
  // NOT_BUNDLED_FOR in bundle-binaries.mjs — because "declare it or remove it"
  // is the only version of this that stays true.
  const ALLOWED_PATCH_LEVEL_GAP = null; // e.g. { linux: 27, win: 28, why: "..." }

  const grovePath = (root, ...rest) => path.join(root, ...rest, "pwnda-grove.json");
  const readLevel = async (p) => {
    try {
      const { readFile } = await import("node:fs/promises");
      return JSON.parse(await readFile(p, "utf8"));
    } catch {
      return null;
    }
  };
  const linuxGrove = await readLevel(
    grovePath(LINUX_RUNTIME_SRC, "lib", "python3.12", "site-packages")
  );
  const winGrove = await readLevel(
    grovePath(path.join(REPO, ".swap-sidecar-work", "runtime"), "Lib", "site-packages")
  );

  if (!linuxGrove) {
    console.error(
      `${LOG} FATAL: the Linux runtime carries no pwnda-grove.json, so which patch ` +
        `level it holds cannot be established from the tree that is about to ship.`
    );
    process.exit(1);
  }
  if (!winGrove) {
    // Not fatal: a Linux-only build machine legitimately has no Windows runtime.
    console.log(`${LOG} no Windows runtime present to compare against — skipping parity check`);
  } else if (linuxGrove.id !== winGrove.id) {
    // Compare the whole identity, not the patch level alone.
    //
    // Until 2026-09-10 this compared `patchLevel` only, and that was a hole
    // exactly the shape this gate exists to close: a Linux runtime at
    // `0.18.5+p31` against Windows at `0.18.6+p31` would have passed, printed
    // "engine parity ok", and shipped a different upstream engine to Linux
    // users. That is the very outcome a "just apply the missing patches"
    // shortcut produces when the series has been rebased onto a newer
    // upstream -- so the advice below is split by WHAT differs, because the
    // patch-only fix is the wrong one when the upstream has moved.
    const sameUpstream = linuxGrove.upstream?.version === winGrove.upstream?.version;
    const ok =
      sameUpstream &&
      ALLOWED_PATCH_LEVEL_GAP &&
      ALLOWED_PATCH_LEVEL_GAP.linux === linuxGrove.patchLevel &&
      ALLOWED_PATCH_LEVEL_GAP.win === winGrove.patchLevel;
    if (!ok) {
      const fix = sameUpstream
        ? `${LOG} Fix:     node scripts/apply-engine-patches.mjs --target .swap-sidecar-work/linux-runtime`
        : `${LOG} Fix:     the Linux runtime's basicswap package is a DIFFERENT UPSTREAM (` +
          `${linuxGrove.upstream?.version} vs ${winGrove.upstream?.version}). Applying patches
` +
          `${LOG}          cannot bridge that; rebuild it from the pin -- see
` +
          `${LOG}          basicswap-upstream-sync.md § THE BUMP IS NOW TWO-PLATFORM.`;
      console.error(
        `${LOG} FATAL: engine identities differ — linux ${linuxGrove.id} vs windows ${winGrove.id}.
` +
          `${LOG} Linux users would get a different swap engine from Windows users, which is
` +
          `${LOG} how p19 shipped against p27 for ten days.
` +
          fix +
          `
${LOG} Declare: a patch-level gap on the SAME upstream may be declared via ALLOWED_PATCH_LEVEL_GAP, with the reason.`
      );
      process.exit(1);
    }
    console.log(
      `${LOG} patch levels differ by declaration: linux ${linuxGrove.id} vs windows ${winGrove.id} — ${ALLOWED_PATCH_LEVEL_GAP.why}`
    );
  } else {
    console.log(`${LOG} engine parity ok: ${linuxGrove.id} on both platforms`);
  }

  let missing = 0;
  for (const [coin, files] of Object.entries(COIN_BINARIES)) {
    for (const f of files) {
      const p = path.join(CORES_SRC, coin, f);
      if (!(await exists(p))) {
        console.error(`${LOG} MISSING: ${path.relative(REPO, p)}`);
        missing++;
      }
    }
  }
  if (missing > 0) {
    console.error(`${LOG} FATAL: ${missing} coin binary(ies) missing — cannot assemble a complete Grove bundle`);
    process.exit(1);
  }
  console.log(
    `${LOG} all ${Object.keys(COIN_BINARIES).length} Linux-bundled coins present ` +
      `(${LINUX_COINS.join(", ")})`,
  );

  // The other half of `NOT_BUNDLED_FOR`: an exemption that is no longer true
  // silently ships FEWER coins than the tree can support, which is the same
  // failure the bundler's v2 guard exists for, pointed the other way. If a
  // coin we declared unstageable is in fact staged, say so loudly — the
  // exemption is the thing to delete, not the coin.
  const stale = [];
  for (const coin of ALL_BUNDLED_COINS) {
    if (LINUX_COINS.includes(coin)) continue;
    const files = ALL_COIN_BINARIES[coin] ?? [];
    const present = [];
    for (const f of files) {
      if (await exists(path.join(CORES_SRC, coin, f))) present.push(f);
    }
    if (present.length === files.length && files.length > 0) stale.push(coin);
  }
  if (stale.length > 0) {
    console.error(
      `${LOG} FATAL: ${stale.join(", ")} is declared unavailable on Linux in ` +
        `bundle-binaries.mjs's NOT_BUNDLED_FOR, but every binary IS staged in ` +
        `${path.relative(REPO, CORES_SRC)}. Remove the exemption so the coin ships — ` +
        `a stale exemption hides a shippable coin exactly the way a missing entry ` +
        `hides a broken one.`,
    );
    process.exit(1);
  }

  if (CHECK_ONLY) {
    console.log(`${LOG} --check passed, nothing copied`);
    return;
  }

  await rm(LINUX_GROVE_BIN, { recursive: true, force: true });
  await mkdir(LINUX_GROVE_BIN, { recursive: true });
  for (const coin of Object.keys(COIN_BINARIES)) {
    const dest = path.join(LINUX_GROVE_BIN, coin);
    await mkdir(dest, { recursive: true });
    for (const f of COIN_BINARIES[coin]) {
      await cp(path.join(CORES_SRC, coin, f), path.join(dest, f));
    }
  }
  console.log(`${LOG} copied ${Object.keys(COIN_BINARIES).length} coins -> ${path.relative(REPO, LINUX_GROVE_BIN)}`);
  console.log(
    `${LOG} done. Next: node scripts/bundle-binaries.mjs linux ` +
      `--runtime-src=${path.relative(REPO, LINUX_RUNTIME_SRC)} ` +
      `--grove-bin=${path.relative(REPO, LINUX_GROVE_BIN)}`
  );
}

main().catch((e) => {
  console.error(`${LOG} FAILED: ${e?.stack || e}`);
  process.exit(1);
});
