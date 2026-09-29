import React from "react";
import ReactDOM from "react-dom/client";
import { LiteApp } from "./LiteApp";
import { AppStateLiteProvider } from "./state/AppStateLite";
import { installDevPerfTrackGuard, reactPerfTracksWanted } from "../src/lib/devPerfTrackGuard";
import "../src/styles.css";

// Dev-only: see `src/lib/devPerfTrackGuard.ts` (mining past the 1-hour sample
// window made React's dev render log grow the renderer ~25–45 MB/min).
if (import.meta.env.DEV && !reactPerfTracksWanted()) {
  installDevPerfTrackGuard();
}

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
