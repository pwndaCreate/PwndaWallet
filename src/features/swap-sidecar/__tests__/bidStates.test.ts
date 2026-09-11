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
  SCRIPTLESS_LEG_STAGES,
  nodeProseIsOtherLegsStory,
  bidStageLabel,
  bidStateNameOf,
  classifyBidState,
  isRefundOutcome,
  isSwipeOutcome,
  isTerminal,
  isTerminalBidState,
  shouldSurface,
  stageForBidState,
  swapLegOf,
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
  // PREREFUND is the refund STARTING, and belongs to its own non-terminal
  // stage: it used to sit in `refunded` and told the user their funds were
  // already back while the tx was still confirming (live bid, 2026-09-06).
  refunding: ["XMR_SWAP_SCRIPT_TX_PREREFUND"],
  refunded: [
    "XMR_SWAP_FAILED_REFUNDED",
    "XMR_SWAP_NOSCRIPT_TX_RECOVERED",
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
  // Reachable only with a LEG. These three are what the scriptless side reads
  // instead of `refunding` / `counterparty-recovered` / `recovering`, and no
  // state maps to them in the neutral table by construction — see
  // `SCRIPTLESS_LEG_STAGES` and the leg-aware describe block below.
  "timelock-unwinding": [],
  swiped: [],
  "swiped-settling": [],
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
    // Both refund stages are non-failures; only the terminal one is past tense.
    expect(["refunding", "refunded"]).toContain(c.stage);
    expect(c.terminal).toBe(name !== "XMR_SWAP_SCRIPT_TX_PREREFUND");
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

// =========================================================================
// The leg split
// =========================================================================

/**
 * Regression guard for the 2026-09-08 incident.
 *
 * Live bid `000000006a9c9d96…`: this node was the taker on an LTC/XMR swap,
 * sent 0.00999997 XMR to receive 0.09992627 LTC, both legs locked, and the
 * counterparty went quiet. It then sat in `XMR_SWAP_SCRIPT_TX_PREREFUND` for
 * 28 hours while the tracker said "The refund is on chain now. Leave the app
 * open until it settles." The operator read that, concluded they had been
 * refunded a day earlier, and asked why the finished swap would not leave the
 * screen. Nothing had been refunded: the pre-refund tx moves the
 * COUNTERPARTY's chain-A lock, and the XMR was still locked at the shared
 * address.
 *
 * The assertions below are written against the engine, not against the copy:
 * each names the `basicswap.py` line that decides which side does what, so a
 * future upstream bump that moves the asymmetry fails here rather than in
 * front of a user with locked funds.
 */
describe("the same state means opposite things to the two legs", () => {
  const scriptless = { was_sent: true, was_received: null, reverse_bid: false };
  const scripted = { was_sent: null, was_received: true, reverse_bid: false };

  describe("swapLegOf", () => {
    it("reads a plain sent bid as the scriptless leg", () => {
      expect(swapLegOf(scriptless)).toBe("scriptless");
    });

    it("reads a plain received bid as the scripted leg", () => {
      expect(swapLegOf(scripted)).toBe("scripted");
    });

    it("mirrors the legs on a reverse ADS bid, as the engine does", () => {
      // basicswap.py::checkXmrBidState:
      //   was_sent = bid.was_received if reverse_bid else bid.was_sent
      expect(swapLegOf({ ...scriptless, reverse_bid: true })).toBe("scripted");
      expect(swapLegOf({ ...scripted, reverse_bid: true })).toBe("scriptless");
    });

    it("refuses to guess without reverse_bid", () => {
      // /json/active rows carry was_sent and NOT reverse_bid. Guessing there
      // is a coin flip between two opposite stories.
      expect(swapLegOf({ was_sent: true })).toBe("unknown");
      expect(swapLegOf({ was_sent: true, reverse_bid: null })).toBe("unknown");
      expect(swapLegOf(null)).toBe("unknown");
      expect(swapLegOf(undefined)).toBe("unknown");
    });

    it("treats a null on both sides as unknown, not as scripted", () => {
      expect(
        swapLegOf({ was_sent: null, was_received: null, reverse_bid: false }),
      ).toBe("unknown");
    });
  });

  describe("XMR_SWAP_SCRIPT_TX_PREREFUND (14) — THE incident", () => {
    const S = "XMR_SWAP_SCRIPT_TX_PREREFUND";

    it("does not tell the scriptless leg its own refund is on chain", () => {
      const c = classifyBidState(S, "scriptless");
      expect(c.stage).toBe("timelock-unwinding");
      const copy = `${c.label} ${c.description}`.toLowerCase();
      // The exact claim that produced the incident.
      expect(copy).not.toContain("the refund is on chain");
      expect(copy).not.toContain("refund");
      // ...and it says the thing that was actually true for 28 hours.
      expect(copy).toContain("has not moved");
    });

    it("still tells the scripted leg its refund is on chain, because it is", () => {
      expect(classifyBidState(S, "scripted").stage).toBe("refunding");
      expect(classifyBidState(S, "scripted").description).toContain(
        "refund is on chain",
      );
    });

    it("is non-terminal and severity normal on BOTH legs", () => {
      for (const leg of ["scriptless", "scripted", "unknown"] as const) {
        const c = classifyBidState(S, leg);
        expect(c.terminal, leg).toBe(false);
        expect(c.severity, leg).toBe("normal");
      }
    });

    it("stays in the refund vocabulary, so no branch reaches for error copy", () => {
      expect(isRefundOutcome(S, "scriptless")).toBe(true);
      expect(isRefundOutcome(S, "scripted")).toBe(true);
    });
  });

  describe("XMR_SWAP_FAILED_SWIPED (18) — inverted, not merely vague", () => {
    const S = "XMR_SWAP_FAILED_SWIPED";

    it("tells the scriptless leg it was PAID, not that it lost the swap", () => {
      // basicswap.py:8880 publishes the swipe under `if was_sent:`, and
      // createCoinALockRefundSwipeTx (:17154) pays
      // getReceiveAddressForCoin — this node's own address.
      const c = classifyBidState(S, "scriptless");
      expect(c.stage).toBe("swiped");
      const copy = `${c.label} ${c.description}`.toLowerCase();
      expect(copy).not.toContain("the other user took");
      expect(copy).toContain("in your wallet");
      expect(c.terminal).toBe(true);
      expect(c.severity).toBe("normal");
    });

    it("still tells the scripted leg the other side recovered", () => {
      expect(classifyBidState(S, "scripted").stage).toBe(
        "counterparty-recovered",
      );
    });

    it("is not a refund on either leg — nothing came back", () => {
      expect(isRefundOutcome(S, "scriptless")).toBe(false);
      expect(isSwipeOutcome(S, "scriptless")).toBe(true);
      expect(isSwipeOutcome(S, "scripted")).toBe(false);
    });
  });

  describe("XMR_SWAP_FAILED_SWIPED_SENDING_MERCY (39) — swiper only", () => {
    const S = "XMR_SWAP_FAILED_SWIPED_SENDING_MERCY";

    it("does not tell the swiper its own funds are being recovered", () => {
      // Set at basicswap.py:10583, on the swiper, once its mercy tx is queued.
      const c = classifyBidState(S, "scriptless");
      expect(c.stage).toBe("swiped-settling");
      expect(c.label).not.toContain("Recovering your funds");
      // Still moving: nothing downstream may settle against it.
      expect(c.terminal).toBe(false);
    });
  });

  describe("the victim-only mercy states keep the neutral reading", () => {
    // All three are set on the side that was swiped (basicswap.py:10557,
    // :9501, :10545), so the base table is already their correct reading.
    it.each([
      "XMR_SWAP_FAILED_SWIPED_USING_MERCY",
      "XMR_SWAP_FAILED_SWIPED_USED_MERCY",
      "XMR_SWAP_FAILED_SWIPED_MERCY_UNUSED",
    ] as BidStateName[])("%s is not overridden by leg", (name) => {
      expect(classifyBidState(name, "scriptless").stage).toBe(
        classifyBidState(name).stage,
      );
    });
  });

  it("overrides EXACTLY the three asymmetric states and nothing else", () => {
    expect(Object.keys(SCRIPTLESS_LEG_STAGES).sort()).toEqual([
      "XMR_SWAP_FAILED_SWIPED",
      "XMR_SWAP_FAILED_SWIPED_SENDING_MERCY",
      "XMR_SWAP_SCRIPT_TX_PREREFUND",
    ]);
  });

  it("leaves every other state identical on every leg", () => {
    for (const name of ALL_BID_STATE_NAMES) {
      if (name in SCRIPTLESS_LEG_STAGES) continue;
      for (const leg of ["scriptless", "scripted", "unknown"] as const) {
        expect(stageForBidState(name, leg), `${name} @ ${leg}`).toBe(
          stageForBidState(name),
        );
      }
    }
  });

  describe("the node's own prose is suppressed when it is the other leg's", () => {
    // Observed live 2026-09-08 at the moment this very bid settled IN THE
    // USER'S FAVOUR. `state_description` on the paid side read, verbatim:
    //
    //   "Swap failed, the other party claimed the refund"
    //
    // The tracker renders that under "Swap node detail:", four lines below the
    // stage label. Without the guard the panel asserted both "It is in your
    // wallet" and "the other party claimed the refund" at once, about the same
    // 0.09992346 LTC.
    it("suppresses it for the states the leg overrides", () => {
      for (const name of Object.keys(SCRIPTLESS_LEG_STAGES) as BidStateName[]) {
        expect(nodeProseIsOtherLegsStory(name, "scriptless"), name).toBe(true);
      }
    });

    it("keeps it on the scripted leg, whose story it actually is", () => {
      for (const name of Object.keys(SCRIPTLESS_LEG_STAGES) as BidStateName[]) {
        expect(nodeProseIsOtherLegsStory(name, "scripted"), name).toBe(false);
        expect(nodeProseIsOtherLegsStory(name), name).toBe(false);
      }
    });

    it("keeps it for every state the leg does not change", () => {
      for (const name of ALL_BID_STATE_NAMES) {
        if (name in SCRIPTLESS_LEG_STAGES) continue;
        expect(nodeProseIsOtherLegsStory(name, "scriptless"), name).toBe(false);
      }
    });

    it("accepts the bid_state_ind the tracker actually holds", () => {
      // The call site passes `swap.detail.bid_state_ind`, an int, not a name.
      expect(nodeProseIsOtherLegsStory(18, "scriptless")).toBe(true);
      expect(nodeProseIsOtherLegsStory(14, "scriptless")).toBe(true);
      expect(nodeProseIsOtherLegsStory(11, "scriptless")).toBe(false);
      expect(nodeProseIsOtherLegsStory(null, "scriptless")).toBe(false);
    });
  });

  it("defaults to the neutral mapping, so an un-migrated caller is unchanged", () => {
    for (const name of ALL_BID_STATE_NAMES) {
      expect(classifyBidState(name).stage).toBe(BID_STATE_STAGES[name]);
      expect(classifyBidState(name).leg).toBe("unknown");
    }
  });
});
