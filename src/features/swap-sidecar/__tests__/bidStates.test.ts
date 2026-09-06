import { BID_ARC, arcProgress } from "../bidStates";
/**
 * Tests for the BidStates → plain-language stage mapping.
 *
 * Two properties are worth more than the rest:
 *
 * - **every** protocol state maps (a fall-through means a user staring at
 *   "Status not recognised" halfway through a live swap), and
 * - refunds are NOT errors (a compliance constraint, see the module header).
 */
import { describe, expect, it } from "vitest";

import {
  ALL_BID_STATE_NAMES,
  BID_STAGES,
  BID_STATE_IDS,
  BID_STATE_STAGES,
  BID_STATE_WIRE_LABELS,
  bidStageLabel,
  bidStateNameOf,
  classifyBidState,
  isRefundOutcome,
  isTerminal,
  isTerminalBidState,
  shouldSurface,
  stageForBidState,
  type BidStage,
  type BidStateName,
} from "../bidStates";

/** The mapping exactly as the execution plan specifies it. */
const EXPECTED: Record<BidStage, BidStateName[]> = {
  requesting: ["BID_REQUEST_SENT", "BID_SENT", "BID_RECEIVING", "BID_RECEIVED"],
  accepted: [
    "BID_ACCEPTED",
    "BID_REQUEST_ACCEPTED",
    "XMR_SWAP_MSG_SCRIPT_LOCK_TX_SIGS",
    "XMR_SWAP_MSG_SCRIPT_LOCK_SPEND_TX",
    "BID_AACCEPT_DELAY",
  ],
  locking: ["SWAP_INITIATED", "XMR_SWAP_SCRIPT_COIN_LOCKED"],
  "waiting-counterparty": [
    "SWAP_PARTICIPATING",
    "XMR_SWAP_NOSCRIPT_COIN_LOCKED",
    "XMR_SWAP_HAVE_SCRIPT_COIN_SPEND_TX",
  ],
  finalising: [
    "XMR_SWAP_LOCK_RELEASED",
    "XMR_SWAP_SCRIPT_TX_REDEEMED",
    "XMR_SWAP_NOSCRIPT_TX_REDEEMED",
  ],
  done: ["SWAP_COMPLETED"],
  refunded: [
    "XMR_SWAP_FAILED_REFUNDED",
    "XMR_SWAP_NOSCRIPT_TX_RECOVERED",
    "XMR_SWAP_SCRIPT_TX_PREREFUND",
    // v0.18.5: mercy USED means the scriptless leg came back to this side.
    "XMR_SWAP_FAILED_SWIPED_USED_MERCY",
  ],
  "counterparty-recovered": [
    "XMR_SWAP_FAILED_SWIPED",
    "XMR_SWAP_FAILED_SWIPED_MERCY_UNUSED",
  ],
  recovering: [
    "XMR_SWAP_FAILED_SWIPED_SENDING_MERCY",
    "XMR_SWAP_FAILED_SWIPED_USING_MERCY",
  ],
  cancelled: ["BID_ABANDONED", "BID_EXPIRED", "BID_REJECTED", "SWAP_TIMEDOUT"],
  "needs-attention": [
    "XMR_SWAP_FAILED",
    "BID_ERROR",
    "BID_AACCEPT_FAIL",
    "BID_STATE_UNKNOWN",
  ],
  internal: [
    "BID_STALLED_FOR_TEST",
    "CONNECT_REQ_SENT",
    "SWAP_DELAYING",
    "BID_RECEIVING_ACC",
  ],
  // Reachable only from an unrecognised input, never from a protocol state.
  unknown: [],
};

describe("the protocol enum", () => {
  it("carries all 38 BidStates members with upstream's own ids", () => {
    // 34 through v0.18.4; v0.18.5 added the four SWIPED_*_MERCY states at
    // 36-39. Upstream skips 35 -- the ids are NOT contiguous past 34, which is
    // why the contiguity assertion below stops there.
    expect(ALL_BID_STATE_NAMES).toHaveLength(38);
    expect(BID_STATE_IDS.BID_SENT).toBe(1);
    expect(BID_STATE_IDS.SWAP_COMPLETED).toBe(8);
    expect(BID_STATE_IDS.XMR_SWAP_FAILED_REFUNDED).toBe(17);
    expect(BID_STATE_IDS.CONNECT_REQ_SENT).toBe(34);
    // Ids run 1..34 then 36..39 — upstream SKIPS 35, so this cannot be a
    // contiguous-range check any more. Asserting the exact set still catches
    // what the range check existed to catch (a state silently dropped from the
    // mirror) without pretending the enum is dense when it is not.
    const ids = ALL_BID_STATE_NAMES.map((n) => BID_STATE_IDS[n]);
    const expected = [...Array.from({ length: 34 }, (_, i) => i + 1), 36, 37, 38, 39];
    expect(ids).toEqual(expected);
    expect(ids).not.toContain(35);
  });
});

describe("every state maps", () => {
  it("assigns a stage to each of the 34 states, and none falls through", () => {
    for (const name of ALL_BID_STATE_NAMES) {
      const stage = stageForBidState(name);
      expect(stage, `${name} has no stage`).not.toBe("unknown");
      expect(BID_STAGES[stage]).toBeDefined();
    }
    expect(Object.keys(BID_STATE_STAGES).sort()).toEqual(
      [...ALL_BID_STATE_NAMES].sort(),
    );
  });

  it.each(
    (Object.entries(EXPECTED) as [BidStage, BidStateName[]][]).flatMap(
      ([stage, names]) => names.map((n): [BidStateName, BidStage] => [n, stage]),
    ),
  )("maps %s to the %s stage", (name, stage) => {
    expect(stageForBidState(name)).toBe(stage);
  });
});

describe("refunds are NORMAL outcomes, not errors", () => {
  const refunds: BidStateName[] = [
    "XMR_SWAP_FAILED_REFUNDED",
    "XMR_SWAP_NOSCRIPT_TX_RECOVERED",
    "XMR_SWAP_SCRIPT_TX_PREREFUND",
  ];

  it.each(refunds)("%s is severity normal, never attention", (name) => {
    const c = classifyBidState(name);
    expect(c.stage).toBe("refunded");
    expect(c.severity).toBe("normal");
    expect(c.severity).not.toBe("attention");
    expect(isRefundOutcome(name)).toBe(true);
  });

  it("does not use failure language in the refund copy", () => {
    const copy = (
      BID_STAGES.refunded.label +
      " " +
      BID_STAGES.refunded.description
    ).toLowerCase();
    expect(copy).not.toContain("failed");
    expect(copy).not.toContain("failure");
    // Saying "not an error" is the point; saying "error occurred" would not be.
    expect(copy).toContain("not an error");
    expect(copy).toContain("normal outcome");
  });

  it("does not inherit upstream's 'Failed, refunded' wording", () => {
    expect(BID_STATE_WIRE_LABELS.XMR_SWAP_FAILED_REFUNDED).toBe(
      "Failed, refunded",
    );
    expect(bidStageLabel("XMR_SWAP_FAILED_REFUNDED")).toBe("Refunded");
  });

  it("keeps genuine faults on the attention severity", () => {
    for (const name of EXPECTED["needs-attention"]) {
      expect(classifyBidState(name).severity).toBe("attention");
    }
  });
});

describe("internal states are never surfaced", () => {
  it.each(EXPECTED.internal)("%s is not surfaced", (name) => {
    const c = classifyBidState(name);
    expect(c.stage).toBe("internal");
    expect(c.severity).toBe("internal");
    expect(shouldSurface(name)).toBe(false);
    expect(c.label).toBe("");
  });

  it("surfaces everything that is not internal", () => {
    for (const name of ALL_BID_STATE_NAMES) {
      const internal = (EXPECTED.internal as string[]).includes(name);
      expect(shouldSurface(name)).toBe(!internal);
    }
  });
});

describe("accepting whatever the endpoint reported", () => {
  it("resolves the raw bid_state_ind integer", () => {
    expect(bidStateNameOf(17)).toBe("XMR_SWAP_FAILED_REFUNDED");
    expect(classifyBidState(8).stage).toBe("done");
  });

  it("resolves an integer that arrived as a string", () => {
    expect(bidStateNameOf("17")).toBe("XMR_SWAP_FAILED_REFUNDED");
  });

  it("resolves the canonical enum name, case-insensitively", () => {
    expect(bidStateNameOf("xmr_swap_failed_refunded")).toBe(
      "XMR_SWAP_FAILED_REFUNDED",
    );
  });

  it("resolves upstream's human bid_state string", () => {
    for (const name of ALL_BID_STATE_NAMES) {
      expect(bidStateNameOf(BID_STATE_WIRE_LABELS[name])).toBe(name);
    }
  });

  it("reports an unrecognised value as unknown rather than guessing", () => {
    for (const bad of [
      "BID_SOMETHING_NEW",
      "Unknown 99",
      99,
      -1,
      1.5,
      "",
      "   ",
      null,
      undefined,
    ]) {
      const c = classifyBidState(bad as never);
      expect(c.state).toBeNull();
      expect(c.stage).toBe("unknown");
    }
  });

  it("keeps the raw value so an unknown state can be reported verbatim", () => {
    expect(classifyBidState("BID_SOMETHING_NEW").raw).toBe("BID_SOMETHING_NEW");
    expect(classifyBidState(99).raw).toBe(99);
  });
});

describe("isTerminal", () => {
  it("is true for the four end-of-life stages", () => {
    for (const stage of [
      "done",
      "refunded",
      "counterparty-recovered",
      "cancelled",
    ] as BidStage[]) {
      for (const name of EXPECTED[stage]) {
        expect(isTerminal(name), name).toBe(true);
      }
    }
  });

  it("is false while the swap is still moving", () => {
    for (const stage of [
      "requesting",
      "accepted",
      "locking",
      "waiting-counterparty",
      "finalising",
    ] as BidStage[]) {
      for (const name of EXPECTED[stage]) {
        expect(isTerminal(name), name).toBe(false);
      }
    }
  });

  it("is false for needs-attention — the timelock refund can still fire", () => {
    for (const name of EXPECTED["needs-attention"]) {
      expect(isTerminal(name), name).toBe(false);
    }
  });

  it("is false for an unknown state — we do not know, so we keep watching", () => {
    expect(isTerminal("BID_SOMETHING_NEW")).toBe(false);
  });

  it("exposes the aliased name for call sites that need it", () => {
    expect(isTerminalBidState).toBe(isTerminal);
  });
});

describe("stage copy", () => {
  it("gives every surfaced stage a label and a description", () => {
    for (const [stage, info] of Object.entries(BID_STAGES)) {
      if (!info.surface) continue;
      expect(info.label.length, stage).toBeGreaterThan(0);
      expect(info.description.length, stage).toBeGreaterThan(0);
    }
  });

  it("never implies pwnda is the counterparty", () => {
    for (const info of Object.values(BID_STAGES)) {
      const copy = `${info.label} ${info.description}`.toLowerCase();
      expect(copy).not.toContain("we will");
      expect(copy).not.toContain("we'll");
      expect(copy).not.toContain("our swap");
    }
  });

  it("names the timelock rather than treating a stalled counterparty as a fault", () => {
    expect(BID_STAGES["waiting-counterparty"].description).toContain("timelock");
  });
});

describe("arcProgress — where a stage sits on the happy path", () => {
  it("runs 0 → 1 across the arc, in order", () => {
    const values = BID_ARC.map((s) => arcProgress(s));
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(1);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });

  it("is null off the arc — a refund, an error, an internal pause", () => {
    for (const s of ["refunded", "needs-attention", "internal", "unknown", "cancelled"] as const) {
      expect(arcProgress(s)).toBeNull();
    }
  });
});
