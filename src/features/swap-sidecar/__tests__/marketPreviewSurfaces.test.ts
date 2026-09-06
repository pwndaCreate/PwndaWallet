/**
 * The market preview must reach every surface it was built for.
 *
 * # Why this file exists at all
 *
 * the contributor guide's Landscape-First rule was written because BasicSwap's taker UI
 * shipped portrait-only for weeks while landscape's router strip advertised
 * the tab — the tab existed, so it looked wired, and selecting it led to an
 * empty screen. `landscapeRouterParity.test.ts` then caught router-LIST drift
 * but could not catch "the tab leads nowhere", because nothing tested for a
 * screen's CONTENT. That recurred once more on 2026-08-22 with a shared
 * component, one day after being recorded as feedback.
 *
 * This block is exactly the shape that keeps failing: one component, four
 * surfaces (Swap portrait, Swap landscape, EARN landscape, portrait CONVERT),
 * mounted through two shared parents. So the mounts are asserted, not assumed.
 *
 * It reads source rather than rendering, and is honest about the limit: it
 * proves the component is mounted on each path, not that it paints. That is
 * the specific failure this rule exists for — a surface that never mounts the
 * block at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");

const SWAP_VIEW = src("../../swap/SwapView.tsx");
const SWAP_LANDSCAPE = src("../../swap/SwapLandscapeView.tsx");
const EARN_BODY = src("../../swap/EarnConvertBody.tsx");
const PREVIEW = src("../MarketPreview.tsx");

/**
 * Prose assertions read the source with whitespace collapsed.
 *
 * JSX text is wrapped by the formatter, so a sentence in the rendered UI can
 * be split mid-phrase in the file — the first cut of this suite went red on
 * "we could not ask" purely because Prettier broke the line after "could".
 * Collapsing whitespace asserts the copy that ships rather than the column
 * the formatter chose, which is the property actually worth guarding.
 */
const PREVIEW_TEXT = PREVIEW.replace(/\s+/g, " ");

describe("MarketPreview reaches every P2P surface", () => {
  /**
   * `BasicswapStrip` is defined in SwapView and imported by
   * SwapLandscapeView, so one mount inside it covers both layouts. That
   * sharing is the invariant worth pinning: if someone forks the strip, this
   * goes red rather than landscape silently losing the block.
   */
  it("is mounted inside the shared BasicswapStrip", () => {
    expect(SWAP_VIEW).toContain("<MarketPreview");
    const at = SWAP_VIEW.indexOf("export function BasicswapStrip");
    const mountAt = SWAP_VIEW.indexOf("<MarketPreview", at);
    expect(at, "BasicswapStrip must exist").toBeGreaterThan(-1);
    expect(
      mountAt,
      "the preview must be mounted INSIDE BasicswapStrip, which is the block " +
        "both layouts render — mounting it in SwapView's own body would give " +
        "portrait the feature and leave landscape without it",
    ).toBeGreaterThan(at);
  });

  it("landscape gets it by importing that same strip, not a fork", () => {
    expect(
      /import\s*\{[^}]*BasicswapStrip[^}]*\}\s*from\s*"\.\/SwapView"/s.test(
        SWAP_LANDSCAPE,
      ),
      "SwapLandscapeView must import BasicswapStrip from SwapView — a local " +
        "copy is how landscape drifts",
    ).toBe(true);
    expect(
      SWAP_LANDSCAPE.includes("function BasicswapStrip"),
      "landscape must not define its own BasicswapStrip",
    ).toBe(false);
  });

  /**
   * EARN's first hop routes through the P2P DEX, so the market is a
   * precondition of the pipeline the tab is selling.
   */
  it("is mounted in EarnConvertBody, which serves both EARN and portrait CONVERT", () => {
    expect(EARN_BODY).toContain("<MarketPreview");
    expect(
      EARN_BODY.includes('variant: "landscape" | "portrait"'),
      "EarnConvertBody must still be the one body for both variants",
    ).toBe(true);
  });

  it("is exported from the swap-sidecar barrel, so cross-feature imports stay legal", () => {
    expect(src("../index.ts")).toContain(
      'export { MarketPreview } from "./MarketPreview";',
    );
  });
});

describe("MarketPreview cannot quietly become a trading surface", () => {
  /**
   * The data cannot see revocations and is minutes old. Everything below is a
   * property of the component that keeps it a PREVIEW — each is cheap to break
   * accidentally while "improving" the block.
   */
  it("names its source on screen", () => {
    expect(PREVIEW).toContain("MARKETS_SNAPSHOT_HOST");
    expect(PREVIEW).toContain("network preview");
  });

  it("warns that offers may already be taken", () => {
    expect(PREVIEW_TEXT.toLowerCase()).toContain("may already be taken");
  });

  it("distinguishes 'could not read' from 'no offers'", () => {
    // The two states are identical in the data. If they ever render the same
    // string, the surface starts arguing against opting in on evidence it
    // does not have.
    expect(PREVIEW).toContain("Preview unavailable");
    expect(PREVIEW).toContain("No live offers");
    expect(
      PREVIEW_TEXT.includes("we could not ask"),
      "the unavailable branch must say the network was not measured",
    ).toBe(true);
  });

  it("offers no action that could move funds", () => {
    for (const forbidden of ["onReview", "submitSidecarBid", "onConfirm", "beginHop"]) {
      expect(
        PREVIEW.includes(forbidden),
        `MarketPreview must not reference ${forbidden} — it reports, it does not transact`,
      ).toBe(false);
    }
  });

  it("is gated so nothing is fetched until a P2P surface is open", () => {
    expect(PREVIEW).toContain("if (!enabled) return null;");
    expect(PREVIEW).toContain("useMarketsSnapshot({ enabled })");
  });
});
