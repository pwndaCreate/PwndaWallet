/**
 * Onboarding routing lock — portrait/landscape parity.
 *
 * Regression guard for the 2026-08-12 "wallets don't persist" bug.
 *
 * The onboarding views (home / login / import / derivation-picker / backup /
 * setPassword) used to live only inside `ViewRouter`, the PORTRAIT router,
 * while `App.tsx` short-circuited to `LandscapeRoot` as soon as
 * `walletsByChain` was non-empty. `handleImport`/`handleCreate` populate that
 * map BEFORE routing to the password step, so in landscape — the default
 * layout since 2026-06-20 — the app jumped straight to the dashboard, the
 * password screen never rendered, `handleSetPassword` never ran, and
 * `saveVault` was never called. The wallet lived in memory until the process
 * exited, silently, because nothing threw.
 *
 * The fix was structural: one `AuthRouter`, rendered by `App.tsx` AHEAD of the
 * layout branch, owned by neither root. These tests lock that shape so the
 * flow can't be pulled back inside a layout branch and swallowed again.
 *
 * Text-based, in the same spirit as `src/wallets/derivation-paths.test.ts` —
 * the alternative is mounting the whole app against a Tauri runtime.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_VIEWS } from "./features/auth/AuthRouter";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const APP = read("src/App.tsx");
const VIEW_TYPES = read("src/types/view.ts");
const VIEW_ROUTER = read("src/ViewRouter.tsx");
const LANDSCAPE_ROOT = read("src/features/landscape/LandscapeRoot.tsx");

/** Views the pre-wallet flow owns. Mirrors `AUTH_VIEWS` in AuthRouter.tsx. */
const ONBOARDING_VIEWS = [
  "home",
  "login",
  "import",
  "derivation-picker",
  "backup",
  "setPassword",
] as const;

describe("onboarding routing parity", () => {
  it("AUTH_VIEWS covers exactly the onboarding views", () => {
    expect([...AUTH_VIEWS].sort()).toEqual([...ONBOARDING_VIEWS].sort());
  });

  it("every onboarding view exists in the View union", () => {
    // A rename in types/view.ts that missed AuthRouter would silently disable
    // the branch for that view — Set.has() just returns false.
    for (const v of ONBOARDING_VIEWS) {
      expect(VIEW_TYPES, `"${v}" is not in the View union`).toContain(`| "${v}"`);
    }
  });

  it("App renders AuthRouter BEFORE the landscape branch", () => {
    const authIdx = APP.indexOf("AUTH_VIEWS.has(view)");
    const landscapeIdx = APP.indexOf('if (layout === "landscape"', authIdx);
    expect(authIdx, "App.tsx never checks AUTH_VIEWS").toBeGreaterThan(-1);
    expect(
      landscapeIdx,
      "the landscape branch must come AFTER the onboarding branch, or landscape " +
        "can swallow onboarding again"
    ).toBeGreaterThan(authIdx);
  });

  it("the landscape branch is gated only on layout + login, not onboarding", () => {
    // The fix is ORDERING, not a second condition. Anchor on the real branch —
    // `if (layout === "landscape")` also appears in setLandscapeTab calls
    // earlier in the file, so an unanchored search matches the wrong line.
    const idx = APP.indexOf('if (layout === "landscape" && isLoggedIn');
    expect(idx, "landscape layout branch not found").toBeGreaterThan(-1);
    const line = APP.slice(idx, APP.indexOf("\n", idx));
    // If a view-based guard reappears here, the AuthRouter hoist was undone
    // and the ordering invariant is no longer what's protecting onboarding.
    expect(line).not.toContain("VIEWS.has");
  });

  it("ViewRouter no longer renders any onboarding view", () => {
    // The whole point: ONE definition. A `view === "setPassword"` reappearing
    // in the portrait router means the two layouts have diverged again.
    for (const v of ONBOARDING_VIEWS) {
      expect(
        VIEW_ROUTER.includes(`view === "${v}"`),
        `ViewRouter renders "${v}" again — onboarding must stay in AuthRouter`
      ).toBe(false);
    }
  });

  it("LandscapeRoot does not render any onboarding view either", () => {
    for (const v of ONBOARDING_VIEWS) {
      expect(
        LANDSCAPE_ROOT.includes(`view === "${v}"`),
        `LandscapeRoot renders "${v}" — onboarding must stay in AuthRouter`
      ).toBe(false);
    }
  });
});
