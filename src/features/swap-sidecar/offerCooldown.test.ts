import { beforeEach, describe, expect, it } from "vitest";
import {
  COOLDOWN_MS,
  COOLDOWN_REASON_EXPIRED,
  COOLDOWN_STORAGE_KEY,
  applyCooldown,
  clearCooldowns,
  coolDown,
  cooldownRemaining,
  isCooledDown,
  loadCooldowns,
  makerKey,
  offerKey,
  withCooldown,
} from "./offerCooldown";

/** The 2026-09-05 incident's own numbers. */
const SLEEPING = {
  offerId: "000000006a9c4d37ced68140006b4d29c44aaa4b3b8a00270a0d3402",
  makerAddress: "Pm3TUKpqC9CRtXpR5wVNxHDuLWo5DaWhn8",
};
const OTHER = { offerId: "00000000ffff1111", makerAddress: "PmSomeoneElse999" };
const NOW = 1_788_650_000_000;

describe("withCooldown / isCooledDown", () => {
  it("cools the offer AND its maker, because makers re-post", () => {
    const list = withCooldown([], SLEEPING, NOW, COOLDOWN_REASON_EXPIRED);
    expect(list.map((e) => e.key).sort()).toEqual(
      [offerKey(SLEEPING.offerId), makerKey(SLEEPING.makerAddress)].sort(),
    );
    expect(isCooledDown(list, SLEEPING, NOW)).toBe(true);
    // The same maker under a NEW offer id is still cooled — that is the whole
    // reason the maker key exists. A maker who expired one bid is advertising
    // an identical replacement within minutes.
    expect(
      isCooledDown(list, { offerId: "a-brand-new-id", makerAddress: SLEEPING.makerAddress }, NOW),
    ).toBe(true);
    // Somebody else is untouched.
    expect(isCooledDown(list, OTHER, NOW)).toBe(false);
  });

  it("expires by itself — it is a cooldown, not a ban", () => {
    const list = withCooldown([], SLEEPING, NOW, COOLDOWN_REASON_EXPIRED);
    expect(isCooledDown(list, SLEEPING, NOW + COOLDOWN_MS - 1)).toBe(true);
    expect(isCooledDown(list, SLEEPING, NOW + COOLDOWN_MS + 1)).toBe(false);
    // ...and outlives one offer's own hour-long life, or the same
    // advertisement would come back while it is still live.
    expect(COOLDOWN_MS).toBeGreaterThan(60 * 60 * 1000);
  });

  it("extends rather than stacks when the same maker fails twice", () => {
    const first = withCooldown([], SLEEPING, NOW, "one");
    const second = withCooldown(first, SLEEPING, NOW + 60_000, "two");
    expect(second).toHaveLength(2);
    expect(new Set(second.map((e) => e.until))).toEqual(new Set([NOW + 60_000 + COOLDOWN_MS]));
    expect(second.every((e) => e.reason === "two")).toBe(true);
  });

  it("handles an offer with no maker address", () => {
    const list = withCooldown([], { offerId: "abc", makerAddress: null }, NOW, "r");
    expect(list).toHaveLength(1);
    expect(isCooledDown(list, { offerId: "abc" }, NOW)).toBe(true);
  });
});

describe("applyCooldown", () => {
  const pool = [SLEEPING, OTHER];

  it("drops the cooled maker and says how many", () => {
    const cool = withCooldown([], SLEEPING, NOW, COOLDOWN_REASON_EXPIRED);
    const out = applyCooldown(pool, cool, NOW);
    expect(out.offers).toEqual([OTHER]);
    expect(out.skipped).toBe(1);
    expect(out.exhausted).toBe(false);
  });

  /**
   * The property that keeps this a preference rather than a safety rule. If
   * every maker on a thin book were cooled down, hiding the whole book would
   * read as "the swap node is broken" — which is worse than the maker who may
   * simply have woken up since.
   */
  it("never turns a non-empty book into an empty one", () => {
    let cool = withCooldown([], SLEEPING, NOW, "r");
    cool = withCooldown(cool, OTHER, NOW, "r");
    const out = applyCooldown(pool, cool, NOW);
    expect(out.offers).toEqual(pool);
    expect(out.exhausted).toBe(true);
    expect(out.skipped).toBe(0);
  });

  it("is a no-op with no cooldowns, and on an empty book", () => {
    expect(applyCooldown(pool, [], NOW).offers).toEqual(pool);
    expect(applyCooldown([], withCooldown([], SLEEPING, NOW, "r"), NOW).offers).toEqual([]);
  });
});

/**
 * `localStorage` does not exist in the test environment, and in a real browser
 * it can also THROW outright — a private window, a preview/thumbnail context,
 * a browser set to block site data. Both are stubbed here rather than skipped,
 * because "the fee-free convenience took the Swap tab down with it" is the
 * failure this module's guards exist to prevent, and a test that cannot run
 * the guard cannot show it works.
 */
function stubStorage(mode: "ok" | "throws"): Record<string, string> {
  const jar: Record<string, string> = {};
  const boom = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  (globalThis as { localStorage?: unknown }).localStorage =
    mode === "throws"
      ? { getItem: boom, setItem: boom, removeItem: boom }
      : {
          getItem: (k: string) => (k in jar ? jar[k] : null),
          setItem: (k: string, v: string) => {
            jar[k] = v;
          },
          removeItem: (k: string) => {
            delete jar[k];
          },
        };
  return jar;
}

describe("persistence", () => {
  let jar: Record<string, string>;
  beforeEach(() => {
    jar = stubStorage("ok");
    clearCooldowns();
  });

  it("round-trips and prunes on read", () => {
    coolDown(SLEEPING, COOLDOWN_REASON_EXPIRED, NOW);
    expect(isCooledDown(loadCooldowns(NOW), SLEEPING, NOW)).toBe(true);
    // Read from beyond the window: gone, without anything having to sweep it.
    expect(loadCooldowns(NOW + COOLDOWN_MS + 1)).toEqual([]);
  });

  it("survives junk in storage rather than throwing into the render", () => {
    for (const junk of ["", "{", "null", '{"not":"an array"}', '[{"key":1}]']) {
      jar[COOLDOWN_STORAGE_KEY] = junk;
      expect(loadCooldowns(NOW)).toEqual([]);
    }
  });

  it("survives storage that throws — the private-window case", () => {
    stubStorage("throws");
    expect(() => loadCooldowns(NOW)).not.toThrow();
    expect(loadCooldowns(NOW)).toEqual([]);
    expect(() => coolDown(SLEEPING, COOLDOWN_REASON_EXPIRED, NOW)).not.toThrow();
    expect(() => clearCooldowns()).not.toThrow();
  });
});

describe("cooldownRemaining", () => {
  it("reads as minutes, then hours", () => {
    const e = { key: "k", until: NOW + 42 * 60_000, reason: "r", label: "l" };
    expect(cooldownRemaining(e, NOW)).toBe("42 min");
    expect(cooldownRemaining({ ...e, until: NOW + 65 * 60_000 }, NOW)).toBe("1h 05m");
    expect(cooldownRemaining({ ...e, until: NOW - 1 }, NOW)).toBe("0 min");
  });
});
