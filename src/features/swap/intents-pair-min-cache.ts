/**
 * Per-pair NEAR Intents minimum cache.
 *
 * `near-intents-tokens.ts` carries the per-asset deposit minimum
 * (`minDepositAmount`) declared by the upstream `/api/intents/tokens`
 * response. That's a floor for the SOURCE asset alone — but 1Click's
 * solver liquidity sometimes enforces a stricter minimum FOR A SPECIFIC
 * (from → to) PAIR, surfaced only as a 4xx error when the user attempts
 * a quote.
 *
 * This module captures those pair-specific minimums after the first
 * failed quote: parse the upstream error message, store the (from, to)
 * minimum, and use it the next time the user types an amount for the
 * same pair. The form's effective minimum is `max(perAssetMin, pairMin)`
 * so users see an accurate floor immediately on the second attempt.
 *
 * The cache is in-memory only (per-session). On cold start every pair
 * starts uncached — the first below-minimum attempt populates it. This
 * matches 1Click's solver liquidity which can shift over time; we don't
 * want stale pair-mins persisting across days.
 */

/**
 * How a cache entry was learned. Drives both the TTL the entry honors
 * (probe entries are fresher but get re-probed sooner) and the UI hint
 * (a probe-derived minimum is anchored to a known output level — the
 * hint can show the USD anchor).
 */
export type PairMinSource = "probe" | "upstream-error";

export interface PairMinEntry {
  /** Atomic-units string of the SOURCE asset (what the user must send). */
  atomic: string;
  /** Where this entry came from. Probe = dry EXACT_OUTPUT response;
   *  upstream-error = parsed from a rejected real quote. */
  source: PairMinSource;
  /** When this entry was learned. ms epoch. */
  learnedAt: number;
  /** USD value of the destination amount that yielded this minimum.
   *  From `quote.amountOutUsd` when the entry came from a probe. Lets
   *  the UI render "(receives ~$X of TICKER)" without re-doing math. */
  expectedAmountOutUsd?: string;
}

/** TTL per source type. Probe entries are anchored to a specific output
 *  level and may drift if solver pricing shifts; re-probe more often.
 *  Upstream-error entries record the bridge floor verbatim and rarely
 *  change. */
const PROBE_TTL_MS = 5 * 60 * 1000; // 5 min
const UPSTREAM_ERROR_TTL_MS = 30 * 60 * 1000; // 30 min

/** Keyed by `${fromAssetId}|${toAssetId}` so a single Map covers every
 *  routable pair. */
const cache = new Map<string, PairMinEntry>();

function key(fromAssetId: string, toAssetId: string): string {
  return `${fromAssetId}|${toAssetId}`;
}

/**
 * Record a pair-specific minimum learned from a probe or an upstream
 * rejection. Atomic-units string of the source asset.
 */
export function setPairMinimum(
  fromAssetId: string,
  toAssetId: string,
  atomicStr: string,
  opts: {
    source?: PairMinSource;
    expectedAmountOutUsd?: string;
  } = {},
): void {
  if (!atomicStr) return;
  const entry: PairMinEntry = {
    atomic: atomicStr,
    source: opts.source ?? "upstream-error",
    learnedAt: Date.now(),
  };
  if (opts.expectedAmountOutUsd) {
    entry.expectedAmountOutUsd = opts.expectedAmountOutUsd;
  }
  cache.set(key(fromAssetId, toAssetId), entry);
}

/** Look up the cached pair minimum atomic-units string, if any. Returns
 *  null when the entry is missing OR has expired by its source-specific
 *  TTL. Stale entries are removed on access so the cache self-cleans. */
export function getPairMinimum(
  fromAssetId: string,
  toAssetId: string,
): string | null {
  const entry = getPairMinimumEntry(fromAssetId, toAssetId);
  return entry?.atomic ?? null;
}

/** Like `getPairMinimum` but returns the full entry. Used by the form
 *  to render the USD-anchor sub-line and surface the source label. */
export function getPairMinimumEntry(
  fromAssetId: string,
  toAssetId: string,
): PairMinEntry | null {
  const entry = cache.get(key(fromAssetId, toAssetId));
  if (!entry) return null;
  const ttl =
    entry.source === "probe" ? PROBE_TTL_MS : UPSTREAM_ERROR_TTL_MS;
  if (Date.now() - entry.learnedAt > ttl) {
    cache.delete(key(fromAssetId, toAssetId));
    return null;
  }
  return entry;
}

/**
 * Wording that means "this is a minimum". Drawn from the shapes this module is
 * pinned against: "try at least N", "minimum amount of N wei", "minimum: N",
 * "Minimum deposit amount is N", "must be at least N", "Amount is below the
 * minimum...". A message without one of these is not a minimum, however many
 * digits it happens to carry.
 */
const MINIMUM_CUES = /at least|minimum|too low|too small|below the/i;

/**
 * Parse an upstream `minimum amount` error message into an atomic-units
 * string. 1Click's wording varies; we match a handful of known shapes:
 *
 *   "Amount is below the minimum amount of 1000000000000000 wei."
 *   "minimum: 50000000 (lamports)"
 *   "must be at least 0.001 ETH (1000000000000000 wei)"
 *   "Minimum deposit amount is 5000000000000 yoctoNEAR"
 *
 * We always pull the largest digit-only token in the string that's
 * "obviously atomic" — i.e. an integer of ≥4 digits with no decimal
 * point. Real on-chain atomic minimums are always integers; treating
 * the largest integer in the message as the atomic minimum is a robust
 * heuristic across upstream wording.
 *
 * Returns null if no integer of ≥4 digits is found — leaves the cache
 * empty rather than poisoning it with a guess.
 */
export function parseMinAtomicFromUpstreamError(message: string): string | null {
  // The message must actually be ABOUT a minimum. Added 2026-09-05: this
  // function was called on any failure, and a probe that died locally with
  // "open the Cardano chain in the dashboard so the wallet derives one
  // (CIP-1852 path)" yielded a floor of 1852 atomic units — a fabricated
  // minimum, cached for the pair, from an error that never reached NEAR.
  // Every shape this parser is pinned against carries one of these cues.
  if (!MINIMUM_CUES.test(message)) return null;
  // Match all unbroken digit-only runs of length ≥4. Strict — won't
  // match "1.5" or "1,500" (the comma form is rare in upstream JSON).
  const matches = message.match(/\b\d{4,}\b/g);
  if (!matches || matches.length === 0) return null;
  // Pick the largest by lexicographic length (since they're integers,
  // longer = larger). Ties: take the last one — typically the wei-shape
  // value, since human-readable forms come first in upstream wording.
  let best = matches[0];
  for (const m of matches) {
    if (m.length > best.length) best = m;
    else if (m.length === best.length && m > best) best = m;
  }
  return best;
}

/** Clear the cache. Used by tests + the Settings "Refresh asset list"
 *  flow so the next quote starts fresh. */
export function clearPairMinimumCache(): void {
  cache.clear();
}

/** Read the cache out for diagnostic purposes. */
export function _snapshotForTests(): Array<{
  from: string;
  to: string;
  atomic: string;
  source: PairMinSource;
  learnedAt: number;
  expectedAmountOutUsd?: string;
}> {
  const out: Array<{
    from: string;
    to: string;
    atomic: string;
    source: PairMinSource;
    learnedAt: number;
    expectedAmountOutUsd?: string;
  }> = [];
  for (const [k, v] of cache.entries()) {
    const [from, to] = k.split("|");
    const row = {
      from,
      to,
      atomic: v.atomic,
      source: v.source,
      learnedAt: v.learnedAt,
      ...(v.expectedAmountOutUsd
        ? { expectedAmountOutUsd: v.expectedAmountOutUsd }
        : {}),
    };
    out.push(row);
  }
  return out;
}

/** Test seam — lets a unit test rewind `learnedAt` so TTL behavior
 *  can be exercised without sleeping. */
export function _setLearnedAtForTests(
  fromAssetId: string,
  toAssetId: string,
  learnedAt: number,
): void {
  const entry = cache.get(key(fromAssetId, toAssetId));
  if (entry) entry.learnedAt = learnedAt;
}
