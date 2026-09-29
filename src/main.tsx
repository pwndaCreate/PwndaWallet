// MUST be the first import. As a side-effect, `./lib/tauri` installs the
// Claude-sandbox invoke + window.fetch shims. ethers `JsonRpcProvider`s probe
// the network (`eth_chainId`) at construction time, which happens while App's
// module graph loads — so the shims must be in place *before* `./App` is
// imported, or those early EVM probes race the shim and CORS-fail. Harmless
// in production (the shim body is dead-code-eliminated when not in the sandbox).
import "./lib/tauri";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppStateProvider } from "./state/AppStateContext";
import { installDevPerfTrackGuard, reactPerfTracksWanted } from "./lib/devPerfTrackGuard";
import { holdAmbientAnimationsWhileIdle } from "./lib/decorativeMotion";
import "./styles.css";

// Dev-only, before the first render: React 19.2's development build records a
// props diff per component render into the Performance timeline and nothing
// ever clears it — 13 GB of renderer memory over a mining night (2026-09-27).
// See `lib/devPerfTrackGuard.ts`. Dead-code-eliminated in production builds.
if (import.meta.env.DEV && !reactPerfTracksWanted()) {
  installDevPerfTrackGuard();
}

// Every build: hold infinite CSS animations still while nobody is using the
// window. WebView2 composites on the CPU here, so each one repaints the window
// every frame — the header's status-dot pulse alone cost ~60% of a core on the
// operator's display, all day (2026-09-29). See `lib/decorativeMotion.ts`.
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

// `?design=1` mounts the design catalog instead of the full app — only
// in dev. See `npm run dev:catalog` for the standalone catalog entry.
// See PwndaWalletVault/wiki/synthesis/design-system-modularization.md Phase 4.
const wantCatalog =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("design");

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (wantCatalog) {
  // Lazy import so the catalog code never lands in production bundles.
  import("./design/catalog/DesignCatalog").then(({ DesignCatalog }) => {
    root.render(
      <React.StrictMode>
        <DesignCatalog />
      </React.StrictMode>
    );
  });
} else {
  root.render(
    <React.StrictMode>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </React.StrictMode>
  );
}
