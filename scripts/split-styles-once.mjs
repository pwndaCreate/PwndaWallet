#!/usr/bin/env node
/**
 * scripts/split-styles-once.mjs
 *
 * One-shot splitter that carves the legacy src/styles.css monolith into
 * the purpose-files documented in design-system-modularization.md Phase 2:
 *
 *   src/design/styles/reset.css      — universal reset, body, window-shell
 *   src/design/styles/chrome.css     — titlebar, .app, header
 *   src/design/styles/utilities.css  — .type-*, .color-*, .qbtn, .field, ...
 *   src/design/styles/legacy.css     — every old component class
 *
 * tokens.css + keyframes.css are emitted by generate-tokens-css.mjs;
 * those keyframes already in styles.css are deleted from the split
 * output (the generated keyframes.css supersedes them).
 *
 * After running this once, src/styles.css becomes a 7-line @import barrel.
 *
 * Delete this script after running it — it's a one-time migration.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_CSS = path.join(ROOT, "src", "styles.css");
const STYLES_OUT = path.join(ROOT, "src", "design", "styles");

if (!existsSync(STYLES_OUT)) mkdirSync(STYLES_OUT, { recursive: true });

const src = readFileSync(SRC_CSS, "utf8");

// Strip the :root block (tokens.css owns it now).
const afterRoot = src.replace(/:root\s*\{[^}]*\}/, "/* :root tokens moved to src/design/styles/tokens.css */");

// Strip every existing @keyframes block (keyframes.css owns them now).
const afterKeyframes = afterRoot.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\}[^{}]*)*[^{}]*\}/g, "");

// Strip the @import url() for Google Fonts — keep it at the top of the barrel.
const fontImport = afterKeyframes.match(/@import\s+url\(['"]https:\/\/fonts\.googleapis[^)]*\);/)?.[0] ?? "";
const afterFontStrip = afterKeyframes.replace(/@import\s+url\(['"]https:\/\/fonts\.googleapis[^)]*\);/g, "");

// Strip the leading file banner — replace with a short note.
const noBanner = afterFontStrip.replace(/^\/\*\s*={5,}[\s\S]*?={5,}\s*\*\/\s*/, "");

// ---------------------------------------------------------------------------
// Carve the remaining content into ranges by marker comments.
// We use heuristic anchors that exist in the file — section divider comments
// like /* ── Titlebar ── */ and the explicit "DESIGN-SYSTEM UTILITY CLASSES"
// banner near line 1444.
// ---------------------------------------------------------------------------

const sections = {
  reset: [],     // universal *, body, .window-shell, .window-shell::after, .app + scrollbar
  chrome: [],    // .titlebar, .titlebar-*, .app::-webkit-scrollbar, header h1, etc.
  utilities: [], // everything from "DESIGN-SYSTEM UTILITY CLASSES" onward
  legacy: [],    // everything else (most of the file)
};

// Split into rule blocks. A rule is "selector(s) { ... }" with optional
// preceding comment.
const lines = noBanner.split("\n");
let buf = [];
let depth = 0;
const blocks = [];
for (const line of lines) {
  buf.push(line);
  for (const ch of line) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth === 0 && buf.join("").trim().endsWith("}")) {
    blocks.push(buf.join("\n"));
    buf = [];
  }
}
if (buf.length) blocks.push(buf.join("\n"));

const matchAny = (text, patterns) => patterns.some((p) => text.includes(p));

const RESET = [
  "* {", "* { margin",
  "body {", "body{",
  ".window-shell {",
  ".window-shell::",
];
const CHROME = [
  ".titlebar",
  ".app {", ".app::-webkit",
  ".no-scrollbar",
  "header {", "header h1", ".header-actions", ".btn-setup",
];
const UTILITIES_BANNER = "DESIGN-SYSTEM UTILITY CLASSES";
const V2_BANNER = "v2 UTILITY CLASSES";

let inUtilities = false;
for (const block of blocks) {
  if (block.includes(UTILITIES_BANNER) || block.includes(V2_BANNER)) inUtilities = true;
  if (inUtilities) {
    sections.utilities.push(block);
    continue;
  }
  if (matchAny(block, RESET)) {
    sections.reset.push(block);
    continue;
  }
  if (matchAny(block, CHROME)) {
    sections.chrome.push(block);
    continue;
  }
  sections.legacy.push(block);
}

// ---------------------------------------------------------------------------
// Write outputs
// ---------------------------------------------------------------------------

function emit(name, blocks, header) {
  const body = blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  writeFileSync(path.join(STYLES_OUT, name), header + "\n\n" + body);
  console.log(`[split] wrote ${name} — ${blocks.length} rule(s)`);
}

emit(
  "reset.css",
  sections.reset,
  `/* Reset + window shell. Sourced from src/styles.css during Phase 2 split. */`
);
emit(
  "chrome.css",
  sections.chrome,
  `/* App chrome — titlebar, scrollbar, header. Sourced during Phase 2 split. */`
);
emit(
  "utilities.css",
  sections.utilities,
  `/* Utility classes — .type-*, .color-*, .bg-*, .border-*, .qbtn, .field, .tnum, etc.
 * Used by the v2 primitives + many legacy views.
 */`
);
emit(
  "legacy.css",
  sections.legacy,
  `/* LEGACY COMPONENT CSS — FROZEN.
 *
 * Every class here predates the v2 primitive layer. New code uses
 * inline-styled or .module.css primitives from src/design/primitives/.
 * When you touch a view that uses one of these classes, migrate it in
 * the same PR.
 *
 * Use \`npm run legacy-css-usage\` to list which classes are still in use.
 *
 * Deprecation map (replacement primitive):
 *   .card                        → <Card> from src/design/primitives
 *   .btn-primary / .btn-secondary→ <Btn variant="primary"/"ghost">
 *   .btn-danger                  → <Btn variant="danger">
 *   .btn-mining / .mine-btn-*    → <Btn variant="accent" size="lg" full> (mining-specific)
 *   .terminal-box                → <Card> or <Panel>
 *   .alert / .alert-*            → use semantic tokens + <Card> compositions
 *   .tab / .tab-row              → no primitive yet; consider adding <TabRow>
 *   .chain-dropdown              → no primitive yet; consider <Select>
 *   .modal-overlay / .modal-dialog → no primitive yet; consider <Modal>
 *   .mining-*, .mine-*, .miner-* → mining-feature-specific; keep until migrated
 */`
);

// Write barrel
const barrel = `/* PwndaWallet styles.css barrel.
 *
 * Split into purpose-files under src/design/styles/ as part of Phase 2
 * of the design-system-modularization plan. Tokens + keyframes are
 * generated from src/design/tokens.ts by scripts/generate-tokens-css.mjs.
 *
 * Existing imports of "./styles.css" keep working — this barrel produces
 * the same merged stylesheet as the legacy monolith.
 */
${fontImport}

@import "./design/styles/tokens.css";
@import "./design/styles/keyframes.css";
@import "./design/styles/reset.css";
@import "./design/styles/chrome.css";
@import "./design/styles/utilities.css";
@import "./design/styles/legacy.css";
`;
writeFileSync(SRC_CSS, barrel);
console.log(`[split] wrote src/styles.css barrel (${barrel.length} bytes)`);
