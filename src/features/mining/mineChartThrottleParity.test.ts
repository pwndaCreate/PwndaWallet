/**
 * Both Mine layouts route the live hashrate chart through the repaint throttle
 * (RAM plan Phase 2M.2, 2026-09-23).
 *
 * ## The failure this pins
 *
 * Round 9 (2026-06-01) found the mining renderer leak tracked chart repaints and
 * throttled the chart's data reference to one update per 12 s. The throttle was
 * a private helper inside `MiningView.tsx` - the PORTRAIT view. `MineLandscapeView`
 * (the primary surface) kept `data={hashrateSamples}` and repainted the chart
 * every 2 s for as long as it was on screen. Nothing failed: the chart drew, the
 * numbers were right, and the fix "existed". It is the same shape as the
 * BasicSwap taker UI that was built portrait-only and left landscape looking
 * wired up (CLAUDE.md, "Landscape-First Development").
 *
 * So this reads the two views' actual source and checks the wiring - that both
 * import the one shared throttle and that neither hands the raw sample array to
 * a `<HashrateAreaChart>` - rather than checking that a tab exists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (f: string) => readFileSync(resolve(__dirname, f), "utf8");
const views = {
  "MiningView.tsx (portrait)": read("MiningView.tsx"),
  "MineLandscapeView.tsx (landscape)": read("MineLandscapeView.tsx"),
} as const;

/** Every `<HashrateAreaChart ... />` opening tag, up to its closing `/>`. */
function chartTags(src: string): string[] {
  return [...src.matchAll(/<HashrateAreaChart\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

describe.each(Object.entries(views))("%s", (_name, src) => {
  it("imports the shared throttle instead of defining or skipping one", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\buseThrottledRef\b[^}]*\}\s*from\s*"\.\/useThrottledRef"/,
    );
    expect(src, "a local copy would let the two layouts drift again").not.toMatch(
      /function useThrottledRef\s*</,
    );
  });

  it("uses the shared throttle interval, not a private number", () => {
    expect(src).toMatch(/CHART_REPAINT_THROTTLE_MS/);
    expect(src).not.toMatch(/const CHART_REPAINT_THROTTLE_MS/);
  });

  it("never gives a chart the raw, every-2-seconds sample array", () => {
    const tags = chartTags(src);
    expect(tags.length, "no <HashrateAreaChart> found - did the view change shape?").toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).not.toMatch(/data=\{\s*hashrateSamples\s*\}/);
    }
  });
});

describe("the shared throttle", () => {
  const shared = read("useThrottledRef.ts");

  it("is exported once, with the interval the Round 9 measurement chose", () => {
    expect(shared).toMatch(/export function useThrottledRef</);
    expect(shared).toMatch(/export const CHART_REPAINT_THROTTLE_MS = 12_000;/);
  });

  it("keeps the trailing flush, so the latest sample is never dropped", () => {
    expect(shared).toMatch(/window\.setTimeout/);
    expect(shared).toMatch(/window\.clearTimeout/);
  });
});
