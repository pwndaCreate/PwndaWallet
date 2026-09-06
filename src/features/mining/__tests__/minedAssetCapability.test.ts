/**
 * What each mineable coin is allowed to claim about its own value.
 *
 * # Why this is a test and not just a table
 *
 * The Mine hero shows a projected balance in another asset. That claim is only
 * honest for a coin with a real two-hop route out (XMR today). The failure
 * mode is silent and expensive: a coin gets added to the roster, nobody
 * revisits the capability, and the hero starts projecting a conversion that
 * cannot happen — a statement about the user's money that no route backs.
 *
 * So the default is asserted to be the CONSERVATIVE one, and each coin's tier
 * is pinned with the reason it has that tier.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CAPABILITY,
  canProjectAsset,
  capabilityFor,
} from "../minedAssetCapability";
import { MINING_COINS } from "../miningCoins";

describe("capability tiers", () => {
  it("only XMR may project an asset balance today", () => {
    expect(canProjectAsset("monero")).toBe(true);
    for (const c of ["zephyr", "zano", "ravencoin", "conflux", "ergo"] as const) {
      expect(canProjectAsset(c)).toBe(false);
    }
  });

  it("ZEPH and ZANO are priced but not routable, and say when that changes", () => {
    for (const c of ["zephyr", "zano"] as const) {
      const cap = capabilityFor(c);
      expect(cap.kind).toBe("usd-only");
      // The note is the user-visible promise; it must name Grove so the
      // "come back when it lands" is legible rather than a shrug.
      expect(cap.kind === "usd-only" && cap.note).toMatch(/Grove/i);
    }
  });

  it("RVN, CFX and ERG have no route and fall back to daily revenue", () => {
    for (const c of ["ravencoin", "conflux", "ergo"] as const) {
      const cap = capabilityFor(c);
      expect(cap.kind).toBe("unavailable");
      expect(cap.kind === "unavailable" && cap.note).toMatch(/daily revenue/i);
    }
  });

  /**
   * The load-bearing one. A coin added to the roster without a capability
   * decision must claim NOTHING rather than inherit XMR's.
   */
  it("an unlisted coin defaults to claiming nothing", () => {
    expect(DEFAULT_CAPABILITY.kind).toBe("unavailable");
    expect(canProjectAsset("bitcoin")).toBe(false);
  });

  it("every coin on the mining roster has a decided capability", () => {
    // Not "has an entry" — has one that was thought about. A coin falling to
    // the default is fine at runtime and worth flagging here, because the
    // default is a placeholder, not an answer.
    const undecided = MINING_COINS.filter(
      (c) => capabilityFor(c.chain) === DEFAULT_CAPABILITY,
    ).map((c) => c.sym);
    expect(undecided).toEqual([]);
  });
});
