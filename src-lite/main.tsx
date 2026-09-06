import React from "react";
import ReactDOM from "react-dom/client";
import { LiteApp } from "./LiteApp";
import { AppStateLiteProvider } from "./state/AppStateLite";
import "../src/styles.css";

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
