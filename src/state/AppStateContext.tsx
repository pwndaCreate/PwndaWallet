import {
  createContext,
  useCallback,
  useContext,
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
