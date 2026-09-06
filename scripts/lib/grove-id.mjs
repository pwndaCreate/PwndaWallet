/**
 * Pwnda Grove — the identity of our BasicSwap distribution.
 *
 * WHY THIS EXISTS, and it is not cosmetics.
 *
 * On 2026-08-25 PWNDA-PATCH-9 — written, reviewed, committed and documented
 * three days earlier — was found ABSENT from the running mainnet node, so the
 * fund-stranding bug it fixes had never actually stopped happening. The repo
 * said one thing and the process was another, which is the same shape as D171
 * (source vs shipped bundle) and C59 (committed vs deployed desk). The general
 * form is: *something true of the repo was assumed true of the running thing.*
 *
 * An identity that encodes BOTH the upstream tag AND the patch level turns
 * "is this runtime actually patched" from a filesystem scan into a string
 * comparison — and, more importantly, makes the claim FALSIFIABLE: the stamp
 * records what a runtime was told it is, and the marker count measures what it
 * IS. A stamp that disagrees with the markers is exactly the PATCH-9 fault,
 * and it now has a name and a check.
 *
 * NAMING NOTE. We do not use `bsx`. That is UPSTREAM's own abbreviation
 * (`basicswap/bsx_network.py`), so it cannot distinguish our tree from theirs —
 * which is the one job this identifier has. "Grove" also keeps us clear of
 * `pwnda-desk`, whose vendored ltc-xmr/ada-xmr engines are separately
 * BasicSwap-derived and are NOT this thing.
 *
 * "Distribution", not "fork": the ENGINE layer is never modified (see
 * [[basicswap-engine-boundary-map]]). This is a pinned upstream tag plus a
 * tracked, re-appliable patch series — the Ubuntu-to-Linux relationship, not a
 * divergent tree.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DISTRO_NAME = "Pwnda Grove";
export const DISTRO_SLUG = "pwnda-grove";

/** The stamp a runtime carries, at the runtime root (beside `basicswap/`). */
export const STAMP_FILE = "pwnda-grove.json";

/**
 * `pwnda-grove 0.18.4+p12` — upstream tag, then patch level.
 *
 * `+p<N>` is semver build metadata on purpose: it does not affect precedence,
 * so the upstream version still sorts as upstream's, and the patch level rides
 * along where a human and a `grep` can both see it.
 */
export function groveId(upstreamVersion, patchLevel) {
  return `${DISTRO_SLUG} ${upstreamVersion}+p${patchLevel}`;
}

export function parseGroveId(s) {
  const m = String(s ?? "").match(/^(\S+)\s+(\d+\.\d+\.\d+)\+p(\d+)$/);
  return m ? { slug: m[1], upstreamVersion: m[2], patchLevel: Number(m[3]) } : null;
}

/** basicswap's own `__version__`, read from the runtime rather than assumed. */
export function readUpstreamVersion(runtimeDir) {
  const p = join(runtimeDir, "basicswap", "__init__.py");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/__version__\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

/**
 * Where a stamp may live, given a directory that is EITHER the runtime root
 * (the one holding `python.exe`) or the package dir (the one holding
 * `basicswap/`).
 *
 * These are not the same directory, and the two callers hold different ones:
 * `apply-engine-patches.mjs` targets the package dir, because that is where the
 * patched files are; `check-basicswap-upstream.mjs` discovers the runtime root,
 * because that is what `python.exe` identifies. The first wiring of this module
 * stamped one and read the other, so a freshly stamped runtime reported
 * "carries no stamp" -- two components with different ideas of the same noun,
 * which is the shape this whole identifier exists to catch. Resolve both rather
 * than make every caller remember which it holds.
 */
function stampCandidates(dir) {
  const out = [join(dir, STAMP_FILE), join(dir, "Lib", "site-packages", STAMP_FILE)];
  // Linux: `lib/python3.12/site-packages`, lowercase and VERSION-QUALIFIED. The
  // version is why this is a scan and not a third hardcoded string -- pinning
  // "python3.12" here would silently stop finding the stamp the day CPython
  // moves, which is the same failure this function already exists to prevent,
  // one CPython release later.
  //
  // Third instance of one shape: two components with different ideas of what
  // "the runtime directory" means. The applier stamps the dir holding
  // `basicswap/`; the checker discovers the dir holding `python.exe`; and those
  // are three different paths across two platforms. Resolve them all here rather
  // than making every caller remember which it is holding.
  const lib = join(dir, "lib");
  try {
    for (const e of readdirSync(lib, { withFileTypes: true })) {
      if (e.isDirectory() && /^python\d+\.\d+$/.test(e.name)) {
        out.push(join(lib, e.name, "site-packages", STAMP_FILE));
      }
    }
  } catch {
    // no lib/ -- a Windows runtime, or not a runtime at all.
  }
  return out;
}

export function readStamp(runtimeDir) {
  for (const p of stampCandidates(runtimeDir)) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Stamp a runtime with what it now is. Only ever called after a real apply --
 * never on `--check`, because a read-only check that writes is a check that can
 * launder a failure into a pass.
 */
export function writeStamp(runtimeDir, { upstreamVersion, patchLevel, markers }) {
  const stamp = {
    schema: "pwnda.grove.runtime-identity/1",
    name: DISTRO_NAME,
    id: groveId(upstreamVersion, patchLevel),
    upstream: { project: "basicswap", version: upstreamVersion },
    patchLevel,
    markers,
    stampedBy: "scripts/apply-engine-patches.mjs",
    _what:
      "What this runtime was told it is. It is a CLAIM, not evidence: the " +
      "evidence is the PWNDA-PATCH-<n> markers present in the files each patch " +
      "touches. `apply-engine-patches.mjs --check` re-measures and fails on " +
      "disagreement -- a stamp saying p12 over a tree carrying 11 markers is " +
      "the 2026-08-25 PATCH-9 fault, and is reported as GROVE-STAMP-DRIFT.",
  };
  writeFileSync(join(runtimeDir, STAMP_FILE), JSON.stringify(stamp, null, 2) + "\n", "utf8");
  return stamp;
}
