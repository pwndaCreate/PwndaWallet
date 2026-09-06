/**
 * C9 — read and set consent to point the swap engine's Monero wallet at this
 * app's own `monero-wallet-rpc`.
 *
 * A single one-shot read on mount/enable, not a continuous poll: consent
 * changes only on user action, so there is no live state to track between
 * clicks. `DexXmrWalletSection`'s own mount comment already flags a SECOND
 * `useSidecarBalances` poll on this exact surface as an accepted cost — this
 * hook is written not to add a third.
 *
 * Best-effort read: a failed status fetch leaves `ack` at its default
 * (`false`) rather than surfacing an error, so a transient read failure
 * cannot make the toggle appear stuck in a state the user did not choose.
 * Only the SET path surfaces an error — that is the one the user is waiting
 * on a response to.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { swapSidecarCoinStatus, swapSidecarSetXmrHostWallet } from "../../api/basicswap";

export interface XmrHostWalletConsentState {
  /** Current consent, best-effort. `false` covers both "never consented" and
   *  "could not be read yet" — the toggle degrades to its default rather than
   *  an error state for a read failure. */
  ack: boolean;
  /**
   * True once C9 sharing is ACTIVE in the config the swap node booted from —
   * `CoinEnableStatus.xmrHostWalletActive`, which Rust computes from
   * `chainclients.monero.mainwalletrpcport`, the same key the engine branches
   * on to set `_external_main_wallet`.
   *
   * `ack` means "the user asked for this"; `active` means "the write actually
   * landed in the config the running node read". A mount still showing "this
   * is a separate wallet" once `active` is true would be actively wrong, not
   * merely stale — the two wallets are the same account at that point.
   *
   * **Corrected 2026-08-21, same day it shipped.** This was
   * `adoption === "accountkey"`, copied from `DexCoinCard`'s BTC/LTC test.
   * That is C8's account-key push, which Monero never travels — C9 shares by
   * redirecting the engine's wallet-rpc instead, so a fully shared Monero
   * wallet sits at `adoption: "deposit"` permanently. The check could
   * therefore never fire, and the card it gates could never hide. Caught by
   * reading the operator's own opt-in record during a mainnet-readiness
   * audit: `monero: adoption = "deposit"` while their engine was
   * demonstrably running on their wallet.
   */
  active: boolean;
  busy: boolean;
  /** The SET path's own error, verbatim. Null once cleared by a fresh attempt. */
  error: string | null;
  setAck: (share: boolean) => Promise<void>;
}

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

export function useXmrHostWalletConsent(enabled: boolean): XmrHostWalletConsentState {
  const [ack, setAckState] = useState(false);
  const [active, setActiveState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setAckState(false);
      setActiveState(false);
      setError(null);
      return;
    }
    void swapSidecarCoinStatus()
      .then((statuses) => {
        if (!alive.current) return;
        const monero = statuses.find((s) => s.coin === "monero");
        setAckState(monero?.sharesWallet ?? false);
        setActiveState(monero?.xmrHostWalletActive === true);
      })
      .catch(() => {
        /* best-effort — see module header */
      });
  }, [enabled]);

  const setAck = useCallback(async (share: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await swapSidecarSetXmrHostWallet("monero", share);
      if (alive.current) setAckState(share);
      // Withdrawing consent also ends any confirmed sharing — the mock and
      // the real backend both revert `adoption` off `accountkey` the moment
      // consent is pulled (see `dexCoins.ts`'s own comment on that exact
      // symmetry for the C8 coins), so this mirrors it rather than leaving
      // `active` stuck true until the next full read.
      if (alive.current && !share) setActiveState(false);
    } catch (e) {
      if (alive.current) setError(errMsg(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  return { ack, active, busy, error, setAck };
}
