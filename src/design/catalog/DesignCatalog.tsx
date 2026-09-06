/**
 * <DesignCatalog> — root catalog view.
 *
 * Four sections in a left sidebar:
 *   - Tokens (TokenInspector + theme switcher + motion override)
 *   - Primitives (one Showcase per primitive)
 *   - Behaviors (one Demo per behavior from BEHAVIORS.md)
 *   - Compositions (real views via MockProvider)
 *
 * The catalog auto-filters by VITE_BUILD_VARIANT — `lite` hides
 * compositions and primitives that lite never uses.
 */

import React, { useState, useEffect } from "react";
import { applyAccent, readAccent } from "../themes";
import { isLite } from "../env";
import { TokenInspector } from "./TokenInspector";
import { ButtonShowcase } from "./primitives/ButtonShowcase";
import { CardShowcase } from "./primitives/CardShowcase";
import { DotShowcase } from "./primitives/DotShowcase";
import { AsciiDividerShowcase } from "./primitives/AsciiDividerShowcase";
import { MiniSparkShowcase } from "./primitives/MiniSparkShowcase";
import { ProgressBarShowcase } from "./primitives/ProgressBarShowcase";
import { BlinkCursorShowcase } from "./primitives/BlinkCursorShowcase";
import { WordmarkShowcase } from "./primitives/WordmarkShowcase";
import { TypeShowcase } from "./primitives/TypeShowcase";
import { TitleBarShowcase } from "./primitives/TitleBarShowcase";
import { BottomNavShowcase } from "./primitives/BottomNavShowcase";
import { ScrambleMountDemo } from "./behaviors/ScrambleMountDemo";
import { ScrambleHoverDemo } from "./behaviors/ScrambleHoverDemo";
import { ScrambleStaggerDemo } from "./behaviors/ScrambleStaggerDemo";
import { PulseDemo } from "./behaviors/PulseDemo";
import { BlinkDemo } from "./behaviors/BlinkDemo";
import { FadeInDemo } from "./behaviors/FadeInDemo";
import { ScanlineDemo } from "./behaviors/ScanlineDemo";
import { HoverTransitionDemo } from "./behaviors/HoverTransitionDemo";
import { FocusRingDemo } from "./behaviors/FocusRingDemo";
import { DisabledStateDemo } from "./behaviors/DisabledStateDemo";

type Section = "tokens" | "primitives" | "behaviors" | "compositions";
type View = { section: Section; id: string };

const PRIMITIVES: { id: string; label: string; render: () => React.ReactNode }[] = [
  { id: "type", label: "Type scale", render: () => <TypeShowcase /> },
  { id: "btn", label: "<Btn>", render: () => <ButtonShowcase /> },
  { id: "card", label: "<Card>", render: () => <CardShowcase /> },
  { id: "dot", label: "<Dot>", render: () => <DotShowcase /> },
  { id: "wordmark", label: "<PwndaWordmark>", render: () => <WordmarkShowcase /> },
  { id: "ascii", label: "<AsciiDivider>", render: () => <AsciiDividerShowcase /> },
  { id: "spark", label: "<MiniSpark>", render: () => <MiniSparkShowcase /> },
  { id: "progress", label: "<ProgressBar>", render: () => <ProgressBarShowcase /> },
  { id: "blink", label: "<BlinkCursor>", render: () => <BlinkCursorShowcase /> },
  { id: "titlebar", label: "<TitleBar>", render: () => <TitleBarShowcase /> },
  { id: "bottomnav", label: "<BottomNav>", render: () => <BottomNavShowcase /> },
];

const BEHAVIORS: { id: string; label: string; render: () => React.ReactNode }[] = [
  { id: "scramble-mount", label: "Scramble decode-on-mount", render: () => <ScrambleMountDemo /> },
  { id: "scramble-hover", label: "Scramble-on-hover", render: () => <ScrambleHoverDemo /> },
  { id: "scramble-stagger", label: "Per-row stagger", render: () => <ScrambleStaggerDemo /> },
  { id: "pulse", label: "Status dot pulse", render: () => <PulseDemo /> },
  { id: "blink", label: "Cursor blink", render: () => <BlinkDemo /> },
  { id: "fadein", label: "Fade-in on mount", render: () => <FadeInDemo /> },
  { id: "scanline", label: "CRT scanlines", render: () => <ScanlineDemo /> },
  { id: "hover", label: "Hover transitions", render: () => <HoverTransitionDemo /> },
  { id: "focus", label: "Focus-visible ring", render: () => <FocusRingDemo /> },
  { id: "disabled", label: "Disabled state", render: () => <DisabledStateDemo /> },
];

export function DesignCatalog() {
  const [view, setView] = useState<View>({ section: "tokens", id: "inspector" });
  const lite = isLite();

  useEffect(() => {
    applyAccent(readAccent());
  }, []);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "240px 1fr",
        height: "100vh",
        fontFamily: "var(--mono)",
        color: "var(--text)",
        background: "var(--bg)",
      }}
    >
      <aside
        style={{
          borderRight: "1px solid var(--border)",
          padding: 16,
          overflowY: "auto",
          background: "var(--bg-2)",
        }}
      >
        <div style={{ marginBottom: 24 }}>
          <div
            style={{
              fontFamily: "var(--pixel)",
              fontSize: 14,
              letterSpacing: 2,
              color: "var(--white)",
              marginBottom: 4,
            }}
          >
            PWNDA · DESIGN
          </div>
          <div style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: 1 }}>
            CATALOG {lite ? "· LITE" : ""}
          </div>
        </div>

        <NavSection title="Tokens">
          <NavItem
            active={view.section === "tokens"}
            onClick={() => setView({ section: "tokens", id: "inspector" })}
          >
            Token inspector
          </NavItem>
        </NavSection>

        <NavSection title="Primitives">
          {PRIMITIVES.map((p) => (
            <NavItem
              key={p.id}
              active={view.section === "primitives" && view.id === p.id}
              onClick={() => setView({ section: "primitives", id: p.id })}
            >
              {p.label}
            </NavItem>
          ))}
        </NavSection>

        <NavSection title="Behaviors">
          {BEHAVIORS.map((b) => (
            <NavItem
              key={b.id}
              active={view.section === "behaviors" && view.id === b.id}
              onClick={() => setView({ section: "behaviors", id: b.id })}
            >
              {b.label}
            </NavItem>
          ))}
        </NavSection>

        {!lite && (
          <NavSection title="Compositions">
            <NavItem
              active={view.section === "compositions" && view.id === "todo"}
              onClick={() => setView({ section: "compositions", id: "todo" })}
            >
              (placeholder — see below)
            </NavItem>
          </NavSection>
        )}

        <div
          style={{
            marginTop: 24,
            paddingTop: 16,
            borderTop: "1px solid var(--border-soft)",
            fontSize: 9,
            color: "var(--text-dim)",
            lineHeight: 1.5,
          }}
        >
          <div style={{ marginBottom: 6 }}>URL overrides:</div>
          <div>?theme=amber|cyan|red|green</div>
          <div>?pulse=700&hover=240</div>
        </div>
      </aside>

      <main
        style={{
          padding: 24,
          overflowY: "auto",
          minHeight: 0,
        }}
      >
        {view.section === "tokens" && <TokenInspector />}
        {view.section === "primitives" &&
          PRIMITIVES.find((p) => p.id === view.id)?.render()}
        {view.section === "behaviors" &&
          BEHAVIORS.find((b) => b.id === view.id)?.render()}
        {view.section === "compositions" && (
          <div style={{ color: "var(--text-muted)" }}>
            <h2 style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--white)" }}>
              Compositions
            </h2>
            <p style={{ fontSize: 12, lineHeight: 1.6, marginTop: 12 }}>
              Composition previews render the real feature views (DashboardView,
              MiningView, etc.) wrapped in a <code>MockProvider</code>. They live
              at <code>src/design/catalog/compositions/</code> and are the only
              design files allowed to import from <code>src/features/**</code>{" "}
              (boundary-check exemption).
            </p>
            <p style={{ fontSize: 12, lineHeight: 1.6, marginTop: 12 }}>
              Placeholder — wire individual compositions by editing
              <code> DesignCatalog.tsx</code> + scaffolding under{" "}
              <code>compositions/</code>.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function NavSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontSize: 9,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: "var(--text-dim)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{children}</div>
    </div>
  );
}

function NavItem({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "var(--accent-soft)" : "transparent",
        border: "none",
        borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
        color: active ? "var(--accent)" : "var(--text-muted)",
        textAlign: "left",
        padding: "5px 10px",
        fontFamily: "var(--mono)",
        fontSize: 11,
        cursor: "pointer",
        letterSpacing: 0.3,
      }}
    >
      {children}
    </button>
  );
}
