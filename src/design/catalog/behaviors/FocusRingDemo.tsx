import { Btn } from "../../primitives";

export function FocusRingDemo() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        Focus-visible ring
      </h1>
      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Structural. Tab through the buttons + input below. Mouse focus does NOT
        show the ring; keyboard focus does. Token: <code>--border-hi</code>.
      </p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Btn>FIRST</Btn>
        <Btn>SECOND</Btn>
        <Btn variant="primary">THIRD</Btn>
        <input
          className="field"
          placeholder="Tab into me"
        />
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        Try Tab → Tab → Tab → Tab.
      </div>
    </div>
  );
}
