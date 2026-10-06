/**
 * How a finished hop 1 moves the EARN convert pipeline (operator request,
 * 2026-10-01: close the open items of "EARN's convert pipeline never adopted
 * its first hop" the same day).
 *
 * Three were left open there, all in `useConvertPipeline`'s stage effect:
 *
 *  - a hop 1 that ended `swiped` (the timelock paid this node the LTC) stayed
 *    at "SWAP IN PROGRESS…": only `done` led to `hop2-ready`;
 *  - an automatic re-bid of hop 1 was not followed: `cancelled` unwound at
 *    once ("…your XMR came back … You can start again") while
 *    `useSidecarSwap` might be re-bidding the same XMR;
 *  - none of it had a test: the suite runs in node, with no React renderer
 *    to run an effect.
 *
 * The decision is now the pure `nextHop1Step`, pinned here per ending, and
 * the effect only applies it. The hook's side of the re-bid is a new report,
 * `SidecarSwapState.rebids` (`trying`, `placed`, `none`); the hook said it
 * only in `console.warn` lines before.
 *
 * Found on the way, and pinned below: a hop 1 picked up after a restart is
 * read with no leg, and the no-leg reading of state 18 (the swipe that PAID
 * this node) is `counterparty-recovered`, which unwound the conversion one
 * poll before the read that names the leg.
 *
 * Bid ids are invented, in the engine's layout. Nothing here reaches a node.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  classifyBidState,
  type AutoRebidOutcome,
  type SidecarTrackedSwap,
} from "../swap-sidecar";
import { nextHop1Step, type Hop1Step } from "./useConvertPipeline";
import {
  followConversionRebid,
  loadConversions,
  recordConversionStarted,
  updateConversion,
} from "./convert-history";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

// Invented ids with the engine's layout: 28-byte object ids.
const objId = (fill: string) => "00000000" + fill.repeat(24);
const HOP1 = objId("a1");
const REBID_1 = objId("a2");
const REBID_2 = objId("a3");
const OFFER = objId("0f");

/** Hop 1 as the tracker holds it: XMR sent, LTC bought, so this node is the
 *  scriptless leg once a read names the leg. */
function hop1(
  state: number,
  leg: "scriptless" | "scripted" | "unknown" = "scriptless",
  over: Partial<SidecarTrackedSwap> = {},
): SidecarTrackedSwap {
  return {
    bidId: HOP1,
    offerId: OFFER,
    sendCoin: "Monero",
    receiveCoin: "Litecoin",
    sendAmount: "0.500000000000",
    receiveAmount: "0.69988801",
    createdAt: 1_790_100_000,
    payoutAddress: "ltc1qinventedpayout000000000000000000000",
    detail: null,
    stage: classifyBidState(state, leg),
    lastPolledAt: leg === "unknown" ? null : 1_790_100_900_000,
    error: null,
    ...over,
  };
}

const step = (
  swap: SidecarTrackedSwap | null,
  rebid?: AutoRebidOutcome,
  hop1BidId: string = HOP1,
): Hop1Step => nextHop1Step({ hop1BidId, hop1: swap, rebid });

// ═══════════════════════════════════════════════════════════════════════
// Endings that pay the LTC
// ═══════════════════════════════════════════════════════════════════════

describe("hop 1 paid the LTC: hop 2 is offered", () => {
  it("done (SWAP_COMPLETED)", () => {
    expect(step(hop1(8))).toEqual({ kind: "settled", viaAmount: "0.69988801" });
  });

  it("swiped (18 on this leg): the timelock paid this node the LTC it was buying", () => {
    const s = hop1(18);
    expect(s.stage.stage).toBe("swiped");
    // Hop 2 gets the bid's receive amount: the bid's record carries no
    // received amount, and what arrived is that less the network fees.
    expect(step(s)).toEqual({ kind: "settled", viaAmount: "0.69988801" });
  });

  it("not swiped-settling (39): the LTC is still on the swap's own key", () => {
    const s = hop1(39);
    expect(s.stage.stage).toBe("swiped-settling");
    expect(step(s)).toEqual({ kind: "running" });
  });

  it("state 36 reads as the coin bought having arrived, if it is ever hop 1's", () => {
    // Only the scripted leg reaches 36, and hop 1 sends XMR (scriptless), so
    // this is the table's reading, not a path hop 1 takes.
    expect(step(hop1(36, "scripted")).kind).toBe("settled");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// A reading with no leg
// ═══════════════════════════════════════════════════════════════════════

describe("a hop 1 picked up after a restart, read with no leg yet", () => {
  it("waits on state 18 instead of unwinding: its no-leg reading is the other side's loss", () => {
    const rehydrated = hop1(18, "unknown");
    expect(rehydrated.stage.stage).toBe("counterparty-recovered");
    expect(step(rehydrated)).toEqual({ kind: "running", awaiting: "leg" });
    // One poll later the read names the leg: this node was paid.
    expect(step(hop1(18, "scriptless")).kind).toBe("settled");
  });

  it("acts at once on an ending that reads the same from both legs", () => {
    expect(step(hop1(8, "unknown")).kind).toBe("settled");
    expect(step(hop1(17, "unknown")).kind).toBe("unwound");
    expect(step(hop1(11, "unknown")).kind).toBe("running");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Endings with no LTC
// ═══════════════════════════════════════════════════════════════════════

describe("hop 1 ended without LTC: the conversion unwinds", () => {
  it("refunded: the XMR came back (16 and 17)", () => {
    expect(step(hop1(16))).toEqual({ kind: "unwound" });
    expect(step(hop1(17))).toEqual({ kind: "unwound" });
  });

  it("counterparty-recovered, read with a leg", () => {
    // 38 is the swiped side with an unusable key share. Unreachable for hop 1
    // (scriptless), kept ending the conversion as before.
    const s = hop1(38, "scripted");
    expect(s.stage.stage).toBe("counterparty-recovered");
    expect(step(s)).toEqual({ kind: "unwound" });
  });

  it("everything still moving keeps hop 1 running, the timelock path included", () => {
    for (const state of [1, 5, 9, 11, 12, 13, 14, 15, 19, 23, 37]) {
      expect(step(hop1(state)).kind, String(state)).toBe("running");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Expired unanswered, and the automatic re-bid
// ═══════════════════════════════════════════════════════════════════════

describe("hop 1 expired unanswered (cancelled)", () => {
  const expired = () => hop1(31); // BID_EXPIRED

  it("waits while the tracker has not answered yet: the re-bid effect runs after this render", () => {
    expect(expired().stage.stage).toBe("cancelled");
    expect(step(expired())).toEqual({ kind: "running", awaiting: "rebid" });
  });

  it("waits while the re-bid is being tried", () => {
    expect(step(expired(), { status: "trying" })).toEqual({ kind: "running", awaiting: "rebid" });
  });

  it("follows the re-bid when one was placed", () => {
    expect(step(expired(), { status: "placed", bidId: REBID_1 })).toEqual({
      kind: "follow",
      bidId: REBID_1,
    });
  });

  it("unwinds only when no re-bid follows", () => {
    for (const reason of [
      "already re-bid automatically 2 time(s) — the next one is yours to make",
      "the replacement is in the amber band, which is yours to accept",
      "no payout address on this swap (it was picked up from the swap node, which does not carry one)",
    ]) {
      expect(step(expired(), { status: "none", reason })).toEqual({ kind: "unwound" });
    }
  });

  it("decides the same once the tracker has dropped the finished bid", () => {
    // The tracker drops a terminal bid the node no longer lists; the outcome
    // is kept by bid id, so the pipeline still knows.
    expect(step(null, { status: "placed", bidId: REBID_1 })).toEqual({ kind: "follow", bidId: REBID_1 });
    expect(step(null, { status: "none", reason: "x" })).toEqual({ kind: "unwound" });
    expect(step(null, { status: "trying" })).toEqual({ kind: "running", awaiting: "rebid" });
    // Nothing known: leave the stage alone, as before.
    expect(step(null)).toEqual({ kind: "unknown" });
  });

  it("a re-bid the node answered with the same id is the bid already held", () => {
    // The browser sandbox's mock answers every bid with one id: adopt then
    // replaced the expired entry with the re-bid under that id.
    const rebidSameId = hop1(1, "unknown");
    expect(step(rebidSameId, { status: "placed", bidId: HOP1 })).toEqual({ kind: "running" });
    expect(step(null, { status: "placed", bidId: HOP1 })).toEqual({ kind: "running" });
  });

  it("follows a chain of re-bids one link at a time, by outcome, not by retryOf", () => {
    // The first re-bid carries retryOf = HOP1. The second carries retryOf =
    // HOP1 too (the ORIGIN, `attemptAutoRetry`), not REBID_1, so only the
    // outcome recorded against REBID_1 links it to REBID_2.
    expect(step(hop1(31), { status: "placed", bidId: REBID_1 })).toEqual({ kind: "follow", bidId: REBID_1 });
    const first = hop1(31, "scriptless", { bidId: REBID_1, retryOf: HOP1, retryAttempt: 1 });
    expect(nextHop1Step({ hop1BidId: REBID_1, hop1: first, rebid: { status: "placed", bidId: REBID_2 } })).toEqual({
      kind: "follow",
      bidId: REBID_2,
    });
    const second = hop1(31, "scriptless", { bidId: REBID_2, retryOf: HOP1, retryAttempt: 2 });
    expect(
      nextHop1Step({
        hop1BidId: REBID_2,
        hop1: second,
        rebid: { status: "none", reason: "already re-bid automatically 2 time(s) — the next one is yours to make" },
      }),
    ).toEqual({ kind: "unwound" });
  });

  it("an outcome is ignored once the bid it names is running again", () => {
    // Only a bid seen ending unanswered has an outcome, so a running hop 1
    // with one is the same-id re-bid above: the stage decides.
    expect(step(hop1(8, "scriptless"), { status: "placed", bidId: HOP1 }).kind).toBe("settled");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The conversion log follows the re-bid
// ═══════════════════════════════════════════════════════════════════════

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("followConversionRebid: the run moves to the re-bid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = (id: string, startedAt: number) => ({
    id,
    fromTicker: "XMR",
    viaTicker: "LTC",
    toTicker: "BTC",
    fromAmount: "0.500000000000",
    viaAmount: "",
    toAmount: "",
    startedAt,
    status: "running" as const,
  });

  it("keeps the run, under the new bid's id, with the amount the re-bid sends", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    recordConversionStarted(run(HOP1, 1_790_100_000_000));
    followConversionRebid(HOP1, REBID_1, { fromAmount: "0.499999999990" });
    const rows = loadConversions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ ...run(REBID_1, 1_790_100_000_000), fromAmount: "0.499999999990" });
    // Later writes reach it under the id the pipeline now holds.
    updateConversion(REBID_1, { viaAmount: "0.69988801" });
    expect(loadConversions()[0].viaAmount).toBe("0.69988801");
  });

  it("one bid is one run: a row already under the new id is replaced", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    recordConversionStarted(run(REBID_1, 1_790_000_000_000));
    recordConversionStarted(run(HOP1, 1_790_100_000_000));
    followConversionRebid(HOP1, REBID_1);
    const rows = loadConversions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: REBID_1, startedAt: 1_790_100_000_000 });
  });

  it("an unknown run and an empty id change nothing", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    recordConversionStarted(run(HOP1, 1_790_100_000_000));
    followConversionRebid(REBID_2, REBID_1);
    followConversionRebid(HOP1, "");
    expect(loadConversions().map((r) => r.id)).toEqual([HOP1]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Wiring: the effect applies the step, the hook reports the re-bid
// ═══════════════════════════════════════════════════════════════════════

describe("wired: the pipeline effect applies nextHop1Step", () => {
  const hook = read("./useConvertPipeline.ts");
  const effect = hook.slice(
    hook.indexOf("/** Advance the stage from hop 1's own state machine"),
    hook.indexOf("const beginHop1 = useCallback"),
  );

  it("decides through the pure function, with the tracker's re-bid outcome", () => {
    expect(effect.length).toBeGreaterThan(0);
    expect(hook).toContain("const hop1Rebid = hop1BidId ? sidecar?.rebids?.[hop1BidId] : undefined;");
    expect(effect).toContain("nextHop1Step({ hop1BidId, hop1, rebid: hop1Rebid })");
    expect(effect).toContain("}, [enabled, hop1, hop1BidId, hop1Rebid]);");
  });

  it("follows a re-bid: storage, the log and the stage", () => {
    const follow = effect.slice(effect.indexOf('case "follow"'), effect.indexOf('case "unwound"'));
    expect(follow).toContain("followConversionRebid(");
    expect(follow).toContain("setHop1BidId(step.bidId);");
    expect(follow).toContain("writeStored(HOP1_STORAGE_KEY, step.bidId);");
    expect(follow).toContain('setStage("hop1-running");');
  });

  it("no longer reads only `done` as settled, nor `cancelled` as unwound", () => {
    expect(hook).not.toContain('const HOP1_SETTLED = "done";');
    expect(hook).not.toMatch(/HOP1_UNWOUND = new Set\(\[[^\]]*"cancelled"/);
  });
});

describe("wired: the tracker reports what became of each re-bid", () => {
  const hook = read("../swap-sidecar/useSidecarSwap.ts");
  const effect = hook.slice(
    hook.indexOf("const retriedRef = useRef"),
    hook.indexOf("const attemptAutoRetry = useCallback"),
  );
  const retry = hook.slice(
    hook.indexOf("const attemptAutoRetry = useCallback"),
    hook.indexOf("const openTracker = useCallback"),
  );

  it("says `trying` when it starts, then what the attempt returned", () => {
    expect(effect).toContain('noteRebid(swap.bidId, { status: "trying" });');
    expect(effect).toMatch(/attemptAutoRetry\(swap\)\.then\(\s*\(outcome\) => noteRebid\(deadId, outcome\),/);
    expect(effect.indexOf('{ status: "trying" }')).toBeLessThan(effect.indexOf("attemptAutoRetry(swap)"));
  });

  it("answers `none` for a bid it only follows from swap history, instead of skipping it in silence", () => {
    const watched = effect.slice(effect.indexOf("if (retriedRef.current.has(swap.bidId))"), effect.indexOf("continue;"));
    expect(watched).toContain('status: "none"');
    expect(watched).not.toContain("coolDown(");
  });

  it("every path of the attempt returns an outcome, and a placed one names the new bid", () => {
    expect(retry).toContain("async (dead: SidecarTrackedSwap): Promise<AutoRebidOutcome> =>");
    expect(retry).toContain('return { status: "placed", bidId: result.bidId };');
    expect(retry.indexOf("adopt({")).toBeLessThan(retry.indexOf('return { status: "placed"'));
    // Five refusals since 2026-10-06: the fifth is a replacement offer that
    // would pay the bought coin somewhere other than the user confirmed
    // (`payoutDestination.ts`).
    expect(retry.match(/return \{ status: "none"|return \{\s*status: "none"/g)?.length).toBe(5);
  });

  it("exposes the outcomes", () => {
    expect(hook).toMatch(/rebids: Readonly<Record<string, AutoRebidOutcome>>;/);
    expect(hook).toMatch(/return \{\s*swaps,[\s\S]*rebids,[\s\S]*\};\s*\}/);
  });
});
