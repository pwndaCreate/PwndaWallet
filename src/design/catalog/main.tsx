/**
 * Catalog standalone Vite entry. Used by `npm run dev:catalog`.
 *
 * Renders only the design catalog — no AppStateProvider, no wallet,
 * no Tauri. The catalog is also reachable from inside the running
 * apps via `?design=1`; this entry skips that guard and mounts
 * unconditionally.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { DesignCatalog } from "./DesignCatalog";
import "../../styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DesignCatalog />
  </React.StrictMode>
);
