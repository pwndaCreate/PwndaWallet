import { invoke } from "../lib/tauri";

/**
 * Open a URL in the OS default browser via the opener plugin's command.
 *
 * Avoids `window.open` (which would open inside the webview) and the npm
 * `@tauri-apps/plugin-opener` package (not currently bundled — the Rust
 * plugin is registered in `lib.rs` and `default.json`, the JS side just
 * invokes the command directly).
 *
 * Extracted 2026-06-16 from the byte-identical copies in
 * `ActivityViewPortrait.tsx`, `ActivityLandscapeView.tsx`,
 * `ActivityView.tsx`, `wallet/ChainTxCard.tsx`, and
 * `zephyr/ZephyrSwapModal.tsx` — all five now share this module
 * (the Zephyr one was rewired 2026-06-16).
 *
 * Imports `invoke` from the guarded `src/lib/tauri` wrapper per the
 * project's invoke-wrapper convention.
 */
export function openExternal(url: string): Promise<void> {
  return invoke("plugin:opener|open_url", { url });
}
