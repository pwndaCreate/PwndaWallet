import { Dot } from "../../primitives";

export function DotShowcase() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>&lt;Dot&gt;</h1>

      <div style={{ display: "flex", gap: 32, alignItems: "center" }}>
        {(["green", "red", "amber", "gray"] as const).map((c) => (
          <div key={c} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Dot color={c} />
            <span style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: 1 }}>
              {c}
            </span>
          </div>
        ))}
      </div>

      <h2 style={h2}>Size sweep</h2>
      <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
        {[4, 6, 8, 12, 18].map((s) => (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Dot color="green" size={s} />
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{s}px</span>
          </div>
        ))}
      </div>
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
