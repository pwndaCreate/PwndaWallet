#!/usr/bin/env node
/**
 * Is our BasicSwap pin behind upstream, and what would moving it break?
 *
 * The routine entry point of the upstream-sync framework
 * (PwndaWalletVault/wiki/synthesis/basicswap-upstream-sync.md). Read-only with
 * respect to this repository: it writes nothing except a throwaway
 * materialization of the candidate tag under the OS temp dir, and its only
 * network operation is `git fetch --tags` on the pinned clone (skippable with
 * --offline). It never moves the pin — that is a deliberate, human-reviewed
 * step; this script's job is to make the decision cheap and the blast radius
 * visible.
 *
 * # Why this exists
 *
 * The sync procedure existed in prose (upstream/README.md § Moving the pin,
 * upstream/patches/README.md § When the pin moves, CLIENT-PLAN § sync runbook)
 * for months and was executed zero times: on 2026-08-26 the first run of these
 * checks found the pin FIVE releases behind (v0.17.9 vs v0.18.4), a raised
 * adaptor-sig protocol floor (MINPROTO_VERSION_ADAPTOR_SIG 4 -> 5 — the
 * network drifts away from a stale node even when nothing local breaks), a
 * moved coincurve fork pin, and one patch of twelve no longer applying. None
 * of that was visible from inside the repo. A procedure nobody can run in one
 * command is a procedure that does not run.
 *
 * # What it deliberately does not do
 *
 *  - Move the pin, edit patches, or rebuild the runtime. Output ends with the
 *    runbook pointer for those steps.
 *  - Judge whether a still-applying patch is still CORRECT. "Applies cleanly"
 *    and "behaviour preserved" are different claims; the second belongs to the
 *    invariant suites (scripts/swap/verify-*.py) run against a rebuilt
 *    runtime, and the report says so wherever it matters.
 *  - Keep its own copy of the pin. Pins are parsed out of
 *    scripts/fetch-swap-runtime.mjs, the machine-readable authority — a second
 *    copy here would be one more mirror waiting to drift (the enginePatches
 *    manifest key sat at "2 patches" while the series grew to 12).
 *  - Keep a hand-listed "endpoints the wrapper uses". That set is DERIVED at
 *    run time by scanning the wrapper sources for the endpoint-key universe
 *    extracted from js_server.py, so a new wrapper call site is picked up
 *    automatically. (Derivation over mirrors, same as
 *    utxoAccountCoverage.test.ts.)
 *
 * Usage:
 *   node scripts/check-basicswap-upstream.mjs               # full check
 *   node scripts/check-basicswap-upstream.mjs --offline     # no fetch
 *   node scripts/check-basicswap-upstream.mjs --against vX  # explicit target
 *   node scripts/check-basicswap-upstream.mjs --report      # + markdown report
 *   node scripts/check-basicswap-upstream.mjs --report P    # ...at path P
 *
 * # The report
 *
 * The console verdict answers "is anything wrong". The report answers the
 * question that actually schedules work: "WHERE does each repair go". Every
 * finding is tagged with the layer that owns it -- ENGINE (a patch in
 * upstream/patches/), WRAPPER (pwnda's own Rust/TS), or RUNTIME (pins and the
 * built image) -- and carries a concrete next action. It also lists what
 * upstream changed in the gap, filtered to fix/feat subjects, because a wall
 * of "build: raise version" commits teaches nobody anything.
 *
 * Exit codes: 0 = in sync (or update available with nothing actionable, which
 * does not happen in practice — a new tag always at least moves the pin table),
 * 1 = update available / action needed (report says what), 2 = pin integrity
 * failure (treat as a supply-chain event, not drift — see upstream/README.md).
 */

import { readFile, readdir, mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readStamp, parseGroveId } from "./lib/grove-id.mjs";
const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLONE = path.join(REPO_ROOT, "upstream", "basicswap");
const COINCURVE_CLONE = path.join(REPO_ROOT, "upstream", "coincurve");
const PATCH_DIR = path.join(REPO_ROOT, "upstream", "patches");
const LOG = "[bsx-sync]";

const OFFLINE = process.argv.includes("--offline");
const AGAINST = (() => {
  const i = process.argv.indexOf("--against");
  return i >= 0 ? process.argv[i + 1] : null;
})();

// --report [path] writes the findings as a markdown SYNC REPORT: what upstream
// changed, and -- the part the console verdict cannot express -- which layer
// owns each repair. Default path keeps reports beside the other swap logs so a
// sync leaves an artifact rather than only scrollback.
const REPORT = (() => {
  const i = process.argv.indexOf("--report");
  if (i < 0) return null;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "AUTO";
})();

// Wrapper sources scanned for endpoint usage. If a new file starts calling the
// engine, add it here — the "unlisted caller" failure mode is a file that talks
// to the engine and is invisible to this probe, so the list errs broad.
const WRAPPER_SOURCES = [
  "src-tauri/src/swap_sidecar.rs",
  "src-tauri/src/swap_bid.rs",
  "src-tauri/src/swap_bridge.rs",
  "src-tauri/src/swap_daemon.rs",
  "src/api/basicswap.ts",
];
const WRAPPER_SOURCE_DIRS = ["src/features/swap-sidecar"];

let breaks = 0;
let warns = 0;

// Every finding is recorded with the LAYER THAT OWNS ITS FIX, because "what
// broke" and "where the repair goes" are different questions and only the
// second one tells you what to do next. The four owners map to the four places
// a BasicSwap change can land on us:
//
//   engine   a patch in upstream/patches/ must be rebased, dropped, or written
//   wrapper  pwnda's own code (Rust supervisor / TS client / mirrored constants)
//   runtime  the pinned artifacts + the built image (wheels, deps, CPython)
//   none     informational; nothing to do
const OWNERS = {
  engine: "ENGINE  (upstream/patches/*)",
  wrapper: "WRAPPER (pwnda src-tauri + src)",
  runtime: "RUNTIME (pins + built image)",
  none: "—",
};
const findings = [];
const record = (sev, owner, text, action) => {
  findings.push({ sev, owner: owner || "none", text, action: action || "" });
};

const say = (s) => console.log(`${LOG} ${s}`);
const ok = (s, owner) => {
  record("OK", owner, s);
  say(`OK     ${s}`);
};
const info = (s, owner) => {
  record("INFO", owner, s);
  say(`INFO   ${s}`);
};
const warn = (s, owner, action) => {
  warns++;
  record("WARN", owner, s, action);
  say(`WARN   ${s}`);
};
const broke = (s, owner, action) => {
  breaks++;
  record("BREAK", owner, s, action);
  say(`BREAK  ${s}`);
};
// A probe that cannot run must say so, never pass by doing nothing.
const skip = (s) => {
  warns++;
  record("SKIP", "none", s);
  say(`SKIP   ${s} — this probe answered NOTHING; do not read its silence as a pass`);
};

async function git(args, cwd = CLONE) {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
async function showAt(tag, file) {
  return git(["show", `${tag}:${file}`]);
}

// ---------------------------------------------------------------------------
// 0. Pins — parsed from fetch-swap-runtime.mjs, the single machine authority.
// ---------------------------------------------------------------------------
async function readPins() {
  const src = await readFile(path.join(__dirname, "fetch-swap-runtime.mjs"), "utf8");
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name} = "([^"]+)"`));
    if (!m) throw new Error(`cannot parse ${name} out of fetch-swap-runtime.mjs — the pin authority moved; fix this parser, do not inline a pin here`);
    return m[1];
  };
  return {
    tag: grab("PIN_BASICSWAP_TAG"),
    commit: grab("PIN_BASICSWAP_COMMIT"),
    coincurveTag: grab("PIN_COINCURVE_TAG"),
    coincurveCommit: grab("PIN_COINCURVE_COMMIT"),
  };
}

// ---------------------------------------------------------------------------
// Installed runtimes vs the pin. Runs on EVERY path, including "in sync".
// ---------------------------------------------------------------------------
async function checkInstalledRuntimes(pins) {
//  The probe that stops the pin move from going quiet. Every check above
//  compares the REPO to upstream; none of them looks at the engine that is
//  actually installed. So the moment the pin moves, "in sync" becomes true
//  of the repo and says nothing about the running node -- which is the exact
//  shape of the 2026-08-25 PWNDA-PATCH-9 incident (fix written, committed,
//  documented, and absent from the runtime, with nothing checking). Read the
//  engine's own __version__ out of each discovered runtime and compare.
const runtimeRows = [];
const workDir = path.join(REPO_ROOT, ".swap-sidecar-work");
const walkForRuntimes = async (dir, depth) => {
  if (depth > 3) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // Junctions report as symlinks, not directories -- miss that and the
    // dev-home/runtime junction (the actually-running node) is invisible.
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name === "Lib" || e.name.startsWith("runtime-backup-")) continue;
    const full = path.join(dir, e.name);
    const initPy = path.join(full, "Lib", "site-packages", "basicswap", "__init__.py");
    // BOTH halves of the rule, same as apply-engine-patches.mjs::discoverRuntimes:
    // an embedded runtime has python.exe at its ROOT; a venv keeps it in Scripts/.
    // Checking only for the basicswap package reported venv-wheelhouse (a pip build
    // venv that happens to have basicswap installed) as a stale runtime -- a false
    // BREAK, which is worse than useless: it trains the reader to skim past the line
    // that will one day name the real node.
    const rootPy =
      existsSync(path.join(full, "python.exe")) || existsSync(path.join(full, "python"));
    if (existsSync(initPy) && rootPy) {
      let real = full;
      try {
        real = await realpath(full);
      } catch {}
      if (!runtimeRows.some((r) => r.real === real)) {
        const src = await readFile(initPy, "utf8");
        const m = src.match(/__version__\s*=\s*["']([^"']+)["']/);
        runtimeRows.push({ real, version: m ? m[1] : null });
      }
      continue;
    }
    if (existsSync(initPy)) continue; // a venv, not a runtime; nothing below it
    await walkForRuntimes(full, depth + 1);
  }
};
await walkForRuntimes(workDir, 0);
// [GROVE FIX 2026-09-12] Derive the pinned VERSION from the pinned SOURCE, not
// from the tag string. Upstream does not always bump `basicswap/__init__.py`
// when it tags: v0.18.7 and v0.18.6 BOTH declare `__version__ = "0.18.6"`, and
// nothing in the gap touched that file. A runtime reports what the package
// declares, so comparing it against a tag-derived "0.18.7" made the DEPLOYED
// check permanently unsatisfiable -- it would have demanded a rebuild, been
// given one, and still gone red. Falling back to the tag keeps the old
// behaviour when the file cannot be read.
const pinnedVersion = (() => {
  try {
    const initSrc = readFileSync(
      path.join(CLONE, "basicswap", "__init__.py"),
      "utf8",
    );
    const m = initSrc.match(/^__version__\s*=\s*["']([^"']+)["']/m);
    if (m) return m[1];
    console.warn(
      `${LOG} WARN   could not read __version__ from the pinned source; ` +
        `falling back to the tag string.`,
    );
  } catch (e) {
    // NOT a bare catch. The first attempt at this used `catch {}` and silently
    // swallowed a ReferenceError from a missing readFileSync import, so the
    // fallback fired and the fix looked like it had simply not worked.
    console.warn(`${LOG} WARN   __version__ probe failed (${e.message}); using the tag.`);
  }
  return pins.tag.replace(/^v/, "");
})();
// The canonical install path, realpath'd so the dev-home junction collapses
// onto it rather than counting as a second, separate runtime.
let liveRuntimeReal = path.join(workDir, "runtime");
try {
  liveRuntimeReal = await realpath(liveRuntimeReal);
} catch {}
if (runtimeRows.length === 0) {
  skip(`no installed runtime found under .swap-sidecar-work — runtime freshness NOT checked`);
} else {
  for (const r of runtimeRows) {
    const rel = path.relative(REPO_ROOT, r.real) || r.real;
    // Pwnda Grove identity. The stamp is a claim; apply-engine-patches.mjs
    // --check is what MEASURES it. Reported here so a sync report names the
    // distribution rather than a bare upstream number -- "0.18.4" alone does
    // not distinguish a fully patched runtime from an unpatched one, and that
    // distinction is what the 2026-08-25 PATCH-9 incident turned on.
    const stamp = readStamp(r.real);
    if (stamp && parseGroveId(stamp.id)) {
      ok(`runtime ${rel} identifies as ${stamp.id}`);
    } else {
      warn(
        `runtime ${rel} carries no Pwnda Grove stamp — run ` +
          `\`node scripts/apply-engine-patches.mjs\` to record one. Upstream version ` +
          `alone cannot tell a patched runtime from an unpatched one.`,
      );
    }
    // DEPLOYED vs STAGED. Only a deployed runtime being behind the pin is a
    // BREAK -- that is the PATCH-9 fault, an engine actually serving swaps
    // while the repo says otherwise. A staging or superseded build sitting in
    // the work dir is not serving anything, and reporting it as BREAK produces
    // a permanent red line that nothing can clear except deleting a directory.
    // A check that stays red for a benign reason trains the reader to skim
    // past it, which is precisely how the line that DOES matter gets missed.
    //
    // "Deployed" is resolved by PATH IDENTITY, not by naming convention: the
    // canonical install is <work>/runtime, and dev-home/runtime is a junction
    // onto it, so realpath collapses both to the same target. A future
    // second install location needs adding here rather than a `bump-*` prefix
    // rule, which would silently mis-classify anything named differently.
    const deployed = r.real === liveRuntimeReal;
    const role = deployed ? "deployed" : "staged/superseded";
    if (r.version === null) warn(`runtime ${rel}: could not read basicswap __version__`);
    else if (r.version === pinnedVersion)
      ok(`runtime ${rel} (${role}) is at the pin (${r.version})`);
    else if (deployed)
      broke(
        `DEPLOYED runtime ${rel} runs basicswap ${r.version} but the pin is ${pinnedVersion} — ` +
          `the repo moved and the engine that actually serves swaps did not. Swap it with ` +
          `scripts/swap/Swap-EngineRuntime.ps1, then re-run apply-engine-patches.`,
        "runtime",
        "Stop the node, run Swap-EngineRuntime.ps1 against a runtime built at the pin, restart.",
      );
    else
      info(
        `runtime ${rel} (${role}) is at ${r.version}, behind the pin ${pinnedVersion} — ` +
          `not serving anything, so not a fault. Delete it once it is no longer a rollback target.`,
      );
  }
}
}


// ---------------------------------------------------------------------------
// The sync report. Findings are already owner-tagged; this groups them so the
// reader sees three separate work-lists instead of one undifferentiated log.
// ---------------------------------------------------------------------------
async function writeReport(pins, latest, delta) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest =
    REPORT === "AUTO"
      ? path.join(REPO_ROOT, "logs", "swap", `bsx-sync-report-${stamp}.md`)
      : path.resolve(REPORT);
  await mkdir(path.dirname(dest), { recursive: true });

  const bySev = (s) => findings.filter((f) => f.sev === s);
  const actionable = findings.filter((f) => f.sev === "BREAK" || f.sev === "WARN");
  const forOwner = (o) => actionable.filter((f) => f.owner === o);

  const L = [];
  L.push(`# BasicSwap sync report`);
  L.push(``);
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| generated | ${stamp.replace("T", " ")} |`);
  L.push(`| pwnda pin | \`${pins.tag}\` (\`${pins.commit.slice(0, 12)}\`), coincurve \`${pins.coincurveTag}\` |`);
  L.push(`| upstream newest | \`${latest}\` |`);
  L.push(`| verdict | **${breaks} BREAK, ${warns} WARN** |`);
  L.push(``);

  if (latest === pins.tag && breaks === 0 && warns === 0) {
    L.push(`**In sync.** The repo is on upstream's newest tag and every installed`);
    L.push(`runtime matches the pin. No engine, wrapper, or runtime work outstanding.`);
    L.push(``);
  }

  if (delta && delta.releases && delta.releases.length) {
    L.push(`## What changed upstream`);
    L.push(``);
    L.push(`${delta.commits} commits across ${delta.releases.length} release(s): ${delta.releases.join(", ")}.`);
    L.push(``);
    if (delta.notable.length) {
      L.push(`Notable (fix/security-shaped commits in the gap):`);
      L.push(``);
      for (const c of delta.notable) L.push(`- ${c}`);
      L.push(``);
    }
  }

  L.push(`## What needs doing, by owner`);
  L.push(``);
  if (actionable.length === 0) {
    L.push(`Nothing. No BREAK or WARN findings.`);
    L.push(``);
  } else {
    for (const key of ["engine", "wrapper", "runtime", "none"]) {
      const rows = forOwner(key);
      if (!rows.length) continue;
      L.push(`### ${OWNERS[key]}`);
      L.push(``);
      for (const f of rows) {
        L.push(`- **[${f.sev}]** ${f.text.replace(/\n/g, " ")}`);
        if (f.action) L.push(`  - *Action:* ${f.action}`);
      }
      L.push(``);
    }
  }

  L.push(`## Every probe`);
  L.push(``);
  L.push(`| severity | owner | finding |`);
  L.push(`|---|---|---|`);
  for (const f of findings) {
    const t = f.text.replace(/\n/g, " ").replace(/\|/g, "\\|").slice(0, 240);
    L.push(`| ${f.sev} | ${f.owner} | ${t} |`);
  }
  L.push(``);
  L.push(`---`);
  L.push(``);
  L.push(`Procedure: \`PwndaWalletVault/wiki/synthesis/basicswap-upstream-sync.md\`.`);
  L.push(`A clean patch apply proves REBASABILITY, not behaviour — the invariant`);
  L.push(`suites (\`scripts/swap/verify-*.py\`) are the authority on that, and only`);
  L.push(`against a rebuilt runtime.`);

  await writeFile(dest, L.join("\n"), "utf8");
  say(``);
  say(`report written: ${path.relative(REPO_ROOT, dest)}`);
}

async function main() {
  const pins = await readPins();
  say(`pin: basicswap ${pins.tag} (${pins.commit.slice(0, 12)}…), coincurve ${pins.coincurveTag}`);

  // -- 1. Pin integrity. A moved tag is a supply-chain event, full stop. ------
  if (!existsSync(path.join(CLONE, ".git"))) {
    say(`FATAL  upstream/basicswap clone missing — re-fetch per upstream/README.md § Re-fetch, then rerun`);
    process.exit(2);
  }
  const head = (await git(["rev-parse", "HEAD"])).trim();
  if (head !== pins.commit) {
    say(`FATAL  upstream/basicswap HEAD ${head} != pinned ${pins.commit}.`);
    say(`FATAL  If you did not deliberately move it: STOP — treat as a supply-chain event (upstream/README.md).`);
    process.exit(2);
  }
  if (existsSync(path.join(COINCURVE_CLONE, ".git"))) {
    const ccHead = (await git(["rev-parse", "HEAD"], COINCURVE_CLONE)).trim();
    if (ccHead !== pins.coincurveCommit) {
      say(`FATAL  upstream/coincurve HEAD ${ccHead} != pinned ${pins.coincurveCommit}. Same supply-chain rule.`);
      process.exit(2);
    }
    ok(`both clones at their pinned commits`);
  } else {
    skip(`upstream/coincurve clone missing — basicswap pin verified, coincurve pin NOT verified`);
  }

  // -- 2. Has upstream moved? -------------------------------------------------
  if (!OFFLINE) {
    try {
      await git(["fetch", "--tags", "--quiet"]);
    } catch (e) {
      skip(`git fetch --tags failed (${String(e).slice(0, 120)}) — comparing against tags fetched previously`);
    }
  }
  const tags = (await git(["tag", "--sort=-v:refname"]))
    .split(/\r?\n/)
    .filter((t) => /^v\d+\.\d+/.test(t));
  const latest = AGAINST ?? tags[0];
  if (!latest) {
    skip(`no version tags visible in the clone at all`);
    process.exit(1);
  }
  // Whether the pin IS the newest tag no longer short-circuits the probes
  // below (it used to `process.exit()` here). Sections 3-12 diff pins.tag
  // against `latest`, which is a no-op (empty) diff when the two are equal —
  // harmless — but several of them (11's patch-series apply, 6's endpoint-
  // collision check, 4b below) read AT `latest`/pin rather than diffing, and
  // those are exactly as meaningful — arguably more so — when in sync: they
  // become a standing self-check of "does the CURRENT pin still hold
  // together" instead of going dark the moment there is nothing to catch up
  // on. Before this fix, being perfectly in sync (the common, desired state)
  // was the one condition under which the patch series was never dry-run at
  // all — the opposite of what "in sync" should mean for a check whose job
  // is exactly to keep the pinned patches verified.
  const inSync = latest === pins.tag;
  if (inSync) {
    ok(`pin ${pins.tag} IS the newest upstream tag — repo is in sync with upstream`);
  } else {
    const behind = (await git(["rev-list", "--count", `${pins.tag}..${latest}`])).trim();
    const releasesBehind = tags.indexOf(pins.tag);
    info(`upstream is at ${latest} — ${releasesBehind >= 0 ? `${releasesBehind} release(s)` : "?"} / ${behind} commits past the pin`);
  }

  // -- 3. Wire format. There is NO version negotiation on SMSG — any change
  //       here is peer-visible and must be read by a human before the pin moves.
  const wire = (await git(["diff", "--stat", `${pins.tag}..${latest}`, "--", "basicswap/messages_npb.py"])).trim();
  if (wire === "") ok(`wire format (messages_npb.py): byte-identical`);
  else broke(`wire format CHANGED — read the diff before anything else:\n${wire}`, "wrapper",
      "Hand-read messages_npb.py. SMSG has NO version negotiation, so an incompatible node is silently unreachable to peers — read this before anything else.");

  // -- 4. Coin-id enum. Our high ids and the wrapper's coin tables key off it.
  const chainparams = (await git(["diff", "--stat", `${pins.tag}..${latest}`, "--", "basicswap/chainparams.py"])).trim();
  if (chainparams === "") ok(`coin enum / chainparams.py: unchanged`);
  else warn(`chainparams.py changed — diff it for Coins enum + decimal_places + min_amount moves:\n${chainparams}`, "wrapper",
      "Re-check coin tables: types.ts (display-name->ticker, decimals) and WALLET_SIDECAR_COINS / COIN_TICKERS in swap_sidecar.rs.");

  // -- 4b. GROVE-RESERVED COIN IDS. Two of our own patches claim `Coins`
  //        enum values upstream does not (fully) use on its own:
  //        0016-zano-registration.patch uncomments upstream's own
  //        placeholder `# ZANO = 16`; 0014-zephyr-registration.patch adds
  //        `ZEPH = 19`, an id upstream has never defined at all (its highest
  //        real member at the pin is `DOGE = 18`). Coin ids ride the wire
  //        raw (see 3's SMSG note above) — if upstream ever assigns either
  //        id to a DIFFERENT coin, a Grove node offering "ZANO"/"ZEPH" at
  //        that id becomes indistinguishable, to a vanilla peer, from
  //        whatever coin THAT peer thinks the id names. This probe reads the
  //        Coins class AT `latest` (== the pin itself when already in sync,
  //        so it doubles as a standing self-check of the current pin, not
  //        only a forward-drift check) and confirms each id is either still
  //        unclaimed by upstream or already assigned to Grove's own coin.
  const coinsEnumAt = async (tag) => {
    const src = await showAt(tag, "basicswap/chainparams.py");
    const i = src.indexOf("class Coins");
    if (i < 0) throw new Error(`no "class Coins" found in chainparams.py at ${tag}`);
    const cls = src.slice(i);
    const out = new Map(); // id -> { name, active }
    for (const line of cls.split(/\r?\n/).slice(1)) {
      const m = line.match(/^(\s+)(#\s*)?([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*$/);
      if (m) {
        const [, , commented, name, id] = m;
        out.set(Number(id), { name, active: !commented });
      } else if (/^\S/.test(line)) {
        break; // dedented out of the class body
      }
    }
    if (out.size === 0) throw new Error(`could not parse any Coins members at ${tag}`);
    return out;
  };
  const GROVE_RESERVED_IDS = [
    { id: 16, groveName: "ZANO", patch: "0016-zano-registration.patch" },
    { id: 19, groveName: "ZEPH", patch: "0014-zephyr-registration.patch" },
  ];
  try {
    const coinsNow = await coinsEnumAt(latest);
    for (const { id, groveName, patch } of GROVE_RESERVED_IDS) {
      const entry = coinsNow.get(id);
      if (!entry) {
        ok(`Coins id ${id} unclaimed by upstream at ${latest} — Grove's ${groveName}=${id} (${patch}) is safe`);
      } else if (entry.name === groveName) {
        ok(`Coins id ${id} at ${latest}: ${entry.active ? "active" : "reserved (commented)"} as ${entry.name} — matches Grove's own ${groveName}=${id} (${patch})`);
      } else {
        broke(
          `Coins id ${id} is ${entry.active ? "ACTIVELY" : "provisionally"} claimed by upstream's ${entry.name} at ${latest} — collides with Grove's own ${groveName}=${id} (${patch}); a vanilla peer on ${latest} reads a Grove ${groveName} offer as ${entry.name}`,
          "engine",
          `Renumber Grove's ${groveName} to a free id across ${patch} and every wrapper mirror (chainparams.py's dependents, WALLET_SIDECAR_COINS/COIN_TICKERS in swap_sidecar.rs, the TS coin tables), or confirm ${entry.name} is a placeholder upstream can still move.`,
        );
      }
    }
  } catch (e) {
    skip(`could not verify Grove-reserved Coins ids (16=ZANO via ${GROVE_RESERVED_IDS[0].patch}, 19=ZEPH via ${GROVE_RESERVED_IDS[1].patch}) at ${latest}: ${String(e).slice(0, 160)}`);
  }

  // -- 5. Protocol floors. The network enforces these against our node; a
  //       raised floor is the clock on how long staying pinned stays viable.
  const protoRx = /(MINPROTO_VERSION_[A-Z_]+|MAXPROTO_VERSION|MINPROTO_VERSION)\s*=\s*(\d+)/g;
  const protoAt = async (tag) => {
    const src = await showAt(tag, "basicswap/basicswap.py");
    return new Map([...src.matchAll(protoRx)].map((m) => [m[1], m[2]]));
  };
  const [protoOld, protoNew] = [await protoAt(pins.tag), await protoAt(latest)];
  let protoMoved = false;
  for (const [k, vNew] of protoNew) {
    const vOld = protoOld.get(k);
    if (vOld !== undefined && vOld !== vNew) {
      protoMoved = true;
      warn(`protocol floor ${k}: ${vOld} -> ${vNew} — peers on ${latest} gate on the NEW value; a pinned node ages out of the network`, "runtime",
        "No code change; this is the CLOCK on staying pinned. Schedule the bump.");
    }
  }
  if (!protoMoved) ok(`protocol version floors unchanged (${[...protoNew.keys()].length} constants compared)`);

  // -- 5b. DATADIR SCHEMA. Added 2026-08-29, because this check did not exist
  //        when it was first needed.
  //
  //        The v0.17.9 -> v0.18.4 bump was written up as safe partly because
  //        "CURRENT_DB_VERSION 37 and CURRENT_DB_DATA_VERSION 9 identical, so
  //        the runtime swap was a binary replacement". That is a real and
  //        load-bearing property -- and NOTHING was measuring it. It was
  //        checked by hand once and then assumed. v0.18.5 moves BOTH (37->38,
  //        9->10), so the very next bump broke the assumption the previous one
  //        had quietly rested on.
  //
  //        Swap-EngineRuntime.ps1's own docstring says "verify separately that
  //        the engine versions share a DB schema version before running it" --
  //        a precondition stated in prose, owned by nobody, with no tool
  //        behind it. This is that tool.
  //
  //        It reports rather than judges: whether a migration is SAFE depends
  //        on what the upgrade steps do (v38 adds three indices; data v10 adds
  //        four bid-state rows -- both additive), and that is a diff a human
  //        reads. What the probe guarantees is that nobody swaps a runtime
  //        without knowing a migration is in it.
  const dbVerRx = /^(CURRENT_DB_VERSION|CURRENT_DB_DATA_VERSION)\s*=\s*(\d+)/gm;
  const dbVerAt = async (tag) => {
    const src = await showAt(tag, "basicswap/db.py");
    return new Map([...src.matchAll(dbVerRx)].map((m) => [m[1], m[2]]));
  };
  const [dbOld, dbNew] = [await dbVerAt(pins.tag), await dbVerAt(latest)];
  const dbMoved = [];
  for (const [k, vNew] of dbNew) {
    const vOld = dbOld.get(k);
    if (vOld !== undefined && vOld !== vNew) dbMoved.push(`${k} ${vOld} -> ${vNew}`);
  }
  if (dbMoved.length === 0) {
    ok(
      `datadir schema unchanged (${[...dbNew.keys()].join(", ")}) — a runtime swap stays a pure binary replacement`
    );
  } else {
    warn(
      `DATADIR MIGRATION in this gap: ${dbMoved.join("; ")} — the runtime swap is NOT a pure binary replacement; the datadir upgrades on first start`,
      "runtime",
      "Read basicswap/db_upgrades.py for the steps this adds, and confirm whether an OLDER engine can still open the migrated datadir (upgradeDatabase() returns early when the DB is newer, so an additive migration is normally still rollback-safe — CONFIRM it, do not assume). Back up the datadir before the operator swaps the live node."
    );
  }

  // -- 6. JSON API endpoints: extract the universe from js_server.py at both
  //       tags, DERIVE which keys the wrapper actually references, and flag
  //       only the intersection. Quoted-exact match keeps "rate"-sized keys
  //       from drowning in substring noise; the false-positive direction
  //       (claiming use where there is none) is the safe one.
  const endpointsAt = async (tag) => {
    const src = await showAt(tag, "basicswap/js_server.py");
    const block = src.slice(src.indexOf("endpoints = {"));
    const keys = new Set();
    for (const m of block.slice(0, block.indexOf("}")).matchAll(/"([a-z0-9_]+)":/g)) keys.add(m[1]);
    if (keys.size === 0) throw new Error(`could not parse the endpoints dict at ${tag}`);
    return keys;
  };
  const [epOld, epNew] = [await endpointsAt(pins.tag), await endpointsAt(latest)];
  const wrapperText = [];
  for (const f of WRAPPER_SOURCES) {
    const p = path.join(REPO_ROOT, f);
    if (existsSync(p)) wrapperText.push(await readFile(p, "utf8"));
    else warn(`wrapper source ${f} not found — endpoint-usage scan is missing a file it expects`);
  }
  for (const d of WRAPPER_SOURCE_DIRS) {
    const dir = path.join(REPO_ROOT, d);
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      if (/\.(ts|tsx)$/.test(f)) wrapperText.push(await readFile(path.join(dir, f), "utf8"));
    }
  }
  const blob = wrapperText.join("\n");
  const wrapperUses = (key) => blob.includes(`"${key}"`) || blob.includes(`/${key}`) || blob.includes(`${key}/`);
  const patchEndpoints = new Set();
  for (const f of (await readdir(PATCH_DIR)).filter((f) => f.endsWith(".patch"))) {
    const t = await readFile(path.join(PATCH_DIR, f), "utf8");
    for (const m of t.matchAll(/^\+\s*"(pwnda[a-z]+)":/gm)) patchEndpoints.add(m[1]);
  }
  let epTrouble = false;
  for (const k of epOld) {
    if (!epNew.has(k)) {
      if (wrapperUses(k)) {
        epTrouble = true;
        broke(`endpoint "${k}" REMOVED upstream and the wrapper references it`, "wrapper",
          `Find the caller (src/api/basicswap.ts or the swap_* Rust modules) and follow upstream's replacement.`);
      } else info(`endpoint "${k}" removed upstream (no wrapper reference found)`);
    }
  }
  for (const k of epNew) {
    if (!epOld.has(k)) info(`endpoint "${k}" added upstream`);
    if (patchEndpoints.has(k)) {
      epTrouble = true;
      broke(`upstream now defines "${k}" which OUR PATCH also adds — name collision, the patch will double-register or shadow it`, "engine",
        "Upstream may have implemented our patch. Read theirs; if equivalent, DELETE our patch rather than rebasing it.");
    }
  }
  if (!epTrouble) ok(`JSON API endpoint contract holds (${epOld.size} -> ${epNew.size} keys; patch-added: ${[...patchEndpoints].join(", ") || "none"})`);

  // -- 7. prepare.py argv. Candidate flags = every "--x" literal in the Rust
  //       supervisor that ALSO exists in the OLD prepare.py (that filter is
  //       what makes the wrapper-side grep safe); each must still exist in the
  //       NEW prepare.py or startup dies with "Unknown argument".
  const rustSrc = await readFile(path.join(REPO_ROOT, "src-tauri/src/swap_sidecar.rs"), "utf8");
  const flagCandidates = new Set([...rustSrc.matchAll(/"(--[a-z0-9][a-z0-9-_]+)/g)].map((m) => m[1]));
  const prepOld = await showAt(pins.tag, "basicswap/bin/prepare.py");
  const prepNew = await showAt(latest, "basicswap/bin/prepare.py");
  let argvTrouble = false;
  for (const f of flagCandidates) {
    if (!prepOld.includes(f)) continue; // not a prepare flag (cargo flag, node flag, …)
    if (!prepNew.includes(f)) {
      argvTrouble = true;
      broke(`prepare.py no longer knows ${f} — the supervisor passes it and prepare aborts on unknown arguments`, "wrapper",
        "Fix the argv plan in swap_sidecar.rs (build_prepare_plan / build_addcoin_plan / build_run_plan).");
    }
  }
  if (!argvTrouble) ok(`prepare.py still accepts every flag the supervisor passes`);

  // -- 8. Auth + console + port literals the wrapper hardcodes.
  const httpNew = await showAt(latest, "basicswap/http_server.py");
  for (const [lit, why] of [
    ["basicswap_session_id", "console cookie name (swap_sidecar.rs console_init_script)"],
    ["page_shutdown", "graceful-shutdown route (step 1 of the shutdown ladder)"],
    // urandom(8) = 16 hex chars — extract_shutdown_token requires EXACTLY 16.
    ["os.urandom(8).hex()", "shutdown-token width; the Rust extractor hardcodes 16 hex chars"],
    ["login", "console lands on /login pre-session (exempt page)"],
  ]) {
    if (httpNew.includes(lit)) ok(`http_server.py still carries "${lit}" (${why})`);
    else broke(`http_server.py lost "${lit}" — ${why}`, "wrapper", "Update the matching literal in swap_sidecar.rs.");
  }
  for (const port of ["12700", "11700"]) {
    if (prepNew.includes(port)) ok(`default port ${port} still in prepare.py`);
    else warn(`default port ${port} no longer literal in prepare.py — re-derive DEFAULT_*_PORT in swap_sidecar.rs`, "wrapper",
        "Re-derive DEFAULT_HTML_PORT / DEFAULT_WS_PORT in swap_sidecar.rs.");
  }

  // -- 9. BidStates renumber check. bidStates.ts mirrors 34 name->int pairs; a
  //       renumber mis-labels LIVE swaps, so compare pairs not just names.
  const bidStatesAt = async (tag) => {
    const src = await showAt(tag, "basicswap/basicswap_util.py");
    const cls = src.slice(src.indexOf("class BidStates"));
    const out = new Map();
    for (const line of cls.split(/\r?\n/).slice(1)) {
      const m = line.match(/^\s{4}([A-Z0-9_]+)\s*=\s*(\d+)/);
      if (m) out.set(m[1], m[2]);
      else if (/^\S/.test(line)) break; // left the class body
    }
    if (out.size === 0) throw new Error(`could not parse BidStates at ${tag}`);
    return out;
  };
  const [bsOld, bsNew] = [await bidStatesAt(pins.tag), await bidStatesAt(latest)];
  let bsTrouble = false;
  for (const [name, v] of bsOld) {
    const nv = bsNew.get(name);
    if (nv === undefined) {
      bsTrouble = true;
      broke(`BidStates.${name} removed upstream — bidStates.ts still maps it`, "wrapper",
        "Remove it from src/features/swap-sidecar/bidStates.ts and its stage mapping (both are exhaustiveness-tested).");
    } else if (nv !== v) {
      bsTrouble = true;
      broke(`BidStates.${name} renumbered ${v} -> ${nv} — bidStates.ts would mis-label live swaps`, "wrapper",
        name === "SWAP_COMPLETED"
          ? "Renumber in bidStates.ts AND in src-tauri/src/sidecar_fees/engine.rs (SWAP_COMPLETED is a bare int there and is the ONLY chargeable state — a stale value means the fee never collects, or collects on the wrong state)."
          : "Renumber in bidStates.ts. A wrong number mis-labels LIVE swaps, so treat as urgent.");
    }
  }
  for (const name of bsNew.keys()) {
    if (!bsOld.has(name)) warn(`BidStates.${name} is NEW upstream — bidStates.ts + its stage mapping need an entry (they are exhaustiveness-tested)`, "wrapper",
        "Add to bidStates.ts + the state->stage map.");
  }
  if (!bsTrouble) ok(`BidStates numbering stable (${bsOld.size} states compared)`);

  // -- 9b. The FEE's engine surface. The sidecar fee is a separate consumer of
  //        upstream from the swap UI, reading endpoints and payload fields no
  //        other probe covers. It shipped BLIND because it swept the wrong ROLE
  //        endpoint and required a field the list payload has never carried, and
  //        nothing here would have caught either, because nothing was checking
  //        the fee's own dependencies at all.
  //        See wiki/queries/2026-09-02-fee-system-readiness-review.md.
  //
  //        Silence is the hazard this probe exists for: the fee has no user
  //        watching it, so a broken sweep looks exactly like an honest "no
  //        eligible swaps yet". Everything below is checked at the CANDIDATE tag.
  const feeJs = await showAt(latest, "basicswap/js_server.py");
  const feeUi = await showAt(latest, "basicswap/ui/util.py");
  const between = (text, startRe, stopRe) => {
    const i = text.search(startRe);
    if (i < 0) return null;
    const rest = text.slice(i + 1);
    const j = rest.search(stopRe);
    return j < 0 ? text.slice(i) : text.slice(i, i + 1 + j);
  };

  // (a) BOTH sweep endpoints, and the role split that makes both necessary.
  //     js_bids returns RECEIVED bids (the maker half); a taker's own swaps live
  //     on js_sentbids. Sweeping one is sweeping half the book.
  const sentBidsFn = between(feeJs, /^def js_sentbids/m, /^def /m);
  if (!sentBidsFn) {
    broke(`js_sentbids is GONE — the fee sweeps it for the user's own (taker) bids and would go blind for every swap the user makes`, "wrapper",
      "Re-point SWEEP_ENDPOINTS in src-tauri/src/sidecar_fees/mod.rs at whatever replaced it, and update the_sweep_covers_both_bid_lists.");
  } else if (!/listBids\(\s*sent\s*=\s*True/.test(sentBidsFn)) {
    broke(`js_sentbids no longer calls listBids(sent=True) — the sweep's role assumption is broken and the fee may be reading the wrong half of the book`, "wrapper",
      "Re-read the role semantics, then fix SWEEP_ENDPOINTS in sidecar_fees/mod.rs.");
  } else if (!/^def js_bids/m.test(feeJs)) {
    broke(`js_bids is GONE — the fee sweeps it for bids received on our own offers`, "wrapper",
      "Update SWEEP_ENDPOINTS in sidecar_fees/mod.rs.");
  } else {
    ok(`fee sweep endpoints intact (js_bids + js_sentbids, sent=True role split)`);
  }

  // (b) The LIST payload must still carry an id. That is all the sweep takes,
  //     deliberately: it carries no state integer and never has.
  const formatBidsFn = between(feeJs, /^def formatBids/m, /^def /m);
  if (!formatBidsFn) skip(`could not locate formatBids at ${latest} — the fee sweep's payload shape is UNVERIFIED`);
  else if (!/"bid_id"/.test(formatBidsFn)) {
    broke(`formatBids no longer emits bid_id — the fee sweep opens records keyed on it and would record nothing at all`, "wrapper",
      "Fix sweep_bid_id in sidecar_fees/mod.rs and its formatBids fixture test.");
  } else ok(`formatBids still emits bid_id (the only field the fee sweep needs)`);

  // (c) The DETAIL payload carries what engine::decide needs, plus the creation
  //     time the first-start baseline uses to refuse retroactive charging.
  const describeBidFn = between(feeUi, /^def describeBid/m, /^def /m);
  if (!describeBidFn) skip(`could not locate describeBid at ${latest} — the fee decision's inputs are UNVERIFIED`);
  else {
    const needed = ["bid_state_ind", "ticker_from", "ticker_to", "amt_from", "amt_to"];
    const missing = needed.filter((f) => !new RegExp('"' + f + '"').test(describeBidFn));
    if (missing.length) {
      broke(`describeBid no longer emits ${missing.join(", ")} — sidecar_fees::parse_bid needs these, and a bid it cannot read is never charged`, "wrapper",
        "Update parse_bid in sidecar_fees/mod.rs and SettledBid in engine.rs.");
    } else if (!/"created_at_timestamp"|"created_at"/.test(describeBidFn)) {
      broke(`describeBid no longer emits a creation time — the fee's first-start baseline cannot age a bid and will refuse to charge ANY of them`, "wrapper",
        "Update parse_created_at in sidecar_fees/mod.rs (see Age / classify_age).");
    } else ok(`describeBid still carries the fee's decision fields and a creation time`);
  }

  // (d) The collection call. The only place the fee moves money.
  if (!/get_data_entry\(post_data,\s*"subfee"\)/.test(feeJs) || !/withdrawCoin\(/.test(feeJs)) {
    broke(`the wallet withdraw endpoint's shape changed ({value, address, subfee} -> withdrawCoin) — sidecar_fees::settle posts exactly that body`, "wrapper",
      "Re-read the handler, update swap_bridge::shared_withdraw_body + sidecar_fees/settle.rs. subfee:false is load-bearing: we receive exactly the fee and the USER pays the network cost, which FEE.md discloses.");
  } else ok(`fee collection endpoint shape unchanged ({value, address, subfee} -> withdrawCoin)`);

  // (e) Atomic units. sidecar_fees hardcodes ATOMIC_PER_COIN = 1e8 for all three
  //     fee coins; a decimals change scales every fee by a power of ten.
  for (const [ticker, dir] of [["LTC", "ltc"], ["BTC", "btc"], ["BCH", "bch"]]) {
    let dp = null;
    try {
      const cp = await showAt(latest, `basicswap/interface/${dir}/chainparams.py`);
      const m = cp.match(/"decimal_places"\s*:\s*(\d+)/);
      if (m) dp = Number(m[1]);
    } catch {}
    if (dp === null) skip(`could not read ${ticker} decimal_places at ${latest} — the fee's atomic-unit assumption is UNVERIFIED for it`);
    else if (dp !== 8) {
      broke(`${ticker} decimal_places is now ${dp}, not 8 — sidecar_fees::ATOMIC_PER_COIN assumes 1e8, so every ${ticker} fee would be wrong by a factor of 10^${Math.abs(dp - 8)}`, "wrapper",
        "Make ATOMIC_PER_COIN per-coin in sidecar_fees/schedule.rs, then RE-DERIVE every flat floor.");
    } else ok(`${ticker} decimal_places still 8 (the fee's atomic-unit assumption holds)`);
  }

  // -- 10. Dependency pins that ride along with the engine.
  const reqNew = await showAt(latest, "requirements.txt");
  const ccm = reqNew.match(/coincurve[^\n]*tags\/([A-Za-z0-9_.-]+)\.zip/);
  if (!ccm) skip(`could not read the coincurve pin out of ${latest}'s requirements.txt`);
  else if (ccm[1] !== pins.coincurveTag) warn(`coincurve fork pin moved ${pins.coincurveTag} -> ${ccm[1]} — the runtime rebuild needs the new fork tag, a NEW locally-built wheel, and new artifact hashes in fetch-swap-runtime.mjs`, "runtime",
      "Rebuild the fork wheel, RE-RUN the six-symbol gate (verify-coincurve.py), then update PIN_COINCURVE_* + the wheel hash.");
  else ok(`coincurve fork pin unchanged (${pins.coincurveTag})`);
  const pyNew = (await showAt(latest, "pyproject.toml")).match(/requires-python\s*=\s*"([^"]+)"/);
  if (pyNew) info(`requires-python at ${latest}: ${pyNew[1]} (embedded runtime ships CPython per fetch-swap-runtime.mjs — recheck if the floor rose)`);

  // -- 11. Patch series against the candidate tag: SEQUENTIAL apply in a
  //        throwaway materialization. Sequential, not per-patch --check
  //        against pristine: later patches edit code earlier ones introduce,
  //        so independent checks can pass a series that does not apply.
  const tmp = await mkdtemp(path.join(tmpdir(), "bsx-sync-"));
  try {
    // Local clone rather than archive+tar: the `tar` on a Windows PATH is
    // often MSYS GNU tar, which reads "C:\..." as a remote host and dies with
    // "Cannot connect to C". git is the one tool this script already requires.
    const dest = path.join(tmp, "tree");
    await execFileP("git", ["clone", "--quiet", "--no-checkout", CLONE, dest]);
    await execFileP("git", ["-C", dest, "checkout", "--quiet", "--detach", latest]);
    const series = (await readdir(PATCH_DIR)).filter((f) => /^\d{4}-.*\.patch$/.test(f)).sort();
    let fails = 0;
    for (const p of series) {
      try {
        await execFileP("git", ["apply", path.join(PATCH_DIR, p)], { cwd: dest });
        ok(`patch ${p} applies on ${latest}`);
      } catch (e) {
        fails++;
        const msg = String(e.stderr || e).split(/\r?\n/).find((l) => l.includes("error:")) ?? String(e).slice(0, 160);
        broke(`patch ${p} does NOT apply on ${latest} — ${msg}`, "engine",
          "Read upstream's diff at that region FIRST: 'stopped applying' and 'stopped being necessary' look identical here, and only one means deleting the patch.");
      }
    }
    if (fails === 0)
      info(`all ${series.length} patches apply — which proves REBASABILITY, not correctness; the invariant suites (scripts/swap/verify-*.py) against a rebuilt runtime are the authority on behaviour`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // -- 12. Churn at the patch-target files, so the reader knows where the
  //        invariant suites matter most even when every patch applied.
  const targets = [
    "basicswap/bin/run.py",
    "basicswap/basicswap.py",
    "basicswap/wallet_manager.py",
    "basicswap/js_server.py",
    "basicswap/interface/xmr/xmr.py",
    "basicswap/interface/btc/btc.py",
    "basicswap/interface/electrumx.py",
  ];
  const churn = (await git(["diff", "--stat", `${pins.tag}..${latest}`, "--", ...targets])).trim();
  if (churn) say(`INFO   churn at patch-target files (behaviour may have moved under a clean rebase):\n${churn}`);
  else ok(`zero churn at any patch-target file`);

  await checkInstalledRuntimes(pins);

  // Upstream delta for the report: how many commits, which releases, and the
  // fix/security-shaped subjects. Filtered rather than dumped -- a 75-commit
  // wall of "build: raise version" teaches nobody anything.
  let delta = null;
  try {
    const gapTags = [];
    for (const t of tags) {
      if (t === pins.tag) break; // tags are newest-first; stop at our pin
      gapTags.push(t);
    }
    const subjects = (await git(["log", "--format=%s", pins.tag + ".." + latest]))
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    const notable = subjects.filter(
      (x) => /^(fix|feat|security)/i.test(x) && !/^build:/i.test(x),
    );
    delta = { commits: subjects.length, releases: gapTags.reverse(), notable: notable.slice(0, 12) };
  } catch {
    delta = null;
  }
  if (REPORT) await writeReport(pins, latest, delta);

  // -- Verdict ---------------------------------------------------------------
  say(``);
  if (inSync) {
    say(`verdict: ${breaks} BREAK, ${warns} WARN — repo at the newest tag (${latest}).`);
    if (breaks) say(`An installed engine (or the pinned patch series itself) needs attention; see above.`);
    process.exit(breaks ? 1 : 0);
  }
  say(`verdict: ${breaks} BREAK, ${warns} WARN against ${latest}.`);
  say(`Moving the pin is a deliberate step — follow`);
  say(`  PwndaWalletVault/wiki/synthesis/basicswap-upstream-sync.md`);
  say(`(procedure, per-layer decision rules, and the update-together checklist: pin table,`);
  say(`patches "Applies to" line, fetch-swap-runtime pins + wheel hashes, invariant suites, log.md).`);
  process.exit(1); // an update is available; the report above is the action list
}

main().catch((e) => {
  console.error(`${LOG} FATAL ${e.stack || e}`);
  process.exit(2);
});
