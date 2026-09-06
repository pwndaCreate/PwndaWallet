import { Btn } from "../../primitives";

export function ScrambleHoverDemo() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        Scramble-on-hover
      </h1>
      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Signature behavior. Fires on <code>onMouseEnter</code>, resets on <code>onMouseLeave</code>.
        Disabled buttons do NOT scramble.
      </p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Btn variant="primary">PRIMARY ACTION</Btn>
        <Btn variant="ghost">GHOST ACTION</Btn>
        <Btn variant="accent">START MINING</Btn>
        <Btn variant="danger">STOP / FORGET</Btn>
        <Btn variant="ghost" disabled>DISABLED (no scramble)</Btn>
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
        Speed: <code>motion.scramble.hover.speed</code> = 38ms/frame. Use the
        Token Inspector to retime if needed.
      </div>
    </div>
  );
}
