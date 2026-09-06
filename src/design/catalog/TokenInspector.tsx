/**
 * <TokenInspector> — token swatches + theme switcher + motion overrides.
 *
 * Live-edits :root CSS variables via the override panel. The "Copy as
 * tokens.ts patch" button outputs a diff the agent can paste into
 * src/design/tokens.ts.
 */

import { useEffect, useState } from "react";
import { tokens } from "../tokens";
import { accents, readAccent, writeAccent, type Accent } from "../themes";

const MOTION_VARS: { name: string; label: string; default: number; min: number; max: number }[] = [
  { name: "--motion-pulse-duration", label: "pulse", default: tokens.motion.pulse.duration, min: 200, max: 4000 },
  { name: "--motion-blink-duration", label: "blink", default: tokens.motion.blink.duration, min: 200, max: 4000 },
  { name: "--motion-fadein-duration", label: "fadeIn", default: tokens.motion.fadeIn.duration, min: 50, max: 1000 },
  { name: "--motion-hover-duration", label: "hover", default: tokens.motion.hover.duration, min: 50, max: 500 },
  { name: "--motion-mining-duration", label: "miningPulse", default: tokens.motion.miningPulse.duration, min: 200, max: 3000 },
];

export function TokenInspector() {
  const [accent, setAccentState] = useState<Accent>(readAccent());
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [scanOpacity, setScanOpacity] = useState<number>(tokens.crt.scanOpacity);

  useEffect(() => {
    // Parse URL motion overrides on mount: ?pulse=700&hover=240
    const params = new URLSearchParams(window.location.search);
    const initial: Record<string, number> = {};
    for (const v of MOTION_VARS) {
      const param = params.get(v.label.toLowerCase());
      if (param) {
        const n = parseInt(param, 10);
        if (!isNaN(n)) {
          initial[v.name] = n;
          document.documentElement.style.setProperty(v.name, `${n}ms`);
        }
      }
    }
    setOverrides(initial);
  }, []);

  function setAccent(a: Accent) {
    writeAccent(a);
    setAccentState(a);
  }

  function setMotion(name: string, value: number) {
    document.documentElement.style.setProperty(name, `${value}ms`);
    setOverrides({ ...overrides, [name]: value });
  }

  function setScan(opacity: number) {
    document.documentElement.style.setProperty("--scan-opacity", String(opacity));
    setScanOpacity(opacity);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <header>
        <h1 style={{ fontFamily: "var(--pixel)", fontSize: 18, letterSpacing: 2, color: "var(--white)" }}>
          TOKEN INSPECTOR
        </h1>
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
          Live edit `:root` CSS variables. Theme persists to localStorage.
          Motion overrides survive the page session. Use the "Copy patch" button
          to paste edits back into <code>src/design/tokens.ts</code>.
        </p>
      </header>

      {/* ── Theme ───────────────────────────────────────────── */}
      <Section title="Theme">
        <div style={{ display: "flex", gap: 8 }}>
          {(Object.keys(accents) as Accent[]).map((a) => (
            <button
              key={a}
              onClick={() => setAccent(a)}
              style={{
                padding: "8px 14px",
                fontFamily: "var(--mono)",
                fontSize: 11,
                letterSpacing: 1,
                textTransform: "uppercase",
                background: accent === a ? accents[a].soft : "transparent",
                border: `1px solid ${accent === a ? accents[a].base : "var(--border)"}`,
                color: accent === a ? accents[a].base : "var(--text-muted)",
                cursor: "pointer",
                transition: "all .12s ease",
              }}
            >
              {a}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8 }}>
          Saved to <code>localStorage["pwnda.theme"]</code>. URL override:
          <code> ?theme={accent}</code>
        </p>
      </Section>

      {/* ── Color swatches ─────────────────────────────────── */}
      <Section title="Colors">
        <Swatches
          rows={[
            ["bg.base", "#000000"],
            ["bg.2", "#0a0a0a"],
            ["bg.surface", "#0d0d0d"],
            ["bg.surface-2", "#111111"],
            ["text.default", "var(--text)"],
            ["text.muted", "var(--text-muted)"],
            ["text.dim", "var(--text-dim)"],
            ["text.white", "var(--white)"],
            ["accent", "var(--accent)"],
            ["accent.soft", "var(--accent-soft)"],
            ["accent.mid", "var(--accent-mid)"],
            ["success", "var(--success)"],
            ["danger", "var(--danger)"],
            ["warn", "var(--warn)"],
            ["border", "var(--border)"],
            ["border.hi", "var(--border-hi)"],
            ["border.soft", "var(--border-soft)"],
          ]}
        />
      </Section>

      {/* ── Type scale ─────────────────────────────────────── */}
      <Section title="Type scale (mono)">
        {Object.entries(tokens.type.scale).map(([k, v]) => (
          <div
            key={k}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 16,
              padding: "4px 0",
              borderBottom: "1px solid var(--border-soft)",
            }}
          >
            <span style={{ fontSize: 10, color: "var(--text-dim)", width: 80 }}>
              {k} ({v}px)
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: v, color: "var(--white)" }}>
              The quick brown fox 0123
            </span>
          </div>
        ))}
      </Section>

      {/* ── Spacing scale ──────────────────────────────────── */}
      <Section title="Spacing scale">
        {Object.entries(tokens.space).map(([k, v]) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 16, padding: "2px 0" }}>
            <span style={{ fontSize: 10, color: "var(--text-dim)", width: 80 }}>space.{k} ({v}px)</span>
            <div style={{ height: 10, width: v, background: "var(--accent)" }} />
          </div>
        ))}
      </Section>

      {/* ── Motion overrides ───────────────────────────────── */}
      <Section title="Motion overrides">
        <p style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 12 }}>
          Edits write to <code>:root</code> live. Page reload reverts (unless URL params persist them).
        </p>
        {MOTION_VARS.map((v) => {
          const current = overrides[v.name] ?? v.default;
          return (
            <div key={v.name} style={{ marginBottom: 12 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginBottom: 4,
                }}
              >
                <span>
                  {v.label} <code style={{ fontSize: 9, color: "var(--text-dim)" }}>{v.name}</code>
                </span>
                <span>{current}ms</span>
              </div>
              <input
                type="range"
                min={v.min}
                max={v.max}
                value={current}
                onChange={(e) => setMotion(v.name, parseInt(e.target.value, 10))}
                style={{ width: "100%" }}
              />
            </div>
          );
        })}
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11,
              color: "var(--text-muted)",
              marginBottom: 4,
            }}
          >
            <span>scan opacity (CRT)</span>
            <span>{scanOpacity}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={scanOpacity}
            onChange={(e) => setScan(parseFloat(e.target.value))}
            style={{ width: "100%" }}
          />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: "var(--text-muted)",
          paddingBottom: 6,
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Swatches({ rows }: { rows: [string, string][] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
        gap: 10,
      }}
    >
      {rows.map(([name, color]) => (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 28,
              height: 28,
              background: color,
              border: "1px solid var(--border)",
              flexShrink: 0,
            }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, color: "var(--white)", fontFamily: "var(--mono)" }}>{name}</div>
            <div style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>{color}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
