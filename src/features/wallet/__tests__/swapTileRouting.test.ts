/**
 * Every asset's SWAP tile must go somewhere.
 *
 * Reported 2026-08-29: "for all assets the swap button doesn't do anything
 * anymore ... Zephyr is the only asset that still has a functional swap
 * button, and it's still has the old swap ui".
 *
 * Both wallet views gated the tile on `activeChain !== "zephyr"`, so on BTC,
 * ETH, SOL and every other coin it rendered a permanently disabled control —
 * and Zephyr's opened the legacy ecosystem modal instead of the Swap tab.
 *
 * This reads source rather than rendering, and is honest about the limit: it
 * proves the gate is gone and a handler is wired on both surfaces, not that
 * the click navigates. The failure it exists to catch is a tile that cannot do
 * anything at all — which is what shipped.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), "utf8");

/**
 * Source with comments stripped.
 *
 * The first cut of this suite went red on both files — because the removed
 * gate is QUOTED in the comment that explains its removal. A source-reading
 * test that cannot tell code from prose about the code will fail every time
 * someone documents a fix, which teaches the next person that the suite is
 * noise. Assert against what actually executes.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const LANDSCAPE = read("../WalletLandscapeView.tsx");
const PORTRAIT = read("../DashboardView.tsx");
const APP = read("../../../App.tsx");

describe("the SWAP tile is not Zephyr-only", () => {
  for (const [name, src] of [
    ["landscape", LANDSCAPE],
    ["portrait", PORTRAIT],
  ] as const) {
    it(`${name} no longer disables the tile for non-Zephyr chains`, () => {
      expect(code(src)).not.toContain('disabled={activeChain !== "zephyr"}');
    });

    it(`${name} wires the tile to the swap opener`, () => {
      expect(code(src)).toContain("onOpenSwapForAsset");
    });
  }
});

describe("the opener seeds the Swap tab rather than a modal", () => {
  const at = APP.indexOf("const openSwapForAsset = useCallback(");
  const body = APP.slice(at, at + 1200);

  it("exists in App and navigates to the swap surface", () => {
    expect(at).toBeGreaterThan(-1);
    expect(body).toContain('setView("swap")');
    expect(body).toContain('setLandscapeTab("swap")');
  });

  it("pre-selects the asset on the AUTO route", () => {
    expect(body).toContain("from: ticker.toUpperCase()");
    // A button labelled only "Swap" must not pin a venue on the user's
    // behalf — AUTO lets the aggregator choose.
    expect(body).toContain('router: "auto"');
  });

  it("reuses the existing seed channel instead of a second one", () => {
    // EARN already pre-fills the form through `convertSeed`. Two channels
    // would mean two places to fix when pre-filling breaks.
    expect(body).toContain("setConvertSeed(");
  });
});

describe("a seed only overwrites the side it names", () => {
  for (const [name, rel] of [
    ["portrait", "../../swap/SwapView.tsx"],
    ["landscape", "../../swap/SwapLandscapeView.tsx"],
  ] as const) {
    it(`${name} does not blank the destination`, () => {
      // The asset tile seeds FROM only. Applying `to: ""` unconditionally
      // would hand back an incomplete form instead of a ready one.
      expect(read(rel)).toContain("if (convertSeed.to) setToCoin(convertSeed.to);");
    });
  }
});
