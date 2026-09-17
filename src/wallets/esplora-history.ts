/**
 * Esplora (`/address/:a/txs`) → `ChainTx`, for one address.
 *
 * Esplora answers with the latest 25 confirmed transactions plus everything in
 * the mempool, each carrying its inputs' prevouts, so one request gives the
 * address's net for every row. `meta.netSat` keeps that net SIGNED: a
 * multi-address wallet sums it per txid (`mergeChainTx`), which is how a send
 * whose change went to another of the wallet's own addresses reads as the
 * amount that actually left, not as the whole spent input.
 *
 * Paging: pass the txid of the oldest row as `/txs/chain/:txid`.
 */
import type { ChainTx, ChainType } from "./types";

export interface EsploraTx {
  txid: string;
  fee?: number;
  status?: { confirmed?: boolean; block_height?: number; block_time?: number };
  vin?: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } | null }>;
  vout?: Array<{ scriptpubkey_address?: string; value?: number }>;
}

export function esploraTxToChainTx(tx: EsploraTx, address: string, chain: ChainType): ChainTx {
  let outFromMe = 0;
  for (const vin of tx.vin ?? []) {
    if (vin.prevout?.scriptpubkey_address === address) outFromMe += vin.prevout.value || 0;
  }
  let inToMe = 0;
  let firstExternalOut: string | undefined;
  for (const vout of tx.vout ?? []) {
    if (vout.scriptpubkey_address === address) inToMe += vout.value || 0;
    else if (!firstExternalOut && vout.scriptpubkey_address) firstExternalOut = vout.scriptpubkey_address;
  }
  const net = inToMe - outFromMe;
  const direction: ChainTx["direction"] = net > 0 ? "in" : net < 0 ? "out" : "self";
  const confirmed = tx.status?.confirmed ?? false;
  return {
    chain,
    hash: tx.txid,
    direction: confirmed ? direction : "pending",
    amount: (Math.abs(net) / 1e8).toFixed(8),
    fee: direction === "out" && tx.fee !== undefined ? (tx.fee / 1e8).toFixed(8) : undefined,
    timestamp: tx.status?.block_time ?? undefined,
    confirmations: confirmed ? undefined : 0,
    height: tx.status?.block_height ?? undefined,
    counterparty: direction === "out" ? firstExternalOut : undefined,
    meta: {
      netSat: net,
      source: "esplora",
      vin_count: tx.vin?.length,
      vout_count: tx.vout?.length,
      // Every address this tx touches, so a multi-address merge can pick a
      // counterparty that is not one of the wallet's own addresses.
      outputs: (tx.vout ?? []).map((v) => v.scriptpubkey_address).filter(Boolean),
    },
  };
}
