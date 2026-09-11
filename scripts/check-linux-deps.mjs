#!/usr/bin/env node
/**
 * Guard: the Linux dependency lists must not GROW without someone deciding.
 *
 * # The failure this exists to make unreachable
 *
 * `.deb` and `.rpm` became in-app updatable on 2026-09-10. The plugin installs
 * them with `pkexec dpkg -i` / `pkexec rpm -U`, which is what apt runs
 * underneath — but plain `dpkg -i` **does not resolve dependencies**. It
 * installs the package and, if a dependency is missing, leaves it in a
 * half-configured state that the user has to repair by hand with
 * `sudo apt-get -f install`.
 *
 * That failure is impossible while the dependency list is unchanged: every dep
 * in the CURRENT list is, by definition, already installed on any machine
 * running the app, because the original install resolved them. It becomes
 * possible the first time a release ADDS one — a machine that never needed
 * `libfoo` will not have it, and the self-update lands half-configured.
 *
 * So the risk is not a property of the user's machine or of the network. It is
 * a property of one edit to `tauri.conf.json`, made on a build machine, days
 * earlier. That is where it should be caught, and this is what catches it.
 *
 * # What it does NOT do
 *
 * It does not forbid adding a dependency. Adding one is legitimate — a new
 * feature may genuinely need a new library. What it forbids is adding one
 * *silently*, and shipping a self-update that will half-configure on every
 * machine that lacks it. When you do add one, the fix is a deliberate choice
 * between:
 *
 *   * `--accept` — record the new baseline and ship it, knowing self-update
 *     may need a manual repair on machines missing the dep. Reasonable when
 *     the dep is near-universal (`tar`, `bzip2`).
 *   * ship that release WITHOUT deb/rpm in the updater manifest
 *     (`--allow-partial` on the manifest generator), so those users install it
 *     from the download page or from the apt/rpm repo, where deps resolve.
 *
 * Removing a dependency is always fine and is recorded without complaint: a
 * package that needs less than before cannot fail for needing more.
 *
 * # Usage
 *
 *   node scripts/check-linux-deps.mjs            # verify against the baseline
 *   node scripts/check-linux-deps.mjs --accept   # record the current lists
 *
 * The baseline is `scripts/linux-deps.baseline.json`, tracked in git, so the
 * question "did this release change what Linux needs" is answerable from the
 * diff alone.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const LOG = "[linux-deps]";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CONF = join(REPO_ROOT, "src-tauri", "tauri.conf.json");
const BASELINE = join(HERE, "linux-deps.baseline.json");

const accept = process.argv.includes("--accept");

/** Strip a UTF-8 BOM; `tauri.conf.json` has been written with one before. */
const readJson = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));

const conf = readJson(CONF);
const linux = conf?.bundle?.linux ?? {};

/**
 * The two lists, normalised.
 *
 * Sorted and de-duplicated so that reordering the array in `tauri.conf.json` —
 * which changes nothing about what gets installed — is not reported as drift.
 * A guard that fires on cosmetic edits is a guard people learn to bypass.
 */
const current = {
  deb: [...new Set(linux?.deb?.depends ?? [])].sort(),
  rpm: [...new Set(linux?.rpm?.depends ?? [])].sort(),
};

if (accept) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`${LOG} baseline recorded:`);
  for (const [fmt, deps] of Object.entries(current)) {
    console.log(`${LOG}   ${fmt}: ${deps.length ? deps.join(", ") : "(none)"}`);
  }
  console.log(`${LOG} commit ${BASELINE} with the change that needed it.`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(
    `${LOG} no baseline at ${BASELINE}.\n` +
      `${LOG} Run: node scripts/check-linux-deps.mjs --accept`,
  );
  process.exit(2);
}

const baseline = readJson(BASELINE);
const added = {};
const removed = {};
for (const fmt of ["deb", "rpm"]) {
  const was = new Set(baseline[fmt] ?? []);
  const now = new Set(current[fmt] ?? []);
  added[fmt] = [...now].filter((d) => !was.has(d));
  removed[fmt] = [...was].filter((d) => !now.has(d));
}

for (const fmt of ["deb", "rpm"]) {
  if (removed[fmt].length) {
    console.log(`${LOG} ${fmt}: dropped ${removed[fmt].join(", ")} (fine — fewer requirements cannot break an upgrade)`);
  }
}

const grew = ["deb", "rpm"].filter((f) => added[f].length);
if (!grew.length) {
  const n = current.deb.length + current.rpm.length;
  console.log(`${LOG} OK — no new dependencies (${n} declared across deb + rpm).`);
  // A removal still changes the file, and leaving the baseline stale would
  // make the NEXT run report the same removal again. Say so rather than
  // rewriting it here: this command is a check, and a check that edits its own
  // expectations is not one.
  if (removed.deb.length || removed.rpm.length) {
    console.log(`${LOG} run --accept to record the removals.`);
  }
  process.exit(0);
}

console.error(`${LOG} REFUSING: this release adds Linux dependencies.\n`);
for (const fmt of grew) {
  console.error(`${LOG}   ${fmt}: + ${added[fmt].join(", ")}`);
}
console.error(
  `\n${LOG} In-app update installs these with \`dpkg -i\` / \`rpm -U\`, which do NOT\n` +
    `${LOG} resolve dependencies. Any machine without the packages above would take\n` +
    `${LOG} this update and end up half-configured, needing \`sudo apt-get -f install\`\n` +
    `${LOG} by hand.\n` +
    `\n${LOG} Choose one:\n` +
    `${LOG}   1. node scripts/check-linux-deps.mjs --accept\n` +
    `${LOG}      Ship it. Right when the dep is near-universal, or when you accept\n` +
    `${LOG}      that some users will need one manual repair.\n` +
    `${LOG}   2. Release without deb/rpm as updater targets, so those users get it\n` +
    `${LOG}      from the download page or the apt/rpm repo, where deps resolve.\n`,
);
process.exit(1);
