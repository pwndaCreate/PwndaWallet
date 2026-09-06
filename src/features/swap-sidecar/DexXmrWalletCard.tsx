/**
 * The swap node's Monero wallet — a **pure presentational** card (contract §2.2).
 *
 * Zero `invoke`; the mount site owns `useDexXmrWallet` and hands the result in.
 *
 * Copy constraints:
 *
 *  - **This is the node's XMR wallet, not the vault's.** Two Monero balances in
 *    one app is confusing enough that the card says which one it is in its own
 *    body rather than leaving the title to carry it.
 *  - **Rotating is a real action with a consequence.** `nextdepositaddr`
 *    derives a *new* subaddress; the old one still receives, but anyone the
 *    user already handed it to will be paying an address the card no longer
 *    shows. The button says "new address", not "refresh".
 *  - **Reserved is caller-supplied.** No endpoint reports XMR committed to live
 *    bids; when the caller passes `null` the card says the figure is unknown
 *    rather than rendering the full balance as spendable.
 *  - **A null address is not an error** — upstream's placeholders are mapped to
 *    null upstream of this card (§R18), and "not available yet" is the honest
 *    rendering.
 */
import { useState, type CSSProperties } from "react";
import { Card, Btn } from "../../design/primitives";
import type { BasicSwapWalletInfo } from "../../api/basicswap";
import { displayAddress, isNegativeAmount, spendableXmr } from "./dexXmrWallet";

const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1.6,
};

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div
      style={{
        ...mono,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "4px 0",
      }}
    >
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span className="tnum" style={{ color: tone ?? "var(--text)", textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

/**
 * @param info        the XMR entry of `/json/wallets`, or null
 * @param reservedXmr decimal string committed to in-flight swaps, or null when
 *                    the caller has no view of it
 * @param onRotateAddress omit to hide the rotate control entirely
 * @param hostWalletAck C9 — has the user consented to point the swap engine
 *        at their own wallet-rpc? Only affects the button's own label/variant
 *        (owned by this card); the explanatory LINE beside it is caller-owned
 *        copy (`hostWalletLine`) — this card has no cross-feature import on
 *        `src/features/monero/dexXmrCopy.ts`, so it cannot choose the text
 *        itself (BOUNDARIES.md: `swap-sidecar` may not import `monero`).
 * @param onSetHostWalletAck omit to hide the C9 control entirely
 * @param hostWalletLine the one line of copy to show beside the control.
 *        Required whenever `onSetHostWalletAck` is given — the mount owns
 *        the words, the card only decides whether to show them.
 * @param hostWalletBusy disables the control mid-request
 */
export function DexXmrWalletCard({
  info,
  reservedXmr,
  onRotateAddress,
  error = null,
  hostWalletAck,
  onSetHostWalletAck,
  hostWalletLine,
  hostWalletBusy = false,
}: {
  info: BasicSwapWalletInfo | null;
  reservedXmr: string | null;
  onRotateAddress?: () => void;
  error?: string | null;
  hostWalletAck?: boolean;
  onSetHostWalletAck?: (share: boolean) => void;
  hostWalletLine?: string;
  hostWalletBusy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const addr = displayAddress(null, info);
  const spendable = spendableXmr(info, reservedXmr);
  const overcommitted = isNegativeAmount(spendable);

  const copy = () => {
    if (!addr) return;
    void navigator.clipboard
      ?.writeText(addr)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* clipboard denied — the address is still on screen */
      });
  };

  return (
    <Card title="SWAP NODE — MONERO">
      <div style={{ ...mono, fontSize: 10.5, color: "var(--text-dim)", marginBottom: 8 }}>
        Held by the local swap node, separate from your wallet's own Monero
        balance. Sending from here means sweeping it back to your own wallet.
      </div>

      <Row label="balance" value={info?.balance ?? "—"} />
      <Row label="pending" value={info?.unconfirmed ?? "—"} />
      <Row
        label="reserved for swaps"
        value={reservedXmr ?? "unknown"}
        tone={reservedXmr == null ? "var(--text-muted)" : undefined}
      />
      <Row
        label="spendable"
        value={spendable ?? "—"}
        tone={overcommitted ? "var(--danger)" : "var(--accent)"}
      />

      {overcommitted && (
        <div style={{ ...mono, fontSize: 10.5, color: "var(--danger)", marginTop: 4 }}>
          More is reserved for in-flight swaps than the node reports holding.
          Do not sweep until that settles.
        </div>
      )}

      <div
        style={{
          ...mono,
          fontSize: 10.5,
          marginTop: 10,
          paddingTop: 8,
          borderTop: "1px solid var(--border-soft)",
        }}
      >
        <div style={{ color: "var(--text-dim)", marginBottom: 4 }}>
          deposit subaddress
        </div>
        {addr ? (
          <div style={{ color: "var(--text)", wordBreak: "break-all" }}>{addr}</div>
        ) : (
          <div style={{ color: "var(--text-muted)" }}>not available yet</div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          {addr && (
            <Btn variant="ghost" size="sm" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Btn>
          )}
          {onRotateAddress && (
            <Btn variant="ghost" size="sm" onClick={onRotateAddress}>
              New address
            </Btn>
          )}
        </div>
      </div>

      {/* C9 consent control. Hidden entirely when the mount has not wired a
          read for it — an offered-then-unanswerable toggle is worse than an
          absent one, the same rule DexCoinCard's "Use my wallet" follows. */}
      {onSetHostWalletAck && (
        <div
          style={{
            ...mono,
            fontSize: 10.5,
            marginTop: 10,
            paddingTop: 8,
            borderTop: "1px solid var(--border-soft)",
          }}
        >
          <div style={{ color: "var(--text-dim)", marginBottom: 6 }}>
            {hostWalletLine}
          </div>
          <Btn
            variant={hostWalletAck ? "accent" : "ghost"}
            size="sm"
            disabled={hostWalletBusy}
            onClick={() => onSetHostWalletAck(!hostWalletAck)}
          >
            {hostWalletBusy
              ? "…"
              : hostWalletAck
                ? "Preference recorded"
                : "Use my own wallet"}
          </Btn>
        </div>
      )}

      {error && (
        <div
          style={{
            ...mono,
            fontSize: 11,
            color: "var(--danger)",
            wordBreak: "break-word",
            marginTop: 8,
          }}
        >
          {error}
        </div>
      )}
    </Card>
  );
}
