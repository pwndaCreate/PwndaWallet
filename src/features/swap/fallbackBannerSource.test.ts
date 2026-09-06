import { describe, it, expect } from "vitest";
import { fallbackBannerSource } from "./SwapForm";
import {
  ROUTER_PREFERENCE_OPTIONS,
  type RouterPreference,
} from "./router-modes";

/**
 * Regression guard for a bug that has now shipped TWICE.
 *
 * The no-quote fallback banner maps the user's router preference onto the
 * upstream it describes. A missing arm silently falls through to "intents",
 * so the user sitting on (say) the P2P tab is told "Routing through NEAR
 * Intents" — naming an upstream that, for XMR/ZEPH, cannot do the trade at
 * all. It happened for `pwnda-desk` (fixed 2026-07-19) and again for
 * `basicswap` (found by the P4 Playwright pass, 2026-08-19).
 *
 * These tests are driven off ROUTER_PREFERENCE_OPTIONS rather than a
 * hand-written list, so ADDING A ROUTER WITHOUT MAPPING IT FAILS HERE — which
 * is the only way to stop this recurring a third time.
 */
describe("fallbackBannerSource", () => {
  it("maps every non-auto preference to its OWN upstream, never a different one", () => {
    const wrong: string[] = [];
    for (const opt of ROUTER_PREFERENCE_OPTIONS) {
      const pref = opt.value as RouterPreference;
      if (pref === "auto") continue; // auto legitimately defaults to intents
      const got = fallbackBannerSource(pref);
      if (got !== pref) {
        wrong.push(`${pref} -> ${got}`);
      }
    }
    expect(
      wrong,
      `these preferences fall through to a DIFFERENT upstream, so the banner ` +
        `would name a route that will not handle the swap: ${wrong.join(", ")}`
    ).toEqual([]);
  });

  it("keeps auto on intents (the default upstream with no resolved quote)", () => {
    expect(fallbackBannerSource("auto")).toBe("intents");
  });

  it("maps basicswap to itself — the P2P route", () => {
    // Pinned explicitly: this is the arm the P4 pass found missing.
    expect(fallbackBannerSource("basicswap")).toBe("basicswap");
  });

  it("maps pwnda-desk to itself — the arm the 2026-07-19 fix added", () => {
    expect(fallbackBannerSource("pwnda-desk")).toBe("pwnda-desk");
  });
});
