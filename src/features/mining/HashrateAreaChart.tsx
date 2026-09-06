/**
 * Unified hashrate area chart — renders BOTH the 1 HR (live in-memory)
 * and the 24 HR (disk-persisted) views in the Mining hero panel.
 *
 * Design goals (locked 2026-05-15 after the user's "floating line"
 * feedback):
 *
 *   1. **Area + 0 baseline** — gradient fill from the hashrate line down
 *      to a 0 baseline at the bottom of the plot. No floating mid-chart
 *      lines.
 *   2. **Drop to 0 on idle** — when there's a gap between samples larger
 *      than the expected polling interval, the line drops to 0, runs flat
 *      across the idle window, and rises back when new data arrives.
 *      Visually identical to the unmineable.com worker chart.
 *   3. **Wall-clock x-axis** — ticks display real clock times in the
 *      user's locale (e.g. "6 AM", "12 PM", "now"). Single source of
 *      truth across both modes — the only difference is `windowMs`.
 *   4. **Hover crosshair + tooltip** — vertical line follows the cursor,
 *      tooltip pins to the nearest data point showing
 *      `YYYY-MM-DD HH:MM` + the hashrate at that point.
 *
 * The component is pure SVG (no charting library) — kept lightweight
 * because the desktop bundle should stay small. Recharts is in the
 * dependency list for SwapForm but pulling it in here would be ~30 KB
 * for no real benefit over the existing hand-rolled approach.
 *
 * See `wiki/concepts/hashrate-history.md` § "Chart rendering" for the
 * architectural rationale.
 */

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { formatHashrateParts } from "./pool-stats/format";

export interface HashrateAreaPoint {
  /** Unix-ms wall-clock timestamp. */
  t: number;
  /** Hashrate in H/s (>= 0). */
  value: number;
}

interface HashrateAreaChartProps {
  data: HashrateAreaPoint[];
  /** Visible window length in ms (3_600_000 for 1 HR, 86_400_000 for 24 HR). */
  windowMs: number;
  /**
   * Expected gap between adjacent samples in ms. Used to detect idle
   * periods — gaps larger than `expectedIntervalMs * 1.5` get bridged by
   * zero-value points so the line drops to the baseline instead of
   * leaving a misleading straight-line interpolation.
   */
  expectedIntervalMs: number;
  /** Unit for the hashrate values (e.g. "H", "Sol"). */
  baseUnit: string;
  /** End of the visible window in Unix ms. Defaults to `Date.now()`. */
  endMs?: number;
  /** Rendered pixel height. */
  h?: number;
  /** Stroke + area fill colour (CSS var or hex). */
  color?: string;
  /** When true, render a glow dot at the right edge (live mining). */
  mining?: boolean;
  style?: CSSProperties;
  /** Empty-state copy when there's no data in the window. */
  emptyLabel?: string;
}

/**
 * Hard-coded internal viewBox width. The SVG uses `preserveAspectRatio="none"`
 * so it stretches to whatever pixel width the parent gives it; `vectorEffect`
 * keeps strokes crisp. Picking a large reference width gives floating-point
 * paths enough resolution that the rendered curve stays smooth at the 520 px
 * the mining hero actually renders.
 */
const VW = 1000;

/**
 * Apply an alpha to a CSS color for canvas fills. The chart's `color` prop
 * is usually a CSS custom property (`var(--accent)`) or a hex string. Canvas
 * can't read CSS vars directly, so on first use we resolve the var against
 * the document once and cache it; hex/rgb values pass through. Returns an
 * `rgba(...)` string. Falls back to a mid-accent green if resolution fails.
 */
const _colorCache = new Map<string, string>();
function resolveColor(c: string): string {
  if (typeof document === "undefined") return c;
  const m = c.match(/var\((--[a-z0-9-]+)\)/i);
  if (!m) return c;
  const cached = _colorCache.get(c);
  if (cached) return cached;
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(m[1])
    .trim();
  const out = resolved || "#00cc66";
  _colorCache.set(c, out);
  return out;
}
function withAlpha(c: string, alpha: number): string {
  const resolved = resolveColor(c);
  // Hex → rgba.
  const hex = resolved.replace("#", "");
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  // Already rgb()/rgba()/named — wrap with global alpha fallback.
  if (resolved.startsWith("rgb")) {
    return resolved
      .replace(/^rgba?\(/, "rgba(")
      .replace(/\)$/, `, ${alpha})`)
      .replace(/,\s*[\d.]+\)$/, `, ${alpha})`);
  }
  return resolved;
}

/**
 * Compute the y-axis maximum with 15% headroom above the data peak, and a
 * floor of 1 to dodge divide-by-zero when the series is empty or all zeros.
 */
function computeYMax(points: HashrateAreaPoint[]): number {
  if (points.length === 0) return 1;
  let peak = 0;
  for (const p of points) if (p.value > peak) peak = p.value;
  return Math.max(1, peak * 1.15);
}

/**
 * Insert "bridge" points between consecutive samples so the rendered
 * line never crosses a gap diagonally. There are two kinds of bridges:
 *
 *   - **Short-gap bridge** (gap < `longGapThresholdMs`): hold the
 *     previous value across the gap so the line stays continuous at
 *     its last-known level. This handles the common case where one or
 *     two polls miss (transient RPC stall, brief miner-stat zero-snap,
 *     2–6 second outages) — the user used to see those as visible
 *     vertical dips in the 1 HR chart that didn't reflect real
 *     downtime. Reported 2026-05-16.
 *   - **Long-gap U-bridge** (gap >= `longGapThresholdMs`): drop to 0
 *     just after the previous point, flat across the idle window, rise
 *     back just before the next point. Real downtime (dev-fee
 *     timeslices at ~54 s, miner restarts, user-paused sessions) stays
 *     visible.
 *
 * Window edges follow the same rule: short gap at the head/tail just
 * holds the boundary value; long gap drops to 0 across the unused
 * portion of the window.
 *
 * `longGapThresholdMs` defaults to `expectedIntervalMs * 5`:
 *   - 1 HR view (expected = 2 s): 10 s threshold — single missed poll
 *     (~2–4 s) and double-misses (~4–6 s) are smoothed; anything over
 *     10 s is real downtime and still drops to zero.
 *   - 24 HR view (expected = 60 s): 5 min threshold — a single missed
 *     minute (~60–90 s) is smoothed; anything over 5 min is a true
 *     mining pause.
 */
function bridgeWithZeros(
  points: HashrateAreaPoint[],
  windowStart: number,
  windowEnd: number,
  expectedIntervalMs: number,
  live: boolean,
): HashrateAreaPoint[] {
  // Anything beyond ~5 expected intervals is treated as a real downtime
  // U-drop. Below the threshold, the line holds the previous value.
  const longGapThresholdMs = expectedIntervalMs * 5;
  // Drop-to-zero offset for the long-gap U-bridge. Smaller = more
  // vertical drop; larger = more gradual slope. The polling interval
  // itself reads as "the miner went dark between these two ticks".
  const bridgeOffsetMs = expectedIntervalMs;

  const inWindow: HashrateAreaPoint[] = [];
  for (const p of points) {
    if (p.t >= windowStart && p.t <= windowEnd) inWindow.push(p);
  }
  inWindow.sort((a, b) => a.t - b.t);

  if (inWindow.length === 0) {
    // No data in the window — anchor a flat zero line across the bottom.
    return [
      { t: windowStart, value: 0 },
      { t: windowEnd, value: 0 },
    ];
  }

  const out: HashrateAreaPoint[] = [];

  // Pad window start: long gap from windowStart to the first point →
  // U-drop to zero across the idle portion. Short gap → just start at
  // the first point (no synthetic head padding).
  //
  // B2 (2026-05-26) — skip the head U-bridge when `live=true`. A fresh
  // session that just started has only a few samples but the rest of
  // the window is *implicitly* empty (no history yet, not "was at 0
  // for the prior hour"). The U-drop made the first few samples render
  // as a visible "snap up from 0", which read as a glitch. With this
  // guard, fresh sessions render only the data they have — the empty
  // space to the left of the first sample stays empty.
  // Real downtime mid-session is still handled by the long-gap
  // U-bridge in the loop below.
  const first = inWindow[0];
  if (!live && first.t - windowStart > longGapThresholdMs) {
    out.push({ t: windowStart, value: 0 });
    out.push({ t: first.t - bridgeOffsetMs, value: 0 });
  }

  for (let i = 0; i < inWindow.length; i++) {
    const p = inWindow[i];
    if (i > 0) {
      const prev = inWindow[i - 1];
      const gap = p.t - prev.t;
      if (gap > longGapThresholdMs) {
        // Long gap → U-bridge: drop just after prev, rise just before p.
        out.push({ t: prev.t + bridgeOffsetMs, value: 0 });
        out.push({ t: p.t - bridgeOffsetMs, value: 0 });
      }
      // Short gap (longGapThresholdMs >= gap >= expectedInterval): hold
      // the previous value. The natural line-draw between `prev` and
      // `p` already does this — we don't insert a flat segment because
      // a straight line between two nearby points at similar values is
      // visually indistinguishable from a held-flat segment, AND
      // inserting an extra `{ t: p.t - 1, value: prev.value }` point
      // would create a tiny saw-tooth artifact on every sample
      // boundary. No-op is the cleanest "held value" rendering.
    }
    out.push(p);
  }

  // Pad window end: drop to 0 across the tail only when it's a long
  // idle window (no live mining + last point is well before windowEnd).
  // When live-mining we always leave the line at its current value —
  // the next tick / synthetic open-bucket point extends it naturally.
  const last = inWindow[inWindow.length - 1];
  if (!live && windowEnd - last.t > longGapThresholdMs) {
    out.push({ t: last.t + bridgeOffsetMs, value: 0 });
    out.push({ t: windowEnd, value: 0 });
  }

  return out;
}

/**
 * Build the x-axis tick list — 4 to 5 evenly-spaced wall-clock labels
 * across the window plus a "now" anchor at the right edge. For sub-day
 * windows we tick every 15 min; for the 24 h window we tick every 6 h.
 */
function buildTicks(windowMs: number, windowEnd: number) {
  const hours = windowMs / (60 * 60_000);
  const stepHours = hours <= 1 ? 0.25 : hours <= 6 ? 1 : 6;
  const stepMs = stepHours * 60 * 60_000;
  const ticks: { t: number; label: string }[] = [];
  for (let t = windowEnd; t > windowEnd - windowMs - 1; t -= stepMs) {
    ticks.push({ t, label: t === windowEnd ? "now" : formatTimeTick(t, hours) });
  }
  ticks.reverse();
  // Cap at ~5 ticks for readability; subsample if we overshot.
  if (ticks.length > 5) {
    const stride = Math.ceil(ticks.length / 5);
    return ticks.filter((_, i) => i % stride === 0 || i === ticks.length - 1);
  }
  return ticks;
}

function formatTimeTick(ms: number, windowHours: number): string {
  const d = new Date(ms);
  if (windowHours <= 1) {
    // 12-hour clock with minutes ("3:45 PM"). Tight enough to fit two
    // per axis at 520 px.
    return d.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }
  return d.toLocaleTimeString([], {
    hour: "numeric",
    hour12: true,
  });
}

/** Format a tooltip line: "2026-05-15 16:21". Local time, 24-hour. */
function formatTooltipTime(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function HashrateAreaChartImpl({
  data,
  windowMs,
  expectedIntervalMs,
  baseUnit,
  endMs,
  h = 110,
  color = "var(--accent)",
  mining = false,
  style,
  emptyLabel,
}: HashrateAreaChartProps): ReactElement {
  // Re-tick the visible window every 15 seconds so the right edge
  // slides while idle. Was 1 second pre-2026-05-26 — the high tick rate
  // caused visible flicker on long paths (24 HR view has ~1440 path
  // commands and the line uses an SVG drop-shadow filter, both of which
  // re-rasterize on every render). User reported the chart "flickers
  // whenever its mining"; the 1-second tick was the source. 15 seconds
  // is still subpixel motion on a 24 HR chart (~0.1 px shift) and a
  // ~2 px shift on a 1 HR chart — fine for x-axis-tracking purposes.
  // The parent re-renders every 2 seconds when a new sample arrives,
  // which drives the actual line updates; the internal tick now only
  // exists to keep the x-axis honest during idle periods.
  //
  // setInterval is throttled (and on some platforms outright paused)
  // by WebView2 / Chromium when the window is unfocused or minimized.
  // We pair it with a `document.visibilitychange` listener so the
  // chart's right edge snaps to the real "now" the instant the user
  // refocuses the app, even if the regular tick is still suspended.
  // Without this catch-up, the chart's window-end can lag minutes
  // behind real time on resume.
  const [nowMs, setNowMs] = useState<number>(() => endMs ?? Date.now());
  useEffect(() => {
    if (endMs !== undefined) {
      setNowMs(endMs);
      return;
    }
    setNowMs(Date.now());
    // 2026-05-31 (leak Round 6) — only run the 15 s x-axis ticker WHILE
    // MINING. The ticker exists to slide the chart's right edge as time
    // passes so live samples land at "now". When NOT mining there is no
    // new data and nothing to slide toward, but the ticker was still
    // firing every 15 s forever — and each tick rebuilds the chart's full
    // SVG path (up to ~1440 commands on the 24 HR view), which WebView2
    // re-rasterizes. A pure-idle PwndaLite window (no mining) grew the
    // WebView2 renderer ~72 MB/h, linear, for 18 h (435 -> 1752 MB) with
    // the JS heap + DOM-node count both flat — the fingerprint of
    // compositing/raster churn, not a JS or DOM accumulator. Gating the
    // ticker on `mining` stops the idle re-render loop entirely. The
    // visibilitychange catch-up stays unconditional so the right edge
    // still snaps to real "now" the moment the user refocuses (covers the
    // brief window before the next mining sample arrives). See
    // [[webview2-memory-management]] Round 6.
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        setNowMs(Date.now());
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    let id: number | undefined;
    if (mining) {
      id = window.setInterval(() => setNowMs(Date.now()), 15_000);
    }
    return () => {
      if (id !== undefined) window.clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [endMs, mining]);

  const windowEnd = nowMs;
  const windowStart = windowEnd - windowMs;

  // Pixel padding inside the viewBox. Bottom is generous to fit the
  // x-axis labels; top is small because the y-max label hangs inside
  // the plot area itself.
  const padL = 6;
  const padR = 6;
  const padT = 8;
  const padB = 20;
  const cx = VW - padL - padR;
  const cy = h - padT - padB;
  const baselineY = padT + cy;

  const bridged = useMemo(
    () =>
      bridgeWithZeros(
        data,
        windowStart,
        windowEnd,
        expectedIntervalMs,
        mining,
      ),
    [data, windowStart, windowEnd, expectedIntervalMs, mining],
  );
  const yMax = useMemo(() => computeYMax(bridged), [bridged]);

  // 2026-05-30 — clamp X to the plot rect and guard against non-finite
  // values. When the app is backgrounded, WebView2 pauses the 15 s `nowMs`
  // ticker AND the parent's 2 s data poll; on resume `nowMs` jumps forward
  // by the whole idle span (e.g. ~2 h) in a single frame. For that one
  // transition frame the chart's `data` is still the pre-background buffer,
  // so points can map far outside the viewBox (or, if `windowMs`/`yMax`
  // ever degenerate, to NaN). An unclamped/ NaN `M/L` command renders as a
  // visibly broken, glitching path until the next poll arrives. Clamping
  // to the plot rect + coercing non-finite to the baseline keeps the
  // resume frame clean — the path just snaps to the correct shape on the
  // next data tick. Reported 2026-05-30 (GPU 24 HR chart after a ~2 h
  // background). See `wiki/concepts/hashrate-history.md` § "Chart rendering".
  const toX = (t: number) => {
    const x = padL + ((t - windowStart) / windowMs) * cx;
    if (!Number.isFinite(x)) return padL;
    return Math.max(padL, Math.min(padL + cx, x));
  };
  const toY = (v: number) => {
    const frac = Math.max(0, Math.min(1, v / yMax));
    const y = padT + cy - frac * cy;
    return Number.isFinite(y) ? y : baselineY;
  };

  // 2026-06-01 (leak Round 10) — render the plot (background, grid, area
  // fill, line, glow dot, hover crosshair) on a <canvas> instead of SVG.
  //
  // Root cause of the WebView2 mining memory leak: SVG is a RETAINED-mode
  // renderer — every path command stays a live object the engine tracks,
  // and rebuilding a ~1440-command path every repaint accumulated native
  // renderer memory the compositor never reliably freed (~1600 MB/h while
  // mining; see [[webview2-memory-management]] Rounds 5/9 + the MS
  // WebView2Feedback #3678 source). Canvas is IMMEDIATE-mode — "once
  // painted, the browser forgets about the object; it's just a grid of
  // pixels" (ECharts / graphics-renderer guidance) — so repainting it
  // every frame allocates nothing retained. This is the architectural fix,
  // not a mitigation. The text overlays (axis ticks, y-max label, empty
  // label, tooltip) stay as DOM below — they are cheap, crisp, and not the
  // leak. `canvasW`/`canvasH` are the measured CSS pixel size; we draw at
  // devicePixelRatio for crispness.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [canvasW, setCanvasW] = useState(0);

  // Measure the container width so the canvas can size to real pixels
  // (the old SVG used a 1000-unit viewBox stretched via
  // preserveAspectRatio="none"; canvas has no such auto-stretch).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      if (el) setCanvasW(el.clientWidth);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setCanvasW(Math.round(w));
    });
    ro.observe(el);
    setCanvasW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Map a viewBox-space X (0..VW, what toX returns) to a real canvas pixel
  // X. The overlays still use viewBox space, so we keep toX/toY as the
  // single source of geometry and just rescale X into pixels here.
  const sx = (vx: number) => (vx / VW) * canvasW;

  // Cursor / hover state. `hover.t` is the *snapped* timestamp of the
  // nearest data point; `hover.value` is its hashrate. We render the
  // crosshair line at that snapped x rather than the raw cursor x so
  // the dot is always on the curve, not floating in space between
  // samples.
  type HoverState = {
    t: number;
    value: number;
    rawSvgX: number; // in viewBox coords (pre-clip)
  };
  const [hover, setHover] = useState<HoverState | null>(null);

  // Build a sorted, de-duped array of points for hover-snap. We use the
  // ORIGINAL data (not the bridged one) so the tooltip lands on real
  // samples rather than the synthetic zeros — that keeps idle-period
  // hovers showing "0" without naming a fake timestamp.
  const hoverable = useMemo(() => {
    const out: HashrateAreaPoint[] = [];
    for (const p of data) {
      if (p.t >= windowStart && p.t <= windowEnd) out.push(p);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }, [data, windowStart, windowEnd]);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Map pixel x → viewBox x (the canvas/overlay coordinate space is VW-wide).
    const fracX = (e.clientX - rect.left) / rect.width;
    const svgX = Math.max(padL, Math.min(VW - padR, fracX * VW));
    const tAtCursor = windowStart + ((svgX - padL) / cx) * windowMs;

    if (hoverable.length === 0) {
      setHover({ t: tAtCursor, value: 0, rawSvgX: svgX });
      return;
    }
    // Find the nearest hoverable point by timestamp.
    let nearest = hoverable[0];
    let bestDelta = Math.abs(nearest.t - tAtCursor);
    for (let i = 1; i < hoverable.length; i++) {
      const delta = Math.abs(hoverable[i].t - tAtCursor);
      if (delta < bestDelta) {
        bestDelta = delta;
        nearest = hoverable[i];
      }
    }
    // If the cursor is well outside any real data (> 1.5x interval from
    // the nearest sample), surface "0" at the cursor instead — useful
    // for the user to see "yeah, I wasn't mining at 3 AM".
    if (bestDelta > expectedIntervalMs * 1.5) {
      setHover({ t: tAtCursor, value: 0, rawSvgX: svgX });
      return;
    }
    setHover({ t: nearest.t, value: nearest.value, rawSvgX: svgX });
  };

  const onLeave = () => setHover(null);

  const ticks = useMemo(
    () => buildTicks(windowMs, windowEnd),
    [windowMs, windowEnd],
  );

  // Last on-curve point for the live "glow dot".
  const lastReal =
    hoverable.length > 0 ? hoverable[hoverable.length - 1] : null;

  const hasData = hoverable.length > 0;

  // ── Canvas draw effect ─────────────────────────────────────────────
  // Renders the plot (background, grid, area, line, glow dot, hover
  // crosshair) to the <canvas>. Re-runs only when the geometry it reads
  // changes — once per (throttled) data update, window slide, or hover
  // move — NOT continuously. Each run fully clears + repaints; canvas is
  // immediate-mode so it retains nothing between frames (the architectural
  // fix for the SVG retained-mode memory leak). Placed after all its
  // inputs are declared.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasW <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Size the backing store at DPR for crisp strokes; CSS size stays h px.
    const needW = Math.round(canvasW * dpr);
    const needH = Math.round(h * dpr);
    if (canvas.width !== needW) canvas.width = needW;
    if (canvas.height !== needH) canvas.height = needH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, h);

    // Plot background.
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(sx(padL), padT, sx(padL + cx) - sx(padL), cy);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx(padL) + 0.5, padT + 0.5, sx(padL + cx) - sx(padL) - 1, cy - 1);

    // Vertical grid lines (every tick except the edges).
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.setLineDash([1, 3]);
    for (let i = 1; i < ticks.length - 1; i++) {
      const x = sx(toX(ticks[i].t));
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, baselineY);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (bridged.length >= 2) {
      // Build the line geometry once.
      const pts = bridged.map((p) => ({ x: sx(toX(p.t)), y: toY(p.value) }));

      // Area fill — vertical gradient from the line down to the baseline.
      const grad = ctx.createLinearGradient(0, padT, 0, baselineY);
      grad.addColorStop(0, withAlpha(color, 0.45));
      grad.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[pts.length - 1].x, baselineY);
      ctx.lineTo(pts[0].x, baselineY);
      ctx.closePath();
      ctx.fill();

      // Hashrate line on top.
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }

    // Glow dot at the most recent real sample (mining only) — a faint halo
    // behind a solid dot, no filter (immediate-mode paint).
    if (lastReal && mining) {
      const gx = sx(toX(lastReal.t));
      const gy = toY(lastReal.value);
      ctx.fillStyle = withAlpha(color, 0.25);
      ctx.beginPath();
      ctx.arc(gx, gy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(gx, gy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Hover crosshair — dashed vertical line + ringed dot.
    if (hover && hoverable.length > 0) {
      const hx = sx(toX(hover.t));
      ctx.strokeStyle = "rgba(242,242,242,0.45)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, baselineY);
      ctx.stroke();
      ctx.setLineDash([]);
      const hy = toY(hover.value);
      ctx.fillStyle = "#0a0a0a";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridged, ticks, hover, lastReal, canvasW, color, mining, yMax, windowStart, windowEnd]);

  // Empty-label is rendered as an HTML overlay rather than `<text>`
  // inside the SVG because the SVG uses `preserveAspectRatio="none"`
  // — that scales the chart geometry to fit the container's width,
  // but it ALSO horizontally squishes any text glyphs inside.
  // "START MINING TO BEGIN CHARTING" at ~50% horizontal scale becomes
  // visibly condensed and hard to read. Reported 2026-05-16. HTML
  // text sits on top of the SVG via the parent `position: relative`
  // and uses real CSS typography, so glyph proportions are preserved.
  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        width: "100%",
        height: h,
        cursor: hasData ? "crosshair" : "default",
        ...style,
      }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {/* Canvas plot — background, grid, area, line, glow dot, crosshair.
          Immediate-mode rendering (painted pixels, nothing retained) — the
          architectural fix for the WebView2 SVG-repaint memory leak. Text
          (axis ticks, y-max, empty label, tooltip) stays as DOM overlays
          below. See [[webview2-memory-management]] Round 10. */}
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: h }}
      />

      {/* X-axis tick labels — HTML overlay so glyphs render at their
          natural width (not squished by preserveAspectRatio="none").
          Each label sits at a fractional left position computed from
          `toX(tk.t) / VW` and is text-anchored via translate to mimic
          the previous SVG `text-anchor="start|middle|end"` behavior. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${((padT + cy + 2) / h) * 100}%`,
          height: padB - 2,
          pointerEvents: "none",
          fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
          fontSize: 9,
          color: "rgba(242,242,242,0.55)",
          letterSpacing: 0.5,
        }}
      >
        {ticks.map((tk, i) => {
          const leftFrac = toX(tk.t) / VW;
          const isFirst = i === 0;
          const isLast = i === ticks.length - 1;
          return (
            <span
              key={`xt${i}`}
              style={{
                position: "absolute",
                left: `${leftFrac * 100}%`,
                top: 0,
                transform: isFirst
                  ? "translateX(0)"
                  : isLast
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
                whiteSpace: "nowrap",
              }}
            >
              {tk.label}
            </span>
          );
        })}
      </div>

      {/* Y-axis max label — HTML overlay so the label's character-count
          changing (yMax shifts each poll) doesn't cause SVG glyph
          reshuffle. The value still re-renders each poll, but as
          properly-typeset HTML text rather than squished SVG glyphs. */}
      {hasData && (
        <div
          style={{
            position: "absolute",
            left: `${((padL + 4) / VW) * 100}%`,
            top: `${((padT + 2) / h) * 100}%`,
            pointerEvents: "none",
            fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
            fontSize: 9,
            color: "rgba(242,242,242,0.55)",
            letterSpacing: 0.5,
            whiteSpace: "nowrap",
          }}
        >
          {(() => {
            const p = formatHashrateParts(yMax, baseUnit);
            return `${p.value} ${p.unit || baseUnit}`;
          })()}
        </div>
      )}

      {/* Empty-state hint — HTML overlay so the text isn't horizontally
          squished by the SVG's preserveAspectRatio="none" scaling.
          Positioned in the chart's plot area (between padT and the
          baseline) using percentages computed from viewBox padding. */}
      {!hasData && emptyLabel && (
        <div
          style={{
            position: "absolute",
            // Centered inside the plot area only (excludes the x-axis
            // label strip below the baseline).
            left: `${(padL / VW) * 100}%`,
            right: `${(padR / VW) * 100}%`,
            top: `${(padT / h) * 100}%`,
            height: `${(cy / h) * 100}%`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
            fontSize: 10,
            letterSpacing: 0.5,
            color: "rgba(242,242,242,0.5)",
            textTransform: "uppercase",
            textAlign: "center",
            // Small horizontal padding so the text never butts up
            // against the plot area's border at very narrow widths.
            padding: "0 8px",
          }}
        >
          {emptyLabel}
        </div>
      )}

      {/* Tooltip rendered as an HTML overlay so font scaling stays
          crisp and we don't have to hand-position a foreignObject. The
          numbers we use to place it map viewBox space → fractional
          position via `toX(...) / VW`. */}
      {hover && hasData && (
        <HoverTooltip
          t={hover.t}
          value={hover.value}
          baseUnit={baseUnit}
          leftFrac={toX(hover.t) / VW}
        />
      )}
    </div>
  );
}

/**
 * `React.memo` wrap so the chart skips re-rendering when none of its
 * props have changed. The hero panel re-renders every 2 s during mining
 * (hashrateSamples poll); without this, the chart's bridgeWithZeros +
 * ~1500-command SVG path rebuild would run on every parent render even
 * if the chart's own data hadn't actually updated. The default shallow
 * comparison is sufficient because callers now hand us reference-stable
 * arrays (`historyAreaData` is `useMemo`'d in MiningView).
 */
export const HashrateAreaChart = memo(HashrateAreaChartImpl);

function HoverTooltip({
  t,
  value,
  baseUnit,
  leftFrac,
}: {
  t: number;
  value: number;
  baseUnit: string;
  leftFrac: number;
}): ReactElement {
  // Flip the tooltip horizontally so it stays inside the chart on the
  // right edge. Threshold at 70% of width keeps it readable when the
  // user mouses to "now".
  const flip = leftFrac > 0.7;
  const parts = formatHashrateParts(value, baseUnit);
  const hashLabel = `${parts.value} ${parts.unit || `${baseUnit}/s`}`;
  return (
    <div
      style={{
        position: "absolute",
        left: `${leftFrac * 100}%`,
        top: 4,
        transform: flip ? "translate(-105%, 0)" : "translate(5%, 0)",
        pointerEvents: "none",
        background: "rgba(0,0,0,0.85)",
        border: "1px solid rgba(255,255,255,0.20)",
        padding: "5px 8px",
        fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
        fontSize: 10,
        color: "var(--text, #f2f2f2)",
        whiteSpace: "nowrap",
        letterSpacing: 0.5,
        boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ color: "rgba(242,242,242,0.55)", fontSize: 9 }}>
        {formatTooltipTime(t)}
      </div>
      <div style={{ color: "var(--accent)", marginTop: 2 }}>
        Speed: {hashLabel}
      </div>
    </div>
  );
}
