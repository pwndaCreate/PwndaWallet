import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ChainType, WalletInfo } from "../wallets";
import type { WalletEntry } from "../vault-schema";
import type { View } from "../types/view";

/**
 * Narrow cross-cutting app state shared by every feature hook + view.
 * Kept intentionally small: `activeChain` + `walletsByChain` + shared
 * error/success banners + session password + view routing. Every
 * feature-specific field (sync state, node pools, miner settings,
 * etc.) stays in the feature hook that owns it.
 */
interface AppState {
  view: View;
  setView: (v: View) => void;
  activeChain: ChainType;
  setActiveChain: (c: ChainType) => void;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  setWalletsByChain: React.Dispatch<
    React.SetStateAction<Partial<Record<ChainType, WalletInfo>>>
  >;
  /**
   * Multi-wallet state spine (Phase 1). The decrypted wallet entries (one
   * per seed) and the active context — a walletId, or "all" for the unified
   * view. Populated at unlock/create; not yet consumed by the UI (the
   * switcher + unified portfolio land in later phases). `walletsByChain`
   * remains the render source of truth for the single active wallet.
   */
  walletEntries: WalletEntry[];
  setWalletEntries: React.Dispatch<React.SetStateAction<WalletEntry[]>>;
  /** Active wallet context: a walletId, or "all" (unified view, default). */
  activeWalletId: string;
  setActiveWalletId: (id: string) => void;
  error: string;
  setError: (v: string) => void;
  success: string;
  setSuccess: (v: string) => void;
  sessionPassword: string | null;
  setSessionPassword: (v: string | null) => void;
}

const AppStateContext = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>("home");
  const [activeChain, setActiveChain] = useState<ChainType>("ethereum");
  const [walletsByChain, setWalletsByChain] = useState<
    Partial<Record<ChainType, WalletInfo>>
  >({});
  const [walletEntries, setWalletEntries] = useState<WalletEntry[]>([]);
  const [activeWalletId, setActiveWalletId] = useState<string>("all");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [sessionPassword, setSessionPassword] = useState<string | null>(null);

  // RAM plan Phase 1.4 (2026-09-22): `mem_guard.rs`'s webview-memory
  // circuit-breaker needs to know whether the vault is currently unlocked
  // BEFORE it reloads the window (reloading an unlocked session silently
  // logs the user out — the F2 bug this exists to fix). The Rust backend
  // has no visibility into frontend vault state at all, so rather than
  // plumb a new Tauri command + AppState field for one boolean, this
  // mirrors `sessionPassword` onto a plain `window` global that the
  // backend's injected reload script reads synchronously (see
  // `mem_guard.rs::run`'s eval string). `sessionPassword !== null` IS this
  // app's definition of "unlocked" — same source of truth, no new state.
  useEffect(() => {
    try {
      (window as unknown as { __pwndaVaultUnlocked?: boolean }).__pwndaVaultUnlocked =
        sessionPassword !== null;
    } catch {
      // non-browser environment / frozen window — the backend's reload
      // check treats a missing flag as "safe to reload" (fail toward the
      // breaker's original behavior, never toward silently disabling it).
    }
  }, [sessionPassword]);

  const setErrorCb = useCallback((v: string) => setError(v), []);
  const setSuccessCb = useCallback((v: string) => setSuccess(v), []);

  const value = useMemo<AppState>(
    () => ({
      view,
      setView,
      activeChain,
      setActiveChain,
      walletsByChain,
      setWalletsByChain,
      walletEntries,
      setWalletEntries,
      activeWalletId,
      setActiveWalletId,
      error,
      setError: setErrorCb,
      success,
      setSuccess: setSuccessCb,
      sessionPassword,
      setSessionPassword,
    }),
    [
      view,
      activeChain,
      walletsByChain,
      walletEntries,
      activeWalletId,
      error,
      setErrorCb,
      success,
      setSuccessCb,
      sessionPassword,
    ]
  );

  return (
    <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
  );
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error("useAppState must be used inside <AppStateProvider>");
  }
  return ctx;
}

/**
 * The app state, or null outside `<AppStateProvider>`. For a shared view that
 * is also rendered on its own — the transaction details, which tests render
 * bare — and needs the state only for an optional part of it (2026-10-01:
 * the wallet entry that signs a BTC speed-up).
 */
export function useAppStateOptional(): AppState | null {
  return useContext(AppStateContext);
}
