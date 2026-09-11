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
 *
 * ## Two kinds of floor
 *
 * Everything above describes a floor stated in ATOMIC UNITS of one asset
 * ("try at least 2655163748239372"). Since 2026-09-09 upstream also states
 * floors in DOLLARS ("Temporary swap limits: minimum swap amount is
 * $1,000"), which is a claim about the size of the swap, not about an
 * amount of any one coin. Those arrive from the HOT Omni Bridge and apply
 * to every pair carrying a `nep245:v2_1.omni.hot.tg:*` asset on either leg.
 *
 * They are parsed by `parseMinUsdFromUpstreamError` and stored as
 * `source: "usd-limit"` entries whose `atomic` is OUR conversion at a live
 * price, with the bridge's own dollar figure kept beside it in `usdFloor`.
 * Keeping both is the point: the conversion is what the form compares
 * against, and the dollar figure is what the copy quotes, so the wallet
 * never attributes a coin amount to a bridge that only ever said a price.
 */

/**
 * How a cache entry was learned. Drives both the TTL the entry honors
 * (probe entries are fresher but get re-probed sooner) and the UI hint
 * (a probe-derived minimum is anchored to a known output level — the
 * hint can show the USD anchor).
 */
export type PairMinSource = "probe" | "upstream-error" | "usd-limit";

export interface PairMinEntry {
  /** Atomic-units string of the SOURCE asset (what the user must send). */
  atomic: string;
  /** Where this entry came from. Probe = dry EXACT_OUTPUT response;
   *  upstream-error = parsed from a rejected real quote; usd-limit =
   *  converted from a FIAT floor the upstream stated in dollars, where
   *  `atomic` is our own price-derived equivalent rather than a number
   *  the bridge ever said. */
  source: PairMinSource;
  /** When this entry was learned. ms epoch. */
  learnedAt: number;
  /** USD value of the destination amount that yielded this minimum.
   *  From `quote.amountOutUsd` when the entry came from a probe. Lets
   *  the UI render "(receives ~$X of TICKER)" without re-doing math. */
  expectedAmountOutUsd?: string;
  /**
   * The floor as the UPSTREAM stated it, in dollars, when it stated one
   * — `"1000"` for *"minimum swap amount is $1,000"*. Present only on
   * `source: "usd-limit"` entries.
   *
   * It is kept alongside `atomic` because the two are not the same claim.
   * `atomic` is ours: dollars divided by a price that moves, so it is an
   * estimate that goes stale. `usdFloor` is the bridge's own sentence and
   * stays true while the limit stands. The hint copy leads with this one
   * and marks the converted amount approximate, so the wallet never
   * attributes a number to upstream that upstream did not say.
   */
  usdFloor?: string;
}

/** TTL per source type. Probe entries are anchored to a specific output
 *  level and may drift if solver pricing shifts; re-probe more often.
 *  Upstream-error entries record the bridge floor verbatim and rarely
 *  change. */
const PROBE_TTL_MS = 5 * 60 * 1000; // 5 min
const UPSTREAM_ERROR_TTL_MS = 30 * 60 * 1000; // 30 min
/** A USD limit is stated by upstream as TEMPORARY, and `atomic` on such an
 *  entry is a price conversion that drifts with the market. Both reasons
 *  point the same way: expire it soon enough that the wallet notices when
 *  the limit lifts, rather than blocking swaps against a floor that is no
 *  longer there. */
const USD_LIMIT_TTL_MS = 10 * 60 * 1000; // 10 min

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
    usdFloor?: string;
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
  if (opts.usdFloor) {
    entry.usdFloor = opts.usdFloor;
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
    entry.source === "probe"
      ? PROBE_TTL_MS
      : entry.source === "usd-limit"
        ? USD_LIMIT_TTL_MS
        : UPSTREAM_ERROR_TTL_MS;
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
 * An amount denominated in MONEY rather than in atomic units.
 *
 * Matches `$1,000`, `$ 1000`, `1000 USD`, `1,000.50 dollars`. Two callers
 * want it and they want opposite things: `parseMinUsdFromUpstreamError`
 * reads it, and `parseMinAtomicFromUpstreamError` deletes it before looking
 * for integers, because a dollar figure that reaches the atomic parser
 * becomes a fabricated on chain floor.
 */
const CURRENCY_AMOUNT =
  /\$\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:USD|dollars?)\b/gi;

/**
 * Parse a FIAT floor out of an upstream rejection.
 *
 * The shape this exists for, captured live 2026-09-09 on AVAX to BTC:
 *
 *   "Temporary swap limits: minimum swap amount is $1,000"
 *
 * It is a different KIND of claim from everything
 * `parseMinAtomicFromUpstreamError` handles. Those messages name an on chain
 * amount of one specific asset, so the number can be cached and compared
 * against what the user typed. This one names a dollar value of the whole
 * swap, applies to every pair carrying a HOT Omni Bridge
 * (`nep245:v2_1.omni.hot.tg:*`) asset on EITHER leg, and has to be turned
 * into an asset amount by us, at a price that moves.
 *
 * Returns the dollar figure as a plain numeric string (`"1000"`), commas
 * stripped, or null when the message is not about a minimum or names no
 * money. The caller converts.
 */
export function parseMinUsdFromUpstreamError(message: string): string | null {
  if (!MINIMUM_CUES.test(message)) return null;
  // Fresh non global regex per call: CURRENCY_AMOUNT is /g, and a shared /g
  // regex carries `lastIndex` between calls, so reusing it here would make
  // the second call on the same string miss.
  const m = message.match(new RegExp(CURRENCY_AMOUNT.source, "i"));
  if (!m) return null;
  const raw = m[0]
    .replace(/[$,]/g, "")
    .replace(/\s*(USD|dollars?)\s*$/i, "")
    .trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return raw;
}

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
  // Delete money before counting digits. Added 2026-09-09, after 1Click began
  // answering HOT Omni Bridge pairs with "Temporary swap limits: minimum swap
  // amount is $1,000": the cue gate passes on "minimum", and the ONLY thing
  // that stopped "1,000" reaching the cache as a floor of 1000 wei was the
  // comma. Written "$1000" it parses, and the form would then have told the
  // user that 0.000000000000001 AVAX cleared the floor. That is the same
  // fabricated floor failure as the "CIP-1852 path" message which yielded a
  // minimum of 1852 on 2026-09-05, one message shape further along.
  //
  // A dollar figure is not atomic units of anything. It belongs to
  // `parseMinUsdFromUpstreamError`, which converts it at a live price and
  // labels the result as ours rather than the bridge's.
  const scrubbed = message.replace(CURRENCY_AMOUNT, " ");
  const matches = scrubbed.match(/\b\d{4,}\b/g);
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
export function _snapshotForTests(): Array<
  PairMinEntry & { from: string; to: string }
> {
  const out: Array<PairMinEntry & { from: string; to: string }> = [];
  for (const [k, v] of cache.entries()) {
    const [from, to] = k.split("|");
    out.push({ ...v, from, to });
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
