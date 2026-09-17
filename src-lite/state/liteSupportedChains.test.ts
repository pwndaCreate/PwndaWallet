/**
 * PwndaLite's paste-an-address list must cover the whole mining roster.
 *
 * ZANO joined `MINING_COINS` on 2026-08-28 and never reached
 * `LITE_SUPPORTED_CHAINS`: Lite rendered a ZANO tile (the roster is shared) but
 * Settings had no ZANO address field, so `addressFor("zano")` was always null
 * and the Start button could only ever say "no mining address". Found
 * 2026-09-15 while adding XEL, by diffing the two lists by hand. This test is
 * that diff, so the next coin cannot repeat it.
 */
import { describe, it, expect } from "vitest";
import { LITE_SUPPORTED_CHAINS } from "./AppStateLite";
import { MINING_COINS } from "../../src/features/mining/miningCoins";

describe("LITE_SUPPORTED_CHAINS", () => {
  it("covers exactly the coins on the shared mining roster", () => {
    const roster = MINING_COINS.map((c) => c.chain).sort();
    expect([...LITE_SUPPORTED_CHAINS].sort()).toEqual(roster);
  });
});
