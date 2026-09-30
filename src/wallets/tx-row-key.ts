/**
 * The identity of one history row: which rows are "the same row" when lists
 * are merged, deduplicated, polled again, or rendered as React children.
 *
 * # Why it is not just the hash (operator report, 2026-09-30)
 *
 * The Activity views, `mergeChainTx` and `mergeHistoryPage` all keyed rows by
 * `tx.hash` (or `chain:hash:direction`). One hash can legitimately carry more
 * than one row, and one row can arrive under two spellings of its hash:
 *
 *  - a Zephyr conversion is an `out` row in one asset and an `in` row in
 *    another, with one txid (`zph-wallet.ts` keeps `asset_type` in `meta`);
 *    a Monero/Zephyr send to your own subaddress is an `out` row AND an `in`
 *    row with one txid. Keyed by hash, a poll merge kept one of them.
 *  - an ERC-20 transaction can move the same token to (or from) the wallet
 *    more than once; Blockscout reports each transfer with its `log_index`.
 *  - Routescan's `txlist` for the test address returned the SAME transaction
 *    twice in one page (hash 0xf451ddcb62…, confirmations 19125 and 19126,
 *    read 2026-09-30) — an exact duplicate that must collapse.
 *  - hex hashes arrive in mixed case from some sources.
 *
 * The key is `chain | hash | asset | side | logIndex`:
 *
 *  - `hash` is lower-cased only when it is hex. Base58 / base64 identifiers
 *    (Solana, NEAR, Algorand) are case-sensitive and are left alone.
 *  - `asset` separates the legs of a multi-asset transaction (Zephyr's
 *    `asset_type`, Zano's `assetId`). EVM and SPL/TRC-20 tokens are separate
 *    CHAINS in this wallet, so the chain already names the asset there.
 *  - `side` is "in" when the wallet received and "out" otherwise. It is
 *    derived rather than taken from `direction`, because `direction` changes
 *    while a transaction settles (`pending` → `out`, `out` → `failed`) and the
 *    settled row must replace the pending one, not sit beside it.
 *  - `logIndex` (an ERC-20 transfer's log) or `receiptId` (a NEAR receipt)
 *    separates two transfers inside one transaction when the source says
 *    which part of it each came from.
 *
 * Amount is deliberately NOT part of it: some adapters fill the amount in on a
 * later poll (a parse that failed first time), and that row must replace the
 * earlier one.
 */
import type { ChainTx } from "./types";

/** Hex hashes compare case-insensitively; anything else is kept verbatim. */
export function normalizeTxHash(hash: string): string {
  return /^(0x)?[0-9a-fA-F]+$/.test(hash) ? hash.toLowerCase() : hash;
}

/** The asset a row moved, when its chain carries more than one. "" otherwise. */
export function txAssetKey(tx: ChainTx): string {
  const m = tx.meta;
  const a = m?.asset_type ?? m?.assetId;
  return typeof a === "string" ? a : "";
}

/** Whether the wallet received (`in`) or sent (`out`) in this row. */
export function txSide(tx: ChainTx): "in" | "out" {
  if (tx.direction === "in") return "in";
  // A reverted incoming transaction is `failed`; the adapter records which
  // way it was meant to go so it keys like the row it was.
  if (tx.direction === "failed" && tx.meta?.intended === "in") return "in";
  return "out";
}

/** Stable identity of a history row. See the file header. */
export function txRowKey(tx: ChainTx): string {
  const part = tx.meta?.logIndex ?? tx.meta?.receiptId;
  return [
    tx.chain,
    normalizeTxHash(tx.hash),
    txAssetKey(tx),
    txSide(tx),
    typeof part === "number" || typeof part === "string" ? String(part) : "",
  ].join("|");
}

/** Drop rows whose `txRowKey` was already seen; keeps the first, in order. */
export function dedupeTxRows(rows: ChainTx[]): ChainTx[] {
  const seen = new Set<string>();
  const out: ChainTx[] = [];
  for (const r of rows) {
    const k = txRowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
