/**
 * Per-pair NEAR Intents minimum probe — adaptive descending EXACT_OUTPUT.
 *
 * 1Click does not publish per-pair minimums. They're solver-dynamic, set
 * by liquidity + gas + risk premium. The only authoritative way to learn
 * the floor is to probe `/v0/quote` itself.
 *
 * This module fires `dry: true, swapType: "EXACT_OUTPUT"` probes against
 * a configurable USD schedule (default $0.05 → $0.20 → $1.00 → $5.00).
 *
 * Live-verified behavior (2026-05-09 capture, see
 * `wiki/synthesis/per-pair-minimums-research.md` §8):
 *   - When the requested OUTPUT is below the bridge floor, the response
 *     is a 4xx with `"Amount is too low for bridge, try at least N"`.
 *     `N` is the bridge's minimum output amount in atomic units.
 *   - When the requested OUTPUT is at or above the floor, the response
 *     is a 200 with `quote.minAmountIn` (the strict input the user must
 *     send to receive that output, with slippage applied) and
 *     `quote.amountOutUsd` (the USD anchor for the hint copy).
 *
 * Optimization: when a probe rejects with `"try at least N"`, the loop
 * inserts a one-time bonus probe at exactly `N` before continuing the
 * scheduled descent. ETH→BTC bridge floor at $5.15? The first probe at
 * $0.05 rejects, the parsed-N bonus probe at the floor succeeds, and we
 * cache the answer in 2 calls instead of 4. Bounded at 4 probes total.
 *
 * Falls back to the existing reactive `parseMinAtomicFromUpstreamError`
 * (in `intents-pair-min-cache.ts`) when all probes are exhausted —
 * users still get a hint after their first real-quote rejection.
 */

import { getIntentsQuote } from "../../api/proxy";
import type {
  IntentsQuoteRequest,
  IntentsQuoteResponse,
} from "../../lib/proxy-types";
import {
  parseMinAtomicFromUpstreamError,
  parseMinUsdFromUpstreamError,
  setPairMinimum,
  type PairMinEntry,
} from "./intents-pair-min-cache";
import type { NearIntentsToken } from "./near-intents-tokens";
import type { WalletAddresses } from "./asset-address-resolver";
import { addressForAssetId } from "./asset-address-resolver";

/**
 * Default USD probe schedule. Cheap-first to favor catching small
 * minimums (cross-chain SOL/MATIC pairs), grows fast enough to clear
 * expensive bridge floors (BTC, monad) within 4 attempts.
 */
const DEFAULT_SCHEDULE_USD = [0.05, 0.2, 1.0, 5.0];

/** Hard cap. Even with the parse-bonus optimization, we never exceed
 *  this many quote calls per pair to bound the upstream rate-limit
 *  footprint. */
const MAX_PROBES = 4;

/**
 * Read the schedule from VITE_PWNDA_PAIRMIN_PROBE_USD_SCHEDULE if set.
 * Format: comma-separated USD numbers, e.g. "0.05,0.2,1,5". Empty /
 * absent / unparseable → returns null and the caller falls back to
 * `DEFAULT_SCHEDULE_USD`.
 */
export function readScheduleEnv(): number[] | null {
  const env = (import.meta as unknown as { env?: Record<string, string> })
    .env;
  const raw = env?.VITE_PWNDA_PAIRMIN_PROBE_USD_SCHEDULE;
  if (!raw || typeof raw !== "string") return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0) return null;
    out.push(n);
  }
  return out.length > 0 ? out : null;
}

/**
 * Convert a USD amount into the destination token's atomic units using
 * its live `price` (USD per token). Returns `"0"` when the price is
 * absent or non-positive — caller must skip that probe entry rather
 * than emitting amount=0 (which 1Click rejects).
 *
 *   dollarAmountAtomic({ price: 80419, decimals: 8 }, 0.05) === "63"
 *   dollarAmountAtomic({ price: 2315.81, decimals: 18 }, 1) === "431...e15"
 */
export function dollarAmountAtomic(
  token: Pick<NearIntentsToken, "price" | "decimals">,
  usd: number,
): string {
  if (!token.price || token.price <= 0 || !Number.isFinite(token.price)) {
    return "0";
  }
  const nativeAmount = usd / token.price;
  // Use BigInt math to avoid floating-point drift at large decimal counts.
  // nativeAmount × 10^decimals → ceil → BigInt.
  const scale = 10 ** Math.min(token.decimals, 15); // safe Number range
  const scaled = Math.ceil(nativeAmount * scale);
  if (scaled <= 0) return "0";
  if (token.decimals <= 15) {
    return scaled.toString();
  }
  // For high-decimal tokens (NEAR=24, FLR=18) shift the rest in BigInt.
  const extra = token.decimals - 15;
  return (BigInt(scaled) * 10n ** BigInt(extra)).toString();
}

/**
 * Headroom over a stated dollar floor, when converting it to an amount of
 * the source asset.
 *
 * The floor is enforced on the swap's USD value as 1Click prices it, at the
 * moment of the request, against a price that moves between our conversion
 * and their check. Landing exactly on the line is landing on the wrong side
 * of it: probed live 2026-09-09, $1,000.00 of USDC on Polygon was refused
 * and $1,009.95 quoted. So MIN offers a size that actually fills, and the
 * copy says "about" and quotes the bridge's own figure as the real rule.
 */
const USD_FLOOR_HEADROOM = 1.02;

/**
 * Significant digits kept when a dollar floor is converted to an amount of
 * the source asset.
 *
 * `$1,000 x 1.02 / $38.6` is `26.49776747216676` AVAX, and eighteen decimal
 * places of a number we rounded up from a price tick reads as a precision
 * that is not there. Four digits says `26.5`.
 *
 * Rounding UP is what makes this safe to do at all: the result stays above
 * the floor, so it is still a floor, and MIN still fills a size that quotes.
 * Rounding to nearest would sometimes land under it and turn the preset into
 * a button that reliably produces a refusal.
 */
const USD_FLOOR_SIG_DIGITS = 4;

/** Round an atomic amount UP to `sig` significant digits. */
function roundUpToSignificant(atomic: string, sig: number): string {
  const v = BigInt(atomic);
  const digits = v.toString().length;
  if (digits <= sig) return atomic;
  const scale = 10n ** BigInt(digits - sig);
  const q = v / scale;
  return ((v % scale === 0n ? q : q + 1n) * scale).toString();
}

/**
 * Learn a dollar denominated floor from an upstream rejection and cache it
 * as an amount of the SOURCE asset.
 *
 * Called wherever `parseMinAtomicFromUpstreamError` gives up, which is the
 * right place for it: a message carrying a dollar figure and no atomic one
 * is precisely the case the atomic parser is now built to refuse.
 *
 * Returns the entry's atomic string on success, null when the message names
 * no dollar floor or the source asset has no cached price to convert with.
 * A null keeps the cache empty rather than guessing, same contract as the
 * atomic path.
 */
export function learnUsdLimitFromError(args: {
  message: string;
  fromAsset: NearIntentsToken;
  toAsset: NearIntentsToken;
}): string | null {
  const usd = parseMinUsdFromUpstreamError(args.message);
  if (!usd) return null;
  const raw = dollarAmountAtomic(
    args.fromAsset,
    Number(usd) * USD_FLOOR_HEADROOM,
  );
  // "0" is `dollarAmountAtomic`'s no-price answer. Caching it would make
  // `belowMinimum` compare against zero and pass everything, which reads as
  // "no limit" on a screen where there certainly is one.
  if (raw === "0") return null;
  const atomic = roundUpToSignificant(raw, USD_FLOOR_SIG_DIGITS);
  setPairMinimum(args.fromAsset.assetId, args.toAsset.assetId, atomic, {
    source: "usd-limit",
    usdFloor: usd,
  });
  return atomic;
}

/**
 * Build a `dry: true, EXACT_OUTPUT` quote request body for a probe.
 * Recipient + refundTo come from the user's resolved wallet addresses
 * via `addressForAssetId`. The probe is dry — no funds move — so even
 * if the addresses were placeholders the call would succeed; using real
 * resolved addresses keeps the probe response shape identical to a
 * real quote, which means the `appFees` echo and other downstream
 * fields stay accurate.
 */
export function buildExactOutputDryProbe(args: {
  fromAsset: NearIntentsToken;
  toAsset: NearIntentsToken;
  destAmountAtomic: string;
  walletAddresses: WalletAddresses;
  /** How long 1Click may wait for solvers. The automatic probe uses 0 (a
   *  cheap "is there an instant answer"); MIN passes the real quote path's
   *  5 000 ms, because a single-route chain (Cardano) answers nothing in
   *  0 ms and reads as "no liquidity" at every size (2026-09-05). */
  quoteWaitingTimeMs?: number;
}): IntentsQuoteRequest {
  // 30-min deadline. Generous so the probe doesn't fail with "deadline
  // too tight" on slow proxy paths.
  const deadlineMs = Date.now() + 30 * 60 * 1000;
  const deadline = new Date(deadlineMs).toISOString();

  return {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 500, // 5% — permissive for the probe
    originAsset: args.fromAsset.assetId,
    destinationAsset: args.toAsset.assetId,
    amount: args.destAmountAtomic,
    depositType: "ORIGIN_CHAIN",
    recipientType: "DESTINATION_CHAIN",
    refundType: "ORIGIN_CHAIN",
    recipient: addressForAssetId(args.toAsset.assetId, args.walletAddresses),
    refundTo: addressForAssetId(args.fromAsset.assetId, args.walletAddresses),
    deadline,
    quoteWaitingTimeMs: args.quoteWaitingTimeMs ?? 0,
  };
}

export interface ProbeResult {
  /** Atomic-units string of the source asset — what the user must send. */
  minAtomicIn: string;
  /** USD value of the destination amount that yielded this minimum. */
  expectedAmountOutUsd?: string;
  /** How many quote calls were used. 1 in the best case (first probe
   *  accepted), 2 in the typical case (first probe rejected, parsed-N
   *  bonus probe accepted), up to 4 for stubborn pairs. */
  probesUsed: number;
}

/** Bound for `probeExactInputFallback` — kept small since it's a secondary
 *  mechanism layered on top of the primary EXACT_OUTPUT probe above. */
const MAX_FALLBACK_PROBES = 2;

/**
 * Build a `dry: true, EXACT_INPUT` quote request body — the fallback probe
 * shape used by `probeExactInputFallback` below.
 */
export function buildExactInputDryProbe(args: {
  fromAsset: NearIntentsToken;
  toAsset: NearIntentsToken;
  sourceAmountAtomic: string;
  walletAddresses: WalletAddresses;
  /** See `buildExactOutputDryProbe`. */
  quoteWaitingTimeMs?: number;
}): IntentsQuoteRequest {
  const deadlineMs = Date.now() + 30 * 60 * 1000;
  const deadline = new Date(deadlineMs).toISOString();

  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 500,
    originAsset: args.fromAsset.assetId,
    destinationAsset: args.toAsset.assetId,
    amount: args.sourceAmountAtomic,
    depositType: "ORIGIN_CHAIN",
    recipientType: "DESTINATION_CHAIN",
    refundType: "ORIGIN_CHAIN",
    recipient: addressForAssetId(args.toAsset.assetId, args.walletAddresses),
    refundTo: addressForAssetId(args.fromAsset.assetId, args.walletAddresses),
    deadline,
    quoteWaitingTimeMs: args.quoteWaitingTimeMs ?? 0,
  };
}

/**
 * Fallback probe for pairs where the primary EXACT_OUTPUT probe (above)
 * comes back with a generic, unparseable rejection instead of the specific
 * "try at least N" shape.
 *
 * Confirmed live 2026-07-01 against `https://1click.chaindefuser.com`: a
 * dry EXACT_OUTPUT probe for POL → BTC (POL's asset id is now the HOT
 * Omni-Bridge `nep245:v2_1.omni.hot.tg:...` shape, not the older `nep141:
 * ...omft.near` OMFT shape the primary probe was built and tested against)
 * returns `{"message":"Failed to get quote"}` — no digits, doesn't match
 * `parseMinAtomicFromUpstreamError`'s regex. The SAME pair asked via a dry
 * EXACT_INPUT quote returns `{"message":"Amount is too low for bridge, try
 * at least 74818831572074059154"}` — the specific, parseable shape. This
 * is exactly the gap that made the swap form's minimum hint only ever
 * appear reactively (after the user types an amount and a real EXACT_INPUT
 * quote gets rejected) instead of proactively, for any pair on this newer
 * bridge family.
 *
 * Strategy: ascend a small source-asset USD schedule with dry EXACT_INPUT
 * probes. The first response that:
 *   - rejects with a parseable atomic integer → that integer IS 1Click's
 *     own floor, echoed verbatim; cache + return it, exactly like the
 *     reactive parser would have (just proactively, before typing).
 *   - succeeds (200) → the floor is at or below this cheap probe amount.
 *     Not precise enough to display as "the minimum" (a success doesn't
 *     say how much lower it could go); treat as "no floor worth flagging"
 *     rather than guess. Same graceful-degradation philosophy as the
 *     primary probe running out — the reactive parser is still there as
 *     the final backstop.
 *
 * Bounded at `MAX_FALLBACK_PROBES` (2) — this only runs after the primary
 * probe already spent up to 4 calls, so keep the extra proxy load small.
 * Call ONLY when `probePerPairMinimum` has already returned null.
 */
export async function probeExactInputFallback(args: {
  fromAsset: NearIntentsToken;
  toAsset: NearIntentsToken;
  walletAddresses: WalletAddresses;
  /** Override the USD schedule for tests. Production reads from env. */
  scheduleOverride?: number[];
  /** Override the quote caller for tests. */
  quoteFn?: (req: IntentsQuoteRequest) => Promise<IntentsQuoteResponse>;
  quoteWaitingTimeMs?: number;
}): Promise<ProbeResult | null> {
  const schedule =
    args.scheduleOverride ?? readScheduleEnv() ?? DEFAULT_SCHEDULE_USD;
  const quoteFn = args.quoteFn ?? getIntentsQuote;

  let probesUsed = 0;
  for (const usd of schedule) {
    if (probesUsed >= MAX_FALLBACK_PROBES) break;
    const sourceAmountAtomic = dollarAmountAtomic(args.fromAsset, usd);
    if (sourceAmountAtomic === "0") continue; // price unavailable, skip this rung

    const body = buildExactInputDryProbe({
      fromAsset: args.fromAsset,
      toAsset: args.toAsset,
      sourceAmountAtomic,
      walletAddresses: args.walletAddresses,
      quoteWaitingTimeMs: args.quoteWaitingTimeMs,
    });
    probesUsed++;

    let errorMessage: string | null = null;
    try {
      await quoteFn(body);
      // Succeeded at a cheap probe amount — the floor is at/below this
      // level. Nothing precise to show; let the swap proceed unhinted.
      return null;
    } catch (e) {
      errorMessage = (e as Error)?.message ?? String(e);
    }

    const parsed = parseMinAtomicFromUpstreamError(errorMessage);
    if (parsed) {
      setPairMinimum(args.fromAsset.assetId, args.toAsset.assetId, parsed, {
        source: "probe",
      });
      return { minAtomicIn: parsed, probesUsed };
    }
    // No atomic floor in the message. It may still name a DOLLAR one, which
    // is what the HOT Omni Bridge assets answer with (2026-09-09). Learning
    // it here is what makes the hint appear on pair selection instead of
    // after the user types an amount and watches a quote get refused.
    const usdLearned = learnUsdLimitFromError({
      message: errorMessage,
      fromAsset: args.fromAsset,
      toAsset: args.toAsset,
    });
    if (usdLearned) return { minAtomicIn: usdLearned, probesUsed };
    // Unparseable rejection at this level — try the next rung, if any.
  }
  return null;
}

/**
 * Adaptive descending EXACT_OUTPUT probe.
 *
 * Returns the per-pair minimum input amount on success, null when all
 * probes exhausted. Calls `setPairMinimum` on success — caller doesn't
 * need to wire that separately.
 */
export async function probePerPairMinimum(args: {
  fromAsset: NearIntentsToken;
  toAsset: NearIntentsToken;
  walletAddresses: WalletAddresses;
  /** Override the USD schedule for tests. Production reads from env. */
  scheduleOverride?: number[];
  /** Override the quote caller for tests. */
  quoteFn?: (req: IntentsQuoteRequest) => Promise<IntentsQuoteResponse>;
  quoteWaitingTimeMs?: number;
}): Promise<ProbeResult | null> {
  const schedule =
    args.scheduleOverride ?? readScheduleEnv() ?? DEFAULT_SCHEDULE_USD;
  const quoteFn = args.quoteFn ?? getIntentsQuote;

  let bonusProbeAmount: string | null = null;
  let probesUsed = 0;
  let scheduleIndex = 0;

  while (probesUsed < MAX_PROBES) {
    // Pick the amount: bonus first (consumed), else next scheduled USD.
    let destAmountAtomic: string;
    if (bonusProbeAmount !== null) {
      destAmountAtomic = bonusProbeAmount;
      bonusProbeAmount = null;
    } else {
      if (scheduleIndex >= schedule.length) break;
      destAmountAtomic = dollarAmountAtomic(
        args.toAsset,
        schedule[scheduleIndex],
      );
      scheduleIndex++;
      if (destAmountAtomic === "0") {
        // Skip schedule entries we can't compute (price unavailable).
        // Don't count toward probesUsed.
        continue;
      }
    }

    const body = buildExactOutputDryProbe({
      fromAsset: args.fromAsset,
      toAsset: args.toAsset,
      destAmountAtomic,
      walletAddresses: args.walletAddresses,
      quoteWaitingTimeMs: args.quoteWaitingTimeMs,
    });
    probesUsed++;

    let resp: IntentsQuoteResponse | null = null;
    let errorMessage: string | null = null;
    try {
      resp = await quoteFn(body);
    } catch (e) {
      errorMessage = (e as Error)?.message ?? String(e);
    }

    if (resp?.quote?.minAmountIn) {
      // Probe accepted. Cache + return.
      const result: ProbeResult = {
        minAtomicIn: resp.quote.minAmountIn,
        probesUsed,
      };
      if (resp.quote.amountOutUsd) {
        result.expectedAmountOutUsd = resp.quote.amountOutUsd;
      }
      setPairMinimum(
        args.fromAsset.assetId,
        args.toAsset.assetId,
        resp.quote.minAmountIn,
        {
          source: "probe",
          ...(resp.quote.amountOutUsd
            ? { expectedAmountOutUsd: resp.quote.amountOutUsd }
            : {}),
        },
      );
      return result;
    }

    // Probe rejected. Try to parse a bridge minimum out of the message
    // ("Amount is too low for bridge, try at least N") so the next
    // iteration probes at the actual floor instead of the next
    // scheduled USD level. parseMinAtomicFromUpstreamError already
    // covers the four shapes 1Click uses.
    if (errorMessage && bonusProbeAmount === null) {
      const parsed = parseMinAtomicFromUpstreamError(errorMessage);
      if (parsed) bonusProbeAmount = parsed;
    }
  }

  // All probes exhausted. The caller's existing reactive parser still
  // catches the eventual real-quote rejection. Don't return a partial
  // result — null preserves the contract that on success we return a
  // valid input minimum, and on failure the form falls back to the
  // existing UX.
  return null;
}

/** Re-export for convenience so call sites importing from one file can
 *  read the cache entry shape. */
export type { PairMinEntry };

// ===========================================================================
// The floor probe (2026-09-05) — ONE call, because 1Click will just say
// ===========================================================================

/**
 * Where the ladder starts, in USD of the SOURCE asset.
 *
 * Measured against the live API on 2026-09-05: every pair tried had a floor
 * near $7 (ADA→BTC $6.99, ETH→BTC $6.98, BTC→ADA $6.61, BTC→ETH $6.61), which
 * is what a fixed bridge cost looks like. $1 therefore lands in the
 * "too low" band for most pairs on the FIRST call — and the too-low answer is
 * the one that names the number.
 */
export const FLOOR_PROBE_START_USD = 1;

/** Step factor when the first size guesses wrong, in either direction. */
export const FLOOR_PROBE_STEP = 5;

/** Hard bound on calls. Typical case is 1. */
export const FLOOR_PROBE_MAX_CALLS = 4;

/**
 * Solver wait for a floor probe: **zero**.
 *
 * Measured 2026-09-05, twelve dry quotes per setting, ADA → BTC above the
 * floor: `wait=0` median 0.51 s (11/12 quoted), `wait=5000` median 5.18 s
 * (12/12). The parameter is a floor on latency, not a timeout — five seconds
 * is charged on every call, success or failure. A probe's useful answer is a
 * REJECTION, which arrives in ~0.78 s regardless, so waiting buys nothing.
 *
 * The REAL quote still asks for 5 000 ms: there the extra reliability is worth
 * the wait, because the user is about to commit to the number.
 */
export const FLOOR_PROBE_WAIT_MS = 0;

/**
 * Ask 1Click for a pair's minimum by deliberately asking for too little.
 *
 * # Why this replaces a nineteen-probe search
 *
 * A dry `EXACT_INPUT` quote below the routable floor does not fail vaguely —
 * it answers with the floor, verbatim:
 *
 * ```
 * {"message":"Amount is too low for bridge, try at least 32420080"}
 * ```
 *
 * So the minimum is a **single round trip**, not a search. Measured live on
 * 2026-09-05, twelve runs, ADA → BTC: median **0.78 s**, every run naming the
 * same floor to within 0.02 ADA (the jitter is the price moving). Six
 * different pairs asked concurrently: **0.78 s wall clock** for all six.
 *
 * What it replaces: two USD schedules plus a nine-step bisection, up to
 * nineteen sequential quotes, each carrying a five-second solver wait — about
 * a hundred seconds of a button that looks broken. That is the "MIN is slow or
 * doesn't respond" the operator reported, and it was self-inflicted (see
 * {@link MIN_BUTTON_QUOTE_WAIT_MS}).
 *
 * # Why `quoteWaitingTimeMs: 0`
 *
 * It is a **floor on latency, not a timeout**. Twelve runs above the floor:
 * `wait=0` → median 0.51 s, 11/12 quoted; `wait=5000` → median 5.18 s, 12/12.
 * Five seconds buys one retry's worth of reliability and costs 4.7 s on every
 * call. For a probe whose useful answer is a REJECTION, it buys nothing at all.
 *
 * # The three answers, and what each means
 *
 * | reply | meaning | move |
 * |---|---|---|
 * | `try at least N` | N **is** the floor | done, cache it |
 * | a quote | the floor is below this size | divide by {@link FLOOR_PROBE_STEP}, remember this size as a known-good upper bound |
 * | anything else (`Failed to get quote`, `No liquidity available`) | too small to route at all — at 1 atomic unit every pair answers this | multiply by {@link FLOOR_PROBE_STEP} |
 *
 * Returns the named floor, or — for a pair whose floor is below the smallest
 * size tried — the smallest amount that actually quoted, which is a true upper
 * bound and safe to put in the field. Null only when nothing was learned.
 *
 * `seedAtomic` covers a source asset with no `price` in the token list: the
 * caller passes a size known to route (the live quote's amount, or the
 * balance) and the ladder starts a thousandth of the way down it.
 */
export async function probePairFloor(args: {
  fromAsset: NearIntentsToken;
  toAsset: NearIntentsToken;
  walletAddresses: WalletAddresses;
  /** A size known to quote, for a source asset with no listed price. */
  seedAtomic?: string;
  startUsd?: number;
  maxCalls?: number;
  quoteFn?: (req: IntentsQuoteRequest) => Promise<IntentsQuoteResponse>;
  /** Reports the last upstream message when nothing was learned, so the
   *  caller can show what the venue actually said instead of inventing a
   *  sentence about liquidity. */
  onError?: (message: string) => void;
}): Promise<ProbeResult | null> {
  const quoteFn = args.quoteFn ?? getIntentsQuote;
  const maxCalls = args.maxCalls ?? FLOOR_PROBE_MAX_CALLS;
  const startUsd = args.startUsd ?? FLOOR_PROBE_START_USD;

  let size: bigint;
  const priced = dollarAmountAtomic(args.fromAsset, startUsd);
  if (priced !== "0") {
    size = BigInt(priced);
  } else if (args.seedAtomic && BigInt(args.seedAtomic) > 0n) {
    // No price for this asset: start a thousandth of the way down a size the
    // caller knows routes. The ladder converges from there.
    size = BigInt(args.seedAtomic) / 1000n;
  } else {
    return null;
  }
  if (size <= 0n) size = 1n;

  let smallestThatQuoted: bigint | null = null;
  let lastMessage = "";
  let probesUsed = 0;

  for (let i = 0; i < maxCalls; i++) {
    // Built OUTSIDE the try on purpose. `addressForAssetId` throws when a
    // chain's address is missing, and that sentence must never reach the
    // minimum parser: the ADA one mentions "CIP-1852", which was read as a
    // floor of 1852 atomic units (2026-09-05). A request we cannot even build
    // is a local fault, and there is nothing to learn from repeating it.
    let body: IntentsQuoteRequest;
    try {
      body = buildExactInputDryProbe({
        fromAsset: args.fromAsset,
        toAsset: args.toAsset,
        sourceAmountAtomic: size.toString(),
        walletAddresses: args.walletAddresses,
        quoteWaitingTimeMs: FLOOR_PROBE_WAIT_MS,
      });
    } catch (e) {
      args.onError?.((e as Error)?.message ?? String(e));
      return null;
    }
    probesUsed++;
    try {
      await quoteFn(body);
      // Routed: the floor is at or below this. Keep it as the best known
      // fillable size and look lower.
      smallestThatQuoted = size;
      const next = size / BigInt(FLOOR_PROBE_STEP);
      if (next <= 0n) break;
      size = next;
      continue;
    } catch (e) {
      lastMessage = (e as Error)?.message ?? String(e);
      const parsed = parseMinAtomicFromUpstreamError(lastMessage);
      if (parsed) {
        setPairMinimum(args.fromAsset.assetId, args.toAsset.assetId, parsed, {
          source: "upstream-error",
        });
        return { minAtomicIn: parsed, probesUsed };
      }
      // A dollar floor names the answer outright, so climbing the ladder can
      // only rediscover it one call at a time. Take it and stop: on the HOT
      // Omni Bridge assets the floor sits near $1,000 and this ladder starts
      // three orders of magnitude below it.
      const usdLearned = learnUsdLimitFromError({
        message: lastMessage,
        fromAsset: args.fromAsset,
        toAsset: args.toAsset,
      });
      if (usdLearned) return { minAtomicIn: usdLearned, probesUsed };
      // Unparseable: too small to route at all (every pair answers this at one
      // atomic unit). Ask for more.
      size *= BigInt(FLOOR_PROBE_STEP);
    }
  }

  if (smallestThatQuoted !== null) {
    const atomic = smallestThatQuoted.toString();
    setPairMinimum(args.fromAsset.assetId, args.toAsset.assetId, atomic, {
      source: "probe",
    });
    return { minAtomicIn: atomic, probesUsed };
  }
  if (lastMessage) args.onError?.(lastMessage);
  return null;
}

/** Probes spent by [`bisectExactInputMinimum`] at most (one dry quote each). */
export const MAX_BISECT_PROBES = 9;

/**
 * Find NEAR's minimum for a pair WITHOUT a price: bisect the source amount
 * between 0 and a size known (or believed) to quote, with dry EXACT_INPUT
 * quotes (2026-09-05).
 *
 * Why it exists: both probes above size their rungs in USD through
 * `dollarAmountAtomic`, which needs `token.price` from the NEAR tokens list.
 * ADA has no price there, so every rung came back "0" and was skipped — the
 * probe "ran", found nothing, and MIN told the operator NEAR had no fillable
 * size for ADA → BTC while a 1 060 ADA quote was live on the same screen. A
 * bisection needs only an upper bound in the coin's own units; the form
 * passes the quoted amount, or the wallet balance.
 *
 * Returns the smallest amount that quoted (or a minimum the upstream error
 * named, which is exact). Null when even `hiAtomic` does not quote — then
 * there is genuinely no route at that size and MIN cannot help.
 */
export async function bisectExactInputMinimum(args: {
  fromAsset: NearIntentsToken;
  toAsset: NearIntentsToken;
  walletAddresses: WalletAddresses;
  hiAtomic: string;
  quoteFn?: (req: IntentsQuoteRequest) => Promise<IntentsQuoteResponse>;
  maxProbes?: number;
  quoteWaitingTimeMs?: number;
  /** The last upstream error, verbatim — so a failed search can say what NEAR
   *  said instead of "no route". */
  onError?: (message: string) => void;
}): Promise<ProbeResult | null> {
  const quoteFn = args.quoteFn ?? getIntentsQuote;
  const maxProbes = args.maxProbes ?? MAX_BISECT_PROBES;
  let hi = BigInt(args.hiAtomic);
  if (hi <= 0n) return null;
  let lo = 0n;
  let probesUsed = 0;
  const tryAmount = async (amount: bigint): Promise<true | string> => {
    probesUsed++;
    try {
      await quoteFn(
        buildExactInputDryProbe({
          fromAsset: args.fromAsset,
          toAsset: args.toAsset,
          sourceAmountAtomic: amount.toString(),
          walletAddresses: args.walletAddresses,
          quoteWaitingTimeMs: args.quoteWaitingTimeMs,
        }),
      );
      return true;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      args.onError?.(msg);
      return msg;
    }
  };
  const first = await tryAmount(hi);
  if (first !== true) {
    const parsed = parseMinAtomicFromUpstreamError(first);
    if (parsed) {
      setPairMinimum(args.fromAsset.assetId, args.toAsset.assetId, parsed, { source: "probe" });
      return { minAtomicIn: parsed, probesUsed };
    }
    // A dollar denominated limit refuses every rung a bisection could try,
    // so there is nothing to bisect: convert it and stop. Without this the
    // whole ladder burns its probe budget re-reading the same sentence.
    const usdLearned = learnUsdLimitFromError({
      message: first,
      fromAsset: args.fromAsset,
      toAsset: args.toAsset,
    });
    if (usdLearned) return { minAtomicIn: usdLearned, probesUsed };
    return null;
  }
  while (probesUsed < maxProbes && hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const r = await tryAmount(mid);
    if (r === true) {
      hi = mid;
    } else {
      const parsed = parseMinAtomicFromUpstreamError(r);
      if (parsed) {
        setPairMinimum(args.fromAsset.assetId, args.toAsset.assetId, parsed, { source: "probe" });
        return { minAtomicIn: parsed, probesUsed };
      }
      lo = mid;
    }
  }
  const min = hi.toString();
  setPairMinimum(args.fromAsset.assetId, args.toAsset.assetId, min, { source: "probe" });
  return { minAtomicIn: min, probesUsed };
}
