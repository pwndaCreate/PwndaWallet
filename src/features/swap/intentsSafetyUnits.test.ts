/**
 * Unit locks for the 2026-09-29 send-safety audit fixes to the NEAR Intents
 * swap path. The end-to-end executor behaviour is pinned in
 * `intentsExecutorRegistry.test.ts`; this file pins the pure pieces each fix
 * rests on, so a regression names the rule it broke.
 */
import { describe, expect, it, vi } from "vitest";

import { ASSET_CAPABILITIES, sourceSecretFor } from "./asset-capabilities";
import { STABLECOIN_NETWORKS } from "../../wallets/stablecoins";
import { EVM_CHAIN_IDS } from "./near-intents-assets.generated";
import { lookupByAssetId } from "./intents-dedup";
import {
  SafetyInvariantError,
  assertEvmDepositShape,
  assertSourceMetaMatchesCatalog,
  decodeEvmSignedTx,
} from "./safety-invariants";
import {
  IntentsQuoteAlreadyUsedError,
  __resetIntentsAttemptsForTests,
  claimIntentsDeposit,
  intentsDepositAttempt,
  isIntentsDepositUsed,
  recordIntentsDeposit,
} from "./intents-attempts";
import {
  IntentsQuoteExpiredError,
  assertDepositWindowOpen,
  depositWindowFor,
  depositWindowMinutesLeft,
  echoMismatches,
  quoteBindingMismatches,
  sameAddress,
} from "./intents-quote-binding";
import {
  evmBroadcastRefusedEverywhere,
  isDefinitiveBroadcastRefusal,
} from "./broadcast-outcome";
import {
  buildIntentsRequestSafely,
  normalizeIntents,
  selectHandedOutQuote,
  swapQuoteInputsKey,
  type NormalizedQuote,
} from "./useSwapQuote";
import { SWAP_COIN_META } from "./swap-data";
import {
  evmReserveFromGasPrice,
  formatPresetAmount,
  nativeMaxReserve,
} from "./feeReserve";
import {
  checkXrpPayout,
  modalIsBusy,
  safetyFooterCopy,
  xrpSignGate,
} from "./SwapConfirmModal";
import { resumePendingIntentsSwaps, rowsToResume } from "./intents-status-resume";
import type { SwapHistoryEntry } from "./swap-history-store";

// ─────────────────────────────────────────────────────────────────────────
// F1
// ─────────────────────────────────────────────────────────────────────────

describe("F1: stablecoin legs carry their contract, checked against the catalog (2026-09-29 send-safety audit)", () => {
  const legs = Object.entries(ASSET_CAPABILITIES).filter(([, c]) =>
    STABLECOIN_NETWORKS.some((n) => n.chain === c.walletsByChainKey),
  );

  it("covers every stablecoin leg the registry routes", () => {
    expect(legs.length).toBeGreaterThanOrEqual(18);
  });

  for (const [key, cap] of legs) {
    it(`${key}: contract, decimals and chain agree across registry, wallet list and 1Click catalog`, () => {
      const wallet = STABLECOIN_NETWORKS.find((n) => n.chain === cap.walletsByChainKey)!;
      // Before the fix: undefined for every leg — read as "native coin".
      expect(cap.tokenContract).toBe(wallet.contract);
      const catalog = lookupByAssetId(cap.nearIntentsAsset!);
      expect(catalog, `${key}: asset id not in the shipped catalog`).not.toBeNull();
      expect(catalog!.contractAddress?.toLowerCase()).toBe(wallet.contract.toLowerCase());
      expect(cap.decimals).toBe(wallet.decimals);
      expect(catalog!.decimals).toBe(cap.decimals);
      if (cap.chainKind === "EVM") expect(EVM_CHAIN_IDS[catalog!.blockchain]).toBe(cap.chainId);
      // And the legacy meta the executor reads carries it through.
      expect(SWAP_COIN_META[key].tokenContract).toBe(wallet.contract);
    });
  }

  it("no non-stablecoin entry gained a contract", () => {
    for (const [key, cap] of Object.entries(ASSET_CAPABILITIES)) {
      if (legs.some(([k]) => k === key)) continue;
      expect(cap.tokenContract, key).toBeUndefined();
    }
  });

  const USDT_BSC = lookupByAssetId(ASSET_CAPABILITIES["USDT-BSC"].nearIntentsAsset!)!;
  const ETH = lookupByAssetId("nep141:eth.omft.near")!;

  it("fails closed: a token with no contract in the wallet (the F1 state)", () => {
    expect(() =>
      assertSourceMetaMatchesCatalog({
        ticker: "USDT",
        nearIntentsAsset: USDT_BSC.assetId,
        decimals: 18,
        tokenContract: undefined,
        catalogAsset: USDT_BSC,
      }),
    ).toThrow(/NATIVE coin/);
  });

  it("fails closed: a different contract, a contract on a native coin, wrong decimals, an unknown asset", () => {
    const cases: Array<() => unknown> = [
      () =>
        assertSourceMetaMatchesCatalog({
          ticker: "USDT", nearIntentsAsset: USDT_BSC.assetId, decimals: 18,
          tokenContract: "0x" + "12".repeat(20), catalogAsset: USDT_BSC,
        }),
      () =>
        assertSourceMetaMatchesCatalog({
          ticker: "ETH", nearIntentsAsset: ETH.assetId, decimals: 18,
          tokenContract: USDT_BSC.contractAddress, catalogAsset: ETH,
        }),
      () =>
        assertSourceMetaMatchesCatalog({
          ticker: "USDT", nearIntentsAsset: USDT_BSC.assetId, decimals: 6,
          tokenContract: USDT_BSC.contractAddress, catalogAsset: USDT_BSC,
        }),
      () =>
        assertSourceMetaMatchesCatalog({
          ticker: "X", nearIntentsAsset: "nep141:nope.near", decimals: 18, catalogAsset: null,
        }),
    ];
    for (const c of cases) {
      let err: unknown = null;
      try {
        c();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SafetyInvariantError);
    }
  });

  it("returns the catalog's contract (or null) when everything agrees", () => {
    expect(
      assertSourceMetaMatchesCatalog({
        ticker: "USDT", nearIntentsAsset: USDT_BSC.assetId, decimals: 18,
        tokenContract: "0x55d398326f99059fF775485246999027B3197955", catalogAsset: USDT_BSC,
      }).contract,
    ).toBe(USDT_BSC.contractAddress);
    expect(
      assertSourceMetaMatchesCatalog({
        ticker: "ETH", nearIntentsAsset: ETH.assetId, decimals: 18, catalogAsset: ETH,
      }).contract,
    ).toBeNull();
  });

  const DEP = "0x1111111111111111111111111111111111111111";
  const TOKEN = "0x55d398326f99059ff775485246999027b3197955";
  const transferData = (to: string, amt: bigint) =>
    "0xa9059cbb" + to.slice(2).padStart(64, "0") + amt.toString(16).padStart(64, "0");

  it("assertEvmDepositShape rejects the F1 transaction — native value where a token transfer is due", () => {
    expect(() =>
      assertEvmDepositShape({
        to: DEP, value: 10n ** 20n, data: "0x", depositAddress: DEP,
        amountAtomic: 10n ** 20n, contract: TOKEN, ticker: "USDT", stage: "post-build",
      }),
    ).toThrow(SafetyInvariantError);
  });

  it("assertEvmDepositShape accepts exactly transfer(deposit, amount) on the contract, and nothing else", () => {
    const ok = {
      to: TOKEN, value: 0n, data: transferData(DEP, 5n), depositAddress: DEP,
      amountAtomic: 5n, contract: TOKEN, ticker: "USDT", stage: "post-sign" as const,
    };
    expect(() => assertEvmDepositShape(ok)).not.toThrow();
    for (const bad of [
      { ...ok, value: 1n },
      { ...ok, data: transferData("0x" + "22".repeat(20), 5n) },
      { ...ok, data: transferData(DEP, 6n) },
      { ...ok, to: "0x" + "33".repeat(20) },
    ]) {
      expect(() => assertEvmDepositShape(bad)).toThrow(SafetyInvariantError);
    }
    // Native: calldata on a native transfer is refused too.
    expect(() =>
      assertEvmDepositShape({
        to: DEP, value: 5n, data: "0xdeadbeef", depositAddress: DEP,
        amountAtomic: 5n, contract: null, ticker: "ETH", stage: "post-build",
      }),
    ).toThrow(SafetyInvariantError);
  });

  it("decodeEvmSignedTx now returns the calldata the post-sign check reads", async () => {
    const { Wallet, Transaction } = await import("ethers");
    const data = transferData(DEP, 7n);
    const raw = await new Wallet("0x" + "11".repeat(32)).signTransaction(
      Transaction.from({ type: 0, chainId: 56, nonce: 1, gasPrice: 1n, gasLimit: 60000n, to: TOKEN, value: 0n, data }),
    );
    const decoded = decodeEvmSignedTx(raw);
    expect(decoded.to.toLowerCase()).toBe(TOKEN);
    expect(decoded.value).toBe(0n);
    expect(decoded.data).toBe(data);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F2
// ─────────────────────────────────────────────────────────────────────────

describe("F2: one quote, one deposit attempt (2026-09-29 send-safety audit)", () => {
  it("a deposit address can be claimed once", () => {
    __resetIntentsAttemptsForTests();
    claimIntentsDeposit("0xAbCdEf0000000000000000000000000000000001");
    // Checksum casing is display only.
    expect(() => claimIntentsDeposit("0xabcdef0000000000000000000000000000000001")).toThrow(
      IntentsQuoteAlreadyUsedError,
    );
    expect(isIntentsDepositUsed("0xABCDEF0000000000000000000000000000000001")).toBe(true);
  });

  it("a retired quote cannot be claimed, and retiring never hides a known hash", () => {
    __resetIntentsAttemptsForTests();
    recordIntentsDeposit("dep-1", { state: "retired" });
    expect(() => claimIntentsDeposit("dep-1")).toThrow(IntentsQuoteAlreadyUsedError);
    recordIntentsDeposit("dep-2", { state: "broadcast", txHash: "h2" });
    recordIntentsDeposit("dep-2", { state: "retired" });
    expect(intentsDepositAttempt("dep-2")).toMatchObject({ state: "broadcast", txHash: "h2" });
    // Base58 is case-sensitive: a different case is a different address.
    expect(isIntentsDepositUsed("DEP-1")).toBe(false);
  });

  it("classifies post-sign broadcast failures: refusal only when the node said so", () => {
    expect(isDefinitiveBroadcastRefusal('RPC error: {"message":"insufficient funds"}')).toBe(true);
    expect(isDefinitiveBroadcastRefusal("RPC returned 400: sendrawtransaction RPC error: min relay fee not met")).toBe(true);
    // May already be on the network.
    expect(isDefinitiveBroadcastRefusal('RPC error: {"message":"already known"}')).toBe(false);
    expect(isDefinitiveBroadcastRefusal("RPC returned 400: txn-already-in-mempool")).toBe(false);
    expect(isDefinitiveBroadcastRefusal('RPC error: {"message":"nonce too low"}')).toBe(false);
    // Transport: the request may have been delivered.
    expect(isDefinitiveBroadcastRefusal("network error: operation timed out")).toBe(false);
    expect(isDefinitiveBroadcastRefusal("RPC returned 502: Bad Gateway")).toBe(false);
    expect(isDefinitiveBroadcastRefusal("")).toBe(false);
  });

  it("an EVM trail with any verify-stage line is never 'refused everywhere'", () => {
    expect(
      evmBroadcastRefusedEverywhere(
        "RPC returned 0: All 2 EVM RPCs failed\n" +
          "  https://a (broadcast): RPC returned 429: Too Many Requests\n" +
          "  https://b (verify): broadcast accepted hash 0x1 but eth_getTransactionByHash returned null on the same node",
      ),
    ).toBe(false);
    expect(
      evmBroadcastRefusedEverywhere(
        "RPC returned 0: All 1 EVM RPCs failed\n  https://a (broadcast): RPC returned 429: Too Many Requests",
      ),
    ).toBe(true);
    expect(evmBroadcastRefusedEverywhere("something with no trail")).toBe(false);
  });

  it("the modal cannot close while a deposit is being built, signed or broadcast", () => {
    for (const p of ["building", "signing", "broadcasting"] as const) {
      expect(modalIsBusy("executing", p)).toBe(true);
    }
    expect(modalIsBusy("executing", "pending")).toBe(false);
    expect(modalIsBusy("review", "idle")).toBe(false);
    expect(modalIsBusy("unknown", "idle")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F3
// ─────────────────────────────────────────────────────────────────────────

const quote = (dep?: string): NormalizedQuote =>
  ({
    source: "intents",
    routerLabel: "NEAR Intents",
    providerName: "solver-relay",
    mockDetected: false,
    intentsQuote: dep ? { depositAddress: dep, amountIn: "1" } : undefined,
    expectedReceive: "1",
    minReceived: "1",
    totalFeesSource: "0",
    affiliateFeeSource: "0",
    etaSeconds: 1,
    etaPretty: "~1s",
    warnings: [],
  }) as NormalizedQuote;

describe("F3: a quote is handed out only for the inputs it was made for (2026-09-29 send-safety audit)", () => {
  const base = {
    from: "ETH", to: "BTC", amount: "0.5", slippage: 0.02, preferredRouter: "intents",
    fromBlockchain: "eth", toBlockchain: "btc", sourceAddress: "0xa", destinationAddress: "bc1q",
  };

  it("the inputs key changes with every input the request depends on", () => {
    const k = swapQuoteInputsKey(base);
    for (const change of [
      { from: "BNB" }, { to: "SOL" }, { amount: "0.6" }, { slippage: 0.01 },
      { preferredRouter: "auto" }, { fromBlockchain: "arb" }, { toBlockchain: "sol" },
      { sourceAddress: "0xb" }, { destinationAddress: "bc1x" },
    ]) {
      expect(swapQuoteInputsKey({ ...base, ...change }), JSON.stringify(change)).not.toBe(k);
    }
    // Case of the ticker and padding of the amount are not changes.
    expect(swapQuoteInputsKey({ ...base, from: "eth", amount: " 0.5 " })).toBe(k);
  });

  it("the audit's race: ETH quote in state, form now says BNB — nothing is handed out", () => {
    const ethKey = swapQuoteInputsKey(base);
    const bnbKey = swapQuoteInputsKey({ ...base, from: "BNB", fromBlockchain: "bnb" });
    const q = quote("0xdep");
    // Before: the hook returned `quote` from state unconditionally, so the
    // Swap button stayed live on the ETH quote for the whole debounce.
    expect(selectHandedOutQuote({ quote: q, quoteKey: ethKey, currentKey: bnbKey, isUsed: () => false })).toBeNull();
    expect(selectHandedOutQuote({ quote: q, quoteKey: ethKey, currentKey: ethKey, isUsed: () => false })).toBe(q);
  });

  it("a quote whose deposit address was used is not handed out again (F2)", () => {
    const k = swapQuoteInputsKey(base);
    expect(
      selectHandedOutQuote({ quote: quote("0xused"), quoteKey: k, currentKey: k, isUsed: (d) => d === "0xused" }),
    ).toBeNull();
  });

  it("normalizeIntents keeps the request the quote answers, and 1Click's echo of it", () => {
    const sent = {
      originAsset: "nep141:eth.omft.near", destinationAsset: "nep141:btc.omft.near",
      amount: "5000000000000000", recipient: "bc1q", refundTo: "0xa", deadline: "2030-01-01T00:00:00Z",
    };
    const n = normalizeIntents(
      { quote: { amountOut: "100000", depositAddress: "0xdep", amountIn: sent.amount }, quoteRequest: { ...sent } } as any,
      0.02,
      SWAP_COIN_META.BTC,
      sent,
    )!;
    // Before: only resp.quote survived; nothing could tell which request it answered.
    expect(n.intentsRequest).toEqual(sent);
    expect(n.intentsEcho).toMatchObject({ originAsset: sent.originAsset, amount: sent.amount });
  });

  it("binding compares assets, the exact amount and addresses (EVM case-insensitively)", () => {
    const sent = {
      originAsset: "A", destinationAsset: "B", amount: "100",
      recipient: "0xAbC0000000000000000000000000000000000001", refundTo: "bitcoincash:qqabc",
    };
    const expected = {
      originAsset: "A", destinationAsset: "B", amountAtomic: 100n,
      recipient: "0xabc0000000000000000000000000000000000001", refundTo: "qqabc",
    };
    expect(quoteBindingMismatches(sent, expected)).toEqual([]);
    expect(quoteBindingMismatches({ ...sent, amount: "101" }, expected)).toHaveLength(1);
    expect(sameAddress("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk", "hagk14jpmqlgt6rvgv7cbqfjwfto5dqxi472ut3dkpqk")).toBe(false);
    expect(echoMismatches(sent, { recipient: "0xdead" })).toHaveLength(1);
    expect(echoMismatches(sent, null)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F4
// ─────────────────────────────────────────────────────────────────────────

describe("F4: the deposit window is sized per origin chain and checked before signing (2026-09-29 send-safety audit)", () => {
  const wallet = {
    evm: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    btc: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    ltc: "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh",
    cardano:
      "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv",
  };
  const minutesAhead = (iso: string) => (Date.parse(iso) - Date.now()) / 60_000;

  it("requests a deadline long enough for the origin chain (it was 10 minutes for every chain)", () => {
    const cases: Array<[string, string, string, number]> = [
      ["BTC", "nep141:btc.omft.near", "nep141:eth.omft.near", 120],
      ["LTC", "nep141:ltc.omft.near", "nep141:eth.omft.near", 60],
      ["ADA", "nep141:cardano.omft.near", "nep141:eth.omft.near", 45],
      ["ETH", "nep141:eth.omft.near", "nep141:btc.omft.near", 30],
    ];
    for (const [ticker, fromAsset, toAsset, minutes] of cases) {
      const body = buildIntentsRequestSafely({
        fromAsset, toAsset, fromMeta: SWAP_COIN_META[ticker], amount: "1", slippage: 0.02,
        walletAddresses: wallet,
      });
      const ahead = minutesAhead(body.deadline);
      expect(ahead, ticker).toBeGreaterThan(minutes - 1);
      expect(ahead, ticker).toBeLessThan(minutes + 1);
    }
  });

  it("a BTC deposit needs an hour of window left; an account chain ten minutes", () => {
    const now = Date.now();
    const at = (m: number) => new Date(now + m * 60_000).toISOString();
    expect(depositWindowFor("BTC").landingMinutes).toBe(60);
    expect(depositWindowMinutesLeft({ deadline: at(90), chainKind: "BTC", nowMs: now })).toBeCloseTo(30, 5);
    expect(() => assertDepositWindowOpen({ deadline: at(50), chainKind: "BTC", nowMs: now, ticker: "BTC" })).toThrow(
      IntentsQuoteExpiredError,
    );
    expect(() => assertDepositWindowOpen({ deadline: at(50), chainKind: "EVM", nowMs: now, ticker: "ETH" })).not.toThrow();
  });

  it("fails closed on a missing or unreadable deadline", () => {
    expect(() => assertDepositWindowOpen({ deadline: undefined, chainKind: "EVM", nowMs: Date.now(), ticker: "ETH" })).toThrow(
      IntentsQuoteExpiredError,
    );
    expect(() => assertDepositWindowOpen({ deadline: "soon", chainKind: "EVM", nowMs: Date.now(), ticker: "ETH" })).toThrow(
      IntentsQuoteExpiredError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F5
// ─────────────────────────────────────────────────────────────────────────

const row = (over: Partial<SwapHistoryEntry>): SwapHistoryEntry => ({
  id: "r1",
  fromAsset: "BTC",
  toAsset: "ETH",
  fromAmount: "0.01",
  toAmount: "0.3",
  status: "pending",
  sourceTxHash: "h",
  sourceExplorerUrl: "",
  createdAt: new Date().toISOString(),
  ...over,
});

describe("F5: pending Intents swaps are followed after the modal is gone (2026-09-29 send-safety audit)", () => {
  it("resumes pending rows that carry a deposit address, and nothing else", () => {
    const now = Date.now();
    const rows = [
      row({ id: "a", depositAddress: "dA" }),
      row({ id: "b" }), // no deposit address (SwapKit / pre-fix row)
      row({ id: "c", depositAddress: "dC", status: "success" }),
      row({ id: "d", depositAddress: "dD" }), // already polled this session
      row({ id: "e", depositAddress: "dE", createdAt: new Date(now - 30 * 86_400_000).toISOString() }),
    ];
    expect(rowsToResume(rows, now, (d) => d === "dD").map((r) => r.id)).toEqual(["a"]);
  });

  it("records the terminal status, and leaves a row pending when polling gives up", async () => {
    const updates: Array<[string, Partial<SwapHistoryEntry>]> = [];
    const n = await resumePendingIntentsSwaps({
      load: async () => [
        row({ id: "ok", depositAddress: "d1", outcomeUnknown: true }),
        row({ id: "slow", depositAddress: "d2" }),
      ],
      update: async (id, patch) => {
        updates.push([id, patch]);
      },
      poll: async ({ depositAddress }) => {
        if (depositAddress === "d2") throw new Error("Intents status polling timed out");
        return { status: "REFUNDED" } as any;
      },
      isActive: () => false,
      now: () => Date.now(),
    });
    expect(n).toBe(2);
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toBe("ok");
    expect(updates[0][1]).toMatchObject({ status: "refunded", outcomeUnknown: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F8
// ─────────────────────────────────────────────────────────────────────────

describe("F8: MAX on a native coin leaves the deposit's fee behind (2026-09-29 send-safety audit)", () => {
  it("reserves for native coins, not for token legs", () => {
    for (const t of ["ETH", "BNB", "SOL", "BTC", "LTC", "DOGE", "ADA", "XRP", "TRX", "NEAR"]) {
      expect(nativeMaxReserve(SWAP_COIN_META[t]), t).toBeGreaterThan(0);
    }
    for (const t of ["USDC-ETH", "USDT-BSC", "USDC-SOL", "USDT-TRON"]) {
      expect(nativeMaxReserve(SWAP_COIN_META[t]), t).toBe(0);
    }
  });

  it("the live EVM reserve covers the executor's gas at twice the price", () => {
    // 1 gwei: 21 000 gas × 1.25 margin × 2 headroom = 52 500 gwei.
    expect(evmReserveFromGasPrice(10n ** 9n, 18)).toBeCloseTo(0.0000525, 12);
  });

  it("rounds a preset DOWN — the old toFixed(8) could ask for more than the balance", () => {
    const balance = 100.12345678912346; // an 18-decimal USDC-BSC balance, as a number
    const old = (balance * 1).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    expect(Number(old)).toBeGreaterThan(balance); // "100.12345679"
    const now = formatPresetAmount(balance, 18);
    expect(now).toBe("100.12345678");
    expect(Number(now)).toBeLessThanOrEqual(balance);
    expect(formatPresetAmount(2.5, 6)).toBe("2.5");
    expect(formatPresetAmount(0, 8)).toBe("0");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F9
// ─────────────────────────────────────────────────────────────────────────

describe("F9: truthful safety copy, and an XRP guard that holds Sign while it asks (2026-09-29 send-safety audit)", () => {
  it("never says 'No funds have moved' for a check that runs after the broadcast", () => {
    const post = safetyFooterCopy("VERIFIED_HASH_MISMATCH");
    const text = [post.headline, post.lead, post.strong, post.tail].join(" ");
    expect(text).not.toMatch(/No funds have moved/);
    expect(text).toMatch(/may have been sent/);
    expect(post.headline).toMatch(/after broadcasting/);
  });

  it("does not call an unfundable amount a wallet bug", () => {
    const c = safetyFooterCopy("TX_NOT_FUNDABLE");
    const text = [c.headline, c.lead, c.strong, c.tail].join(" ");
    expect(text).not.toMatch(/report/);
    expect(text).toMatch(/Nothing was sent/);
    expect(safetyFooterCopy("DEPOSIT_TX_SHAPE_DRIFT").strong).toBe("No funds have moved.");
  });

  it("Sign is disabled while the ledger lookup is pending or refused; allowed with a warning when unknown", () => {
    expect(xrpSignGate({ state: "pending" }).blockedReason).toMatch(/Checking/);
    expect(xrpSignGate({ state: "blocked", reason: "no" }).blockedReason).toBe("no");
    const unknown = xrpSignGate({ state: "unknown", warning: "w" });
    expect(unknown.blockedReason).toBeNull();
    expect(unknown.warning).toBe("w");
    expect(xrpSignGate({ state: "ok" }).blockedReason).toBeNull();
  });

  it("a lookup that never answers becomes 'unknown' after the timeout, not a silent pass", async () => {
    vi.useFakeTimers();
    try {
      const p = checkXrpPayout({
        destination: "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3",
        minReceived: "0.5",
        lookup: () => new Promise(() => undefined),
        timeoutMs: 8_000,
      });
      await vi.advanceTimersByTimeAsync(8_001);
      expect((await p).state).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks a payout under the reserve to an account that does not exist", async () => {
    const r = await checkXrpPayout({
      destination: "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3",
      minReceived: "0.5",
      lookup: async () => ({ activated: false, reserveBaseXrp: 1 }),
      timeoutMs: 1_000,
    });
    expect(r.state).toBe("blocked");
    const ok = await checkXrpPayout({
      destination: "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3",
      minReceived: "0.5",
      lookup: async () => ({ activated: true, reserveBaseXrp: 1 }),
      timeoutMs: 1_000,
    });
    expect(ok.state).toBe("ok");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F10
// ─────────────────────────────────────────────────────────────────────────

describe("F10: UTXO sources hand the executor the mnemonic for an account-wide send (2026-09-29 live incident)", () => {
  it("sourceSecretFor returns each UTXO chain's mnemonic", () => {
    const wallets = {
      bitcoin: { mnemonic: "m-btc", privateKey: "k" },
      litecoin: { mnemonic: "m-ltc", privateKey: "k" },
      dogecoin: { mnemonic: "m-doge", privateKey: "k" },
      "bitcoin-cash": { mnemonic: "m-bch", privateKey: "k" },
      dash: { mnemonic: "m-dash", privateKey: "k" },
    };
    // Before: undefined for all five — the executor had no way to reach the
    // adapter's account-wide send.
    expect(sourceSecretFor("LTC", wallets)).toEqual({ kind: "mnemonic", value: "m-ltc" });
    expect(sourceSecretFor("BTC", wallets)).toEqual({ kind: "mnemonic", value: "m-btc" });
    expect(sourceSecretFor("DOGE", wallets)).toEqual({ kind: "mnemonic", value: "m-doge" });
    expect(sourceSecretFor("BCH", wallets)).toEqual({ kind: "mnemonic", value: "m-bch" });
    expect(sourceSecretFor("DASH", wallets)).toEqual({ kind: "mnemonic", value: "m-dash" });
    // A Rust-signed EVM source still gets nothing.
    expect(sourceSecretFor("ETH", { ethereum: { mnemonic: "m", privateKey: "k" } })).toBeUndefined();
  });
});
