/**
 * The MIN preset's routing rule (2026-09-04).
 *
 * Background: the 2026-08-22 MIN button was gated on
 * `preferredRouter === "basicswap" && basicswapRoutable`, so it was absent on
 * NEAR entirely and absent on P2P whenever the selected pair was not P2P-
 * routable — which, after the redesign carried the NEAR pair (ETH→BTC) into
 * the P2P tab, was the common case. The operator read that as "the min button
 * disappeared for all the swaps". The button now always renders and this
 * function decides what it does.
 */
import { describe, expect, it } from "vitest";
import { minPresetTitle, planMinPreset, type MinPresetInput } from "./minPreset";

const base: MinPresetInput = {
  preferredRouter: "intents",
  basicswapRoutable: false,
  intentsMinimum: null,
  fromCoin: "ETH",
  perAssetMinDisplay: null,
  probeAvailable: false,
};

describe("planMinPreset — P2P reads the book", () => {
  it("scans the offer book when the pair is routable", () => {
    expect(
      planMinPreset({ ...base, preferredRouter: "basicswap", basicswapRoutable: true }),
    ).toEqual({ kind: "book" });
  });

  it("is disabled with a reason, never hidden, when the pair has no book", () => {
    const plan = planMinPreset({ ...base, preferredRouter: "basicswap" });
    expect(plan.kind).toBe("none");
    expect(minPresetTitle(plan)).toMatch(/holds a book/);
  });
});

describe("planMinPreset — NEAR fills the venue minimum already on screen", () => {
  it("prefers the pair minimum the quote hook learned", () => {
    expect(
      planMinPreset({
        ...base,
        intentsMinimum: { displayAmount: "0.0031", ticker: "ETH", source: "probe" },
        perAssetMinDisplay: "0.001",
      }),
    ).toEqual({ kind: "fill", amount: "0.0031", source: "intents-pair" });
  });

  it("accepts an upstream-error minimum too, and matches the ticker case-insensitively", () => {
    expect(
      planMinPreset({
        ...base,
        fromCoin: "eth",
        intentsMinimum: { displayAmount: "0.01", ticker: "ETH", source: "upstream-error" },
      }),
    ).toEqual({ kind: "fill", amount: "0.01", source: "intents-pair" });
  });

  it("falls back to the per-asset deposit floor when the pair minimum is missing or for another coin", () => {
    expect(
      planMinPreset({
        ...base,
        intentsMinimum: { displayAmount: "5", ticker: "POL", source: "probe" },
        perAssetMinDisplay: "0.001",
      }),
    ).toEqual({ kind: "fill", amount: "0.001", source: "intents-asset" });
    expect(planMinPreset({ ...base, perAssetMinDisplay: "0.002" })).toEqual({
      kind: "fill",
      amount: "0.002",
      source: "intents-asset",
    });
  });

  it("waits while the probe is in flight and has nothing else", () => {
    expect(
      planMinPreset({
        ...base,
        intentsMinimum: { displayAmount: "", ticker: "ETH", source: "loading" },
      }),
    ).toEqual({ kind: "wait" });
  });

  it("is disabled with a reason when no minimum is known and nothing can probe", () => {
    const plan = planMinPreset(base);
    expect(plan).toEqual({ kind: "none", reason: expect.stringMatching(/No minimum/) });
  });

  // 2026-09-04: ADA → LTC quoted fine at $223 but the automatic probe (tops
  // out at $5) found no minimum, so MIN sat greyed out. With a probe
  // available the button asks NEAR instead.
  it("probes on demand when no minimum is known but the pair can be asked", () => {
    expect(planMinPreset({ ...base, probeAvailable: true })).toEqual({ kind: "probe" });
    expect(planMinPreset({ ...base, preferredRouter: "auto", probeAvailable: true })).toEqual({
      kind: "probe",
    });
    // A known minimum still wins over probing.
    expect(
      planMinPreset({ ...base, probeAvailable: true, perAssetMinDisplay: "3" }).kind,
    ).toBe("fill");
    // …and so does a probe already in flight.
    expect(
      planMinPreset({
        ...base,
        probeAvailable: true,
        intentsMinimum: { displayAmount: "", ticker: "ETH", source: "loading" },
      }),
    ).toEqual({ kind: "wait" });
  });

  it("treats swapkit like intents", () => {
    expect(
      planMinPreset({ ...base, preferredRouter: "swapkit", perAssetMinDisplay: "1" }).kind,
    ).toBe("fill");
  });
});

describe("planMinPreset — auto and the desk", () => {
  it("auto uses NEAR's minimum when known, else the P2P book when the pair has one", () => {
    expect(
      planMinPreset({
        ...base,
        preferredRouter: "auto",
        basicswapRoutable: true,
        intentsMinimum: { displayAmount: "0.5", ticker: "ETH", source: "probe" },
      }),
    ).toEqual({ kind: "fill", amount: "0.5", source: "intents-pair" });
    expect(
      planMinPreset({ ...base, preferredRouter: "auto", basicswapRoutable: true }),
    ).toEqual({ kind: "book" });
    expect(planMinPreset({ ...base, preferredRouter: "auto" }).kind).toBe("none");
  });

  it("the Zephyr desk publishes no minimum — disabled, with the reason as the tooltip", () => {
    const plan = planMinPreset({ ...base, preferredRouter: "pwnda-desk" });
    expect(plan.kind).toBe("none");
    expect(minPresetTitle(plan)).toMatch(/desk/i);
  });
});

describe("a stopped node has no book to read (2026-09-05)", () => {
  it("refuses the book path when the node is known to be down", () => {
    const plan = planMinPreset({
      preferredRouter: "basicswap",
      basicswapRoutable: true,
      nodeRunning: false,
    } as Parameters<typeof planMinPreset>[0]);
    expect(plan.kind).toBe("none");
    expect(plan.kind === "none" && plan.reason).toMatch(/not running/i);
  });

  it("still reads the book when the node is up, or when liveness is unknown", () => {
    for (const nodeRunning of [true, undefined]) {
      const plan = planMinPreset({
        preferredRouter: "basicswap",
        basicswapRoutable: true,
        nodeRunning,
      } as Parameters<typeof planMinPreset>[0]);
      expect(plan.kind, `nodeRunning=${nodeRunning}`).toBe("book");
    }
  });
});
