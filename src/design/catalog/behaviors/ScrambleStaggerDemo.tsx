import { useState } from "react";
import { ST } from "../../primitives";
import { staggerDelay } from "../../behaviors";

const ROWS = [
  "› balance              $12,345.67",
  "› address              0xabc…12345678",
  "› last sync            2 minutes ago",
  "› active chain         XMR",
  "› mining hashrate      142.3 H/s",
  "› dev fee              3%",
  "› node                 node.community.rino.io",
  "› version              v2.0.1",
];

export function ScrambleStaggerDemo() {
  const [stagger, setStagger] = useState(55);
  const [base, setBase] = useState(0);
  const [key, setKey] = useState(0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        Per-row scramble stagger
      </h1>
      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Apply <code>delay = base + idx * stagger</code> to scramble rows in
        sequence rather than all at once.
      </p>

      <div
        key={key}
        style={{
          padding: 16,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--text-muted)",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {ROWS.map((row, i) => (
          <ST key={i} delay={base + i * stagger} speed={20}>
            {row}
          </ST>
        ))}
      </div>

      <Slider label="stagger (ms/row)" value={stagger} min={0} max={200} onChange={setStagger} />
      <Slider label="base delay (ms)" value={base} min={0} max={1000} step={50} onChange={setBase} />

      <button onClick={() => setKey((k) => k + 1)} style={btn}>replay</button>
    </div>
  );
}

function Slider({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseInt(e.target.value, 10))} style={{ width: "100%" }} />
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 11,
  cursor: "pointer",
  alignSelf: "flex-start",
};

// Mark staggerDelay as used so it doesn't trip unused-import warnings if the
// snippet above gets refactored to inline math.
void staggerDelay;
