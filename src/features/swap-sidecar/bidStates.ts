/**
 * BasicSwap `BidStates` → plain-language swap stages.
 *
 * A cross-chain atomic swap takes 30–90 minutes and passes through 34 distinct
 * protocol states with names like `XMR_SWAP_HAVE_SCRIPT_COIN_SPEND_TX`. Showing
 * those to a user is the same as showing nothing. This module collapses them to
 * eleven stages a person can act on, each with a label, a description and a
 * severity.
 *
 * ## The rule that is not a style choice: REFUNDS ARE NORMAL
 *
 * `XMR_SWAP_FAILED_REFUNDED`, `XMR_SWAP_NOSCRIPT_TX_RECOVERED` and
 * `XMR_SWAP_SCRIPT_TX_PREREFUND` all carry the word "failed" or "refund" in
 * their protocol names, and all three are the timelock working exactly as
 * designed: the counterparty went away, the deadline passed, the funds came
 * back. They are given severity `"normal"`, never `"attention"`, and their copy
 * never says "error".
 *
 * This is a compliance constraint, not a tone preference. Framing a refund as a
 * failure invites support pressure to "fix" it by intervening in a swap — and
 * pwnda intervening in settlement is precisely the coordinator posture the
 * product must not have. See `CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` §3.
 *
 * ## Accepting whatever the node hands you
 *
 * The API reports bid state three different ways depending on the endpoint:
 *
 * | source | value |
 * |---|---|
 * | `GET /json/bids/<id>` → `bid_state_ind` | the raw int, e.g. `17` |
 * | `GET /json/bids/<id>` → `bid_state` | upstream's human string, `"Failed, refunded"` |
 * | `GET /json/bids/<id>/states` rows | the same human string |
 *
 * The canonical enum NAME (`"XMR_SWAP_FAILED_REFUNDED"`) never appears on the
 * wire at all — it is the plan's vocabulary and this module's key.
 * {@link classifyBidState} accepts all three, so callers pass whatever field
 * they happen to hold. **Prefer `bid_state_ind`**: the human strings are
 * upstream display text and can be reworded in any release without notice.
 */

// =========================================================================
// The protocol enum
// =========================================================================

/** Every `BidStates` member, as upstream's `basicswap_util.py` defines it. */
export type BidStateName =
  | "BID_SENT"
  | "BID_RECEIVING"
  | "BID_RECEIVED"
  | "BID_RECEIVING_ACC"
  | "BID_ACCEPTED"
  | "SWAP_INITIATED"
  | "SWAP_PARTICIPATING"
  | "SWAP_COMPLETED"
  | "XMR_SWAP_SCRIPT_COIN_LOCKED"
  | "XMR_SWAP_HAVE_SCRIPT_COIN_SPEND_TX"
  | "XMR_SWAP_NOSCRIPT_COIN_LOCKED"
  | "XMR_SWAP_LOCK_RELEASED"
  | "XMR_SWAP_SCRIPT_TX_REDEEMED"
  | "XMR_SWAP_SCRIPT_TX_PREREFUND"
  | "XMR_SWAP_NOSCRIPT_TX_REDEEMED"
  | "XMR_SWAP_NOSCRIPT_TX_RECOVERED"
  | "XMR_SWAP_FAILED_REFUNDED"
  | "XMR_SWAP_FAILED_SWIPED"
  | "XMR_SWAP_FAILED"
  | "SWAP_DELAYING"
  | "SWAP_TIMEDOUT"
  | "BID_ABANDONED"
  | "BID_ERROR"
  | "BID_STALLED_FOR_TEST"
  | "BID_REJECTED"
  | "BID_STATE_UNKNOWN"
  | "XMR_SWAP_MSG_SCRIPT_LOCK_TX_SIGS"
  | "XMR_SWAP_MSG_SCRIPT_LOCK_SPEND_TX"
  | "BID_REQUEST_SENT"
  | "BID_REQUEST_ACCEPTED"
  | "BID_EXPIRED"
  | "BID_AACCEPT_DELAY"
  | "BID_AACCEPT_FAIL"
  | "CONNECT_REQ_SENT"
  // v0.18.5 — the "mercy" keyshare path. After the counterparty SWIPES (takes
  // the coin-A lock at the timelock), they may still publish a mercy tx
  // carrying the keyshare that lets the other side recover the scriptless leg
  // rather than lose it. These four refine XMR_SWAP_FAILED_SWIPED with what
  // happened to that keyshare.
  | "XMR_SWAP_FAILED_SWIPED_USED_MERCY"
  | "XMR_SWAP_FAILED_SWIPED_USING_MERCY"
  | "XMR_SWAP_FAILED_SWIPED_MERCY_UNUSED"
  | "XMR_SWAP_FAILED_SWIPED_SENDING_MERCY";

/** Name → the integer upstream puts in `bid_state_ind`. */
export const BID_STATE_IDS: Readonly<Record<BidStateName, number>> = {
  BID_SENT: 1,
  BID_RECEIVING: 2,
  BID_RECEIVED: 3,
  BID_RECEIVING_ACC: 4,
  BID_ACCEPTED: 5,
  SWAP_INITIATED: 6,
  SWAP_PARTICIPATING: 7,
  SWAP_COMPLETED: 8,
  XMR_SWAP_SCRIPT_COIN_LOCKED: 9,
  XMR_SWAP_HAVE_SCRIPT_COIN_SPEND_TX: 10,
  XMR_SWAP_NOSCRIPT_COIN_LOCKED: 11,
  XMR_SWAP_LOCK_RELEASED: 12,
  XMR_SWAP_SCRIPT_TX_REDEEMED: 13,
  XMR_SWAP_SCRIPT_TX_PREREFUND: 14,
  XMR_SWAP_NOSCRIPT_TX_REDEEMED: 15,
  XMR_SWAP_NOSCRIPT_TX_RECOVERED: 16,
  XMR_SWAP_FAILED_REFUNDED: 17,
  XMR_SWAP_FAILED_SWIPED: 18,
  XMR_SWAP_FAILED: 19,
  SWAP_DELAYING: 20,
  SWAP_TIMEDOUT: 21,
  BID_ABANDONED: 22,
  BID_ERROR: 23,
  BID_STALLED_FOR_TEST: 24,
  BID_REJECTED: 25,
  BID_STATE_UNKNOWN: 26,
  XMR_SWAP_MSG_SCRIPT_LOCK_TX_SIGS: 27,
  XMR_SWAP_MSG_SCRIPT_LOCK_SPEND_TX: 28,
  BID_REQUEST_SENT: 29,
  BID_REQUEST_ACCEPTED: 30,
  BID_EXPIRED: 31,
  BID_AACCEPT_DELAY: 32,
  BID_AACCEPT_FAIL: 33,
  CONNECT_REQ_SENT: 34,
  // 35 is deliberately absent upstream — the ids are not contiguous past 34.
  XMR_SWAP_FAILED_SWIPED_USED_MERCY: 36,
  XMR_SWAP_FAILED_SWIPED_USING_MERCY: 37,
  XMR_SWAP_FAILED_SWIPED_MERCY_UNUSED: 38,
  XMR_SWAP_FAILED_SWIPED_SENDING_MERCY: 39,
};

/**
 * Upstream's own display string for each state (`strBidState`). Kept because
 * two endpoints report *only* this — NOT because it should ever be shown: it
 * says "Failed, refunded" for an outcome we present as a normal refund.
 */
export const BID_STATE_WIRE_LABELS: Readonly<Record<BidStateName, string>> = {
  BID_SENT: "Sent",
  BID_RECEIVING: "Receiving",
  BID_RECEIVED: "Received",
  BID_RECEIVING_ACC: "Receiving accept",
  BID_ACCEPTED: "Accepted",
  SWAP_INITIATED: "Initiated",
  SWAP_PARTICIPATING: "Participating",
  SWAP_COMPLETED: "Completed",
  XMR_SWAP_SCRIPT_COIN_LOCKED: "Script coin locked",
  XMR_SWAP_HAVE_SCRIPT_COIN_SPEND_TX: "Script coin spend tx valid",
  XMR_SWAP_NOSCRIPT_COIN_LOCKED: "Scriptless coin locked",
  XMR_SWAP_LOCK_RELEASED: "Script coin lock released",
  XMR_SWAP_SCRIPT_TX_REDEEMED: "Script tx redeemed",
  XMR_SWAP_SCRIPT_TX_PREREFUND: "Script pre-refund tx in chain",
  XMR_SWAP_NOSCRIPT_TX_REDEEMED: "Scriptless tx redeemed",
  XMR_SWAP_NOSCRIPT_TX_RECOVERED: "Scriptless tx recovered",
  XMR_SWAP_FAILED_REFUNDED: "Failed, refunded",
  XMR_SWAP_FAILED_SWIPED: "Failed, swiped",
  XMR_SWAP_FAILED: "Failed",
  SWAP_DELAYING: "Delaying",
  SWAP_TIMEDOUT: "Timed-out",
  BID_ABANDONED: "Abandoned",
  BID_ERROR: "Error",
  BID_STALLED_FOR_TEST: "Stalled (debug)",
  BID_REJECTED: "Rejected",
  BID_STATE_UNKNOWN: "Unknown bid state",
  XMR_SWAP_MSG_SCRIPT_LOCK_TX_SIGS: "Exchanged script lock tx sigs msg",
  XMR_SWAP_MSG_SCRIPT_LOCK_SPEND_TX: "Exchanged script lock spend tx msg",
  BID_REQUEST_SENT: "Request sent",
  BID_REQUEST_ACCEPTED: "Request accepted",
  BID_EXPIRED: "Expired",
  BID_AACCEPT_DELAY: "Auto accept delay",
  BID_AACCEPT_FAIL: "Auto accept failed",
  CONNECT_REQ_SENT: "Connect request sent",
  XMR_SWAP_FAILED_SWIPED_USED_MERCY: "Failed, swiped, recovered",
  XMR_SWAP_FAILED_SWIPED_USING_MERCY: "Failed, swiped, recovering",
  XMR_SWAP_FAILED_SWIPED_MERCY_UNUSED: "Failed, swiped, mercy unused",
  XMR_SWAP_FAILED_SWIPED_SENDING_MERCY: "Failed, swiped, sending mercy",
};

/** Every state name, in protocol-id order. Useful for exhaustiveness tests. */
export const ALL_BID_STATE_NAMES: readonly BidStateName[] = Object.keys(
  BID_STATE_IDS,
).sort(
  (a, b) =>
    BID_STATE_IDS[a as BidStateName] - BID_STATE_IDS[b as BidStateName],
) as BidStateName[];

const ID_TO_NAME: Readonly<Record<number, BidStateName>> = (() => {
  const out: Record<number, BidStateName> = {};
  for (const name of ALL_BID_STATE_NAMES) out[BID_STATE_IDS[name]] = name;
  return out;
})();

const WIRE_LABEL_TO_NAME: Readonly<Record<string, BidStateName>> = (() => {
  const out: Record<string, BidStateName> = {};
  for (const name of ALL_BID_STATE_NAMES) {
    out[BID_STATE_WIRE_LABELS[name].toUpperCase()] = name;
  }
  return out;
})();

/** Id → name. Exported for callers holding only `bid_state_ind`. */
export const BID_STATE_NAMES = ID_TO_NAME;

// =========================================================================
// Stages
// =========================================================================

export type BidStage =
  | "requesting"
  | "accepted"
  | "locking"
  | "waiting-counterparty"
  | "finalising"
  | "done"
  | "refunded"
  | "counterparty-recovered"
  | "recovering"
  | "cancelled"
  | "needs-attention"
  | "internal"
  | "unknown";

/**
 * How loudly a stage should read.
 *
 * - `progress` — in flight, nothing to do.
 * - `success`  — the swap settled.
 * - `normal`   — an ordinary, expected non-success outcome. **Refunds live
 *                here.** Not an error, not a warning.
 * - `attention`— genuinely wants a look.
 * - `internal` — never rendered at all.
 */
export type BidSeverity =
  | "progress"
  | "success"
  | "normal"
  | "attention"
  | "internal";

export interface BidStageInfo {
  stage: BidStage;
  /** Short plain-language label — what the tracker shows as the current step. */
  label: string;
  /** One sentence of context, safe to render under the label. */
  description: string;
  severity: BidSeverity;
  /** Whether the swap can still change state. See {@link isTerminal}. */
  terminal: boolean;
  /** False for states that exist only inside the node's own bookkeeping. */
  surface: boolean;
}

export const BID_STAGES: Readonly<Record<BidStage, BidStageInfo>> = {
  requesting: {
    stage: "requesting",
    label: "Requesting the swap",
    description:
      "Your bid has been sent to the other user over the peer-to-peer network and is waiting to be picked up.",
    severity: "progress",
    terminal: false,
    surface: true,
  },
  accepted: {
    stage: "accepted",
    label: "Accepted",
    description:
      "The other user accepted your bid. Both sides are exchanging the messages that set the swap up.",
    severity: "progress",
    terminal: false,
    surface: true,
  },
  locking: {
    stage: "locking",
    label: "Locking your funds",
    description:
      "Your side of the swap is being committed on-chain. Nothing can be spent by either side until both legs are locked.",
    severity: "progress",
    terminal: false,
    surface: true,
  },
  "waiting-counterparty": {
    stage: "waiting-counterparty",
    label: "Waiting for the other user",
    description:
      "Your funds are locked and the other user's leg is confirming. If they never complete, the timelock returns your funds automatically.",
    severity: "progress",
    terminal: false,
    surface: true,
  },
  finalising: {
    stage: "finalising",
    label: "Finalising",
    description:
      "Both legs are locked and the claim transactions are going through. This is the last step.",
    severity: "progress",
    terminal: false,
    surface: true,
  },
  done: {
    stage: "done",
    label: "Done",
    description: "The swap completed and the coins you bought have arrived.",
    severity: "success",
    terminal: true,
    surface: true,
  },
  refunded: {
    stage: "refunded",
    label: "Refunded",
    description:
      "The swap did not go through, so the timelock returned your funds. This is a normal outcome, not an error — no coins were lost.",
    severity: "normal",
    terminal: true,
    surface: true,
  },
  "counterparty-recovered": {
    stage: "counterparty-recovered",
    label: "Recovered by the other user",
    description:
      "The final timelock expired and the other user took the recovery path. Nothing further will happen on this swap.",
    severity: "normal",
    terminal: true,
    surface: true,
  },
  recovering: {
    stage: "recovering",
    label: "Recovering your funds",
    description:
      "The other user took the recovery path, but they have released the key share that lets your side be recovered too. This is in progress — it is not finished, and nothing is lost yet.",
    severity: "progress",
    terminal: false,
    surface: true,
  },
  cancelled: {
    stage: "cancelled",
    label: "Cancelled",
    description:
      "The swap ended before any funds were committed — it was abandoned, rejected, or it expired.",
    severity: "normal",
    terminal: true,
    surface: true,
  },
  "needs-attention": {
    stage: "needs-attention",
    label: "Needs attention",
    description:
      "The swap stopped in a state the node could not resolve on its own. If funds were locked, the timelock refund still applies.",
    severity: "attention",
    terminal: false,
    surface: true,
  },
  internal: {
    stage: "internal",
    label: "",
    description: "",
    severity: "internal",
    terminal: false,
    surface: false,
  },
  unknown: {
    stage: "unknown",
    label: "Status not recognised",
    description:
      "The swap node reported a state this version of the wallet does not know about. The swap itself is unaffected.",
    severity: "normal",
    terminal: false,
    surface: true,
  },
};

/**
 * THE MAPPING. Every one of the 34 protocol states appears exactly once — the
 * test asserts that, because a state that falls through to `unknown` is a
 * user staring at "Status not recognised" during a live swap.
 */
export const BID_STATE_STAGES: Readonly<Record<BidStateName, BidStage>> = {
  // Requesting
  BID_REQUEST_SENT: "requesting",
  BID_SENT: "requesting",
  BID_RECEIVING: "requesting",
  BID_RECEIVED: "requesting",
  // Accepted
  BID_ACCEPTED: "accepted",
  BID_REQUEST_ACCEPTED: "accepted",
  XMR_SWAP_MSG_SCRIPT_LOCK_TX_SIGS: "accepted",
  XMR_SWAP_MSG_SCRIPT_LOCK_SPEND_TX: "accepted",
  BID_AACCEPT_DELAY: "accepted",
  // Locking your funds
  SWAP_INITIATED: "locking",
  XMR_SWAP_SCRIPT_COIN_LOCKED: "locking",
  // Waiting for counterparty
  SWAP_PARTICIPATING: "waiting-counterparty",
  XMR_SWAP_NOSCRIPT_COIN_LOCKED: "waiting-counterparty",
  XMR_SWAP_HAVE_SCRIPT_COIN_SPEND_TX: "waiting-counterparty",
  // Finalising
  XMR_SWAP_LOCK_RELEASED: "finalising",
  XMR_SWAP_SCRIPT_TX_REDEEMED: "finalising",
  XMR_SWAP_NOSCRIPT_TX_REDEEMED: "finalising",
  // Done
  SWAP_COMPLETED: "done",
  // Refunded — NORMAL outcomes, see the module header
  XMR_SWAP_FAILED_REFUNDED: "refunded",
  XMR_SWAP_NOSCRIPT_TX_RECOVERED: "refunded",
  XMR_SWAP_SCRIPT_TX_PREREFUND: "refunded",
  // Counterparty recovered
  XMR_SWAP_FAILED_SWIPED: "counterparty-recovered",
  // ...and the mercy keyshare was there but never used, so it stays that way.
  XMR_SWAP_FAILED_SWIPED_MERCY_UNUSED: "counterparty-recovered",

  // Mercy path IN FLIGHT — deliberately NOT terminal. A swipe with a mercy tx
  // coming is not a finished swap: the scriptless leg can still come back, and
  // calling it terminal would both mislead the user and (once the fee watcher
  // exists) risk settling against a bid that is still moving.
  XMR_SWAP_FAILED_SWIPED_SENDING_MERCY: "recovering",
  XMR_SWAP_FAILED_SWIPED_USING_MERCY: "recovering",

  // Mercy USED — the funds came back to this side. That is a refund in
  // everything but name, so it reads as one rather than as "recovered by the
  // other user", which would tell the user they lost the leg they just got back.
  XMR_SWAP_FAILED_SWIPED_USED_MERCY: "refunded",
  // Cancelled / expired
  BID_ABANDONED: "cancelled",
  BID_EXPIRED: "cancelled",
  BID_REJECTED: "cancelled",
  SWAP_TIMEDOUT: "cancelled",
  // Needs attention
  XMR_SWAP_FAILED: "needs-attention",
  BID_ERROR: "needs-attention",
  BID_AACCEPT_FAIL: "needs-attention",
  BID_STATE_UNKNOWN: "needs-attention",
  // Internal — DO NOT SURFACE
  BID_STALLED_FOR_TEST: "internal",
  CONNECT_REQ_SENT: "internal",
  SWAP_DELAYING: "internal",
  BID_RECEIVING_ACC: "internal",
};

// =========================================================================
// Classification
// =========================================================================

/** Anything an endpoint might hand us for "what state is this bid in". */
export type BidStateInput = BidStateName | string | number | null | undefined;

/**
 * The happy path, in order. `arcProgress` reports where a stage sits on it
 * as a 0–1 fraction, or `null` for a stage that is not on it (a refund, an
 * error, an internal pause). Exported so the tracker's step list and the
 * Swap tab's in-progress card cannot disagree about the order.
 */
export const BID_ARC: readonly BidStage[] = [
  "requesting",
  "accepted",
  "locking",
  "waiting-counterparty",
  "finalising",
  "done",
];

export function arcProgress(stage: BidStage): number | null {
  const i = BID_ARC.indexOf(stage);
  if (i < 0) return null;
  return i / (BID_ARC.length - 1);
}

export interface BidStateClassification extends BidStageInfo {
  /** The resolved protocol state, or `null` when nothing matched. */
  state: BidStateName | null;
  /** The protocol integer, or `null`. */
  stateId: number | null;
  /** Exactly what was passed in, kept so an unknown value can be reported. */
  raw: string | number | null;
}

/**
 * Resolve any of the three wire representations to the canonical state name.
 * Returns `null` for anything unrecognised — never a guess.
 */
export function bidStateNameOf(state: BidStateInput): BidStateName | null {
  if (state == null) return null;
  if (typeof state === "number") {
    return Number.isInteger(state) ? (ID_TO_NAME[state] ?? null) : null;
  }
  const raw = state.trim();
  if (raw === "") return null;
  // An all-digits string is `bid_state_ind` that came through JSON as text.
  if (/^\d+$/.test(raw)) return ID_TO_NAME[Number(raw)] ?? null;
  const upper = raw.toUpperCase();
  const byName = (BID_STATE_IDS as Record<string, number | undefined>)[upper];
  if (byName != null) return upper as BidStateName;
  return WIRE_LABEL_TO_NAME[upper] ?? null;
}

/** The full stage record for a bid state. */
export function classifyBidState(state: BidStateInput): BidStateClassification {
  const name = bidStateNameOf(state);
  const stage = name ? BID_STATE_STAGES[name] : "unknown";
  const info = BID_STAGES[stage];
  return {
    ...info,
    state: name,
    stateId: name ? BID_STATE_IDS[name] : null,
    raw: typeof state === "string" || typeof state === "number" ? state : null,
  };
}

/** Just the stage. */
export function stageForBidState(state: BidStateInput): BidStage {
  return classifyBidState(state).stage;
}

/** Just the label. Empty string for internal states — check {@link shouldSurface} first. */
export function bidStageLabel(state: BidStateInput): string {
  return classifyBidState(state).label;
}

/**
 * Whether the swap can still change state.
 *
 * `needs-attention` is deliberately **not** terminal: a bid sitting in
 * `XMR_SWAP_FAILED` with funds locked still has a timelock refund ahead of it,
 * and a tracker that stops polling there would show a stuck swap that has in
 * fact already refunded. `unknown` is not terminal for the same reason — we do
 * not know, so we keep watching.
 */
export function isTerminal(state: BidStateInput): boolean {
  return classifyBidState(state).terminal;
}

/** Alias for call sites where the bare name would be ambiguous. */
export const isTerminalBidState = isTerminal;

/**
 * True for the three timelock-return states. Call this to pick refund copy —
 * never to pick error copy.
 */
export function isRefundOutcome(state: BidStateInput): boolean {
  return stageForBidState(state) === "refunded";
}

/**
 * False for the four internal bookkeeping states. A tracker showing
 * `SWAP_DELAYING` or `CONNECT_REQ_SENT` is leaking the node's internals into a
 * user's progress bar; hold the previous stage instead.
 */
export function shouldSurface(state: BidStateInput): boolean {
  return classifyBidState(state).surface;
}
