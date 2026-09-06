/**
 * src/design/themes.ts
 *
 * Theme variants. Currently only the accent block swaps — the rest of
 * the token tree is shared across themes. A `light` mode is scaffolded
 * for future use but not wired into any view.
 *
 * Theme persistence: `localStorage["pwnda.theme"]`. URL override:
 * `?theme=amber`. See `src/design/catalog/TokenInspector.tsx` for the
 * live switcher.
 */

export type Accent = "green" | "amber" | "cyan" | "red";
export type Mode = "dark" | "light";

export const accents: Record<Accent, { base: string; soft: string; mid: string; glow: string }> = {
  green: {
    base: "#00ff66",
    soft: "rgba(0,255,102,0.10)",
    mid: "rgba(0,255,102,0.25)",
    glow: "rgba(0,255,102,0.06)",
  },
  amber: {
    base: "#ffaa00",
    soft: "rgba(255,170,0,0.10)",
    mid: "rgba(255,170,0,0.25)",
    glow: "rgba(255,170,0,0.06)",
  },
  cyan: {
    base: "#00e5ff",
    soft: "rgba(0,229,255,0.10)",
    mid: "rgba(0,229,255,0.25)",
    glow: "rgba(0,229,255,0.06)",
  },
  red: {
    base: "#ff3b3b",
    soft: "rgba(255,59,59,0.10)",
    mid: "rgba(255,59,59,0.25)",
    glow: "rgba(255,59,59,0.06)",
  },
};

export const modes: Record<Mode, { /* future light-mode token overrides go here */ }> = {
  dark: {},
  // Light mode scaffolded — values intentionally empty until the design
  // system picks light-mode palette. Wiring it on later is one-PR work.
  light: {},
};

/** Apply an accent theme by rewriting CSS variables on :root. */
export function applyAccent(accent: Accent) {
  if (typeof document === "undefined") return;
  const a = accents[accent];
  const r = document.documentElement.style;
  r.setProperty("--accent", a.base);
  r.setProperty("--accent-soft", a.soft);
  r.setProperty("--accent-mid", a.mid);
  r.setProperty("--accent-glow", a.glow);
  r.setProperty("--green", a.base);
  r.setProperty("--green-dim", a.soft);
  r.setProperty("--green-glow", a.glow);
}

/** Read the current accent from localStorage + URL overrides. */
export function readAccent(): Accent {
  if (typeof window === "undefined") return "green";
  const url = new URLSearchParams(window.location.search).get("theme");
  if (url && url in accents) return url as Accent;
  const stored = localStorage.getItem("pwnda.theme");
  if (stored && stored in accents) return stored as Accent;
  return "green";
}

export function writeAccent(accent: Accent) {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("pwnda.theme", accent);
  }
  applyAccent(accent);
}
