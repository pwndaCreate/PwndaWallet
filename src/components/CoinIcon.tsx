import { useId } from "react";
import type { CSSProperties, ReactElement } from "react";

const RING_12 = [
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

/**
 * A small corner badge, drawn over a masked-out notch in the bottom-right
 * of the ring. Mirrors how an ecosystem token is marked in its own project's
 * branding: one shared base mark for the family, one colored badge per asset
 * (Zephyr's ZSD/ZRS/ZYS are the case this exists for).
 */
type Badge = { c: string; t: string };

type Glyph =
  | { kind: "g"; t: string; w?: number; badge?: Badge }
  | { kind: "p"; g: string[]; badge?: Badge };

/**
 * The Zephyr wordmark as an 8x8 cell pattern: a "Z" crossed by a full-width
 * bar (Ƶ). Shared by ZEPH and all three ecosystem assets so the family reads
 * as one project at 22px, exactly as it does in Zephyr's own branding.
 */
const ZEPHYR_MARK = [
  "########",
  "......##",
  ".....##.",
  "########",
  "...##...",
  "..##....",
  ".##.....",
  "########",
];

/**
 * Badge fill per Zephyr ecosystem asset, taken from the project's own asset
 * marks: green dollar (stable), red R (reserve share), blue Y (yield share).
 * The BADGE carries the color; the Ƶ underneath stays on the caller's
 * `color`/`accent` so an asset row can still tint the mark.
 */
const ZPH_BADGE = {
  ZSD: "#22c05e",
  ZRS: "#ee4b2b",
  ZYS: "#2b9fe0",
} as const;

const GLYPHS: Record<string, Glyph> = {
  XMR: { kind: "g", t: "M", w: 700 },
  ETH: {
    kind: "p",
    g: [
      "...##...",
      "..####..",
      ".######.",
      "##.##.##",
      "##....##",
      ".######.",
      "..####..",
      "...##...",
    ],
  },
  BTC: { kind: "g", t: "₿", w: 700 },
  SOL: {
    kind: "p",
    g: [
      "........",
      ".######.",
      "######..",
      "........",
      "..######",
      ".######.",
      "######..",
      "........",
    ],
  },
  RVN: {
    kind: "p",
    g: [
      "........",
      "..####..",
      ".######.",
      "##.##.##",
      "########",
      ".#....#.",
      "..#..#..",
      "...##...",
    ],
  },
  CFX: { kind: "g", t: "C", w: 700 },
  AVAX: {
    kind: "p",
    g: [
      "...##...",
      "..####..",
      ".##..##.",
      "##....##",
      "########",
      "##.##.##",
      "##....##",
      "##....##",
    ],
  },
  USDT: { kind: "g", t: "₮", w: 700 },
  USDC: { kind: "g", t: "$", w: 700 },
  // USD₮0 is Tether's LayerZero OFT, not a separate issuer — same ₮ mark,
  // with the badge carrying the "0" so the two are never confused in a list
  // where a user may hold both.
  USDT0: { kind: "g", t: "₮", w: 700, badge: { c: "#1e9e78", t: "0" } },
  POL: {
    kind: "p",
    g: [
      "..####..",
      ".######.",
      "##.##.##",
      "##....##",
      "##....##",
      "##.##.##",
      ".######.",
      "..####..",
    ],
  },
  MATIC: {
    kind: "p",
    g: [
      "..####..",
      ".######.",
      "##.##.##",
      "##....##",
      "##....##",
      "##.##.##",
      ".######.",
      "..####..",
    ],
  },
  FLR: { kind: "g", t: "F", w: 700 },
  // Aptos: the brand mark is a stylised "A" in a rounded square.
  APT: { kind: "g", t: "A", w: 700 },
  XRP: {
    kind: "p",
    g: [
      "##....##",
      ".##..##.",
      "..####..",
      "...##...",
      "..####..",
      ".##..##.",
      "##....##",
      "##....##",
    ],
  },
  TRX: {
    kind: "p",
    g: [
      "########",
      "##....##",
      ".##..##.",
      "..####..",
      "...##...",
      "..####..",
      ".######.",
      "..####..",
    ],
  },
  ADA: {
    kind: "p",
    g: [
      "...##...",
      "..####..",
      "...##...",
      "##....##",
      "##....##",
      "...##...",
      "..####..",
      "...##...",
    ],
  },
  // ── Zephyr family ─────────────────────────────────────────────────────
  // All four assets share ONE base mark — the Zephyr "Ƶ" (a Z crossed by a
  // horizontal bar), matching the project's own branding, where every
  // ecosystem token is the same Ƶ disc differentiated only by a small
  // colored corner badge. Before this the four were unrelated glyphs (a
  // bare "Z", a "$", an up-triangle that read as a bell, and a "Y"), so
  // nothing tied ZSD/ZRS/ZYS back to Zephyr and the triangle in particular
  // was unidentifiable.
  //
  // The diagonal steps x=6 → 5 → (4, inside the crossbar) → 3 → 2 → 1, so
  // the stroke stays continuous through the bar rather than breaking at it.
  ZEPH: { kind: "p", g: ZEPHYR_MARK },
  ZSD: { kind: "p", g: ZEPHYR_MARK, badge: { c: ZPH_BADGE.ZSD, t: "$" } },
  ZRS: { kind: "p", g: ZEPHYR_MARK, badge: { c: ZPH_BADGE.ZRS, t: "R" } },
  ZYS: { kind: "p", g: ZEPHYR_MARK, badge: { c: ZPH_BADGE.ZYS, t: "Y" } },
  // Long-name aliases — `ZPH_UI_TICKER` in `wallets/zph-rpc.ts` shows the
  // ecosystem assets as ZEPHUSD / ZEPHRSV / ZEPHYRS in the wallet view, so
  // accept those spellings and render the identical mark + badge.
  ZEPHUSD: { kind: "p", g: ZEPHYR_MARK, badge: { c: ZPH_BADGE.ZSD, t: "$" } },
  ZEPHRSV: { kind: "p", g: ZEPHYR_MARK, badge: { c: ZPH_BADGE.ZRS, t: "R" } },
  ZEPHYRS: { kind: "p", g: ZEPHYR_MARK, badge: { c: ZPH_BADGE.ZYS, t: "Y" } },
  DOGE: { kind: "g", t: "Ð", w: 700 },
  HBAR: {
    kind: "p",
    g: [
      "##....##",
      "##....##",
      "##....##",
      "########",
      "########",
      "##....##",
      "##....##",
      "##....##",
    ],
  },
  ALGO: {
    kind: "p",
    g: [
      "...##...",
      "..####..",
      ".##.##..",
      "##..##..",
      "##.##...",
      "#####...",
      "##......",
      "##......",
    ],
  },
  LTC: { kind: "g", t: "Ł", w: 700 },
  BCH: { kind: "g", t: "₿", w: 600 },
  // Ergo's protocol identity is "Sigma" (the Σ-protocol family), and the
  // official logo uses a capital sigma. Renders cleanly in JetBrains Mono.
  ERG: { kind: "g", t: "Σ", w: 700 },
};

/**
 * Unified 12×12 ring-frame coin icon — one outer pixel ring with a
 * unique inner glyph per ticker. Replaces the older PixelCoin (16×16
 * with ad-hoc per-coin grids and a 3-letter text fallback) on the v2
 * dashboard, account card, and activity rows so every chain shares
 * the same visual silhouette.
 */
export function CoinIcon({
  sym,
  size = 22,
  color = "var(--white)",
  dim = "rgba(242,242,242,0.40)",
  glow = true,
  accent,
  style,
}: {
  sym: string;
  size?: number;
  color?: string;
  dim?: string;
  /**
   * Halo behind the mark. `true` uses a neutral white glow (the original
   * behaviour); `"accent"` glows in the icon's OWN colour, which is what the
   * assets rail uses to mark focus now that every coin is always coloured —
   * a colour change can no longer signal selection if colour is the resting
   * state, so the halo carries it instead.
   */
  glow?: boolean | "accent";
  accent?: string | null;
  style?: CSSProperties;
}) {
  const upper = (sym || "").toUpperCase();
  const glyph = GLYPHS[upper];
  const innerColor = accent ?? color;
  // Unique per instance: two icons for the same symbol would otherwise emit
  // duplicate mask ids into the document.
  const maskId = `coin-badge-${useId().replace(/:/g, "")}`;
  const badge = glyph?.badge;

  const ringRects: ReactElement[] = [];
  for (let y = 0; y < 12; y++) {
    const row = RING_12[y] || "";
    for (let x = 0; x < 12; x++) {
      if (row[x] === "#") {
        ringRects.push(
          <rect
            key={`r${x},${y}`}
            x={x}
            y={y}
            width={1.02}
            height={1.02}
            fill={dim}
          />
        );
      }
    }
  }

  const innerRects: ReactElement[] = [];
  if (glyph?.kind === "p") {
    for (let y = 0; y < 8; y++) {
      const row = glyph.g[y] || "";
      for (let x = 0; x < 8; x++) {
        if (row[x] === "#") {
          innerRects.push(
            <rect
              key={`i${x},${y}`}
              x={x + 2}
              y={y + 2}
              width={1.02}
              height={1.02}
              fill={innerColor}
            />
          );
        }
      }
    }
  }

  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      style={{
        display: "block",
        filter:
          glow === "accent"
            ? `drop-shadow(0 0 3px ${innerColor}) drop-shadow(0 0 7px ${innerColor})`
            : glow
              ? "drop-shadow(0 0 2px rgba(242,242,242,0.30))"
              : "none",
        flexShrink: 0,
        ...style,
      }}
    >
      {/* The badge sits in a notch cut out of the ring + mark, so it reads
          as a separate disc laid over the coin rather than a blob welded
          onto the rim. A mask (not an opaque knockout rect) because the
          icon renders over several different backgrounds. */}
      {badge && (
        <mask id={maskId}>
          <rect x="0" y="0" width="12" height="12" fill="#fff" />
          <circle cx="9.1" cy="9.1" r="3.5" fill="#000" />
        </mask>
      )}
      <g mask={badge ? `url(#${maskId})` : undefined}>
      {ringRects}
      {glyph?.kind === "p" && innerRects}
      {glyph?.kind === "g" && (
        <text
          x="6"
          y="8.5"
          fontFamily="JetBrains Mono, monospace"
          fontSize="6.5"
          fontWeight={glyph.w ?? 700}
          textAnchor="middle"
          fill={innerColor}
          style={{ letterSpacing: 0 }}
        >
          {glyph.t}
        </text>
      )}
      {!glyph && (
        <text
          x="6"
          y="8.5"
          fontFamily="JetBrains Mono, monospace"
          fontSize="4"
          fontWeight={700}
          textAnchor="middle"
          fill={innerColor}
        >
          {upper.slice(0, 3)}
        </text>
      )}
      </g>
      {badge && (
        <>
          <circle cx="9.1" cy="9.1" r="2.75" fill={badge.c} />
          <text
            x="9.1"
            y="10.3"
            fontFamily="JetBrains Mono, monospace"
            fontSize="3.6"
            fontWeight={700}
            textAnchor="middle"
            fill="#fff"
            style={{ letterSpacing: 0 }}
          >
            {badge.t}
          </text>
        </>
      )}
    </svg>
  );
}
