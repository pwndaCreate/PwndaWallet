import { describe, it, expect, beforeEach } from "vitest";
import {
  bisectExactInputMinimum,
  MAX_BISECT_PROBES,
  buildExactInputDryProbe,
  buildExactOutputDryProbe,
  dollarAmountAtomic,
  FLOOR_PROBE_MAX_CALLS,
  FLOOR_PROBE_STEP,
  probeExactInputFallback,
  probePairFloor,
  probePerPairMinimum,
  readScheduleEnv,
} from "./intents-pair-min-probe";
import {
  clearPairMinimumCache,
  getPairMinimum,
  getPairMinimumEntry,
  parseMinAtomicFromUpstreamError,
  setPairMinimum,
  _setLearnedAtForTests,
} from "./intents-pair-min-cache";
import type { NearIntentsToken } from "./near-intents-tokens";
import type { WalletAddresses } from "./asset-address-resolver";
import type {
  IntentsQuoteRequest,
  IntentsQuoteResponse,
} from "../../lib/proxy-types";
import { formatUsdSubLine } from "./SwapForm";

/**
 * Regression vectors for the per-pair minimum probe (2026-05-09).
 *
 * Locks the four phases of the descending probe loop against the
 * verified-live API behavior captured against `https://1click.chaindefuser.com`:
 *   - First probe rejects with "Amount is too low for bridge, try at least N"
 *   - Parse-bonus probe at exactly N succeeds, response carries `quote.minAmountIn`
 *   - Cache populated with source: "probe" and expectedAmountOutUsd
 *   - 5-min TTL on probe entries; 30-min TTL on upstream-error entries
 */

const ETH_TOKEN: NearIntentsToken = {
  assetId: "nep141:eth.omft.near",
  symbol: "ETH",
  decimals: 18,
  blockchain: "eth",
  price: 2315.81,
  priceUpdatedAt: "2026-05-09T05:34:00.000Z",
};

const BTC_TOKEN: NearIntentsToken = {
  assetId: "nep141:btc.omft.near",
  symbol: "BTC",
  decimals: 8,
  blockchain: "btc",
  price: 80419,
  priceUpdatedAt: "2026-05-09T05:34:00.000Z",
};

const USDC_TOKEN: NearIntentsToken = {
  assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  symbol: "USDC",
  decimals: 6,
  blockchain: "eth",
  price: 1.0,
  priceUpdatedAt: "2026-05-09T05:34:00.000Z",
  contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
};

const POL_TOKEN: NearIntentsToken = {
  // HOT Omni-Bridge asset id — the family that returns an unparseable
  // rejection for dry EXACT_OUTPUT probes (live-captured 2026-07-01),
  // which is what `probeExactInputFallback` exists to work around.
  assetId: "nep245:v2_1.omni.hot.tg:137_11111111111111111111",
  symbol: "POL",
  decimals: 18,
  blockchain: "pol",
  price: 0.0707,
  priceUpdatedAt: "2026-07-01T19:16:00.000Z",
};

const HARDHAT_WALLET: WalletAddresses = {
  evm: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  btc: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  sol: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
};

// ---------------------------------------------------------------------------
// dollarAmountAtomic
// ---------------------------------------------------------------------------

describe("dollarAmountAtomic — USD → atomic units", () => {
  it("BTC at $80,419, $0.05 → 63 sat (matches the live probe)", () => {
    expect(dollarAmountAtomic(BTC_TOKEN, 0.05)).toBe("63");
  });

  it("BTC at $80,419, $5 → 6217 sat (just below the captured 6400 floor)", () => {
    // 5 / 80419 * 1e8 = 6217.4... → ceil → 6218.
    // Confirms a $5 probe at this price is just below the bridge floor;
    // the loop's parse-bonus would jump to the captured 6400 next.
    const atomic = dollarAmountAtomic(BTC_TOKEN, 5);
    expect(Number(atomic)).toBeGreaterThan(6000);
    expect(Number(atomic)).toBeLessThan(6500);
  });

  it("ETH at $2,315.81, $1 → ~432e15 wei (18 decimals)", () => {
    const atomic = dollarAmountAtomic(ETH_TOKEN, 1);
    // 1 / 2315.81 ≈ 0.000432 ETH = 4.32e14 wei
    expect(BigInt(atomic) > 4n * 10n ** 14n).toBe(true);
    expect(BigInt(atomic) < 5n * 10n ** 14n).toBe(true);
  });

  it("USDC at $1, $0.05 → 50000 (6 decimals)", () => {
    expect(dollarAmountAtomic(USDC_TOKEN, 0.05)).toBe("50000");
  });

  it("price unavailable → '0' (caller must skip)", () => {
    expect(dollarAmountAtomic({ price: 0, decimals: 18 }, 1)).toBe("0");
    expect(dollarAmountAtomic({ price: NaN, decimals: 18 }, 1)).toBe("0");
    expect(
      dollarAmountAtomic({ price: undefined as unknown as number, decimals: 18 }, 1),
    ).toBe("0");
  });

  it("high-decimal token (NEAR, 24 decimals) handled via BigInt shift", () => {
    const NEAR_TOKEN = { price: 1.59, decimals: 24 } as const;
    const atomic = dollarAmountAtomic(NEAR_TOKEN, 1);
    // 1/1.59 NEAR ≈ 0.629 NEAR = 6.29e23 yocto.
    expect(BigInt(atomic) > 6n * 10n ** 23n).toBe(true);
    expect(BigInt(atomic) < 7n * 10n ** 23n).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildExactOutputDryProbe
// ---------------------------------------------------------------------------

describe("buildExactOutputDryProbe — request body shape", () => {
  it("locks the body shape exactly (regression)", () => {
    const body = buildExactOutputDryProbe({
      fromAsset: ETH_TOKEN,
      toAsset: BTC_TOKEN,
      destAmountAtomic: "63",
      walletAddresses: HARDHAT_WALLET,
    });
    expect(body.dry).toBe(true);
    expect(body.swapType).toBe("EXACT_OUTPUT");
    expect(body.slippageTolerance).toBe(500);
    expect(body.originAsset).toBe("nep141:eth.omft.near");
    expect(body.destinationAsset).toBe("nep141:btc.omft.near");
    expect(body.amount).toBe("63");
    expect(body.depositType).toBe("ORIGIN_CHAIN");
    expect(body.recipientType).toBe("DESTINATION_CHAIN");
    expect(body.refundType).toBe("ORIGIN_CHAIN");
    expect(body.recipient).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(body.refundTo).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(body.quoteWaitingTimeMs).toBe(0);
    expect(body.deadline).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("destAmountAtomic flows through unchanged (atomic, not display)", () => {
    const body = buildExactOutputDryProbe({
      fromAsset: ETH_TOKEN,
      toAsset: BTC_TOKEN,
      destAmountAtomic: "6400",
      walletAddresses: HARDHAT_WALLET,
    });
    expect(body.amount).toBe("6400");
  });
});

// ---------------------------------------------------------------------------
// probePerPairMinimum — descending loop with parse-bonus
// ---------------------------------------------------------------------------

/** Mock quote function that scripts a sequence of (request → response or error). */
function makeMockQuote(
  script: Array<
    | { matchAmount: string; ok: { quote: IntentsQuoteResponse["quote"] } }
    | { matchAmount: string; reject: string }
  >,
): {
  fn: (req: IntentsQuoteRequest) => Promise<IntentsQuoteResponse>;
  callsArgs: IntentsQuoteRequest[];
} {
  const callsArgs: IntentsQuoteRequest[] = [];
  let i = 0;
  const fn = async (req: IntentsQuoteRequest): Promise<IntentsQuoteResponse> => {
    callsArgs.push(req);
    if (i >= script.length) {
      throw new Error("Mock script exhausted");
    }
    const step = script[i++];
    if (step.matchAmount !== req.amount) {
      throw new Error(
        `Mock expected amount=${step.matchAmount}, got ${req.amount}`,
      );
    }
    if ("ok" in step) {
      return {
        quote: step.ok.quote,
        timestamp: "2026-05-09T05:35:00.000Z",
      };
    }
    throw new Error(step.reject);
  };
  return { fn, callsArgs };
}

describe("probePerPairMinimum — adaptive descending probe", () => {
  beforeEach(() => clearPairMinimumCache());

  it("first probe accepted → caches + returns in 1 call", async () => {
    // Hypothetical cheap pair: USDC.eth → USDC.eth, $0.05 already at floor.
    const { fn, callsArgs } = makeMockQuote([
      {
        matchAmount: "50000", // $0.05 of USDC at decimals 6
        ok: {
          quote: {
            amountIn: "50100",
            minAmountIn: "47595",
            amountOut: "50000",
            minAmountOut: "50000",
            amountInUsd: "0.0501",
            amountOutUsd: "0.05",
            timeEstimate: 30,
          },
        },
      },
    ]);
    const result = await probePerPairMinimum({
      fromAsset: USDC_TOKEN,
      toAsset: USDC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      quoteFn: fn,
    });
    expect(result?.minAtomicIn).toBe("47595");
    expect(result?.expectedAmountOutUsd).toBe("0.05");
    expect(result?.probesUsed).toBe(1);
    expect(callsArgs.length).toBe(1);
    const cached = getPairMinimumEntry(USDC_TOKEN.assetId, USDC_TOKEN.assetId);
    expect(cached?.atomic).toBe("47595");
    expect(cached?.source).toBe("probe");
    expect(cached?.expectedAmountOutUsd).toBe("0.05");
  });

  it("first rejected with 'try at least N' → parse-bonus probe at N succeeds (2 calls, the ETH→BTC live case)", async () => {
    // ETH → BTC: $0.05 = 63 sat, bridge floor = 6400 sat per the live capture.
    const { fn, callsArgs } = makeMockQuote([
      {
        matchAmount: "63",
        reject: "Amount is too low for bridge, try at least 6400",
      },
      {
        matchAmount: "6400",
        ok: {
          quote: {
            amountIn: "3044469169702092",
            minAmountIn: "2892245711216987",
            amountOut: "6400",
            minAmountOut: "6400",
            amountInUsd: "7.0521",
            amountOutUsd: "5.1472",
            timeEstimate: 490,
          },
        },
      },
    ]);
    const result = await probePerPairMinimum({
      fromAsset: ETH_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      quoteFn: fn,
    });
    expect(result?.minAtomicIn).toBe("2892245711216987");
    expect(result?.expectedAmountOutUsd).toBe("5.1472");
    expect(result?.probesUsed).toBe(2);
    expect(callsArgs.length).toBe(2);
    expect(callsArgs[0].amount).toBe("63");
    expect(callsArgs[1].amount).toBe("6400");
  });

  it("descending schedule walks all 4 levels when no parse-bonus available", async () => {
    // Reject with messages that don't carry parsable atomic integers.
    const { fn, callsArgs } = makeMockQuote([
      { matchAmount: "63", reject: "service unavailable" },
      { matchAmount: "249", reject: "service unavailable" },
      { matchAmount: "1244", reject: "service unavailable" },
      { matchAmount: "6218", reject: "service unavailable" },
    ]);
    const result = await probePerPairMinimum({
      fromAsset: ETH_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      quoteFn: fn,
    });
    expect(result).toBe(null);
    expect(callsArgs.length).toBe(4);
    expect(callsArgs.map((c) => c.amount)).toEqual(["63", "249", "1244", "6218"]);
    // Cache stays empty — fall back to reactive parser.
    expect(getPairMinimum(ETH_TOKEN.assetId, BTC_TOKEN.assetId)).toBe(null);
  });

  it("never exceeds 4 probes total (parse-bonus counts toward the bound)", async () => {
    // Every rejection carries a parsable integer to test the bonus loop —
    // but the bonus probe is also bounded at the same MAX_PROBES = 4.
    const { fn, callsArgs } = makeMockQuote([
      { matchAmount: "63", reject: "try at least 100" },
      { matchAmount: "100", reject: "try at least 200" },
      { matchAmount: "200", reject: "try at least 300" },
      { matchAmount: "300", reject: "try at least 400" },
      // 5th call would exceed MAX_PROBES — should never fire.
    ]);
    const result = await probePerPairMinimum({
      fromAsset: ETH_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      quoteFn: fn,
    });
    expect(result).toBe(null);
    expect(callsArgs.length).toBe(4);
  });

  it("schedule override via scheduleOverride arg uses overridden USD level", async () => {
    // $25 of BTC at $80,419: ceil(25/80419 * 1e8) = 31088 sat.
    const { fn, callsArgs } = makeMockQuote([
      {
        matchAmount: "31088",
        ok: {
          quote: {
            amountIn: "1000000000000000",
            minAmountIn: "950000000000000",
            amountOut: "31088",
            minAmountOut: "31088",
            amountOutUsd: "25.00",
            timeEstimate: 100,
          },
        },
      },
    ]);
    const result = await probePerPairMinimum({
      fromAsset: ETH_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      scheduleOverride: [25], // single $25 entry instead of the default [0.05, 0.20, 1, 5]
      quoteFn: fn,
    });
    expect(callsArgs.length).toBe(1);
    expect(callsArgs[0].amount).toBe("31088");
    expect(result?.minAtomicIn).toBe("950000000000000");
    expect(result?.expectedAmountOutUsd).toBe("25.00");
  });

  it("skips schedule entries when destination price is unavailable", async () => {
    const NO_PRICE_TOKEN: NearIntentsToken = {
      ...BTC_TOKEN,
      price: 0,
    };
    const { fn, callsArgs } = makeMockQuote([]);
    const result = await probePerPairMinimum({
      fromAsset: ETH_TOKEN,
      toAsset: NO_PRICE_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      quoteFn: fn,
    });
    expect(result).toBe(null);
    expect(callsArgs.length).toBe(0);
  });

  it("network error short-circuits the loop early (treats as exhausted)", async () => {
    const fn = async (): Promise<IntentsQuoteResponse> => {
      throw new Error("network unreachable");
    };
    const result = await probePerPairMinimum({
      fromAsset: ETH_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      quoteFn: fn,
    });
    // Loop continues attempting all 4 levels but every one throws.
    // None succeed → returns null. Caller falls back to reactive parser.
    expect(result).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// buildExactInputDryProbe
// ---------------------------------------------------------------------------

describe("buildExactInputDryProbe — request body shape", () => {
  it("locks the body shape exactly (regression)", () => {
    const body = buildExactInputDryProbe({
      fromAsset: POL_TOKEN,
      toAsset: BTC_TOKEN,
      sourceAmountAtomic: "706000000000000000",
      walletAddresses: HARDHAT_WALLET,
    });
    expect(body.dry).toBe(true);
    expect(body.swapType).toBe("EXACT_INPUT");
    expect(body.slippageTolerance).toBe(500);
    expect(body.originAsset).toBe("nep245:v2_1.omni.hot.tg:137_11111111111111111111");
    expect(body.destinationAsset).toBe("nep141:btc.omft.near");
    expect(body.amount).toBe("706000000000000000");
    expect(body.depositType).toBe("ORIGIN_CHAIN");
    expect(body.recipientType).toBe("DESTINATION_CHAIN");
    expect(body.refundType).toBe("ORIGIN_CHAIN");
    expect(body.recipient).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(body.refundTo).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(body.quoteWaitingTimeMs).toBe(0);
    expect(body.deadline).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// probeExactInputFallback — the HOT Omni-Bridge / POL fix
// ---------------------------------------------------------------------------
//
// Live-verified 2026-07-01: a dry EXACT_OUTPUT probe for POL → BTC (POL's
// asset id is the newer `nep245:` HOT Omni-Bridge shape) returns
// {"message":"Failed to get quote"} — no digits, unparseable. The SAME
// pair asked via dry EXACT_INPUT returns {"message":"Amount is too low
// for bridge, try at least 74818831572074059154"} — the specific shape
// the reactive parser already knows how to read. These tests pin that
// fallback strategy against regression.

describe("probeExactInputFallback — adaptive ascending EXACT_INPUT probe", () => {
  beforeEach(() => clearPairMinimumCache());

  it("first probe rejected with 'try at least N' → caches + returns in 1 call (the live POL→BTC case)", async () => {
    // First schedule rung ($0.05 of POL) computed via the real helper —
    // avoids hand-guessing an atomic amount that the mock's strict
    // amount-match would then reject.
    const firstRungAtomic = dollarAmountAtomic(POL_TOKEN, 0.05);
    const { fn, callsArgs } = makeMockQuote([
      {
        matchAmount: firstRungAtomic,
        reject: "Amount is too low for bridge, try at least 74818831572074059154",
      },
    ]);
    const result = await probeExactInputFallback({
      fromAsset: POL_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      quoteFn: fn,
    });
    expect(result?.minAtomicIn).toBe("74818831572074059154");
    expect(result?.probesUsed).toBe(1);
    expect(callsArgs.length).toBe(1);
    expect(callsArgs[0].swapType).toBe("EXACT_INPUT");
    expect(callsArgs[0].amount).toBe(firstRungAtomic);
    const cached = getPairMinimumEntry(POL_TOKEN.assetId, BTC_TOKEN.assetId);
    expect(cached?.atomic).toBe("74818831572074059154");
    expect(cached?.source).toBe("probe");
  });

  it("first probe succeeds (floor at/below the cheap rung) → returns null, no cache write", async () => {
    const firstRungAtomic = dollarAmountAtomic(POL_TOKEN, 0.05);
    const { fn, callsArgs } = makeMockQuote([
      {
        matchAmount: firstRungAtomic,
        ok: {
          quote: {
            amountIn: firstRungAtomic,
            minAmountIn: firstRungAtomic,
            amountOut: "50",
            minAmountOut: "48",
            timeEstimate: 300,
          },
        },
      },
    ]);
    const result = await probeExactInputFallback({
      fromAsset: POL_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      quoteFn: fn,
    });
    expect(result).toBe(null);
    expect(callsArgs.length).toBe(1);
    expect(getPairMinimum(POL_TOKEN.assetId, BTC_TOKEN.assetId)).toBe(null);
  });

  it("unparseable rejections exhaust after 2 probes (bounded, cheaper than the primary probe)", async () => {
    const { fn, callsArgs } = makeMockQuote([
      { matchAmount: dollarAmountAtomic(POL_TOKEN, 0.05), reject: "Failed to get quote" },
      { matchAmount: dollarAmountAtomic(POL_TOKEN, 0.2), reject: "Failed to get quote" },
      // A 3rd call would exceed MAX_FALLBACK_PROBES — should never fire.
    ]);
    const result = await probeExactInputFallback({
      fromAsset: POL_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      quoteFn: fn,
    });
    expect(result).toBe(null);
    expect(callsArgs.length).toBe(2);
  });

  it("schedule override respected", async () => {
    // $25 of POL at $0.0707: ceil(25/0.0707 * 1e18) ≈ 353605374822 * 1e9.
    const { fn, callsArgs } = makeMockQuote([
      {
        matchAmount: dollarAmountAtomic(POL_TOKEN, 25),
        reject: "Amount is too low for bridge, try at least 74818831572074059154",
      },
    ]);
    const result = await probeExactInputFallback({
      fromAsset: POL_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      scheduleOverride: [25],
      quoteFn: fn,
    });
    expect(callsArgs.length).toBe(1);
    expect(result?.minAtomicIn).toBe("74818831572074059154");
  });

  it("skips schedule entries when source price is unavailable", async () => {
    const NO_PRICE_TOKEN: NearIntentsToken = { ...POL_TOKEN, price: 0 };
    const { fn, callsArgs } = makeMockQuote([]);
    const result = await probeExactInputFallback({
      fromAsset: NO_PRICE_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      quoteFn: fn,
    });
    expect(result).toBe(null);
    expect(callsArgs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cache TTL behavior
// ---------------------------------------------------------------------------

describe("pair-min cache TTL", () => {
  beforeEach(() => clearPairMinimumCache());

  it("probe entry within 5 min TTL is returned", () => {
    setPairMinimum(ETH_TOKEN.assetId, BTC_TOKEN.assetId, "2892245711216987", {
      source: "probe",
      expectedAmountOutUsd: "5.1472",
    });
    expect(getPairMinimum(ETH_TOKEN.assetId, BTC_TOKEN.assetId)).toBe(
      "2892245711216987",
    );
  });

  it("probe entry past 5 min TTL is dropped on access", () => {
    setPairMinimum(ETH_TOKEN.assetId, BTC_TOKEN.assetId, "2892245711216987", {
      source: "probe",
    });
    // Rewind learnedAt to 6 minutes ago.
    _setLearnedAtForTests(
      ETH_TOKEN.assetId,
      BTC_TOKEN.assetId,
      Date.now() - 6 * 60 * 1000,
    );
    expect(getPairMinimum(ETH_TOKEN.assetId, BTC_TOKEN.assetId)).toBe(null);
  });

  it("upstream-error entry past 5 min but within 30 min TTL still returned", () => {
    setPairMinimum(ETH_TOKEN.assetId, BTC_TOKEN.assetId, "1000000", {
      source: "upstream-error",
    });
    _setLearnedAtForTests(
      ETH_TOKEN.assetId,
      BTC_TOKEN.assetId,
      Date.now() - 10 * 60 * 1000, // 10 minutes ago
    );
    expect(getPairMinimum(ETH_TOKEN.assetId, BTC_TOKEN.assetId)).toBe("1000000");
  });

  it("upstream-error entry past 30 min TTL is dropped", () => {
    setPairMinimum(ETH_TOKEN.assetId, BTC_TOKEN.assetId, "1000000", {
      source: "upstream-error",
    });
    _setLearnedAtForTests(
      ETH_TOKEN.assetId,
      BTC_TOKEN.assetId,
      Date.now() - 31 * 60 * 1000,
    );
    expect(getPairMinimum(ETH_TOKEN.assetId, BTC_TOKEN.assetId)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Schedule env-var parsing
// ---------------------------------------------------------------------------

describe("readScheduleEnv", () => {
  // Note: the env-var read happens at module-import time via Vite's
  // import.meta.env, which is hard to mutate at runtime. These tests
  // exercise the parsing logic via the public function — for full env
  // override coverage, set VITE_PWNDA_PAIRMIN_PROBE_USD_SCHEDULE before
  // running the test suite.
  it("returns null when env var is unset (default schedule used)", () => {
    // import.meta.env.VITE_PWNDA_PAIRMIN_PROBE_USD_SCHEDULE is undefined
    // in the test environment — the function should return null.
    expect(readScheduleEnv()).toBe(null);
  });

  // Indirect: the parsing logic is internal but trivial. The probe
  // tests above use `scheduleOverride` to verify the parsed schedule
  // would route correctly through the loop.
});

// ---------------------------------------------------------------------------
// Hint copy formatter
// ---------------------------------------------------------------------------

describe("formatUsdSubLine — destination USD anchor for hint copy", () => {
  it("normal range $5.1472 → '5.15'", () => {
    expect(formatUsdSubLine("5.1472")).toBe("5.15");
  });

  it("$0.05 → '0.05'", () => {
    expect(formatUsdSubLine("0.05")).toBe("0.05");
  });

  it("$0.0023 → '0.0023' (4 decimals retained for sub-cent values)", () => {
    expect(formatUsdSubLine("0.0023")).toBe("0.0023");
  });

  it("$1234.5678 → '1234.57'", () => {
    expect(formatUsdSubLine("1234.5678")).toBe("1234.57");
  });

  it("$0 or invalid → '0.00'", () => {
    expect(formatUsdSubLine("0")).toBe("0.00");
    expect(formatUsdSubLine("invalid")).toBe("0.00");
    expect(formatUsdSubLine("")).toBe("0.00");
  });

  it("trims trailing zeros for sub-cent values", () => {
    expect(formatUsdSubLine("0.0010")).toBe("0.001");
  });

  // Issue 3 (2026-05-10): USD sub-lines under YOU SEND / YOU RECEIVE.
  // Source side accepts both number-stringified inputs (from local
  // price × amount) and the 1Click `amountInUsd` field directly.
  it("formats local computation outputs (e.g. 11.5790... from 0.005 × 2315.81)", () => {
    const computed = (0.005 * 2315.81).toString();
    expect(formatUsdSubLine(computed)).toBe("11.58");
  });

  it("formats 1Click's amountInUsd response field verbatim", () => {
    // Live-capture from the per-pair-min research §8: ETH input → BTC.
    // amountInUsd: "7.0521" → display as "7.05".
    expect(formatUsdSubLine("7.0521")).toBe("7.05");
  });
});

// ---------------------------------------------------------------------------
// "Amount is too low for bridge" pattern coverage (Issue 1, 2026-05-10)
// ---------------------------------------------------------------------------
//
// The user reported seeing the proxy's wrapped 4xx envelope in the UI:
//   {"error":"UPSTREAM","message":"Upstream API request failed",
//    "upstreamStatus":400,"upstreamMessage":"Amount is too low for
//    bridge, try at least 2938452937037670","requestId":"..."}
//
// The original trigger regex matched "minimum/too small/below/less than/
// min...amount" — none of which appeared in the upstream wording "too
// low" / "at least". Confirms the parse falls through cleanly now that
// the trigger covers both "too low" and "at least".
//
// We test the parser's regex against the actual error body the user
// captured. The trigger detection lives in useSwapQuote.ts; here we
// just verify parseMinAtomicFromUpstreamError extracts the right
// integer from the proxy's wrapper format.

describe("upstream-error parser — proxy-wrapped 'too low' rejection", () => {
  it("parses the user-reported wrapper envelope shape verbatim", () => {
    const wrapped =
      'Quote request rejected by upstream: proxy returned 400: ' +
      '{"error":"UPSTREAM","message":"Upstream API request failed",' +
      '"upstreamStatus":400,"upstreamMessage":"Amount is too low for ' +
      'bridge, try at least 2938452937037670",' +
      '"requestId":"832735b57a1f905942dfd25d95df10f0"}';
    const min = parseMinAtomicFromUpstreamError(wrapped);
    expect(min).toBe("2938452937037670");
  });

  it("extracts the bridge minimum from the live ETH→BTC capture", () => {
    // Verbatim from the 2026-05-09 live capture in research doc §8.
    const min = parseMinAtomicFromUpstreamError(
      "Amount is too low for bridge, try at least 6400",
    );
    expect(min).toBe("6400");
  });

  it("ignores 3-digit HTTP-status integers (e.g. 400) and 6+-digit hex prefixes within requestIds", () => {
    // The wrapper carries the HTTP status (400) and a hex requestId
    // ("832735b57a1f..."). The 3-digit 400 is filtered by the >=4-digit
    // rule. The hex requestId starts with digits but has letters mixed
    // in — `\b\d{4,}\b` requires word-boundary at both ends, so it
    // does not match the digit prefix of an alphanumeric token.
    const wrapped =
      'proxy returned 400: {"upstreamStatus":400,' +
      '"upstreamMessage":"Amount is too low for bridge, try at least 6400",' +
      '"requestId":"832735b57a1f905942dfd25d95df10f0"}';
    expect(parseMinAtomicFromUpstreamError(wrapped)).toBe("6400");
  });
});

// ── bisectExactInputMinimum (2026-09-05) ─────────────────────────────────
// Both USD-scheduled probes skip every rung when the tokens list has no
// price for the source (ADA), so MIN reported "no fillable size" while a
// 1 060 ADA quote was live. The bisection needs no price.
describe("bisectExactInputMinimum — a minimum without a price", () => {
  // A source with NO listed price (the ADA case), on an asset id the address
  // resolver knows so the dry probe body can be built.
  const ADA_TOKEN: NearIntentsToken = { ...ETH_TOKEN, price: undefined } as NearIntentsToken;
  const addrs = HARDHAT_WALLET;

  it("converges on the smallest size that quotes, within its probe budget", async () => {
    const floor = 12_345_678n;
    const seen: bigint[] = [];
    const quoteFn = async (req: { amount: string }) => {
      seen.push(BigInt(req.amount));
      if (BigInt(req.amount) < floor) throw new Error("proxy returned 400: No liquidity available");
      return { quote: { amountIn: req.amount } } as never;
    };
    const r = await bisectExactInputMinimum({
      fromAsset: ADA_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: addrs,
      hiAtomic: "1000000000",
      quoteFn: quoteFn as never,
    });
    expect(r).not.toBeNull();
    const min = BigInt(r!.minAtomicIn);
    expect(min >= floor).toBe(true);
    // 9 probes over 1e9 leaves a window of ~1e9 / 2^8 ≈ 4e6 above the floor.
    expect(min - floor < 8_000_000n).toBe(true);
    expect(r!.probesUsed).toBeLessThanOrEqual(MAX_BISECT_PROBES);
    expect(seen[0]).toBe(1000000000n);
  });

  it("returns null when even the upper bound does not quote — no route, not a minimum", async () => {
    const quoteFn = async () => {
      throw new Error("proxy returned 400: No liquidity available");
    };
    expect(
      await bisectExactInputMinimum({
        fromAsset: ADA_TOKEN,
        toAsset: BTC_TOKEN,
        walletAddresses: addrs,
        hiAtomic: "5000000",
        quoteFn: quoteFn as never,
      }),
    ).toBeNull();
    expect(
      await bisectExactInputMinimum({
        fromAsset: ADA_TOKEN,
        toAsset: BTC_TOKEN,
        walletAddresses: addrs,
        hiAtomic: "0",
        quoteFn: quoteFn as never,
      }),
    ).toBeNull();
  });
});

// ── solver waiting time (2026-09-05) ──────────────────────────────────────
// Real quotes give solvers 5 000 ms; the automatic probe asks with 0 ms. A
// single-route chain (Cardano) answers nothing in 0 ms, so every probe read
// as "no liquidity" while MAX quoted. MIN's probes must be able to wait.
describe("probe bodies carry the caller's solver wait", () => {
  it("defaults to 0 and honours an override on both builders", () => {
    const base = { fromAsset: ETH_TOKEN, toAsset: BTC_TOKEN, walletAddresses: HARDHAT_WALLET };
    expect(buildExactInputDryProbe({ ...base, sourceAmountAtomic: "1" }).quoteWaitingTimeMs).toBe(0);
    expect(buildExactOutputDryProbe({ ...base, destAmountAtomic: "1" }).quoteWaitingTimeMs).toBe(0);
    expect(
      buildExactInputDryProbe({ ...base, sourceAmountAtomic: "1", quoteWaitingTimeMs: 5000 }).quoteWaitingTimeMs,
    ).toBe(5000);
    expect(
      buildExactOutputDryProbe({ ...base, destAmountAtomic: "1", quoteWaitingTimeMs: 5000 }).quoteWaitingTimeMs,
    ).toBe(5000);
  });

  it("the bisection passes its wait through and reports the last upstream error", async () => {
    const waits: number[] = [];
    const errors: string[] = [];
    const quoteFn = async (req: { quoteWaitingTimeMs?: number }) => {
      waits.push(req.quoteWaitingTimeMs ?? -1);
      throw new Error("proxy returned 400: No liquidity available");
    };
    const r = await bisectExactInputMinimum({
      fromAsset: ETH_TOKEN,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET,
      hiAtomic: "1000",
      quoteWaitingTimeMs: 5000,
      quoteFn: quoteFn as never,
      onError: (m) => errors.push(m),
    });
    expect(r).toBeNull();
    expect(waits).toEqual([5000]);
    expect(errors[0]).toMatch(/No liquidity/);
  });
});

// ---------------------------------------------------------------------------
// probePairFloor — the one-call floor probe (2026-09-05)
// ---------------------------------------------------------------------------

describe("probePairFloor — ask for too little and let 1Click name the floor", () => {
  beforeEach(() => clearPairMinimumCache());

  /** ADA at $0.215726, 6 decimals — the live token-list entry used for the
   *  2026-09-05 measurements. */
  const ADA: NearIntentsToken = {
    assetId: "nep141:cardano.omft.near",
    decimals: 6,
    blockchain: "cardano",
    symbol: "ADA",
    price: 0.215726,
  } as NearIntentsToken;

  /** The verbatim reply the live API gives below the floor. */
  const TOO_LOW = "Amount is too low for bridge, try at least 32420080";
  /** What it says when the amount is too small to route at all — measured at
   *  one atomic unit, on every pair tried. */
  const GENERIC = "Failed to get quote";

  /** HARDHAT_WALLET plus the ADA address from the same ABANDON vector —
   *  without it `addressForAssetId` throws before any probe is sent. */
  const ADA_WALLET: WalletAddresses = {
    ...HARDHAT_WALLET,
    cardano:
      "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv",
  };

  it("names the floor in ONE call, and asks with zero solver wait", async () => {
    const seen: IntentsQuoteRequest[] = [];
    const result = await probePairFloor({
      fromAsset: ADA,
      toAsset: BTC_TOKEN,
      walletAddresses: ADA_WALLET,
      quoteFn: async (req) => {
        seen.push(req);
        throw new Error(TOO_LOW);
      },
    });
    expect(result?.minAtomicIn).toBe("32420080");
    expect(result?.probesUsed).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].swapType).toBe("EXACT_INPUT");
    expect(seen[0].dry).toBe(true);
    // The measured reason: the parameter is a floor on latency, not a
    // timeout, so 5 000 ms would add ~4.7 s to a call whose useful answer is
    // a rejection that arrives in ~0.78 s anyway.
    expect(seen[0].quoteWaitingTimeMs).toBe(0);
    // $1 of ADA at the pinned price — deliberately below every floor measured
    // (all near $7), so the first call lands in the band that names the number.
    expect(seen[0].amount).toBe(dollarAmountAtomic(ADA, 1));
    // ...and it is cached, so the next MIN press costs nothing.
    expect(getPairMinimum(ADA.assetId, BTC_TOKEN.assetId)).toBe("32420080");
  });

  it("steps UP when the first size is too small to route at all", async () => {
    const amounts: string[] = [];
    const result = await probePairFloor({
      fromAsset: ADA,
      toAsset: BTC_TOKEN,
      walletAddresses: ADA_WALLET,
      startUsd: 0.000001, // absurdly small on purpose
      quoteFn: async (req) => {
        amounts.push(req.amount);
        // Generic until the amount grows past a threshold, then the real shape.
        if (BigInt(req.amount) < 100n) throw new Error(GENERIC);
        throw new Error(TOO_LOW);
      },
    });
    expect(result?.minAtomicIn).toBe("32420080");
    expect(amounts.length).toBeGreaterThan(1);
    // Each step multiplies by FLOOR_PROBE_STEP.
    for (let i = 1; i < amounts.length; i++) {
      expect(BigInt(amounts[i])).toBe(
        BigInt(amounts[i - 1]) * BigInt(FLOOR_PROBE_STEP),
      );
    }
  });

  it("steps DOWN when the first size quotes, and reports the smallest that did", async () => {
    // A pair whose floor is below $1 — ADA→LTC behaved this way live.
    const amounts: string[] = [];
    const result = await probePairFloor({
      fromAsset: ADA,
      toAsset: BTC_TOKEN,
      walletAddresses: ADA_WALLET,
      quoteFn: async (req) => {
        amounts.push(req.amount);
        return {} as IntentsQuoteResponse; // every size routes
      },
    });
    expect(amounts.length).toBe(FLOOR_PROBE_MAX_CALLS);
    for (let i = 1; i < amounts.length; i++) {
      expect(BigInt(amounts[i])).toBe(
        BigInt(amounts[i - 1]) / BigInt(FLOOR_PROBE_STEP),
      );
    }
    // The answer is the smallest size that actually quoted — a true upper
    // bound on the floor, and safe to put in the field.
    expect(result?.minAtomicIn).toBe(amounts[amounts.length - 1]);
  });

  it("never exceeds its call bound", async () => {
    let calls = 0;
    const result = await probePairFloor({
      fromAsset: ADA,
      toAsset: BTC_TOKEN,
      walletAddresses: ADA_WALLET,
      quoteFn: async () => {
        calls++;
        throw new Error(GENERIC); // never parseable, never routes
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(FLOOR_PROBE_MAX_CALLS);
  });

  it("reports the venue's own words when it learns nothing", async () => {
    let said: string | null = null;
    const result = await probePairFloor({
      fromAsset: ADA,
      toAsset: BTC_TOKEN,
      walletAddresses: ADA_WALLET,
      quoteFn: async () => {
        throw new Error("No liquidity available");
      },
      onError: (m) => {
        said = m;
      },
    });
    expect(result).toBeNull();
    expect(said).toBe("No liquidity available");
  });

  it("works for a source asset with no listed price, from a size known to route", async () => {
    const NO_PRICE = { ...ADA, price: undefined } as unknown as NearIntentsToken;
    const amounts: string[] = [];
    const result = await probePairFloor({
      fromAsset: NO_PRICE,
      toAsset: BTC_TOKEN,
      walletAddresses: ADA_WALLET,
      seedAtomic: "1000000000", // 1 000 ADA, e.g. the wallet balance
      quoteFn: async (req) => {
        amounts.push(req.amount);
        throw new Error(TOO_LOW);
      },
    });
    expect(result?.minAtomicIn).toBe("32420080");
    // A thousandth of the known-good size.
    expect(amounts[0]).toBe("1000000");
  });

  it("gives up rather than guessing when it has neither a price nor a seed", async () => {
    const NO_PRICE = { ...ADA, price: undefined } as unknown as NearIntentsToken;
    let called = 0;
    const result = await probePairFloor({
      fromAsset: NO_PRICE,
      toAsset: BTC_TOKEN,
      walletAddresses: ADA_WALLET,
      quoteFn: async () => {
        called++;
        throw new Error(TOO_LOW);
      },
    });
    expect(result).toBeNull();
    expect(called).toBe(0);
  });

  /**
   * The 2026-09-05 incident, pinned in both halves.
   *
   * `PLACEHOLDER_ADDRESSES` had no `cardano` entry, so on every ADA pair
   * `addressForAssetId` threw *before any network call* — and its sentence
   * ends "(CIP-1852 path)". The old code parsed that thrown message for a
   * minimum and found `1852`, which is how MIN "didn't respond, then said
   * there are no pairs" while MAX quoted the same pair fine.
   */
  it("a missing address is a local fault, not a minimum of 1852", async () => {
    let called = 0;
    let said: string | null = null;
    const result = await probePairFloor({
      fromAsset: ADA,
      toAsset: BTC_TOKEN,
      walletAddresses: HARDHAT_WALLET, // no cardano address
      quoteFn: async () => {
        called++;
        throw new Error(TOO_LOW);
      },
      onError: (m) => {
        said = m;
      },
    });
    expect(result).toBeNull();
    expect(called).toBe(0); // nothing was sent
    expect(said).toContain("ADA address");
    expect(getPairMinimum(ADA.assetId, BTC_TOKEN.assetId)).toBeNull();
  });

  /** ...and the parser itself refuses that sentence, wherever it is called
   *  from. Belt and braces: the guard above stops it reaching the parser,
   *  this one stops the parser inventing a floor if it ever does again. */
  it("the parser will not read a floor out of an unrelated message", () => {
    expect(
      parseMinAtomicFromUpstreamError(
        "No derived ADA address — open the Cardano chain in the dashboard so " +
          "the wallet derives one (CIP-1852 path), then retry.",
      ),
    ).toBeNull();
    // ...while the real shape still parses.
    expect(parseMinAtomicFromUpstreamError(TOO_LOW)).toBe("32420080");
  });
});
