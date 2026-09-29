/**
 * Pins `devPerfTrackGuard` — the dev-only fix for React 19.2's development
 * render log retaining a props diff per component render (13 GB of renderer
 * memory over a mining night, 2026-09-27). See the module's header.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDevPerfTrackGuard, isReactDevtoolsMeasure, reactPerfTracksWanted } from "./devPerfTrackGuard";

/** A stand-in Performance object that records what reaches the timeline. */
function fakePerformance() {
  const recorded: { name: string; options: unknown }[] = [];
  const perf = {
    measure(name: string, options?: unknown) {
      recorded.push({ name, options });
      return { name } as unknown as PerformanceMeasure;
    },
  } as unknown as Performance;
  return { perf, recorded };
}

// The exact shape React 19.2.4's `logComponentRender` passes
// (react-dom-client.development.js, `reusableComponentOptions`).
const reactOptions = {
  start: 1,
  end: 2,
  detail: {
    devtools: {
      color: "primary",
      track: "Components ⚛",
      tooltipText: "MineSimpleView",
      properties: [["Changed Props", ""], ["–  hashrateSamples", "Array"]],
    },
  },
};

describe("isReactDevtoolsMeasure", () => {
  it("recognises React's DevTools track payload", () => {
    expect(isReactDevtoolsMeasure(reactOptions)).toBe(true);
  });
  it("leaves every other measure alone", () => {
    expect(isReactDevtoolsMeasure(undefined)).toBe(false);
    expect(isReactDevtoolsMeasure("mark-a")).toBe(false);
    expect(isReactDevtoolsMeasure({ start: 1, end: 2 })).toBe(false);
    expect(isReactDevtoolsMeasure({ detail: { mine: 1 } })).toBe(false);
    expect(isReactDevtoolsMeasure({ detail: { devtools: "nope" } })).toBe(false);
  });
});

describe("installDevPerfTrackGuard", () => {
  it("drops React's render measures and passes everything else through", () => {
    const { perf, recorded } = fakePerformance();
    const uninstall = installDevPerfTrackGuard(perf);
    expect(perf.measure("​MineSimpleView", reactOptions as PerformanceMeasureOptions)).toBeUndefined();
    perf.measure("app-own", { start: 1, end: 3 });
    expect(recorded.map((r) => r.name)).toEqual(["app-own"]);
    uninstall();
    perf.measure("​MineSimpleView", reactOptions as PerformanceMeasureOptions);
    expect(recorded.map((r) => r.name)).toEqual(["app-own", "​MineSimpleView"]);
  });

  it("installs once — a second install neither double-wraps nor breaks uninstall", () => {
    const { perf, recorded } = fakePerformance();
    const uninstall = installDevPerfTrackGuard(perf);
    const again = installDevPerfTrackGuard(perf);
    again();
    perf.measure("​Panel", reactOptions as PerformanceMeasureOptions);
    expect(recorded).toHaveLength(0);
    uninstall();
  });

  it("is a no-op without a Performance object", () => {
    expect(() => installDevPerfTrackGuard(undefined)()).not.toThrow();
  });
});

describe("reactPerfTracksWanted", () => {
  it("reads the opt-out flag and survives a storage that throws", () => {
    expect(reactPerfTracksWanted({ getItem: () => "1" })).toBe(true);
    expect(reactPerfTracksWanted({ getItem: () => null })).toBe(false);
    expect(reactPerfTracksWanted({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });
});

describe("wiring", () => {
  // Both entry points must install it before the first render, dev-only.
  it("is installed by the full wallet and by PwndaLite, gated on import.meta.env.DEV", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const entry of [path.join(here, "..", "main.tsx"), path.join(here, "..", "..", "src-lite", "main.tsx")]) {
      const src = readFileSync(entry, "utf8");
      const install = src.indexOf("installDevPerfTrackGuard();");
      const render = src.indexOf(".render(");
      expect(install, entry).toBeGreaterThan(-1);
      expect(install, `${entry}: installs before React renders`).toBeLessThan(render);
      expect(src.slice(Math.max(0, install - 120), install)).toContain("import.meta.env.DEV");
    }
  });
});
