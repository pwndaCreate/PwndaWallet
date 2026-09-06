/**
 * src/features/mining/mineViewMode.ts
 *
 * SIMPLE vs PRO for the Mine tab, remembered across sessions.
 *
 * # Why SIMPLE is the default
 *
 * The Mine tab has always opened on the console: hashrate chart, share
 * counters, pool diff, thread count. That is the right screen for someone
 * tuning a rig and the wrong one for someone who just wants to know whether
 * leaving their PC on is worth anything. Mock 3a makes the answer the hero and
 * hides the instruments behind `PRO ▸`; 3b's own label is the promise that
 * nothing is lost — "same page, console instruments slide in".
 *
 * # localStorage, not the plugin store
 *
 * This is a layout preference, read on first paint. `poolPreferenceStore` uses
 * `tauri-plugin-store` because it is written from a Tauri command path and
 * survives as user data; a view toggle read asynchronously would flash the
 * wrong view on every launch. Same choice, same reason, as `pwnda-layout`.
 *
 * Never holds anything secret — see CONTRIBUTING.md's rule against vault decrypt for
 * non-secret UX state.
 */

export type MineViewMode = "simple" | "pro";

const KEY = "pwnda.mine.viewMode";

/**
 * SIMPLE unless the user has said otherwise.
 *
 * An unreadable store (private mode, storage disabled) returns the default
 * rather than throwing: the Mine tab must render.
 */
export function readMineViewMode(): MineViewMode {
  try {
    return window.localStorage.getItem(KEY) === "pro" ? "pro" : "simple";
  } catch {
    return "simple";
  }
}

export function writeMineViewMode(mode: MineViewMode): void {
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    /* the choice just does not persist this session */
  }
}
