/**
 * The update notice must reach BOTH layouts.
 *
 * ## The failure this pins
 *
 * Before 2026-09-06 the app had a working updater that nothing ever asked:
 * `checkForUpdate()` had exactly one caller in the entire codebase — a button
 * in the PORTRAIT Settings card. A landscape user could not reach it at all,
 * and a portrait user who never opened that card was never told an update
 * existed. The app shipped an update mechanism and no update path.
 *
 * That is the same shape as the BasicSwap taker UI incident recorded in
 * `landscapeRouterParity.test.ts`: a feature built against one shell, with the
 * other shell looking wired up. This file is the equivalent guard for the
 * update banner, and it deliberately asserts on the MOUNT rather than on the
 * import — an import that nothing renders is exactly how "the tab exists" came
 * to be mistaken for "the feature works".
 *
 * Source-level assertions because this repo's vitest environment is `node`:
 * there is no DOM, so rendering the component is not an option here. The
 * rendered behaviour is covered by the Playwright pass (both layouts, the
 * View action, and per-version dismissal) — see `screenshots/update-banner-*`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const PORTRAIT_SHELL = "src/ViewRouter.tsx";
const LANDSCAPE_SHELL = "src/features/landscape/LandscapeShell.tsx";
const COMPONENT = "src/components/UpdateBanner.tsx";

describe("update banner parity", () => {
  it("is mounted — not merely imported — by both shells", () => {
    for (const shell of [PORTRAIT_SHELL, LANDSCAPE_SHELL]) {
      const src = read(shell);
      expect(
        /<UpdateBanner\b/.test(src),
        `${shell} does not RENDER <UpdateBanner>. An update notice that only ` +
          `one layout mounts means the other layout's users are never told an ` +
          `update exists — the exact defect this guard exists for.`
      ).toBe(true);
    }
  });

  it("both shells import the one shared component, not a per-layout fork", () => {
    const portrait = read(PORTRAIT_SHELL);
    const landscape = read(LANDSCAPE_SHELL);
    expect(portrait).toMatch(/import \{ UpdateBanner \} from "\.\/components\/UpdateBanner"/);
    expect(landscape).toMatch(
      /import \{ UpdateBanner \} from "\.\.\/\.\.\/components\/UpdateBanner"/
    );
  });

  it("gives each shell a way to reach the install UI", () => {
    // The banner only NOTIFIES; the download/install button lives in Settings,
    // which is also the only place that can tell a .deb/.rpm user their install
    // cannot self-update. A banner whose action went nowhere would be the
    // "tab exists but leads to an empty screen" bug in miniature.
    expect(read(PORTRAIT_SHELL)).toMatch(
      /<UpdateBanner onOpenSettings=\{\(\) => setView\("settings"\)\}/
    );
    expect(read(LANDSCAPE_SHELL)).toMatch(
      /<UpdateBanner onOpenSettings=\{\(\) => setTab\("settings"\)\}/
    );
  });

  it("checks once per launch, not once per mount", () => {
    // Toggling the layout unmounts one shell and mounts the other. Without a
    // module-level memo that would re-poll the release endpoint on every
    // layout flip.
    const src = read(COMPONENT);
    expect(src).toMatch(/let checkOnce: Promise<UpdateInfo \| null> \| null = null/);
    expect(src).toMatch(/if \(!checkOnce\) checkOnce = checkForUpdate\(\)/);
  });

  it("remembers dismissal per version, so a new version can still be announced", () => {
    // A banner that stays dismissed forever is indistinguishable from no
    // banner. The stored value must be the VERSION, and the comparison must be
    // against the version just found.
    const src = read(COMPONENT);
    expect(src).toMatch(/localStorage\.setItem\(DISMISS_KEY, info\.version\)/);
    expect(src).toMatch(/readDismissed\(\) === found\.version/);
  });

  it("cannot fire in a shipped build via the sandbox override", () => {
    // VITE_MOCK_UPDATE exists so the browser sandbox can render the banner at
    // all. It must stay behind `import.meta.env.DEV`, which Vite folds to a
    // literal `false` in `vite build` so the branch is eliminated. Without that
    // guard an env var could fake an update in a real wallet.
    const src = read("src/lib/updater.ts");
    expect(src).toMatch(/import\.meta\.env\.DEV && import\.meta\.env\.VITE_MOCK_UPDATE/);
  });
});
