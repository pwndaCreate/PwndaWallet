/**
 * Memory-trace card — DEV-only readout of V8 JS heap growth over time.
 * Added 2026-05-28 after the two-round memory-leak fix (SessionTimer
 * extraction + single-pass useMemo) reduced per-render allocations from
 * ~75 KB to ~3 KB but users still reported WebView2 process memory
 * climbing to 7+ GB after long mining sessions. The remaining leak
 * isn't in any per-render hot path — to find it we need a heap-growth
 * time series.
 *
 * Lives under `src/features/mining/**` (per `BOUNDARIES.md`) so both the
 * full wallet's Settings and PwndaLite's Settings can render it. Extracted
 * 2026-07-06 from the former `DevFeeDiagnostics.tsx` when the dev-fee
 * diagnostics cards were removed in the pure-wallet cutover.
 *
 * DEV-gated: renders when `import.meta.env.DEV` OR the localStorage
 * `pwnda-dev-diagnostics` flag is `"true"`. The data lives in localStorage
 * (not Tauri-side) — small enough (1440 samples × ~50 bytes = ~70 KB) and
 * persistence-across-restart is the whole point.
 *
 * What the data tells you:
 *   - **`usedJSHeapSize` flat or oscillating around a baseline** → no
 *     JS-side leak. Native-layer growth (GPU/canvas buffers, image cache,
 *     IPC retention) needs a different debugging path.
 *   - **`usedJSHeapSize` climbing linearly** → JS-side leak. Take a heap
 *     snapshot in DevTools, look at the biggest retainer's path.
 *   - **`view` field changes around growth slope inflections** → the leak
 *     is panel-specific. Reproduce by holding that panel.
 */

import { useCallback, useState } from "react";
import { Btn, Card } from "../../components/PrimitivesV2";
import { useMemoryTraceData, type MemorySample } from "./useMemoryTrace";

function Row({
  label,
  value,
  mono,
  color,
}: {
  label: string;
  value: string;
  mono?: boolean;
  color?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        className={mono ? "tnum" : undefined}
        style={{
          fontSize: 11,
          color: color ?? "var(--text)",
          textAlign: "right",
          wordBreak: "break-all",
          maxWidth: "60%",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function MemoryTraceCard({ view }: { view: string }) {
  const enabled =
    import.meta.env.DEV ||
    (typeof window !== "undefined" &&
      window.localStorage?.getItem("pwnda-dev-diagnostics") === "true");
  if (!enabled) return null;
  return <MemoryTraceCardInner view={view} />;
}

function MemoryTraceCardInner({ view }: { view: string }) {
  const trace = useMemoryTraceData();
  const [copied, setCopied] = useState(false);
  // `view` is consumed by `useMemoryTracker` at the app-shell level so
  // each sample is labeled with the panel that was rendered. The card
  // surfaces the value here as the "Active view" row so you can see
  // what label is being written into the trace as you read it.
  void view;

  const copyData = useCallback(async () => {
    const json = JSON.stringify(trace.samples, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard rejected */
    }
  }, [trace.samples]);

  // Detect Chromium / V8 — `performance.memory` is non-standard and
  // returns `undefined` outside Chromium-based runtimes. The fallback
  // message keeps the card honest about what it can and can't measure.
  const hasMemoryApi =
    typeof window !== "undefined" &&
    typeof window.performance !== "undefined" &&
    "memory" in window.performance;

  if (!hasMemoryApi) {
    return (
      <Card title="MEMORY TRACE (DEV)" style={{ marginTop: 14 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
          `performance.memory` is unavailable in this runtime. Chromium /
          WebView2 only. Sample collection paused.
        </div>
      </Card>
    );
  }

  return (
    <Card title="MEMORY TRACE (DEV)" style={{ marginTop: 14 }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          lineHeight: 1.55,
          color: "var(--text-muted)",
        }}
      >
        <p style={{ marginTop: 0, marginBottom: 8 }}>
          Polls <code>performance.memory.usedJSHeapSize</code> once per
          minute; persists across restart via localStorage. Only the
          V8 JS heap — NOT the WebView2 process working set. If process
          memory in Task Manager balloons but this stays flat, the leak
          is in the native layer (GPU buffers, IPC, image cache), not
          JS.
        </p>

        <Row
          label="Current"
          value={
            trace.currentUsedMb != null
              ? `${trace.currentUsedMb.toFixed(1)} MB`
              : "—"
          }
        />
        <Row
          label="Peak"
          value={
            trace.peakUsedMb != null
              ? `${trace.peakUsedMb.toFixed(1)} MB`
              : "—"
          }
        />
        <Row
          label="Growth (last hr)"
          value={
            trace.growthMbPerHour != null
              ? `${trace.growthMbPerHour >= 0 ? "+" : ""}${trace.growthMbPerHour.toFixed(1)} MB/hr`
              : "(need ≥ 2 samples in last hour)"
          }
          color={
            trace.growthMbPerHour != null && trace.growthMbPerHour > 50
              ? "var(--danger)"
              : undefined
          }
        />
        <Row label="Samples" value={`${trace.samples.length} / 1440`} />
        <Row label="Active view" value={view} mono />

        <div style={{ marginTop: 10 }}>
          <MemorySparkline samples={trace.samples} />
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
          <Btn onClick={copyData} size="sm">
            {copied ? "✓ Copied" : "Copy trace JSON"}
          </Btn>
          <Btn onClick={trace.reset} size="sm">
            Reset
          </Btn>
        </div>
      </div>
    </Card>
  );
}

/**
 * Tiny inline SVG sparkline showing the `usedMb` time series. No
 * memoization wrapper — the parent re-renders once per minute when
 * a new sample lands, and the SVG path build is O(n) over a ~1440-cap
 * buffer (~30 µs even cold). Cheap enough to not bother.
 */
function MemorySparkline({ samples }: { samples: MemorySample[] }) {
  if (samples.length < 2) {
    return (
      <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
        (waiting for samples — first one fires immediately, subsequent at 1/min)
      </div>
    );
  }
  const W = 400;
  const H = 60;
  const PAD = 4;
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    if (s.usedMb < min) min = s.usedMb;
    if (s.usedMb > max) max = s.usedMb;
  }
  const span = Math.max(1, max - min);
  const tFirst = samples[0].t;
  const tLast = samples[samples.length - 1].t;
  const tSpan = Math.max(1, tLast - tFirst);
  const toX = (t: number) =>
    PAD + ((t - tFirst) / tSpan) * (W - PAD * 2);
  const toY = (v: number) =>
    PAD + (1 - (v - min) / span) * (H - PAD * 2);
  const pts: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    pts.push(`${i === 0 ? "M" : "L"} ${toX(s.t).toFixed(1)} ${toY(s.usedMb).toFixed(1)}`);
  }
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      style={{
        display: "block",
        background: "var(--surface)",
        border: "1px solid var(--border)",
      }}
    >
      <path
        d={pts.join(" ")}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.2}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={PAD}
        y={H - PAD}
        fontSize={9}
        fill="rgba(242,242,242,0.45)"
        fontFamily="var(--font-mono, monospace)"
      >
        {min.toFixed(0)} MB
      </text>
      <text
        x={PAD}
        y={PAD + 8}
        fontSize={9}
        fill="rgba(242,242,242,0.45)"
        fontFamily="var(--font-mono, monospace)"
      >
        {max.toFixed(0)} MB
      </text>
    </svg>
  );
}
