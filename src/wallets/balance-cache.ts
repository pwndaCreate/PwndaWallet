/**
 * Balance loading — speed and reliability helpers (2026-08-22).
 *
 * Everything here is pure except the two cache I/O functions, so the
 * behaviour the dashboard depends on can be unit-tested without a network or
 * a webview. `App.tsx`'s `refreshAllBalances` composes these.
 *
 * # The defects this replaces (from the 2026-08-22 RPC survey)
 *
 * - **Unbounded fan-out.** `Promise.all` over ~27 chains at once, several of
 *   them sharing one rate-limited host (BlockCypher, Blockchair) — the exact
 *   shape that produced the 2026-06-17 429/430 blacklist incident. Now a
 *   bounded queue, active chain first.
 * - **No deadline.** Most direct-`fetch` adapters have no timeout, and the
 *   proxied ones allow 30 s × 3 sources, so the whole sweep waited on the
 *   slowest chain. Now every chain gets one deadline.
 * - **Failure blanked the number.** A failed refresh wrote `"—"` over a
 *   value that was correct a minute ago. Now a known numeric value is kept
 *   (the row is merely stale), and `"—"` is reserved for "never had one".
 * - **Cold start was all "—"** until the network answered. Now the last
 *   successful reading per `chain:address` is persisted and hydrated first,
 *   the same hydrate-then-fetch pattern `useTxHistory` already uses.
 */
import type { ChainType, WalletInfo } from "./index";

/** Concurrent balance fetches in flight at once. Six keeps the shared-host
 *  buckets (BlockCypher/Blockchair) under their keyless caps while still
 *  filling a 27-row list in a few round trips. */
export const BALANCE_CONCURRENCY = 6;

/** Per-chain deadline. Generous enough for a slow public RPC, short enough
 *  that one dead endpoint cannot hold the rest of the list hostage. */
export const BALANCE_DEADLINE_MS = 20_000;

const STORE_FILE = "balance-cache.json";

export interface CachedBalance {
  balance: string;
  fetchedAt: number;
}

export function cacheKey(chain: ChainType, address: string): string {
  return `${chain}:${address}`;
}

/** A balance string the dashboard can do arithmetic on — not "—", not
 *  "Syncing…", not an error message. */
export function isNumericBalance(s: string | undefined | null): s is string {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t === "") return false;
  return /^-?\d+(\.\d+)?$/.test(t) && Number.isFinite(Number(t));
}

/**
 * Run `tasks` with at most `limit` in flight. Settles every task; a task's
 * own rejection is NOT propagated (each task is expected to handle its own
 * failure — the sweep does, per chain), so one bad chain never aborts the
 * queue.
 */
export async function runLimited(
  tasks: ReadonlyArray<() => Promise<unknown>>,
  limit: number,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, tasks.length));
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        await tasks[i]();
      } catch {
        /* per-task failure is the task's own business */
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
}

/** Reject after `ms` with a named error. The underlying promise is not
 *  cancelled (adapters do not take an AbortSignal yet) — this unblocks the
 *  UI; the straggling request is simply ignored when it lands. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms} ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Stable reorder that puts `first` at the front — the focal number should
 *  land before the long tail. */
export function orderChains<T extends [ChainType, unknown]>(
  entries: ReadonlyArray<T>,
  first: ChainType | null | undefined,
): T[] {
  if (!first) return [...entries];
  const head = entries.filter(([c]) => c === first);
  const rest = entries.filter(([c]) => c !== first);
  return [...head, ...rest];
}

/**
 * The failure branch of the sweep: keep a known numeric value (stale beats
 * blank), write "—" only when there was never one. Returns a new object.
 *
 * "Stale beats blank" is only true WITHIN one wallet. Across a wallet switch
 * the last-known value is a different wallet's money, and keeping it puts a
 * number on screen that the user reasonably reads as this wallet's balance.
 * Pass `recordedAddress` (the address the retained value was fetched for) and
 * `currentAddress` (the address we just failed to fetch) and a mismatch is
 * refused: "—" is honest, the other wallet's balance is not.
 *
 * Both optional so the old two-argument call is still "keep whatever we have",
 * but every call site inside the balance sweep supplies them.
 */
export function keepLastGood(
  prev: Readonly<Partial<Record<ChainType, string>>>,
  chain: ChainType,
  addrs?: { recordedAddress?: string; currentAddress?: string },
): Partial<Record<ChainType, string>> {
  const next = { ...prev };
  const recorded = addrs?.recordedAddress;
  const current = addrs?.currentAddress;
  const belongsToAnotherWallet =
    recorded !== undefined && current !== undefined && recorded !== current;
  if (belongsToAnotherWallet || !isNumericBalance(prev[chain])) {
    next[chain] = "—";
  }
  return next;
}

/**
 * Merge cached readings into the current map for the CURRENT addresses.
 *
 * - An in-session value is kept when it was recorded for this same address
 *   (`prevAddrs`), or when its address was never recorded (a value that
 *   arrived before this bookkeeping existed).
 * - Otherwise the cached reading for `chain:address` is used, if any.
 * - A value recorded for a DIFFERENT address is dropped — switching wallet
 *   must not carry the old wallet's number across.
 *
 * Pure. Returns both the balances and the address book to store.
 */
export function hydrateBalances(
  prev: Readonly<Partial<Record<ChainType, string>>>,
  prevAddrs: Readonly<Partial<Record<ChainType, string>>>,
  entries: ReadonlyArray<[ChainType, WalletInfo]>,
  cached: Readonly<Record<string, CachedBalance>>,
): {
  balances: Partial<Record<ChainType, string>>;
  addrs: Partial<Record<ChainType, string>>;
} {
  const balances: Partial<Record<ChainType, string>> = {};
  const addrs: Partial<Record<ChainType, string>> = {};
  for (const [chain, w] of entries) {
    const address = w.address;
    addrs[chain] = address;
    const recorded = prevAddrs[chain];
    const keepPrev =
      prev[chain] != null && (recorded === undefined || recorded === address);
    if (keepPrev) {
      balances[chain] = prev[chain];
      continue;
    }
    const c = cached[cacheKey(chain, address)];
    if (c && isNumericBalance(c.balance)) balances[chain] = c.balance;
  }
  return { balances, addrs };
}

// ── Persistence (best-effort; never throws) ──────────────────────────────

type StoreLike = {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
  entries<T>(): Promise<[string, T][]>;
};

let _store: Promise<StoreLike | null> | null = null;
function getStore(): Promise<StoreLike | null> {
  if (!_store) {
    _store = import("@tauri-apps/plugin-store")
      .then((m) => m.Store.load(STORE_FILE) as unknown as Promise<StoreLike>)
      .catch(() => null);
  }
  return _store;
}

/** Every cached reading, keyed by `chain:address`. Empty on any failure. */
export async function readBalanceCache(): Promise<Record<string, CachedBalance>> {
  try {
    const store = await getStore();
    if (!store) return {};
    const out: Record<string, CachedBalance> = {};
    for (const [k, v] of await store.entries<CachedBalance>()) {
      if (v && typeof v.balance === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Record one successful reading. Fire-and-forget; failure is non-fatal. */
export async function writeBalanceCache(
  chain: ChainType,
  address: string,
  balance: string,
): Promise<void> {
  if (!isNumericBalance(balance)) return;
  try {
    const store = await getStore();
    if (!store) return;
    const entry: CachedBalance = { balance, fetchedAt: Date.now() };
    await store.set(cacheKey(chain, address), entry);
    await store.save();
  } catch {
    /* cache write failure is non-fatal */
  }
}
