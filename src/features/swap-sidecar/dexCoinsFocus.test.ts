/**
 * The tile → editor channel.
 *
 * Reported 2026-09-04: *"I am unable to click the other coins for the swap node
 * while its running to enable them, and if I stop the swap node the coins
 * disappear."* Both halves were real:
 *
 *  - the tiles were `<div>`s with no handler — read-only by design, but drawn
 *    exactly like toggles, so the click went nowhere;
 *  - the stopped state rendered `status.coins.join(", ")` instead of the tiles,
 *    and that list contains only CONFIGURED coins — so a coin you had never
 *    enabled (BCH, the one the user wanted) was not merely un-clickable, it was
 *    absent from the screen entirely, in the one state you would sit down to
 *    change the coin set.
 *
 * This file covers the channel. The rendering half is covered by the panel's
 * own tests plus the type-checker; what is worth pinning here is that a request
 * with no editor mounted is a no-op rather than a throw, and that one broken
 * listener cannot silence the others — the failure modes that would turn "the
 * click does nothing" into "the click does nothing AND the card errors out".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  requestDexCoinsFocus,
  onDexCoinsFocus,
  __resetDexCoinsFocus,
} from "./dexCoinsFocus";

describe("dexCoinsFocus", () => {
  beforeEach(() => __resetDexCoinsFocus());

  it("delivers a request to a mounted listener", () => {
    const seen = vi.fn();
    onDexCoinsFocus(seen);
    requestDexCoinsFocus();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no editor is mounted — never throws", () => {
    // The swap-node card renders on surfaces where the Settings section is not
    // mounted. A throw here would take out the card over a navigation nicety.
    expect(() => requestDexCoinsFocus()).not.toThrow();
  });

  it("stops delivering after unsubscribe", () => {
    const seen = vi.fn();
    const off = onDexCoinsFocus(seen);
    off();
    requestDexCoinsFocus();
    expect(seen).not.toHaveBeenCalled();
  });

  it("one throwing listener does not stop the others", () => {
    const ok = vi.fn();
    onDexCoinsFocus(() => {
      throw new Error("scrollIntoView unavailable");
    });
    onDexCoinsFocus(ok);
    expect(() => requestDexCoinsFocus()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("a listener that unsubscribes itself mid-delivery does not perturb the rest", () => {
    // Both Settings surfaces can be mounted across a layout switch; one
    // unmounting while the other handles must not skip the survivor.
    const survivor = vi.fn();
    const off = onDexCoinsFocus(() => off());
    onDexCoinsFocus(survivor);
    expect(() => requestDexCoinsFocus()).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
  });

  it("delivers to every mounted listener, not just the first", () => {
    const a = vi.fn();
    const b = vi.fn();
    onDexCoinsFocus(a);
    onDexCoinsFocus(b);
    requestDexCoinsFocus();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
