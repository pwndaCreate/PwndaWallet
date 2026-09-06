/**
 * Every coin colour must be readable on the wallet's dark surfaces.
 *
 * ZANO shipped 2026-08-27 with `color: "#0e0e10"` — its wordmark black, copied
 * verbatim from the brand. On a `#0a0a0a` background that is invisible: the
 * mining picker rendered a row with no coin name, just the algorithm beneath
 * it, and the operator reported "zano is a black text and I cant see it".
 *
 * The colours in `coin-metadata.ts` are not brand reproductions — they are
 * chosen to READ against this UI. That is a property worth enforcing, because
 * the natural thing to do when adding a coin is to paste its official hex, and
 * for any coin with a dark brand that produces an invisible asset with no type
 * error and no failing test.
 */
import { describe, it, expect } from "vitest";
import { COIN_METADATA } from "./coin-metadata";
import { getAdapter } from "./index";
import type { ChainType } from "./types";

/** The darkest surface a coin colour is drawn on (`--bg`). */
const BG = { r: 0x0a, g: 0x0a, b: 0x0a };

function parse(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

/** WCAG relative luminance. */
function lum(c: { r: number; g: number; b: number }): number {
  const f = (x: number) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrast(hex: string): number | null {
  const c = parse(hex);
  if (!c) return null;
  const a = lum(c);
  const b = lum(BG);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("coin colours are visible on the dark UI", () => {
  /**
   * 3.0:1 is WCAG's large-text / non-text threshold. These are used for coin
   * names, icon tints and 2px active borders — all large or graphical — so
   * 3.0 is the right bar rather than the 4.5 body-text one. ZANO's old
   * #0e0e10 scored about 1.03, i.e. indistinguishable from the background.
   */
  const MIN_CONTRAST = 3.0;

  for (const [chain, meta] of Object.entries(COIN_METADATA)) {
    it(`${chain} (${meta.ticker}) reads against the background`, () => {
      const ratio = contrast(meta.color);
      expect(ratio, `${meta.color} is not a 6-digit hex`).not.toBeNull();
      expect(
        ratio!,
        `${chain} uses ${meta.color}, contrast ${ratio!.toFixed(2)}:1 against ` +
          `#0a0a0a — below ${MIN_CONTRAST}:1, so it renders as an invisible ` +
          `smudge. Pick a lighter variant of the brand colour; this table is ` +
          `for readability, not brand reproduction.`,
      ).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  }
});

/**
 * The UI reads the ADAPTER's colour, not this table's.
 *
 * `WalletLandscapeView` renders `getAdapter(chain).color`; so does the
 * portrait `DashboardView`. `COIN_METADATA.color` feeds the mining picker and
 * anything that must not import wallet adapters (see BOUNDARIES.md).
 *
 * That means the 2026-08-28 contrast sweep fixed the copy the asset rail does
 * NOT read. Eight adapters kept their literal brand hex — algorand `#000000`,
 * zano `#0e0e10` (the exact value the sweep was written about), stellar
 * `#0a0e3f`, xrp `#23292f`, conflux `#1a1a2e`, plus cardano/ravencoin/usdt-tron
 * — and the test above passed the whole time, because it was checking a
 * different table. The defect only became visible once coins were coloured at
 * rest (2026-09-02): before that the rail drew every unselected coin white, so
 * an unreadable adapter colour was invisible in both senses.
 *
 * Two tables holding the same fact will drift; the fix is to assert they
 * cannot. This is the same "same contract in two forms — keep them in sync"
 * pattern the dev-fee wallet registry and BOUNDARIES.md already use.
 */
describe("adapter colours match COIN_METADATA and are readable", () => {
  const MIN_CONTRAST = 3.0;

  for (const chain of Object.keys(COIN_METADATA) as ChainType[]) {
    const meta = COIN_METADATA[chain];

    it(`${chain} (${meta.ticker}) — adapter agrees with the table`, () => {
      const adapter = getAdapter(chain);
      expect(
        adapter.color.toLowerCase(),
        `getAdapter("${chain}").color is ${adapter.color} but COIN_METADATA ` +
          `says ${meta.color}. The asset rail reads the ADAPTER, so a colour ` +
          `corrected only in the table never reaches the UI. Update both.`,
      ).toBe(meta.color.toLowerCase());
    });

    it(`${chain} (${meta.ticker}) — adapter colour reads on the dark UI`, () => {
      const ratio = contrast(getAdapter(chain).color);
      expect(ratio, `${getAdapter(chain).color} is not a 6-digit hex`).not.toBeNull();
      expect(
        ratio!,
        `getAdapter("${chain}").color renders at ${ratio!.toFixed(2)}:1 against ` +
          `#0a0a0a — below ${MIN_CONTRAST}:1. Coins are coloured at REST now, so ` +
          `this is what the user actually sees in the asset list.`,
      ).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  }
});
