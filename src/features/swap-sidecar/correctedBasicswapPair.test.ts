/**
 * `correctedBasicswapPair` — self-heals `(fromCoin, toCoin)` into a
 * BasicSwap-routable pair when it isn't one.
 *
 * Pinned 2026-08-22 from the operator's bug report: fresh boot, P2P tab
 * already selected (persisted from last session), YOU SEND showing ETH —
 * the app's universal default pair, never reconciled against the router.
 * See the function's own doc comment in `useSidecarSwap.ts` for the full
 * trace.
 *
 * Extended 2026-09-03 (Grove expansion plan, Phase C unit C-T1): ZEPH and
 * ZANO becoming followers (narrower counterparty set than XMR — see
 * `FOLLOWER_COUNTERPARTY_TICKERS`) creates NEW invalid pairs this function
 * must still heal correctly — e.g. `(ZEPH, DASH)`, which was already
 * invalid before 2026-09-03 (ZEPH wasn't a BasicSwap coin at all) but is
 * invalid for a DIFFERENT reason now (ZEPH is a follower; DASH isn't a
 * legal follower counterparty). The function's own logic needed no code
 * change to keep handling these correctly (it always falls back to BTC,
 * which is valid for every scriptless coin) — verified by the cases below.
 */
import { describe, it, expect } from "vitest";
import {
  correctedBasicswapPair,
  isBasicswapRoutable,
} from "./useSidecarSwap";

describe("correctedBasicswapPair", () => {
  it("returns null when the pair is already routable — no correction needed", () => {
    expect(correctedBasicswapPair("XMR", "BTC")).toBeNull();
    expect(correctedBasicswapPair("LTC", "XMR")).toBeNull();
  });

  it("the reported bug: ETH -> BTC keeps BTC and swaps ETH for XMR", () => {
    expect(correctedBasicswapPair("ETH", "BTC")).toEqual({
      from: "XMR",
      to: "BTC",
    });
  });

  it("the mirror case: BTC -> ETH keeps BTC on send and swaps ETH for XMR", () => {
    expect(correctedBasicswapPair("BTC", "ETH")).toEqual({
      from: "BTC",
      to: "XMR",
    });
  });

  it("XMR already on send, invalid receive: keeps XMR, defaults receive to BTC", () => {
    expect(correctedBasicswapPair("XMR", "ETH")).toEqual({
      from: "XMR",
      to: "BTC",
    });
    expect(correctedBasicswapPair("XMR", "SOL")).toEqual({
      from: "XMR",
      to: "BTC",
    });
  });

  it("XMR already on receive, invalid send: keeps XMR, defaults send to BTC", () => {
    expect(correctedBasicswapPair("ETH", "XMR")).toEqual({
      from: "BTC",
      to: "XMR",
    });
  });

  it("neither side is a BasicSwap coin at all: falls back to XMR/BTC", () => {
    expect(correctedBasicswapPair("ETH", "SOL")).toEqual({
      from: "XMR",
      to: "BTC",
    });
  });

  it("is case-insensitive, mirroring isBasicswapRoutable", () => {
    expect(correctedBasicswapPair("eth", "btc")).toEqual({
      from: "XMR",
      to: "btc",
    });
  });

  it("a follower opposite a counterparty IT cannot pair with (ZEPH/DASH) is healed to a valid follower pair, not bounced to XMR", () => {
    // ZEPH is scriptless, so it hits the `fromIsScriptless` branch and keeps
    // its own send side — the correction is {ZEPH, BTC}, not {XMR, BTC}.
    expect(correctedBasicswapPair("ZEPH", "DASH")).toEqual({
      from: "ZEPH",
      to: "BTC",
    });
    expect(correctedBasicswapPair("DOGE", "ZANO")).toEqual({
      from: "BTC",
      to: "ZANO",
    });
  });

  it("every correction it proposes is itself routable — no infinite loop risk", () => {
    const cases: Array<[string, string]> = [
      ["ETH", "BTC"],
      ["BTC", "ETH"],
      ["XMR", "ETH"],
      ["ETH", "XMR"],
      ["ETH", "SOL"],
      ["ZEPH", "SOL"],
      ["ZANO", "SOL"],
      ["ZEPH", "DASH"],
      ["DOGE", "ZANO"],
      ["ZEPH", "ZANO"],
      ["ZANO", "ZEPH"],
    ];
    for (const [from, to] of cases) {
      const corrected = correctedBasicswapPair(from, to);
      expect(corrected, `${from}->${to}`).not.toBeNull();
      expect(
        isBasicswapRoutable(corrected!.from, corrected!.to),
        `corrected ${from}->${to} into ${corrected!.from}->${corrected!.to}, which must itself be routable`
      ).toBe(true);
    }
  });
});
