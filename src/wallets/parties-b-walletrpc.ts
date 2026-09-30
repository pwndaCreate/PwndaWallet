/**
 * Who sent and who received one of this wallet's Monero or Zephyr
 * transactions, read from the local wallet-rpc by txid (2026-09-30). See
 * `TxParties` in `types.ts`.
 *
 * Both sidecars are monero-wallet-rpc (Zephyr's is a fork of it), reached
 * through their existing Tauri passthroughs (`xmr_rpc_call`, `zph_rpc_call`),
 * which forward any wallet-rpc method. `get_transfer_by_txid` is the method
 * the send path already settles relays with (`xmr-rpc.ts::lookupOwnTransfer`,
 * `zph-rpc.ts::lookupOwnZphTransfer`), so no new command is involved.
 */
import { invoke } from "../lib/tauri";
import { errorText } from "../lib/errorText";
import { isTxNotFound } from "./xmr-rpc";
import { uniqueAddresses } from "./parties-b-common";
import type { TxParties } from "./types";

/**
 * One `get_transfer_by_txid` answer as parties, or `null` when it lists no
 * transfer. Exported for tests.
 *
 * The wallet-rpc knows only this wallet's side (`fill_transfer_entry` in
 * monero's wallet_rpc_server.cpp):
 *  - an outgoing entry (`out`, `pending`, `failed`) names the account's own
 *    address (subaddress index 0 of the account) in `address`, and the
 *    recipients in `destinations` — but only when this wallet built the
 *    transaction and stored them. A wallet restored from its seed has none,
 *    and then `to` is empty rather than guessed;
 *  - an incoming entry (`in`, `pool`) names the receiving subaddress in
 *    `address`. The sender is hidden by the protocol: `senderHidden`.
 *
 * `transfers` lists every entry for the txid; `transfer` is its first entry,
 * kept for older callers, so it is read only when `transfers` is absent.
 */
export function walletRpcTransferParties(result: unknown, source?: string): TxParties | null {
  const r = (result ?? {}) as { transfer?: unknown; transfers?: unknown };
  const entries = (
    Array.isArray(r.transfers) ? r.transfers : r.transfer ? [r.transfer] : []
  ) as Array<Record<string, any>>;
  const outgoing = entries.filter((t) => t?.type === "out" || t?.type === "pending" || t?.type === "failed");
  const incoming = entries.filter((t) => t?.type === "in" || t?.type === "pool");
  const src = source ? { source } : {};
  if (outgoing.length > 0) {
    return {
      from: uniqueAddresses(outgoing.map((t) => t.address)),
      to: uniqueAddresses(
        outgoing.flatMap((t) => (Array.isArray(t.destinations) ? t.destinations : []).map((d: any) => d?.address)),
      ),
      ...src,
    };
  }
  if (incoming.length > 0) {
    return { from: [], to: uniqueAddresses(incoming.map((t) => t.address)), senderHidden: true, ...src };
  }
  return null;
}

/**
 * Ask a Monero-lineage wallet-rpc for one of its own transactions. `null` for
 * `-8 Transaction not found.` (the wallet does not know the txid: not its
 * own, or not scanned yet); any other failure throws with the sidecar named.
 */
export async function readWalletRpcTransferParties(args: {
  command: "xmr_rpc_call" | "zph_rpc_call";
  /** For messages and `source`, e.g. "monero-wallet-rpc". */
  sidecar: string;
  txid: string;
}): Promise<TxParties | null> {
  let result: unknown;
  try {
    result = await invoke(args.command, {
      method: "get_transfer_by_txid",
      params: { txid: args.txid, account_index: 0 },
    });
  } catch (e) {
    if (isTxNotFound(e)) return null;
    throw new Error(`${args.sidecar} (local) could not read transaction ${args.txid}: ${errorText(e)}`);
  }
  return walletRpcTransferParties(result, `${args.sidecar} (local)`);
}
