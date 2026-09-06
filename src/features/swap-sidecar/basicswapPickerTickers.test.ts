/**
 * `basicswapPickerTickers` — the route-aware coin roster for the swap form's
 * picker while the BasicSwap route is selected.
 *
 * Pinned 2026-08-22 from the audit finding: the picker was router-blind and
 * listed the NEAR Intents roster (ETH/SOL/BNB/ADA/AVAX/POL/XLM/SUI…) on the
 * P2P tab, none of which BasicSwap can settle. The fix is a pure filter over
 * the caller's list that applies `basicswapLegsFor`'s rule one side at a time.
 *
 * Extended 2026-08-22, same day: the roster was protocol-legal but not
 * activation-aware — DOGE/DASH/BCH showed up in the picker even when the
 * node had never been asked to run them, because they ship off by default
 * (`DEFAULT_ENABLED_COINS` in `swap_sidecar.rs`). `liveEnabled` closes that:
 * the picker now shows exactly the counterparty coins the node currently
 * reports `enabled && configured`, and a coin activated later via Settings
 * appears with no further wiring the next time the node's coin status is
 * re-read.
 *
 * Extended again 2026-09-03 (Grove expansion plan, Phase C unit C-T1): ZEPH
 * and ZANO joined `SIDECAR_SCRIPTLESS_TICKERS` as real BasicSwap follower
 * coins (Phase B, patches 13-17). **Two assertions this file used to make
 * are now wrong and are corrected below, not silently deleted:**
 *   1. "picking ZEPH opposite offers both families — ZEPH is not a
 *      BasicSwap coin" — was true 2026-08-22, is false now.
 *   2. "nothing picked opposite offers `SIDECAR_ONLY_TICKERS ∪
 *      BASICSWAP_COUNTERPARTY_TICKERS`" — `SIDECAR_ONLY_TICKERS` answers a
 *      DIFFERENT question now (see `types.ts`'s doc on both constants) and
 *      was never the right set to union with the counterparty list here;
 *      `SIDECAR_SCRIPTLESS_TICKERS` is.
 * Also new: ZEPH/ZANO are narrower than XMR opposite a counterparty (never
 * DOGE/DASH — grove-expansion-master-plan.md § 1), and unlike XMR they are
 * NOT exempt from the `liveEnabled` gate (they are not in Grove's
 * `DEFAULT_ENABLED_COINS`, so a fresh install must not show them before the
 * DEX-coins card's host-wallet consent step has run).
 */
import { describe, it, expect } from "vitest";
import {
  basicswapPickerTickers,
  BASICSWAP_COUNTERPARTY_TICKERS,
  FOLLOWER_COUNTERPARTY_TICKERS,
  isBasicswapRoutable,
} from "./useSidecarSwap";
import { SIDECAR_SCRIPTLESS_TICKERS } from "./types";

/** A roster shaped like `getDropdownTickers()` — aggregator coins mixed in. */
const ROSTER = [
  "BTC", "ETH", "SOL", "BNB", "ADA", "DOGE", "AVAX", "POL", "LTC", "BCH",
  "XLM", "SUI", "DASH", "MON", "XMR", "ZEPH", "ZANO", "USDC", "USDT", "DAI",
];

const BASICSWAP_SET = new Set([
  ...SIDECAR_SCRIPTLESS_TICKERS,
  ...BASICSWAP_COUNTERPARTY_TICKERS,
]);

describe("basicswapPickerTickers", () => {
  it("with nothing picked opposite, offers every BasicSwap coin and nothing else", () => {
    const out = basicswapPickerTickers(ROSTER, undefined);
    expect(new Set(out)).toEqual(BASICSWAP_SET);
    // Specifically: the aggregator coins that leaked onto the P2P tab are gone.
    for (const leaked of ["ETH", "SOL", "BNB", "ADA", "AVAX", "POL", "XLM", "SUI", "MON", "USDC", "USDT", "DAI"]) {
      expect(out, `${leaked} must not be offered on the BasicSwap route`).not.toContain(leaked);
    }
  });

  it("with XMR picked opposite, offers only XMR's (wider) scripted counterparties", () => {
    const out = basicswapPickerTickers(ROSTER, "XMR");
    expect(new Set(out)).toEqual(new Set(BASICSWAP_COUNTERPARTY_TICKERS));
    expect(out).not.toContain("XMR");
    expect(out).not.toContain("ZEPH");
    expect(out).not.toContain("ZANO");
  });

  it("CORRECTED 2026-09-03 (was: 'ZEPH picked opposite offers both families — ZEPH is not a BasicSwap coin', true 2026-08-22, false since Phase B): ZEPH/ZANO opposite offers only the NARROWER follower counterparties", () => {
    // ZEPH and ZANO are now real BasicSwap follower coins (patches 13-17),
    // but with a counterparty set NARROWER than XMR's — see
    // FOLLOWER_COUNTERPARTY_TICKERS's doc. Picking one opposite must show
    // BTC/LTC/BCH only, never DOGE/DASH and never another scriptless coin.
    for (const follower of ["ZEPH", "ZANO"]) {
      const out = basicswapPickerTickers(ROSTER, follower);
      expect(new Set(out), follower).toEqual(new Set(FOLLOWER_COUNTERPARTY_TICKERS));
      expect(out, follower).not.toContain("XMR");
      expect(out, follower).not.toContain("DOGE");
      expect(out, follower).not.toContain("DASH");
      expect(out, follower).not.toContain(follower === "ZEPH" ? "ZANO" : "ZEPH");
    }
  });

  it("with a counterparty (LTC) picked opposite, offers every scriptless leg it can legally pair with AND every OTHER counterparty", () => {
    // Corrected 2026-08-22: was narrowed to the scriptless leg alone, which
    // is the XMR_SWAP protocol's rule, not the route's — BasicSwap's
    // scripted<->scripted protocol lets LTC pair directly with BTC/DOGE/
    // DASH/BCH too (verified live on the node's own console). LTC itself is
    // excluded — a coin never pairs with itself. LTC is in
    // FOLLOWER_COUNTERPARTY_TICKERS too, so as of 2026-09-03 ZEPH/ZANO join
    // XMR here (this was the SIDECAR_ONLY_TICKERS-vs-SIDECAR_SCRIPTLESS_
    // TICKERS distinction this file's header explains).
    const out = basicswapPickerTickers(ROSTER, "LTC");
    const expected = new Set([
      ...SIDECAR_SCRIPTLESS_TICKERS,
      ...BASICSWAP_COUNTERPARTY_TICKERS.filter((t) => t !== "LTC"),
    ]);
    expect(new Set(out)).toEqual(expected);
    expect(out).not.toContain("LTC");
  });

  it("with a DOGE/DASH counterparty picked opposite, offers XMR but NOT ZEPH/ZANO — the follower narrowing in the OTHER direction", () => {
    // The asymmetric half of the follower rule: it isn't enough that
    // basicswapLegsFor(ZEPH, DOGE) is false — the picker must also not
    // offer ZEPH/ZANO when DOGE or DASH is already picked on the other
    // side, or the two controls would disagree about what's legal.
    for (const excluded of ["DOGE", "DASH"]) {
      const out = basicswapPickerTickers(ROSTER, excluded);
      expect(out, excluded).toContain("XMR");
      expect(out, excluded).not.toContain("ZEPH");
      expect(out, excluded).not.toContain("ZANO");
    }
  });

  it("scripted<->scripted: BTC opposite offers LTC/DOGE/DASH/BCH plus every scriptless leg, matching the live book", () => {
    // The operator's bug report: the node's own console shows live BTC<->LTC
    // offers, but picking BTC opposite only ever offered XMR. Screenshot-
    // verified real offers on the network: "0.0633 BTC -> 92.2000 Litecoin",
    // "303.9931 Litecoin -> 0.2000 Bitcoin".
    const out = basicswapPickerTickers(ROSTER, "BTC");
    expect(out).toContain("LTC");
    expect(out).toContain("DOGE");
    expect(out).toContain("DASH");
    expect(out).toContain("BCH");
    expect(out).toContain("XMR");
    // BTC is in FOLLOWER_COUNTERPARTY_TICKERS, so ZEPH/ZANO are legal here too.
    expect(out).toContain("ZEPH");
    expect(out).toContain("ZANO");
    expect(out).not.toContain("BTC");
  });

  it("with a non-BasicSwap coin left over opposite (ETH from another tab), offers both families", () => {
    // The user switched to P2P while ETH was still selected on one side. The
    // picker on the OTHER side must let them reach a valid pair from either
    // family, not lock them out because of a stale selection.
    const out = basicswapPickerTickers(ROSTER, "ETH");
    expect(new Set(out)).toEqual(BASICSWAP_SET);
  });

  it("is case-insensitive about the opposite ticker", () => {
    expect(new Set(basicswapPickerTickers(ROSTER, "xmr"))).toEqual(
      new Set(BASICSWAP_COUNTERPARTY_TICKERS),
    );
  });

  it("preserves the caller's ordering — it filters, it does not re-sort", () => {
    const out = basicswapPickerTickers(ROSTER, undefined);
    const expectedOrder = ROSTER.filter((t) => BASICSWAP_SET.has(t));
    expect(out).toEqual(expectedOrder);
  });

  it("liveEnabled narrows the counterparty leg — AND ZEPH/ZANO, which are not exempt — to what the node actually has on", () => {
    const out = basicswapPickerTickers(ROSTER, undefined, new Set(["BTC", "LTC"]));
    expect(new Set(out)).toEqual(new Set(["XMR", "BTC", "LTC"]));
    for (const off of ["DOGE", "DASH", "BCH", "ZEPH", "ZANO"]) {
      expect(out, `${off} is not enabled and must not be offered`).not.toContain(off);
    }
  });

  it("liveEnabled does not gate the scriptless leg (XMR) — but DOES gate ZEPH/ZANO, unlike XMR", () => {
    // XMR is DEFAULT_ENABLED_COINS and has no local chain to wait on, so
    // gating it too would blank the picker for a split second on every
    // fresh opt-in. A liveEnabled set that (unrealistically) omits XMR must
    // still offer it. ZEPH/ZANO are the opposite case: Grove does NOT ship
    // them in DEFAULT_ENABLED_COINS (they need the DEX-coins card's
    // explicit host-wallet consent), so a liveEnabled set that omits them
    // must exclude them, exactly like an ordinary counterparty coin.
    const out = basicswapPickerTickers(ROSTER, undefined, new Set(["BTC"]));
    expect(out).toContain("XMR");
    expect(out).not.toContain("ZEPH");
    expect(out).not.toContain("ZANO");
  });

  it("liveEnabled including ZEPH/ZANO shows them, same as any consented-and-configured coin", () => {
    const out = basicswapPickerTickers(ROSTER, undefined, new Set(["BTC", "ZEPH", "ZANO"]));
    expect(out).toContain("ZEPH");
    expect(out).toContain("ZANO");
  });

  it("omitting liveEnabled shows the full protocol-legal roster, not an empty one", () => {
    // The state before the node's first coin-status reply lands — must not
    // read as "nothing is enabled".
    expect(new Set(basicswapPickerTickers(ROSTER, undefined))).toEqual(BASICSWAP_SET);
    expect(new Set(basicswapPickerTickers(ROSTER, undefined, null))).toEqual(BASICSWAP_SET);
  });

  it("never offers a coin the caller did not supply", () => {
    // A roster missing DASH (e.g. the wallet derives no DASH address) must
    // not have DASH invented back into it.
    const noDash = ROSTER.filter((t) => t !== "DASH");
    expect(basicswapPickerTickers(noDash, "XMR")).not.toContain("DASH");
  });

  it("every offered pair is one the route can actually hold a book for", () => {
    // The property the whole filter exists to guarantee: pick anything it
    // offers opposite XMR, and the pair is routable; same opposite LTC, and
    // (2026-09-03) opposite ZEPH and ZANO.
    for (const other of ["XMR", "LTC", "ZEPH", "ZANO"]) {
      for (const t of basicswapPickerTickers(ROSTER, other)) {
        expect(isBasicswapRoutable(other, t), `${other}->${t}`).toBe(true);
      }
    }
  });
});
