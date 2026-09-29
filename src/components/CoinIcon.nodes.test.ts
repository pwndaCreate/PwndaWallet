/**
 * `CoinIcon` draws its ring and pixel glyph as one SVG path each, not one
 * `<rect>` per lit cell (RAM plan Phase 2.3, 2026-09-22).
 *
 * ## The regression this pins
 *
 * A coin mark used to be 41-82 SVG nodes. The dashboard mounts a mark per chain
 * in several lists at once, and `mem-frontend` traces showed it sitting at a
 * median 1,887 SVG nodes with samples up to 14,083 (roughly 195 icons) - about
 * 90% of the whole page's DOM. Collapsing to a path is only safe if the path
 * lights EXACTLY the cells the grids say, so this test does both jobs: it
 * bounds the node count, and it re-derives every lit cell from the rendered
 * path and compares it with the source grid, for the ring and for every pixel
 * glyph the table ships.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoinIcon, coinGlyphTable } from "./CoinIcon";

/** Lit cells of a rendered `M x yh1.02v1.02h-1.02z` path, as "x,y" strings. */
function cellsOf(d: string): string[] {
  return [...d.matchAll(/M(\d+) (\d+)h1\.02v1\.02h-1\.02z/g)].map((m) => `${m[1]},${m[2]}`);
}

/** Lit cells of a `#`/`.` grid, `offset` cells in from the origin. */
function gridCells(rows: readonly string[], offset: number): string[] {
  const out: string[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === "#") out.push(`${x + offset},${y + offset}`);
    });
  });
  return out;
}

const RING = [
  "....####....",
  "..##....##..",
  ".##......##.",
  "##........##",
  "#..........#",
  "#..........#",
  "#..........#",
  "#..........#",
  "##........##",
  ".##......##.",
  "..##....##..",
  "....####....",
];

const markup = (sym: string) => renderToStaticMarkup(createElement(CoinIcon, { sym }));
/** Every element tag in the markup, svg included. */
const nodeCount = (html: string) => (html.match(/<[a-zA-Z]/g) ?? []).length;

describe("CoinIcon collapses its pixel grids to paths", () => {
  it("draws no per-cell rects", () => {
    for (const sym of ["BTC", "XMR", "ZANO", "XEL", "NOPE"]) {
      expect(markup(sym), sym).not.toContain("<rect");
    }
  });

  it("stays within a small, fixed node budget for every coin in the table", () => {
    // svg + ring path + (inner path | text) + optional badge (mask, rect,
    // circle, g, circle, text). 12 is generous; the old bound was 41-82.
    for (const sym of Object.keys(coinGlyphTable())) {
      expect(nodeCount(markup(sym)), sym).toBeLessThanOrEqual(12);
    }
    expect(nodeCount(markup("UNKNOWN"))).toBeLessThanOrEqual(12);
  });

  it("lights exactly the ring cells the ring grid says", () => {
    const html = markup("BTC");
    const ring = /<path d="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(cellsOf(ring).sort()).toEqual(gridCells(RING, 0).sort());
    expect(cellsOf(ring)).toHaveLength(40);
  });

  it("lights exactly the glyph cells each pixel glyph's grid says", () => {
    let checked = 0;
    for (const [sym, glyph] of Object.entries(coinGlyphTable())) {
      if (glyph.kind !== "p") continue;
      const paths = [...markup(sym).matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
      // First path is the ring; the second is the glyph.
      expect(paths, sym).toHaveLength(2);
      expect(cellsOf(paths[1]).sort(), sym).toEqual(gridCells(glyph.g, 2).sort());
      checked++;
    }
    expect(checked, "no pixel glyphs found - the table shape changed").toBeGreaterThan(0);
  });

  it("keeps the ring's colour and the glyph's colour separate", () => {
    const html = renderToStaticMarkup(
      createElement(CoinIcon, { sym: "ZEPH", color: "#123456", dim: "#abcdef" }),
    );
    const fills = [...html.matchAll(/<path d="[^"]+" fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills[0]).toBe("#abcdef");
    expect(fills[1]).toBe("#123456");
  });
});
