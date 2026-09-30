/**
 * A UTXO wallet's history as the ACCOUNT sees it: one row per transaction,
 * netted across every one of the account's addresses (2026-09-30).
 *
 * # The incident
 *
 * The operator's Activity screen listed one Litecoin transaction five times,
 * each as
 *
 *     ▼ recv   <the send's txid>   +4.02888049 LTC
 *
 * On chain it spent 4.32888299 LTC from the wallet's primary address, paid
 * 0.3 LTC to someone else and returned 4.02888049 as change to change/20 of the
 * same account (the 2026-08-22 change). The true row is ONE send: 0.3 LTC out,
 * a 0.0000025 LTC fee, the external address as the counterparty.
 *
 * History is fetched per ADDRESS (`ChainAdapter.getTransactionHistory`), and a
 * per-address row only knows its own address: from change/20 alone, this
 * transaction is a receipt of the change. Two things turned that into five
 * receipts, both outside this module (see the 2026-09-30 fix log):
 *
 *  - `App.tsx` built `ownedChains` with one entry per {chain, address} pair
 *    and `addressByChain[chain]` as the LAST pair's address — the highest
 *    change index — so a chain with N account addresses was listed N times;
 *  - the Activity views read ONE per-address list per entry,
 *    `txByChain[`${chain}:${addressByChain[chain]}`]`, instead of merging the
 *    chain's lists: N copies of change/20's view.
 *
 * `accountTxHistory` is the merge those views need: every address's rows for
 * one chain, one row per txid, each netted by `netAccountTx`.
 *
 * # The rules (pinned by `utxo-account-history.test.ts`)
 *
 *  - The account's net is the sum of every own address's SIGNED net — own
 *    outputs minus own inputs. Change and self-transfers therefore net to
 *    what actually left the account, never to a receipt.
 *  - When the account paid the fee (every input is its own, or — where a
 *    source does not say — the outflow covers the fee), the fee is split out:
 *    `amount` is what reached addresses that are NOT the account's, `fee` is
 *    the fee, and a transaction that paid no one else is `self`.
 *  - The counterparty is an address that is not the account's own.
 *
 * Every per-address UTXO row states its address's net in `meta.netSat`
 * (signed; it includes the fee for the address that paid it), and lists the
 * transaction's `meta.outputs` and `meta.inputs` addresses where its source
 * gives them. Rows without `netSat` (cached from before) are signed from
 * `direction` and `amount`.
 *
 * FOR UTXO CHAINS ONLY. An account-model chain's `amount` excludes the fee,
 * so splitting the fee out again would understate every send.
 */
import type { ChainTx, ChainType } from "./types";
import { decimalToAtomic } from "./decimal-amount";

/** Every UTXO chain here counts in 1e-8 of the coin. */
const DECIMALS = 8;

/**
 * "Is this one of ours" identity. Base58 is case-sensitive and compared
 * exactly; CashAddr compares without its `bitcoincash:` prefix and case-folded,
 * because explorers answer in either form.
 */
export function accountAddressKey(chain: ChainType, address: string): string {
  const a = String(address ?? "").trim();
  return chain === "bitcoin-cash" ? a.toLowerCase().replace(/^bitcoincash:/, "") : a;
}

/** One per-address row's signed net in base units, or null when it cannot be told. */
function signedNetSat(row: ChainTx): bigint | null {
  const n = row.meta?.netSat;
  if (typeof n === "number" && Number.isSafeInteger(n)) return BigInt(n);
  if (row.direction !== "in" && row.direction !== "out" && row.direction !== "self") return null;
  let units: bigint;
  try {
    units = decimalToAtomic(row.amount, DECIMALS);
  } catch {
    return null;
  }
  return row.direction === "out" ? -units : row.direction === "in" ? units : 0n;
}

function feeSatOf(rows: ReadonlyArray<ChainTx>): bigint | null {
  for (const r of rows) {
    const f = r.meta?.feeSat;
    if (typeof f === "number" && Number.isSafeInteger(f) && f >= 0) return BigInt(f);
    if (typeof r.fee === "string") {
      try {
        return decimalToAtomic(r.fee, DECIMALS);
      } catch {
        /* next row */
      }
    }
  }
  return null;
}

/**
 * The first row's list under `key` (they all describe the same transaction).
 * An empty string stands for an input or output with no address (a coinbase,
 * a bare script): it is never the account's own.
 */
function addressList(rows: ReadonlyArray<ChainTx>, key: "inputs" | "outputs"): string[] | null {
  for (const r of rows) {
    const v = r.meta?.[key];
    if (Array.isArray(v)) return v.map((a) => (typeof a === "string" ? a : ""));
  }
  return null;
}

function formatSat(v: bigint): string {
  const abs = v < 0n ? -v : v;
  const scale = 10n ** BigInt(DECIMALS);
  return `${abs / scale}.${(abs % scale).toString().padStart(DECIMALS, "0")}`;
}

/**
 * One transaction's per-address rows — one row for each of the account's
 * addresses it touches — as ONE account row. See the module header for the
 * rules. `own` holds `accountAddressKey`s.
 *
 * A row set that cannot be signed (a mempool row from a source that gives no
 * `netSat`) is returned as its first row, unchanged: netting part of a
 * transaction would state a number nobody computed.
 */
export function netAccountTx(
  rows: ReadonlyArray<ChainTx>,
  own: ReadonlySet<string>,
  chain: ChainType,
): ChainTx {
  const first = rows[0];
  const signed = rows.map(signedNetSat);
  if (signed.some((s) => s === null)) return first;
  const net = (signed as bigint[]).reduce((a, b) => a + b, 0n);
  const isOwn = (a: string) => a !== "" && own.has(accountAddressKey(chain, a));

  const fee = feeSatOf(rows);
  const inputs = addressList(rows, "inputs");
  const outputs = addressList(rows, "outputs");
  // Did the account fund this transaction alone, and so pay its fee? Said
  // outright when a source lists the inputs; otherwise inferred from an
  // outflow at least as large as the fee — true of every transaction this
  // wallet or the swap engine builds, and wrong only for a transaction that
  // other parties co-funded, which neither builds.
  const soleFunder = inputs && inputs.length > 0 ? inputs.every(isOwn) : null;
  const paidFee =
    net < 0n && fee !== null && -net >= fee && (soleFunder === true || soleFunder === null);

  let direction: ChainTx["direction"];
  let amount: bigint;
  let rowFee: bigint | null = null;
  if (paidFee) {
    // What reached addresses that are not the account's own.
    amount = -net - fee!;
    rowFee = fee;
    direction = amount > 0n ? "out" : "self";
  } else {
    amount = net < 0n ? -net : net;
    direction = net > 0n ? "in" : net < 0n ? "out" : "self";
  }

  const external = (outputs ?? []).filter((a) => a !== "" && !isOwn(a));
  let counterparty: string | undefined;
  if (direction === "out") {
    counterparty =
      external[0] ??
      rows.map((r) => r.counterparty).find((c): c is string => !!c && !isOwn(c));
  }

  // A transaction still in the mempool stays marked as such; its netted
  // direction rides in `meta.netDirection` for a view that wants the arrow.
  const pending = rows.some((r) => r.direction === "pending");
  const timestamp = rows.find((r) => r.timestamp !== undefined)?.timestamp;
  const height = rows.find((r) => r.height !== undefined)?.height;
  const confirmations = pending ? 0 : rows.find((r) => r.confirmations !== undefined)?.confirmations;

  return {
    ...first,
    direction: pending ? "pending" : direction,
    amount: formatSat(amount),
    fee: rowFee !== null ? formatSat(rowFee) : undefined,
    timestamp,
    height,
    confirmations,
    counterparty,
    meta: {
      ...first.meta,
      // The account's balance change: negative for a send, fee included.
      netSat: Number(net),
      ...(rowFee !== null ? { feeSat: Number(rowFee) } : {}),
      netDirection: direction,
      ...(external.length > 0 ? { externalOutputs: external } : {}),
      mergedAddresses: rows.length,
    },
  };
}

/**
 * Every row of one UTXO chain's history, across all of its addresses: one row
 * per txid, netted by `netAccountTx`, newest first (mempool first).
 *
 * `txByKey` is the per-address history as `useTxHistory` keeps it —
 * `"${chain}:${address}"` → rows — and every address with a key is one of the
 * account's own. A list is expected to hold one row per transaction; a second
 * row for the same txid under the same address is dropped, never added in.
 */
export function accountTxHistory(
  txByKey: Readonly<Record<string, ReadonlyArray<ChainTx> | undefined>>,
  chain: ChainType,
): ChainTx[] {
  const prefix = `${chain}:`;
  const own = new Set<string>();
  const byHash = new Map<string, Map<string, ChainTx>>();
  const order: string[] = [];
  for (const [k, list] of Object.entries(txByKey)) {
    if (!k.startsWith(prefix)) continue;
    const addr = accountAddressKey(chain, k.slice(prefix.length));
    own.add(addr);
    for (const tx of list ?? []) {
      const h = tx.hash.toLowerCase();
      let perAddress = byHash.get(h);
      if (!perAddress) {
        perAddress = new Map();
        byHash.set(h, perAddress);
        order.push(h);
      }
      if (!perAddress.has(addr)) perAddress.set(addr, tx);
    }
  }
  const rows = order.map((h) => netAccountTx([...byHash.get(h)!.values()], own, chain));
  const ts = (t: ChainTx) => (t.timestamp === undefined ? Number.POSITIVE_INFINITY : t.timestamp);
  return rows.sort((a, b) => ts(b) - ts(a));
}
