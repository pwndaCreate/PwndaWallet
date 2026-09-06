/**
 * The public market snapshot parser.
 *
 * # What these tests are protecting
 *
 * This module consumes a **third-party feed with no schema version, no
 * changelog and no stability promise**, and renders the result to a user who
 * is deciding whether to enable a background service. Two failure modes matter
 * more than correctness of any single field:
 *
 *   1. **Rendering "no market" when we could not read one.** That argues
 *      against opting in using evidence we do not have. `parseSnapshot` throws
 *      rather than returning an empty snapshot, so the UI's unavailable branch
 *      and its empty-market branch can never be reached by the same input.
 *   2. **Rendering a number we cannot defend.** The publisher's own counts
 *      disagree across its surfaces, so we recompute. The liveness cases below
 *      pin OUR rule, including the deliberate mismatch with theirs.
 *
 * The captured field names are from a live read on 2026-08-28. They are the
 * SMSG wire shape, not our `BasicSwapOffer`, and the difference is the point:
 * a test written against our own type would agree with a mirror of itself.
 */
import { describe, it, expect } from "vitest";
import {
  MarketSnapshotError,
  isLive,
  normalizeOffer,
  pairKeyFor,
  parseSnapshot,
  shortAge,
  shortMaker,
} from "../marketsSnapshot";

const NOW = 1_787_953_958;

/** One record with the real field names, overridable per case. */
function raw(over: Record<string, unknown> = {}) {
  return {
    msg_id: "000000006a91f19b212b101c6a5d2aeaf04d2a38d3a70c7ed8daf5c9",
    timestamp: NOW - 300,
    coin_from: "BTC",
    coin_to: "XMR",
    amount_from_str: "0.06240000",
    amount_to_str: "10.457000000000",
    time_valid: 14400,
    addr_from: "PbAiK3mVpQr7sTuvWxYzGBTB",
    ...over,
  };
}

describe("normalizeOffer — drops rather than defaults", () => {
  it("reads the wire field names", () => {
    const o = normalizeOffer(raw())!;
    expect(o.id).toContain("000000006a91");
    expect(o.fromTicker).toBe("BTC");
    expect(o.toTicker).toBe("XMR");
    // Strings, not floats: the feed's own `rate` is a double and some are
    // 2.4e-10. Amounts must arrive as the decimal strings the feed publishes.
    expect(o.fromAmount).toBe("0.06240000");
    expect(typeof o.fromAmount).toBe("string");
    expect(o.expiresAt).toBe(NOW - 300 + 14400);
  });

  it("computes expiry from time_valid, because the feed has no expire_at", () => {
    const o = normalizeOffer(raw({ timestamp: 1000, time_valid: 60 }))!;
    expect(o.expiresAt).toBe(1060);
  });

  for (const missing of [
    "msg_id",
    "coin_from",
    "coin_to",
    "amount_from_str",
    "amount_to_str",
    "timestamp",
    "time_valid",
  ]) {
    it(`returns null when \`${missing}\` is absent`, () => {
      // A blank ticker or a zero amount rendered in a preview reads as a fact
      // about the market. Fewer offers is the honest degradation.
      expect(normalizeOffer(raw({ [missing]: undefined }))).toBeNull();
    });
  }

  it("uppercases tickers so pair keys are stable", () => {
    const o = normalizeOffer(raw({ coin_from: "btc", coin_to: "xmr" }))!;
    expect(o.pairKey).toBe("BTC/XMR");
  });

  it("gives both directions of a pair the same key", () => {
    expect(pairKeyFor("XMR", "BTC")).toBe(pairKeyFor("BTC", "XMR"));
  });
});

describe("isLive — our rule, stated once", () => {
  const o = normalizeOffer(raw({ timestamp: NOW - 100, time_valid: 200 }))!;

  it("is live inside the maker's validity window", () => {
    expect(isLive(o, NOW)).toBe(true);
  });

  it("is not live past it", () => {
    expect(isLive(o, NOW + 200)).toBe(false);
  });
});

describe("parseSnapshot", () => {
  function payload(over: Record<string, unknown> = {}) {
    return {
      timestamp: NOW - 300,
      num_offers: 3,
      active_offers: 99, // deliberately wrong — see below
      offers: [
        raw({ msg_id: "a", timestamp: NOW - 100, time_valid: 3600 }),
        raw({
          msg_id: "b",
          coin_from: "LTC",
          coin_to: "XMR",
          timestamp: NOW - 200,
          time_valid: 3600,
          addr_from: "PdifferentMakerAddressHere",
        }),
        // expired
        raw({ msg_id: "c", timestamp: NOW - 9000, time_valid: 3600 }),
      ],
      ...over,
    };
  }

  it("counts only live offers, not the publisher's number", () => {
    const s = parseSnapshot(payload(), NOW);
    expect(s.liveOffers).toHaveLength(2);
    // The publisher said 99. We must not echo it.
    expect(s.publisherClaimed.activeOffers).toBe(99);
    expect(s.liveOffers.length).not.toBe(s.publisherClaimed.activeOffers);
  });

  it("aggregates pairs busiest-first with a stable tiebreak", () => {
    const s = parseSnapshot(payload(), NOW);
    expect(s.pairs.map((p) => p.pairKey)).toEqual(["BTC/XMR", "LTC/XMR"]);
    expect(s.pairs[0].offerCount).toBe(1);
  });

  it("counts distinct makers, not offers", () => {
    const s = parseSnapshot(
      payload({
        offers: [
          raw({ msg_id: "a", addr_from: "Psame", timestamp: NOW, time_valid: 99 }),
          raw({ msg_id: "b", addr_from: "Psame", timestamp: NOW, time_valid: 99 }),
        ],
      }),
      NOW,
    );
    expect(s.liveOffers).toHaveLength(2);
    expect(s.makerCount).toBe(1);
  });

  it("skips malformed records instead of failing the whole read", () => {
    const s = parseSnapshot(
      payload({
        offers: [
          raw({ msg_id: "good", timestamp: NOW, time_valid: 99 }),
          { msg_id: "bad", timestamp: NOW }, // no tickers, no amounts
        ],
      }),
      NOW,
    );
    expect(s.liveOffers).toHaveLength(1);
    expect(s.liveOffers[0].id).toBe("good");
  });

  it("reports the tickers actually quotable right now", () => {
    const s = parseSnapshot(payload(), NOW);
    expect(s.tickers).toEqual(["BTC", "LTC", "XMR"]);
  });

  it("computes snapshot age", () => {
    expect(parseSnapshot(payload(), NOW).ageSec).toBe(300);
  });

  /**
   * The load-bearing cases. An unreadable feed must NOT look like a dead
   * market — that is the one error this surface cannot afford, because the
   * surface exists to tell a user whether opting in is worth it.
   */
  it("throws when `offers` is missing — a schema change must be loud", () => {
    expect(() => parseSnapshot({ timestamp: NOW }, NOW)).toThrow(
      MarketSnapshotError,
    );
  });

  it("throws when `offers` is not an array", () => {
    expect(() => parseSnapshot({ offers: "nope" }, NOW)).toThrow(
      MarketSnapshotError,
    );
  });

  it("throws on a non-object payload", () => {
    expect(() => parseSnapshot(null, NOW)).toThrow(MarketSnapshotError);
    expect(() => parseSnapshot("<html>502</html>", NOW)).toThrow(
      MarketSnapshotError,
    );
  });

  it("an empty book parses fine — that is a real answer, not an error", () => {
    const s = parseSnapshot({ timestamp: NOW, offers: [] }, NOW);
    expect(s.liveOffers).toHaveLength(0);
    expect(s.pairs).toHaveLength(0);
  });
});

describe("formatting helpers", () => {
  it("truncates a maker the way the publisher does", () => {
    expect(shortMaker("PbAiK3mVpQr7sTuvWxYzGBTB")).toBe("PbAi…GBTB");
  });

  it("leaves a short string alone", () => {
    expect(shortMaker("Pshort")).toBe("Pshort");
  });

  it("formats ages at each scale", () => {
    expect(shortAge(30)).toBe("30s");
    expect(shortAge(90)).toBe("1m");
    expect(shortAge(7200)).toBe("2h");
    expect(shortAge(200_000)).toBe("2d");
  });

  it("refuses to invent an age", () => {
    expect(shortAge(-1)).toBe("—");
    expect(shortAge(Number.NaN)).toBe("—");
  });
});
