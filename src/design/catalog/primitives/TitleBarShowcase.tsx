import { TitleBar } from "../../shell";

export function TitleBarShowcase() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        &lt;TitleBar&gt;
      </h1>

      <Row label="synced (green)">
        <TitleBar syncLabel="synced" syncColor="green" />
      </Row>
      <Row label="syncing (amber)">
        <TitleBar syncLabel="XMR sync 87%" syncColor="amber" />
      </Row>
      <Row label="offline (red)">
        <TitleBar syncLabel="offline" syncColor="red" />
      </Row>
      <Row label="unknown (gray)">
        <TitleBar syncLabel="—" syncColor="gray" />
      </Row>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
        In browser mode (dev:web, dev:catalog), OS controls are hidden via{" "}
        <code>isTauri()</code> shim. Hover the close X in a real Tauri build to
        confirm it stays scoped.
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }}>{label}</div>
      <div style={{ border: "1px solid var(--border)" }}>{children}</div>
    </div>
  );
}
