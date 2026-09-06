/**
 * The share pass's report must be READABLE by the card, including a pass that
 * finished before the card mounted — the automatic pass runs at app start and
 * the Settings view mounts whenever the user gets there.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  lastSharePass,
  recordSharePass,
  resetSharePassLog,
  subscribeSharePass,
} from "./sharePassLog";

describe("the share-pass log", () => {
  beforeEach(() => resetSharePassLog());

  it("has nothing to say before a pass runs", () => {
    expect(lastSharePass()).toBeNull();
  });

  it("keeps the last pass for a card that mounts later", () => {
    recordSharePass({ shared: ["BTC", "LTC"], errors: [] });
    expect(lastSharePass()?.shared).toEqual(["BTC", "LTC"]);
    expect(lastSharePass()?.at).toBeGreaterThan(0);
  });

  it("delivers a pass to a subscriber that was already listening", () => {
    const seen: string[][] = [];
    const off = subscribeSharePass((r) => seen.push(r.errors));
    recordSharePass({
      shared: [],
      errors: [
        "BCH: the swap node's current balance for this coin could not be read, so its wallet was not replaced",
      ],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toContain("could not be read");
    off();
    recordSharePass({ shared: [], errors: ["later"] });
    expect(seen).toHaveLength(1);
  });

  it("copies the arrays, so a later mutation cannot rewrite history", () => {
    const errors = ["first"];
    recordSharePass({ shared: [], errors });
    errors.push("second");
    expect(lastSharePass()?.errors).toEqual(["first"]);
  });

  it("survives a subscriber that throws", () => {
    subscribeSharePass(() => {
      throw new Error("a render crashed");
    });
    const seen: number[] = [];
    subscribeSharePass((r) => seen.push(r.at));
    expect(() => recordSharePass({ shared: ["BCH"], errors: [] })).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(lastSharePass()?.shared).toEqual(["BCH"]);
  });
});
