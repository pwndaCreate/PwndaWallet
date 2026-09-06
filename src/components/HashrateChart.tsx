// Task-Manager / Resource-Monitor style chart. Dithered grid
// bg, monochrome line + hatched fill area, stats ticker.

import { useEffect, useRef, useState } from "react";

export function HashrateChart({
  samples = [],
  max,
  windowS = 60,
  unit = "H/s",
  format = (v: number) => Math.round(v).toString(),
  height = 130,
  active = true,
}: {
  samples?: number[];
  max: number;
  windowS?: number;
  unit?: string;
  format?: (v: number) => string;
  height?: number;
  active?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(340);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(120, Math.floor(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = samples.length;
  const current = n ? samples[n - 1] : 0;
  const peak = n ? Math.max(...samples) : 0;
  const avg = n ? samples.reduce((a, b) => a + b, 0) / n : 0;

  const gridCols = 12;
  const gridRows = 4;
  const padL = 42;
  const padR = 6;
  const padT = 6;
  const padB = 14;
  const cx = w - padL - padR;
  const cy = height - padT - padB;

  const capacity = 60;
  const toX = (i: number) => padL + (i / (capacity - 1)) * cx;
  const toY = (v: number) => padT + cy - Math.min(1, v / (max || 1)) * cy;

  let linePath = "";
  let areaPath = "";
  if (n > 1) {
    const offset = capacity - n;
    for (let i = 0; i < n; i++) {
      const x = toX(offset + i);
      const y = toY(samples[i]);
      linePath += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
    }
    const firstX = toX(offset);
    const lastX = toX(offset + n - 1);
    const baselineY = padT + cy;
    areaPath =
      `M ${firstX} ${baselineY} ` + linePath.replace(/^M/, "L") + ` L ${lastX} ${baselineY} Z`;
  }

  const yTicks: { y: number; label: string }[] = [];
  for (let i = 0; i <= gridRows; i++) {
    const frac = 1 - i / gridRows;
    const v = max * frac;
    yTicks.push({ y: padT + (i / gridRows) * cy, label: format(v) });
  }

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        width="100%"
        height={height}
        style={{ display: "block", fontFamily: "'JetBrains Mono',monospace" }}
        shapeRendering="geometricPrecision"
      >
        <defs>
          <pattern
            id="hatch-hr"
            patternUnits="userSpaceOnUse"
            width="4"
            height="4"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(242,242,242,0.28)" strokeWidth="1" />
          </pattern>
          <linearGradient id="fade-hr" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(242,242,242,0.22)" />
            <stop offset="100%" stopColor="rgba(242,242,242,0.02)" />
          </linearGradient>
        </defs>

        <rect
          x={padL}
          y={padT}
          width={cx}
          height={cy}
          fill="#0a0a0a"
          stroke="rgba(255,255,255,0.18)"
          strokeWidth="1"
        />

        {Array.from({ length: gridRows - 1 }).map((_, i) => {
          const y = padT + ((i + 1) / gridRows) * cy;
          return (
            <line
              key={`gh${i}`}
              x1={padL}
              y1={y}
              x2={padL + cx}
              y2={y}
              stroke="rgba(255,255,255,0.08)"
              strokeDasharray="1 3"
            />
          );
        })}
        {Array.from({ length: gridCols - 1 }).map((_, i) => {
          const x = padL + ((i + 1) / gridCols) * cx;
          return (
            <line
              key={`gv${i}`}
              x1={x}
              y1={padT}
              x2={x}
              y2={padT + cy}
              stroke="rgba(255,255,255,0.08)"
              strokeDasharray="1 3"
            />
          );
        })}

        {yTicks.map((t, i) => (
          <g key={`yt${i}`}>
            <text
              x={padL - 6}
              y={t.y + 3}
              textAnchor="end"
              fontSize="8.5"
              fill="rgba(242,242,242,0.55)"
              letterSpacing="0.5"
            >
              {t.label}
            </text>
          </g>
        ))}

        {areaPath && (
          <>
            <path d={areaPath} fill="url(#fade-hr)" />
            <path d={areaPath} fill="url(#hatch-hr)" />
          </>
        )}

        {linePath && (
          <>
            <path
              d={linePath}
              fill="none"
              stroke="rgba(242,242,242,0.9)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                filter: active ? "drop-shadow(0 0 3px rgba(242,242,242,0.5))" : "none",
              }}
            />
            {n > 0 &&
              (() => {
                const offset = capacity - n;
                const lx = toX(offset + n - 1);
                const ly = toY(samples[n - 1]);
                return (
                  <g>
                    <circle
                      cx={lx}
                      cy={ly}
                      r={2.5}
                      fill="#f2f2f2"
                      style={{
                        filter: active ? "drop-shadow(0 0 4px rgba(242,242,242,0.8))" : "none",
                      }}
                    />
                    {active && (
                      <circle
                        cx={lx}
                        cy={ly}
                        r={5}
                        fill="none"
                        stroke="rgba(242,242,242,0.5)"
                        strokeWidth="1"
                      >
                        <animate
                          attributeName="r"
                          values="2.5;8;2.5"
                          dur="1.4s"
                          repeatCount="indefinite"
                        />
                        <animate
                          attributeName="opacity"
                          values="0.6;0;0.6"
                          dur="1.4s"
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}
                  </g>
                );
              })()}
          </>
        )}

        {[
          [padL, padT],
          [padL + cx, padT],
          [padL, padT + cy],
          [padL + cx, padT + cy],
        ].map(([x, y], i) => (
          <g key={`c${i}`} stroke="rgba(242,242,242,0.5)" strokeWidth="1">
            <line x1={x - 2} y1={y} x2={x + 2} y2={y} />
            <line x1={x} y1={y - 2} x2={x} y2={y + 2} />
          </g>
        ))}

        <text
          x={padL}
          y={padT + cy + 11}
          fontSize="8.5"
          fill="rgba(242,242,242,0.45)"
          letterSpacing="0.5"
        >
          -{windowS}s
        </text>
        <text
          x={padL + cx}
          y={padT + cy + 11}
          textAnchor="end"
          fontSize="8.5"
          fill="rgba(242,242,242,0.45)"
          letterSpacing="0.5"
        >
          now
        </text>
      </svg>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          marginTop: 6,
          border: "1px solid rgba(255,255,255,0.12)",
          background: "#0a0a0a",
        }}
      >
        {(
          [
            ["CUR", format(current) + " " + unit, "#f2f2f2", true],
            ["PEAK", format(peak) + " " + unit, "rgba(242,242,242,0.85)", false],
            ["AVG", format(avg) + " " + unit, "rgba(242,242,242,0.7)", false],
            ["n", `${n}/${capacity}`, "rgba(242,242,242,0.55)", false],
          ] as [string, string, string, boolean][]
        ).map(([k, v, c, glow], i) => (
          <div
            key={k}
            style={{
              padding: "6px 6px 5px",
              borderRight: i < 3 ? "1px solid rgba(255,255,255,0.08)" : "none",
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontSize: 8,
                letterSpacing: 1,
                color: "rgba(242,242,242,0.4)",
                textTransform: "uppercase",
                marginBottom: 2,
              }}
            >
              {k}
            </div>
            <div
              style={{
                fontSize: 11,
                letterSpacing: 0.5,
                color: c,
                textShadow: glow ? "0 0 4px rgba(242,242,242,0.4)" : "none",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {v}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
