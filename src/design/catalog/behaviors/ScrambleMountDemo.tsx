import { useState } from "react";
import { ST } from "../../primitives";

export function ScrambleMountDemo() {
  const [speed, setSpeed] = useState(26);
  const [text, setText] = useState("PWNDA WALLET — TERMINAL");
  const [delay, setDelay] = useState(0);
  const [key, setKey] = useState(0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        Scramble decode-on-mount
      </h1>
      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Signature behavior. Fires on mount + every <code>text</code> change.
        See <code>BEHAVIORS.md</code>.
      </p>

      <div style={{ padding: 24, border: "1px solid var(--border)", background: "var(--surface)" }} key={key}>
        <ST speed={speed} delay={delay}>{text}</ST>
      </div>

      <Slider label="speed (ms/frame)" value={speed} min={8} max={80} onChange={setSpeed} />
      <Slider label="delay (ms)" value={delay} min={0} max={2000} step={50} onChange={setDelay} />

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1, background: "#060606", border: "1px solid var(--border)", color: "var(--text)", padding: "8px 10px", fontFamily: "var(--mono)", fontSize: 12 }}
        />
        <button
          onClick={() => setKey((k) => k + 1)}
          style={btn}
        >
          replay
        </button>
      </div>
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
  letterSpacing: 0.5,
  cursor: "pointer",
};
