import { PwndaWordmark } from "../../primitives";

export function WordmarkShowcase() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        &lt;PwndaWordmark&gt;
      </h1>

      {[11, 14, 18, 24, 32].map((s) => (
        <div key={s} style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <span style={{ fontSize: 10, color: "var(--text-dim)", width: 60 }}>size={s}</span>
          <PwndaWordmark size={s} />
        </div>
      ))}

      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)", width: 60 }}>no scan</span>
        <PwndaWordmark size={24} scan={false} />
      </div>
    </div>
  );
}
