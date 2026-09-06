/**
 * <MiniSpark> — tiny SVG sparkline (polyline only).
 *
 * fluid=true makes the SVG fill its parent width; useful when the
 * container's width is dictated by flex/grid.
 */

import type { CSSProperties } from "react";

export function MiniSpark({
  values,
  w = 80,
  h = 18,
  color = "var(--accent)",
  strokeWidth = 1.2,
  style,
  fluid = false,
  minRangeFrac,
}: {
  values: number[];
  w?: number;
  h?: number;
  color?: string;
  strokeWidth?: number;
  style?: CSSProperties;
  fluid?: boolean;
  /**
   * Floor the vertical domain to `|midpoint| * minRangeFrac` and center the
   * series within it. Without this the spark auto-scales min→max and fills the
   * full height regardless of magnitude, so a 0.1% move and a 50% move look
   * identical — visually dishonest for value series (e.g. a portfolio total).
   * Set e.g. `0.08` so the chart spans at least ~8% peak-to-peak: tiny moves
   * render tiny, large moves still fill. Omit for raw auto-scale (the default,
   * correct for unitless trend sparks like hashrate).
   */
  minRangeFrac?: number;
}) {
  if (!values || values.length === 0) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  // Default: raw min→max auto-scale (lo = min). When minRangeFrac is set, floor
  // the domain span and recenter so small percentage moves stay visually small.
  let range = max - min || 1;
  let lo = min;
  if (minRangeFrac && minRangeFrac > 0) {
    const mid = (max + min) / 2;
    range = Math.max(range, Math.abs(mid) * minRangeFrac);
    lo = mid - range / 2;
  }
  const step = w / (values.length - 1 || 1);
  const pts = values
    .map((v, i) => `${i * step},${h - ((v - lo) / range) * (h - 2) - 1}`)
    .join(" ");
  return (
    <svg
      width={fluid ? "100%" : w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio={fluid ? "none" : "xMidYMid meet"}
      style={{ display: "block", ...style }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect={fluid ? "non-scaling-stroke" : undefined}
      />
    </svg>
  );
}
