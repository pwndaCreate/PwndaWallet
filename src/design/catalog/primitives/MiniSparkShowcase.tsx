import { MiniSpark } from "../../primitives";

const rising = Array.from({ length: 30 }, (_, i) => i + Math.random() * 4);
const choppy = Array.from({ length: 30 }, () => Math.random() * 10);
const declining = Array.from({ length: 30 }, (_, i) => 30 - i + Math.random() * 4);

export function MiniSparkShowcase() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        &lt;MiniSpark&gt;
      </h1>

      <Row label="rising"><MiniSpark values={rising} /></Row>
      <Row label="choppy"><MiniSpark values={choppy} color="var(--warn)" /></Row>
      <Row label="declining"><MiniSpark values={declining} color="var(--danger)" /></Row>

      <h2 style={h2}>fluid (fills container)</h2>
      <div style={{ width: "100%", border: "1px solid var(--border)", padding: 8 }}>
        <MiniSpark values={rising} fluid h={24} />
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <span style={{ fontSize: 10, color: "var(--text-dim)", width: 90 }}>{label}</span>
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
};
