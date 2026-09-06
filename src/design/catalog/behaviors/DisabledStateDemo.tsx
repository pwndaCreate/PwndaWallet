import { useState } from "react";
import { Btn } from "../../primitives";

export function DisabledStateDemo() {
  const [disabled, setDisabled] = useState(true);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        Disabled state
      </h1>
      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Structural. <code>--disabled-opacity = 0.4</code> +{" "}
        <code>cursor: not-allowed</code>. Disabled buttons do NOT scramble or
        transition.
      </p>

      <div style={{ display: "flex", gap: 12 }}>
        <Btn variant="primary" disabled={disabled}>DISABLED?</Btn>
        <Btn variant="ghost" disabled={disabled}>GHOST</Btn>
        <Btn variant="accent" disabled={disabled}>ACCENT</Btn>
        <Btn variant="danger" disabled={disabled}>DANGER</Btn>
      </div>

      <button
        onClick={() => setDisabled((d) => !d)}
        style={{
          padding: "8px 14px",
          background: "transparent",
          border: "1px solid var(--border)",
          color: "var(--text)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          cursor: "pointer",
          alignSelf: "flex-start",
        }}
      >
        toggle disabled ({disabled ? "currently disabled" : "currently enabled"})
      </button>
    </div>
  );
}
