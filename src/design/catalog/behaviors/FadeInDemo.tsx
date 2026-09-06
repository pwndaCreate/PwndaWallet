import { useState } from "react";
import { Card } from "../../primitives";

export function FadeInDemo() {
  const [key, setKey] = useState(0);
  const [duration, setDuration] = useState(250);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        Fade-in on mount
      </h1>
      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Structural. Applied to every <code>&lt;Card&gt;</code> and <code>&lt;Box&gt;</code>.
        opacity 0→1 + translateY 6→0.
      </p>

      <Card key={key} title="Replay to see the fade">
        <p style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-muted)" }}>
          The whole card re-mounts when you press the button below.
        </p>
      </Card>

      <button onClick={() => setKey((k) => k + 1)} style={btn}>replay</button>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
          <span>fade duration (ms)</span>
          <span>{duration}</span>
        </div>
        <input
          type="range"
          min={50}
          max={1000}
          value={duration}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            setDuration(v);
            document.documentElement.style.setProperty("--motion-fadein-duration", `${v}ms`);
          }}
          style={{ width: "100%" }}
        />
      </div>
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
