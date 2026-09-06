import { useState } from "react";
import { Dot } from "../../primitives";

export function PulseDemo() {
  const [duration, setDuration] = useState(1400);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        Status dot pulse
      </h1>
      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Structural. Status indicators. Opacity 0.25↔1 + scale 0.75↔1.25. Token:
        <code> motion.pulse.duration</code>.
      </p>

      <div style={{ display: "flex", gap: 40, alignItems: "center", padding: 24, border: "1px solid var(--border)", background: "var(--surface)" }}>
        <Pair color="green" />
        <Pair color="red" />
        <Pair color="amber" />
        <Pair color="gray" />
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
          <span>pulse duration (ms)</span>
          <span>{duration}</span>
        </div>
        <input
          type="range"
          min={200}
          max={4000}
          value={duration}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            setDuration(v);
            document.documentElement.style.setProperty("--motion-pulse-duration", `${v}ms`);
          }}
          style={{ width: "100%" }}
        />
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
          Tip: lowering to ~600ms feels frantic; raising to ~2500ms feels calm.
          Use the Token Inspector to commit changes.
        </div>
      </div>
    </div>
  );
}

function Pair({ color }: { color: "green" | "red" | "amber" | "gray" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Dot color={color} size={8} />
      <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 1 }}>
        {color}
      </span>
    </div>
  );
}
