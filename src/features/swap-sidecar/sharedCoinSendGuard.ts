/**
 * Sending a Grove-shared coin (BTC / LTC / BCH) is an ordinary on-chain send
 * from the wallet's own signer. This module is the one question Grove still
 * gets asked first: "is a swap of yours using this coin right now?"
 *
 * # Why the send no longer goes THROUGH Grove (2026-09-12)
 *
 * C8 routed a verified-shared BTC/LTC send into the engine
 * (`swap_bridge_shared_coin_withdraw`), on two grounds: the engine held the
 * complete account while the adapter could only spend index 0, and two signers
 * selecting inputs from one account could build conflicting transactions.
 *
 * The first ground stopped being true on 2026-08-25, when `sendFromAccount`
 * learned to gather the whole BIP-84 account. The second was never a funds
 * risk — a conflicting spend is rejected by the mempool, not paid twice. What
 * the routing DID do was make every BTC/LTC send depend on a sidecar process
 * being up, unlocked, and holding its account key: on 2026-09-12 an LTC send
 * failed silently because Grove was mid-way through an unpark restart (engine
 * log: `HTTP server stopped.` at 21:35:39, `Starting BasicSwap` at 21:38:44)
 * and came back without the LTC account key
 * (`PWNDA-PATCH-3: LTC expects a host-wallet account key; none pushed yet`).
 *
 * # What is left, and which way it fails
 *
 * The one real interaction is a swap in flight: the engine may be about to fund
 * a lock from the same UTXOs. So when Grove ANSWERS that it has an active bid
 * touching this coin, the send is refused with that reason.
 *
 * When Grove does NOT answer — stopped, locked, restarting, slow — the send
 * proceeds. This is deliberately the opposite of the Rust
 * `reserved_balance_gate`, which fails closed. That gate protects a send the
 * ENGINE performs, where "cannot read the book" and "cannot act" are the same
 * process; here the signer does not depend on Grove at all, and refusing an
 * ordinary send because an unrelated sidecar is asleep is exactly the failure
 * this change removes. A Grove that cannot answer is also a Grove that cannot
 * be funding a lock at that moment.
 */
import { fetchBids, fetchSentBids } from "../../api/basicswap";
import { SHARED_COIN_CHAINS } from "./sharedCoinBalance";

/** Engine `chainclients` key per UPPERCASE ticker. Keyed off
 *  `SHARED_COIN_CHAINS` so a coin admitted to sharing cannot silently skip the
 *  check — `sharedCoinSendGuard.test.ts` asserts every entry has a key here. */
export const SHARED_SEND_ENGINE_COIN: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  LTC: "litecoin",
  BCH: "bitcoincash",
};

/** How long the pre-send question may take before the send goes ahead
 *  without an answer. Local IPC to a healthy node answers in milliseconds. */
export const SHARED_SEND_CHECK_TIMEOUT_MS = 5_000;

/** Wallet chain key → `{ ticker, engineCoin }`, or null for a chain Grove
 *  cannot share (every account-model chain, DOGE, DASH, …). */
export function sharedSendCoinFor(
  chain: string,
): { ticker: string; engineCoin: string } | null {
  for (const [ticker, c] of Object.entries(SHARED_COIN_CHAINS)) {
    if (c !== chain) continue;
    const engineCoin = SHARED_SEND_ENGINE_COIN[ticker];
    return engineCoin ? { ticker, engineCoin } : null;
  }
  return null;
}

/** `"Bitcoin Cash"` → `"bitcoincash"`. Mirrors Rust `normalize_coin_label`. */
function normalizeCoinLabel(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/**
 * Does a bid row's coin label (a DISPLAY name — `"Litecoin MWEB"`) refer to
 * `engineCoin`? Mirrors Rust `bid_coin_matches`, including its refusal to use
 * a prefix test: `"Bitcoin Cash"` must never count as a Bitcoin bid.
 */
export function bidCoinMatches(label: string, engineCoin: string): boolean {
  const n = normalizeCoinLabel(label);
  if (n === engineCoin) return true;
  return (
    (engineCoin === "litecoin" && n === "litecoinmweb") ||
    (engineCoin === "particl" && (n === "particlblind" || n === "particlanon"))
  );
}

/**
 * Active bids touching `engineCoin` across the `bids` + `sentbids` replies,
 * deduplicated by id. `null` when any reply is not a list — the engine's
 * `{"error": …, "locked": true}` is "unknown", never "zero" (the same
 * distinction Rust `count_bids_for_coin` draws since 2026-09-05).
 */
export function countInFlightBidsForCoin(
  replies: readonly unknown[],
  engineCoin: string,
): number | null {
  const seen = new Set<string>();
  let matching = 0;
  for (const reply of replies) {
    if (!Array.isArray(reply)) return null;
    for (const row of reply) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const id = typeof r.bid_id === "string" ? r.bid_id : null;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const touches = [r.coin_from, r.coin_to].some(
        (leg) => typeof leg === "string" && bidCoinMatches(leg, engineCoin),
      );
      if (touches) matching += 1;
    }
  }
  return matching;
}

/** The refusal to show, or null to send. Only a DEFINITE non-zero count
 *  refuses; `null` (Grove did not answer) sends — see the header. */
export function sharedSendRefusal(ticker: string, inFlight: number | null): string | null {
  if (inFlight == null || inFlight <= 0) return null;
  const plural = inFlight === 1 ? "" : "s";
  return (
    `Pwnda Grove has ${inFlight} swap${plural} in progress that use${inFlight === 1 ? "s" : ""} ${ticker}, ` +
    `and may need these coins to fund ${inFlight === 1 ? "it" : "them"}. Nothing was sent — ` +
    "let the swap finish (or cancel it), then send again."
  );
}

export interface SharedSendDeps {
  fetchBids: typeof fetchBids;
  fetchSentBids: typeof fetchSentBids;
  timeoutMs?: number;
}

const DEFAULT_DEPS: SharedSendDeps = { fetchBids, fetchSentBids };

/** In-flight count for `engineCoin`, or `null` when Grove cannot answer in
 *  time (not running, locked, restarting, or slow). Never throws. */
export async function inFlightBidsForCoin(
  engineCoin: string,
  deps: SharedSendDeps = DEFAULT_DEPS,
): Promise<number | null> {
  const timeoutMs = deps.timeoutMs ?? SHARED_SEND_CHECK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const query = { with_available_or_active: true } as const;
    const replies = await Promise.race([
      Promise.all([deps.fetchBids(query), deps.fetchSentBids(query)]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
    return countInFlightBidsForCoin(replies, engineCoin);
  } catch {
    return null;
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/**
 * The whole pre-send check for one chain: `null` to send, or the refusal.
 * A chain Grove cannot share returns `null` without touching the engine.
 */
export async function checkSharedCoinSend(
  chain: string,
  deps: SharedSendDeps = DEFAULT_DEPS,
): Promise<string | null> {
  const coin = sharedSendCoinFor(chain);
  if (!coin) return null;
  const inFlight = await inFlightBidsForCoin(coin.engineCoin, deps);
  if (inFlight == null) {
    console.warn(
      `[sharedCoinSendGuard] Pwnda Grove did not answer for ${coin.ticker}; sending from the wallet's own signer`,
    );
  }
  return sharedSendRefusal(coin.ticker, inFlight);
}
