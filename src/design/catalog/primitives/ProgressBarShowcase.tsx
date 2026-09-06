import { useState, useEffect } from "react";
import { ProgressBar } from "../../primitives";

export function ProgressBarShowcase() {
  const [n, setN] = useState(35);
  useEffect(() => {
    const t = setInterval(() => setN((v) => (v + 3) % 100), 200);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 480 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        &lt;ProgressBar&gt;
      </h1>

      <Row label={`${n}%`}><ProgressBar percent={n} /></Row>
      <Row label="50%"><ProgressBar percent={50} /></Row>
      <Row label="100%"><ProgressBar percent={100} /></Row>
      <Row label="danger"><ProgressBar percent={70} color="var(--danger)" /></Row>
      <Row label="14 segments"><ProgressBar percent={n} segments={14} /></Row>
      <Row label="tall"><ProgressBar percent={60} height={12} /></Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ fontSize: 10, color: "var(--text-dim)", width: 70 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
