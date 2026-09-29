/**
 * Unified, multi-chain transaction-history hook.
 *
 * For each `{chain, address}` pair it owns:
 *   - First-paint hydration from `tauri-plugin-store` (instant render of
 *     the last known list).
 *   - Initial fetch via `adapter.getTransactionHistory(address)`.
 *   - Background poll every `pollMs` (default 60s) while a history view is
 *     on screen, every `backgroundPollMs` (default 15 min) otherwise, paused
 *     while the document is hidden; failing pairs back off; routine polls
 *     fetch a small page and merge it (RAM plan 3.6, 2026-09-25).
 *   - Results are applied in one commit per burst and not at all when
 *     unchanged (RAM plan 3.7).
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
import {
  isDue,
  mergeHistoryPage,
  pollIntervalMs,
  pollPageOverlaps,
  sameError,
  sameHistory,
} from "./txHistorySchedule";

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
/** Cadence while no history-showing view is on screen (RAM plan 3.6). */
const DEFAULT_BACKGROUND_POLL_MS = 15 * 60_000;
const DEFAULT_LIMIT = 50;
/** Steady-state page size once a full page is held (RAM plan 3.6). */
const DEFAULT_POLL_LIMIT = 10;
/** How often due pairs are checked. Cheap: a loop over timestamps. */
const SCHEDULER_MS = 5_000;
/** Results arriving within this window share one commit (RAM plan 3.7)... */
const FLUSH_DEBOUNCE_MS = 1_000;
/** ...but no result waits longer than this to reach the screen. */
const FLUSH_MAX_WAIT_MS = 5_000;

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

export interface UseTxHistoryOpts {
  /** Poll cadence while `active` (default 60 s). */
  pollMs?: number;
  /** Poll cadence while not `active` (default 15 min). */
  backgroundPollMs?: number;
  /** A view that shows history is on screen (default true). */
  active?: boolean;
  /** Full page size - first fetch per pair, and every explicit refresh (default 50). */
  limit?: number;
  /** Page size for routine polls once a full page is held (default 10). */
  pollLimit?: number;
}

interface PairState {
  lastAttemptAt: number;
  failures: number;
  /** A full `limit` page has been fetched this session. */
  fullDone: boolean;
}

/**
 * RAM plan 3.6 / 3.7 (2026-09-25). Two changes to how this hook runs, both from
 * the renderer-memory trace ([[ram-optimization-execution-plan]] § "cause
 * trace"), which measured this hook re-fetching ~99 pairs x 50 transactions
 * every 60 s on every view (~660 requests/min idle) and landing each result as
 * its own `App`-root update - the commit stream React's dev build leaked on:
 *
 *  - WHEN: pairs are polled at `pollMs` only while `active` (a history view is
 *    on screen), at `backgroundPollMs` otherwise; a failing pair backs off
 *    (`pollIntervalMs`); after one full page a pair is polled with a small page
 *    that is merged in (`mergeHistoryPage`), with a full re-fetch when the small
 *    page does not connect (`pollPageOverlaps`).
 *  - HOW MUCH: results are held and applied together - one commit per burst,
 *    none for an unchanged result (`sameHistory`, `sameError`) - and the cache
 *    file is written once per burst, for the pairs that changed. Background
 *    polls no longer flip `loading`; only a first load or an explicit
 *    `refresh()` does.
 */
export function useTxHistory(
  pairs: ChainAddressPair[],
  opts: UseTxHistoryOpts = {}
): UseTxHistoryResult {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const backgroundPollMs = opts.backgroundPollMs ?? DEFAULT_BACKGROUND_POLL_MS;
  const active = opts.active ?? true;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const pollLimit = Math.min(opts.pollLimit ?? DEFAULT_POLL_LIMIT, limit);

  const [txByChain, setTxByChain] = useState<Record<string, ChainTx[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  // Mirrors of what has been committed, so the fetch path can merge and
  // compare without depending on (and re-running for) every state change.
  const heldTx = useRef<Record<string, ChainTx[]>>({});
  const heldErr = useRef<Record<string, string | null>>({});
  const pairState = useRef<Map<string, PairState>>(new Map());

  // Results waiting for the next flush.
  const pendingTx = useRef<Record<string, ChainTx[]>>({});
  const pendingErr = useRef<Record<string, string | null>>({});
  const pendingLoadingOff = useRef<Set<string>>(new Set());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPendingAt = useRef<number>(0);

  // Stable signature so effects only re-fire when the *set* of chains changes.
  const sig = useMemo(
    () => pairs.map((p) => key(p.chain, p.address)).sort().join("|"),
    [pairs]
  );

  // Per-key in-flight gate — coalesces concurrent fetches.
  const inFlight = useRef<Map<string, Promise<void>>>(new Map());

  const flushNow = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    firstPendingAt.current = 0;
    const tx = pendingTx.current;
    const err = pendingErr.current;
    const off = pendingLoadingOff.current;
    pendingTx.current = {};
    pendingErr.current = {};
    pendingLoadingOff.current = new Set();
    const txKeys = Object.keys(tx);
    const errKeys = Object.keys(err);
    // All three setters run in one synchronous block, so React commits once.
    if (txKeys.length) {
      heldTx.current = { ...heldTx.current, ...tx };
      setTxByChain((m) => ({ ...m, ...tx }));
    }
    if (errKeys.length) {
      heldErr.current = { ...heldErr.current, ...err };
      setErrors((e) => ({ ...e, ...err }));
    }
    if (off.size) {
      setLoading((l) => {
        const next = { ...l };
        for (const k of off) next[k] = false;
        return next;
      });
    }
    // One cache write per flush, only for the pairs whose history changed.
    if (txKeys.length) {
      void (async () => {
        try {
          const store = await getStore();
          const now = Date.now();
          for (const k of txKeys) {
            const entry: CacheEntry = { items: tx[k], fetchedAt: now };
            await store.set(k, entry);
          }
          await store.save();
        } catch {
          /* cache write failure is non-fatal */
        }
      })();
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    const now = Date.now();
    if (!firstPendingAt.current) firstPendingAt.current = now;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    const wait = Math.max(0, Math.min(FLUSH_DEBOUNCE_MS, firstPendingAt.current + FLUSH_MAX_WAIT_MS - now));
    flushTimer.current = setTimeout(flushNow, wait);
  }, [flushNow]);

  const fetchOne = useCallback(
    async (chain: ChainType, address: string, userInitiated = false): Promise<void> => {
      const k = key(chain, address);
      const existing = inFlight.current.get(k);
      if (existing) return existing;

      const st = pairState.current.get(k) ?? { lastAttemptAt: 0, failures: 0, fullDone: false };
      pairState.current.set(k, st);
      st.lastAttemptAt = Date.now();
      const prev = pendingTx.current[k] ?? heldTx.current[k];
      // Only a first load or a user-asked refresh shows a spinner.
      const showLoading = userInitiated || !prev;

      const promise = (async () => {
        if (showLoading) setLoading((l) => ({ ...l, [k]: true }));
        try {
          const adapter = getAdapterByChain(chain);
          const full = userInitiated || !st.fullDone;
          let items: ChainTx[];
          if (full) {
            items = (await adapter.getTransactionHistory(address, { limit })).items;
          } else {
            const page = await adapter.getTransactionHistory(address, { limit: pollLimit });
            items = pollPageOverlaps(prev, page.items, pollLimit)
              ? mergeHistoryPage(prev, page.items, limit)
              : (await adapter.getTransactionHistory(address, { limit })).items;
          }
          st.fullDone = true;
          st.failures = 0;
          if (!sameHistory(prev, items)) pendingTx.current[k] = items;
          if (heldErr.current[k] != null || pendingErr.current[k] != null) pendingErr.current[k] = null;
        } catch (e) {
          st.failures += 1;
          const msg = e instanceof Error ? e.message : String(e);
          if (!sameError(pendingErr.current[k] ?? heldErr.current[k], msg)) pendingErr.current[k] = msg;
        } finally {
          if (showLoading) pendingLoadingOff.current.add(k);
          inFlight.current.delete(k);
          scheduleFlush();
        }
      })();

      inFlight.current.set(k, promise);
      return promise;
    },
    [limit, pollLimit, scheduleFlush]
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
          heldTx.current = { ...next, ...heldTx.current };
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

  // Scheduler: every pair is fetched once at start (full page), then whenever
  // it is due at the current cadence. Re-created when the pair set or the
  // cadence inputs change; `active` turning on runs a check immediately, so a
  // stale pair refreshes the moment a history view opens.
  useEffect(() => {
    if (pairs.length === 0) return;
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const now = Date.now();
      for (const p of pairs) {
        const st = pairState.current.get(key(p.chain, p.address));
        const interval = pollIntervalMs({
          active,
          failures: st?.failures ?? 0,
          activeMs: pollMs,
          backgroundMs: backgroundPollMs,
        });
        if (isDue(now, st?.lastAttemptAt ?? 0, interval)) void fetchOne(p.chain, p.address);
      }
    };
    check();
    const id = window.setInterval(check, SCHEDULER_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sig, pollMs, backgroundPollMs, active, fetchOne]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deliver anything still held when the hook goes away.
  useEffect(() => () => flushNow(), [flushNow]);

  const refresh = useCallback(
    async (chain?: ChainType) => {
      const targets = chain ? pairs.filter((p) => p.chain === chain) : pairs;
      await Promise.all(targets.map((p) => fetchOne(p.chain, p.address, true)));
      flushNow();
    },
    [pairs, fetchOne, flushNow]
  );

  return { txByChain, loading, errors, refresh };
}
