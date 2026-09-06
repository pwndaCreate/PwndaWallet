#!/usr/bin/env node
/**
 * scripts/snapshot-catalog.mjs
 *
 * Snapshots the design catalog at all four accent themes into
 * `.design-snapshots/<branch>/` for before/after PR diffs.
 *
 * Requires Playwright (not currently a project dep):
 *   npm install --save-dev @playwright/test
 *   npx playwright install chromium
 *
 * Usage:
 *   1. On main: `npm run snapshot:catalog` → saves baseline
 *   2. Switch branch
 *   3. `npm run snapshot:catalog` → saves your branch's screenshots
 *   4. Diff `.design-snapshots/main/` vs `.design-snapshots/<branch>/`
 *      with any image diff tool
 *
 * This script intentionally fails gracefully if Playwright isn't
 * installed — the catalog itself is the primary verification surface.
 */

import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let chromium;
try {
  ({ chromium } = await import("@playwright/test"));
} catch {
  console.error("[snapshot] Playwright is not installed.");
  console.error("    npm install --save-dev @playwright/test && npx playwright install chromium");
  console.error("");
  console.error("    The catalog itself (npm run dev:catalog) is the primary");
  console.error("    verification surface; snapshots are agent-friendly polish.");
  process.exit(2);
}

const THEMES = ["green", "amber", "cyan", "red"];
const VIEWS = [
  { section: "tokens", id: "inspector", label: "01-tokens-inspector" },
  { section: "primitives", id: "btn", label: "02-primitives-btn" },
  { section: "primitives", id: "card", label: "03-primitives-card" },
  { section: "primitives", id: "type", label: "04-primitives-type" },
  { section: "primitives", id: "dot", label: "05-primitives-dot" },
  { section: "primitives", id: "wordmark", label: "06-primitives-wordmark" },
  { section: "primitives", id: "progress", label: "07-primitives-progress" },
  { section: "behaviors", id: "scramble-mount", label: "08-behaviors-scramble-mount" },
  { section: "behaviors", id: "scramble-hover", label: "09-behaviors-scramble-hover" },
  { section: "behaviors", id: "pulse", label: "10-behaviors-pulse" },
  { section: "behaviors", id: "fadein", label: "11-behaviors-fadein" },
  { section: "behaviors", id: "scanline", label: "12-behaviors-scanline" },
];

async function getBranch() {
  return new Promise((resolve) => {
    const p = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => resolve(out.trim().replace(/[/\\]/g, "-") || "detached"));
    p.on("error", () => resolve("detached"));
  });
}

const branch = await getBranch();
const outDir = path.join(ROOT, ".design-snapshots", branch);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// Boot Vite catalog dev server
console.log("[snapshot] starting dev:catalog server...");
const vite = spawn("npm", ["run", "dev:catalog"], { cwd: ROOT, shell: true });
let viteReady = false;
vite.stdout.on("data", (d) => {
  const s = d.toString();
  if (s.includes("Local:") || s.includes("localhost:1420")) viteReady = true;
});

// Wait for server (up to 30s)
const start = Date.now();
while (!viteReady && Date.now() - start < 30000) {
  await new Promise((r) => setTimeout(r, 500));
}
if (!viteReady) {
  console.error("[snapshot] Vite did not boot in 30s");
  vite.kill();
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 1500)); // settle

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

for (const theme of THEMES) {
  for (const view of VIEWS) {
    const url = `http://localhost:1420/index-catalog.html?theme=${theme}`;
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    // Navigate to the view by clicking its sidebar entry — for now just dump landing
    await new Promise((r) => setTimeout(r, 400));
    const file = path.join(outDir, `${theme}-${view.label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`[snapshot] wrote ${path.relative(ROOT, file)}`);
  }
}

await browser.close();
vite.kill();
console.log(`\n[snapshot] done — ${outDir}`);
