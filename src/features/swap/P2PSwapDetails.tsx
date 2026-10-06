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
 *   counterparty identity either. On a swap where the user was the MAKER
 *   (2026-10-01) the offer is their own;
 * - where the bought coin was paid, when the bid paid the swap node's own
 *   wallet rather than the user's address (`payoutTo`, 2026-10-01; the
 *   address case is the shared details' "payout address" row);
 * - for an unfinished swap, a way to open the live tracker.
 *
 * One read of the swap node, when the details open (2026-10-01): the swap's
 * transactions, through `p2pSwapHistory.refreshTxns`, which writes them into
 * the row. The engine lists an adaptor swap's transactions only for a read
 * that asks, and a swap that ended while nothing was following it was never
 * asked. Everything else the tracker reads, and the details re-read the row
 * whenever anything writes.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Btn } from "../../components/PrimitivesV2";
import { TxHashField } from "./TxHashField";
import type { SwapHistoryEntry } from "./swap-history-store";
import {
  p2pLegTransactions,
  p2pStageView,
  p2pSwapHistory,
  p2pTrackerHandle,
  type P2PLegTx,
  type P2PTxRole,
} from "./p2p-history";
import {
  FEE_KEPT_TAIL,
  feeBearingPurchase,
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

/** Where the read of this swap's transactions is (2026-10-01). */
type TxnsRead = "none" | "reading" | "read" | "failed" | "off";

/** What "both legs" says when no transaction is listed, by why. */
function noTxnsNote(read: TxnsRead, finished: boolean): string {
  switch (read) {
    case "reading":
      return "Reading this swap's transactions from your swap node…";
    case "failed":
      return "Your swap node did not answer, so this swap's transactions could not be read. Open this again with the node running.";
    case "off":
      return "Peer-to-peer swaps are switched off on this wallet, so the swap node was not asked for this swap's transactions. Turn them on in Settings.";
    case "read":
      return finished
        ? "None: this swap ended before either side locked coins."
        : "None yet: neither side has locked coins.";
    default:
      return "The swap node has not reported this swap's transactions to the wallet. Its own console lists them under this bid.";
  }
}

export function P2PSwapDetails({
  row,
  onClose,
}: {
  row: SwapHistoryEntry;
  /** Closes the details: the tracker opens in their place. */
  onClose: () => void;
}) {
  const [trackerNote, setTrackerNote] = useState<string | null>(null);
  const bidId = row.bidId ?? null;
  const [txnsRead, setTxnsRead] = useState<TxnsRead>(bidId ? "reading" : "none");
  const view = p2pStageView(row);
  const txs = p2pLegTransactions(row);
  const unfinished = row.status === "pending";
  const maker = row.bidRole === "maker";
  // A taker's purchase the licence fee is charged on (2026-10-06): its coin
  // stays with the node so the fee can be taken from it, as the confirm
  // screen said. Read from the pair, which is what the bid decided it from.
  const feeKept = !maker && feeBearingPurchase(row.fromAsset, row.toAsset);

  // The swap's transactions, once per opening (2026-10-01). Written into the
  // row by the sink; `SwapDetailsModal` re-reads the row on that write.
  useEffect(() => {
    if (!bidId) {
      setTxnsRead("none");
      return;
    }
    let live = true;
    setTxnsRead("reading");
    void p2pSwapHistory.refreshTxns(bidId).then((outcome) => {
      if (live) setTxnsRead(outcome);
    });
    return () => {
      live = false;
    };
  }, [bidId]);

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
        <div data-p2p-no-txns={txnsRead} style={{ ...NOTE, marginTop: 4 }}>
          {noTxnsNote(txnsRead, !unfinished)}
        </div>
      )}

      {row.payoutTo === "node-wallet" && (
        <div data-p2p-payout="node-wallet" style={{ ...NOTE, marginTop: 10 }}>
          <span style={SMALL_CAPS}>payout · </span>
          {feeKept
            ? `your swap node's ${row.toAsset} wallet, ${FEE_KEPT_TAIL}`
            : `your swap node's ${row.toAsset} wallet, not this wallet's ${row.toAsset} address. The confirm screen said so, and why, before the bid.`}
        </div>
      )}

      {row.offerId &&
        (maker ? (
          <TxHashField
            label="your offer"
            value={row.offerId}
            hint="You were the maker: the other user's bid took this offer, which your swap node posted."
          />
        ) : (
          <TxHashField
            label="with · the other user's offer"
            value={row.offerId}
            hint="The bid record names the other user only by the offer this bid was placed on."
          />
        ))}
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
