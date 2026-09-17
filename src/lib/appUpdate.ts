/**
 * App self-update state, shared by every place that shows it.
 *
 * ## Why one store
 *
 * Three surfaces show the same update: the banner (both layouts and the lock
 * screen) and the Updates row in each layout's Settings. Before 2026-09-17
 * each kept its own state, and only portrait Settings could install. The
 * landscape banner's "View" opened a Settings tab with no update row at all,
 * so in the default layout nothing could be clicked to update. With one store,
 * an install started from the banner shows its progress in Settings and the
 * other way round, and the release endpoint is asked once per launch however
 * many surfaces mount (the layout toggle remounts them).
 *
 * The UI never restarts on its own: the app may be mid-sync, mid-swap, or
 * holding an unlocked vault. Installing and restarting are two clicks.
 */
import { useSyncExternalStore } from "react";
import {
  checkForUpdate,
  installUpdate,
  isUpdaterSupported,
  restartApp,
  type UpdateInfo,
} from "./updater";

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "found"
  | "installing"
  | "done"
  | "restarting"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  /** The newer release, once one is found. Kept through install and errors. */
  info: UpdateInfo | null;
  /** Whether this build was produced by the bundler and can install in place. */
  canSelfInstall: boolean;
  /** 0..1, or -1 when the download size is unknown. */
  progress: number;
  error: string;
}

const INITIAL: AppUpdateState = {
  phase: "idle",
  info: null,
  canSelfInstall: false,
  progress: 0,
  error: "",
};

let state: AppUpdateState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<AppUpdateState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getAppUpdateState(): AppUpdateState {
  return state;
}

/** The launch check, memoised for the life of the process. */
let launchCheck: Promise<void> | null = null;

async function runCheck(): Promise<void> {
  set({ phase: "checking", error: "" });
  const found = await checkForUpdate();
  if (!found) {
    set({ phase: "current", info: null });
    return;
  }
  const canSelfInstall = await isUpdaterSupported();
  set({ phase: "found", info: found, canSelfInstall });
}

/**
 * Ask whether a newer version exists. `force` is the Settings "check now"
 * button; without it, every caller shares the one launch check.
 */
export function checkAppUpdate(force = false): Promise<void> {
  // An install in progress or finished must not be reset to "checking".
  if (["installing", "done", "restarting"].includes(state.phase)) {
    return Promise.resolve();
  }
  if (force) return runCheck();
  if (!launchCheck) launchCheck = runCheck();
  return launchCheck;
}

/** Download and install the release found by the last check. */
export async function installAppUpdate(): Promise<void> {
  if (state.phase !== "found" && state.phase !== "error") return;
  if (!state.info || !state.canSelfInstall) return;
  set({ phase: "installing", progress: 0, error: "" });
  try {
    await installUpdate((progress) => set({ progress }));
    set({ phase: "done" });
  } catch (e: unknown) {
    set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/** Restart into the installed version. Only after `installAppUpdate` finished. */
export async function restartIntoUpdate(): Promise<void> {
  if (state.phase !== "done") return;
  set({ phase: "restarting" });
  try {
    await restartApp();
  } catch (e: unknown) {
    set({
      phase: "done",
      error: `Could not restart (${e instanceof Error ? e.message : String(e)}). Close and reopen PwndaWallet to finish.`,
    });
  }
}

export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(subscribe, getAppUpdateState, getAppUpdateState);
}

/** Tests only: start from a fresh process. */
export function __resetAppUpdateForTests(): void {
  state = INITIAL;
  launchCheck = null;
  listeners.clear();
}
