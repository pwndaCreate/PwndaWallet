import { useCallback, useState } from "react";
import {
  ALL_CHAINS,
  getAdapter,
  type ChainType,
  type NetworkInfo,
  type WalletInfo,
} from "../../wallets";
import {
  saveVault,
  loadVault,
  loadVaultV3,
  saveVaultV3,
  projectV3ToV2,
  deleteWallet,
  type VaultPayload,
  type WalletEntry,
} from "../../store";
import {
  addWalletEntry,
  renameWalletEntry,
  removeWalletEntry,
  findDuplicateSeed,
  findDuplicateAddress,
  isPrimaryBip39,
  contextForWallet,
  memberOfKind,
  sidecarFileForEntry,
  LEGACY_XMR_SIDECAR_FILE,
  LEGACY_ZPH_SIDECAR_FILE,
  LEGACY_ZANO_SIDECAR_FILE,
  type NewWalletSpec,
  type WalletKind,
  legacyZanoSeedFor,
} from "../../vault-schema";

/** Fallback label when the user doesn't name an added wallet. */
function defaultWalletName(kind: WalletKind): string {
  return kind === "xmr"
    ? "Monero wallet"
    : kind === "zph"
    ? "Zephyr wallet"
    : kind === "privateKey"
    ? "Imported key"
    : kind === "watch"
    ? "Watched address"
    : "Wallet";
}

/**
 * Light watch-address sanity check (view-only, so a typo costs nothing but a
 * removable 0-balance row). Catches empties + obvious garbage; the balance
 * fetch is the real test. Per-chain strict validation is a follow-up.
 */
function validateWatchAddress(address: string): string | null {
  const a = address.trim();
  if (!a) return "Public address is required.";
  if (/\s/.test(a)) return "Address can't contain spaces.";
  if (a.length < 20 || a.length > 120) return "That doesn't look like a valid address.";
  return null;
}
import {
  xmrAdapter,
  setActiveXmrSeed,
  detectXmrSeedFormat,
  probeCurrentXmrHeight,
  polyseedRestoreHeight,
  type XmrSeedFormat,
} from "../../wallets/xmr-wallet";
import { zphAdapter } from "../../wallets/zph-wallet";
import { raceBestNode as raceBestZphNode } from "../../wallets/zph-nodes";
import { zanoAddressFromSeed } from "../../wallets/zano-keys";
import { fetchCurrentDaemonHeight as fetchCurrentZphDaemonHeight } from "../../wallets/zph-rpc";
import {
  entropyToMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist as bip39Wordlist } from "@scure/bip39/wordlists/english.js";
import { secureRandomBytes, bytesEqual } from "../../secure-random";
import type { View } from "../../types/view";
import {
  derivePerChoice,
  detectAll,
  detectProfilePaths,
  DEFAULT_DERIVATION_CHOICE,
  type DerivationChoice,
} from "../onboarding/derivation-detector";
import { fingerprintProfile, schemeFor, type ProfileId } from "../onboarding/derivation-profiles";

/**
 * Vault-orchestration hook. Owns:
 *   - Pending seeds (BIP39 / XMR / ZPH) staged between create-click and
 *     password-submit. Lives here because handleCreate writes them and
 *     handleSetPassword consumes them; co-locating avoids prop-drilling.
 *   - The six auth-flow handlers: create, import, setPassword, unlock,
 *     removeWallet, logout. They share password/seed plumbing and the
 *     same set of cross-feature side effects (forget sessions, clear
 *     in-memory wallets, route views).
 *   - The four save/forget helpers (XMR + ZPH) introduced in M8.
 *
 * Form-state for the auth views (loginPassword, password/confirmPassword,
 * unlocking flag, etc.) still lives in App.tsx and is passed in via
 * setters. M10 will move that state into the extracted view components.
 *
 * Every vault write goes through `{...payload, v: 2, ...}` spread so
 * cross-chain fields (BIP39 + XMR + ZPH) are never silently clobbered
 * when one chain's seed is updated.
 */
export function useVault(args: {
  // Identity / shared cross-feature state
  sessionPassword: string | null;
  setSessionPassword: (v: string | null) => void;
  setError: (msg: string) => void;
  setSuccess: (msg: string) => void;
  setView: (v: View) => void;
  setWalletsByChain: React.Dispatch<
    React.SetStateAction<Partial<Record<ChainType, WalletInfo>>>
  >;
  // Multi-wallet state spine (Phase 1). Populated at unlock/create, cleared
  // on logout. Not yet rendered — the switcher/unified view land later.
  setWalletEntries: (entries: WalletEntry[]) => void;
  setActiveWalletId: (id: string) => void;
  /**
   * Which wallet context the user is ON — needed by every post-unlock mutator.
   *
   * Until 2026-08-29 this hook only received the SETTER, so every read-modify-
   * write helper below projected and merged the PRIMARY group no matter what
   * the switcher said. Switching to an imported wallet and changing an LTC
   * derivation rewrote Main's stored choice and stamped Main's LTC address into
   * the active wallet's map.
   */
  activeWalletId: string;
  /** Focus a chain — used to point a single-chain (PK/watch) wallet at its chain on switch. */
  setActiveChain: (c: ChainType) => void;
  setXmrSeedLoaded: (v: string | null) => void;
  setZphSeedLoaded: (v: string | null) => void;
  setZanoSeedLoaded: (v: string | null) => void;
  /** In-memory mirror of the vault's `zanoSeedPassphrase`, so Wallet
   *  Details can show the user the passphrase their seed needs. A Zano
   *  backup of the words ALONE is not a backup when the seed is
   *  passphrase-protected — the same words with a different passphrase
   *  restore a different, empty wallet. Optional so existing callers that
   *  do not surface it keep compiling. */
  setZanoSeedPassphrase?: (v: string | null) => void;

  // Per-chain session lifecycle (from useXmrSession / useZphSession)
  startXmrSync: (
    seed: string,
    masterPassword: string,
    restoreHeight?: number,
    walletFilename?: string
  ) => void;
  startZphSync: (
    seed: string,
    masterPassword: string,
    restoreHeight?: number,
    walletFilename?: string
  ) => void;
  /** From `useZanoSession`. No restore-height param — a Zano seed
   *  self-encodes its own creation date, unlike XMR/ZPH. `walletFilename`
   *  arrived 2026-09-02 when Zano became a `WalletKind`: the Rust layer was
   *  single-wallet-file only until then, so two contexts shared one file. */
  startZanoSync: (
    seed: string,
    masterPassword: string,
    seedPassphrase?: string,
    walletFilename?: string
  ) => void;
  /** Close the wallet + release this caller's swap-rpc lease. Files stay —
   *  this is Lock, not Forget. See `useXmrSession.lock`'s doc comment. */
  lockXmrSession: () => Promise<void>;
  forgetXmrSession: () => Promise<void>;
  forgetZphSession: () => Promise<void>;
  /** From `useZanoSession`. Stops the sidecar + resets in-memory sync
   *  state — mirrors `forgetZphSession`'s role on logout. */
  forgetZanoSession: () => Promise<void>;

  // Saved-wallet flag — set true after first vault save, false on remove
  hasSaved: boolean;
  setHasSaved: (v: boolean) => void;

  // Logout cleanup — App.tsx-owned state that should be reset when the
  // user locks the wallet. Each lives outside the auth-flow views so the
  // views themselves can't reset it on unmount. Will move into the
  // dashboard / WalletDetailsCard / XmrImportPanel decompositions in M13.
  setBalance: (v: string) => void;
  setNetworkInfo: (v: NetworkInfo | null) => void;
  setShowPrivateKey: (v: boolean) => void;
  setShowMnemonic: (v: boolean) => void;
  setShowXmrSeed: (v: boolean) => void;
  setShowZphSeed: (v: boolean) => void;
  setXmrImportValue: (v: string) => void;

  /**
   * C9 — is a swap actively using the shared Monero wallet right now?
   *
   * `useVault` has no swap-sidecar awareness by design (BOUNDARIES.md scopes
   * `vault` to `src/wallets/*` + `src/store` + `src/crypto` + `src/state/*`
   * only). Optional and currently a safe no-op for every existing user:
   * nothing yet sets the C9 consent flag this check reads, so it resolves to
   * `false` and Lock Wallet / Forget Monero behave exactly as before. It
   * exists so that when C9's consent UI ships, the refusal already works
   * without touching this hook again.
   */
  checkXmrHostWalletInUse?: () => Promise<boolean>;
  /**
   * The ZEPH/ZANO twin of `checkXmrHostWalletInUse` (2026-09-04): the swap
   * node can share this app's own `zephyr-wallet-rpc` (C-RZ) or run a
   * scratch `simplewallet` beside the app's Zano Main (C-RX), and locking the
   * wallet or forgetting the primary ZEPH/ZANO entry mid-swap corrupts that
   * swap exactly as it would for Monero. Same best-effort contract: only an
   * explicit `true` refuses.
   */
  checkCnHostWalletInUse?: (coin: "zephyr" | "zano") => Promise<boolean>;
}) {
  const {
    sessionPassword,
    setSessionPassword,
    setError,
    setSuccess,
    setView,
    setWalletsByChain,
    setWalletEntries,
    setActiveWalletId,
    activeWalletId,
    setActiveChain,
    setXmrSeedLoaded,
    setZphSeedLoaded,
    setZanoSeedLoaded,
    setZanoSeedPassphrase,
    startXmrSync,
    startZphSync,
    startZanoSync,
    lockXmrSession,
    forgetXmrSession,
    forgetZphSession,
    forgetZanoSession,
    hasSaved,
    setHasSaved,
    setBalance,
    setNetworkInfo,
    setShowPrivateKey,
    setShowMnemonic,
    setShowXmrSeed,
    setShowZphSeed,
    setXmrImportValue,
    checkXmrHostWalletInUse,
    checkCnHostWalletInUse,
  } = args;

  // Pending seeds — staged between create/import and password-submit.
  // Owned by useVault (as of M9) so handleCreate → handleSetPassword
  // doesn't have to thread three setters through App.tsx.
  const [pendingBip39, setPendingBip39] = useState("");
  const [pendingXmrSeed, setPendingXmrSeed] = useState("");
  const [pendingZphSeed, setPendingZphSeed] = useState("");
  const [pendingDerivationChoice, setPendingDerivationChoice] =
    useState<DerivationChoice>(DEFAULT_DERIVATION_CHOICE);
  /**
   * Live derivation choice loaded from the vault on unlock. Read-only
   * for consumers — the post-hoc switcher (`handleChangeSolanaDerivation`)
   * is the only way to change it. Used by `SolanaDerivationPanel` to
   * highlight the user's current path.
   */
  const [activeDerivationChoice, setActiveDerivationChoice] =
    useState<DerivationChoice>(DEFAULT_DERIVATION_CHOICE);

  const deriveAllChains = useCallback(
    (
      mnemonic: string,
      choice: DerivationChoice = DEFAULT_DERIVATION_CHOICE
    ) => {
      const newWallets: Partial<Record<ChainType, WalletInfo>> = {};
      for (const chain of ALL_CHAINS) {
        const a = getAdapter(chain);
        if (a.usesIndependentSeed) continue; // XMR uses its own 25-word seed
        newWallets[chain] = a.deriveFromMnemonic(mnemonic);
      }
      // Override BTC / SOL / ADA / ALGO / LTC with the chosen derivation
      // paths. The adapters' default deriveFromMnemonic produces the standard
      // path already; this only changes anything for users who imported
      // from a non-standard wallet AND picked a non-default path in the
      // picker (e.g. an Exodus LTC seed → the BIP-44 legacy L… path).
      const perChoice = derivePerChoice(mnemonic, choice);
      newWallets.bitcoin = perChoice.bitcoin;
      newWallets.solana = perChoice.solana;
      newWallets.cardano = perChoice.cardano;
      newWallets.algorand = perChoice.algorand;
      newWallets.litecoin = perChoice.litecoin;
      // Profile-driven secp256k1 coins (2026-06-21). No-op vs the adapter
      // default until the derivation-profile fingerprint sets a path.
      newWallets.xrp = perChoice.xrp;
      newWallets.tron = perChoice.tron;
      newWallets.ravencoin = perChoice.ravencoin;
      newWallets.dash = perChoice.dash;
      return newWallets;
    },
    []
  );

  const handleCreate = useCallback(async () => {
    setError("");
    try {
      // Generate BIP39 phrase from OS-backed entropy (Rust `secureRandomBytes`,
      // see src/secure-random.ts). 16 bytes = 128 bits of entropy = 12 words.
      // Kept at 12 words intentionally for cross-wallet compatibility
      // (MetaMask/Phantom/Trust default).
      const bip39Entropy = await secureRandomBytes(16);
      const bip39 = entropyToMnemonic(bip39Entropy, bip39Wordlist);
      // Sanity round-trip: decode the phrase back to entropy and verify it
      // matches what we encoded. Catches encoder/wordlist regressions and
      // any in-memory corruption between generation and display.
      const bip39RoundTripped = mnemonicToEntropy(bip39, bip39Wordlist);
      if (!bytesEqual(bip39Entropy, bip39RoundTripped)) {
        throw new Error(
          "BIP39 sanity check failed: phrase did not round-trip to source entropy."
        );
      }
      if (!validateMnemonic(bip39, bip39Wordlist)) {
        throw new Error(
          "BIP39 sanity check failed: generated phrase failed checksum validation."
        );
      }

      // Generate independent 25-word Monero seed
      const xmrSeed = await xmrAdapter.generateOwnSeed!();

      // Generate independent 25-word Zephyr seed (Zephyr doesn't support
      // polyseed, so this is always the 25-word Electrum-style format).
      const zphSeed = await zphAdapter.generateOwnSeed!();

      // Derive all non-XMR wallets from BIP39
      const newWallets = deriveAllChains(bip39);

      // Derive XMR address from its own seed (async)
      const xmrWallet = await xmrAdapter.deriveFromOwnSeed!(xmrSeed);
      newWallets.monero = xmrWallet;

      // Derive Zephyr address from its own seed (async, offline pure-JS)
      const zphWallet = await zphAdapter.deriveFromOwnSeed!(zphSeed);
      newWallets.zephyr = zphWallet;

      setWalletsByChain(newWallets);
      setPendingBip39(bip39);
      setPendingXmrSeed(xmrSeed);
      setPendingZphSeed(zphSeed);
      setView("backup");
    } catch (e: any) {
      setError("Failed to create wallet: " + e.message);
    }
  }, [deriveAllChains, setError, setView, setWalletsByChain]);

  const handleImport = useCallback(
    async (importType: "mnemonic" | "privateKey", importValue: string, activeChain: ChainType): Promise<void> => {
      setError("");
      try {
        if (importType === "mnemonic") {
          const mnemonic = importValue.trim();
          // Validate the mnemonic up-front so we don't run a 5-10s
          // multi-RPC derivation scan against a typo'd phrase.
          if (!validateMnemonic(mnemonic, bip39Wordlist)) {
            setError("Invalid BIP-39 phrase — check the words and word order.");
            return;
          }
          // Stage the seed.
          setPendingBip39(mnemonic);
          setPendingXmrSeed(""); // XMR not included on BIP39 restore
          setPendingZphSeed(""); // Zephyr not included on BIP39 restore either
          //
          // Auto-detect the best derivation path per chain (BTC/SOL/ADA)
          // and apply the recommended one without prompting. The picker
          // view used to gate this step; on user feedback (2026-05-16)
          // we drop the prompt entirely — most users want the standard
          // path, and the dashboard `SolanaDerivationPanel` /
          // `CardanoDerivationPanel` / `BtcLegacyPanel` cards let them
          // switch later if the scan recommended the wrong default for
          // their actual funds (e.g. they imported from a wallet whose
          // RPC endpoints all 429'd during the scan).
          //
          // The scan is on-chain RPC + fast (~5-10s wall time).
          // Best-effort: if it throws (network down, etc.) we fall
          // through to DEFAULT_DERIVATION_CHOICE so the import still
          // completes.
          let recommended: DerivationChoice = DEFAULT_DERIVATION_CHOICE;
          try {
            const detection = await detectAll(mnemonic);
            recommended = {
              bitcoin: detection.bitcoin.recommendedId,
              solana: detection.solana.recommendedId,
              cardano: detection.cardano.recommendedId,
              // LTC + ALGO are now in the import scan too, so an Exodus seed
              // auto-selects its derivation (bip44-legacy / exodus) instead of
              // defaulting and hiding the funds. Previously omitted → defaulted.
              litecoin: detection.litecoin.recommendedId,
              algorand: detection.algorand.recommendedId,
            };
            // Phase 2 (2026-06-21): fingerprint the SOURCE WALLET from the
            // resolved choice ids, then resolve the profile's paths for the
            // secp256k1 coins that have no probe of their own (XRP/TRX/RVN/
            // DASH). `detectProfilePaths` balance-confirms the unverified
            // paths, so a non-Exodus wallet (fingerprint "standard") is left
            // untouched and an Exodus user only gets the Exodus XRP path if
            // they actually hold XRP there. See [[derivation-profiles-plan]].
            const fp = fingerprintProfile({
              bitcoin: recommended.bitcoin,
              solana: recommended.solana,
              cardano: recommended.cardano,
              litecoin: recommended.litecoin,
              algorand: recommended.algorand,
            });
            if (fp.profile !== "standard") {
              const profilePaths = await detectProfilePaths(mnemonic, fp.profile);
              recommended = { ...recommended, ...profilePaths };
            }
          } catch (e) {
            console.warn(
              "[useVault] derivation auto-scan failed; using defaults:",
              e
            );
          }
          setPendingDerivationChoice(recommended);
          // Hand off to handleConfirmDerivation — same code path the old
          // picker used after the user clicked Confirm. Derives all
          // chains at the chosen paths and routes to setPassword.
          const newWallets = deriveAllChains(mnemonic, recommended);
          setWalletsByChain(newWallets);
          setView("setPassword");
        } else {
          // Private key import: skip XMR (handled via XMR import panel in dashboard)
          if (activeChain === "monero") {
            setError(
              "To import a Monero wallet, use the dashboard XMR import panel after restoring your BIP39 wallet."
            );
            return;
          }
          const a = getAdapter(activeChain);
          const w = a.importFromPrivateKey(importValue);
          setWalletsByChain((prev) => ({ ...prev, [activeChain]: w }));
          setView("dashboard");
        }
      } catch (e: any) {
        setError("Import failed: " + e.message);
      }
    },
    [deriveAllChains, setError, setView, setWalletsByChain]
  );

  /**
   * Picker confirmation. Re-derives all chains using the chosen paths,
   * stages the choice for vault save, and routes to setPassword.
   */
  const handleConfirmDerivation = useCallback(
    (choice: DerivationChoice) => {
      setError("");
      try {
        const newWallets = deriveAllChains(pendingBip39, choice);
        setWalletsByChain(newWallets);
        setPendingDerivationChoice(choice);
        setView("setPassword");
      } catch (e: any) {
        setError("Failed to derive wallet: " + e.message);
      }
    },
    [deriveAllChains, pendingBip39, setError, setView, setWalletsByChain]
  );

  const handleSetPassword = useCallback(
    async (password: string, confirmPassword: string) => {
      setError("");
      if (password.length < 4) {
        setError("Password must be at least 4 characters");
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match");
        return;
      }
      try {
        // For a fresh wallet, record a restore height so future logins
        // restore from that block instead of scanning from genesis.
        //
        // Polyseed: the seed itself embeds a creation-date birthday, so the
        // initial restore height comes straight from that — we still probe
        // the current tip as a better upper bound if the node is reachable,
        // since a brand-new wallet can't have funds below tip.
        //
        // Legacy 25-word: we probe the current tip and use it verbatim.
        let xmrRestoreHeight: number | null = null;
        let xmrSeedFormat: XmrSeedFormat | undefined;
        if (pendingXmrSeed) {
          xmrSeedFormat = detectXmrSeedFormat(pendingXmrSeed) ?? undefined;
          try {
            const h = await probeCurrentXmrHeight();
            if (h > 0) xmrRestoreHeight = h;
          } catch {
            /* non-fatal — falls back to scan-from-genesis or polyseed birthday */
          }
          if (xmrRestoreHeight === null && xmrSeedFormat === "polyseed") {
            const fromBirthday = await polyseedRestoreHeight(pendingXmrSeed);
            if (fromBirthday > 0) xmrRestoreHeight = fromBirthday;
          }
        }

        // Zephyr: probe the current Zephyr tip for restore_height so fresh
        // wallets don't scan from genesis. Best-effort — if no node responds
        // we fall through to 0 (scan from genesis, which still works, just
        // slower).
        let zphRestoreHeight: number | null = null;
        if (pendingZphSeed) {
          try {
            const zNodeUrl = await raceBestZphNode().catch(() => null);
            if (zNodeUrl) {
              const h = await fetchCurrentZphDaemonHeight(zNodeUrl);
              if (h > 0) zphRestoreHeight = h;
            }
          } catch {
            /* non-fatal */
          }
        }

        const payload: VaultPayload = {
          v: 2,
          bip39: pendingBip39,
          xmrSeed: pendingXmrSeed || null,
          xmrSeedFormat,
          xmrRestoreHeight,
          zphSeed: pendingZphSeed || null,
          zphRestoreHeight,
          derivationChoice: pendingDerivationChoice,
        };
        await saveVault(payload, password);
        setHasSaved(true);
        // Populate the multi-wallet state spine from the canonical v3 the
        // save just wrote (carries the stable entry ids). Fresh wallet =
        // one group; active context defaults to the unified "all" view.
        try {
          const v3 = await loadVaultV3(password);
          setWalletEntries(v3.wallets);
          setActiveWalletId(v3.lastActiveWalletId ?? "all");
        } catch {
          /* non-fatal — spine is unused by the UI in Phase 1 */
        }
        if (pendingXmrSeed) {
          setXmrSeedLoaded(pendingXmrSeed);
          setActiveXmrSeed(pendingXmrSeed);
          // Fresh wallet — sidecar opens instantly because restoreHeight is the
          // tip (nothing to scan). `password` is required to encrypt the wallet
          // file on disk with a key derived from the vault master password.
          startXmrSync(pendingXmrSeed, password, xmrRestoreHeight ?? 0);
        }
        if (pendingZphSeed) {
          setZphSeedLoaded(pendingZphSeed);
          startZphSync(pendingZphSeed, password, zphRestoreHeight ?? 0);
        }
        // Retain the password in session state so subsequent vault saves
        // (e.g. XMR seed import) don't need to re-prompt the user.
        setSessionPassword(password);
        setPendingBip39("");
        setPendingXmrSeed("");
        setPendingZphSeed("");
        setView("dashboard");
      } catch (e: any) {
        setError("Failed to save wallet: " + e.message);
      }
    },
    [
      pendingBip39,
      pendingXmrSeed,
      pendingZphSeed,
      setError,
      setHasSaved,
      setSessionPassword,
      setView,
      setWalletEntries,
      setActiveWalletId,
      setXmrSeedLoaded,
      setZphSeedLoaded,
      startXmrSync,
      startZphSync,
    ]
  );

  const handleUnlock = useCallback(
    async (loginPassword: string) => {
      setError("");
      try {
        // Load the full v3 vault (migrates v2→v3 on disk on first unlock),
        // then project the primary group to the flat shape the rest of this
        // handler consumes. `v3.wallets` seeds the multi-wallet spine.
        const v3 = await loadVaultV3(loginPassword);
        // Project the context the user was LAST ON, not the primary group.
        // Restoring `lastActiveWalletId` into the switcher while deriving from
        // Main's seed is exactly the reported bug: the chip, breadcrumb and tick
        // all said "Wallet" while every address, balance and session was Main's.
        const restoredWalletId = v3.lastActiveWalletId ?? "all";
        const payload = projectV3ToV2(v3, restoredWalletId);
        // The restored context's Zano entry, for its per-wallet sidecar file.
        // Absent on a vault written before Zano became a `WalletKind` — the
        // sidecar then falls back to the legacy fixed name, which is the file
        // that vault's only Zano wallet already occupies.
        const zanoEntry = contextForWallet(v3, restoredWalletId)?.members.find(
          (m) => m.kind === "zano"
        );
        setWalletEntries(v3.wallets);
        setActiveWalletId(restoredWalletId);
        // MERGE (not ??) so vaults written before `algorand`/`litecoin` existed
        // in derivationChoice still get those keys filled from the defaults.
        // Without this, `activeDerivationChoice.litecoin` is undefined for every
        // pre-2026-06-14 vault, which hides the LTC derivation panel from
        // exactly the already-imported Exodus users who need it (and likewise
        // kept the ALGO panel hidden on old vaults). Explicitly-chosen keys in
        // the stored choice still win over the defaults.
        const choice = { ...DEFAULT_DERIVATION_CHOICE, ...payload.derivationChoice };
        setActiveDerivationChoice(choice);
        const newWallets = deriveAllChains(payload.bip39, choice);

        // If an XMR seed is stored, derive the XMR address synchronously
        // and kick off the background sidecar sync in the background.
        if (payload.xmrSeed) {
          const xmrWallet = await xmrAdapter.deriveFromOwnSeed!(payload.xmrSeed);
          newWallets.monero = xmrWallet;
          setXmrSeedLoaded(payload.xmrSeed);
          setActiveXmrSeed(payload.xmrSeed);
          // Start the monero-wallet-rpc sidecar in the background. The UI
          // goes to the dashboard immediately; the Monero panel shows a
          // sync progress bar while scanning completes.
          //
          // Pass `loginPassword` so the sidecar can encrypt the wallet file
          // on disk with a key derived from the vault master password.
          // `xmrRestoreHeight` (persisted at wallet creation) lets the wallet
          // skip genesis-to-creation-date scanning — typically hours saved.
          startXmrSync(
            payload.xmrSeed,
            loginPassword,
            payload.xmrRestoreHeight ?? 0
          );
        } else {
          setXmrSeedLoaded(null);
        }

        // Zephyr seed + session — same pattern as Monero. Lazy v2-vault-
        // upgrade: old vaults don't have `zphSeed`, read as undefined, so
        // this branch is silently skipped and the user can import a Zephyr
        // seed later from the dashboard.
        if (payload.zphSeed) {
          const zphWallet = await zphAdapter.deriveFromOwnSeed!(payload.zphSeed);
          newWallets.zephyr = zphWallet;
          setZphSeedLoaded(payload.zphSeed);
          startZphSync(
            payload.zphSeed,
            loginPassword,
            payload.zphRestoreHeight ?? 0
          );
        } else {
          setZphSeedLoaded(null);
        }

        // Zano seed + session — same pattern as Zephyr, minus restore
        // height (Zano's seed self-encodes its own creation date). NOT
        // `zanoAdapter.deriveFromOwnSeed` — that throws by design for
        // password-protected seeds (nowhere to collect a passphrase); this
        // is the same offline call `ZanoImportPanel` makes, and a wrong
        // stored passphrase still produces a valid-looking address here —
        // `startZanoSync` (via `initZanoSession`'s address cross-check) is
        // what actually catches it, surfacing as a sync error rather than
        // blocking unlock.
        if (payload.zanoSeed) {
          const zanoAddress = zanoAddressFromSeed(
            payload.zanoSeed,
            payload.zanoSeedPassphrase ?? ""
          );
          newWallets.zano = {
            chain: "zano",
            address: zanoAddress,
            mnemonic: payload.zanoSeed,
            privateKey: "",
          };
          setZanoSeedLoaded(payload.zanoSeed);
          setZanoSeedPassphrase?.(payload.zanoSeedPassphrase ?? null);
          startZanoSync(
            payload.zanoSeed,
            loginPassword,
            payload.zanoSeedPassphrase,
            // Undefined for a vault written before Zano became a WalletKind:
            // the sidecar then falls back to the legacy fixed filename, which
            // is exactly the file that vault's wallet already occupies.
            zanoEntry ? sidecarFileForEntry(zanoEntry) : undefined
          );
        } else {
          setZanoSeedLoaded(null);
          setZanoSeedPassphrase?.(null);
        }

        setWalletsByChain(newWallets);
        // Retain the password in session state for subsequent vault saves
        // (XMR seed import, "forget monero", etc.) without re-prompting.
        setSessionPassword(loginPassword);
        setView("dashboard");
      } catch (e: any) {
        setError(
          e.message === "No saved wallet found" ? e.message : "Incorrect password"
        );
      }
    },
    [
      deriveAllChains,
      setError,
      setSessionPassword,
      setView,
      setWalletsByChain,
      setWalletEntries,
      setActiveWalletId,
      setXmrSeedLoaded,
      setZphSeedLoaded,
      setZanoSeedLoaded,
      startXmrSync,
      startZphSync,
      startZanoSync,
    ]
  );

  const handleRemoveWallet = useCallback(async () => {
    try {
      await deleteWallet();
      setHasSaved(false);
      setError("");
      setView("home");
    } catch (e: any) {
      setError("Failed to remove wallet: " + e.message);
    }
  }, [setError, setHasSaved, setView]);

  const handleLogout = useCallback(async () => {
    // C9 safety gate. Best-effort: a failed CHECK must not itself block
    // logout (that would trade a swap-corruption risk for a
    // cannot-lock-my-wallet complaint on every transient error) — only an
    // explicit `true` answer refuses.
    if (checkXmrHostWalletInUse) {
      try {
        if (await checkXmrHostWalletInUse()) {
          setError(
            "A swap is using the Monero wallet the swap node shares with this app right now — " +
              "finish or abandon it before locking, or the swap will be corrupted.",
          );
          return;
        }
      } catch {
        /* best-effort — proceed as if not in use */
      }
    }
    // Same gate for the two CryptoNote followers the node can share
    // (2026-09-04). Checked one at a time so the message names the coin.
    if (checkCnHostWalletInUse) {
      for (const [coin, name] of [
        ["zephyr", "Zephyr"],
        ["zano", "Zano"],
      ] as const) {
        try {
          if (await checkCnHostWalletInUse(coin)) {
            setError(
              `A swap is using the ${name} wallet the swap node shares with this app right now — ` +
                "finish or abandon it before locking, or the swap will be corrupted.",
            );
            return;
          }
        } catch {
          /* best-effort — proceed as if not in use */
        }
      }
    }
    setWalletsByChain({});
    setWalletEntries([]);
    setActiveWalletId("all");
    setBalance("--");
    setNetworkInfo(null);
    setShowPrivateKey(false);
    setShowMnemonic(false);
    setShowXmrSeed(false);
    setShowZphSeed(false);
    setError("");
    setSuccess("");
    setXmrSeedLoaded(null);
    setSessionPassword(null);
    setPendingBip39("");
    setPendingXmrSeed("");
    setXmrImportValue("");
    void lockXmrSession();
    void forgetZphSession();
    setZphSeedLoaded(null);
    void forgetZanoSession();
    setZanoSeedLoaded(null);
    if (hasSaved) {
      setView("login");
    } else {
      setView("home");
    }
  }, [
    checkXmrHostWalletInUse,
    lockXmrSession,
    forgetZphSession,
    forgetZanoSession,
    hasSaved,
    setBalance,
    setError,
    setNetworkInfo,
    setSessionPassword,
    setShowMnemonic,
    setShowPrivateKey,
    setShowXmrSeed,
    setShowZphSeed,
    setSuccess,
    setView,
    setWalletsByChain,
    setWalletEntries,
    setActiveWalletId,
    setXmrImportValue,
    setXmrSeedLoaded,
    setZphSeedLoaded,
    setZanoSeedLoaded,
  ]);

  const saveXmrSeedToVault = useCallback(
    async (xmrSeed: string, xmrRestoreHeight: number | null = null) => {
      if (!sessionPassword) {
        setError(
          "Session password missing — please lock and unlock the wallet, then try again."
        );
        return;
      }
      try {
        const payload = await loadVault(sessionPassword, activeWalletId);
        const xmrSeedFormat = detectXmrSeedFormat(xmrSeed) ?? undefined;
        const updated: VaultPayload = {
          ...payload,
          v: 2,
          xmrSeed,
          xmrSeedFormat,
          xmrRestoreHeight,
        };
        await saveVault(updated, sessionPassword, activeWalletId);
        setSuccess("Monero wallet saved to vault.");
      } catch (e: any) {
        console.error("[useVault] saveXmrSeedToVault failed:", e);
        setError(
          "Failed to save Monero wallet to vault: " + (e?.message || String(e))
        );
      }
    },
    [sessionPassword, setError, setSuccess]
  );

  const saveZphSeedToVault = useCallback(
    async (zphSeed: string, zphRestoreHeight: number | null = null) => {
      if (!sessionPassword) {
        setError(
          "Session password missing — please lock and unlock the wallet, then try again."
        );
        return;
      }
      try {
        const payload = await loadVault(sessionPassword, activeWalletId);
        const updated: VaultPayload = {
          ...payload,
          v: 2,
          zphSeed,
          zphRestoreHeight,
        };
        await saveVault(updated, sessionPassword, activeWalletId);
        setSuccess("Zephyr wallet saved to vault.");
      } catch (e: any) {
        console.error("[useVault] saveZphSeedToVault failed:", e);
        setError(
          "Failed to save Zephyr wallet to vault: " + (e?.message || String(e))
        );
      }
    },
    [sessionPassword, setError, setSuccess]
  );

  /** No restore-height param — Zano's seed self-encodes its own creation
   *  date, unlike XMR/ZPH. `zanoSeedPassphrase` defaults to "" (ordinary,
   *  non-Secured-Seed) rather than undefined so a re-save that clears a
   *  previously-set passphrase actually clears it (an `undefined` write
   *  would leave the old value in place via the `{...payload}` spread). */
  const saveZanoSeedToVault = useCallback(
    async (zanoSeed: string, zanoSeedPassphrase: string = "") => {
      if (!sessionPassword) {
        setError(
          "Session password missing — please lock and unlock the wallet, then try again."
        );
        return;
      }
      try {
        const payload = await loadVault(sessionPassword, activeWalletId);
        const updated: VaultPayload = {
          ...payload,
          v: 2,
          zanoSeed,
          zanoSeedPassphrase: zanoSeedPassphrase || undefined,
        };
        await saveVault(updated, sessionPassword, activeWalletId);
        setZanoSeedPassphrase?.(zanoSeedPassphrase || null);
        setSuccess("Zano wallet saved to vault.");
      } catch (e: any) {
        console.error("[useVault] saveZanoSeedToVault failed:", e);
        setError(
          "Failed to save Zano wallet to vault: " + (e?.message || String(e))
        );
      }
    },
    [sessionPassword, setError, setSuccess]
  );

  /**
   * Switch the user's Solana derivation choice post-import. Reads the
   * current vault, updates `derivationChoice.solana`, re-derives the
   * SOL wallet via `derivePerChoice`, persists. Used by
   * `SolanaDerivationPanel` when the user discovers their Exodus / CLI
   * funds aren't visible because the wallet was on the wrong path.
   */
  const handleChangeSolanaDerivation = useCallback(
    async (newSolanaChoice: string) => {
      if (!sessionPassword) {
        setError(
          "Session password missing — lock and unlock the wallet, then try again."
        );
        return;
      }
      try {
        const payload = await loadVault(sessionPassword, activeWalletId);
        const currentChoice = payload.derivationChoice ?? DEFAULT_DERIVATION_CHOICE;
        const nextChoice: DerivationChoice = {
          ...currentChoice,
          solana: newSolanaChoice,
        };
        const updated: VaultPayload = {
          ...payload,
          v: 2,
          derivationChoice: nextChoice,
        };
        await saveVault(updated, sessionPassword, activeWalletId);
        setActiveDerivationChoice(nextChoice);
        // Re-derive the SOL wallet at the new path. Other chains stay
        // unchanged. We compute the FULL derivation set (not just SOL)
        // because the in-memory walletsByChain holds every chain's
        // entry; targeted update keeps the others in sync.
        const next = derivePerChoice(payload.bip39, nextChoice);
        setWalletsByChain((prev) => ({ ...prev, solana: next.solana }));
        setSuccess("Solana derivation updated.");
      } catch (e: any) {
        setError(
          "Failed to update Solana derivation: " + (e?.message || String(e))
        );
        throw e;
      }
    },
    [sessionPassword, setError, setSuccess, setWalletsByChain]
  );

  /**
   * Same shape as `handleChangeSolanaDerivation` but for Algorand. Used
   * by `AlgorandDerivationPanel` when the user discovers their Exodus /
   * Atomic seed produces a different ALGO address because the source
   * wallet uses the secp256k1→ed25519 scheme rather than SLIP-0010.
   * Re-derives only the algorand entry; everything else stays put.
   */
  const handleChangeAlgorandDerivation = useCallback(
    async (newAlgorandChoice: string) => {
      if (!sessionPassword) {
        setError(
          "Session password missing — lock and unlock the wallet, then try again."
        );
        return;
      }
      try {
        const payload = await loadVault(sessionPassword, activeWalletId);
        const currentChoice = payload.derivationChoice ?? DEFAULT_DERIVATION_CHOICE;
        const nextChoice: DerivationChoice = {
          ...currentChoice,
          algorand: newAlgorandChoice,
        };
        const updated: VaultPayload = {
          ...payload,
          v: 2,
          derivationChoice: nextChoice,
        };
        await saveVault(updated, sessionPassword, activeWalletId);
        setActiveDerivationChoice(nextChoice);
        const next = derivePerChoice(payload.bip39, nextChoice);
        setWalletsByChain((prev) => ({ ...prev, algorand: next.algorand }));
        setSuccess("Algorand derivation updated.");
      } catch (e: any) {
        setError(
          "Failed to update Algorand derivation: " + (e?.message || String(e))
        );
        throw e;
      }
    },
    [sessionPassword, setError, setSuccess, setWalletsByChain]
  );

  /**
   * Same shape as `handleChangeSolanaDerivation` but for Litecoin. Used by
   * `LitecoinDerivationPanel` when an Exodus user discovers their LTC funds
   * aren't visible because Pwnda defaults to BIP-84 native-segwit (ltc1q…)
   * while Exodus uses BIP-44 legacy P2PKH (L…). Switching to "bip44-legacy"
   * re-derives the LTC entry to the L… address (and the P2PKH spend path in
   * ltc-wallet then lets those funds move). Re-derives only the litecoin
   * entry; everything else stays put.
   */
  const handleChangeLitecoinDerivation = useCallback(
    async (newLitecoinChoice: string) => {
      if (!sessionPassword) {
        setError(
          "Session password missing — lock and unlock the wallet, then try again."
        );
        return;
      }
      try {
        const payload = await loadVault(sessionPassword, activeWalletId);
        const currentChoice = payload.derivationChoice ?? DEFAULT_DERIVATION_CHOICE;
        const nextChoice: DerivationChoice = {
          ...currentChoice,
          litecoin: newLitecoinChoice,
        };
        const updated: VaultPayload = {
          ...payload,
          v: 2,
          derivationChoice: nextChoice,
        };
        await saveVault(updated, sessionPassword, activeWalletId);
        setActiveDerivationChoice(nextChoice);
        const next = derivePerChoice(payload.bip39, nextChoice);
        setWalletsByChain((prev) => ({ ...prev, litecoin: next.litecoin }));
        setSuccess("Litecoin derivation updated.");
      } catch (e: any) {
        setError(
          "Failed to update Litecoin derivation: " + (e?.message || String(e))
        );
        throw e;
      }
    },
    [sessionPassword, setError, setSuccess, setWalletsByChain]
  );

  /**
   * Same shape as `handleChangeSolanaDerivation` but for Cardano. Used
   * by `CardanoDerivationPanel` when the user discovers their Exodus /
   * Atomic / Trust Wallet seed produces a different `addr1q…` address
   * because the source wallet defaulted to a non-zero account index.
   * Re-derives only the cardano entry; everything else stays put.
   */
  const handleChangeCardanoDerivation = useCallback(
    async (newCardanoChoice: string) => {
      if (!sessionPassword) {
        setError(
          "Session password missing — lock and unlock the wallet, then try again."
        );
        return;
      }
      try {
        const payload = await loadVault(sessionPassword, activeWalletId);
        const currentChoice = payload.derivationChoice ?? DEFAULT_DERIVATION_CHOICE;
        const nextChoice: DerivationChoice = {
          ...currentChoice,
          cardano: newCardanoChoice,
        };
        const updated: VaultPayload = {
          ...payload,
          v: 2,
          derivationChoice: nextChoice,
        };
        await saveVault(updated, sessionPassword, activeWalletId);
        setActiveDerivationChoice(nextChoice);
        const next = derivePerChoice(payload.bip39, nextChoice);
        setWalletsByChain((prev) => ({ ...prev, cardano: next.cardano }));
        setSuccess("Cardano derivation updated.");
      } catch (e: any) {
        setError(
          "Failed to update Cardano derivation: " + (e?.message || String(e))
        );
        throw e;
      }
    },
    [sessionPassword, setError, setSuccess, setWalletsByChain]
  );

  /**
   * Generic post-hoc switcher for the path-based profile coins (XRP / TRX /
   * RVN / DASH). Same shape as `handleChangeSolanaDerivation`, but the choice
   * value is a RAW HD path (`derivationChoice.xrp` etc.) and it re-derives
   * just that coin. Used by the secp256k1 derivation panel's paste-to-find
   * "Use this" (2026-06-21, [[derivation-profiles-plan]] Phase 3).
   */
  const handleChangeCoinDerivation = useCallback(
    async (coin: "xrp" | "tron" | "ravencoin" | "dash", path: string) => {
      if (!sessionPassword) {
        setError("Session password missing — lock and unlock the wallet, then try again.");
        return;
      }
      try {
        const payload = await loadVault(sessionPassword, activeWalletId);
        const currentChoice = payload.derivationChoice ?? DEFAULT_DERIVATION_CHOICE;
        const nextChoice: DerivationChoice = { ...currentChoice, [coin]: path };
        const updated: VaultPayload = { ...payload, v: 2, derivationChoice: nextChoice };
        await saveVault(updated, sessionPassword, activeWalletId);
        setActiveDerivationChoice(nextChoice);
        const next = derivePerChoice(payload.bip39, nextChoice);
        setWalletsByChain((prev) => ({ ...prev, [coin]: next[coin] }));
        setSuccess(`${coin.toUpperCase()} derivation updated.`);
      } catch (e: any) {
        setError(`Failed to update ${coin} derivation: ` + (e?.message || String(e)));
        throw e;
      }
    },
    [sessionPassword, setError, setSuccess, setWalletsByChain]
  );

  /**
   * Apply a whole derivation PROFILE across every coin at once (the Settings
   * global switch). Flexible coins (BTC/SOL/ADA/ALGO/LTC) take the profile's
   * choice ids directly — the user explicitly asserted "I came from <wallet>".
   * The secp256k1 coins (XRP/TRX/RVN/DASH) go through `detectProfilePaths`, so
   * their `published`/`inferred` paths apply ONLY where an on-chain balance
   * confirms them — never blind. Picking "standard" resets every coin to the
   * default (always safe). Re-derives + persists everything.
   */
  const handleApplyProfile = useCallback(
    async (profileId: ProfileId) => {
      if (!sessionPassword) {
        setError("Session password missing — lock and unlock the wallet, then try again.");
        return;
      }
      try {
        const payload = await loadVault(sessionPassword, activeWalletId);
        const flexible: Partial<DerivationChoice> = {};
        for (const coin of ["bitcoin", "solana", "cardano", "algorand", "litecoin"] as const) {
          const choiceId = schemeFor(profileId, coin).choiceId;
          if (choiceId) flexible[coin] = choiceId;
        }
        const paths = await detectProfilePaths(payload.bip39, profileId);
        const nextChoice: DerivationChoice = {
          ...DEFAULT_DERIVATION_CHOICE,
          ...flexible,
          xrp: paths.xrp,
          tron: paths.tron,
          ravencoin: paths.ravencoin,
          dash: paths.dash,
        };
        const updated: VaultPayload = { ...payload, v: 2, derivationChoice: nextChoice };
        await saveVault(updated, sessionPassword, activeWalletId);
        setActiveDerivationChoice(nextChoice);
        const next = derivePerChoice(payload.bip39, nextChoice);
        setWalletsByChain((prev) => ({
          ...prev,
          bitcoin: next.bitcoin,
          solana: next.solana,
          cardano: next.cardano,
          algorand: next.algorand,
          litecoin: next.litecoin,
          xrp: next.xrp,
          tron: next.tron,
          ravencoin: next.ravencoin,
          dash: next.dash,
        }));
        setSuccess(
          profileId === "standard"
            ? "Reset to the standard derivation for every coin."
            : `Applied the ${profileId === "exodus" ? "Exodus" : "Atomic"} derivation profile.`
        );
      } catch (e: any) {
        setError("Failed to apply derivation profile: " + (e?.message || String(e)));
        throw e;
      }
    },
    [sessionPassword, setError, setSuccess, setWalletsByChain]
  );

  /* ─── Multi-wallet CRUD (Phase 2) ─────────────────────────────────────
   * Add / rename / remove INDEPENDENT wallets (each its own seed) in the v3
   * vault. These operate on the full entry array via loadVaultV3/saveVaultV3
   * and refresh the `walletEntries` spine. The Settings ▸ Wallets card drives
   * them. Switching the ACTIVE context to a newly-added wallet is Phase 3.
   */
  const [walletOpBusy, setWalletOpBusy] = useState(false);

  const addWallet = useCallback(
    async (
      kind: WalletKind,
      input: string,
      name: string,
      chain?: ChainType
    ): Promise<boolean> => {
      if (!sessionPassword) {
        setError("Session password missing — lock and unlock the wallet, then try again.");
        return false;
      }
      const value = input.trim();
      const trimmedName = name.trim() || defaultWalletName(kind);

      // Single-chain kinds (privateKey / watch) require a chain and can't be
      // CryptoNote (XMR/ZPH view-only is a separate, sidecar-backed feature).
      if (kind === "privateKey" || kind === "watch") {
        if (!chain) {
          setError("Pick a network for this account.");
          return false;
        }
        if (chain === "monero" || chain === "zephyr") {
          setError("Monero / Zephyr can't be imported this way — add their seed instead.");
          return false;
        }
      }
      // Seed-kind validation (bip39/xmr/zph) up front.
      if (kind === "bip39" && !validateMnemonic(value, bip39Wordlist)) {
        setError("Invalid BIP-39 phrase — check the words and word order.");
        return false;
      }
      if (kind === "xmr" && !detectXmrSeedFormat(value)) {
        setError("Unrecognized Monero seed (expected 16-word polyseed or 25-word legacy).");
        return false;
      }
      if (kind === "zph" && value.split(/\s+/).filter(Boolean).length !== 25) {
        setError("Zephyr seed must be exactly 25 words.");
        return false;
      }
      if (kind === "watch") {
        const err = validateWatchAddress(value);
        if (err) {
          setError(err);
          return false;
        }
      }

      setWalletOpBusy(true);
      setError("");
      try {
        const v3 = await loadVaultV3(sessionPassword);

        // Duplicate guards: seed-based for HD/seed kinds, address-based for
        // single-chain kinds (a re-encoded key or a repeat watch).
        if (kind === "privateKey" || kind === "watch") {
          // Resolve the address: derive it for a private key (also validates
          // the key — the adapter throws on malformed input, Phantom-style),
          // or take it verbatim for a watch.
          let address = value;
          if (kind === "privateKey") {
            const w = getAdapter(chain!).importFromPrivateKey(value);
            address = w.address;
          }
          if (findDuplicateAddress(v3, chain!, address)) {
            setError(
              kind === "watch"
                ? "You're already watching that address."
                : "That key's address is already one of your wallets."
            );
            return false;
          }
          const spec: NewWalletSpec = {
            kind,
            seed: kind === "watch" ? "" : value,
            name: trimmedName,
            chain,
            address,
          };
          const { v3: next } = addWalletEntry(v3, spec);
          await saveVaultV3(next, sessionPassword);
          setWalletEntries(next.wallets);
          setSuccess(
            kind === "watch" ? `Watching "${trimmedName}".` : `Imported "${trimmedName}".`
          );
          return true;
        }

        // Seed kinds (bip39 / xmr / zph).
        if (findDuplicateSeed(v3, value)) {
          setError("That seed is already one of your wallets.");
          return false;
        }
        const spec: NewWalletSpec = { kind, seed: value, name: trimmedName };
        if (kind === "bip39") {
          // Secondary bip39 wallets default to the standard paths; the user can
          // switch per-coin later (same derivation panels as the primary).
          spec.derivationChoice = DEFAULT_DERIVATION_CHOICE;
        } else if (kind === "xmr") {
          spec.xmrSeedFormat = detectXmrSeedFormat(value) ?? undefined;
          let h: number | null = null;
          try {
            const tip = await probeCurrentXmrHeight();
            if (tip > 0) h = tip;
          } catch {
            /* non-fatal */
          }
          if (h === null && spec.xmrSeedFormat === "polyseed") {
            const b = await polyseedRestoreHeight(value);
            if (b > 0) h = b;
          }
          spec.restoreHeight = h;
        } else if (kind === "zph") {
          let h: number | null = null;
          try {
            const node = await raceBestZphNode().catch(() => null);
            if (node) {
              const tip = await fetchCurrentZphDaemonHeight(node);
              if (tip > 0) h = tip;
            }
          } catch {
            /* non-fatal */
          }
          spec.restoreHeight = h;
        }
        const { v3: next } = addWalletEntry(v3, spec);
        await saveVaultV3(next, sessionPassword);
        setWalletEntries(next.wallets);
        setSuccess(`Added wallet "${trimmedName}".`);
        return true;
      } catch (e: any) {
        setError("Failed to add wallet: " + (e?.message || String(e)));
        return false;
      } finally {
        setWalletOpBusy(false);
      }
    },
    [sessionPassword, setError, setSuccess, setWalletEntries]
  );

  const renameWallet = useCallback(
    async (id: string, name: string): Promise<void> => {
      if (!sessionPassword) {
        setError("Session password missing — lock and unlock the wallet, then try again.");
        return;
      }
      const trimmed = name.trim();
      if (!trimmed) {
        setError("Wallet name can't be empty.");
        return;
      }
      try {
        const v3 = await loadVaultV3(sessionPassword);
        const next = renameWalletEntry(v3, id, trimmed);
        await saveVaultV3(next, sessionPassword);
        setWalletEntries(next.wallets);
        setSuccess("Wallet renamed.");
      } catch (e: any) {
        setError("Failed to rename wallet: " + (e?.message || String(e)));
      }
    },
    [sessionPassword, setError, setSuccess, setWalletEntries]
  );

  const removeWallet = useCallback(
    async (id: string): Promise<void> => {
      if (!sessionPassword) {
        setError("Session password missing — lock and unlock the wallet, then try again.");
        return;
      }
      try {
        const v3 = await loadVaultV3(sessionPassword);
        // The primary bip39 wallet can't be removed as "just one entry" —
        // every other chain (BTC/ETH/SOL/...) derives from it, so removing
        // it is really "wipe this vault", which only makes sense as the
        // last-entry-removed path below (wasLast), not a targeted delete.
        if (isPrimaryBip39(v3, id)) {
          setError(
            "This is your primary wallet — remove your other wallets first if you want to start over."
          );
          return;
        }
        const target = v3.wallets.find((w) => w.id === id);
        // The primary group's xmr/zph entry is NOT a Phase-2 secondary
        // wallet, identified by still pointing at the legacy sidecar file
        // (every added-later wallet gets its own per-id filename). A plain
        // removeWalletEntry() only edits the vault file; this one also has a
        // LIVE session (sidecar wallet-rpc, walletsByChain, xmrSeedLoaded)
        // that a bare vault edit leaves dangling — stale balance on screen,
        // sidecar still holding the wallet open, until the next unlock.
        const isPrimaryXmr =
          target?.kind === "xmr" &&
          sidecarFileForEntry(target) === LEGACY_XMR_SIDECAR_FILE;
        const isPrimaryZph =
          target?.kind === "zph" &&
          sidecarFileForEntry(target) === LEGACY_ZPH_SIDECAR_FILE;
        // Zano gained a removeWallet path on 2026-09-02, when it became a
        // `WalletKind`. Before that it was a vault-wide field with no removal
        // route at all — "forgetting" it meant logging out (which closed the
        // sidecar but left the seed in the vault) or overwriting the field.
        const isPrimaryZano =
          target?.kind === "zano" &&
          sidecarFileForEntry(target) === LEGACY_ZANO_SIDECAR_FILE;
        if (isPrimaryXmr && checkXmrHostWalletInUse) {
          try {
            if (await checkXmrHostWalletInUse()) {
              setError(
                "A swap is using the Monero wallet the swap node shares with this app right now — " +
                  "finish or abandon it before removing this wallet, or the swap will be corrupted.",
              );
              return;
            }
          } catch {
            /* best-effort — a failed CHECK must not itself block removal;
               only an explicit `true` refuses. */
          }
        }
        // The ZEPH/ZANO twin (2026-09-04) — the primary entry of either is
        // the wallet process the swap node shares, so the same refusal
        // applies; secondary (per-id) entries are never shared.
        const cnCoin: "zephyr" | "zano" | null = isPrimaryZph
          ? "zephyr"
          : isPrimaryZano
            ? "zano"
            : null;
        if (cnCoin && checkCnHostWalletInUse) {
          try {
            if (await checkCnHostWalletInUse(cnCoin)) {
              setError(
                `A swap is using the ${cnCoin === "zephyr" ? "Zephyr" : "Zano"} wallet the swap ` +
                  "node shares with this app right now — finish or abandon it before removing " +
                  "this wallet, or the swap will be corrupted.",
              );
              return;
            }
          } catch {
            /* best-effort — only an explicit `true` refuses */
          }
        }
        const { v3: next, removed, wasLast } = removeWalletEntry(v3, id);
        if (!removed) return;
        if (wasLast) {
          await deleteWallet();
          setHasSaved(false);
          setWalletEntries([]);
          setView("home");
          return;
        }
        await saveVaultV3(next, sessionPassword);
        if (isPrimaryXmr) {
          setWalletsByChain((prev) => {
            const nextChains = { ...prev };
            delete nextChains.monero;
            return nextChains;
          });
          setXmrSeedLoaded(null);
          await forgetXmrSession();
        } else if (isPrimaryZph) {
          setWalletsByChain((prev) => {
            const nextChains = { ...prev };
            delete nextChains.zephyr;
            return nextChains;
          });
          setZphSeedLoaded(null);
          await forgetZphSession();
        } else if (isPrimaryZano) {
          setWalletsByChain((prev) => {
            const nextChains = { ...prev };
            delete nextChains.zano;
            return nextChains;
          });
          setZanoSeedLoaded(null);
          setZanoSeedPassphrase?.(null);
          await forgetZanoSession();
        }
        // A genuine Phase-2 secondary xmr/zph wallet has no on-disk sidecar
        // file yet (its session never started — switching is Phase 3), so
        // there is nothing further to tear down for that case.
        setWalletEntries(next.wallets);
        setSuccess(`Removed wallet "${removed.name}".`);
      } catch (e: any) {
        setError("Failed to remove wallet: " + (e?.message || String(e)));
      }
    },
    [
      sessionPassword,
      setError,
      setSuccess,
      setWalletEntries,
      setHasSaved,
      setView,
      checkXmrHostWalletInUse,
      checkCnHostWalletInUse,
      setWalletsByChain,
      setXmrSeedLoaded,
      setZphSeedLoaded,
      setZanoSeedLoaded,
      setZanoSeedPassphrase,
      forgetXmrSession,
      forgetZphSession,
      forgetZanoSession,
    ]
  );

  /**
   * Switch the ACTIVE wallet context (Phase 3). `walletId` is a wallet id or
   * "all" (unified — resolves to the primary context until Phase 4 builds true
   * aggregation). Re-derives `walletsByChain` from the target context's bip39
   * member, re-points the Monero/Zephyr sidecar sessions to the context's
   * xmr/zph members (opening each wallet's OWN file), and persists the choice
   * as `lastActiveWalletId` so the next unlock restores it.
   */
  const switchWallet = useCallback(
    async (walletId: string): Promise<void> => {
      if (!sessionPassword) {
        setError("Session password missing — lock and unlock the wallet, then try again.");
        return;
      }
      try {
        const v3 = await loadVaultV3(sessionPassword);
        const ctx = contextForWallet(v3, walletId);
        if (!ctx) return;
        await saveVaultV3({ ...v3, lastActiveWalletId: walletId }, sessionPassword);
        setActiveWalletId(walletId);

        // BIP39 chains from this context's bip39 member (empty for a pure
        // XMR/ZPH standalone wallet).
        const bip39Entry = memberOfKind(ctx, "bip39");
        const choice = { ...DEFAULT_DERIVATION_CHOICE, ...bip39Entry?.derivationChoice };
        setActiveDerivationChoice(choice);
        const newWallets: Partial<Record<ChainType, WalletInfo>> = bip39Entry
          ? deriveAllChains(bip39Entry.seed, choice)
          : {};

        // Re-point the Monero session (open this wallet's own file), or clear.
        // Per-coin failures are isolated so a bad XMR entry never blocks the
        // rest of the switch (the bip39 chains + Zephyr still load).
        const xmrEntry = memberOfKind(ctx, "xmr");
        if (xmrEntry) {
          try {
            newWallets.monero = await xmrAdapter.deriveFromOwnSeed!(xmrEntry.seed);
            setXmrSeedLoaded(xmrEntry.seed);
            setActiveXmrSeed(xmrEntry.seed);
            startXmrSync(
              xmrEntry.seed,
              sessionPassword,
              xmrEntry.restoreHeight ?? 0,
              sidecarFileForEntry(xmrEntry)
            );
          } catch (e) {
            console.warn("[useVault] switchWallet: Monero re-point failed:", e);
            setXmrSeedLoaded(null);
          }
        } else {
          // The TARGET context has no Monero entry — this is a context
          // switch, not a request to delete the PREVIOUS context's wallet.
          // lockXmrSession (not forget) so its scan state survives a
          // switch back later.
          setXmrSeedLoaded(null);
          void lockXmrSession();
        }

        // Re-point the Zephyr session likewise.
        const zphEntry = memberOfKind(ctx, "zph");
        if (zphEntry) {
          try {
            newWallets.zephyr = await zphAdapter.deriveFromOwnSeed!(zphEntry.seed);
            setZphSeedLoaded(zphEntry.seed);
            startZphSync(
              zphEntry.seed,
              sessionPassword,
              zphEntry.restoreHeight ?? 0,
              sidecarFileForEntry(zphEntry)
            );
          } catch (e) {
            console.warn("[useVault] switchWallet: Zephyr re-point failed:", e);
            setZphSeedLoaded(null);
          }
        } else {
          setZphSeedLoaded(null);
          void forgetZphSession();
        }

        // Single-chain members (privateKey / watch): populate just their one
        // chain. A private key derives a full signing WalletInfo; a watch entry
        // gets a `watchOnly` WalletInfo (no key → Send/Swap hidden, addressFor
        // never resolves it).
        const pkEntry = memberOfKind(ctx, "privateKey");
        if (pkEntry?.chain) {
          try {
            newWallets[pkEntry.chain] = getAdapter(pkEntry.chain).importFromPrivateKey(pkEntry.seed);
          } catch (e) {
            console.warn("[useVault] switchWallet: private-key derive failed:", e);
          }
        }
        const watchEntry = memberOfKind(ctx, "watch");
        if (watchEntry?.chain && watchEntry.address) {
          newWallets[watchEntry.chain] = {
            chain: watchEntry.chain,
            address: watchEntry.address,
            mnemonic: "",
            privateKey: "",
            watchOnly: true,
          };
        }

        // Focus a single-chain (PK/watch) wallet on its own chain so the detail
        // pane + the watch-only Send guard (which reads walletsByChain[activeChain])
        // line up with the wallet the user just opened.
        const singleChain = pkEntry?.chain ?? watchEntry?.chain;
        if (singleChain) setActiveChain(singleChain);

        // Re-point the Zano session, exactly like Monero and Zephyr above.
        //
        // Until 2026-09-02 Zano was a vault-WIDE `zanoSeed` field rather than a
        // `WalletEntry`, so every context shared one Zano wallet and this
        // function had to carry the previous context's entry across by hand
        // (`if (prev.zano) carried.zano = prev.zano`) just to stop it vanishing
        // from the UI. That carry was correct for the old one-seed model and
        // WRONG the moment a second Zano wallet could exist: it would have shown
        // the previous context's Zano wallet under the new context's name.
        //
        // The legacy top-level seed reads through `legacyZanoSeedFor`, which
        // is SCOPED to the primary group. Unscoped — as it was until
        // 2026-09-05 — it handed the same Zano wallet to every context, which
        // is the fault the promotion itself was for. Per-coin failures stay
        // isolated, as for xmr/zph.
        const zanoEntry = memberOfKind(ctx, "zano");
        const legacyZano = zanoEntry ? null : legacyZanoSeedFor(v3, ctx.groupId);
        const zanoSeed = zanoEntry?.seed ?? legacyZano?.seed ?? null;
        if (zanoSeed) {
          try {
            const passphrase =
              zanoEntry?.zanoSeedPassphrase ?? legacyZano?.passphrase ?? "";
            newWallets.zano = {
              chain: "zano",
              address: zanoAddressFromSeed(zanoSeed, passphrase),
              mnemonic: zanoSeed,
              privateKey: "",
            };
            setZanoSeedLoaded(zanoSeed);
            setZanoSeedPassphrase?.(passphrase || null);
            startZanoSync(
              zanoSeed,
              sessionPassword,
              passphrase,
              zanoEntry ? sidecarFileForEntry(zanoEntry) : undefined
            );
          } catch (e) {
            console.warn("[useVault] switchWallet: Zano re-point failed:", e);
            setZanoSeedLoaded(null);
          }
        } else {
          // Target context has no Zano wallet — stop the sidecar rather than
          // leaving the previous context's Zano RPC serving this one.
          setZanoSeedLoaded(null);
          setZanoSeedPassphrase?.(null);
          void forgetZanoSession();
        }

        setWalletsByChain(newWallets);
        setSuccess(`Switched to "${ctx.name}".`);
      } catch (e: any) {
        setError("Failed to switch wallet: " + (e?.message || String(e)));
      }
    },
    [
      sessionPassword,
      deriveAllChains,
      setError,
      setSuccess,
      setWalletsByChain,
      setActiveWalletId,
      setActiveChain,
      setXmrSeedLoaded,
      setZphSeedLoaded,
      setZanoSeedLoaded,
      setZanoSeedPassphrase,
      startXmrSync,
      startZphSync,
      startZanoSync,
      lockXmrSession,
      forgetZphSession,
      forgetZanoSession,
    ]
  );

  return {
    // Pending seeds (read by BackupView; cleared by handleSetPassword + handleLogout)
    pendingBip39,
    pendingXmrSeed,
    pendingZphSeed,
    pendingDerivationChoice,

    // Auth-flow handlers (M9)
    handleCreate,
    handleImport,
    handleConfirmDerivation,
    handleSetPassword,
    handleUnlock,
    handleRemoveWallet,
    handleLogout,

    // Save helpers (M8) — forgetting XMR/ZPH now goes through removeWallet
    // (Settings ▸ Wallets), which folds in the same session teardown these
    // used to do on their own; see removeWallet's isPrimaryXmr/isPrimaryZph.
    // Zano has no removeWallet equivalent yet (not a WalletKind — see
    // vault-schema.ts's VaultPayloadV3.zanoSeed doc comment); forgetting it
    // today means clearing the seed field via a fresh saveZanoSeedToVault
    // call or logging out (handleLogout calls forgetZanoSession, which
    // closes the sidecar but — like XMR/ZPH before removeWallet existed —
    // does not itself clear the vault-stored seed).
    saveXmrSeedToVault,
    saveZphSeedToVault,
    saveZanoSeedToVault,

    // Multi-wallet CRUD (Phase 2) — drives Settings ▸ Wallets
    addWallet,
    renameWallet,
    removeWallet,
    walletOpBusy,
    // Wallet switching (Phase 3) — drives the rail switcher
    switchWallet,

    // Post-hoc derivation switcher (2026-05-07)
    handleChangeSolanaDerivation,
    handleChangeCardanoDerivation,
    handleChangeAlgorandDerivation,
    handleChangeLitecoinDerivation,
    // Profile-coin switchers (2026-06-21, Phase 3)
    handleChangeCoinDerivation,
    handleApplyProfile,
    activeDerivationChoice,

    // Sync BIP39 → per-chain derivation helper. Exposed so the App.tsx
    // dev-mode auth bypass can populate walletsByChain from a test
    // mnemonic without going through the encrypted-vault unlock flow.
    deriveAllChains,
  };
}
