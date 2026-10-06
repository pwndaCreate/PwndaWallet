/**
 * The Bitcoin transactions THIS APP built and broadcast (operator request,
 * 2026-10-01) — the gate in front of "Speed up".
 *
 * # Why a record, and not "every input is the wallet's"
 *
 * The swap engine (BasicSwap, "Grove") can share this wallet's BTC account
 * keys (C8 account-key sharing, `swapAccountKey.ts`), so a transaction whose
 * every input is the wallet's own may be one the ENGINE built — an atomic
 * swap's lock transaction, whose txid the counterparty's pre-signed refund
 * transaction spends. A replacement keeps every output, but it gets a new
 * txid, and a refund signed against the old one can then never be valid:
 * the coins would sit in a 2-of-2 output that only both parties together can
 * move. Nothing in the transaction itself tells the wallet's send from the
 * engine's (both can be version 2, locktime 0, RBF-signalling, paying a
 * P2WSH), so the wallet keeps its own list instead, and offers a speed-up only
 * for a transaction on it.
 *
 * A transaction is recorded when it is SIGNED, just before its first push
 * (`broadcastBtc` in `btc-wallet.ts`; the swap's Rust-signed fallback in
 * `swap-sources.ts`): a crash or a lost reply after that still leaves it on
 * the list, and one the network then refuses is harmless here, because it
 * never reaches a history that could offer it.
 *
 * Kept in `btc-own-txs.json` (tauri-plugin-store) so a transaction stuck
 * across a restart can still be sped up. Best-effort like the other wallet
 * caches: a store that cannot be read means only this session's sends are
 * known, which fails closed (no button), never open.
 */

const STORE_FILE = "btc-own-txs.json";
const STORE_KEY = "txids";
/** Newest entries kept. A send that has not confirmed by the time 300 more
 *  were made has long been dropped from every mempool. */
const MAX_ENTRIES = 300;
/** Bitcoin Core drops a transaction from its mempool after 336 hours; a
 *  month is well past that. */
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

type Entry = { txid: string; at: number };

type StoreLike = {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

const TXID = /^[0-9a-f]{64}$/;

/** txid → when it was recorded (ms). */
const known = new Map<string, number>();
let hydrated: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
let _store: Promise<StoreLike | null> | null = null;

function getStore(): Promise<StoreLike | null> {
  if (!_store) {
    _store = import("@tauri-apps/plugin-store")
      .then((m) => m.Store.load(STORE_FILE) as unknown as Promise<StoreLike>)
      .catch(() => null);
  }
  return _store;
}

function norm(txid: string): string | null {
  const t = String(txid ?? "").trim().toLowerCase();
  return TXID.test(t) ? t : null;
}

function prune(now: number): Entry[] {
  const list = [...known.entries()]
    .map(([txid, at]) => ({ txid, at }))
    .filter((e) => now - e.at <= MAX_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ENTRIES);
  if (list.length !== known.size) {
    known.clear();
    for (const e of list) known.set(e.txid, e.at);
  }
  return list;
}

function hydrate(): Promise<void> {
  if (!hydrated) {
    hydrated = (async () => {
      try {
        const store = await getStore();
        const stored = store ? await store.get<Entry[]>(STORE_KEY) : null;
        for (const e of Array.isArray(stored) ? stored : []) {
          const t = norm(e?.txid);
          if (!t || typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
          if ((known.get(t) ?? 0) < e.at) known.set(t, e.at);
        }
      } catch {
        /* unreadable: this session's own sends still count */
      }
    })();
  }
  return hydrated;
}

/**
 * Note that this app built and signed `txid`. Synchronous for the session
 * (the speed-up can see it at once); written to disk in the background.
 */
export function rememberOwnBtcTx(txid: string, now: number = Date.now()): void {
  const t = norm(txid);
  if (!t) return;
  known.set(t, now);
  writes = writes
    .then(async () => {
      await hydrate();
      const store = await getStore();
      if (!store) return;
      await store.set(STORE_KEY, prune(Date.now()));
      await store.save();
    })
    .catch(() => {
      /* persistence is best-effort; the session copy stands */
    });
}

/** Did this app build `txid`? Reads the stored list once per session. */
export async function isOwnBtcTx(txid: string): Promise<boolean> {
  const t = norm(txid);
  if (!t) return false;
  if (known.has(t)) return true;
  await hydrate();
  return known.has(t);
}

/** Test seam: forget everything, including the store handle. */
export function _resetOwnBtcTxsForTests(): void {
  known.clear();
  hydrated = null;
  writes = Promise.resolve();
  _store = null;
}

/** Test seam: wait for the background writes queued so far. */
export function _ownBtcTxWritesForTests(): Promise<void> {
  return writes;
}
