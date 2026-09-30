/**
 * TRON history (TRX and TRC-20): which source to ask, and how to read it.
 *
 * # Why this exists (operator report, 2026-09-30)
 *
 * TRX was in the landscape Activity header's error list. Its history asked
 * TronGrid's indexed `/v1/accounts/<a>/transactions`, then TronStack for the
 * same path. TronGrid allows a keyless client ~3 requests a second and 429s
 * past that (`trx-wallet.ts`, TRONGRID_RATE); TronStack serves only the
 * full-node `/wallet/*` API and answers 404 to every `/v1/*` path (re-read
 * 2026-09-30 for this address: `404 Not Found`, nginx). So one TronGrid 429
 * became the pair's error, reported as TronStack's 404 — the real cause was
 * hidden and the fallback could never answer. The TRC-20 reader had the same
 * shape through `tronFetch`.
 *
 * The full-node API has no "transactions of an account" call, so TronStack
 * cannot be a history fallback at all. TronScan's public API can:
 * `apilist.tronscanapi.com` is keyless, already on the backend proxy's
 * allowlist (`tronscanapi.com`), and answered both lists for the test
 * address on 2026-09-30 (`/api/transfer/trx`, `/api/token_trc20/transfers`).
 *
 * Rows now carry what the details view needs: the fee this wallet paid (sent
 * rows only; TronGrid's `ret[0].fee`), block height, both parties in
 * `meta.from` / `meta.to`, and a failed contract result as `failed`. TRC-20
 * approvals are no longer listed as transfers.
 */
import type { ChainTx, ChainType, TxHistoryPage } from "./types";
import { atomicToDecimal } from "./decimal-amount";
import { condenseHttpError } from "./tx-history-errors";
import { dedupeTxRows } from "./tx-row-key";

/** GET a path on one TRON history source and parse JSON (throws on non-2xx). */
export type TronGetJson = (path: string) => Promise<unknown>;

export interface TronHistorySources {
  /** TronGrid (`https://api.trongrid.io` + path), spaced to its keyless limit. */
  tronGrid: TronGetJson;
  /** TronScan's API (`https://apilist.tronscanapi.com` + path). */
  tronScan: TronGetJson;
}

export const TRONGRID_HOST = "api.trongrid.io";
export const TRONSCAN_HOST = "apilist.tronscanapi.com";

type Intended = "in" | "out" | "self";

function intendedOf(from: string, to: string, me: string): Intended {
  return from === me && to === me ? "self" : from === me ? "out" : "in";
}

function sunOf(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

/** Sun → TRX with six fixed decimals, as `getBalance` prints it. */
export function sunToTrx(sun: bigint): string {
  return `${sun / 1_000_000n}.${(sun % 1_000_000n).toString().padStart(6, "0")}`;
}

function msToSeconds(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1000) : undefined;
}

function heightOf(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

interface Cursor {
  s: "tg" | "ts";
  p: string | number;
}

function parseCursor(c: string | undefined): Cursor | null {
  if (!c) return null;
  try {
    const v = JSON.parse(c);
    if (v && (v.s === "tg" || v.s === "ts")) return v as Cursor;
  } catch {
    /* a pre-2026-09-30 cursor was a bare TronGrid fingerprint */
  }
  return { s: "tg", p: c };
}

async function trySources(
  label: string,
  attempts: { host: string; run: () => Promise<TxHistoryPage> }[],
): Promise<TxHistoryPage> {
  const failures: string[] = [];
  for (const a of attempts) {
    try {
      const page = await a.run();
      return { ...page, items: dedupeTxRows(page.items) };
    } catch (e) {
      failures.push(`${a.host}: ${condenseHttpError(e)}`);
    }
  }
  throw new Error(`every ${label} history source failed — ${failures.join("; ")}`);
}

// ── TRX ─────────────────────────────────────────────────────────────────────

/**
 * A TronGrid `/v1/accounts/<a>/transactions` item as a `ChainTx`, or null when
 * it is not a TRX transfer. `toBase58` turns TronGrid's hex addresses into
 * `T…` addresses. Exported for tests.
 */
export function trongridTrxRow(
  raw: unknown,
  me: string,
  toBase58: (hex: string) => string,
): ChainTx | null {
  if (!raw || typeof raw !== "object") return null;
  const tx = raw as Record<string, any>;
  const c = tx.raw_data?.contract?.[0];
  if (c?.type !== "TransferContract") return null;
  const v = c.parameter?.value;
  if (!v || typeof tx.txID !== "string") return null;
  const from = toBase58(String(v.owner_address ?? ""));
  const to = toBase58(String(v.to_address ?? ""));
  const sun = sunOf(v.amount);
  if (sun === null) return null;
  const intended = intendedOf(from, to, me);
  const ret = tx.ret?.[0];
  const ok = !ret?.contractRet || ret.contractRet === "SUCCESS";
  const feeSun = sunOf(ret?.fee) ?? (sunOf(tx.net_fee) ?? 0n) + (sunOf(tx.energy_fee) ?? 0n);
  return {
    chain: "tron",
    hash: tx.txID,
    direction: ok ? intended : "failed",
    amount: sunToTrx(sun),
    fee: intended !== "in" ? sunToTrx(feeSun) : undefined,
    timestamp: msToSeconds(tx.block_timestamp),
    // Read with `only_confirmed=true`: every row is final. The count is
    // not given, so it stays undefined ("no count"), with the height set.
    height: heightOf(tx.blockNumber),
    counterparty: intended === "in" ? from : to,
    meta: {
      from,
      to,
      intended,
      contractType: c.type,
      ...(ok ? {} : { failure: String(ret?.contractRet) }),
      source: TRONGRID_HOST,
    },
  };
}

/** A TronScan `/api/transfer/trx` item as a `ChainTx`. Exported for tests. */
export function tronscanTrxRow(raw: unknown, me: string): ChainTx | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  if (typeof r.hash !== "string" || typeof r.from !== "string" || typeof r.to !== "string") return null;
  const sun = sunOf(r.amount);
  if (sun === null) return null;
  const intended = intendedOf(r.from, r.to, me);
  const ok = (r.contract_ret ?? "SUCCESS") === "SUCCESS" && !r.revert;
  return {
    chain: "tron",
    hash: r.hash,
    direction: ok ? intended : "failed",
    amount: sunToTrx(sun),
    // TronScan's transfer list carries no fee.
    timestamp: msToSeconds(r.block_timestamp),
    confirmations: r.confirmed === 0 || r.confirmed === false ? 0 : undefined,
    height: heightOf(r.block),
    counterparty: intended === "in" ? r.from : r.to,
    meta: {
      from: r.from,
      to: r.to,
      intended,
      ...(ok ? {} : { failure: String(r.contract_ret ?? "reverted") }),
      source: TRONSCAN_HOST,
    },
  };
}

export async function fetchTrxHistory(
  address: string,
  opts: { limit?: number; cursor?: string } | undefined,
  src: TronHistorySources,
  toBase58: (hex: string) => string,
): Promise<TxHistoryPage> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 25, 200));
  const cursor = parseCursor(opts?.cursor);
  const tronGrid = {
    host: TRONGRID_HOST,
    run: async (): Promise<TxHistoryPage> => {
      const fp = cursor?.s === "tg" ? `&fingerprint=${encodeURIComponent(String(cursor.p))}` : "";
      const data = (await src.tronGrid(
        `/v1/accounts/${address}/transactions?limit=${limit}&only_confirmed=true${fp}`,
      )) as { data?: unknown; meta?: { fingerprint?: unknown } } | null;
      if (!Array.isArray(data?.data)) throw new Error("unexpected response");
      const items = data!.data
        .map((t) => trongridTrxRow(t, address, toBase58))
        .filter((x): x is ChainTx => x !== null);
      const next = typeof data!.meta?.fingerprint === "string" ? data!.meta.fingerprint : undefined;
      return { items, cursor: next ? JSON.stringify({ s: "tg", p: next }) : undefined };
    },
  };
  const tronScan = {
    host: TRONSCAN_HOST,
    run: async (): Promise<TxHistoryPage> => {
      const start = cursor?.s === "ts" ? Number(cursor.p) || 0 : 0;
      const data = (await src.tronScan(
        `/api/transfer/trx?address=${address}&start=${start}&limit=${limit}&direction=0&reverse=true&db_version=1`,
      )) as { data?: unknown } | null;
      if (!Array.isArray(data?.data)) throw new Error("unexpected response");
      const items = data!.data
        .map((t) => tronscanTrxRow(t, address))
        .filter((x): x is ChainTx => x !== null);
      const cursorOut = data!.data.length >= limit ? JSON.stringify({ s: "ts", p: start + limit }) : undefined;
      return { items, cursor: cursorOut };
    },
  };
  // A continuation belongs to the source that issued it.
  const attempts = cursor?.s === "ts" ? [tronScan] : cursor ? [tronGrid] : [tronGrid, tronScan];
  return trySources("TRX", attempts);
}

// ── TRC-20 ──────────────────────────────────────────────────────────────────

export interface Trc20HistoryConfig {
  chain: ChainType;
  ticker: string;
  contract: string;
  decimals: number;
}

/** A TronGrid `/transactions/trc20` item as a `ChainTx`. Exported for tests. */
export function trongridTrc20Row(raw: unknown, me: string, cfg: Trc20HistoryConfig): ChainTx | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  // Approvals come back on the same list; they move nothing.
  if (r.type !== undefined && r.type !== "Transfer") return null;
  if (r.token_info?.address && r.token_info.address !== cfg.contract) return null;
  const hash = typeof r.transaction_id === "string" ? r.transaction_id : "";
  if (!hash) return null;
  const units = sunOf(r.value);
  if (units === null) return null;
  const from = String(r.from ?? "");
  const to = String(r.to ?? "");
  const intended = intendedOf(from, to, me);
  return {
    chain: cfg.chain,
    hash,
    direction: intended,
    amount: atomicToDecimal(units, cfg.decimals),
    timestamp: msToSeconds(r.block_timestamp),
    // TronGrid's TRC-20 list gives neither a block height nor a fee.
    counterparty: intended === "in" ? from : to,
    meta: { from, to, intended, contractAddress: cfg.contract, source: TRONGRID_HOST },
  };
}

/** A TronScan `/api/token_trc20/transfers` item as a `ChainTx`. Exported for tests. */
export function tronscanTrc20Row(raw: unknown, me: string, cfg: Trc20HistoryConfig): ChainTx | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  if (r.event_type !== undefined && r.event_type !== "Transfer") return null;
  if (r.contract_address && r.contract_address !== cfg.contract) return null;
  const hash = typeof r.transaction_id === "string" ? r.transaction_id : "";
  if (!hash) return null;
  const units = sunOf(r.quant);
  if (units === null) return null;
  const from = String(r.from_address ?? "");
  const to = String(r.to_address ?? "");
  const intended = intendedOf(from, to, me);
  const ok = (r.finalResult ?? r.contractRet ?? "SUCCESS") === "SUCCESS" && !r.revert;
  return {
    chain: cfg.chain,
    hash,
    direction: ok ? intended : "failed",
    amount: atomicToDecimal(units, cfg.decimals),
    timestamp: msToSeconds(r.block_ts),
    confirmations: r.confirmed === false || r.confirmed === 0 ? 0 : undefined,
    height: heightOf(r.block),
    counterparty: intended === "in" ? from : to,
    meta: {
      from,
      to,
      intended,
      contractAddress: cfg.contract,
      ...(ok ? {} : { failure: String(r.finalResult ?? r.contractRet ?? "reverted") }),
      source: TRONSCAN_HOST,
    },
  };
}

export async function fetchTrc20History(
  cfg: Trc20HistoryConfig,
  address: string,
  opts: { limit?: number; cursor?: string } | undefined,
  src: TronHistorySources,
): Promise<TxHistoryPage> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 25, 200));
  const cursor = parseCursor(opts?.cursor);
  const tronGrid = {
    host: TRONGRID_HOST,
    run: async (): Promise<TxHistoryPage> => {
      const fp = cursor?.s === "tg" ? `&fingerprint=${encodeURIComponent(String(cursor.p))}` : "";
      const data = (await src.tronGrid(
        `/v1/accounts/${address}/transactions/trc20?limit=${limit}&only_confirmed=true&contract_address=${cfg.contract}${fp}`,
      )) as { data?: unknown; meta?: { fingerprint?: unknown } } | null;
      // Until 2026-09-29 a failure here became an empty list. Still thrown.
      if (!Array.isArray(data?.data)) throw new Error(`${cfg.ticker} history: unexpected response`);
      const items = data!.data
        .map((t) => trongridTrc20Row(t, address, cfg))
        .filter((x): x is ChainTx => x !== null);
      const next = typeof data!.meta?.fingerprint === "string" ? data!.meta.fingerprint : undefined;
      return { items, cursor: next ? JSON.stringify({ s: "tg", p: next }) : undefined };
    },
  };
  const tronScan = {
    host: TRONSCAN_HOST,
    run: async (): Promise<TxHistoryPage> => {
      const start = cursor?.s === "ts" ? Number(cursor.p) || 0 : 0;
      const data = (await src.tronScan(
        `/api/token_trc20/transfers?relatedAddress=${address}&contract_address=${cfg.contract}` +
          `&start=${start}&limit=${limit}&sort=-timestamp&count=true`,
      )) as { token_transfers?: unknown } | null;
      if (!Array.isArray(data?.token_transfers)) throw new Error(`${cfg.ticker} history: unexpected response`);
      const items = data!.token_transfers
        .map((t) => tronscanTrc20Row(t, address, cfg))
        .filter((x): x is ChainTx => x !== null);
      const cursorOut =
        data!.token_transfers.length >= limit ? JSON.stringify({ s: "ts", p: start + limit }) : undefined;
      return { items, cursor: cursorOut };
    },
  };
  const attempts = cursor?.s === "ts" ? [tronScan] : cursor ? [tronGrid] : [tronGrid, tronScan];
  return trySources(cfg.ticker, attempts);
}
