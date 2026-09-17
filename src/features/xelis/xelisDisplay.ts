/**
 * What the Xelis cards say about sync progress and transfers. Pure, so the
 * wording rules are tested without mounting a card (`xelisDisplay.test.ts`).
 *
 * Two rules, each learned on Zano in this repo:
 *  - No percentages. `XelisSyncStatus` reports topoheights. A percentage made
 *    from them would be a number nobody measured, so the card says where the
 *    wallet is and how far the node is ahead of it.
 *  - Direction and amount come only from the entry's own `kind` and
 *    `amountAtomic`. Zano's history once showed "Sent -0" over a received
 *    transfer because a response field was guessed.
 */
import {
  atomicToXelis,
  type XelisSyncStatus,
  type XelisTransferEntry,
  type XelisTransferKind,
} from "../../wallets/xelis-rpc";

export type XelisSyncTone = "ok" | "progress" | "warn";

export interface XelisSyncView {
  tone: XelisSyncTone;
  headline: string;
  detail: string;
}

const count = (n: number) => n.toLocaleString("en-US");

/** The sync card's two lines for a status the wallet reported. */
export function describeXelisSync(status: XelisSyncStatus): XelisSyncView {
  const scanned = status.walletTopoheight;
  const at = scanned == null ? null : count(scanned);
  const tip = status.daemonTopoheight;

  if (!status.online) {
    return {
      tone: "warn",
      headline: "Not connected to a Xelis node.",
      detail:
        at == null
          ? "The wallet has not finished its first scan."
          : `The wallet has scanned to topoheight ${at}.`,
    };
  }
  if (status.synced && at != null) {
    return {
      tone: "ok",
      headline: "Synced.",
      detail: tip == null ? `Topoheight ${at}.` : `Topoheight ${at} of ${count(tip)}.`,
    };
  }
  // First sync: the wallet records its height only when the scan finishes.
  if (scanned == null) {
    return {
      tone: "progress",
      headline: "Scanning the chain…",
      detail:
        tip == null
          ? "First scan in progress. The wallet records its height when the scan finishes."
          : `First scan in progress; the node is at topoheight ${count(tip)}. The wallet ` +
            "records its height when the scan finishes.",
    };
  }
  if (tip == null) {
    return {
      tone: "progress",
      headline: "Scanning the chain…",
      detail: `At topoheight ${at}. The node has not reported its own height yet.`,
    };
  }
  const behind = Math.max(0, tip - scanned);
  return {
    tone: "progress",
    headline: "Scanning the chain…",
    detail: `Topoheight ${at} of ${count(tip)} (${count(behind)} behind).`,
  };
}

export interface XelisTransferRow {
  key: string;
  label: string;
  direction: "in" | "out" | "neutral";
  /** Signed for received and sent entries, e.g. "+1.5 XEL". */
  amount: string;
  /** "fee 0.0001 XEL" for an outgoing entry whose fee the wallet reported. */
  fee: string | null;
  when: string;
  where: string;
  hash: string;
  counterparty: string | null;
}

const KIND: Record<
  XelisTransferKind,
  { label: string; direction: XelisTransferRow["direction"]; sign: "+" | "-" | "" }
> = {
  incoming: { label: "Received", direction: "in", sign: "+" },
  outgoing: { label: "Sent", direction: "out", sign: "-" },
  coinbase: { label: "Mined", direction: "in", sign: "+" },
  burn: { label: "Burned", direction: "out", sign: "-" },
  other: { label: "Other", direction: "neutral", sign: "" },
};

const ZERO = BigInt(0);

/** One history row. `index` only disambiguates the React key. */
export function xelisTransferRow(entry: XelisTransferEntry, index = 0): XelisTransferRow {
  const k = KIND[entry.kind] ?? KIND.other;
  // The contract says `amountAtomic` is never negative; if one ever is, the
  // sign still comes from `kind` alone rather than printing "+-1".
  const magnitude = entry.amountAtomic < ZERO ? -entry.amountAtomic : entry.amountAtomic;
  return {
    key: `${entry.hash}-${entry.kind}-${index}`,
    label: k.label,
    direction: k.direction,
    amount: `${k.sign}${atomicToXelis(magnitude)} XEL`,
    fee:
      k.direction === "out" && entry.feeAtomic != null
        ? `fee ${atomicToXelis(entry.feeAtomic)} XEL`
        : null,
    when: entry.timestamp != null ? new Date(entry.timestamp).toLocaleString() : "time unknown",
    where: `topoheight ${count(entry.topoheight)}`,
    hash: entry.hash,
    counterparty: entry.counterparty,
  };
}
