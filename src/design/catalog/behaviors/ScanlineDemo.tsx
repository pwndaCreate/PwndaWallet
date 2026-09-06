import { useState } from "react";

export function ScanlineDemo() {
  const [opacity, setOpacity] = useState(0.5);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        CRT scanlines
      </h1>
      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Signature. Page-level overlay via <code>.scanlines::after</code> on
        <code> .window-shell</code>. Opacity exposed as a Settings slider.
      </p>

      <div
        className="scanlines"
        style={{
          position: "relative",
          height: 200,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--mono)",
          fontSize: 16,
          color: "var(--white)",
        }}
      >
        TERMINAL OUTPUT
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
          <span>--scan-opacity</span>
          <span>{opacity.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setOpacity(v);
            document.documentElement.style.setProperty("--scan-opacity", String(v));
          }}
          style={{ width: "100%" }}
        />
      </div>
    </div>
  );
}
