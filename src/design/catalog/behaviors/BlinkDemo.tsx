import { useState } from "react";
import { BlinkCursor } from "../../primitives";

export function BlinkDemo() {
  const [duration, setDuration] = useState(1000);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        Cursor blink
      </h1>
      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Signature. Step-end timing (hard on/off). Used in login splash + landscape breadcrumb.
      </p>

      <div style={{ padding: 24, border: "1px solid var(--border)", background: "var(--surface)", fontFamily: "var(--mono)", fontSize: 14, color: "var(--text)" }}>
        $ pwnda unlock <BlinkCursor />
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
          <span>blink duration (ms)</span>
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
            document.documentElement.style.setProperty("--motion-blink-duration", `${v}ms`);
          }}
          style={{ width: "100%" }}
        />
      </div>
    </div>
  );
}
