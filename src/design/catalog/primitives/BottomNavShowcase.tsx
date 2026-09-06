import { useState } from "react";
import { BottomNav, type TabId } from "../../shell";

export function BottomNavShowcase() {
  const [tab, setTab] = useState<TabId>("wallet");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--white)" }}>
        &lt;BottomNav&gt;
      </h1>
      <div style={{ border: "1px solid var(--border)" }}>
        <BottomNav tab={tab} setTab={setTab} />
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        Active: <code>{tab}</code>
      </div>
    </div>
  );
}
