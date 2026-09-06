/**
 * C-RZ / C-RX — read and set consent for the swap engine to use this app's
 * own ZEPH wallet-rpc, or to run Zano's engine-owned scratch wallet beside
 * the app's Main. The ZEPH/ZANO twin of `useXmrHostWalletConsent`, kept as a
 * separate hook rather than a coin parameter on that one because the two
 * read different `CoinEnableStatus` rows and write through different
 * commands — see `swapSidecarSetCnHostWallet`'s doc for why the commands are
 * separate.
 *
 * Same discipline as the Monero hook: ONE best-effort read on mount/enable
 * (consent changes only on user action, so there is no live state to poll),
 * a failed read leaves `ack` at its default rather than surfacing an error,
 * and only the SET path reports one — that is the call the user is waiting
 * on.
 *
 * # Why this exists (2026-09-04)
 *
 * Until today the backend half (`maybe_activate_zph_host_wallet` /
 * `maybe_activate_zano_host_wallet`, the `*_host_wallet_ack_at` fields, the
 * `shares_zph_host_wallet` / `shares_zano_host_wallet` predicates) and the
 * consent card (`DexCnWalletCard`) both existed and nothing connected them:
 * no command wrote the ack fields, and `swap_sidecar_coin_status` routed both
 * coins through the lean predicate, which is unconditionally false for them.
 * XMR had all three pieces wired; ZEPH/ZANO had two of three. This hook is
 * the third.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  swapSidecarCoinStatus,
  swapSidecarSetCnHostWallet,
  type CnHostWalletCoin,
} from "../../api/basicswap";

export interface CnHostWalletConsentState {
  /** Current consent, best-effort. `false` covers both "declined" and
   *  "could not be read yet" — the control degrades to its default rather
   *  than an error state for a read failure. Note the Rust default is
   *  OPT-OUT (sharing on unless declined), so a successful read of an
   *  untouched, enabled coin reports `true`. */
  ack: boolean;
  /** The row's `enabled` flag — the card only offers the control for a coin
   *  the node is configured to run; sharing consent for a disabled coin is
   *  a decision about nothing. */
  enabled: boolean;
  /**
   * True once sharing is ACTIVE in the config the swap node booted from —
   * `CoinEnableStatus.hostWalletActive`, which Rust reads from the coin's
   * own config key (`mainwalletrpcport` for zephyr, `scratchwalletrpcport`
   * for zano). `ack` means "the user asked for this"; `active` means "the
   * write landed in the config the running node read". Between them sits
   * the ordinary "will share, node not restarted yet".
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

export function useCnHostWalletConsent(
  coin: CnHostWalletCoin,
  enabledForRead: boolean,
): CnHostWalletConsentState {
  const [ack, setAckState] = useState(false);
  const [enabled, setEnabledState] = useState(false);
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
    if (!enabledForRead) {
      setAckState(false);
      setEnabledState(false);
      setActiveState(false);
      setError(null);
      return;
    }
    void swapSidecarCoinStatus()
      .then((statuses) => {
        if (!alive.current) return;
        const row = statuses.find((s) => s.coin === coin);
        setAckState(row?.sharesWallet ?? false);
        setEnabledState(row?.enabled ?? false);
        setActiveState(row?.hostWalletActive === true);
      })
      .catch(() => {
        /* best-effort — see module header */
      });
  }, [coin, enabledForRead]);

  const setAck = useCallback(
    async (share: boolean) => {
      setBusy(true);
      setError(null);
      try {
        await swapSidecarSetCnHostWallet(coin, share);
        if (alive.current) setAckState(share);
        // Withdrawing consent ends any confirmed sharing at the next start;
        // mirror that immediately rather than leaving `active` stuck true
        // until the next full read (same reasoning as the Monero hook).
        if (alive.current && !share) setActiveState(false);
      } catch (e) {
        if (alive.current) setError(errMsg(e));
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [coin],
  );

  return { ack, enabled, active, busy, error, setAck };
}
