import { Card, Btn } from "../../primitives";

export function CardShowcase() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 480 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        &lt;Card&gt;
      </h1>

      <Card title="Header strip + body">
        <p style={p}>Standard card. Body padding default 14.</p>
      </Card>

      <Card title="With right element" right={<Btn size="sm">action</Btn>}>
        <p style={p}>The <code>right</code> prop slots an element in the header bar.</p>
      </Card>

      <Card>
        <p style={p}>No title — body-only card.</p>
      </Card>

      <Card title="Custom padding" pad={28}>
        <p style={p}>Body padding overridden to 28px.</p>
      </Card>

      <Card title="Flush body" padded={false}>
        <div style={{ background: "var(--bg-2)", padding: "14px 16px", fontSize: 11, color: "var(--text-muted)" }}>
          <code>padded=false</code> — body renders flush.
        </div>
      </Card>

      <Card title="Nested">
        <Card title="Inner" pad={10}>
          <p style={{ ...p, margin: 0 }}>Cards nest fine.</p>
        </Card>
      </Card>
    </div>
  );
}

const p: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 12,
  color: "var(--text-muted)",
  lineHeight: 1.5,
  margin: 0,
};
