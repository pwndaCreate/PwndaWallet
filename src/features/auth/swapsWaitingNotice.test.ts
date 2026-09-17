import { describe, expect, it } from "vitest";
import { swapsWaitingLines } from "./swapsWaitingNotice";

// 2026-09-15: a node that starts while the vault is locked cannot run its
// swaps until the unlock, and the lock screen had no way to say so.
describe("swapsWaitingLines", () => {
  const now = new Date(2026, 8, 15, 12, 0, 0);
  const at = (d: Date) => Math.floor(d.getTime() / 1000);

  it("says nothing when there is nothing in progress", () => {
    expect(swapsWaitingLines(null, now)).toBeNull();
    expect(swapsWaitingLines(undefined, now)).toBeNull();
    expect(swapsWaitingLines({ inProgress: 0, at: at(now) }, now)).toBeNull();
    expect(swapsWaitingLines({ inProgress: Number.NaN, at: at(now) }, now)).toBeNull();
  });

  it("names one swap in the singular", () => {
    const lines = swapsWaitingLines({ inProgress: 1, at: at(now) }, now);
    expect(lines).not.toBeNull();
    expect(lines![0]).toContain("1 swap in progress");
    expect(lines![1]).toContain("to continue it.");
  });

  it("names several in the plural", () => {
    const lines = swapsWaitingLines({ inProgress: 3, at: at(now) }, now);
    expect(lines![0]).toContain("3 swaps in progress");
    expect(lines![1]).toContain("to continue them.");
  });

  it("says the count is a past reading, and when it was taken", () => {
    const earlier = new Date(2026, 8, 12, 9, 30, 0);
    const lines = swapsWaitingLines({ inProgress: 2, at: at(earlier) }, now);
    expect(lines![0]).toContain("when the swap node last checked (");
    expect(lines![0]).not.toContain("()");
  });
});
