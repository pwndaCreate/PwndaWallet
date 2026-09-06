/**
 * XMR-wallet-surface mount for `DexXmrWalletCard` (contract C6, UI side).
 *
 * The card was exported from `features/swap-sidecar/index.ts` and mounted
 * **nowhere**, so the swap node's Monero wallet — the account that actually
 * holds XMR during a swap — was invisible to the user. This is its host:
 * landscape first (`WalletLandscapeView`'s right rail on the Monero panel),
 * portrait inheriting the same block (`DashboardView`'s Monero branch).
 *
 * It sits **inside the Monero surface and clearly separated from it**: a
 * labelled divider, then the card, then the two sentences that say what it is
 * and what it cannot do (see `dexXmrCopy.ts` for why both are mandatory).
 *
 * Split pure/hook like the other two mounts so the gate and the copy are
 * testable without a DOM.
 */
import { useEffect, useState } from "react";
import {
  DexXmrWalletCard,
  useDexXmrWallet,
  useXmrHostWalletConsent,
} from "../swap-sidecar";
import type { SidecarBalanceRow } from "../swap-sidecar";
import {
  DEX_XMR_DISTINCT_NOTE,
  DEX_XMR_SEND_CAVEAT,
  dexXmrVisible,
  walletInfoFromRow,
  xmrHostWalletCopy,
  type DexXmrWalletInfo,
} from "./dexXmrCopy";

const mono = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  lineHeight: 1.6,
} as const;

/**
 * Pure presentational half — no hooks, callable from a test.
 *
 * @param visible result of {@link dexXmrVisible}; false renders nothing
 * @param info    the adapted wallet entry, or null
 * @param onRotate omit to hide the rotate control (the card hides it itself)
 */
export function DexXmrWalletPanel({
  visible,
  info,
  error,
  onRotate,
  hostWalletAck,
  onSetHostWalletAck,
  hostWalletBusy = false,
}: {
  visible: boolean;
  info: DexXmrWalletInfo | null;
  error: string | null;
  onRotate?: () => void;
  /** C9. Omit both this and `onSetHostWalletAck` to hide the control entirely
   *  (mirrors `onRotate`'s omit-to-hide contract). */
  hostWalletAck?: boolean;
  onSetHostWalletAck?: (share: boolean) => void;
  hostWalletBusy?: boolean;
}) {
  if (!visible) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          ...mono,
          fontSize: 9.5,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: "var(--text-muted)",
          paddingBottom: 6,
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        Separate wallet · swap node
      </div>

      <DexXmrWalletCard
        info={info}
        // No endpoint reports XMR committed to in-flight bids. `null` makes the
        // card print "unknown"; a zero here would be an invented number on a
        // fund-moving surface.
        reservedXmr={null}
        onRotateAddress={onRotate}
        error={error}
        hostWalletAck={hostWalletAck}
        onSetHostWalletAck={onSetHostWalletAck}
        hostWalletLine={
          onSetHostWalletAck ? xmrHostWalletCopy(hostWalletAck === true) : undefined
        }
        hostWalletBusy={hostWalletBusy}
      />

      <div style={{ ...mono, color: "var(--text-dim)" }}>{DEX_XMR_DISTINCT_NOTE}</div>
      <div style={{ ...mono, color: "var(--text-dim)" }}>{DEX_XMR_SEND_CAVEAT}</div>
    </div>
  );
}

/**
 * Hook-owning wrapper.
 *
 * @param optedIn tri-state from `useSwapSidecarOptIn()` — `null` is NOT enabled
 * @param row     the `XMR` entry of `useSidecarBalances().rows`, or undefined
 */
export function DexXmrWalletSection({
  optedIn,
  row,
}: {
  optedIn: boolean | null;
  row: SidecarBalanceRow | undefined;
}) {
  // "Eligible" only: opted in and the node is up. Whether the CARD actually
  // renders additionally depends on `hostWallet.active` below — kept as a
  // separate step because `useXmrHostWalletConsent` needs an enable flag
  // that does not itself depend on its own result.
  const eligible = dexXmrVisible(optedIn, row);
  const [rotated, setRotated] = useState<string | null>(null);

  const hostWallet = useXmrHostWalletConsent(eligible);
  // Once C9 sharing is CONFIRMED (not merely consented to), there is no
  // second Monero wallet left to explain — the swap node's own balance and
  // this wallet's balance are the same account, same seed, same address.
  // Showing the "separate wallet, not part of your total" card at that point
  // would be actively false, not just redundant. Found live 2026-08-21: the
  // operator asked why this section was still showing a separate address
  // once their XMR balance was correctly visible in the main wallet panel.
  const visible = eligible && !hostWallet.active;

  // Drop a rotated address as soon as the section goes away — the node
  // stopping, the opt-in being revoked, OR sharing becoming confirmed.
  // Without this, a later un-share brings the card back still displaying a
  // subaddress from the previous session and overriding whatever the fresh
  // poll reported, so the address on screen is no longer the one the node is
  // currently handing out.
  // (`useDexXmrWallet` clears its OWN copy on `enabled: false`; this is the
  // mount's copy, which is the one that reaches the card via `info`.)
  useEffect(() => {
    if (!visible) setRotated(null);
  }, [visible]);

  const info = walletInfoFromRow(row, rotated);
  // No reason to keep polling the node's OWN balance/address once the card
  // that would show them is hidden.
  const wallet = useDexXmrWallet({ enabled: visible, info });

  return (
    <DexXmrWalletPanel
      visible={visible}
      info={info}
      error={wallet.error ?? hostWallet.error}
      onRotate={() => {
        void wallet
          .rotate()
          .then((addr) => setRotated(addr))
          .catch(() => {
            /* surfaced via wallet.error */
          });
      }}
      hostWalletAck={hostWallet.ack}
      onSetHostWalletAck={(share) => void hostWallet.setAck(share)}
      hostWalletBusy={hostWallet.busy}
    />
  );
}
