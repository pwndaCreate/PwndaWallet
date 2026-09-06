/**
 * Regression locks for the 2026-05-25 SwapKit live cutover.
 *
 * Four covered cases:
 *   1. Defense-in-depth: a route carrying the mock UUID still flips
 *      `mockDetected: true` regardless of how the env flag is read.
 *      This is what prevents a misconfigured proxy from quietly serving
 *      mocks during the live window.
 *   2. `pickAutoBest` is a POST-FEE destination-side comparison — the
 *      side with the higher `expectedReceive` wins, even when its
 *      headline rate or source-side gas cost looks worse.
 *   3. `formatPwndaFee` renders the affiliate row correctly across the
 *      zero-fee, valid-percent, and malformed-sellAmount branches.
 *   4. `shouldShowCanaryBanner` gates on the user's actual routing
 *      preference + the resolved quote source, not just the env flag.
 *      Pure NEAR-Intents picks hide the banner (banner is informational
 *      only when SwapKit could actually run).
 */
import { describe, expect, it, vi } from "vitest";
import {
  MOCK_SWAPKIT_ROUTE_ID,
  isMockSwapKitResponse,
} from "./router-modes";
import {
  normalizeSwapKit,
  pickAutoBest,
  type NormalizedQuote,
} from "./useSwapQuote";
import { SWAP_COIN_META } from "./swap-data";
import { formatPwndaFee } from "./SwapConfirmModal";
import { shouldShowCanaryBanner } from "./SwapForm";

/* ─── 1. MOCK-UUID defense ──────────────────────────────────── */

describe("MOCK_SWAPKIT_ROUTE_ID defense (Case 1)", () => {
  it("isMockSwapKitResponse flags the canonical mock route id", () => {
    expect(
      isMockSwapKitResponse({
        routeId: MOCK_SWAPKIT_ROUTE_ID,
        providers: ["mock"],
        expectedBuyAmount: "0.013",
      })
    ).toBe(true);
  });

  it("isMockSwapKitResponse is false for a real-looking route id", () => {
    expect(
      isMockSwapKitResponse({
        routeId: "5e1bd5a4-f06f-4f4b-9d35-2bcb6cf3a3f3",
        providers: ["THORCHAIN"],
        expectedBuyAmount: "0.013",
      })
    ).toBe(false);
  });

  it("normalizeSwapKit sets mockDetected=true when the route carries the MOCK UUID, regardless of provider strings", () => {
    // Even if the route's `providers` look real, the UUID alone forces
    // mock mode. This is the load-bearing assertion: a misconfigured
    // proxy can't smuggle a mock route past the UI even if it labels
    // it as THORCHAIN.
    const normalized = normalizeSwapKit(
      {
        quoteId: "q1",
        routes: [
          {
            routeId: MOCK_SWAPKIT_ROUTE_ID,
            providers: ["THORCHAIN"], // not "mock" — UUID still wins
            expectedBuyAmount: "0.013",
            fees: { network: "0.0001", affiliate: "0.0015" },
            estimatedTime: { total: 600 },
          },
        ],
      },
      0.02,
      SWAP_COIN_META.ETH
    );
    expect(normalized?.mockDetected).toBe(true);
    expect(normalized?.source).toBe("swapkit");
  });

  it("normalizeSwapKit sets mockDetected=false for a non-mock route id", () => {
    const normalized = normalizeSwapKit(
      {
        quoteId: "q1",
        routes: [
          {
            routeId: "5e1bd5a4-f06f-4f4b-9d35-2bcb6cf3a3f3",
            providers: ["THORCHAIN"],
            expectedBuyAmount: "0.013",
            fees: { network: "0.0001", affiliate: "0.0015" },
            estimatedTime: { total: 600 },
          },
        ],
      },
      0.02,
      SWAP_COIN_META.ETH
    );
    expect(normalized?.mockDetected).toBe(false);
  });
});

/* ─── 1b. Live-shape fee parser (array of typed entries) ────── */

describe("normalizeSwapKit — live array-shape fees (post-2026-05-25 cutover)", () => {
  // Fixture captured 2026-05-25 from the user's actual live BTC→ETH 0.0005
  // quote against https://wallet.pwnda.org after the SwapKit cutover.
  // Pins the array-shape parser against the legacy object-shape parser so
  // a future drift back to the object shape (mock proxy fallback) would
  // be a test failure, not silent data loss.
  const LIVE_RESPONSE = {
    quoteId: "72f5b992-7f5e-4493-8b0d-23977389dc63",
    routes: [
      {
        routeId: "a8d07958-ee1d-4776-a9bd-4565cab50c2a",
        providers: ["NEAR"],
        expectedBuyAmount: "0.018150507342858749",
        fees: [
          { type: "affiliate", amount: "0", amountBps: 0 },
          { type: "service", amount: "0.00000075", amountBps: 15 },
          { type: "outbound", amount: "0.000035" },
          { type: "inbound", amount: "0.000008" },
        ],
        estimatedTime: { total: 2018.25 },
        meta: { tags: ["RECOMMENDED", "CHEAPEST"] },
      },
      {
        routeId: "b9e18a69-ff2e-5887-bace-5676db61b3d3",
        providers: ["FLASHNET"],
        expectedBuyAmount: "0.017904994437942479",
        estimatedTime: { total: 642.5 },
      },
    ],
  };

  it("picks the highest-expectedBuyAmount route (NEAR > FLASHNET)", () => {
    const normalized = normalizeSwapKit(LIVE_RESPONSE, 0.02, SWAP_COIN_META.ETH);
    expect(normalized?.providerName).toBe("NEAR");
    expect(normalized?.expectedReceive).toBe("0.018150507342858749");
  });

  it("does NOT flag the live response as mock", () => {
    const normalized = normalizeSwapKit(LIVE_RESPONSE, 0.02, SWAP_COIN_META.ETH);
    expect(normalized?.mockDetected).toBe(false);
  });

  it("parses array-shape fees into the normalized totalFeesSource (inbound + outbound + service, affiliate excluded)", () => {
    const normalized = normalizeSwapKit(LIVE_RESPONSE, 0.02, SWAP_COIN_META.ETH);
    // inbound 0.000008 + outbound 0.000035 + service 0.00000075 + network 0
    //                                                        = 0.00004375
    // Affiliate (0) is reported separately in affiliateFeeSource, not summed
    // into totalFeesSource (mirrors the legacy object-shape behavior).
    expect(Number(normalized?.totalFeesSource)).toBeCloseTo(0.00004375, 9);
  });

  it("parses array-shape affiliate=0 into affiliateFeeSource='0' (AFFILIATE_NAME='' path)", () => {
    const normalized = normalizeSwapKit(LIVE_RESPONSE, 0.02, SWAP_COIN_META.ETH);
    expect(normalized?.affiliateFeeSource).toBe("0");
  });

  it("falls back to 0 for unknown fee types without crashing", () => {
    const resp = {
      quoteId: "q-future",
      routes: [
        {
          routeId: "real-route-id",
          providers: ["NEAR"],
          expectedBuyAmount: "0.018",
          fees: [
            { type: "future_unknown_type", amount: "0.001" },
            { type: "inbound", amount: "0.000008" },
          ],
          estimatedTime: { total: 600 },
        },
      ],
    };
    const normalized = normalizeSwapKit(resp, 0.02, SWAP_COIN_META.ETH);
    // Only the inbound entry contributes (0.000008); unknown type is dropped.
    expect(Number(normalized?.totalFeesSource)).toBeCloseTo(0.000008, 9);
    expect(normalized?.affiliateFeeSource).toBe("0");
  });

  it("still handles the legacy object-shape (mock-mode proxy compatibility)", () => {
    // Regression guard: if a proxy regresses to mock-mode, fee parsing
    // must not break — the MOCK_UUID detection layer handles the mock
    // classification, fee parsing just needs to keep working.
    const legacy = {
      quoteId: "q-legacy",
      routes: [
        {
          routeId: "5e1bd5a4-f06f-4f4b-9d35-2bcb6cf3a3f3",
          providers: ["THORCHAIN"],
          expectedBuyAmount: "0.013",
          fees: {
            inbound: "0.0001",
            network: "0.0002",
            outbound: "0.00009",
            service: "0",
            affiliate: "0.0015",
          },
          estimatedTime: { total: 600 },
        },
      ],
    };
    const normalized = normalizeSwapKit(legacy, 0.02, SWAP_COIN_META.ETH);
    expect(Number(normalized?.totalFeesSource)).toBeCloseTo(0.00039, 9);
    expect(normalized?.affiliateFeeSource).toBe("0.0015");
  });
});

/* ─── 2. Auto Best is post-fee, destination-side ─────────────── */

describe("pickAutoBest — post-fee destination comparison (Case 2)", () => {
  function makeQuote(
    source: "swapkit" | "intents",
    expectedReceive: string,
    overrides?: Partial<NormalizedQuote>
  ): NormalizedQuote {
    return {
      source,
      routerLabel: source === "swapkit" ? "SwapKit" : "NEAR Intents",
      providerName: source === "swapkit" ? "THORCHAIN" : "solver-relay",
      mockDetected: false,
      expectedReceive,
      minReceived: expectedReceive,
      totalFeesSource: "0",
      affiliateFeeSource: "0",
      etaSeconds: 600,
      etaPretty: "~10m",
      warnings: [],
      ...overrides,
    };
  }

  it("picks the side with the higher expectedReceive (SwapKit wins)", () => {
    const swap = makeQuote("swapkit", "0.0131");
    const intents = makeQuote("intents", "0.0128");
    expect(pickAutoBest(swap, intents)?.source).toBe("swapkit");
  });

  it("picks the side with the higher expectedReceive (Intents wins)", () => {
    const swap = makeQuote("swapkit", "0.0128");
    const intents = makeQuote("intents", "0.0131");
    expect(pickAutoBest(swap, intents)?.source).toBe("intents");
  });

  it("picks Intents when its lower-fee post-fee output beats SwapKit even though SwapKit has higher headline gas cost reported separately", () => {
    // Scenario the user raised: SwapKit reports higher network gas in
    // source units, but its `expectedReceive` is also lower (gas
    // doesn't enter the destination receive). The comparison must
    // pick whichever side actually delivers more on the destination.
    const swap = makeQuote("swapkit", "0.0125", {
      totalFeesSource: "0.005", // high source-side gas
    });
    const intents = makeQuote("intents", "0.0130", {
      totalFeesSource: "0", // 1Click rolls everything into amountOut
    });
    expect(pickAutoBest(swap, intents)?.source).toBe("intents");
    expect(pickAutoBest(swap, intents)?.expectedReceive).toBe("0.0130");
  });

  it("tie goes to SwapKit (a >= b)", () => {
    const swap = makeQuote("swapkit", "0.013");
    const intents = makeQuote("intents", "0.013");
    expect(pickAutoBest(swap, intents)?.source).toBe("swapkit");
  });

  it("falls back to the single-side quote when the other upstream is null", () => {
    const intents = makeQuote("intents", "0.013");
    expect(pickAutoBest(null, intents)?.source).toBe("intents");
    const swap = makeQuote("swapkit", "0.013");
    expect(pickAutoBest(swap, null)?.source).toBe("swapkit");
  });

  it("returns null when both upstreams are null", () => {
    expect(pickAutoBest(null, null)).toBeNull();
  });
});

/* ─── 3. Pwnda fee row formatting ───────────────────────────── */

describe("formatPwndaFee — affiliate-fee row formatting (Case 3)", () => {
  it("renders amount + percentage for a typical SwapKit affiliate row", () => {
    // 0.0015 ETH affiliate on a 0.5 ETH swap = 0.30%
    expect(formatPwndaFee("0.0015", "0.5", "ETH")).toBe("0.0015 ETH · 0.3%");
  });

  it("trims trailing zeros in the percentage display", () => {
    // 0.005 / 1 = 0.5% exact — no trailing zeros after .5
    expect(formatPwndaFee("0.005", "1", "ETH")).toBe("0.005 ETH · 0.5%");
  });

  it("falls back to em-dash when the affiliate fee is zero (NEAR Intents path)", () => {
    expect(formatPwndaFee("0", "0.5", "ETH")).toBe("—");
  });

  it("falls back to em-dash for non-numeric affiliate values", () => {
    expect(formatPwndaFee("", "0.5", "ETH")).toBe("—");
    expect(formatPwndaFee("NaN", "0.5", "ETH")).toBe("—");
  });

  it("omits the percentage (renders amount only) when sellAmount is malformed", () => {
    // Defensive — don't render "NaN%" if the typed amount is bad.
    expect(formatPwndaFee("0.0015", "abc", "ETH")).toBe("0.0015 ETH");
    expect(formatPwndaFee("0.0015", "0", "ETH")).toBe("0.0015 ETH");
  });

  it("renders four-decimal precision for tiny percentages", () => {
    // 0.0001 / 1 = 0.01% — exactly at the boundary, uses 2-decimal branch
    expect(formatPwndaFee("0.0001", "1", "ETH")).toBe("0.0001 ETH · 0.01%");
    // 0.00001 / 1 = 0.001% — below 0.01% boundary, uses 4-decimal branch
    expect(formatPwndaFee("0.00001", "1", "ETH")).toBe(
      "0.00001 ETH · 0.001%"
    );
  });
});

/* ─── 4. Canary banner gating ────────────────────────────────── */

// The env-flag (`VITE_SWAPKIT_CANARY`) is read at module load — we can't
// mutate it from inside a test. Instead we test the routing-gate logic
// by toggling the underlying export. vi.mock lets us swap it cleanly
// without touching import.meta.env.
vi.mock("./router-modes", async (importOriginal) => {
  const original = await importOriginal<typeof import("./router-modes")>();
  return {
    ...original,
    SWAPKIT_CANARY_ACTIVE: true,
  };
});

describe("shouldShowCanaryBanner — gating logic (Case 4)", () => {
  it("shows the banner when preferredRouter is 'swapkit'", () => {
    expect(
      shouldShowCanaryBanner({
        preferredRouter: "swapkit",
        liveQuoteSource: undefined,
        swapKitRoutable: true,
      })
    ).toBe(true);
  });

  it("shows the banner in 'auto' mode when the pair is SwapKit-routable", () => {
    expect(
      shouldShowCanaryBanner({
        preferredRouter: "auto",
        liveQuoteSource: undefined,
        swapKitRoutable: true,
      })
    ).toBe(true);
  });

  it("hides the banner in 'auto' mode when the pair is NOT SwapKit-routable (Intents-only)", () => {
    expect(
      shouldShowCanaryBanner({
        preferredRouter: "auto",
        liveQuoteSource: undefined,
        swapKitRoutable: false,
      })
    ).toBe(false);
  });

  it("hides the banner for explicit NEAR Intents preference", () => {
    expect(
      shouldShowCanaryBanner({
        preferredRouter: "intents",
        liveQuoteSource: "intents",
        swapKitRoutable: true,
      })
    ).toBe(false);
  });

  it("surfaces the banner if a resolved quote actually came from SwapKit (defensive — Auto-mode resolver wins)", () => {
    expect(
      shouldShowCanaryBanner({
        preferredRouter: "intents",
        liveQuoteSource: "swapkit",
        swapKitRoutable: true,
      })
    ).toBe(true);
  });
});
