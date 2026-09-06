/**
 * The Zephyr conversion topology.
 *
 * The operator described it as rock-paper-scissors: some pairs convert
 * directly and some must be "gated through Zusd". Getting a route wrong here
 * is not a cosmetic bug — it offers the user a conversion the chain will
 * reject, which costs them a failed transaction to discover.
 *
 * The expected shape is taken from `wiki/entities/Zephyr.md`, not from the
 * implementation, so this is a check against the protocol rather than a mirror
 * of the code.
 */
import { describe, it, expect } from "vitest";
import {
  directNeighbours,
  isDirect,
  legKind,
  reachableFrom,
  routeFor,
  routeHint,
} from "../zephyrRoutes";
import { ZPH_ASSETS } from "../../../wallets/zph-rpc";

describe("direct pairs — one transaction", () => {
  it("ZPH mints and redeems both derived assets", () => {
    expect(isDirect("ZPH", "ZSD")).toBe(true);
    expect(isDirect("ZPH", "ZRS")).toBe(true);
    // Symmetric: redeem is the same edge travelled backwards.
    expect(isDirect("ZSD", "ZPH")).toBe(true);
    expect(isDirect("ZRS", "ZPH")).toBe(true);
  });

  it("the yield wrapper attaches to the STABLE, not the base coin", () => {
    expect(isDirect("ZSD", "ZYS")).toBe(true);
    // The one the modal's copy already called out by name.
    expect(isDirect("ZPH", "ZYS")).toBe(false);
  });

  it("the two derived assets do not touch each other", () => {
    expect(isDirect("ZSD", "ZRS")).toBe(false);
    expect(isDirect("ZRS", "ZYS")).toBe(false);
  });

  it("an asset is not directly convertible to itself", () => {
    for (const a of ZPH_ASSETS) expect(isDirect(a, a)).toBe(false);
  });
});

describe("indirect routes are gated through the right intermediate", () => {
  it("ZPH to ZYS goes via ZSD — mint, then stake", () => {
    const r = routeFor("ZPH", "ZYS")!;
    expect(r.via).toEqual(["ZSD"]);
    expect(r.legs.map((l) => l.kind)).toEqual(["mint", "stake"]);
  });

  it("ZSD to ZRS goes via ZPH — redeem, then mint", () => {
    // The pair the modal had no copy for at all, so it simply looked
    // available.
    const r = routeFor("ZSD", "ZRS")!;
    expect(r.via).toEqual(["ZPH"]);
    expect(r.legs.map((l) => l.kind)).toEqual(["redeem", "mint"]);
  });

  it("ZRS to ZYS is THREE legs, via ZPH then ZSD", () => {
    // The case nobody would hand-write correctly, which is why the route is
    // searched rather than enumerated.
    const r = routeFor("ZRS", "ZYS")!;
    expect(r.via).toEqual(["ZPH", "ZSD"]);
    expect(r.legs).toHaveLength(3);
    expect(r.legs.map((l) => l.kind)).toEqual(["redeem", "mint", "stake"]);
  });

  it("every route is reversible with the legs mirrored", () => {
    const there = routeFor("ZRS", "ZYS")!;
    const back = routeFor("ZYS", "ZRS")!;
    expect(back.legs).toHaveLength(there.legs.length);
    expect(back.via).toEqual([...there.via].reverse());
  });
});

describe("every pair is reachable, and nothing is stranded", () => {
  it("all four assets connect to all others", () => {
    for (const from of ZPH_ASSETS) {
      const reach = reachableFrom(from, ZPH_ASSETS);
      expect(reach).toHaveLength(ZPH_ASSETS.length - 1);
      for (const r of reach) expect(r.legs).toBeGreaterThan(0);
    }
  });

  it("same-asset is not a route", () => {
    for (const a of ZPH_ASSETS) expect(routeFor(a, a)).toBeNull();
  });

  it("the direct graph is connected", () => {
    for (const a of ZPH_ASSETS) {
      expect(directNeighbours(a).length).toBeGreaterThan(0);
    }
  });
});

describe("the verbs match the protocol's own vocabulary", () => {
  it("leaving the base coin mints, returning redeems", () => {
    expect(legKind("ZPH", "ZSD")).toBe("mint");
    expect(legKind("ZSD", "ZPH")).toBe("redeem");
    expect(legKind("ZPH", "ZRS")).toBe("mint");
    expect(legKind("ZRS", "ZPH")).toBe("redeem");
  });

  it("the yield leg stakes and unstakes", () => {
    // "mint ZEPHYRS" would be the wrong promise to show a user.
    expect(legKind("ZSD", "ZYS")).toBe("stake");
    expect(legKind("ZYS", "ZSD")).toBe("unstake");
  });
});

describe("the hint explains multi-leg routes and stays quiet otherwise", () => {
  it("says nothing for a direct pair", () => {
    expect(routeHint(routeFor("ZPH", "ZSD"))).toBeNull();
  });

  it("names the legs and the intermediates", () => {
    const hint = routeHint(routeFor("ZPH", "ZYS"))!;
    expect(hint).toContain("2 transactions");
    expect(hint).toContain("ZSD");
    expect(hint).toContain("mint then stake");
  });
});
