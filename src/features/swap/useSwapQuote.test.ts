/**
 * Regression locks for `buildIntentsRequestSafely` — specifically the
 * display-units → atomic-units conversion of the `amount` field.
 *
 * Background: 2026-05-06, the wallet was sending the user's display
 * input (`"0.005"`) verbatim as the 1Click `amount` field, where 1Click
 * expects atomic units of the origin asset. The proxy returned 5xx for
 * 38/38 calls because the upstream couldn't parse the decimal.
 *
 * These tests pin the body shape so that if the conversion ever drifts
 * back to display units (or shifts to wrong decimals), the build halts.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  buildIntentsRequestSafely,
  formatAtomicAmount,
  getMinDepositAtomicForAsset,
  isDeskQuoteStale,
  minimumUsdFor,
  normalizeDesk,
  pickAutoBest,
  type NormalizedQuote,
} from "./useSwapQuote";
import { SWAP_COIN_META } from "./swap-data";
import { IntentsValidationError } from "./asset-address-resolver";
import {
  _resetCacheForTests,
  _setCacheForTests,
} from "./near-intents-tokens";

// Hardhat dev mnemonic at m/44'/60'/0'/0/0 — same vector pinned in
// `cargo test swap::derive::vector1_bip39_to_eth_address` and the
// asset-address-resolver test.
const HARDHAT_EVM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ABANDON_BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

describe("buildIntentsRequestSafely — amount conversion", () => {
  it("converts ETH 0.005 to wei (5_000_000_000_000_000)", () => {
    // The exact bug we shipped to fix: form sends `"0.005"`, upstream
    // expects atomic units. Lock the conversion as a regression target.
    const body = buildIntentsRequestSafely({
      fromAsset: "nep141:eth.omft.near",
      toAsset: "nep141:btc.omft.near",
      fromMeta: SWAP_COIN_META.ETH,
      amount: "0.005",
      slippage: 0.02,
      walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
    });
    expect(body.amount).toBe("5000000000000000");
    expect(typeof body.amount).toBe("string");
    // Sanity-check the rest of the body so a future drift in the
    // shape doesn't sneak through.
    expect(body.originAsset).toBe("nep141:eth.omft.near");
    expect(body.destinationAsset).toBe("nep141:btc.omft.near");
    expect(body.recipient).toBe(ABANDON_BTC);
    expect(body.refundTo).toBe(HARDHAT_EVM);
    expect(body.swapType).toBe("EXACT_INPUT");
    expect(body.slippageTolerance).toBe(200); // 0.02 → 200 bps
  });

  it("converts BTC 0.001 to satoshis (100_000)", () => {
    const body = buildIntentsRequestSafely({
      fromAsset: "nep141:btc.omft.near",
      toAsset: "nep141:eth.omft.near",
      fromMeta: SWAP_COIN_META.BTC,
      amount: "0.001",
      slippage: 0.02,
      walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
    });
    expect(body.amount).toBe("100000");
    // Source side became BTC, so the refund is BTC and recipient is EVM.
    expect(body.recipient).toBe(HARDHAT_EVM);
    expect(body.refundTo).toBe(ABANDON_BTC);
  });

  it("preserves whole-number amounts without precision loss", () => {
    // 1 ETH = 1e18 wei. Catches a JS Number-precision regression — the
    // helper uses BigInt internally.
    const body = buildIntentsRequestSafely({
      fromAsset: "nep141:eth.omft.near",
      toAsset: "nep141:btc.omft.near",
      fromMeta: SWAP_COIN_META.ETH,
      amount: "1",
      slippage: 0.02,
      walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
    });
    expect(body.amount).toBe("1000000000000000000");
  });

  it("rejects amounts that round to zero in atomic units", () => {
    // 0.0000000001 ETH × 10^18 = 100 000 000 wei → this case is fine.
    // But e.g. 0.0000000001 BTC × 10^8 = 0.01 sat → rounds to 0 → reject.
    expect(() =>
      buildIntentsRequestSafely({
        fromAsset: "nep141:btc.omft.near",
        toAsset: "nep141:eth.omft.near",
        fromMeta: SWAP_COIN_META.BTC,
        amount: "0.000000001", // 0.1 sat
        slippage: 0.02,
        walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
      }),
    ).toThrow(IntentsValidationError);
  });

  it("rejects malformed amounts with a clear message", () => {
    expect(() =>
      buildIntentsRequestSafely({
        fromAsset: "nep141:eth.omft.near",
        toAsset: "nep141:btc.omft.near",
        fromMeta: SWAP_COIN_META.ETH,
        amount: "not-a-number",
        slippage: 0.02,
        walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
      }),
    ).toThrow(IntentsValidationError);
  });

  it("propagates the resolver's rejection when an address is missing", () => {
    expect(() =>
      buildIntentsRequestSafely({
        fromAsset: "nep141:eth.omft.near",
        toAsset: "nep141:btc.omft.near",
        fromMeta: SWAP_COIN_META.ETH,
        amount: "0.005",
        slippage: 0.02,
        // Wallet hasn't derived a BTC address yet.
        walletAddresses: { evm: HARDHAT_EVM },
      }),
    ).toThrow(IntentsValidationError);
  });
});

describe("buildIntentsRequestSafely — body shape (1Click /api/intents/quote)", () => {
  // The server agent diagnosed (2026-05-06) that the upstream 4xx —
  // "dry should not be empty, dry must be a boolean value" — was caused
  // by `dry` missing from our body. These tests pin every required
  // field's name + type + literal value against the server's known-good
  // body so any future drift fails the build.

  it("includes dry: false as a boolean literal", () => {
    const body = buildIntentsRequestSafely({
      fromAsset: "nep141:eth.omft.near",
      toAsset: "nep141:btc.omft.near",
      fromMeta: SWAP_COIN_META.ETH,
      amount: "0.005",
      slippage: 0.02,
      walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
    });
    expect(body.dry).toBe(false);
    expect(typeof body.dry).toBe("boolean");
  });

  it("matches the server agent's known-good body shape (modulo addresses + deadline)", () => {
    const body = buildIntentsRequestSafely({
      fromAsset: "nep141:eth.omft.near",
      toAsset: "nep141:btc.omft.near",
      fromMeta: SWAP_COIN_META.ETH,
      amount: "0.005",
      slippage: 0.02,
      walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
    });

    // Every required key is present.
    expect(Object.keys(body).sort()).toEqual([
      "amount",
      "deadline",
      "depositType",
      "destinationAsset",
      "dry",
      "originAsset",
      "quoteWaitingTimeMs",
      "recipient",
      "recipientType",
      "refundTo",
      "refundType",
      "slippageTolerance",
      "swapType",
    ]);

    // Per-field type + value locks. If any of these drifts, the build
    // halts with a precise message — easier to triage than a 5xx.
    expect(body.dry).toBe(false);
    expect(typeof body.dry).toBe("boolean");

    expect(body.swapType).toBe("EXACT_INPUT");
    expect(typeof body.swapType).toBe("string");

    expect(body.slippageTolerance).toBe(200);
    expect(typeof body.slippageTolerance).toBe("number");
    expect(Number.isInteger(body.slippageTolerance)).toBe(true);

    expect(body.originAsset).toBe("nep141:eth.omft.near");
    expect(typeof body.originAsset).toBe("string");

    expect(["INTENTS", "ORIGIN_CHAIN"]).toContain(body.depositType);
    expect(typeof body.depositType).toBe("string");

    expect(body.destinationAsset).toBe("nep141:btc.omft.near");
    expect(typeof body.destinationAsset).toBe("string");

    expect(["DESTINATION_CHAIN", "INTENTS"]).toContain(body.recipientType);
    expect(typeof body.recipientType).toBe("string");

    // Atomic-units conversion lock — same as the dedicated test above
    // but pinned here too so the body-shape test stands alone.
    expect(body.amount).toBe("5000000000000000");
    expect(typeof body.amount).toBe("string");

    expect(body.recipient).toBe(ABANDON_BTC);
    expect(typeof body.recipient).toBe("string");

    expect(["ORIGIN_CHAIN", "INTENTS"]).toContain(body.refundType);
    expect(typeof body.refundType).toBe("string");

    expect(body.refundTo).toBe(HARDHAT_EVM);
    expect(typeof body.refundTo).toBe("string");

    // Deadline is timestamp-dependent; assert ISO 8601 prefix and a
    // future point in time (within the allowed 10-min window).
    expect(typeof body.deadline).toBe("string");
    expect(body.deadline).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    );
    const deadlineMs = new Date(body.deadline).getTime();
    expect(Number.isFinite(deadlineMs)).toBe(true);
    expect(deadlineMs).toBeGreaterThan(Date.now());
    expect(deadlineMs).toBeLessThan(Date.now() + 11 * 60 * 1000);

    expect(body.quoteWaitingTimeMs).toBe(5000);
    expect(typeof body.quoteWaitingTimeMs).toBe("number");
  });
});

/* ──────────────────────────────────────────────────────────────────
   Per-source-chain regression locks (added 2026-05-06)

   Each test pins a buildIntentsRequest body for one source chain:
     EVM (ETH on Ethereum) → BTC
     UTXO (BTC) → ETH
     Solana (SOL) → BTC
     NEAR-native → BTC
     Bridged USDC on Base → BTC
   Locks the (originAsset, recipient, refundTo, atomic-amount) tuple
   per chain so a future regression in the resolver or amount-conversion
   shows up in CI rather than at the user's first live attempt.
   ─────────────────────────────────────────────────────────────────*/

const HARDHAT_SOL = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const HARDHAT_NEAR =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const HOLLOW_USDC_BASE_META = {
  ticker: "USDC",
  chainKind: "EVM" as const,
  swapKitAsset: null,
  nearIntentsAsset:
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  evmChainId: 8453,
  decimals: 6,
  sourceCapable: true,
  explorerTxUrl: () => "",
  explorerAddressUrl: () => "",
};

describe("buildIntentsRequestSafely — per-source-chain coverage", () => {
  it("EVM (ETH) source — body recipient = BTC, refundTo = EVM", () => {
    const body = buildIntentsRequestSafely({
      fromAsset: "nep141:eth.omft.near",
      toAsset: "nep141:btc.omft.near",
      fromMeta: SWAP_COIN_META.ETH,
      amount: "0.01",
      slippage: 0.02,
      walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
    });
    expect(body.amount).toBe("10000000000000000"); // 0.01 ETH = 1e16 wei
    expect(body.originAsset).toBe("nep141:eth.omft.near");
    expect(body.refundTo).toBe(HARDHAT_EVM);
    expect(body.recipient).toBe(ABANDON_BTC);
  });

  it("UTXO (BTC) source — body recipient = EVM, refundTo = BTC", () => {
    const body = buildIntentsRequestSafely({
      fromAsset: "nep141:btc.omft.near",
      toAsset: "nep141:eth.omft.near",
      fromMeta: SWAP_COIN_META.BTC,
      amount: "0.001",
      slippage: 0.02,
      walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
    });
    expect(body.amount).toBe("100000"); // 0.001 BTC = 100k sat
    expect(body.originAsset).toBe("nep141:btc.omft.near");
    expect(body.refundTo).toBe(ABANDON_BTC);
    expect(body.recipient).toBe(HARDHAT_EVM);
  });

  it("Solana (SOL) source — body refundTo = base58 SOL, recipient = BTC", () => {
    const body = buildIntentsRequestSafely({
      fromAsset: "nep141:sol.omft.near",
      toAsset: "nep141:btc.omft.near",
      fromMeta: SWAP_COIN_META.SOL,
      amount: "0.05",
      slippage: 0.02,
      walletAddresses: {
        evm: HARDHAT_EVM,
        btc: ABANDON_BTC,
        sol: HARDHAT_SOL,
      },
    });
    expect(body.amount).toBe("50000000"); // 0.05 SOL = 5e7 lamports
    expect(body.originAsset).toBe("nep141:sol.omft.near");
    expect(body.refundTo).toBe(HARDHAT_SOL);
    expect(body.recipient).toBe(ABANDON_BTC);
  });

  it("NEAR-native source — body refundTo = NEAR account, recipient = BTC", () => {
    const body = buildIntentsRequestSafely({
      fromAsset: "nep141:wrap.near",
      toAsset: "nep141:btc.omft.near",
      fromMeta: SWAP_COIN_META.NEAR,
      amount: "0.5",
      slippage: 0.02,
      walletAddresses: {
        evm: HARDHAT_EVM,
        btc: ABANDON_BTC,
        near: HARDHAT_NEAR,
      },
    });
    expect(body.amount).toBe("500000000000000000000000"); // 0.5 NEAR = 5e23 yocto
    expect(body.originAsset).toBe("nep141:wrap.near");
    expect(body.refundTo).toBe(HARDHAT_NEAR);
    expect(body.recipient).toBe(ABANDON_BTC);
  });

  it("USDC on Base source — bridged-token route resolves to EVM address", () => {
    const body = buildIntentsRequestSafely({
      fromAsset:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      toAsset: "nep141:btc.omft.near",
      fromMeta: HOLLOW_USDC_BASE_META,
      amount: "5",
      slippage: 0.02,
      walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
    });
    expect(body.amount).toBe("5000000"); // 5 USDC = 5e6 (6 decimals)
    expect(body.originAsset).toBe(
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
    );
    expect(body.refundTo).toBe(HARDHAT_EVM);
    expect(body.recipient).toBe(ABANDON_BTC);
  });

  it("ETH source → USDC.e on Arbitrum destination — recipient is EVM, both bridged-asset shapes accepted", () => {
    const body = buildIntentsRequestSafely({
      fromAsset: "nep141:eth.omft.near",
      toAsset:
        "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
      fromMeta: SWAP_COIN_META.ETH,
      amount: "0.02",
      slippage: 0.02,
      walletAddresses: { evm: HARDHAT_EVM, btc: ABANDON_BTC },
    });
    expect(body.amount).toBe("20000000000000000"); // 0.02 ETH = 2e16 wei
    expect(body.recipient).toBe(HARDHAT_EVM); // arbitrum destination → same EVM address
    expect(body.refundTo).toBe(HARDHAT_EVM);
  });
});

/* ──────────────────────────────────────────────────────────────────
   Per-asset minimum-amount enforcement (added 2026-05-07)

   1Click rejects swaps below the per-asset `minDepositAmount` with a
   structured 4xx. The wallet pre-flights this check so users get an
   inline hint + a disabled Swap button BEFORE a round-trip burns
   proxy quota. Tests cover:
     - input below min throws SafetyInvariantError-equivalent
     - input at or above min passes through
     - asset with no recorded minimum skips the check cleanly
     - getMinDepositAtomicForAsset returns null when cache empty
     - formatAtomicAmount round-trips
   ──────────────────────────────────────────────────────────────── */

const ETH_MIN_DEPOSIT_WEI = "100000000000000"; // 0.0001 ETH

describe("formatAtomicAmount + getMinDepositAtomicForAsset", () => {
  beforeEach(() => {
    _resetCacheForTests();
  });

  it("formats wei back to a clean ETH display string", () => {
    expect(formatAtomicAmount(100_000_000_000_000n, 18)).toBe("0.0001");
    expect(formatAtomicAmount(5_000_000_000_000_000n, 18)).toBe("0.005");
    expect(formatAtomicAmount(1_000_000_000_000_000_000n, 18)).toBe("1");
    expect(formatAtomicAmount(0n, 18)).toBe("0");
  });

  it("formats sat back to a clean BTC display string", () => {
    expect(formatAtomicAmount(100_000n, 8)).toBe("0.001");
    expect(formatAtomicAmount(100_000_000n, 8)).toBe("1");
  });

  it("returns null when the cache is empty", () => {
    expect(getMinDepositAtomicForAsset("nep141:eth.omft.near")).toBeNull();
  });

  it("returns null when the asset is unknown to the cache", () => {
    _setCacheForTests([
      {
        assetId: "nep141:btc.omft.near",
        symbol: "BTC",
        decimals: 8,
        blockchain: "btc",
        minDepositAmount: "1000",
      },
    ]);
    expect(getMinDepositAtomicForAsset("nep141:eth.omft.near")).toBeNull();
  });

  it("returns null when the asset has no minimum recorded", () => {
    _setCacheForTests([
      {
        assetId: "nep141:eth.omft.near",
        symbol: "ETH",
        decimals: 18,
        blockchain: "eth",
        // minDepositAmount intentionally omitted
      },
    ]);
    expect(getMinDepositAtomicForAsset("nep141:eth.omft.near")).toBeNull();
  });

  it("returns the BigInt minimum when the cache has one", () => {
    _setCacheForTests([
      {
        assetId: "nep141:eth.omft.near",
        symbol: "ETH",
        decimals: 18,
        blockchain: "eth",
        minDepositAmount: ETH_MIN_DEPOSIT_WEI,
      },
    ]);
    expect(getMinDepositAtomicForAsset("nep141:eth.omft.near")).toBe(
      BigInt(ETH_MIN_DEPOSIT_WEI)
    );
  });
});

describe("minimumUsdFor — USD equivalent of a displayed minimum", () => {
  beforeEach(() => {
    _resetCacheForTests();
  });

  it("computes source-side USD from the tokens cache's live price (the live POL case)", () => {
    _setCacheForTests([
      {
        assetId: "nep245:v2_1.omni.hot.tg:137_11111111111111111111",
        symbol: "POL",
        decimals: 18,
        blockchain: "pol",
        price: 0.0707,
      },
    ]);
    const usd = minimumUsdFor(
      "nep245:v2_1.omni.hot.tg:137_11111111111111111111",
      "74.818831572074059154",
    );
    expect(usd).toBeDefined();
    expect(Number(usd)).toBeCloseTo(74.818831572074059154 * 0.0707, 6);
  });

  it("returns undefined when the token isn't in the cache yet", () => {
    expect(minimumUsdFor("nep141:eth.omft.near", "0.005")).toBeUndefined();
  });

  it("returns undefined when the cached token has no price", () => {
    _setCacheForTests([
      { assetId: "nep141:eth.omft.near", symbol: "ETH", decimals: 18, blockchain: "eth" },
    ]);
    expect(minimumUsdFor("nep141:eth.omft.near", "0.005")).toBeUndefined();
  });

  it("returns undefined for a zero or unparseable display amount", () => {
    _setCacheForTests([
      {
        assetId: "nep141:eth.omft.near",
        symbol: "ETH",
        decimals: 18,
        blockchain: "eth",
        price: 3480,
      },
    ]);
    expect(minimumUsdFor("nep141:eth.omft.near", "0")).toBeUndefined();
    expect(minimumUsdFor("nep141:eth.omft.near", "not-a-number")).toBeUndefined();
  });
});

/**
 * Desk quote normalization.
 *
 * The pass-through test below is the single highest-value assertion in the
 * desk seam. Desk and 1Click responses are structurally similar and
 * numerically OPPOSITE: 1Click returns ATOMIC units (hence
 * `formatAtomicForDisplay` in normalizeIntents), the desk returns DISPLAY
 * units (like SwapKit). Running desk amounts through the atomic converter
 * would turn "27" ADA into 0.000000000027 ADA — and that would pass every
 * existing guard, because `assertDisplayedAmountReasonable` only rejects
 * values that are too LARGE. Nothing else in the codebase would catch it.
 */
describe("normalizeDesk — display-units pass-through", () => {
  const ADA_META = { ticker: "ADA", decimals: 6 } as never;
  // Deliberately a 12-decimal meta: if anyone ever reintroduces an atomic
  // conversion, a big `decimals` makes the corruption unmissable.
  const XMR_META = { ticker: "XMR", decimals: 12 } as never;

  function deskQuote(over: Record<string, unknown> = {}) {
    return {
      quoteId: "q_test",
      pair: "XMR/ADA",
      direction: "SELL_FOLLOWER",
      deskRole: "LEADER",
      coinIn: "XMR",
      coinOut: "ADA",
      amountIn: "0.1",
      amountOut: "27",
      rate: "270",
      mid: "300",
      markup: 0.1,
      sTotal: 0.1,
      expiresAt: 1783792092,
      minConfsIn: 10,
      minConfsOut: 3,
      t0Seconds: 1200,
      t1Seconds: 2400,
      t2Seconds: 3600,
      ...over,
    } as never;
  }

  it("passes the amount through VERBATIM — never atomic-converts", () => {
    const q = normalizeDesk(deskQuote(), ADA_META)!;
    expect(q.expectedReceive).toBe("27");
    // The corrupted value an atomic conversion would produce, pinned
    // explicitly so the failure message names the bug.
    expect(q.expectedReceive).not.toBe("0.000027");
  });

  it("does not convert even against a 12-decimal destination meta", () => {
    const q = normalizeDesk(deskQuote({ amountOut: "0.009", coinOut: "XMR" }), XMR_META)!;
    expect(q.expectedReceive).toBe("0.009");
    expect(q.expectedReceive).not.toBe("0.000000000000000009");
  });

  it("sets minReceived === expectedReceive (an atomic swap has no slippage band)", () => {
    const q = normalizeDesk(deskQuote(), ADA_META)!;
    expect(q.minReceived).toBe(q.expectedReceive);
  });

  it("keeps totalFeesSource at '0' — never the sTotal FRACTION", () => {
    const q = normalizeDesk(deskQuote({ sTotal: 0.1, markup: 0.1 }), ADA_META)!;
    // 0.1 here would render as "0.1 XMR of fees" on a 0.1 XMR swap.
    expect(q.totalFeesSource).toBe("0");
    expect(q.affiliateFeeSource).toBe("0");
  });

  it("carries source, expiresAt, and the raw quote", () => {
    const q = normalizeDesk(deskQuote(), ADA_META)!;
    expect(q.source).toBe("pwnda-desk");
    expect(q.expiresAt).toBe(1783792092);
    expect(q.deskQuote).toBeTruthy();
    expect(q.providerName).toBe("desk-leader");
    expect(q.mockDetected).toBe(false);
  });

  it("returns null for a zero, negative, or unparseable amountOut", () => {
    expect(normalizeDesk(deskQuote({ amountOut: "0" }), ADA_META)).toBeNull();
    expect(normalizeDesk(deskQuote({ amountOut: "-1" }), ADA_META)).toBeNull();
    expect(normalizeDesk(deskQuote({ amountOut: "abc" }), ADA_META)).toBeNull();
    expect(normalizeDesk(deskQuote({ amountOut: "" }), ADA_META)).toBeNull();
  });
});

describe("pickAutoBest — 3-way with aggregator precedence", () => {
  function q(source: string, receive: string): NormalizedQuote {
    return {
      source,
      routerLabel: source,
      providerName: source,
      mockDetected: false,
      expectedReceive: receive,
      minReceived: receive,
      totalFeesSource: "0",
      affiliateFeeSource: "0",
      etaSeconds: 60,
      etaPretty: "~1m",
      warnings: [],
    } as NormalizedQuote;
  }

  it("still picks the higher aggregator, SwapKit winning exact ties", () => {
    expect(pickAutoBest(q("swapkit", "10"), q("intents", "9"))?.source).toBe("swapkit");
    expect(pickAutoBest(q("swapkit", "9"), q("intents", "10"))?.source).toBe("intents");
    expect(pickAutoBest(q("swapkit", "10"), q("intents", "10"))?.source).toBe("swapkit");
  });

  it("returns the desk ONLY when no aggregator answered", () => {
    expect(pickAutoBest(null, null, q("pwnda-desk", "5"))?.source).toBe("pwnda-desk");
  });

  it("prefers an aggregator over the desk even when the desk pays more", () => {
    // A desk swap is a 10-60 min locked protocol; a rate tiebreak must not
    // silently move the user onto it.
    expect(pickAutoBest(q("swapkit", "1"), null, q("pwnda-desk", "999"))?.source).toBe("swapkit");
    expect(pickAutoBest(null, q("intents", "1"), q("pwnda-desk", "999"))?.source).toBe("intents");
  });

  it("is unchanged when called with the original two arguments", () => {
    expect(pickAutoBest(null, null)).toBeNull();
    expect(pickAutoBest(q("swapkit", "1"), null)?.source).toBe("swapkit");
    expect(pickAutoBest(null, q("intents", "1"))?.source).toBe("intents");
  });

  it("returns null when nothing answered", () => {
    expect(pickAutoBest(null, null, null)).toBeNull();
  });
});

describe("isDeskQuoteStale", () => {
  const withExpiry = (expiresAt?: number) =>
    ({ expiresAt, source: "pwnda-desk" } as NormalizedQuote);

  it("is never stale without an expiresAt (the aggregators publish none)", () => {
    expect(isDeskQuoteStale(withExpiry(undefined), 9_999_999)).toBe(false);
    expect(isDeskQuoteStale(null, 9_999_999)).toBe(false);
    expect(isDeskQuoteStale(undefined, 9_999_999)).toBe(false);
  });

  it("is stale once inside the skew margin", () => {
    expect(isDeskQuoteStale(withExpiry(1000), 995, 5)).toBe(true);
    expect(isDeskQuoteStale(withExpiry(1000), 1000, 5)).toBe(true);
    expect(isDeskQuoteStale(withExpiry(1000), 1200, 5)).toBe(true);
  });

  it("is fresh comfortably before the deadline", () => {
    expect(isDeskQuoteStale(withExpiry(1000), 900, 5)).toBe(false);
    expect(isDeskQuoteStale(withExpiry(1000), 994, 5)).toBe(false);
  });
});
