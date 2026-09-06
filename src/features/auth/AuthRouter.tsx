import type { ChainType } from "../../wallets";
import type { View } from "../../types/view";
import type { DerivationChoice } from "../onboarding/derivation-detector";
import { HomeView } from "./HomeView";
import { LoginView } from "./LoginView";
import { BackupView } from "./BackupView";
import { SetPasswordView } from "./SetPasswordView";
import { ImportView } from "./ImportView";
import { DerivationPickerView } from "../onboarding/DerivationPickerView";

/**
 * The pre-wallet flow: welcome, unlock, import, derivation pick, seed backup,
 * password. One definition, rendered by BOTH layouts.
 *
 * ## Why this is layout-independent
 *
 * These six screens are single-column forms. There is no meaningful landscape
 * variant of "type your password" — a second column would be empty. So rather
 * than duplicating them per layout (two copies to keep in sync, which is how
 * they drifted in the first place), `App.tsx` renders this component ahead of
 * the layout branch entirely. Portrait and landscape therefore cannot disagree
 * about onboarding: there is only one implementation, and neither root owns it.
 *
 * ## The bug this replaces
 *
 * Until 2026-08-12 these views lived only inside `ViewRouter` (portrait), while
 * `App.tsx` short-circuited to `LandscapeRoot` as soon as `walletsByChain` was
 * non-empty. `handleImport`/`handleCreate` populate that map BEFORE routing to
 * the password step, so in landscape — the default layout since 2026-06-20 —
 * the app jumped straight to the dashboard and the password screen never
 * rendered. `handleSetPassword` never ran, `saveVault` was never called, and
 * the wallet existed only in memory until the process exited. Silent: nothing
 * threw, so nothing was reported.
 *
 * Hoisting the flow out of both roots removes the class of bug rather than the
 * instance — there is no longer a layout branch that can swallow it.
 *
 * Returns `null` for any non-onboarding view so callers can render it
 * unconditionally and fall through.
 */
export function AuthRouter(props: {
  view: View;
  setView: (v: View) => void;
  activeChain: ChainType;
  setActiveChain: (c: ChainType) => void;
  pendingBip39: string;
  pendingXmrSeed: string;
  pendingZphSeed: string;
  handleCreate: () => Promise<void>;
  handleUnlock: (password: string) => Promise<void>;
  handleRemoveWallet: () => Promise<void>;
  handleImport: (
    importType: "mnemonic" | "privateKey",
    importValue: string,
    activeChain: ChainType
  ) => Promise<void>;
  handleConfirmDerivation: (choice: DerivationChoice) => void;
  handleSetPassword: (password: string, confirmPassword: string) => Promise<void>;
  copyToClipboard: (text: string, key?: string) => void;
}) {
  const {
    view,
    setView,
    activeChain,
    setActiveChain,
    pendingBip39,
    pendingXmrSeed,
    pendingZphSeed,
    handleCreate,
    handleUnlock,
    handleRemoveWallet,
    handleImport,
    handleConfirmDerivation,
    handleSetPassword,
    copyToClipboard,
  } = props;

  if (view === "home") {
    return <HomeView onCreate={handleCreate} onImport={() => setView("import")} />;
  }

  if (view === "login") {
    return <LoginView onUnlock={handleUnlock} onRemoveWallet={handleRemoveWallet} />;
  }

  if (view === "import") {
    return (
      <ImportView
        activeChain={activeChain}
        setActiveChain={setActiveChain}
        onImport={handleImport}
        onBack={() => setView("home")}
      />
    );
  }

  if (view === "derivation-picker") {
    return (
      <DerivationPickerView
        mnemonic={pendingBip39}
        onConfirm={handleConfirmDerivation}
        onBack={() => setView("import")}
      />
    );
  }

  if (view === "backup") {
    return (
      <BackupView
        pendingBip39={pendingBip39}
        pendingXmrSeed={pendingXmrSeed}
        pendingZphSeed={pendingZphSeed}
        onContinue={() => setView("setPassword")}
        onCopy={copyToClipboard}
      />
    );
  }

  if (view === "setPassword") {
    return <SetPasswordView onSubmit={handleSetPassword} />;
  }

  return null;
}

/**
 * The views `AuthRouter` owns. Exported so `App.tsx` can decide whether to
 * render the onboarding flow instead of a layout root, and so the routing test
 * can assert the two lists agree.
 */
export const AUTH_VIEWS: ReadonlySet<View> = new Set<View>([
  "home",
  "login",
  "import",
  "derivation-picker",
  "backup",
  "setPassword",
]);
