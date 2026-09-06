// =============================================================================
// scripts/check-file-sizes.mjs — oversized-source-file guard (drift backstop)
// =============================================================================
//
// Workstream C of the code-structure-improvement-plan
// (PwndaWalletVault/wiki/synthesis/code-structure-improvement-plan.md).
//
// The plan split several "god files" (proxy.rs, App.tsx, useMiner.ts) into
// focused modules. This guard stops them from silently re-forming: it lists
// every source file over a line threshold so a reviewer (human or agent) can
// see the current god-file candidates at a glance.
//
// ADVISORY by default (always exit 0) so it can be wired into prebuild as a
// non-blocking warning. Pass --strict to exit 1 when any file is over the
// threshold (for a dedicated CI lane). Override the threshold with --max <n>.
//
// No external dependencies (node:fs / node:path only).
//
// Usage:
//   node scripts/check-file-sizes.mjs              # advisory, exit 0
//   node scripts/check-file-sizes.mjs --max 1000   # custom threshold
//   node scripts/check-file-sizes.mjs --strict      # exit 1 if any over
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const SOURCE_ROOTS = ["src", "src-tauri/src", "src-lite"];
const SOURCE_EXT = new Set([".ts", ".tsx", ".rs"]);
const EXCLUDED_SEGMENTS = ["node_modules", "target", "target-sandbox", "target-linux", "dist"];

// Known large *data* files (word arrays / generated tables) — not logic, so
// excluded from the guard. Line count there is irrelevant to maintainability.
const DATA_FILE_RE = /wordlist|\.gen\.|\.generated\./i;

const STRICT = process.argv.includes("--strict");
const MAX_LINES = (() => {
  const i = process.argv.indexOf("--max");
  if (i >= 0 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 800;
})();

function toRel(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join("/");
}

function isExcluded(rel) {
  return rel.split("/").some((p) => EXCLUDED_SEGMENTS.includes(p));
}

function walk(dirAbs, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return; // missing/unreadable root — skip
  }
  for (const entry of entries) {
    const childAbs = path.join(dirAbs, entry.name);
    if (isExcluded(toRel(childAbs))) continue;
    if (entry.isDirectory()) walk(childAbs, onFile);
    else if (entry.isFile()) onFile(childAbs);
  }
}

function countLines(abs) {
  try {
    return fs.readFileSync(abs, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

function main() {
  const offenders = [];
  for (const root of SOURCE_ROOTS) {
    walk(path.join(REPO_ROOT, root), (abs) => {
      const ext = path.extname(abs).toLowerCase();
      if (!SOURCE_EXT.has(ext)) return;
      const rel = toRel(abs);
      if (DATA_FILE_RE.test(rel)) return; // skip data tables
      const lines = countLines(abs);
      if (lines > MAX_LINES) offenders.push({ rel, lines });
    });
  }

  offenders.sort((a, b) => b.lines - a.lines);

  console.log(`check-file-sizes: ${offenders.length} source file(s) over ${MAX_LINES} lines`);
  if (offenders.length > 0) {
    console.log("");
    for (const o of offenders) {
      console.log(`  ${String(o.lines).padStart(6)}  ${o.rel}`);
    }
    console.log("");
    console.log("God-file candidates — consider extracting focused modules (see code-structure-improvement-plan).");
  }

  if (STRICT && offenders.length > 0) process.exit(1);
  process.exit(0);
}

main();
