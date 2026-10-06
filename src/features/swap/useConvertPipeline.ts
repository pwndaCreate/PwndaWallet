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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AutoRebidOutcome,
  BidStage,
  SidecarSwapState,
  SidecarTrackedSwap,
} from "../swap-sidecar";
import {
  feeBearingPurchase,
  LICENCE_FEE_FRACTION,
  stageForBidState,
  tickerForCoin,
} from "../swap-sidecar";
import {
  followConversionRebid,
  recordConversionStarted,
  updateConversion,
  type ConversionRecord,
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
   * Where hop 1 paid that LTC ({@link hop1PaidTo}): `"address"`, this
   * wallet's LTC address, the one on hop 1's confirm screen; `"node-wallet"`,
   * the swap node's own LTC wallet. Since 2026-10-06 hop 1 is a purchase the
   * licence fee is charged on (XMR -> LTC), so its LTC stays in the node's
   * wallet for the fee. Where that leads is {@link hop2Next}.
   */
  hop2PaidTo: "address" | "node-wallet" | null;
  /**
   * What a settled hop 1 leads to ({@link afterHop1}): `"hop2"` seeds the NEAR
   * Intents form, `"finish"` ends the conversion at LTC. Null before hop 1
   * settles.
   */
  hop2Next: "hop2" | "finish" | null;

  /**
   * True when hop 1 ended in a way that is not "settled": refunded,
   * cancelled with no automatic re-bid following it, or recovered by the
   * counterparty. Those are NORMAL outcomes of this protocol, not errors, so
   * they get their own flag rather than being folded into `failed`.
   */
  hop1Unwound: boolean;

  /** Open the P2P review for XMR -> LTC. The caller supplies the opener. */
  beginHop1: () => void;
  /** Seed the aggregator form with LTC -> target and let the user confirm.
   *  Does nothing when {@link hop2Next} is not `"hop2"`. */
  beginHop2: () => void;
  /** End a conversion at LTC whose hop 1 paid the swap node's wallet: logs
   *  where it ended and returns to idle (2026-10-06). */
  finishAtRouteHop: () => void;
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
  /**
   * The swap node holds this wallet's own LTC account (verified C8 sharing,
   * `useSwapAutoSetup().shared` includes `"LTC"`). LTC the node kept is then in
   * this wallet's account, and hop 2 can spend it ({@link afterHop1}).
   */
  routeHopShared?: boolean;
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
 * What each tracker stage of hop 1 means for the pipeline. A `Record` over
 * every stage, so a stage added to `bidStates.ts` fails the type check here
 * until somebody decides what it means for a conversion.
 *
 * Hop 1 sends XMR, so this node is always on its SCRIPTLESS leg; stages only
 * the scripted leg reaches are still given the reading their words state.
 *
 * - `settled`: this node holds the LTC it was buying. `done`, and since
 *   2026-10-01 `swiped` (operator request). Until then only `done` led to
 *   `hop2-ready`, so a hop 1 the timelock had paid left EARN at "SWAP IN
 *   PROGRESS…" for the session.
 * - `unwound`: hop 1 is over and produced no LTC.
 * - `unanswered`: `cancelled`, the bid ended before anything was locked. The
 *   tracker may re-bid it; {@link nextHop1Step} reads `rebids` to know.
 * - `running`: anything still moving, or that the protocol can still move.
 */
type Hop1Reading = "running" | "settled" | "unwound" | "unanswered";

const HOP1_STAGE_READING: Readonly<Record<BidStage, Hop1Reading>> = {
  requesting: "running",
  accepted: "running",
  locking: "running",
  "waiting-counterparty": "running",
  finalising: "running",
  done: "settled",
  // The scripted leg's refund, still confirming.
  refunding: "running",
  refunded: "unwound",
  // The other user's chain-A lock is unwinding; this node's XMR has not moved.
  "timelock-unwinding": "running",
  // Paid, and NOT finished: the LTC still sits on the swap's own key until the
  // node's mercy tx (or, when none is sent, its sweep) moves it into the
  // node's LTC wallet (deployed engine: with `altruistic` on, its default,
  // `createCoinALockRefundSwipeTx` pays the swap's `KA_SWIPE` key, and
  // `sendMercyTx` sets 18 once the mercy tx is out).
  "swiped-settling": "running",
  // The timelock paid this node the LTC it was buying. The engine pays it to
  // the same LTC wallet as a normal completion, at another of its addresses:
  // a completion pays the bid's pool address (`dest_af`), a swipe the
  // swap's own key and then, by the mercy tx or the sweep, a second pool
  // address (deployed `basicswap.py:7084-7092`, `:17491-17506`, `:9827-9849`).
  swiped: "settled",
  // State 36, the scripted leg's ending: the coin it was buying arrived.
  "claimed-after-swipe": "settled",
  // The other user took this side's locked coin. For hop 1 only a reading
  // with no leg says this (state 18); {@link nextHop1Step} waits for the leg.
  "counterparty-recovered": "unwound",
  recovering: "running",
  cancelled: "unanswered",
  // Not terminal: a timelock refund can still be ahead of it.
  "needs-attention": "running",
  internal: "running",
  unknown: "running",
};

/** What the pipeline does with hop 1 next. See {@link nextHop1Step}. */
export type Hop1Step =
  /** Nothing is known about hop 1 here: leave the stage alone. */
  | { kind: "unknown" }
  /** Still moving. `awaiting` names what a terminal-looking hop 1 waits on. */
  | { kind: "running"; awaiting?: "rebid" | "leg" }
  /** The LTC is in: hop 2 may start, with `viaAmount`. */
  | { kind: "settled"; viaAmount: string }
  /** Hop 1 expired unanswered and the tracker re-bid it: follow `bidId`. */
  | { kind: "follow"; bidId: string }
  /** Hop 1 ended without LTC, and no re-bid follows. */
  | { kind: "unwound" };

/**
 * Does this state read differently from the two legs (`bidStates.ts`, "A bid
 * state does NOT determine the story on its own")? Then a reading without a
 * leg is a coin flip between two stories.
 */
function readingDependsOnLeg(state: string): boolean {
  return stageForBidState(state, "scripted") !== stageForBidState(state, "scriptless");
}

/**
 * The pipeline's next step for hop 1, from what the P2P tracker holds. Pure,
 * so every hop-1 ending is pinned by a unit test (the suite runs in node,
 * with no React renderer to run the effect; until 2026-10-01 the effect
 * itself was the logic and had no test).
 *
 * - `hop1`: the tracker's entry for `hop1BidId`, or null when it holds none
 *   (not adopted yet, or dropped after it finished).
 * - `rebid`: `SidecarSwapState.rebids[hop1BidId]`. Present only once the
 *   tracker saw that bid end unanswered.
 *
 * The rules, in order:
 *
 * 1. A terminal-looking reading whose meaning depends on the leg, made without
 *    one, waits: a hop 1 picked up from `/json/active` after a restart is
 *    read with no leg, and the no-leg reading of `XMR_SWAP_FAILED_SWIPED` is
 *    `counterparty-recovered`, which would end the conversion as "unwound"
 *    one poll before the read that says this node was PAID.
 * 2. Any other reading of a hop 1 the tracker holds decides by its stage
 *    ({@link HOP1_STAGE_READING}). `settled` hands hop 2 the bid's own
 *    receive amount: the bid's record does not say what arrived (`describeBid`
 *    reports the agreed amounts, not an output value), and what arrives is
 *    the bid amount less the claim fee (`createSCLockSpendTx`: `locked_coin -
 *    pay_fee`), or after a swipe less the pre-refund, swipe and mercy fees.
 *    Hop 2's own form checks the balance, and the user confirms it.
 * 3. Hop 1 ended unanswered (or the tracker dropped it after that): follow
 *    the re-bid when one was `placed` (operator request, 2026-10-01: the
 *    pipeline said "unwound" at once while a re-bid for the same XMR ran);
 *    unwind only on `none`; while `trying`, or before the tracker has
 *    answered at all, wait.
 */
export function nextHop1Step(args: {
  hop1BidId: string;
  hop1: Pick<SidecarTrackedSwap, "bidId" | "receiveAmount" | "stage"> | null;
  rebid: AutoRebidOutcome | undefined;
}): Hop1Step {
  const { hop1BidId, hop1, rebid } = args;
  if (hop1) {
    const reading = HOP1_STAGE_READING[hop1.stage.stage];
    if (reading !== "unanswered") {
      const state = hop1.stage.state;
      if (
        reading !== "running" &&
        hop1.stage.leg === "unknown" &&
        state != null &&
        readingDependsOnLeg(state)
      ) {
        return { kind: "running", awaiting: "leg" };
      }
      if (reading === "settled") return { kind: "settled", viaAmount: hop1.receiveAmount };
      if (reading === "unwound") return { kind: "unwound" };
      return { kind: "running" };
    }
  }
  if (!rebid) return hop1 ? { kind: "running", awaiting: "rebid" } : { kind: "unknown" };
  switch (rebid.status) {
    case "trying":
      return { kind: "running", awaiting: "rebid" };
    case "placed":
      // A re-bid the node answered with the same id (the browser sandbox's
      // mock does) is already the bid the tracker holds under that id.
      return rebid.bidId === hop1BidId
        ? { kind: "running" }
        : { kind: "follow", bidId: rebid.bidId };
    case "none":
      return { kind: "unwound" };
  }
}

/**
 * Where a settled hop 1 paid its LTC (2026-10-06). The bid's own plan when this
 * session placed it (`SidecarSwapHandle.payoutTo`). Otherwise the payout rule
 * for the pair: hop 1 buys LTC with XMR, a purchase the licence fee is charged
 * on, so the bid sent no address and the LTC is in the swap node's LTC wallet
 * ({@link feeBearingPurchase}, the predicate the bid itself used). Released
 * builds before this one never sent an address at all.
 */
export function hop1PaidTo(
  bidPayoutTo: "address" | "node-wallet" | null | undefined,
): "address" | "node-wallet" | null {
  if (bidPayoutTo) return bidPayoutTo;
  return feeBearingPurchase(CONVERT_SOURCE, CONVERT_ROUTE_HOP) ? "node-wallet" : null;
}

/**
 * What a settled hop 1 leads to. Hop 2 spends LTC from this wallet's own
 * account (`sendFromAccount` gathers the whole BIP-84 account).
 *
 * - Paid to this wallet's address: hop 2.
 * - Kept by the swap node, and the node holds this wallet's own LTC account
 *   (`shared`, the default lean setup): the LTC is already in this wallet's
 *   account, so hop 2, as before 2026-10-06. The licence fee is withdrawn from
 *   the same account by the backend after the swap; {@link hop2SeedAmount}
 *   leaves room for it, so the user never handles it.
 * - Kept by a node with its own LTC wallet: the coin is not in this wallet, so
 *   the conversion ends at LTC and says where it is, rather than seed a NEAR
 *   Intents swap from an account that does not hold it.
 *
 * 2026-10-06, corrected the same day: the first version ended every
 * node-kept hop 1 at LTC ("► DONE"), which on a shared account stopped EARN
 * one step short for no reason.
 */
export function afterHop1(
  paidTo: "address" | "node-wallet" | null,
  shared = false,
): "hop2" | "finish" {
  return paidTo === "node-wallet" && !shared ? "finish" : "hop2";
}

/**
 * The LTC amount hop 2 is seeded with. Hop 1's receive amount, less the
 * licence fee when that fee is still to come out of the same LTC (kept by the
 * node: the purchase was fee-bearing). Floors to 8 decimals so the seed never
 * exceeds what will be there; hop 2's own form checks the balance, and the
 * user confirms it. Unparseable input passes through unchanged.
 */
export function hop2SeedAmount(
  viaAmount: string,
  paidTo: "address" | "node-wallet" | null,
): string {
  if (paidTo !== "node-wallet") return viaAmount;
  const n = Number(viaAmount);
  if (!Number.isFinite(n) || n <= 0) return viaAmount;
  const atoms = Math.floor(Math.round(n * 1e8) * (1 - LICENCE_FEE_FRACTION));
  const whole = Math.floor(atoms / 1e8);
  return `${whole}.${String(atoms % 1e8).padStart(8, "0")}`;
}

/**
 * Is this P2P swap the conversion's first hop: XMR sent, LTC received?
 *
 * Compares TICKERS, through `tickerForCoin`, on both sides. The handle the
 * confirm modal passes up names coins the way the swap node does, because it
 * is built from the offer (`TakerOffer.sendCoin` is the offer's `coin_to`):
 * "Monero" and "Litecoin". Only a handle rebuilt from swap history holds
 * tickers. The first version compared `sendCoin.toUpperCase()` with "XMR",
 * which "MONERO" never equals, so the pipeline never adopted a hop 1: after
 * the user confirmed the bid it stayed `idle`, logged no conversion, and hop 2
 * was unreachable (operator request, 2026-10-01).
 *
 * "Litecoin MWEB" resolves to LTC_MWEB, another coin with its own wallet, so
 * it is not the route hop.
 */
export function isConvertHop1Leg(handle: {
  sendCoin?: string | null;
  receiveCoin?: string | null;
}): boolean {
  return (
    tickerForCoin(handle.sendCoin) === CONVERT_SOURCE &&
    tickerForCoin(handle.receiveCoin) === CONVERT_ROUTE_HOP
  );
}

/** The part of App's swap-form seed that {@link shouldAdoptAsHop1} reads. */
export interface ConvertSeedLike {
  router: string;
  nonce: number;
}

/**
 * Should a P2P swap the user just placed become the pipeline's hop 1?
 *
 * App's `adoptSidecarSwap` asks this for every bid the confirm modal places;
 * the tracker adopts every bid regardless. All four must hold:
 *
 * - the pipeline is waiting for hop 1 (`idle`, or `hop1-running` as the first
 *   version allowed);
 * - the form was seeded by CONVERT (`router: "basicswap"`). A plain P2P swap
 *   the user started from the Swap tab is not a conversion;
 * - that seed has not already produced a hop 1. The seed outlives the click
 *   that made it, so without this every later XMR -> LTC bid of the session
 *   would count as a conversion too, and one placed while hop 1 runs would
 *   replace the bid the pipeline follows. One CONVERT click, one hop 1.
 *   (Dormant while the coin check below could never pass; live with the fix.)
 * - the swap is XMR -> LTC ({@link isConvertHop1Leg}).
 */
export function shouldAdoptAsHop1(args: {
  stage: ConvertStage;
  handle: { sendCoin?: string | null; receiveCoin?: string | null };
  seed: ConvertSeedLike | null | undefined;
  /** The nonce of the seed that already produced a hop 1, if one has. */
  adoptedSeedNonce: number | null;
}): boolean {
  const { stage, handle, seed, adoptedSeedNonce } = args;
  if (stage !== "idle" && stage !== "hop1-running") return false;
  if (!seed || seed.router !== "basicswap") return false;
  if (adoptedSeedNonce != null && adoptedSeedNonce === seed.nonce) return false;
  return isConvertHop1Leg(handle);
}

/** A coin as the conversion log names it: a ticker. */
function tickerOf(coin: string | null | undefined): string {
  return (tickerForCoin(coin) ?? coin ?? "").trim().toUpperCase();
}

/**
 * The conversion-log row for an adopted hop 1, with TICKERS.
 *
 * The handle names coins as the swap node does ("Monero"); the CONVERSIONS
 * list keys its coin icons and labels on tickers. Swap history's P2P rows
 * convert for the same reason (`p2p-history.ts::tickerOf`).
 */
export function hop1ConversionRecord(
  handle: SidecarSwapHandleLike,
  targetCoin: string,
  startedAt: number,
): ConversionRecord {
  return {
    id: handle.bidId,
    fromTicker: tickerOf(handle.sendCoin),
    viaTicker: tickerOf(handle.receiveCoin),
    toTicker: targetCoin,
    fromAmount: handle.sendAmount,
    viaAmount: "",
    toAmount: "",
    startedAt,
    status: "running",
  };
}

export function useConvertPipeline({
  enabled,
  sidecar,
  onSeedHop1,
  onSeedHop2,
  routeHopShared = false,
}: ConvertPipelineArgs): ConvertPipelineState {
  const [targetCoin, setTargetCoinRaw] = useState<string>(
    () => readStored(TARGET_STORAGE_KEY) ?? "BTC",
  );
  const [hop1BidId, setHop1BidId] = useState<string | null>(() =>
    readStored(HOP1_STORAGE_KEY),
  );
  const [stage, setStage] = useState<ConvertStage>("idle");
  const [hop2InputAmount, setHop2InputAmount] = useState<string | null>(null);
  const [hop2PaidTo, setHop2PaidTo] = useState<"address" | "node-wallet" | null>(null);
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

  /** What the tracker says became of hop 1's re-bid, once it ended unanswered. */
  const hop1Rebid = hop1BidId ? sidecar?.rebids?.[hop1BidId] : undefined;

  // Read inside the effect, never a dependency of it: `sidecar` is a new
  // object on every App render, and re-running the effect on each one would
  // re-apply `hop2-ready` over a `hop2-running` the user has moved on to.
  const sidecarRef = useRef(sidecar);
  sidecarRef.current = sidecar;

  /** Advance the stage from hop 1's own state machine ({@link nextHop1Step}). */
  useEffect(() => {
    if (!enabled || !hop1BidId) return;
    const step = nextHop1Step({ hop1BidId, hop1, rebid: hop1Rebid });
    switch (step.kind) {
      case "unknown":
        // The tracker has not adopted it yet (or has dropped it after a
        // terminal read). Leave the stage alone rather than guessing.
        return;
      case "settled":
        setHop2InputAmount(step.viaAmount);
        // Kept with the amount: the tracker drops a finished swap once the
        // node stops listing it, and with it the handle that says this.
        setHop2PaidTo(hop1PaidTo(hop1?.payoutTo));
        setHop1Unwound(false);
        setStage("hop2-ready");
        updateConversion(hop1BidId, { viaAmount: step.viaAmount });
        return;
      case "follow": {
        // The tracker re-bid hop 1 after it expired unanswered (operator
        // request, 2026-10-01): the same XMR, now on `step.bidId`. Follow it
        // as hop 1, under its id in storage and in the conversion log.
        const rebid = sidecarRef.current?.swaps.find((s) => s.bidId === step.bidId);
        followConversionRebid(
          hop1BidId,
          step.bidId,
          rebid?.sendAmount ? { fromAmount: rebid.sendAmount } : {},
        );
        setHop1BidId(step.bidId);
        writeStored(HOP1_STORAGE_KEY, step.bidId);
        setHop1Unwound(false);
        setStage("hop1-running");
        return;
      }
      case "unwound":
        setHop1Unwound(true);
        setStage("idle");
        setHop1BidId(null);
        writeStored(HOP1_STORAGE_KEY, null);
        updateConversion(hop1BidId, { status: "unwound" });
        return;
      case "running":
        setStage("hop1-running");
        return;
    }
  }, [enabled, hop1, hop1BidId, hop1Rebid]);

  const beginHop1 = useCallback(() => {
    setHop1Unwound(false);
    // The amount is the caller's business (it is the XMR balance it renders);
    // passing "" asks the surface to seed with everything available.
    onSeedHop1("");
  }, [onSeedHop1]);

  const hop2Next = useMemo(
    () => (stage === "hop2-ready" ? afterHop1(hop2PaidTo, routeHopShared) : null),
    [stage, hop2PaidTo, routeHopShared],
  );

  const beginHop2 = useCallback(() => {
    // Never for LTC a node with its own wallet kept ({@link afterHop1}).
    if (!hop2InputAmount || afterHop1(hop2PaidTo, routeHopShared) !== "hop2") return;
    setStage("hop2-running");
    // The pipeline's work ends when hop 2 is handed to the swap form: the
    // NEAR leg then has its own confirm + Activity entry, and claiming an
    // outcome here would be asserting something this hook cannot observe.
    if (hop1BidId) updateConversion(hop1BidId, { status: "done" });
    onSeedHop2(hop2SeedAmount(hop2InputAmount, hop2PaidTo), targetCoin);
  }, [hop2InputAmount, hop2PaidTo, routeHopShared, onSeedHop2, targetCoin, hop1BidId]);

  const reset = useCallback(() => {
    setStage("idle");
    setHop1BidId(null);
    setHop2InputAmount(null);
    setHop2PaidTo(null);
    setHop1Unwound(false);
    writeStored(HOP1_STORAGE_KEY, null);
  }, []);

  /**
   * End the conversion at LTC (2026-10-06): hop 1 settled into the swap
   * node's own LTC wallet, which the second hop cannot spend from here. The
   * log records where it ended; `reset` clears the stored hop 1, so the
   * settle effect has nothing to read again and nothing is retried.
   */
  const finishAtRouteHop = useCallback(() => {
    if (hop1BidId) {
      updateConversion(hop1BidId, {
        status: "done",
        toTicker: CONVERT_ROUTE_HOP,
        toAmount: hop2InputAmount ?? "",
      });
    }
    reset();
  }, [hop1BidId, hop2InputAmount, reset]);

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
      // Tickers, not the node's coin names (2026-10-01): this wrote
      // `handle.sendCoin` as is, which would have logged "Monero" the first
      // time a hop 1 was ever adopted.
      recordConversionStarted(hop1ConversionRecord(handle, targetCoin, Date.now()));
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
      hop2PaidTo,
      hop2Next,
      hop1Unwound,
      beginHop1,
      beginHop2,
      finishAtRouteHop,
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
      hop2PaidTo,
      hop2Next,
      hop1Unwound,
      beginHop1,
      beginHop2,
      finishAtRouteHop,
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
