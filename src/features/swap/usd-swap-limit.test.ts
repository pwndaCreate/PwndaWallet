/**
 * A floor stated in DOLLARS is not a floor stated in atomic units.
 *
 * On 2026-09-09 a user hit this on AVAX at 2.6 (about $21), to BTC and to
 * USDC on Polygon, and the swap screen printed the proxy envelope at them:
 *
 *   Quote request rejected by upstream: proxy returned 400:
 *   {"error":"UPSTREAM","message":"Upstream API request failed",
 *    "upstreamStatus":400,"upstreamMessage":"Temporary swap limits: minimum
 *    swap amount is $1,000","requestId":"809f3f8a0427200ccb69c3102e2de7a5"}
 *
 * Two separate faults, and this file pins both.
 *
 * ## 1. The parser was one comma away from fabricating a floor
 *
 * `parseMinAtomicFromUpstreamError` gates on a cue and then takes the
 * largest integer of four digits or more. "minimum" clears the cue. The only
 * reason "$1,000" did not become a cached floor of 1000 atomic units is that
 * the comma splits it into "1" and "000". Written "$1000" it parses, and the
 * form would have told a user that 0.000000000000001 AVAX cleared the floor.
 *
 * That is the same failure as the ADA one of 2026-09-05, where the local
 * error "open the Cardano chain in the dashboard (CIP-1852 path)" yielded a
 * minimum of 1852. That was fixed by adding a cue gate. This message passes
 * the cue gate, so it needs the other half: money is not units.
 *
 * ## 2. The unknown-wording branch was a JSON dumper
 *
 * The same shape of raw envelope reached a user on 2026-05-10 ("Amount is
 * too low for bridge, try at least N"). That was answered by teaching the
 * parser that one wording, which left the dumper in place for the next new
 * wording. Four months later it caught this one. The branch now prints the
 * venue's own sentence and nothing else.
 *
 * ## What the limit actually is
 *
 * Probed live against `https://1click.chaindefuser.com` on 2026-09-09 with
 * dry quotes:
 *
 *   AVAX to BTC          $21        400 Temporary swap limits
 *   AVAX to BTC          $160       400 Temporary swap limits
 *   AVAX to BTC          $1,038     201 quoted
 *   USDC-POL to BTC      $1,000.00  400 Temporary swap limits
 *   USDC-POL to BTC      $1,009.95  201 quoted
 *   ETH to AVAX          $25        400 Temporary swap limits
 *
 * So: a dollar floor of exactly $1,000 (strictly greater passes), on the
 * swap rather than on one asset, applying to any pair with a HOT Omni Bridge
 * `nep245:v2_1.omni.hot.tg:*` asset on EITHER leg. Thirteen of the wallet's
 * thirty NEAR routable assets are on that bridge. Pure `nep141:` pairs are
 * unaffected and still answer with the atomic "try at least N" shape.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  _snapshotForTests,
  clearPairMinimumCache,
  parseMinAtomicFromUpstreamError,
  parseMinUsdFromUpstreamError,
} from "./intents-pair-min-cache";
import { learnUsdLimitFromError } from "./intents-pair-min-probe";
import { humanizeError, upstreamSentence } from "./useSwapQuote";
import type { NearIntentsToken } from "./near-intents-tokens";

/** The envelope from the user's screenshot, character for character. */
const VERBATIM =
  "proxy returned 400: " +
  '{"error":"UPSTREAM","message":"Upstream API request failed",' +
  '"upstreamStatus":400,"upstreamMessage":"Temporary swap limits: minimum ' +
  'swap amount is $1,000","requestId":"809f3f8a0427200ccb69c3102e2de7a5"}';

/** AVAX as the tokens cache carries it, at the price of that afternoon. */
const AVAX: NearIntentsToken = {
  assetId: "nep245:v2_1.omni.hot.tg:43114_11111111111111111111",
  decimals: 18,
  blockchain: "avax",
  symbol: "AVAX",
  price: 8,
};

const BTC: NearIntentsToken = {
  assetId: "nep141:btc.omft.near",
  decimals: 8,
  blockchain: "btc",
  symbol: "BTC",
  price: 79000,
};

describe("the atomic parser refuses money", () => {
  it("returns null for the verbatim envelope", () => {
    expect(parseMinAtomicFromUpstreamError(VERBATIM)).toBeNull();
  });

  it("returns null WITHOUT the comma, which is the actual bug", () => {
    // The comma-free form is the one that proves the guard is doing the
    // work. Before 2026-09-09 this returned "1000" and cached it as atomic
    // units of the source asset.
    expect(
      parseMinAtomicFromUpstreamError(
        "Temporary swap limits: minimum swap amount is $1000",
      ),
    ).toBeNull();
  });

  it("refuses the other money spellings too", () => {
    for (const m of [
      "minimum swap amount is 1000 USD",
      "minimum swap amount is 1,000.00 dollars",
      "minimum swap amount is $ 2500",
    ]) {
      expect(parseMinAtomicFromUpstreamError(m), m).toBeNull();
    }
  });

  it("still parses a genuine atomic floor that happens to quote a price", () => {
    // Scrubbing money must not eat the units. A message carrying both is the
    // case where getting this wrong is invisible: it would return null and
    // the pair would silently lose a floor it does have.
    expect(
      parseMinAtomicFromUpstreamError(
        "Amount is below the minimum amount of 1000000000000000 wei ($3.50)",
      ),
    ).toBe("1000000000000000");
  });

  it("leaves the 2026-05-10 capture parsing exactly as before", () => {
    expect(
      parseMinAtomicFromUpstreamError(
        "proxy returned 400: " +
          '{"upstreamStatus":400,"upstreamMessage":"Amount is too low for ' +
          'bridge, try at least 2938452937037670",' +
          '"requestId":"832735b57a1f905942dfd25d95df10f0"}',
      ),
    ).toBe("2938452937037670");
  });
});

describe("the USD parser reads what the atomic one refuses", () => {
  it("reads the verbatim envelope", () => {
    expect(parseMinUsdFromUpstreamError(VERBATIM)).toBe("1000");
  });

  it("reads the spellings, comma or not, symbol or word", () => {
    expect(parseMinUsdFromUpstreamError("minimum swap amount is $1000")).toBe(
      "1000",
    );
    expect(
      parseMinUsdFromUpstreamError("minimum swap amount is 1,000.50 dollars"),
    ).toBe("1000.50");
    expect(parseMinUsdFromUpstreamError("minimum is 2500 USD")).toBe("2500");
  });

  it("keeps the cue gate, so a dollar figure alone is not a minimum", () => {
    // The gate is what stopped the CIP-1852 fabrication. A message that
    // merely mentions money is not a limit, and inventing one from it would
    // block swaps that upstream would have filled.
    expect(
      parseMinUsdFromUpstreamError("Route fee is $1,000 for this size"),
    ).toBeNull();
  });

  it("does not read an atomic floor as dollars", () => {
    expect(
      parseMinUsdFromUpstreamError("Amount is too low for bridge, try at least 6400"),
    ).toBeNull();
  });

  it("does not mistake a USDT or USDC amount for a USD one", () => {
    // A live trap on this wallet specifically: half the affected assets are
    // called USDT or USDC, and both start with the three letters the money
    // pattern looks for. Reading "6400 USDT" as $6,400 would put a dollar
    // floor on a message that named an amount of coin, and then the atomic
    // parser would ALSO have had its number scrubbed away, losing a real
    // floor in both directions at once.
    expect(
      parseMinUsdFromUpstreamError("minimum is 6400 USDT for this route"),
    ).toBeNull();
    expect(
      parseMinAtomicFromUpstreamError("minimum is 6400 USDT for this route"),
    ).toBe("6400");
  });
});

describe("learning the limit as an amount of the source asset", () => {
  beforeEach(() => clearPairMinimumCache());

  it("converts at the live price, with headroom over the stated floor", () => {
    const atomic = learnUsdLimitFromError({
      message: VERBATIM,
      fromAsset: AVAX,
      toAsset: BTC,
    });
    expect(atomic).not.toBeNull();
    // $1,000 x 1.02 headroom / $8 = 127.5 AVAX. The headroom is not decoration:
    // $1,000.00 exactly was REFUSED live and $1,009.95 quoted, and the price
    // moves between our conversion and their check.
    const avax = Number(atomic) / 1e18;
    expect(avax).toBeGreaterThan(1000 / AVAX.price!);
    expect(avax).toBeCloseTo(127.5, 1);
  });

  it("rounds UP to four significant digits, never down", () => {
    // At $38.60 the exact conversion is 26.42487046632124 AVAX, and eighteen
    // decimals of a number derived from a price tick claims a precision that
    // is not there. Rounding up keeps it a valid floor; rounding to nearest
    // would sometimes land under the limit and make MIN a button that fills
    // an amount upstream then refuses.
    const priced = { ...AVAX, price: 38.6 } as NearIntentsToken;
    const atomic = learnUsdLimitFromError({
      message: VERBATIM,
      fromAsset: priced,
      toAsset: BTC,
    });
    expect(atomic).toBe("26430000000000000000"); // 26.43 AVAX
    expect(Number(atomic) / 1e18).toBeGreaterThan((1000 * 1.02) / 38.6);
  });

  it("leaves an already-short amount alone", () => {
    // USDC at $1: $1,020 is 1020000000 atomic, four significant digits
    // already. Rounding must not inflate a floor that needs no rounding.
    const usdc: NearIntentsToken = {
      assetId: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
      decimals: 6,
      blockchain: "pol",
      symbol: "USDC",
      price: 1,
    };
    expect(
      learnUsdLimitFromError({ message: VERBATIM, fromAsset: usdc, toAsset: BTC }),
    ).toBe("1020000000");
  });

  it("keeps the bridge's own figure beside our conversion", () => {
    learnUsdLimitFromError({ message: VERBATIM, fromAsset: AVAX, toAsset: BTC });
    const [entry] = _snapshotForTests();
    expect(entry.source).toBe("usd-limit");
    // `usdFloor` is what upstream said; `atomic` is ours. The hint quotes the
    // first and marks the second approximate, so the wallet never attributes
    // a coin amount to a bridge that only ever named a price.
    expect(entry.usdFloor).toBe("1000");
    expect(entry.from).toBe(AVAX.assetId);
    expect(entry.to).toBe(BTC.assetId);
  });

  it("caches nothing when the source asset has no price", () => {
    // A floor of "0" would make the below-minimum check pass everything,
    // which reads as "no limit" on a screen where there certainly is one.
    const priceless = { ...AVAX, price: undefined } as NearIntentsToken;
    expect(
      learnUsdLimitFromError({
        message: VERBATIM,
        fromAsset: priceless,
        toAsset: BTC,
      }),
    ).toBeNull();
    expect(_snapshotForTests()).toEqual([]);
  });

  it("caches nothing for a message that names no dollar floor", () => {
    expect(
      learnUsdLimitFromError({
        message: "proxy returned 400: No liquidity available",
        fromAsset: AVAX,
        toAsset: BTC,
      }),
    ).toBeNull();
    expect(_snapshotForTests()).toEqual([]);
  });
});

describe("what the user reads", () => {
  it("never shows the envelope", () => {
    const shown = humanizeError(new Error(VERBATIM));
    expect(shown).not.toContain("{");
    expect(shown).not.toContain("requestId");
    expect(shown).not.toContain("upstreamStatus");
    expect(shown).not.toContain("809f3f8a0427200ccb69c3102e2de7a5");
  });

  it("names the floor, and says whose rule it is", () => {
    const shown = humanizeError(new Error(VERBATIM));
    expect(shown).toContain("$1,000");
    // The limit follows the asset onto either leg, so "try the other
    // direction" is the wrong instinct and the copy has to head it off.
    expect(shown.toLowerCase()).toContain("not a wallet limit");
  });

  it("shows the venue's sentence for wording nobody has taught it yet", () => {
    // The point of the change: an unrecognised 4xx degrades to the upstream
    // sentence, not to the JSON around it. This is what would have happened
    // on 2026-05-10 and on 2026-09-09 had it been written this way first.
    const unknown =
      "proxy returned 400: " +
      '{"error":"UPSTREAM","message":"Upstream API request failed",' +
      '"upstreamStatus":400,"upstreamMessage":"Solver refused: route paused ' +
      'for maintenance","requestId":"deadbeef"}';
    const shown = humanizeError(new Error(unknown));
    expect(shown).toContain("Solver refused: route paused for maintenance");
    expect(shown).not.toContain("requestId");
    expect(shown).not.toContain("deadbeef");
  });

  it("says so plainly when the envelope carries no upstream sentence", () => {
    const bare = humanizeError(new Error("proxy returned 429: {}"));
    expect(bare).not.toContain("{");
    expect(bare).toContain("4xx");
  });
});

describe("upstreamSentence", () => {
  it("unwraps the verbatim envelope", () => {
    expect(upstreamSentence(VERBATIM)).toBe(
      "Temporary swap limits: minimum swap amount is $1,000",
    );
  });

  it("decodes escapes rather than leaking them", () => {
    expect(
      upstreamSentence('{"upstreamMessage":"Asset \\"USDC\\" is paused"}'),
    ).toBe('Asset "USDC" is paused');
  });

  it("returns null when there is no envelope to unwrap", () => {
    expect(upstreamSentence("Amount is too low for bridge, try at least 6400"))
      .toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The OTHER upstream refusal (2026-09-09)
// ---------------------------------------------------------------------------
//
// 1Click has two ways of saying no and they mean opposite things for the user:
//
//   "No liquidity available"                  route exists, nobody filled it
//                                             this second. Transient — seen on
//                                             DOGE to BTC and recovered inside
//                                             a minute at the same size.
//   "Quoting for this pair is not available"  the pair is not offered at all.
//                                             Litecoin has been here since
//                                             about 2026-09-08 14:39 UTC.
//
// Collapsing them into one "no route" message sends a user to change the
// amount when the amount was never the problem, or to conclude the wallet is
// broken when the wallet is fine and can route the pair over P2P.
describe("structural refusal vs a liquidity gap", () => {
  const MSG =
    'proxy returned 400: {"message":"Quoting for this pair is not available"}';

  it("says it is upstream and not about the amount", () => {
    const shown = humanizeError(new Error(MSG));
    expect(shown).toMatch(/not currently offering this pair/i);
    expect(shown).toMatch(/not a wallet problem/i);
    expect(shown).toMatch(/not about the amount/i);
    expect(shown).not.toContain("{");
  });

  it("names P2P when the same pair IS routable there", () => {
    // The LTC case exactly: NEAR will not quote it, BasicSwap carries it as a
    // scripted leg. A dead end and a detour read very differently.
    const shown = humanizeError(new Error(MSG), { basicswapAlternative: true });
    expect(shown).toMatch(/P2P tab/);
  });

  it("does not promise P2P when the pair is not routable there", () => {
    const shown = humanizeError(new Error(MSG), { basicswapAlternative: false });
    expect(shown).not.toMatch(/P2P/);
  });

  it("leaves the transient liquidity message alone", () => {
    // Still its own branch, still pointing at MIN, because for that one the
    // size genuinely can be the problem.
    const shown = humanizeError(new Error("proxy returned 400: No liquidity available"));
    expect(shown).toMatch(/press MIN/i);
    expect(shown).not.toMatch(/not currently offering/i);
  });
});
