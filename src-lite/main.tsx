import React from "react";
import ReactDOM from "react-dom/client";
import { LiteApp } from "./LiteApp";
import { AppStateLiteProvider } from "./state/AppStateLite";
import { installDevPerfTrackGuard, reactPerfTracksWanted } from "../src/lib/devPerfTrackGuard";
import { holdAmbientAnimationsWhileIdle } from "../src/lib/decorativeMotion";
import "../src/styles.css";

// Dev-only: see `src/lib/devPerfTrackGuard.ts` (mining past the 1-hour sample
// window made React's dev render log grow the renderer ~25–45 MB/min).
if (import.meta.env.DEV && !reactPerfTracksWanted()) {
  installDevPerfTrackGuard();
}

// Every build: infinite CSS animations are held still while nobody is using the
// window — see `src/lib/decorativeMotion.ts` (CPU-only compositing, 2026-09-29).
holdAmbientAnimationsWhileIdle();

if (import.meta.env.VITE_DEV_INSTANCE === "sandbox") {
  // eslint-disable-next-line no-console
  console.info(
    "[dev-sandbox] active, mode:",
    import.meta.env.MODE,
    "mock state:",
    import.meta.env.VITE_MOCK_STATE ?? "(unset)"
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppStateLiteProvider>
      <LiteApp />
    </AppStateLiteProvider>
  </React.StrictMode>
);
