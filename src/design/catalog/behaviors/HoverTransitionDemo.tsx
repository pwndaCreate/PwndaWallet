import { useState } from "react";
import { Btn } from "../../primitives";

export function HoverTransitionDemo() {
  const [duration, setDuration] = useState(120);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        Hover state transitions
      </h1>
      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Structural. Standard <code>all .12s ease</code> on every interactive
        primitive. Hover any button below to feel the transition.
      </p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Btn variant="primary">primary</Btn>
        <Btn variant="ghost">ghost</Btn>
        <Btn variant="accent">accent</Btn>
        <Btn variant="danger">danger</Btn>
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
          <span>hover duration (ms)</span>
          <span>{duration}</span>
        </div>
        <input
          type="range"
          min={20}
          max={500}
          value={duration}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            setDuration(v);
            document.documentElement.style.setProperty("--motion-hover-duration", `${v}ms`);
          }}
          style={{ width: "100%" }}
        />
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
          Below ~80ms feels snappy; above ~250ms feels sluggish.
        </div>
      </div>
    </div>
  );
}
