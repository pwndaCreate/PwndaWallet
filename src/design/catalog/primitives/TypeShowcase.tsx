export function TypeShowcase() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        Type scale
      </h1>

      <Row name="type-display"><span className="type-display">Display heading</span></Row>
      <Row name="type-hero"><span className="type-hero">12,345.67</span></Row>
      <Row name="type-hero-accent"><span className="type-hero-accent">142.3 H/s</span></Row>
      <Row name="type-label"><span className="type-label">SECTION LABEL</span></Row>
      <Row name="type-micro"><span className="type-micro">MICRO LABEL</span></Row>
      <Row name="type-body"><span className="type-body">Body / status copy</span></Row>
      <Row name="type-input"><span className="type-input">Input text</span></Row>
      <Row name="type-code"><span className="type-code">code: pwnda::wallet</span></Row>
      <Row name="hero-num"><span className="hero-num" style={{ fontSize: 28 }}>$1,234.56</span></Row>

      <h2 style={h2}>Color utilities</h2>
      <Row name="color-accent"><span className="color-accent">accent text</span></Row>
      <Row name="color-success"><span className="color-success">success text</span></Row>
      <Row name="color-danger"><span className="color-danger">danger text</span></Row>
      <Row name="color-warn"><span className="color-warn">warn text</span></Row>
      <Row name="color-muted"><span className="color-muted">muted text</span></Row>
      <Row name="color-dim"><span className="color-dim">dim text</span></Row>
    </div>
  );
}

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 16, padding: "6px 0", borderBottom: "1px solid var(--border-soft)" }}>
      <span style={{ fontSize: 9, color: "var(--text-dim)", width: 140, letterSpacing: 1, fontFamily: "var(--mono)" }}>
        .{name}
      </span>
      {children}
    </div>
  );
}

const h2: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  marginTop: 16,
};
