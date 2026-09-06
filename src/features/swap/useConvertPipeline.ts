/**
 * src/features/swap/useConvertPipeline.ts
 *
 * "Mine XMR, receive Y" — the two-hop convert pipeline behind the landscape
 * EARN tab (canvas frame 1d) and the portrait CONVERT mode (frame 1e).
 *
 * # One hook, two surfaces
 *
 * The handoff is explicit that these are two renderings of one pipeline, not
 * two pipelines: "Same pipeline handlers as workstream 3 — one shared hook,
 * two surface renderings. Do not fork the logic." This is that hook. Both
 * surfaces read the same state and call the same handlers; neither owns any
 * step of the conversion.
 *
 * # Why the state lives above the views
 *
 * Hop 1 is a peer-to-peer atomic swap: 30–90 minutes, surviving tab changes
 * and app restarts. `SwapView` and the EARN view both unmount on every
 * navigation, so pipeline state cannot live in either. This hook is owned by
 * `App.tsx` alongside `useSidecarSwap` and `useDeskTracker`, for exactly the
 * reason those two are — and it delegates the actual swap tracking TO
 * `useSidecarSwap` rather than re-tracking anything itself.
 *
 * # Manual only, by design
 *
 * There is no auto-fire and no threshold. `beginHop1` opens the normal P2P
 * review; when that swap reaches a terminal success the hook moves to
 * `hop2-ready` and waits. `beginHop2` seeds the ordinary NEAR Intents form
 * and the user confirms a second time, at a rate they can see. Two hops, two
 * confirmations, no step that fires on its own — the decision recorded on the
 * canvas ("manual CONVERT only") and the only shape compatible with this
 * repo's rule that a funds-moving action is always the operator's.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SidecarSwapState, SidecarTrackedSwap } from "../swap-sidecar";
import {
  recordConversionStarted,
  updateConversion,
} from "./convert-history";

/** The coin every conversion routes through. */
export const CONVERT_ROUTE_HOP = "LTC";

/** The coin hop 1 spends. */
export const CONVERT_SOURCE = "XMR";

/** Targets the mock surfaces directly; everything else is behind "+ N more". */
export const CONVERT_QUICK_TARGETS = ["BTC", "ETH", "SOL"] as const;

const TARGET_STORAGE_KEY = "pwnda.convert.target";
const HOP1_STORAGE_KEY = "pwnda.convert.hop1BidId";

/**
 * Where a conversion is.
 *
 * `hop2-ready` is a real resting state, not a transient: hop 1 has settled,
 * the LTC is in the wallet, and nothing else happens until the user asks for
 * it. A pipeline that auto-advanced here would be firing a swap the user has
 * not seen a rate for.
 */
/** The subset of a submitted P2P swap the pipeline needs to adopt it. */
export interface SidecarSwapHandleLike {
  bidId: string;
  sendCoin: string;
  receiveCoin: string;
  sendAmount: string;
  receiveAmount: string;
}

export type ConvertStage =
  | "idle"
  | "hop1-running"
  | "hop2-ready"
  | "hop2-running"
  | "failed";

export interface ConvertPipelineState {
  /** Ticker the user wants to end up holding. Persisted. */
  targetCoin: string;
  setTargetCoin: (ticker: string) => void;

  stage: ConvertStage;
  /** The live hop-1 swap, when there is one. */
  hop1: SidecarTrackedSwap | null;
  /** LTC amount hop 1 produced — the input to hop 2. */
  hop2InputAmount: string | null;

  /**
   * True when hop 1 ended in a way that is not "settled": refunded,
   * cancelled, or recovered by the counterparty. Those are NORMAL outcomes of
   * this protocol, not errors, so they get their own flag rather than being
   * folded into `failed`.
   */
  hop1Unwound: boolean;

  /** Open the P2P review for XMR -> LTC. The caller supplies the opener. */
  beginHop1: () => void;
  /** Seed the aggregator form with LTC -> target and let the user confirm. */
  beginHop2: () => void;
  /** Drop pipeline state back to idle (after a settle, or a user dismiss). */
  reset: () => void;
}

export interface ConvertPipelineArgs {
  enabled: boolean;
  /** The live P2P tracker — the pipeline reads hop 1's progress from it. */
  sidecar: SidecarSwapState | null;
  /**
   * Puts the swap surface into "P2P, XMR -> LTC, this amount" and opens the
   * review. Supplied by the surface because seeding the form is a view
   * concern; the hook owns WHEN, not HOW.
   */
  onSeedHop1: (amount: string) => void;
  /** Same, for the NEAR Intents leg: LTC -> target, with hop 1's output. */
  onSeedHop2: (amount: string, target: string) => void;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled — the pipeline still works this session */
  }
}

/**
 * Terminal classifications, split by what they mean for the pipeline.
 *
 * Mirrors `swap-sidecar/bidStates.ts`. `done` is the only one that produces
 * LTC to convert; the unwound three return the funds and end the pipeline
 * without an error, which is what the refund copy has always promised.
 */
const HOP1_SETTLED = "done";
const HOP1_UNWOUND = new Set([
  "refunded",
  "cancelled",
  "counterparty-recovered",
]);

export function useConvertPipeline({
  enabled,
  sidecar,
  onSeedHop1,
  onSeedHop2,
}: ConvertPipelineArgs): ConvertPipelineState {
  const [targetCoin, setTargetCoinRaw] = useState<string>(
    () => readStored(TARGET_STORAGE_KEY) ?? "BTC",
  );
  const [hop1BidId, setHop1BidId] = useState<string | null>(() =>
    readStored(HOP1_STORAGE_KEY),
  );
  const [stage, setStage] = useState<ConvertStage>("idle");
  const [hop2InputAmount, setHop2InputAmount] = useState<string | null>(null);
  const [hop1Unwound, setHop1Unwound] = useState(false);

  const setTargetCoin = useCallback((ticker: string) => {
    const t = ticker.toUpperCase();
    setTargetCoinRaw(t);
    writeStored(TARGET_STORAGE_KEY, t);
  }, []);

  /**
   * The hop-1 swap, looked up in the tracker by id.
   *
   * Deliberately a LOOKUP rather than a copy: `useSidecarSwap` already
   * rehydrates non-terminal bids on relaunch, so a pipeline that stored its
   * own copy of the swap would have two sources of truth for one bid and
   * would go stale the moment the tracker polled. Storing only the id means
   * a restart mid-hop-1 finds the swap again for free.
   */
  const hop1 = useMemo(() => {
    if (!hop1BidId || !sidecar) return null;
    return sidecar.swaps.find((s) => s.bidId === hop1BidId) ?? null;
  }, [hop1BidId, sidecar]);

  /** Advance the stage from hop 1's own state machine. */
  useEffect(() => {
    if (!enabled || !hop1BidId) return;
    if (!hop1) {
      // The tracker has not adopted it yet (or has dropped it after a
      // terminal read). Leave the stage alone rather than guessing.
      return;
    }
    const cls = hop1.stage?.stage ?? null;
    if (cls === HOP1_SETTLED) {
      setHop2InputAmount(hop1.receiveAmount);
      setHop1Unwound(false);
      setStage("hop2-ready");
      updateConversion(hop1.bidId, { viaAmount: hop1.receiveAmount });
      return;
    }
    if (cls && HOP1_UNWOUND.has(cls)) {
      setHop1Unwound(true);
      setStage("idle");
      setHop1BidId(null);
      writeStored(HOP1_STORAGE_KEY, null);
      updateConversion(hop1.bidId, { status: "unwound" });
      return;
    }
    setStage("hop1-running");
  }, [enabled, hop1, hop1BidId]);

  const beginHop1 = useCallback(() => {
    setHop1Unwound(false);
    // The amount is the caller's business (it is the XMR balance it renders);
    // passing "" asks the surface to seed with everything available.
    onSeedHop1("");
  }, [onSeedHop1]);

  const beginHop2 = useCallback(() => {
    if (!hop2InputAmount) return;
    setStage("hop2-running");
    // The pipeline's work ends when hop 2 is handed to the swap form: the
    // NEAR leg then has its own confirm + Activity entry, and claiming an
    // outcome here would be asserting something this hook cannot observe.
    if (hop1BidId) updateConversion(hop1BidId, { status: "done" });
    onSeedHop2(hop2InputAmount, targetCoin);
  }, [hop2InputAmount, onSeedHop2, targetCoin, hop1BidId]);

  const reset = useCallback(() => {
    setStage("idle");
    setHop1BidId(null);
    setHop2InputAmount(null);
    setHop1Unwound(false);
    writeStored(HOP1_STORAGE_KEY, null);
  }, []);

  /**
   * Adopt a freshly-submitted P2P swap as hop 1.
   *
   * Exposed through the returned object's identity rather than as a separate
   * export so the surface that submits the bid (the P2P confirm modal's
   * `onSidecarSwapAccepted`) can hand it straight over.
   */
  const adoptHop1 = useCallback(
    (handle: {
      bidId: string;
      sendCoin: string;
      receiveCoin: string;
      sendAmount: string;
      receiveAmount: string;
    }) => {
      setHop1BidId(handle.bidId);
      writeStored(HOP1_STORAGE_KEY, handle.bidId);
      setStage("hop1-running");
      recordConversionStarted({
        id: handle.bidId,
        fromTicker: handle.sendCoin,
        viaTicker: handle.receiveCoin,
        toTicker: targetCoin,
        fromAmount: handle.sendAmount,
        viaAmount: "",
        toAmount: "",
        startedAt: Date.now(),
        status: "running",
      });
    },
    [targetCoin],
  );

  return useMemo(
    () => ({
      targetCoin,
      setTargetCoin,
      stage,
      hop1,
      hop2InputAmount,
      hop1Unwound,
      beginHop1,
      beginHop2,
      reset,
      // Not in the public interface above because only App.tsx's wiring calls
      // it; typed via the cast at the call site.
      adoptHop1,
    }) as ConvertPipelineState & { adoptHop1: (handle: SidecarSwapHandleLike) => void },
    [
      targetCoin,
      setTargetCoin,
      stage,
      hop1,
      hop2InputAmount,
      hop1Unwound,
      beginHop1,
      beginHop2,
      reset,
      adoptHop1,
    ],
  );
}

/**
 * Projected output of the whole pipeline, in target-coin units.
 *
 * Fees are applied as the canvas states them: ~1% on the P2P leg, ~0.3% on
 * the NEAR leg. Both are ADVISORY — the real numbers come from each hop's own
 * quote, which the user confirms before it fires. This projection exists to
 * answer "roughly what do I end up with", and every surface that renders it
 * labels it with a `≈`.
 */
export const P2P_FEE_FRACTION = 0.01;
export const NEAR_FEE_FRACTION = 0.003;

export function projectConversion(args: {
  sourceAmount: number;
  /** USD price of XMR. */
  sourcePriceUsd: number | null;
  /** USD price of the target coin. */
  targetPriceUsd: number | null;
  /** True when the target IS the route hop, so there is no second leg. */
  singleHop: boolean;
}): { targetAmount: number | null; usdAfterFees: number | null } {
  const { sourceAmount, sourcePriceUsd, targetPriceUsd, singleHop } = args;
  if (
    !Number.isFinite(sourceAmount) ||
    sourceAmount <= 0 ||
    sourcePriceUsd == null ||
    targetPriceUsd == null ||
    targetPriceUsd <= 0
  ) {
    return { targetAmount: null, usdAfterFees: null };
  }
  const grossUsd = sourceAmount * sourcePriceUsd;
  const afterP2p = grossUsd * (1 - P2P_FEE_FRACTION);
  const usdAfterFees = singleHop ? afterP2p : afterP2p * (1 - NEAR_FEE_FRACTION);
  return { targetAmount: usdAfterFees / targetPriceUsd, usdAfterFees };
}
