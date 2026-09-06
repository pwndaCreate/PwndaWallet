/**
 * Shared address-probe parsers for the UTXO chains (2026-08-22).
 *
 * The account walk in `utxo-account.ts` needs TWO facts per address —
 * `balanceSat` and `used` — where the adapters previously fetched only the
 * first. `used` means "has any on-chain history", including an address that
 * was funded and later emptied; the gap walk keys on it, because an emptied
 * address reads `0` and treating that as "never used" would let the unused run
 * swallow the exact region where the wallet has been active.
 *
 * Every parser here throws rather than returning a zero when the source did
 * not actually answer for the address. That is the same doctrine as
 * `ChainAdapter.getBalance` and it exists because of a specific recurring bug:
 * `(r.balance || 0)` turns a rate-limit body, a malformed payload, or a
 * "no such key" into a confident claim of emptiness, and `tryEach` then stops
 * on that "success" without ever consulting the healthy fallbacks.
 */
import { proxyGetJson } from "./_proxy";

export interface UtxoProbeResult {
  balanceSat: number;
  used: boolean;
}

interface EsploraStats {
  funded_txo_sum?: number;
  spent_txo_sum?: number;
  tx_count?: number;
}

/**
 * Esplora/Blockstream-compatible `/address/{addr}` (also mempool.space,
 * litecoinspace). Confirmed and mempool sums are both counted.
 */
export function parseEsploraStats(r: {
  chain_stats?: EsploraStats;
  mempool_stats?: EsploraStats;
}): UtxoProbeResult {
  const c = r.chain_stats;
  if (!c || typeof c.funded_txo_sum !== "number") {
    throw new Error("esplora: no chain_stats in response");
  }
  const m = r.mempool_stats;
  return {
    balanceSat:
      (c.funded_txo_sum ?? 0) -
      (c.spent_txo_sum ?? 0) +
      ((m?.funded_txo_sum ?? 0) - (m?.spent_txo_sum ?? 0)),
    used: (c.tx_count ?? 0) > 0 || (m?.tx_count ?? 0) > 0,
  };
}

/**
 * Blockchair `dashboards/address/{addr}`. Works uniformly across every chain
 * this app cares about (bitcoin, litecoin, dogecoin, dash, bitcoin-cash),
 * which makes it the common fallback in all five adapters.
 *
 * `keyOverride` exists for BCH, where the response is keyed by the address
 * form Blockchair chose rather than the one we asked with.
 */
export async function blockchairProbe(
  base: string,
  address: string,
  keyOverride?: string,
): Promise<UtxoProbeResult> {
  const r = await proxyGetJson<{
    data?: Record<
      string,
      { address?: { balance?: number | null; transaction_count?: number | null } }
    >;
  }>(`${base}/dashboards/address/${address}?limit=1`);
  const data = r.data ?? {};
  const a = (data[keyOverride ?? address] ?? data[address])?.address;
  if (!a || typeof a.balance !== "number") {
    // A missing key is "Blockchair did not answer for this address", not
    // "zero" — rotate rather than assert emptiness.
    throw new Error("blockchair: address missing from response");
  }
  return { balanceSat: a.balance, used: (a.transaction_count ?? 0) > 0 };
}

/** BlockCypher `addrs/{addr}/balance`. */
export async function blockcypherProbe(
  base: string,
  address: string,
): Promise<UtxoProbeResult> {
  const r = await proxyGetJson<{
    balance?: number;
    unconfirmed_balance?: number;
    n_tx?: number;
    final_n_tx?: number;
  }>(`${base}/addrs/${address}/balance`);
  if (typeof r.balance !== "number") {
    throw new Error("blockcypher: no balance field in response");
  }
  return {
    balanceSat: r.balance + (r.unconfirmed_balance ?? 0),
    used: (r.final_n_tx ?? r.n_tx ?? 0) > 0,
  };
}

// =========================================================================
// haskoin-store — the BTC/BCH indexer with a BATCH balance endpoint
// =========================================================================
//
// Every source above answers for ONE address per request. A gap walk asks
// about ~90 addresses per refresh on each UTXO chain, so per-address sources
// are exactly the shape that rate-limits: on 2026-09-04 the BCH walk cost 98
// bitcore requests and 13.7 s, and before the requests were serialized it did
// not complete at all (HTTP 429 after ~10), which left a funded BCH account
// reading 0. Electrum-family wallets never have this problem because the
// Electrum protocol batches scripthash lookups over one connection; haskoin
// is the closest REST equivalent — `/address/balances?addresses=a,b,c`
// answers for up to (at least) 100 addresses in one request. Measured live
// 2026-09-04 on both public deployments:
//
//   api.blockchain.info/haskoin-store/bch  n=100 -> 100 rows, 184 ms
//   api.haskoin.com/bch                    n=100 -> 100 rows, 154 ms
//   api.blockchain.info/haskoin-store/btc  n=100 -> 100 rows, 253 ms
//
// The row carries `txs` (history count) beside the balance, so `used` is
// settled without a second request — the two facts the walk needs, from one
// call, for a whole block of addresses.

/** One row of `/address/balances` (and the body of `/address/{a}/balance`). */
export interface HaskoinBalanceRow {
  address?: string;
  confirmed?: number;
  unconfirmed?: number;
  utxo?: number;
  txs?: number;
  received?: number;
}

/** Case-insensitive, scheme-insensitive address identity: haskoin echoes BCH
 *  addresses WITH the `bitcoincash:` prefix whichever form it was asked with. */
function haskoinAddrKey(a: string): string {
  return a.trim().toLowerCase().replace(/^bitcoincash:/, "");
}

/**
 * Parse one haskoin balance row. Throws unless BOTH facts are present — a row
 * without `txs` cannot say whether the address is used, and guessing `false`
 * is how a gap walk truncates itself over live funds (2026-08-22, LTC).
 */
export function parseHaskoinBalance(row: HaskoinBalanceRow | null | undefined): UtxoProbeResult {
  if (!row || typeof row.confirmed !== "number" || typeof row.txs !== "number") {
    throw new Error("haskoin: balance row missing confirmed/txs");
  }
  const balanceSat = row.confirmed + (row.unconfirmed ?? 0);
  if (!Number.isFinite(balanceSat)) throw new Error("haskoin: non-numeric balance");
  return {
    balanceSat,
    // `received > 0` is a second witness for history in case a deployment
    // ever reports `txs: 0` for a mempool-only address.
    used: row.txs > 0 || (row.received ?? 0) > 0 || balanceSat > 0,
  };
}

/** haskoin `/address/{addr}/balance` — the single-address form. */
export async function haskoinProbe(base: string, address: string): Promise<UtxoProbeResult> {
  const row = await proxyGetJson<HaskoinBalanceRow>(`${base}/address/${address}/balance`);
  return parseHaskoinBalance(row);
}

/**
 * haskoin `/address/balances?addresses=…` — one request, many addresses.
 *
 * Returns results in REQUEST order, one per address, matched by address (not
 * by position — a deployment that reorders or drops rows must not shift a
 * balance onto the wrong index). Any address missing from the reply makes the
 * whole call throw: "the source did not answer for this address" is a rotate,
 * never a zero.
 */
export async function haskoinProbeMany(
  base: string,
  addresses: readonly string[],
): Promise<UtxoProbeResult[]> {
  if (addresses.length === 0) return [];
  const rows = await proxyGetJson<HaskoinBalanceRow[]>(
    `${base}/address/balances?addresses=${addresses.join(",")}`,
  );
  if (!Array.isArray(rows)) throw new Error("haskoin: balances response is not an array");
  const byAddr = new Map<string, HaskoinBalanceRow>();
  for (const r of rows) {
    if (r && typeof r.address === "string") byAddr.set(haskoinAddrKey(r.address), r);
  }
  const out: UtxoProbeResult[] = [];
  const missing: string[] = [];
  for (const a of addresses) {
    const row = byAddr.get(haskoinAddrKey(a));
    if (!row) {
      missing.push(a);
      continue;
    }
    out.push(parseHaskoinBalance(row));
  }
  if (missing.length > 0) {
    throw new Error(
      `haskoin: ${missing.length} of ${addresses.length} addresses missing from response`,
    );
  }
  return out;
}
