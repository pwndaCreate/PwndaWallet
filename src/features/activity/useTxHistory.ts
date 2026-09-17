/**
 * Unified, multi-chain transaction-history hook.
 *
 * For each `{chain, address}` pair it owns:
 *   - First-paint hydration from `tauri-plugin-store` (instant render of
 *     the last known list).
 *   - Initial fetch via `adapter.getTransactionHistory(address)`.
 *   - Background poll every `pollMs` (default 60s), paused while the
 *     document is hidden so backgrounded windows don't burn API budget.
 *   - Coalesced in-flight requests per chain so re-renders never
 *     double-fetch.
 *
 * Adapters are responsible for redundancy across their own data sources;
 * this hook never throws, it just records the per-chain `error` and lets
 * the next poll retry.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Store } from "@tauri-apps/plugin-store";
import { getAdapterByChain } from "../../wallets";
import type { ChainTx, ChainType } from "../../wallets";

export interface ChainAddressPair {
  chain: ChainType;
  address: string;
}

export interface UseTxHistoryResult {
  txByChain: Record<string, ChainTx[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
  /** Re-fetch one chain (or all if undefined). */
  refresh(chain?: ChainType): Promise<void>;
}

/**
 * Merge tx history across every address tracked for one chain.
 *
 * `txByChain` is keyed per `{chain}:{address}`, and a UTXO chain can have
 * more than one address worth asking — a deep account scan
 * (`resolveUtxoAccountBalance`) may find funds on a change address the
 * displayed address never touches (2026-08-23: a swap payout landed on an
 * LTC change address one past the standard gap limit; the balance sweep
 * found it, but the single-key lookup this replaces never asked that
 * address for its history, so the payout was correctly counted in the
 * total and invisible in "Recent"). Callers pass every `{chain, address}`
 * pair they know about to `useTxHistory` — App.tsx does, via the UTXO
 * account summary registry — and this collapses the resulting per-address
 * entries back into one chain-level list.
 *
 * One row per txid. When a tx touches several of the wallet's addresses the
 * row shows the WALLET's net: the signed per-address amounts are summed.
 *
 * Corrected 2026-09-17. This used to keep the first occurrence. A 1.2 LTC
 * send that spent 3.52 LTC from change/0 and returned 2.32 to change/2 read
 * "-3.52247525 LTC", the whole input, because change/0's row came first. The
 * P2P fee spend after a swap (change/2 → fee + change/3) had the same shape.
 *
 * Rows that cannot be signed (`pending`, or an address row with no direction)
 * keep the old first-occurrence behaviour for that txid; a mempool tx is
 * shown once, not netted from a partial picture.
 */
export function mergeChainTx(
  result: {
    txByChain: Record<string, ChainTx[]>;
    loading?: Record<string, boolean>;
    errors?: Record<string, string | null>;
  },
  chain: ChainType
): { txs: ChainTx[]; loading: boolean; error: string | null } {
  const prefix = `${chain}:`;
  const loadingMap = result.loading ?? {};
  const errorsMap = result.errors ?? {};
  const byHash = new Map<string, ChainTx[]>();
  const order: string[] = [];
  const ownAddresses = new Set<string>();
  for (const [k, list] of Object.entries(result.txByChain)) {
    if (!k.startsWith(prefix)) continue;
    ownAddresses.add(k.slice(prefix.length));
    for (const tx of list) {
      const rows = byHash.get(tx.hash);
      if (rows) rows.push(tx);
      else {
        byHash.set(tx.hash, [tx]);
        order.push(tx.hash);
      }
    }
  }
  const txs = order.map((h) => netAcrossAddresses(byHash.get(h)!, ownAddresses));
  txs.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

  let loading = false;
  for (const k of Object.keys(loadingMap)) {
    if (k.startsWith(prefix) && loadingMap[k]) {
      loading = true;
      break;
    }
  }

  let error: string | null = null;
  for (const k of Object.keys(errorsMap)) {
    if (k.startsWith(prefix) && errorsMap[k]) {
      error = errorsMap[k];
      break;
    }
  }

  return { txs, loading, error };
}

/** Signed amount of one address row in atomic units, or null if unsignable. */
function signedAtomic(tx: ChainTx): bigint | null {
  const netSat = tx.meta?.netSat;
  if (typeof netSat === "number" && Number.isFinite(netSat)) return BigInt(Math.trunc(netSat));
  if (tx.direction !== "in" && tx.direction !== "out" && tx.direction !== "self") return null;
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(tx.amount);
  if (!m) return null;
  const units = BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0"));
  return tx.direction === "out" ? -units : tx.direction === "in" ? units : 0n;
}

function formatAtomic(v: bigint): string {
  const abs = v < 0n ? -v : v;
  return `${abs / 100_000_000n}.${(abs % 100_000_000n).toString().padStart(8, "0")}`;
}

/**
 * One row for a txid seen under several of the wallet's addresses: the
 * wallet's net. Exported for tests. A single row is returned unchanged.
 */
export function netAcrossAddresses(rows: ChainTx[], ownAddresses: ReadonlySet<string>): ChainTx {
  const first = rows[0];
  if (rows.length === 1) return first;
  const signed = rows.map(signedAtomic);
  if (signed.some((s) => s === null)) return first;
  const net = (signed as bigint[]).reduce((a, b) => a + b, 0n);
  const direction: ChainTx["direction"] = net > 0n ? "in" : net < 0n ? "out" : "self";
  // The counterparty is the first output that is not one of our own addresses.
  let counterparty: string | undefined;
  if (direction === "out") {
    for (const r of rows) {
      const outs = r.meta?.outputs;
      const ext = Array.isArray(outs)
        ? (outs as unknown[]).find((a): a is string => typeof a === "string" && !ownAddresses.has(a))
        : undefined;
      counterparty = ext ?? (r.counterparty && !ownAddresses.has(r.counterparty) ? r.counterparty : undefined);
      if (counterparty) break;
    }
  }
  return {
    ...first,
    direction,
    amount: formatAtomic(net),
    fee: direction === "out" ? rows.find((r) => r.fee)?.fee : undefined,
    counterparty,
    meta: { ...first.meta, netSat: Number(net), mergedAddresses: rows.length },
  };
}

const STORE_FILE = "tx-cache.json";
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_LIMIT = 50;

function key(chain: ChainType, address: string) {
  return `${chain}:${address}`;
}

let _store: Store | null = null;
async function getStore(): Promise<Store> {
  if (_store) return _store;
  _store = await Store.load(STORE_FILE);
  return _store;
}

interface CacheEntry {
  items: ChainTx[];
  cursor?: string;
  fetchedAt: number;
}

export function useTxHistory(
  pairs: ChainAddressPair[],
  opts: { pollMs?: number; limit?: number } = {}
): UseTxHistoryResult {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const [txByChain, setTxByChain] = useState<Record<string, ChainTx[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  // Stable signature so effects only re-fire when the *set* of chains changes.
  const sig = useMemo(
    () => pairs.map((p) => key(p.chain, p.address)).sort().join("|"),
    [pairs]
  );

  // Per-key in-flight gate — coalesces concurrent fetches.
  const inFlight = useRef<Map<string, Promise<void>>>(new Map());

  const fetchOne = useCallback(
    async (chain: ChainType, address: string): Promise<void> => {
      const k = key(chain, address);
      const existing = inFlight.current.get(k);
      if (existing) return existing;

      const promise = (async () => {
        setLoading((l) => ({ ...l, [k]: true }));
        try {
          const adapter = getAdapterByChain(chain);
          const page = await adapter.getTransactionHistory(address, { limit });
          setTxByChain((m) => ({ ...m, [k]: page.items }));
          setErrors((e) => ({ ...e, [k]: null }));
          // Persist to cache (fire-and-forget; failure here is non-fatal).
          try {
            const store = await getStore();
            const entry: CacheEntry = {
              items: page.items,
              cursor: page.cursor,
              fetchedAt: Date.now(),
            };
            await store.set(k, entry);
            await store.save();
          } catch {
            /* cache write failure is non-fatal */
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setErrors((er) => ({ ...er, [k]: msg }));
        } finally {
          setLoading((l) => ({ ...l, [k]: false }));
          inFlight.current.delete(k);
        }
      })();

      inFlight.current.set(k, promise);
      return promise;
    },
    [limit]
  );

  // Hydrate cache once per pair set.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await getStore();
        const next: Record<string, ChainTx[]> = {};
        for (const p of pairs) {
          const k = key(p.chain, p.address);
          const cached = await store.get<CacheEntry>(k);
          if (cached?.items) next[k] = cached.items;
        }
        if (!cancelled && Object.keys(next).length > 0) {
          setTxByChain((m) => ({ ...next, ...m }));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial fetch + polling for each chain.
  useEffect(() => {
    if (pairs.length === 0) return;
    let cancelled = false;

    // Fire one fetch per chain immediately.
    for (const p of pairs) void fetchOne(p.chain, p.address);

    const tick = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      for (const p of pairs) void fetchOne(p.chain, p.address);
    };
    const id = window.setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sig, pollMs, fetchOne]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(
    async (chain?: ChainType) => {
      const targets = chain ? pairs.filter((p) => p.chain === chain) : pairs;
      await Promise.all(targets.map((p) => fetchOne(p.chain, p.address)));
    },
    [pairs, fetchOne]
  );

  return { txByChain, loading, errors, refresh };
}
