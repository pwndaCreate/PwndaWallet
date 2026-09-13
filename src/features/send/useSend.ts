import { useCallback, useState } from "react";
import { shouldUseAccountSend } from "./accountSend";
import type {
  ChainAdapter,
  ChainType,
  TxResult,
  WalletInfo,
} from "../../wallets";

/**
 * Send-flow hook. Owns:
 *   - Modal visibility (`showSendModal`).
 *   - The form fields (`sendTo`, `sendAmount`).
 *   - The async send-in-flight flag (`sending`).
 *   - `handleSend` — the actual send action that goes through the
 *     active chain's adapter.
 *
 * On success: clears the form, closes the modal, refreshes the
 * balance for the active chain, and pings the tx-history hook so
 * the pending transaction appears in Activity within seconds rather
 * than waiting for the next 60s poll.
 *
 * XMR is special — `adapter.sendTransaction` for Monero takes the
 * full seed (not a raw private key hex), so the caller passes
 * `xmrSeedLoaded` and we substitute it in.
 */
export function useSend(args: {
  wallet: WalletInfo | null;
  adapter: ChainAdapter;
  activeChain: ChainType;
  xmrSeedLoaded: string | null;
  refreshBalance: () => void;
  refreshTxHistory: (chain?: ChainType) => Promise<void> | void;
  setError: (msg: string) => void;
  setSuccess: (msg: string) => void;
  /**
   * An alternate transport for the active chain's send, used INSTEAD OF
   * `adapter.sendTransaction` when present. Today: Stellar / NEAR / Sui, whose
   * signers are session-gated in Rust (`App.tsx::sessionSignedSendOverride`).
   *
   * `useSend` has no swap-sidecar awareness by design (BOUNDARIES.md scopes
   * the `send` feature to `src/wallets/*` + `src/store` + `src/state/*`
   * only), so the caller decides when an override applies. `undefined` means
   * "send exactly as the adapter does".
   *
   * **Correction, 2026-09-12.** This used to also carry C8's route for a
   * Grove-shared BTC/LTC: the send went INTO the swap engine, justified first
   * by "the engine holds the complete account" (false for LTC since
   * 2026-08-25, when `sendFromAccount` gathered the whole account) and then by
   * "one writer at a time". The second reason cost more than it protected: a
   * conflicting spend is rejected by the mempool, not paid twice, while the
   * routing made every BTC/LTC send depend on Grove being up, unlocked and
   * keyed — and on 2026-09-12 an LTC send failed silently during a Grove
   * restart. Shared coins now sign with the wallet's own account path like
   * any other UTXO chain; the one real interaction (a swap funding a lock
   * from the same coins) is `sendGuard`'s job below.
   */
  sendOverride?: (to: string, amount: string) => Promise<TxResult>;
  /**
   * Asked immediately before the send. Resolve with a message to refuse (it is
   * shown as the failure, and nothing is signed), or `null` to send.
   *
   * Used for Grove-shared coins: `checkSharedCoinSend` refuses only when Grove
   * definitely reports a swap in flight on the coin, and resolves `null` when
   * Grove is stopped, locked or slow — so a guard can never make an ordinary
   * send depend on the sidecar.
   */
  sendGuard?: (to: string, amount: string) => Promise<string | null>;
}) {
  const {
    wallet,
    adapter,
    activeChain,
    xmrSeedLoaded,
    refreshBalance,
    refreshTxHistory,
    setError,
    setSuccess,
    sendOverride,
    sendGuard,
  } = args;

  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [showSendModal, setShowSendModal] = useState(false);
  // Optional per-chain asset selector — only Zephyr uses it (ZSD/ZRS/ZYS).
  // `undefined` means "the chain's native asset" (the default for every other
  // chain and for the focal ZEPH send).
  const [sendAssetType, setSendAssetType] = useState<string | undefined>(undefined);

  const openSendModal = useCallback((assetType?: string) => {
    // Coerce anything that is not a string to `undefined`. React passes its
    // SyntheticEvent as the first argument to a handler wired as
    // `onClick={openSendModal}`, and the prop types along the way declare
    // `() => void` — which structurally accepts this one-parameter function, so
    // tsc cannot see the mismatch. The result was `sendAssetType` holding an
    // event object after every dashboard Send. Harmless for adapters that
    // ignore the 4th argument of `sendTransaction`, NOT harmless for Zephyr
    // (which branches on it), and it silently disabled the account-wide send
    // guard. Fixed at the call site too (`DashboardView.tsx`); this is the
    // funnel that makes every other call site safe by construction.
    // See the 2026-08-25 entry in `PwndaWalletVault/log.md`.
    setSendAssetType(typeof assetType === "string" ? assetType : undefined);
    setShowSendModal(true);
  }, []);
  const closeSendModal = useCallback(() => {
    setShowSendModal(false);
    setSendAssetType(undefined);
  }, []);

  /**
   * `feeRate` is the Send modal's selected tier, in the adapter's base units
   * per (v)byte, for chains whose estimate is a rate (`feeRateForSend`).
   * Coerced: anything that is not a positive finite number is dropped, because
   * a handler wired as `onClick={handleSend}` receives a MouseEvent here — the
   * same shape as the `openSendModal` event bug documented above.
   */
  const handleSend = useCallback(async (feeRateArg?: unknown) => {
    if (!wallet) return;
    const feeRate =
      typeof feeRateArg === "number" && Number.isFinite(feeRateArg) && feeRateArg > 0
        ? feeRateArg
        : undefined;
    setError("");
    setSuccess("");
    setSending(true);
    try {
      // Per-chain key-material override:
      //   - XMR uses the 25-word seed, NOT a private-key hex.
      //   - Cardano uses the BIP-39 mnemonic, because BIP-32-Ed25519
      //     signing requires the FULL extended secret (kL || kR + chain
      //     code), which can only be re-derived from the mnemonic. The
      //     stored privateKey field carries only the 64-byte payment
      //     extended secret for display — it doesn't carry the chain
      //     code needed for signing.
      //   - Every other chain uses the standard privateKey.
      const keyMaterial =
        activeChain === "monero" && xmrSeedLoaded
          ? xmrSeedLoaded
          : activeChain === "cardano" && wallet.mnemonic
            ? wallet.mnemonic
            : wallet.privateKey;

      // Prefer the ACCOUNT-WIDE path (2026-08-25). `sendTransaction` takes one
      // private key and can therefore only spend the single address that key
      // derives — which on a UTXO chain goes empty as soon as anything spends
      // with real BIP-32 change behaviour, leaving a correct, displayed,
      // non-zero balance that cannot be sent. See `ChainAdapter.sendFromAccount`.
      //
      // Four conditions, all required, and none of them decorative:
      //   - the adapter offers it (most chains are not UTXO and never split);
      //   - we hold the mnemonic (deriving siblings is the whole mechanism —
      //     a child key cannot produce them);
      //   - `supportsAccountSend` confirms THIS wallet is on the account the
      //     adapter scans (LTC also exposes a BIP-44 legacy account, and
      //     scanning the wrong one would report a false shortfall — the very
      //     failure this fixes);
      //   - no token asset type, because the account path spends the native
      //     coin only.
      // Any of them false falls through to the existing single-key path.
      const useAccountSend = shouldUseAccountSend({
        hasAccountSend: !!adapter.sendFromAccount,
        hasMnemonic: !!wallet.mnemonic,
        accountMatches: wallet.mnemonic
          ? (adapter.supportsAccountSend?.(wallet.mnemonic, wallet.address) ?? false)
          : false,
        assetType: sendAssetType,
      });

      // Refusal BEFORE anything is signed. Thrown so it lands on the same
      // "Transaction failed: …" line every other failure uses.
      if (sendGuard) {
        const refusal = await sendGuard(sendTo, sendAmount);
        if (refusal) throw new Error(refusal);
      }

      const result = sendOverride
        ? await sendOverride(sendTo, sendAmount)
        : useAccountSend
          ? await adapter.sendFromAccount!(
              wallet.mnemonic!,
              sendTo,
              sendAmount,
              wallet.address,
              { feeRate }
            )
          : await adapter.sendTransaction(
              keyMaterial,
              sendTo,
              sendAmount,
              sendAssetType
            );
      setSuccess(`Transaction sent! Hash: ${result.hash}`);
      setSendTo("");
      setSendAmount("");
      setShowSendModal(false);
      setSendAssetType(undefined);
      refreshBalance();
      // Pre-emptively refresh tx history for the chain we just sent on so
      // the new (pending) transaction shows up in Activity within seconds
      // instead of waiting for the next 60s poll.
      void refreshTxHistory(activeChain);
    } catch (e: any) {
      setError("Transaction failed: " + e.message);
    } finally {
      setSending(false);
    }
  }, [
    wallet,
    adapter,
    activeChain,
    xmrSeedLoaded,
    sendTo,
    sendAmount,
    sendAssetType,
    sendOverride,
    sendGuard,
    refreshBalance,
    refreshTxHistory,
    setError,
    setSuccess,
  ]);

  return {
    sendTo,
    setSendTo,
    sendAmount,
    setSendAmount,
    sending,
    showSendModal,
    openSendModal,
    closeSendModal,
    handleSend,
    /** The Zephyr asset being sent (ZSD/ZRS/ZYS), or undefined for the chain's
     *  native asset. Drives the SendModal's asset label. */
    sendAssetType,
  };
}
