import { tickerForCoin } from "./types";

/**
 * How long an atomic swap should take, and how long this one has been going.
 *
 * # Why an estimate at all
 *
 * A cross-chain atomic swap is slow by construction — tens of minutes — and
 * for most of that time nothing visible happens. The engine is waiting on
 * block confirmations. With no elapsed time and no expectation on screen, a
 * perfectly healthy swap and a wedged one look identical, and the operator
 * asked for exactly this after a BCH → XMR swap that took 37 minutes:
 * *"add like a timer and an estimate in the pwnda ui so the user knows it's
 * still active"*.
 *
 * # Where the numbers come from
 *
 * Not a guess and not a constant. A swap waits on **four** confirmation
 * windows — each chain's lock has to confirm, and each chain's spend has to
 * confirm — so:
 *
 * ```
 * estimate = 2 * (confirmations[A] * blockSeconds[A]
 *                 + confirmations[B] * blockSeconds[B])
 * ```
 *
 * Checked against the real swap this wallet completed: BCH ↔ XMR predicts
 * `2 * (1*600 + 3*120)` = 32 min; the measured 2026-09-05 swap (bid
 * `000000006a9c5eaa…`, created 18:25 UTC, completed ~19:02 UTC) took
 * **37 min**. Within 16% from first principles, which is why this is a
 * *window* rather than a countdown.
 *
 * Deliberately NOT a countdown. A number ticking down to zero and then
 * sitting at zero is worse than no number: it turns "slow" into "broken" at
 * exactly the moment the user most needs to be told to wait.
 */

/**
 * Confirmations each chain's lock must reach before the engine will move on.
 *
 * Mirrors `chainclients.<coin>.blocks_confirmed` in the Grove's own
 * `basicswap.json` — read from the live node on 2026-09-05. ZEPH (3) and
 * ZANO (10) are ours and are pinned against their patches in the tests;
 * BTC/BCH/LTC/XMR are upstream's prepare defaults.
 *
 * A coin missing here yields no estimate rather than a wrong one.
 */
export const CONFIRMATIONS: Readonly<Record<string, number>> = {
  BTC: 1,
  BCH: 1,
  LTC: 2,
  XMR: 3,
  ZEPH: 3,
  ZANO: 10,
  PART: 2,
};

/** Target block interval, seconds. Protocol constants, not measurements. */
export const BLOCK_SECONDS: Readonly<Record<string, number>> = {
  BTC: 600,
  BCH: 600,
  LTC: 150,
  XMR: 120,
  ZEPH: 120,
  ZANO: 60,
  PART: 120,
};

/** The window a swap on this pair should land in. */
export interface EtaWindow {
  /** Seconds: the four confirmation waits, summed. */
  typicalSec: number;
  /** Seconds: past this, the swap is unusually slow (still not unsafe). */
  highSec: number;
}

/**
 * Normalize whatever the caller has to the ticker the tables are keyed by.
 *
 * Not `toUpperCase()`. The tracker's swaps carry upstream's DISPLAY NAMES —
 * `SidecarTrackedSwap.sendCoin` is `r.coin_to`, which reads "Litecoin", not
 * "LTC" — so a naive upcase resolved every in-flight swap to `null` and the
 * estimate silently vanished from the one card that most needed it. Caught in
 * the sandbox on 2026-09-05, not by a unit test: the tests were written in the
 * tickers the author had in mind rather than the strings the app passes.
 */
function ticker(coin: string): string {
  return tickerForCoin(coin) ?? coin.trim().toUpperCase();
}

/**
 * The expected duration window for a swap between these two coins, or `null`
 * when either side is a coin with no published confirmation depth — an
 * estimate assembled from a default would be a fabrication, and the UI can
 * say nothing perfectly well.
 */
export function etaWindow(sendCoin: string, receiveCoin: string): EtaWindow | null {
  const a = ticker(sendCoin);
  const b = ticker(receiveCoin);
  const ca = CONFIRMATIONS[a];
  const cb = CONFIRMATIONS[b];
  const ba = BLOCK_SECONDS[a];
  const bb = BLOCK_SECONDS[b];
  if (!ca || !cb || !ba || !bb) return null;
  // Two confirmation windows per chain: the lock, then the spend.
  const typicalSec = 2 * (ca * ba + cb * bb);
  // 1.75x, rounded up to the next 5 minutes. Empirical headroom for mempool
  // wait and the engine's own inter-step pauses, not a second model — it
  // exists so "longer than typical" can mean something.
  const highSec = Math.ceil((typicalSec * 1.75) / 300) * 300;
  return { typicalSec, highSec };
}

/**
 * Seconds since the bid was created, or `null` if the timestamp is unusable.
 *
 * `createdAt` is unix SECONDS off the engine. A zero, a negative, or a value
 * well in the future means the payload is not what we think it is; a timer
 * that silently counts from 1970 would be worse than none.
 */
export function elapsedSeconds(createdAtUnixSec: number, nowMs: number): number | null {
  if (!Number.isFinite(createdAtUnixSec) || createdAtUnixSec <= 0) return null;
  const nowSec = Math.floor(nowMs / 1000);
  const delta = nowSec - Math.floor(createdAtUnixSec);
  // A minute of clock skew is tolerated and clamped; more than that is a
  // timestamp we do not understand.
  if (delta < -60) return null;
  return Math.max(0, delta);
}

/**
 * Compact elapsed-time label: `42s`, `4m 12s`, `1h 06m`.
 *
 * Seconds are shown for the first hour on purpose — a number that visibly
 * moves is the whole point of the timer.
 */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Round seconds to whole minutes for the estimate copy. Never below 1. */
function minutes(sec: number): number {
  return Math.max(1, Math.round(sec / 60));
}

/** `30–60 min` — the bare range, for a chip with no room for a sentence. */
export function formatEtaRange(w: EtaWindow): string {
  const lo = Math.max(5, Math.round(minutes(w.typicalSec) / 5) * 5);
  const hi = Math.round(minutes(w.highSec) / 5) * 5;
  return hi > lo ? `${lo} to ${hi} min` : `${lo} min`;
}

/** `about 30–60 min` — the window, in the phrasing the prose surfaces use. */
export function formatEtaWindow(w: EtaWindow): string {
  return `about ${formatEtaRange(w)}`;
}

export type EtaStanding = "onTrack" | "slow" | "overdue" | "unknown";

/**
 * Where this swap sits against its window.
 *
 * The boundary is `highSec`, not `typicalSec`, because `highSec` is the top of
 * the range the UI actually shows the user. Grading against the midpoint would
 * put "a little past usual" on screen beside "usually 30-60 min" at 37
 * minutes — which is what the one measured swap took, and is plainly inside
 * the range we just quoted. The displayed window is the contract.
 */
export function etaStanding(elapsedSec: number | null, w: EtaWindow | null): EtaStanding {
  if (elapsedSec == null || !w) return "unknown";
  if (elapsedSec <= w.highSec) return "onTrack";
  // Twice the window: unusual, but a chain having a bad hour is unusual too.
  if (elapsedSec <= w.highSec * 2) return "slow";
  return "overdue";
}

/**
 * One sentence for the tracker: what the clock means right now.
 *
 * Every branch says the swap is still running, because it is: past the window
 * is a slow chain, not a lost swap, and the funds stay locked until either the
 * swap completes or a timelock resolves it. Alarming the user into a manual
 * recovery they do not need is the failure mode this copy is written against.
 *
 * # Only valid ON the happy arc
 *
 * Callers must not render this once a swap has left the arc for the timelock
 * path — see `SidecarSwapTracker.tsx`, which gates it on `onArc`. Two reasons,
 * both observed on the same live bid (`000000006a9c9d96…`, 2026-09-08):
 *
 * 1. `overdue` read "Longer than the usual about 20 to 40 min" beside an
 *    elapsed time of **51 hours**. Comparing a swap that is now governed by a
 *    CSV lock against a four-confirmation estimate is not a comparison.
 * 2. The old `overdue` branch ended "the timelock returns your funds if it
 *    never completes", which is only true on the SCRIPTED leg. On the
 *    scriptless leg the timelock pays out the counterparty's coin instead —
 *    still a good outcome, but not the one that sentence promises, and the
 *    user reasonably read it as "I have been refunded".
 *
 * The wording below now holds on either leg.
 */
export function etaSentence(elapsedSec: number | null, w: EtaWindow | null): string {
  switch (etaStanding(elapsedSec, w)) {
    case "onTrack":
      return `Usually ${formatEtaWindow(w as EtaWindow)}. Nothing to do.`;
    case "slow":
      return `Past the usual ${formatEtaWindow(w as EtaWindow)}. Still normal. Nothing to do.`;
    case "overdue":
      return `Longer than the usual ${formatEtaWindow(w as EtaWindow)}. Still live. A timelock ends it either way, so neither side can walk away with your coins.`;
    default:
      return "Running in the background.";
  }
}
