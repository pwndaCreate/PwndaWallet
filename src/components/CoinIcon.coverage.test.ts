/**
 * Every coin the wallet can show draws a real glyph, not three letters.
 *
 * ## The failure this pins
 *
 * `CoinIcon` falls back to the first three letters of a ticker when its glyph
 * table has no entry. The fallback throws nothing, logs nothing and still draws
 * the tidy ring, so a missing icon looks like a design choice. Until 2026-09-15
 * seven chains the wallet ships drew it in the asset rail, the swap picker and
 * the mining picker: ZANO, BNB, SUI, MON, DASH, XLM and NEAR. The same fallback
 * hid a second gap: the swap form and its confirm modal hand the per-network
 * leg key (`USDC-ARB`) straight to `CoinIcon`, so every stablecoin leg drew
 * "USD" (found by reading SwapForm -> AmountCard -> CoinSelectButton).
 *
 * Nothing caught either, because nothing asked. `coin-metadata.contrast.test.ts`
 * guards every coin's COLOUR; this file is the same guard for its GLYPH. The
 * rosters are read from the live tables, not copied here, so a coin added to
 * `COIN_METADATA` or to the swap pickers without an icon fails this file.
 *
 * The glyphs themselves are rasterised from each project's own logo - see the
 * coin-glyph-rasterisation wiki page for the method and how to add one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COIN_METADATA } from "../wallets/coin-metadata";
import { STABLECOINS } from "../wallets/stablecoins";
import { getDropdownTickers } from "../features/swap/swap-data";
import { coinGlyphTable, resolveCoinGlyph } from "./CoinIcon";

/**
 * Tickers knowingly left on the letter fallback, each with the reason and the
 * tier that will draw it. Empty since 2026-09-15, when tier 1 drew the last
 * seven. Adding an entry is allowed; keeping a stale one is not - the last test
 * fails when an exempt ticker gains a glyph or leaves every roster, so this list
 * can only shrink back to empty, never quietly rot.
 */
const LETTER_FALLBACK_EXEMPT: Readonly<Record<string, string>> = {};

const isExempt = (t: string): boolean =>
  Object.prototype.hasOwnProperty.call(LETTER_FALLBACK_EXEMPT, t.toUpperCase());

/** The tickers in `tickers` that would draw three letters, sorted. */
function lettersOnly(tickers: Iterable<string>): string[] {
  return [...new Set(tickers)].filter((t) => !isExempt(t) && !resolveCoinGlyph(t)).sort();
}

const metadataTickers = Object.values(COIN_METADATA).map((m) => m.ticker);
const swapRoster = [
  ...new Set([...getDropdownTickers(), ...getDropdownTickers({ sourceOnly: true })]),
];
const stableSymbols = STABLECOINS.map((f) => f.symbol);

describe("CoinIcon draws a glyph for every coin the wallet shows", () => {
  it("renders through the lookup this file tests", () => {
    // Testing `resolveCoinGlyph` proves nothing if the component reads the
    // table some other way. This keeps the two the same lookup.
    const src = readFileSync(resolve(__dirname, "CoinIcon.tsx"), "utf8");
    expect(src).toMatch(/const glyph = resolveCoinGlyph\(sym\);/);
    expect(src).not.toMatch(/GLYPHS\[upper\]/);
  });

  it("every COIN_METADATA ticker", () => {
    expect(metadataTickers.length, "COIN_METADATA read as nearly empty").toBeGreaterThan(30);
    expect(
      lettersOnly(metadataTickers),
      "these tickers draw three letters - give them a glyph rasterised from the " +
        "project's logo, or an explicit exemption with a reason",
    ).toEqual([]);
  });

  it("every entry the swap pickers offer, per-network leg keys included", () => {
    expect(swapRoster.length, "swap roster read as nearly empty").toBeGreaterThan(20);
    // Control: without a leg key in the roster, the leg-key case is untested.
    expect(swapRoster).toContain("USDC-ARB");
    expect(lettersOnly(swapRoster)).toEqual([]);
  });

  it("every stablecoin family symbol", () => {
    expect(stableSymbols).toEqual(expect.arrayContaining(["USDC", "USDT", "USDT0"]));
    expect(lettersOnly(stableSymbols)).toEqual([]);
  });

  it("a leg key draws its symbol's mark, and an unknown ticker still falls back", () => {
    expect(resolveCoinGlyph("USDC-ARB")).toBe(resolveCoinGlyph("USDC"));
    expect(resolveCoinGlyph("usdt0-pol")).toBe(resolveCoinGlyph("USDT0"));
    expect(resolveCoinGlyph("USDT-TRON")).toBe(resolveCoinGlyph("USDT"));
    // Controls: the fallback must still be reachable, or every check above
    // would pass for a resolver that answers everything.
    expect(resolveCoinGlyph("NOPE")).toBeUndefined();
    expect(resolveCoinGlyph("NOPE-ARB")).toBeUndefined();
    expect(resolveCoinGlyph("")).toBeUndefined();
    expect(resolveCoinGlyph("constructor")).toBeUndefined();
  });

  it("the logo-rasterised marks are pixel glyphs, not letters", () => {
    for (const t of ["TRX", "XEL", "ZANO", "BNB", "SUI", "MON", "DASH", "XLM", "NEAR"]) {
      expect(resolveCoinGlyph(t)?.kind, `${t} should be an 8x8 pixel glyph`).toBe("p");
    }
  });

  it("every pixel glyph is exactly 8 rows of 8 '#'/'.'", () => {
    const pixel = Object.entries(coinGlyphTable()).filter(([, g]) => g.kind === "p");
    expect(pixel.length).toBeGreaterThan(20);
    const malformed = pixel
      .filter(([, g]) => g.kind === "p" && (g.g.length !== 8 || g.g.some((row) => !/^[#.]{8}$/.test(row))))
      .map(([t]) => t);
    expect(malformed).toEqual([]);
  });

  it("exemptions shrink, not rot", () => {
    const shown = new Set(
      [...metadataTickers, ...swapRoster, ...stableSymbols].map((t) => t.toUpperCase()),
    );
    for (const [t, why] of Object.entries(LETTER_FALLBACK_EXEMPT)) {
      expect(resolveCoinGlyph(t), `${t} is exempt (${why}) but now has a glyph - delete the exemption`).toBeUndefined();
      expect(shown.has(t.toUpperCase()), `${t} is exempt but no roster shows it - delete the exemption`).toBe(true);
    }
  });
});
