#!/usr/bin/env node
/**
 * scripts/legacy-css-usage.mjs
 *
 * Reports which legacy CSS classes (from src/design/styles/legacy.css)
 * are still in use across the codebase. Prints a table sorted by
 * usage count. Run on demand — not wired into CI.
 *
 * Usage:
 *   npm run legacy-css-usage
 *
 * Useful when:
 *   - Planning a migration sweep ("which classes are widely used?")
 *   - Confirming a primitive replacement is safe ("does .btn-primary
 *     still appear anywhere?")
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LEGACY = path.join(ROOT, "src", "design", "styles", "legacy.css");

// Extract every class selector from legacy.css
const css = readFileSync(LEGACY, "utf8");
const classRe = /\.([a-zA-Z][a-zA-Z0-9_-]*)(?=[\s.,:>+~\[{])/g;
const classes = new Set();
let m;
while ((m = classRe.exec(css)) !== null) classes.add(m[1]);

// Walk src/ and src-lite/ for TSX/TS files referencing them
function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "dist-lite") continue;
    if (entry === "design" && dir.endsWith("src")) continue; // skip self-referential design layer
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

const files = [
  ...walk(path.join(ROOT, "src")),
  ...walk(path.join(ROOT, "src-lite")).filter(() => {
    try {
      statSync(path.join(ROOT, "src-lite"));
      return true;
    } catch {
      return false;
    }
  }),
];

const usage = new Map();
for (const cls of classes) usage.set(cls, []);

for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const cls of classes) {
    // Match: className="...cls..." or className={`...cls...`}
    const re = new RegExp(`(?:className=|class=)["'\`][^"'\`]*\\b${cls}\\b[^"'\`]*["'\`]`);
    if (re.test(src)) usage.get(cls).push(path.relative(ROOT, file));
  }
}

const ranked = [...usage.entries()]
  .filter(([, locs]) => locs.length > 0)
  .sort((a, b) => b[1].length - a[1].length);

const unused = [...usage.entries()].filter(([, locs]) => locs.length === 0);

console.log(`\nLegacy CSS class usage (${classes.size} classes scanned in legacy.css)\n`);
console.log("Used:");
for (const [cls, locs] of ranked) {
  console.log(`  .${cls.padEnd(36)} ${locs.length}x`);
}

console.log(`\nUnused (safe to delete): ${unused.length} classes`);
if (process.argv.includes("--verbose")) {
  for (const [cls] of unused) console.log(`  .${cls}`);
}
console.log(`\nRun with --verbose to list unused classes.`);
console.log(`Run with --files <class> to list files using a specific class.\n`);

const filesFlag = process.argv.indexOf("--files");
if (filesFlag !== -1 && process.argv[filesFlag + 1]) {
  const target = process.argv[filesFlag + 1].replace(/^\./, "");
  const locs = usage.get(target);
  if (!locs) {
    console.log(`No such legacy class: .${target}`);
  } else {
    console.log(`\nFiles using .${target}:`);
    for (const f of locs) console.log(`  ${f}`);
  }
}
