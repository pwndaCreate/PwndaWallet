#!/usr/bin/env node
/**
 * Apply `upstream/patches/*.patch` to an installed BasicSwap runtime, and say
 * plainly which ones are and are not in it.
 *
 * # Why this exists
 *
 * The patch series was tracked, reviewed, and re-appliable; applying it was a
 * manual step nobody automated. On 2026-08-23 that caught up with us:
 * PWNDA-PATCH-9 — the change-address fix written specifically to stop funds
 * landing past the standard gap limit — had been written, committed, and
 * documented a day earlier, and was NOT in the running runtime. The bug it
 * fixes had therefore never stopped happening. Nothing anywhere reported the
 * gap, because nothing was checking.
 *
 * `--check` is the answer to that: a fast, read-only "what is actually in this
 * runtime", suitable for a preflight.
 *
 * # Why this does not shell out to `patch(1)`
 *
 * It was tried. Two traps, both hit for real:
 *
 *  1. **Line endings.** The runtime's files are CRLF and the patch files are
 *     mixed. `git apply` simply refuses; that part is honest.
 *  2. **Fuzz is not a fallback, it is a hazard.** With `patch -F3` the same
 *     refusal turns into `Hunk #1 succeeded at 519 with fuzz 3` — and line 519
 *     of the installed `wallet_manager.py` is inside `importAddress`, a
 *     completely different function from the one PWNDA-PATCH-9 targets. A
 *     "successful" dry run would have written change-address allocation logic
 *     into an address-import routine, in a wallet, silently.
 *
 * So: normalise endings, and match context EXACTLY. A hunk whose context is
 * not found verbatim, or is found more than once, is a refusal — never a best
 * guess. Line numbers in the hunk header are used for nothing at all, because
 * the installed tree is offset from the pinned tree by every patch already
 * applied.
 *
 * # New files (`--- /dev/null`)
 *
 * A patch that CREATES a file carries no context to match at all — there is
 * nothing on disk yet to find a hunk's `before` lines in, so the ordinary
 * "match context exactly" rule cannot even ask its question. That is not an
 * excuse to guess. The file is written only when BOTH hold: (a) the target
 * path is genuinely absent from the tree being patched, and (b) every hunk
 * in that file's entry is a pure addition — no context lines, no removed
 * lines, i.e. exactly what a real `git diff` against `/dev/null` produces.
 * A hunk that claims "this file does not exist" (`/dev/null`) while also
 * carrying context lines from its supposed existing content is contradicting
 * itself, and is refused rather than resolved by picking one half to
 * believe. If the target path already exists, this file is not new to the
 * tree being patched regardless of what the patch header says, and the
 * ordinary context-matching path below decides what happens to it.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  groveId,
  readStamp,
  writeStamp,
  readUpstreamVersion,
  STAMP_FILE,
} from "./lib/grove-id.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATCH_DIR = join(ROOT, "upstream", "patches");
/** Binary companions to the text patches — see `syncAssets`. */
const ASSET_DIR = join(PATCH_DIR, "assets");
const WORK = join(ROOT, ".swap-sidecar-work");

/**
 * Every EMBEDDED runtime under `.swap-sidecar-work/`, deduplicated by real path.
 *
 * Three things make naive discovery wrong here, all of them hit for real while
 * writing this:
 *
 *  1. **The path the node runs is not the path that looks canonical.** The
 *     running mainnet node is
 *     `.swap-sidecar-work/dev-home/runtime/python.exe -m basicswap.bin.run`,
 *     because `PWNDA_SWAP_SIDECAR_HOME` redirects the sidecar home in dev.
 *  2. **`dev-home/runtime` is a Windows JUNCTION** back to
 *     `.swap-sidecar-work/runtime`, so it is the same files — but
 *     `readdirSync(..., {withFileTypes:true})` reports it as a symlink, not a
 *     directory, and a plain `isDirectory()` walk silently never enters it.
 *     Both facts matter: miss the junction and you conclude the live runtime is
 *     unpatched; follow it without dedup and you patch the same file twice,
 *     which for a context-matched patch means the second pass fails and reports
 *     drift that is not there.
 *  3. **A venv is not a runtime.** `venv-wheelhouse/` also carries a
 *     `basicswap` package, but it is pip build staging (`Scripts/python.exe`,
 *     no interpreter at its root). Patching it would put patched sources into
 *     a tree whose whole job is to produce clean wheels.
 *
 * So: an embedded runtime is a directory with BOTH `python.exe` at its root and
 * `Lib/site-packages/basicswap/basicswap.py`, and results are keyed by
 * `realpathSync` so a junction and its target count once.
 */
/**
 * The `site-packages` directory of an embedded runtime rooted at `dir`, or null.
 *
 * # Why this is not just `Lib/site-packages` (2026-09-06)
 *
 * It was, and that is why the Linux release shipped Grove p19 while Windows
 * shipped p27. Both markers this used to require —
 *
 *     python.exe                              (root)
 *     Lib/site-packages/basicswap/basicswap.py
 *
 * — are CPython-on-WINDOWS shapes. A POSIX runtime has `bin/python3` and
 * `lib/python3.12/site-packages`. So `.swap-sidecar-work/linux-runtime` was
 * structurally invisible to this script: every run patched only the Windows
 * runtime, printed success, and left Linux eight patch levels behind. `--check`
 * inherited the same blindness, which is worse — the tool used to CONFIRM a
 * runtime's patch level could not see the runtime that was wrong.
 *
 * The identical Windows-only assumption existed in `verify-bundle-deep.mjs`
 * (`runtime/Lib/site-packages/pwnda-grove.json`) and was fixed the same day;
 * fixing it there is what made this drift visible at all.
 *
 * Windows is checked first and the POSIX glob cannot match a Windows runtime
 * (which has no `lib/pythonX.Y` level), so a case-insensitive filesystem does
 * not confuse the two.
 */
function sitePackagesFor(dir) {
  const win = join(dir, "Lib", "site-packages");
  if (
    existsSync(join(dir, "python.exe")) &&
    existsSync(join(win, "basicswap", "basicswap.py"))
  ) {
    return win;
  }
  // POSIX: bin/python3* at the root, lib/python<X.Y>/site-packages beneath.
  const bin = join(dir, "bin");
  let hasPython = false;
  try {
    hasPython = readdirSync(bin).some((f) => /^python3(\.\d+)?$/.test(f));
  } catch {
    hasPython = false;
  }
  if (!hasPython) return null;
  let libs;
  try {
    libs = readdirSync(join(dir, "lib")).filter((f) => /^python3(\.\d+)?$/.test(f));
  } catch {
    return null;
  }
  for (const l of libs.sort()) {
    const sp = join(dir, "lib", l, "site-packages");
    if (existsSync(join(sp, "basicswap", "basicswap.py"))) return sp;
  }
  return null;
}

function discoverRuntimes(dir, depth = 0, seen = new Map()) {
  if (depth > 3 || !existsSync(dir)) return seen;
  const sp = sitePackagesFor(dir);
  if (sp) {
    // Key AND report on the resolved path, so a junction and its target are one
    // entry and the name printed is the real one. Reporting the first-seen alias
    // instead is actively misleading here: several junctions point at the single
    // real runtime, and the alphabetically-first is `claude-regtest/runtime` —
    // so the mainnet runtime would be announced under a regtest sandbox's name.
    const key = realpathSync(sp);
    if (!seen.has(key)) seen.set(key, key);
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return seen; // unreadable dir is not a reason to abandon the whole walk
  }
  for (const e of entries) {
    // isDirectory() is false for a junction — check isSymbolicLink() too, or
    // the live runtime is invisible (trap 2 above).
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name === "Lib" || e.name === "lib" || e.name.startsWith("runtime-backup-")) continue;
    discoverRuntimes(join(dir, e.name), depth + 1, seen);
  }
  return seen;
}

/**
 * `--target <path>` used to take `<path>` completely literally, unlike auto-
 * discovery above, which always resolves to the `Lib/site-packages` folder
 * INSIDE a runtime root (see `discoverRuntimes`'s own doc comment). That
 * asymmetry is a real hazard, not a cosmetic one: `.swap-sidecar-work/runtime`
 * IS a runtime root (`python.exe` at its own top level, real patched files
 * under `Lib/site-packages/basicswap/`), so `--target .swap-sidecar-work/runtime`
 * reads as the single most natural, safety-conscious command a cautious
 * caller would type — and it silently checked a directory containing none of
 * the patch files at all, reporting "0 applied, 19 missing" and "could not
 * read basicswap __version__ — identity UNKNOWN". That is not a quiet miss;
 * for a tool whose entire purpose is catching "this runtime is not what it
 * claims to be", producing exactly that verdict from a wrong PATH rather than
 * a wrong RUNTIME is the most misleading failure mode this script could have.
 * It happened for real, twice, the same day (2026-09-03, Phase D units D-Z2
 * and this investigation) — both times against `.swap-sidecar-work/runtime`,
 * both times independently corrected only by noticing the marker files
 * plainly DID contain `PWNDA-PATCH-*` strings the tool insisted were absent.
 *
 * So: if the literal `--target` path does not itself look like a
 * site-packages root (no `basicswap/basicswap.py` directly under it) but
 * DOES look like a runtime root by the exact same test `discoverRuntimes`
 * uses (`python.exe` at its top level plus `Lib/site-packages/basicswap/basicswap.py`
 * beneath it), resolve to that subdirectory instead — the same resolution
 * auto-discovery already does silently, made explicit and logged here so a
 * caller who typed the runtime root is never told "not found" about a
 * runtime that is right there.
 */
function resolveTarget(raw) {
  const literal = resolve(raw);
  if (existsSync(join(literal, "basicswap", "basicswap.py"))) return literal;
  const asRoot = sitePackagesFor(literal);
  if (asRoot) {
    console.log(
      `[patches] --target ${literal} is a runtime root, not a site-packages ` +
        `dir — using ${asRoot}`,
    );
    return asRoot;
  }
  return literal;
}

/**
 * True when a patch touches NOTHING inside the shipped `basicswap/` package.
 *
 * # Why this exists (2026-09-04)
 *
 * Patch 0022 fixes the shared ADS *test* helpers
 * (`tests/basicswap/extended/test_dcr.py`). The basicswap wheel ships the
 * package and not its test suite, so that file is absent from every assembled
 * runtime — and the patch reported FAILED there, which blocked stamping and
 * would have made `EXPECTED_PATCH_LEVEL` unreachable by any runtime forever.
 *
 * The rule is deliberately a property of the PATCH, not of the target:
 * "every path this patch touches lies outside basicswap/". A runtime that has
 * genuinely drifted — missing, say, `basicswap/interface/bch/bch.py` — still
 * FAILS loudly, because that patch does touch the package. Keying the skip on
 * "the file isn't there" instead would have converted exactly the drift this
 * tool exists to catch into a silent pass, which is the failure shape this
 * project has already paid for twice.
 *
 * Exempt patches are still applied wherever their files DO exist (a scratch
 * source tree), and are excluded from the patch LEVEL in both places, so one
 * series has one level rather than a different number per target shape.
 */
function isPackageExempt(patchText) {
  // Collect paths from BOTH diff header sides, ignoring /dev/null.
  //
  // Neither side alone is sufficient, and each omission was found the hard way:
  //   * `diff --git` is absent from patches 0009-0012 entirely, so keying on it
  //     saw zero files and called four real engine patches exempt;
  //   * `--- a/` is `/dev/null` for a patch that CREATES files, so keying on it
  //     called 0013 and 0015 -- the whole ZEPH and ZANO coin modules -- exempt.
  // Both mistakes point the same way: an empty file list must never read as
  // "touches nothing in the package". `files.length > 0` is the guard for that.
  const files = [
    ...patchText.matchAll(/^--- a\/(\S+)/gm),
    ...patchText.matchAll(/^\+\+\+ b\/(\S+)/gm),
  ].map((m) => m[1]);
  return files.length > 0 && files.every((f) => !f.startsWith("basicswap/"));
}

const argv = process.argv.slice(2);

/**
 * Argument handling REFUSES on anything it does not recognise.
 *
 * # Why this is a hard refusal and not a warning (2026-09-04)
 *
 * The bare form of this script -- no `--target` -- discovers every runtime
 * under the work dir and applies to all of them, THE LIVE MAINNET NODE
 * INCLUDED. That is a legitimate operator action, but it used to be the
 * FALL-THROUGH for every argv shape that was not exactly `--target <path>`.
 * So `--dry-run`, `--taget` (typo), `--check-only`, or a `--target` whose
 * value was swallowed by shell quoting all silently became "apply for real,
 * everywhere".
 *
 * It fired six times in a single day across six different agents. Not one of
 * them intended a real apply; every one of them had typed something that
 * LOOKED like a safe flag. A footgun that six independent people find on the
 * same day is not a usage problem.
 *
 * So: an unknown flag exits 2. `--target` with no value exits 2. The
 * everything-runtime mode still exists, because the operator genuinely needs
 * it, but it now has to be asked for BY NAME (`--all-runtimes`) rather than
 * being what you get when you fumble a flag.
 */
const KNOWN_FLAGS = new Set(["--check", "--target", "--all-runtimes", "--help", "-h"]);

function usage(exitCode) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`
apply-engine-patches — apply the Grove patch series to a BasicSwap tree

  node scripts/apply-engine-patches.mjs --target <dir>     apply to ONE tree
  node scripts/apply-engine-patches.mjs --check --target <dir>
                                                          measure, change nothing
  node scripts/apply-engine-patches.mjs --all-runtimes     apply to EVERY runtime
                                                          found under ${WORK}
                                                          (includes the live node)

--target takes the tree containing basicswap/basicswap.py, or a runtime root
(python.exe + Lib/site-packages), which is resolved for you.

There is deliberately no default: a bare invocation used to mean --all-runtimes,
which made every typo a real apply against the live mainnet node.
`);
  process.exit(exitCode);
}

if (argv.includes("--help") || argv.includes("-h")) usage(0);

for (const a of argv) {
  if (a.startsWith("-") && !KNOWN_FLAGS.has(a)) {
    console.error(`[patches] REFUSING: unrecognised argument "${a}".`);
    console.error(
      `[patches] Refusing rather than falling back to "apply to every runtime", ` +
        `which is what this used to do and is how a typo reached the live node.`,
    );
    usage(2);
  }
}

const CHECK_ONLY = argv.includes("--check");
const tIdx = argv.indexOf("--target");
const ALL_RUNTIMES = argv.includes("--all-runtimes");

if (tIdx >= 0 && ALL_RUNTIMES) {
  console.error("[patches] REFUSING: --target and --all-runtimes are mutually exclusive.");
  usage(2);
}
if (tIdx >= 0) {
  const val = argv[tIdx + 1];
  if (!val || val.startsWith("-")) {
    console.error("[patches] REFUSING: --target needs a path.");
    console.error(
      "[patches] An empty --target used to fall through to every runtime; it now stops here.",
    );
    usage(2);
  }
}
if (tIdx < 0 && !ALL_RUNTIMES) {
  console.error("[patches] REFUSING: no target given.");
  console.error(
    "[patches] Pass --target <dir> for one tree, or --all-runtimes to mean it.",
  );
  usage(2);
}

const TARGETS =
  tIdx >= 0 ? [resolveTarget(argv[tIdx + 1])] : [...discoverRuntimes(WORK).values()];

/** Split on any line ending; the caller re-joins with "\n". */
const splitLines = (s) =>
  s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

/**
 * The marker a patch is responsible for, e.g. `0011-foo.patch` -> `PWNDA-PATCH-11`.
 *
 * Derived from the FILENAME, not from a header line: the header convention
 * drifted across the series (`Marker:` in 0009+, `Marker in patched source:` in
 * 0001, absent in 0003/0008), and reading it from the body is worse still —
 * several patches legitimately MENTION an earlier patch's marker in a comment
 * (0004 cites PWNDA-PATCH-3, 0008 cites -5, 0011 cites -10), so "first marker
 * in the diff" would let one patch's presence vouch for another's.
 *
 * Returns null if the patch does not actually insert its own marker, which
 * would make "is it applied?" unanswerable — better to skip loudly than to
 * report a guess.
 */
function markerOf(fileName, patchText) {
  const n = fileName.match(/^(\d+)-/);
  if (!n) return null;
  const marker = `PWNDA-PATCH-${parseInt(n[1], 10)}`;
  const inserts = splitLines(patchText).some(
    (l) => l.startsWith("+") && l.includes(marker),
  );
  return inserts ? marker : null;
}

/**
 * Parse a unified diff into `[{ file, hunks: [{ before, after }] }]`.
 *
 * The hunk header's line numbers are deliberately discarded. They describe the
 * PINNED tree; the tree being patched is offset from it by however many
 * patches already landed, so using them to locate anything is precisely the
 * mistake this file exists to prevent.
 */
function parsePatch(text) {
  const lines = splitLines(text);
  const files = [];
  let cur = null;
  let hunk = null;
  for (const ln of lines) {
    if (ln.startsWith("--- ")) {
      const raw = ln.slice(4).trim().split("\t")[0];
      // `--- /dev/null` is git's spelling of "this file did not exist before
      // this patch" — the patch CREATES it. That header carries no path of
      // its own; the real target lives on the "+++ " line that follows, so
      // resolution is deferred to that branch below (`file: null` until then).
      const isNewFile = raw === "/dev/null";
      cur = {
        file: isNewFile ? null : raw.replace(/^a\//, ""),
        hunks: [],
        isNewFile,
      };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (ln.startsWith("+++ ")) {
      // Ordinarily redundant with "--- a/..." above, so ignored — except for
      // a `/dev/null` header just above, which named no path at all. For a
      // new-file entry this is the ONLY line the target path appears on.
      if (cur && cur.isNewFile && cur.file === null) {
        cur.file = ln.slice(4).trim().split("\t")[0].replace(/^b\//, "");
      }
      continue;
    }
    if (ln.startsWith("@@")) {
      // The header's START positions are useless here (see above) but its
      // LINE COUNTS are position-independent truth, and they are the only
      // honest way to know where a hunk ENDS. Without them, any blank line
      // between the hunk and whatever follows — including the empty string
      // that split("\n") manufactures from the file's own trailing newline
      // when a patch carries no "-- " signature — was swallowed as a phantom
      // context line, and the hunk could then never match anything. That bug
      // sat unnoticed in patches 0001–0008 because on every real runtime
      // they were always "already present" by marker, so their APPLY path
      // had never once executed until the 2026-08-26 framework
      // cross-validation ran it against a fresh checkout of the pinned tag.
      const m = ln.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
      hunk = {
        before: [],
        after: [],
        oldLeft: m && m[1] !== undefined ? Number(m[1]) : 1,
        newLeft: m && m[2] !== undefined ? Number(m[2]) : 1,
      };
      if (cur) cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    // git's trailing "-- \n2.43.0" signature ends the last hunk (kept as a
    // backstop; the count accounting below normally ends it first).
    if (ln === "-- ") {
      hunk = null;
      continue;
    }
    const tag = ln[0];
    const body = ln.slice(1);
    if (tag === " " || ln === "") {
      // An empty line inside a still-open hunk is a blank context line whose
      // leading space an editor stripped; the count accounting guarantees we
      // are still inside the hunk when we treat it as one.
      hunk.before.push(tag === " " ? body : "");
      hunk.after.push(tag === " " ? body : "");
      hunk.oldLeft--;
      hunk.newLeft--;
    } else if (tag === "-") {
      hunk.before.push(body);
      hunk.oldLeft--;
    } else if (tag === "+") {
      hunk.after.push(body);
      hunk.newLeft--;
    }
    if (hunk.oldLeft <= 0 && hunk.newLeft <= 0) hunk = null;
  }
  for (const f of files) {
    if (f.isNewFile && f.file === null) {
      // A `--- /dev/null` header with no "+++ " line after it (or one this
      // parser didn't recognise) names no target at all. Refuse rather than
      // apply hunks to a path we never actually read.
      throw new Error(
        "new-file hunk (--- /dev/null) has no following +++ path — refusing to guess the target.",
      );
    }
  }
  return files.filter((f) => f.hunks.length > 0);
}

/** Every index at which the line-array `needle` occurs in the line-array `hay`. */
function findAll(hay, needle) {
  const hits = [];
  if (needle.length === 0) return hits;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** Apply one file's hunks. Throws on anything ambiguous — never guesses. */
function applyHunks(original, hunks, label) {
  let lines = splitLines(original);
  hunks.forEach((h, n) => {
    const hits = findAll(lines, h.before);
    if (hits.length === 0) {
      throw new Error(
        `${label}: hunk ${n + 1} context not found verbatim — refusing to guess. ` +
          "Either the runtime has drifted from the pinned tree, or this patch " +
          "is already partially applied.",
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `${label}: hunk ${n + 1} context matches ${hits.length} places — refusing. ` +
          "An ambiguous anchor is how a wallet edit lands in the wrong function.",
      );
    }
    lines = [
      ...lines.slice(0, hits[0]),
      ...h.after,
      ...lines.slice(hits[0] + h.before.length),
    ];
  });
  return lines.join("\n");
}

/** Apply/inspect the whole series against ONE runtime. Returns a tally. */
function runAgainst(target, patchFiles) {
  const rows = [];
  let applied = 0;
  let already = 0;
  let failed = 0;
  // Patches that touch nothing inside basicswap/ and whose files are absent
  // here. Counted separately so they never inflate OR deflate the patch level:
  // one series must report one level whatever the target's shape.
  let exemptCount = 0;
  // Markers belonging to patches that are not engine patches. Collected whether
  // or not the patch applied HERE: a source tree has tests/ and applies 0022, a
  // runtime does not, and if that difference reached the level then one series
  // would report two identities depending on which shape you measured.
  const exemptMarkers = new Set();

  for (const pf of patchFiles) {
    const text = readFileSync(join(PATCH_DIR, pf), "utf8");
    const marker = markerOf(pf, text);
    if (!marker) {
      rows.push([pf, "SKIP", "inserts no marker of its own"]);
      continue;
    }

    // A patch that touches nothing inside basicswap/ cannot apply to an
    // assembled runtime (the wheel ships the package, not tests/). Report that
    // as EXEMPT rather than FAILED, but ONLY when the files really are absent
    // — if they are present (a scratch source tree) it applies normally, so
    // this never becomes a way to skip work that could have been done.
    const exempt = isPackageExempt(text);
    if (exempt) exemptMarkers.add(marker);

    let files;
    try {
      files = parsePatch(text);
    } catch (e) {
      // A malformed patch (e.g. a `--- /dev/null` header with no "+++ "
      // target after it) is refused here rather than thrown all the way out
      // — one bad patch file fails its own row; it does not abort the rows
      // already decided for every other patch in the series.
      failed++;
      rows.push([pf, "FAILED", e.message]);
      continue;
    }
    if (exempt && files.every((f) => !existsSync(join(target, f.file)))) {
      exemptCount++;
      rows.push([
        pf,
        "EXEMPT",
        "touches no basicswap/ file; absent from this target (a runtime ships " +
          "the package, not tests/)",
      ]);
      continue;
    }

    // "Already applied" is decided by the marker being present in the files THIS
    // patch touches — not by a tree-wide grep, which would let one patch's
    // marker vouch for another's.
    const present =
      files.length > 0 &&
      files.every((f) => {
        const p = join(target, f.file);
        return existsSync(p) && readFileSync(p, "utf8").includes(marker);
      });
    if (present) {
      already++;
      rows.push([pf, "already", marker]);
      continue;
    }

    if (CHECK_ONLY) {
      failed++;
      rows.push([pf, "MISSING", marker]);
      continue;
    }

    try {
      const staged = files.map((f) => {
        const p = join(target, f.file);
        const exists = existsSync(p);
        if (!exists && !f.isNewFile) {
          throw new Error(`${f.file}: not present in target`);
        }
        if (!exists && f.isNewFile) {
          // The one case this file is CREATED rather than edited. Still
          // refuse rather than guess: every hunk in this entry must be a
          // pure addition (no context, no removed lines) — anything else
          // is a patch asserting "this file doesn't exist" and "here is
          // context from its existing content" in the same breath.
          const badHunk = f.hunks.findIndex((h) => h.before.length > 0);
          if (badHunk !== -1) {
            throw new Error(
              `${f.file}: new-file patch but hunk ${badHunk + 1} carries context ` +
                "or removed lines against a file that does not exist — refusing to guess.",
            );
          }
          return { path: p, text: f.hunks.flatMap((h) => h.after).join("\n") };
        }
        return {
          path: p,
          text: applyHunks(readFileSync(p, "utf8"), f.hunks, f.file),
        };
      });
      // Write only after EVERY file in the patch applied cleanly — a
      // half-applied patch is worse than an unapplied one. mkdirSync covers
      // a new file's not-yet-existing parent directory; for every existing
      // file (patches 1-12, and any modified file in a later patch) the
      // directory is already there, so this is a no-op and does not change
      // their behaviour.
      for (const s of staged) {
        mkdirSync(dirname(s.path), { recursive: true });
        writeFileSync(s.path, s.text, "utf8");
      }
      for (const s of staged) {
        if (!readFileSync(s.path, "utf8").includes(marker)) {
          throw new Error(`${s.path}: written but ${marker} absent`);
        }
      }
      applied++;
      rows.push([pf, "APPLIED", marker]);
    } catch (e) {
      failed++;
      rows.push([pf, "FAILED", e.message]);
    }
  }
  // The markers actually PRESENT in the tree after this run. This is the
  // evidence behind the Grove stamp: measured, never inherited from a
  // previous run or from the patch directory's contents.
  const present = rows
    .filter(([, status]) => status === "already" || status === "APPLIED")
    .map(([, , note]) => note)
    // Engine patches only — see exemptMarkers above.
    .filter((m) => !exemptMarkers.has(m));
  return { rows, applied, already, failed, exemptCount, present };
}

// ── run ──────────────────────────────────────────────────────────────────────
/** Every file under `upstream/patches/assets/`, as `<rel>` paths relative to
 *  the target's site-packages (so `basicswap/static/images/coins/Zephyr.png`). */
function listAssets(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listAssets(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * Copy (or, under --check, only compare) the binary assets into `target`.
 * Returns `[rel, status]` rows: "present" (byte-identical), "COPIED",
 * "MISSING" (--check only), or "FAILED: <why>".
 */
function syncAssets(target) {
  const rows = [];
  for (const rel of listAssets(ASSET_DIR)) {
    const src = join(ASSET_DIR, rel);
    const dst = join(target, rel);
    try {
      const same = existsSync(dst) && Buffer.compare(readFileSync(src), readFileSync(dst)) === 0;
      if (same) {
        rows.push([rel, "present"]);
      } else if (CHECK_ONLY) {
        rows.push([rel, "MISSING"]);
      } else {
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, readFileSync(src));
        rows.push([rel, "COPIED"]);
      }
    } catch (e) {
      rows.push([rel, `FAILED: ${e.message}`]);
    }
  }
  return rows;
}

if (TARGETS.length === 0) {
  console.error("[patches] no BasicSwap runtime found under .swap-sidecar-work/");
  console.error("[patches] pass --target <dir containing basicswap/>");
  process.exit(2);
}

const patchFiles = readdirSync(PATCH_DIR)
  .filter((f) => f.endsWith(".patch"))
  .sort();

let totalApplied = 0;
let totalFailed = 0;
let totalStampDrift = 0;

for (const target of TARGETS) {
  const { rows, applied, already, failed, exemptCount, present } = runAgainst(target, patchFiles);
  totalApplied += applied;
  totalFailed += failed;
  console.log(`\n[patches] ── ${target}`);
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [f, status, note] of rows) {
    console.log(`[patches] ${f.padEnd(w)}  ${status.padEnd(8)}  ${note}`);
  }
  // Binary assets a text patch cannot carry (2026-09-04: the Zephyr coin icons
  // PATCH-26's offers page references). Copied byte-for-byte from
  // upstream/patches/assets/<rel> to <target>/<rel>; never part of the patch
  // level, never a marker — a missing icon is a broken <img>, not a wrong
  // engine. In --check mode they are reported, not written.
  for (const [rel, status] of syncAssets(target)) {
    console.log(`[assets]  ${rel.padEnd(w)}  ${status}`);
    if (status === "MISSING" && CHECK_ONLY) totalFailed++;
  }
  console.log(
    `[patches] ${applied} applied, ${already} already present, ` +
      `${failed} ${CHECK_ONLY ? "missing" : "failed"}` +
      (exemptCount ? `, ${exemptCount} exempt (not engine patches)` : ""),
  );

  // ── Pwnda Grove identity ───────────────────────────────────────────────────
  // The stamp is a CLAIM; `present.length` is the MEASUREMENT. Writing the stamp
  // only on a real apply, and re-measuring it on --check, is what makes the
  // 2026-08-25 PATCH-9 fault (a runtime that everyone believed was patched)
  // detectable instead of latent.
  const upstreamVersion = readUpstreamVersion(target);
  if (!upstreamVersion) {
    console.log(`[grove]   could not read basicswap __version__ — identity UNKNOWN`);
  } else {
    const measured = groveId(upstreamVersion, present.length);
    const stamp = readStamp(target);
    if (CHECK_ONLY) {
      if (!stamp) {
        console.log(`[grove]   ${measured}  (unstamped — apply once to record it)`);
      } else if (stamp.id !== measured) {
        totalStampDrift++;
        console.log(`[grove]   GROVE-STAMP-DRIFT`);
        console.log(`[grove]     stamped  ${stamp.id}`);
        console.log(`[grove]     measured ${measured}`);
        console.log(
          `[grove]     the stamp is what this runtime was TOLD it is; the markers are ` +
            `what it IS. Trust the measurement.`,
        );
      } else {
        console.log(`[grove]   ${measured}  (stamp agrees)`);
      }
    } else if (failed === 0) {
      writeStamp(target, {
        upstreamVersion,
        patchLevel: present.length,
        markers: present,
      });
      console.log(`[grove]   ${measured}  -> ${STAMP_FILE}`);
    } else {
      console.log(`[grove]   not stamped — ${failed} patch(es) failed; identity would be a lie`);
    }
  }
}

console.log(`\n[patches] ${TARGETS.length} runtime(s) inspected.`);
if (totalFailed > 0) {
  console.log(
    CHECK_ONLY
      ? "[patches] run without --check to apply, then RESTART the swap node."
      : "[patches] a failure above means the runtime drifted — re-fetch it rather than forcing.",
  );
  process.exit(1);
}
if (totalStampDrift > 0) {
  console.log(
    "[grove] a stamp disagreed with the markers present. That is the 2026-08-25 " +
      "PATCH-9 shape: the runtime is not what it says it is.",
  );
  process.exit(1);
}
if (totalApplied > 0) {
  console.log("[patches] RESTART the swap node for these to take effect.");
}

