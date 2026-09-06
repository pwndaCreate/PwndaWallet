/**
 * `basicswapLegsFor` / `isBasicswapRoutable` — direct coverage.
 *
 * Extended 2026-08-22 to also accept scripted<->scripted pairs (e.g.
 * BTC<->LTC), after the operator flagged — with a screenshot of the node's
 * own console showing live "0.0633 BTC -> 92.2000 Litecoin" and
 * "303.9931 Litecoin -> 0.2000 Bitcoin" offers — that the wallet refused to
 * let two bitcoin-family coins pair directly, even though the real book
 * carries exactly that. Was previously requiring exactly one scriptless
 * (XMR/ZEPH) leg unconditionally, which is the `XMR_SWAP` protocol's rule,
 * not the route's. See `BASICSWAP_COUNTERPARTY_TICKERS`'s doc comment in
 * `useSidecarSwap.ts` for what was verified before widening it (the amount/
 * rate math, the floor computation, and the bid write path are all already
 * swap_type-agnostic).
 *
 * Extended again 2026-09-03 (Grove expansion plan, Phase C unit C-T1): ZEPH
 * and ZANO became real BasicSwap follower coins once Phase B's engine
 * patches (13-17) gave both a chainclient. **This inverts one of the
 * assertions this file used to make** — "ZEPH is not a BasicSwap coin at
 * all" was true on 2026-08-22 and is false now; that test is replaced below
 * rather than silently deleted, per the bug-documentation protocol (a wrong
 * claim gets corrected in place with the correction visible, not erased).
 * The new pair-matrix cases pin the hard product rule from
 * `grove-expansion-master-plan.md` § 1: followers pair with BTC/LTC/BCH
 * only — never XMR, each other, DOGE or DASH.
 */
import { describe, it, expect } from "vitest";
import { basicswapLegsFor, isBasicswapRoutable } from "./useSidecarSwap";

describe("basicswapLegsFor / isBasicswapRoutable", () => {
  it("XMR_SWAP: scriptless (XMR) opposite a counterparty is routable, either direction", () => {
    expect(isBasicswapRoutable("XMR", "BTC")).toBe(true);
    expect(isBasicswapRoutable("BTC", "XMR")).toBe(true);
    expect(isBasicswapRoutable("XMR", "LTC")).toBe(true);
    expect(isBasicswapRoutable("DOGE", "XMR")).toBe(true);
  });

  it("scripted<->scripted: two DIFFERENT counterparties are routable, either direction", () => {
    expect(isBasicswapRoutable("BTC", "LTC")).toBe(true);
    expect(isBasicswapRoutable("LTC", "BTC")).toBe(true);
    expect(isBasicswapRoutable("BTC", "DOGE")).toBe(true);
    expect(isBasicswapRoutable("DASH", "BCH")).toBe(true);
  });

  it("scriptless<->scriptless (any pair among XMR/ZEPH/ZANO) is never routable — no protocol variant makes it", () => {
    expect(isBasicswapRoutable("XMR", "ZEPH")).toBe(false);
    expect(isBasicswapRoutable("ZEPH", "XMR")).toBe(false);
    expect(isBasicswapRoutable("XMR", "ZANO")).toBe(false);
    expect(isBasicswapRoutable("ZANO", "XMR")).toBe(false);
    // "Never each other" — the hard product rule from
    // grove-expansion-master-plan.md § 1 falls straight out of this same
    // two-scriptless check; no separate ZEPH/ZANO-specific code exists.
    expect(isBasicswapRoutable("ZEPH", "ZANO")).toBe(false);
    expect(isBasicswapRoutable("ZANO", "ZEPH")).toBe(false);
  });

  it("a coin never pairs with itself", () => {
    expect(isBasicswapRoutable("BTC", "BTC")).toBe(false);
    expect(isBasicswapRoutable("XMR", "XMR")).toBe(false);
    expect(isBasicswapRoutable("btc", "BTC")).toBe(false);
  });

  it("an unrecognised coin on either side is never routable", () => {
    expect(isBasicswapRoutable("ETH", "BTC")).toBe(false);
    expect(isBasicswapRoutable("BTC", "SOL")).toBe(false);
    expect(isBasicswapRoutable("ETH", "SOL")).toBe(false);
    expect(isBasicswapRoutable("ETH", "XMR")).toBe(false);
  });

  it("CORRECTED 2026-09-03 (was: 'ZEPH is not a BasicSwap coin at all', true as of 2026-08-22, false since Phase B/patches 13-17): ZEPH and ZANO are now real followers, pairing with BTC/LTC/BCH in either direction", () => {
    for (const follower of ["ZEPH", "ZANO"]) {
      for (const partner of ["BTC", "LTC", "BCH"]) {
        expect(isBasicswapRoutable(follower, partner), `${follower}->${partner}`).toBe(true);
        expect(isBasicswapRoutable(partner, follower), `${partner}->${follower}`).toBe(true);
      }
    }
  });

  it("followers refuse DOGE and DASH — hard product rule (grove-expansion-master-plan.md § 1), narrower than XMR's own counterparty set", () => {
    for (const follower of ["ZEPH", "ZANO"]) {
      for (const excluded of ["DOGE", "DASH"]) {
        expect(isBasicswapRoutable(follower, excluded), `${follower}->${excluded}`).toBe(false);
        expect(isBasicswapRoutable(excluded, follower), `${excluded}->${follower}`).toBe(false);
      }
    }
    // The contrast that makes this a real narrowing and not a global
    // DOGE/DASH removal: XMR keeps pairing with both.
    expect(isBasicswapRoutable("XMR", "DOGE")).toBe(true);
    expect(isBasicswapRoutable("XMR", "DASH")).toBe(true);
  });

  it("followers never pair with PART — this wallet has no Particl wallet adapter to receive into (see FOLLOWER_COUNTERPARTY_TICKERS's doc)", () => {
    expect(isBasicswapRoutable("ZEPH", "PART")).toBe(false);
    expect(isBasicswapRoutable("ZANO", "PART")).toBe(false);
  });

  it("basicswapLegsFor carries follower pairs uppercased too", () => {
    expect(basicswapLegsFor("zeph", "ltc")).toEqual({
      sendTicker: "ZEPH",
      receiveTicker: "LTC",
    });
    expect(basicswapLegsFor("bch", "zano")).toEqual({
      sendTicker: "BCH",
      receiveTicker: "ZANO",
    });
  });

  it("is case-insensitive on both sides", () => {
    expect(isBasicswapRoutable("btc", "ltc")).toBe(true);
    expect(isBasicswapRoutable("xmr", "btc")).toBe(true);
  });

  it("basicswapLegsFor carries the tickers uppercased, in the order given", () => {
    expect(basicswapLegsFor("ltc", "btc")).toEqual({
      sendTicker: "LTC",
      receiveTicker: "BTC",
    });
    expect(basicswapLegsFor("xmr", "ltc")).toEqual({
      sendTicker: "XMR",
      receiveTicker: "LTC",
    });
  });

  it("basicswapLegsFor returns null for every non-routable case", () => {
    expect(basicswapLegsFor("XMR", "ZEPH")).toBeNull();
    expect(basicswapLegsFor("BTC", "BTC")).toBeNull();
    expect(basicswapLegsFor("ETH", "SOL")).toBeNull();
  });
});
