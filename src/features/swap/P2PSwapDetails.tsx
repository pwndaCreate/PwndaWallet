/**
 * The peer-to-peer part of a swap's details (operator request, 2026-10-01:
 * "Is it possible to have the p2p swaps also tracked inside the swaps and
 * recent swaps sections?").
 *
 * `SwapDetailsModal` renders this for a P2P row (`swapRouteOf` -> "p2p"), in
 * every list that opens it: RECENT SWAPS and HISTORY on the Swap tab, SWAPS in
 * both Activity layouts. What it adds to the shared details:
 *
 * - the bid's stage in plain words: the live tracker's own label and sentence
 *   (`bidStates.ts`), read from the state and leg the row recorded;
 * - both legs' transactions, each named from the user's side ("you locked",
 *   "they claimed"), with the wallet's own explorer links;
 * - who the swap is with, as far as the bid record says: the other user's
 *   offer. The record carries no other name for them (its `addr_from` is this
 *   node's own bid address, not theirs), and the tracker shows no
 *   counterparty identity either;
 * - for an unfinished swap, a way to open the live tracker.
 *
 * Rendered only. Nothing here asks the swap node anything: the tracker does,
 * and the details re-read the row whenever it writes.
 */
import { useState, type CSSProperties } from "react";
import { Btn } from "../../components/PrimitivesV2";
import { TxHashField } from "./TxHashField";
import type { SwapHistoryEntry } from "./swap-history-store";
import {
  p2pLegTransactions,
  p2pStageView,
  p2pTrackerHandle,
  type P2PLegTx,
  type P2PTxRole,
} from "./p2p-history";
import {
  requestSidecarTracker,
  type BidSeverity,
  type SidecarTrackerOutcome,
} from "../swap-sidecar";

const SMALL_CAPS: CSSProperties = {
  fontSize: 9,
  color: "var(--text-dim)",
  letterSpacing: 1,
  textTransform: "uppercase",
};

const NOTE: CSSProperties = {
  fontSize: 10,
  lineHeight: 1.5,
  color: "var(--text-muted)",
};

/** The tracker's colours: severity, not stage. A refund is `normal`, the
 *  ordinary text colour, never a warning (`SidecarSwapTracker.tsx`). */
function severityColor(severity: BidSeverity): string {
  switch (severity) {
    case "success":
    case "progress":
      return "var(--accent)";
    case "attention":
      return "var(--warn)";
    default:
      return "var(--text)";
  }
}

const ROLE_LABEL: Readonly<Record<P2PTxRole, string>> = {
  "you-locked": "you locked",
  "they-locked": "they locked",
  "you-claimed": "you claimed",
  "they-claimed": "they claimed",
  "you-refunded": "refunded to you",
  "they-refunded": "refunded to them",
  "pre-refund": "pre-refund",
  other: "",
};

function roleHint(t: P2PLegTx): string {
  const coin = t.asset ?? "coin";
  switch (t.role) {
    case "you-locked":
      return `What you sent: your ${coin}, locked into the swap.`;
    case "they-locked":
      return `The other user's ${coin}, locked into the swap.`;
    case "you-claimed":
      return `What you received: the transaction that paid you the ${coin}.`;
    case "they-claimed":
      return `The other user claiming your ${coin}.`;
    case "you-refunded":
      return `Your ${coin} back to you.`;
    case "they-refunded":
      return `The other user's ${coin} back to them.`;
    case "pre-refund":
      return `Moved the ${coin} lock to its refund path once the first timelock passed.`;
    default:
      return `As the swap node names it: ${t.type}.`;
  }
}

function txLabel(t: P2PLegTx): string {
  const role = ROLE_LABEL[t.role] || t.type.toLowerCase();
  return t.asset ? `${role} · ${t.asset}` : role;
}

const TRACKER_NOTES: Readonly<Record<Exclude<SidecarTrackerOutcome, "opened">, string>> = {
  "not-enabled":
    "Peer-to-peer swaps are switched off on this wallet, so the tracker cannot ask the swap node about this swap. Turn them on in Settings.",
  "not-tracked": "The tracker could not follow this swap.",
};

export function P2PSwapDetails({
  row,
  onClose,
}: {
  row: SwapHistoryEntry;
  /** Closes the details: the tracker opens in their place. */
  onClose: () => void;
}) {
  const [trackerNote, setTrackerNote] = useState<string | null>(null);
  const view = p2pStageView(row);
  const txs = p2pLegTransactions(row);
  const unfinished = row.status === "pending";

  const openTracker = () => {
    setTrackerNote(null);
    const handle = p2pTrackerHandle(row);
    if (!handle) return;
    const heard = requestSidecarTracker({
      bidId: handle.bidId,
      handle,
      stateHint: row.bidState,
      respond: (outcome) => {
        if (outcome === "opened") onClose();
        else setTrackerNote(TRACKER_NOTES[outcome]);
      },
    });
    if (!heard) setTrackerNote("The swap tracker is not running in this window.");
  };

  return (
    <div
      data-p2p-details={row.bidId ?? ""}
      style={{
        padding: "10px 12px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        marginBottom: 10,
      }}
    >
      <div style={SMALL_CAPS}>peer-to-peer swap · stage</div>
      <div
        data-p2p-stage={view.key}
        style={{ fontSize: 13, marginTop: 4, color: severityColor(view.severity) }}
      >
        {view.label}
      </div>
      <div style={{ ...NOTE, marginTop: 4 }}>{view.description}</div>

      {unfinished && (
        <div data-p2p-open-tracker style={{ marginTop: 10 }}>
          <Btn variant="accent" full onClick={openTracker}>
            Open live tracker
          </Btn>
          {trackerNote && (
            <div style={{ ...NOTE, color: "var(--warn)", marginTop: 6 }}>{trackerNote}</div>
          )}
        </div>
      )}

      <div style={{ ...SMALL_CAPS, marginTop: 12 }}>both legs</div>
      {txs.length > 0 ? (
        txs.map((t) => (
          <TxHashField
            key={`${t.type}:${t.txid}`}
            label={txLabel(t)}
            value={t.txid}
            explorerUrl={t.explorerUrl}
            hint={roleHint(t)}
          />
        ))
      ) : (
        <div data-p2p-no-txns style={{ ...NOTE, marginTop: 4 }}>
          The swap node has not reported this swap's transactions to the wallet. Its own
          console lists them under this bid.
        </div>
      )}

      {row.offerId && (
        <TxHashField
          label="with · the other user's offer"
          value={row.offerId}
          hint="The bid record names the other user only by the offer this bid was placed on."
        />
      )}
      {row.bidId && (
        <TxHashField
          label="bid id"
          value={row.bidId}
          hint="This swap's id on your swap node, as its console shows it."
        />
      )}
    </div>
  );
}
