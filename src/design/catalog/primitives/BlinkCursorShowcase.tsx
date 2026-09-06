import { BlinkCursor } from "../../primitives";

export function BlinkCursorShowcase() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        &lt;BlinkCursor&gt;
      </h1>

      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 14, color: "var(--text)" }}>
        <span>$ pwnda</span> <BlinkCursor />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)" }}>
          › pwnda@vault : ~/wallet
        </span>
        <BlinkCursor color="var(--white)" />
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
        Step-end timing — no easing.
      </div>
    </div>
  );
}
