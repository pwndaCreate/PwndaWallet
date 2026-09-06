#!/usr/bin/env node
/**
 * scripts/generate-tokens-css.mjs
 *
 * Reads src/design/tokens.ts (parsed as a TS module via tsc compile or
 * a regex sniff — we use the latter to avoid a tsc dep at script
 * runtime) and emits four files:
 *
 *   src/design/styles/tokens.css     — :root block + short aliases
 *   src/design/styles/keyframes.css  — @keyframes consuming motion vars
 *   src/design/tokens.json           — flat key/value mirror
 *   src/design/tokens.d.ts           — TokenName discriminated union
 *
 * Flags:
 *   --check   exits non-zero if generated output differs from on-disk
 *             (used by `npm run check-tokens` in CI)
 *
 * The script imports the .ts file using a regex-driven snapshot rather
 * than executing TypeScript — keeps the script zero-dep. The trade-off
 * is that the source object must be a plain const-asserted literal
 * (which is true today and is enforced by the test in Phase 8).
 *
 * Run from `prebuild` so every build has fresh outputs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DESIGN = path.join(REPO_ROOT, "src", "design");
const STYLES = path.join(DESIGN, "styles");

const CHECK = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Load tokens.ts as a module via dynamic import. Vite-side TS is fine; node
// 22 has native ESM-TS via `--experimental-strip-types`. Fallback: regex.
// ---------------------------------------------------------------------------

async function loadTokens() {
  // Strategy: write a temp .mjs that imports the .ts source via a regex
  // extraction. The file is small and structured, so the regex is reliable.
  const tsSource = readFileSync(path.join(DESIGN, "tokens.ts"), "utf8");
  const match = tsSource.match(/export const tokens\s*=\s*(\{[\s\S]*?\})\s*as const;/);
  if (!match) {
    console.error("[gen-tokens] FAIL — could not parse tokens.ts");
    process.exit(1);
  }
  // Convert TS object literal to JSON-ish JS. The literal only uses
  // string keys (some quoted, some unquoted), numbers, and strings — no
  // function references, no spreads, no computed keys. Safe to eval.
  const objLiteral = match[1]
    // Strip block comments and line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*\n/g, "\n");
  // eslint-disable-next-line no-eval
  const tokens = eval("(" + objLiteral + ")");
  return tokens;
}

// ---------------------------------------------------------------------------
// CSS variable name mapping. Mirrors the existing var names in styles.css
// so the diff is byte-identical on first run.
// ---------------------------------------------------------------------------

function emitTokensCss(tokens) {
  const lines = ["/* AUTO-GENERATED from src/design/tokens.ts. Do not hand-edit. */", "", ":root {"];

  // Backgrounds
  lines.push(`  --bg:           ${tokens.bg.base};`);
  lines.push(`  --bg-2:         ${tokens.bg["2"]};`);
  lines.push(`  --surface:      ${tokens.bg.surface};`);
  lines.push(`  --surface-2:    ${tokens.bg["surface-2"]};`);
  lines.push("");

  // Borders (three weights)
  lines.push(`  --border:       ${tokens.border.default};`);
  lines.push(`  --border-hi:    ${tokens.border.hi};`);
  lines.push(`  --border-soft:  ${tokens.border.soft};`);
  lines.push("");

  // Text
  lines.push(`  --text:         ${tokens.text.default};`);
  lines.push(`  --text-muted:   ${tokens.text.muted};`);
  lines.push(`  --text-dim:     ${tokens.text.dim};`);
  lines.push(`  --white:        ${tokens.text.white};`);
  lines.push("");

  // Accent
  lines.push(`  --accent:       ${tokens.accent.base};`);
  lines.push(`  --accent-soft:  ${tokens.accent.soft};`);
  lines.push(`  --accent-mid:   ${tokens.accent.mid};`);
  lines.push(`  --accent-glow:  ${tokens.accent.glow};`);
  // Legacy alias retained as plain pointer (NOT a duplicated value) so
  // callers using var(--accent-dim) still resolve. New code: use
  // var(--accent-soft) directly.
  lines.push(`  --accent-dim:   var(--accent-soft);`);
  lines.push("");

  // Semantic
  lines.push(`  --success:      ${tokens.semantic.success.base};`);
  lines.push(`  --success-dim:  ${tokens.semantic.success.dim};`);
  lines.push(`  --danger:       ${tokens.semantic.danger.base};`);
  lines.push(`  --danger-dim:   ${tokens.semantic.danger.dim};`);
  lines.push(`  --warn:         ${tokens.semantic.warn.base};`);
  lines.push(`  --warn-dim:     ${tokens.semantic.warn.dim};`);
  lines.push(`  --positive:     ${tokens.semantic.positive};`);
  lines.push(`  --negative:     ${tokens.semantic.negative};`);
  lines.push("");

  // CRT
  lines.push(`  --scan-opacity: ${tokens.crt.scanOpacity};`);
  lines.push("");

  // Radius
  lines.push(`  --radius:         ${tokens.radius.default}px;`);
  lines.push(`  --radius-sm:      ${tokens.radius.sm}px;`);
  lines.push(`  --radius-xs:      ${tokens.radius.xs}px;`);
  lines.push(`  --radius-window:  ${tokens.radius.window}px;`);
  lines.push("");

  // Typography
  lines.push(`  --font-pixel:   ${tokens.type.family.pixel};`);
  lines.push(`  --font-mono:    ${tokens.type.family.mono};`);
  lines.push(`  --font-sans:    ${tokens.type.family.sans};`);
  lines.push(`  --pixel:        var(--font-pixel);`);
  lines.push(`  --mono:         var(--font-mono);`);
  lines.push(`  --sans:         var(--font-sans);`);
  lines.push("");

  // Type scale
  for (const [k, v] of Object.entries(tokens.type.scale)) {
    lines.push(`  --text-${(k + ":").padEnd(7)} ${v}px;`);
  }
  lines.push("");

  // Tracking
  for (const [k, v] of Object.entries(tokens.type.tracking)) {
    lines.push(`  --tracking-${(k + ":").padEnd(8)} ${v}px;`);
  }
  lines.push("");

  // Leading
  for (const [k, v] of Object.entries(tokens.type.leading)) {
    lines.push(`  --leading-${(k + ":").padEnd(9)} ${v};`);
  }
  lines.push("");

  // Spacing
  for (const [k, v] of Object.entries(tokens.space)) {
    lines.push(`  --space-${(k + ":").padEnd(4)} ${v}px;`);
  }
  lines.push("");

  // Transition (matches existing tokens)
  lines.push(`  --transition-fast:   all ${tokens.motion.transition.fast}ms ease;`);
  lines.push(`  --transition-medium: all ${tokens.motion.transition.medium}ms ease;`);
  lines.push(`  --transition-slow:   all ${tokens.motion.transition.slow}ms ease;`);
  lines.push("");

  // Motion durations (new — for @keyframes to consume via var())
  lines.push("  /* Motion durations (see src/design/BEHAVIORS.md) */");
  lines.push(`  --motion-pulse-duration:    ${tokens.motion.pulse.duration}ms;`);
  lines.push(`  --motion-blink-duration:    ${tokens.motion.blink.duration}ms;`);
  lines.push(`  --motion-fadein-duration:   ${tokens.motion.fadeIn.duration}ms;`);
  lines.push(`  --motion-fadein-translate:  ${tokens.motion.fadeIn.translateY}px;`);
  lines.push(`  --motion-scan-duration:     ${tokens.motion.scan.duration}ms;`);
  lines.push(`  --motion-syncbar-duration:  ${tokens.motion.syncbar.duration}ms;`);
  lines.push(`  --motion-syncbar-step:      ${tokens.motion.syncbar.step}px;`);
  lines.push(`  --motion-alert-duration:    ${tokens.motion.alertPulse.duration}ms;`);
  lines.push(`  --motion-progress-duration: ${tokens.motion.progressPulse.duration}ms;`);
  lines.push(`  --motion-mining-duration:   ${tokens.motion.miningPulse.duration}ms;`);
  lines.push(`  --motion-loading-duration:  ${tokens.motion.loadingPulse.duration}ms;`);
  lines.push(`  --motion-hover-duration:    ${tokens.motion.hover.duration}ms;`);
  lines.push(`  --motion-hover-easing:      ${tokens.motion.hover.easing};`);
  lines.push("");

  // UI constants
  lines.push(`  --disabled-opacity: ${tokens.ui.disabledOpacity};`);
  lines.push("");

  // Short aliases — prototype names (BEHAVIORS.md §4)
  lines.push("  /* Short aliases — match the prototype names */");
  lines.push(`  --bg2:        var(--bg-2);`);
  lines.push(`  --surf:       var(--surface);`);
  lines.push(`  --surf2:      var(--surface-2);`);
  lines.push(`  --bdr:        var(--border);`);
  lines.push(`  --bdr-hi:     var(--border-hi);`);
  lines.push(`  --muted:      var(--text-muted);`);
  lines.push(`  --dim:        var(--text-dim);`);
  lines.push(`  --green:      var(--accent);`);
  lines.push(`  --green-dim:  var(--accent-soft);`);
  lines.push(`  --green-glow: var(--accent-glow);`);
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

function emitKeyframesCss(tokens) {
  return `/* AUTO-GENERATED from src/design/tokens.ts motion block. Do not hand-edit. */

@keyframes blink {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0; }
}

@keyframes pulse {
  0%, 100% { opacity: 0.25; transform: scale(0.75); }
  50%      { opacity: 1;    transform: scale(1.25); }
}

@keyframes fade-in {
  0%   { opacity: 0; transform: translateY(var(--motion-fadein-translate, 6px)); }
  100% { opacity: 1; transform: translateY(0); }
}

@keyframes scan {
  0%   { top: -4px; }
  100% { top: 100%; }
}

@keyframes syncbar {
  0%   { background-position: 0 0; }
  100% { background-position: var(--motion-syncbar-step, 40px) 0; }
}

@keyframes alert-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.7; }
}

@keyframes mining-pulse-anim {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50%      { opacity: 1;   transform: scale(1.2); }
}

@keyframes pulse-loading {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}

@keyframes progress-pulse {
  0%, 100% { opacity: 0.3; }
  50%      { opacity: 1; }
}
`;
}

// Flatten the token tree to dot-paths for tokens.json + tokens.d.ts
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function emitTokensJson(tokens) {
  return JSON.stringify(flatten(tokens), null, 2) + "\n";
}

function emitTokensDts(tokens) {
  const flat = flatten(tokens);
  const names = Object.keys(flat).map((k) => `"${k}"`).join("\n  | ");
  return `// AUTO-GENERATED from src/design/tokens.ts. Do not hand-edit.

/** Dot-path name of every token in tokens.ts. */
export type TokenName =
  | ${names};
`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
  if (!existsSync(STYLES)) mkdirSync(STYLES, { recursive: true });

  const tokens = await loadTokens();

  const outputs = [
    { path: path.join(STYLES, "tokens.css"), content: emitTokensCss(tokens) },
    { path: path.join(STYLES, "keyframes.css"), content: emitKeyframesCss(tokens) },
    { path: path.join(DESIGN, "tokens.json"), content: emitTokensJson(tokens) },
    { path: path.join(DESIGN, "tokens.d.ts"), content: emitTokensDts(tokens) },
  ];

  let drift = 0;
  for (const out of outputs) {
    const existing = existsSync(out.path) ? readFileSync(out.path, "utf8") : null;
    if (CHECK) {
      if (existing !== out.content) {
        console.error(
          `[gen-tokens] DRIFT — ${path.relative(REPO_ROOT, out.path)} out of sync with tokens.ts`
        );
        drift += 1;
      }
    } else {
      if (existing !== out.content) {
        writeFileSync(out.path, out.content);
        console.log(`[gen-tokens] wrote ${path.relative(REPO_ROOT, out.path)}`);
      }
    }
  }

  if (CHECK && drift > 0) {
    console.error(`[gen-tokens] FAIL — ${drift} file(s) out of sync. Run 'npm run gen-tokens'.`);
    process.exit(1);
  }
  if (CHECK) {
    console.log("[gen-tokens] PASS");
  } else {
    console.log("[gen-tokens] done");
  }
}

run().catch((e) => {
  console.error("[gen-tokens] FAIL", e);
  process.exit(1);
});
