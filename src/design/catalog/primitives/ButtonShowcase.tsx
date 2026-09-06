import { Btn, type BtnVariant, type BtnSize } from "../../primitives";

const VARIANTS: BtnVariant[] = ["primary", "ghost", "accent", "danger"];
const SIZES: BtnSize[] = ["sm", "md", "lg"];

export function ButtonShowcase() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        &lt;Btn&gt;
      </h1>

      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
        Every variant × size. Hover any to see the scramble. See <code>BEHAVIORS.md</code> §
        Scramble-on-hover.
      </div>

      <table
        style={{
          borderCollapse: "collapse",
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--text-muted)",
        }}
      >
        <thead>
          <tr>
            <th style={th}></th>
            {SIZES.map((s) => (
              <th key={s} style={th}>{s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {VARIANTS.map((v) => (
            <tr key={v}>
              <td style={td}>{v}</td>
              {SIZES.map((s) => (
                <td key={s} style={td}>
                  <Btn variant={v} size={s}>{`${v} ${s}`}</Btn>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={h2}>States</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Btn variant="primary">primary</Btn>
        <Btn variant="primary" disabled>disabled</Btn>
        <Btn variant="primary" caret>with caret</Btn>
        <Btn variant="primary" full>full-width</Btn>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "8px 16px",
  textAlign: "left",
  letterSpacing: 1,
  textTransform: "uppercase",
  borderBottom: "1px solid var(--border-soft)",
  fontWeight: 500,
};
const td: React.CSSProperties = {
  padding: "10px 16px",
  borderBottom: "1px solid var(--border-soft)",
};
const h2: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--text-muted)",
};
