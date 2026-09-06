import { AsciiDivider } from "../../primitives";

export function AsciiDividerShowcase() {
  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)", marginBottom: 24 }}>
        &lt;AsciiDivider&gt;
      </h1>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Section one</div>
      <AsciiDivider label="section break" />
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Section two</div>
      <AsciiDivider />
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>No-label form</div>
    </div>
  );
}
