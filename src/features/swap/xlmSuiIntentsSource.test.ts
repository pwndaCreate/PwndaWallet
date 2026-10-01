/**
 * XLM and SUI as NEAR Intents swap SOURCES (F7 follow-up, 2026-09-29
 * send-safety audit; fixed 2026-09-30).
 *
 * F7 took both off the source roster because the executor had no branch for
 * either and threw after the password. This file pins what brings them back:
 *
 *  - SUI deposits through the dashboard Send's `executeSuiTransfer`, with
 *    `amountIn` (MIST) converted to decimal SUI exactly;
 *  - XLM deposits through `executeStellarTransfer` with the quote's
 *    `depositMemo` attached as MEMO_TEXT. The Stellar deposit address is
 *    SHARED by every Stellar depositor; the memo is the deposit's identity.
 *    So the quote is requested with `depositMode: "MEMO"` (Stellar only), the
 *    memo travels with the notify and every status query, and the
 *    one-attempt guard is keyed by address AND memo;
 *  - a wallet proxy that refuses or drops `depositMode` produces a sentence
 *    that names the proxy.
 *
 * Like `intentsExecutorRegistry.test.ts`, the executor runs against the REAL
 * asset registry (`./swap-data` is not mocked); only I/O edges are stubbed.
 * The Stellar payment is built by the real `executeStellarTransfer` and the
 * real stellar-base against a fake Horizon, and signed by a fake Rust signer
 * with the world-public abandon seed's key. Nothing reaches a network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Networks, TransactionBuilder } from "@stellar/stellar-base";

const S = vi.hoisted(() => ({
  notify: [] as any[],
  statusCalls: [] as any[][],
  statusQueue: [] as any[],
  stellar: [] as any[],
  sui: [] as any[],
  stellarImpl: null as null | ((a: any) => Promise<any>),
  suiImpl: null as null | ((a: any) => Promise<any>),
  suiLog: [] as unknown[][],
  horizon: {
    accounts: {} as Record<string, unknown>,
    posted: [] as string[],
  },
  signer: { stellar: "", sui: "" },
}));

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));

vi.mock("../../wallets", () => ({
  getAdapter: vi.fn(() => null),
  getAdapterByChain: vi.fn(() => null),
  ALL_CHAINS: [],
}));

vi.mock("../../api/proxy", () => ({
  buildSwapKitTx: vi.fn(),
  trackSwapKitSwap: vi.fn(),
  getIntentsQuote: vi.fn(),
  getIntentsStatus: vi.fn(async (...args: any[]) => {
    S.statusCalls.push(args);
    return S.statusQueue.shift() ?? { status: "PENDING_DEPOSIT" };
  }),
  notifyIntentsDeposit: vi.fn(async (req: unknown) => {
    S.notify.push(req);
    return {};
  }),
}));

vi.mock("../../api/swap-rust", () => ({
  signEvm: vi.fn(async () => {
    throw new Error("signEvm must not be called in these tests");
  }),
  signPsbt: vi.fn(async () => {
    throw new Error("signPsbt must not be called in these tests");
  }),
  broadcastTx: vi.fn(),
  broadcastEvmVerified: vi.fn(),
  getNearAddress: vi.fn(),
  getSolanaAddress: vi.fn(),
  getUtxoAddress: vi.fn(),
  lockSwap: vi.fn(),
  unlockSwap: vi.fn(),
}));

// The deposit functions, spied on: by default the REAL implementation runs;
// a test sets `S.stellarImpl` / `S.suiImpl` to stand in for the network.
vi.mock("./session-send", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    executeStellarTransfer: vi.fn(async (a: any) => {
      S.stellar.push(a);
      return S.stellarImpl ? S.stellarImpl(a) : orig.executeStellarTransfer(a);
    }),
    executeSuiTransfer: vi.fn(async (a: any) => {
      S.sui.push(a);
      return S.suiImpl ? S.suiImpl(a) : orig.executeSuiTransfer(a);
    }),
  };
});

// Sui's transaction builder, faked: it records what it was asked to split, to
// whom it transfers, and the gas it was given. Since 2026-10-01 the chain
// reads and the submit are GraphQL through the proxy (`suiGraphql` below),
// not the SDK's JSON-RPC client, which is why that client is no longer faked
// here; `suiSend.test.ts` covers the send with the real builder.
vi.mock("@mysten/sui/transactions", async (importOriginal) => {
  const actual: any = await importOriginal();
  class FakeTransaction {
    gas = { $kind: "GasCoin" };
    setSender(s: string) {
      S.suiLog.push(["setSender", s]);
    }
    splitCoins(_c: unknown, amounts: unknown[]) {
      S.suiLog.push(["splitCoins", ...amounts]);
      return [{ $kind: "Result" }];
    }
    transferObjects(_o: unknown, to: string) {
      S.suiLog.push(["transferObjects", to]);
    }
    setGasPrice(p: bigint) {
      S.suiLog.push(["setGasPrice", p]);
    }
    setGasBudget(b: bigint) {
      S.suiLog.push(["setGasBudget", b]);
    }
    setGasPayment(p: unknown[]) {
      S.suiLog.push(["setGasPayment", p.length]);
    }
    async build() {
      return new Uint8Array([9, 9, 9]);
    }
  }
  return { ...actual, Transaction: FakeTransaction };
});

const { invoke } = await import("../../lib/tauri");
const {
  executeIntentsTrade,
  isIntentsPollActive,
  pollIntentsToTerminal,
} = await import("./swap-execute");
const { SWAP_COIN_META, getDropdownTickers, isIntentsRoutable } = await import("./swap-data");
const {
  __resetIntentsAttemptsForTests,
  IntentsQuoteAlreadyUsedError,
  intentsDepositAttempt,
  intentsDepositKey,
  isIntentsDepositUsed,
} = await import("./intents-attempts");
const { IntentsQuoteMismatchError, echoMismatches, statusDescribesDeposit } = await import(
  "./intents-quote-binding"
);
const {
  IntentsDepositMemoError,
  IntentsProxyMemoUnsupportedError,
  PROXY_MEMO_UNSUPPORTED_MESSAGE,
  intentsDepositModeFor,
} = await import("./intents-deposit-memo");
const { SafetyInvariantError } = await import("./safety-invariants");
const { isSendOutcomeUnknown, SendOutcomeUnknownError } = await import("../../wallets/send-outcome");
const {
  buildIntentsRequestSafely,
  echoOfRequest,
  humanizeError,
  normalizeIntents,
  requestIntentsQuote,
  selectHandedOutQuote,
} = await import("./useSwapQuote");
const { buildExactInputDryProbe, buildExactOutputDryProbe } = await import(
  "./intents-pair-min-probe"
);
const { rowsToResume, resumePendingIntentsSwaps } = await import("./intents-status-resume");
const { parseMinAtomicFromUpstreamError } = await import("./intents-pair-min-cache");
const { nativeMaxReserve } = await import("./feeReserve");
const { SwapConfirmModal } = await import("./SwapConfirmModal");
const { stellarAdapter } = await import("../../wallets/stellar-wallet");
const { suiAdapter } = await import("../../wallets/sui-wallet");
const proxy = await import("../../api/proxy");
const realProxy = await vi.importActual<typeof import("../../api/proxy")>("../../api/proxy");

// ── Fixtures ────────────────────────────────────────────────────────────

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xlmMe = stellarAdapter.deriveFromMnemonic(ABANDON);
const XLM_SEED = Uint8Array.from(Buffer.from(xlmMe.privateKey, "hex"));
const XLM_PUB = ed25519.getPublicKey(XLM_SEED);
const suiMe = suiAdapter.deriveFromMnemonic(ABANDON);

/** The live test-seed quote the lead captured on 2026-09-30: 100 XLM → NEAR. */
const SHARED_XLM_DEPOSIT = "GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK";
const LIVE_MEMO = "188711688";
const XLM_ASSET = SWAP_COIN_META.XLM.nearIntentsAsset!;
const SUI_ASSET = SWAP_COIN_META.SUI.nearIntentsAsset!;
const NEAR_ASSET = "nep141:wrap.near";
const NEAR_DEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SUI_DEPOSIT = "0x" + "5d".repeat(32);
const { TransactionDataBuilder } = await import("@mysten/sui/transactions");
/** The digest of the fake builder's bytes: what a real Sui deposit reports. */
const SUI_FAKE_DIGEST = TransactionDataBuilder.getDigestFromBytes(new Uint8Array([9, 9, 9]));
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/** Executor input for an XLM or SUI deposit, bound correctly. */
function bound(args: {
  fromAsset: "XLM" | "SUI";
  amountIn: string;
  depositAddress: string;
  depositMemo?: unknown;
  sourceAddress?: string;
  requestOverrides?: Record<string, unknown>;
}) {
  const meta = SWAP_COIN_META[args.fromAsset];
  const sourceAddress =
    args.sourceAddress ?? (args.fromAsset === "XLM" ? xlmMe.address : suiMe.address);
  const deadline = inMinutes(180);
  return {
    sessionId: "session-1",
    fromAsset: args.fromAsset,
    intentsQuote: {
      depositAddress: args.depositAddress,
      ...(args.depositMemo !== undefined ? { depositMemo: args.depositMemo } : {}),
      amountIn: args.amountIn,
      deadline,
    } as any,
    sourceAddress,
    userIntendedAtomic: BigInt(args.amountIn),
    quoteRequest: {
      originAsset: meta.nearIntentsAsset!,
      destinationAsset: NEAR_ASSET,
      amount: args.amountIn,
      recipient: NEAR_DEST,
      refundTo: sourceAddress,
      deadline,
      ...(args.fromAsset === "XLM" ? { depositMode: "MEMO" as const } : {}),
      ...(args.requestOverrides ?? {}),
    } as any,
    destinationAsset: NEAR_ASSET,
    destinationAddress: NEAR_DEST,
  };
}

// ── Fake Horizon + fake Rust core (for the real Stellar payment) ─────────

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/hal+json" },
  });

function horizonAccount(id: string, balance: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    account_id: id,
    sequence: "1000",
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [{ asset_type: "native", balance, selling_liabilities: "0.0000000" }],
    data: {},
    ...extra,
  };
}

async function horizonFetch(input: unknown, init?: { method?: string; body?: unknown }) {
  const path = String(input).replace("https://horizon.stellar.org", "");
  if (init?.method === "POST" && path === "/transactions") {
    S.horizon.posted.push(new URLSearchParams(String(init.body)).get("tx") ?? "");
    return json(200, { successful: true });
  }
  const acct = /^\/accounts\/(.*)$/.exec(path);
  if (acct) {
    const a = S.horizon.accounts[decodeURIComponent(acct[1])];
    return a ? json(200, a) : json(404, { title: "Resource Missing", status: 404 });
  }
  throw new Error(`unscripted Horizon ${init?.method ?? "GET"} ${path}`);
}

/**
 * Sui's GraphQL, as the proxy returns it (2026-10-01 layouts): one coin of
 * 5 SUI and no address balance, a successful dry run, a successful submit.
 */
function suiGraphql(args: { url: string; body: string }) {
  const { query } = JSON.parse(args.body);
  const data = (d: unknown) => ({ status: 200, body: JSON.stringify({ data: d }), headers: [] });
  if (query.includes("simulateTransaction")) {
    return data({
      simulateTransaction: {
        effects: {
          status: "SUCCESS",
          executionError: null,
          gasEffects: { gasSummary: { computationCost: 100000, storageCost: 1976000, storageRebate: 0 } },
        },
      },
    });
  }
  if (query.includes("executeTransaction")) {
    return data({ executeTransaction: { effects: { digest: SUI_FAKE_DIGEST, status: "SUCCESS", executionError: null } } });
  }
  if (query.includes("objects(")) {
    const id = "0x" + "c0".repeat(32);
    return data({
      epoch: { referenceGasPrice: "100" },
      address: {
        balance: { coinBalance: "5000000000", addressBalance: "0" },
        objects: {
          nodes: [
            { address: id, version: 1, digest: "4ZAVLMEE62Aa8gm41JKUfzSQW4wdp5T62vDkdYgN1g4U", contents: { json: { id, balance: "5000000000" } } },
          ],
        },
      },
    });
  }
  throw new Error(`unscripted Sui GraphQL ${String(query).slice(0, 60)}`);
}

async function fakeInvoke(cmd: string, args: any): Promise<unknown> {
  switch (cmd) {
    case "http_proxy_call":
      if (String(args?.url).includes("graphql.mainnet.sui.io")) return suiGraphql(args);
      throw new Error(`unscripted proxy call ${args?.url}`);
    case "swap_get_stellar_address":
      return S.signer.stellar;
    case "swap_sign_stellar_tx": {
      // swap/stellar.rs sign_tx: sha256(network id || ENVELOPE_TYPE_TX || tx).
      const tx = Buffer.from(args.input.txXdrBase64, "base64");
      const networkId = sha256(new TextEncoder().encode(Networks.PUBLIC));
      const digest = sha256(Buffer.concat([networkId, Buffer.from([0, 0, 0, 2]), tx]));
      return {
        publicKeyBase64: Buffer.from(XLM_PUB).toString("base64"),
        hintBase64: Buffer.from(XLM_PUB.subarray(28)).toString("base64"),
        signatureBase64: Buffer.from(ed25519.sign(digest, XLM_SEED)).toString("base64"),
      };
    }
    case "swap_get_sui_address":
      return S.signer.sui;
    case "swap_sign_sui_tx":
      return {
        signatureBase64: Buffer.from([0, 1, 2]).toString("base64"),
        publicKeyBase64: Buffer.from(
          ed25519.getPublicKey(Uint8Array.from(Buffer.from(suiMe.privateKey, "hex"))),
        ).toString("base64"),
      };
    case "swap_set_proxy_url":
    case "intents_status":
    case "intents_deposit_submit":
      return { status: "PENDING_DEPOSIT" };
    default:
      throw new Error(`unscripted invoke ${cmd}`);
  }
}
const invokedWith = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  S.notify.length = 0;
  S.statusCalls.length = 0;
  S.statusQueue.length = 0;
  S.stellar.length = 0;
  S.sui.length = 0;
  S.suiLog.length = 0;
  S.stellarImpl = null;
  S.suiImpl = null;
  S.horizon.posted = [];
  S.horizon.accounts = {
    [xlmMe.address]: horizonAccount(xlmMe.address, "500.0000000"),
    // 1Click's shared deposit account; SEP-29 memo_required, as an exchange-
    // style account would set it. The payment carries a memo, so it passes.
    [SHARED_XLM_DEPOSIT]: horizonAccount(SHARED_XLM_DEPOSIT, "90000.0000000", {
      data: { "config.memo_required": "MQ==" },
    }),
  };
  S.signer = { stellar: xlmMe.address, sui: suiMe.address };
  __resetIntentsAttemptsForTests();
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", vi.fn(horizonFetch));
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(fakeInvoke as any);
});

// ─────────────────────────────────────────────────────────────────────────
// The roster
// ─────────────────────────────────────────────────────────────────────────

describe("XLM and SUI are NEAR Intents sources again (F7 follow-up, 2026-09-29 send-safety audit)", () => {
  it("both are on the NEAR source roster and quotable as a FROM asset", () => {
    const sources = getDropdownTickers({ sourceOnly: true, router: "intents" });
    // Before: F7 had removed both, because the executor could not deposit them.
    expect(sources).toContain("XLM");
    expect(sources).toContain("SUI");
    expect(isIntentsRoutable("XLM", "BTC")).toBe(true);
    expect(isIntentsRoutable("SUI", "BTC")).toBe(true);
  });

  it("MAX leaves Stellar's minimum balance and the fee bid behind, and Sui's gas", () => {
    // Without a reserve, MAX asked for the whole XLM balance, which Stellar's
    // 1 XLM minimum balance makes unsendable — refused on every account.
    expect(nativeMaxReserve(SWAP_COIN_META.XLM)).toBeGreaterThanOrEqual(1.01);
    expect(nativeMaxReserve(SWAP_COIN_META.SUI)).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SUI
// ─────────────────────────────────────────────────────────────────────────

describe("SUI deposits (F7 follow-up, 2026-09-29 send-safety audit)", () => {
  it("calls executeSuiTransfer with the exact decimal amount and the deposit address", async () => {
    S.suiImpl = async () => ({ txHash: "SUI-DIGEST" });
    for (const [amountIn, decimal] of [
      ["1234567891", "1.234567891"],
      ["5000000000", "5"],
      ["1", "0.000000001"],
      ["123456789012345678", "123456789.012345678"], // beyond 2^53 MIST: no float anywhere
    ] as const) {
      const deposit = `0x${amountIn.padStart(64, "0")}`;
      const r = await executeIntentsTrade(
        bound({ fromAsset: "SUI", amountIn, depositAddress: deposit }),
      );
      expect(r.sourceTxHash).toBe("SUI-DIGEST");
      expect(S.sui.at(-1)).toEqual({
        sessionId: "session-1",
        fromAddress: suiMe.address,
        to: deposit,
        amount: decimal,
      });
    }
    // Before 2026-09-30 every one of these threw "SUI cannot be a NEAR
    // Intents source in this build" after the password.
    expect(S.sui).toHaveLength(4);
    // SIMPLE mode: the notify carries no memo key at all.
    expect(S.notify.at(-1)).toEqual({ depositAddress: `0x${"123456789012345678".padStart(64, "0")}`, txHash: "SUI-DIGEST" });
  });

  it("the real Sui transfer splits exactly amountIn MIST and pays the deposit address", async () => {
    const r = await executeIntentsTrade(
      bound({ fromAsset: "SUI", amountIn: "1234567891", depositAddress: SUI_DEPOSIT }),
    );
    // The hash of the bytes that were signed (2026-10-01: the send reports its
    // own digest, not the node's).
    expect(r.sourceTxHash).toBe(SUI_FAKE_DIGEST);
    expect(S.suiLog).toContainEqual(["splitCoins", 1234567891n]);
    expect(S.suiLog).toContainEqual(["transferObjects", SUI_DEPOSIT]);
    expect(S.suiLog).toContainEqual(["setSender", suiMe.address]);
    // Gas from GraphQL: the reference price, then the budget and the one coin.
    expect(S.suiLog).toContainEqual(["setGasPrice", 100n]);
    expect(S.suiLog).toContainEqual(["setGasPayment", 1]);
  });

  it("an unknown outcome is recorded with the digest and never retried on the same quote", async () => {
    S.suiImpl = async () => {
      throw new SendOutcomeUnknownError("Sui has not confirmed the transaction.", "DIGEST-X");
    };
    const args = bound({ fromAsset: "SUI", amountIn: "2000000000", depositAddress: SUI_DEPOSIT });
    const err = await executeIntentsTrade(args).catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
    expect(err.hash).toBe("DIGEST-X");
    expect(intentsDepositAttempt(SUI_DEPOSIT)).toMatchObject({ state: "unknown", txHash: "DIGEST-X" });
    // A Retry, a re-opened modal, a second click: refused, nothing rebuilt.
    await expect(executeIntentsTrade(args)).rejects.toBeInstanceOf(IntentsQuoteAlreadyUsedError);
    expect(S.sui).toHaveLength(1);
    expect(S.notify).toEqual([]);
  });

  it("the session's Sui key must control the wallet's address (wrong-key guard, before building)", async () => {
    S.signer.sui = "0x" + "cd".repeat(32);
    const err = await executeIntentsTrade(
      bound({ fromAsset: "SUI", amountIn: "1000000000", depositAddress: SUI_DEPOSIT }),
    ).catch((e) => e);
    expect(String(err?.message)).toMatch(/isn't supported yet/);
    expect(invokedWith("swap_sign_sui_tx")).toEqual([]);
  });

  it("a SUI quote that carries a memo is refused before anything is signed", async () => {
    S.suiImpl = async () => ({ txHash: "never" });
    const err = await executeIntentsTrade(
      bound({ fromAsset: "SUI", amountIn: "1000000000", depositAddress: SUI_DEPOSIT, depositMemo: "42" }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(IntentsDepositMemoError);
    expect(S.sui).toEqual([]);
    // Nothing was claimed, so the quote's state says nothing was attempted.
    expect(isIntentsDepositUsed(SUI_DEPOSIT)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// XLM: the quote request
// ─────────────────────────────────────────────────────────────────────────

const WALLET = {
  evm: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  btc: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  ltc: "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh",
  sol: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
  near: NEAR_DEST,
  stellar: xlmMe.address,
  sui: suiMe.address,
  xrp: "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3",
  tron: "TPrkFhZ8LH8Mruco8vXyA496TaeFBrbmeU",
  cardano:
    "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv",
};

/** The body keys, in order, that every quote had before 2026-09-30. */
const BODY_KEYS_BEFORE = [
  "dry",
  "swapType",
  "slippageTolerance",
  "originAsset",
  "depositType",
  "destinationAsset",
  "recipientType",
  "amount",
  "recipient",
  "refundType",
  "refundTo",
  "deadline",
  "quoteWaitingTimeMs",
];

describe("XLM quotes are requested in MEMO mode, and only XLM quotes (F7 follow-up, 2026-09-29 send-safety audit)", () => {
  const body = (ticker: string, to = "BTC") =>
    buildIntentsRequestSafely({
      fromAsset: SWAP_COIN_META[ticker].nearIntentsAsset!,
      toAsset: SWAP_COIN_META[to].nearIntentsAsset!,
      fromMeta: SWAP_COIN_META[ticker],
      amount: "1",
      slippage: 0.01,
      walletAddresses: WALLET,
    });

  it("a Stellar origin carries depositMode MEMO, appended after the old fields", () => {
    const b = body("XLM");
    // Before: no such field, and 1Click answered HTTP 400 "Incorrect
    // depositMode for originAsset from stellar chain".
    expect(b.depositMode).toBe("MEMO");
    expect(Object.keys(b)).toEqual([...BODY_KEYS_BEFORE, "depositMode"]);
    expect(b.refundTo).toBe(xlmMe.address);
    expect(b.amount).toBe("10000000"); // 1 XLM = 10^7 stroops
  });

  it("every other origin's body is exactly what it was — no depositMode key at all", () => {
    for (const t of ["ETH", "BTC", "SOL", "NEAR", "SUI", "XRP", "TRX", "LTC", "ADA", "USDC-BSC", "AVAX"]) {
      const b = body(t, t === "BTC" ? "ETH" : "BTC");
      expect(Object.keys(b), t).toEqual(BODY_KEYS_BEFORE);
      expect("depositMode" in b, t).toBe(false);
      expect(JSON.stringify(b), t).not.toContain("depositMode");
    }
  });

  it("the minimum probes ask in MEMO mode for XLM only", () => {
    const tok = (ticker: string) => ({
      assetId: SWAP_COIN_META[ticker].nearIntentsAsset!,
      decimals: SWAP_COIN_META[ticker].decimals,
      blockchain: "x",
      symbol: ticker,
    });
    for (const build of [
      () => buildExactOutputDryProbe({ fromAsset: tok("XLM"), toAsset: tok("BTC"), destAmountAtomic: "1000", walletAddresses: WALLET }),
      () => buildExactInputDryProbe({ fromAsset: tok("XLM"), toAsset: tok("BTC"), sourceAmountAtomic: "1000", walletAddresses: WALLET }),
    ]) {
      expect(build().depositMode).toBe("MEMO");
    }
    const eth = buildExactInputDryProbe({ fromAsset: tok("ETH"), toAsset: tok("BTC"), sourceAmountAtomic: "1000", walletAddresses: WALLET });
    expect("depositMode" in eth).toBe(false);
    // Stellar is recognised by the catalog and by the HOT Omni chain id.
    expect(intentsDepositModeFor(XLM_ASSET)).toBe("MEMO");
    expect(intentsDepositModeFor("nep245:v2_1.omni.hot.tg:1100_somethingNotInTheCatalog")).toBe("MEMO");
    expect(intentsDepositModeFor("nep245:v2_1.omni.hot.tg:137_11111111111111111111")).toBeUndefined();
    expect(intentsDepositModeFor(SUI_ASSET)).toBeUndefined();
  });

  it("the quote keeps the mode it was asked in and the memo it was given", () => {
    const req = body("XLM", "NEAR");
    const sent = echoOfRequest(req);
    // Dropped here, every XLM quote would fail its own binding check at Sign.
    expect(sent.depositMode).toBe("MEMO");
    expect("depositMode" in echoOfRequest(body("ETH"))).toBe(false);
    const n = normalizeIntents(
      {
        quote: { amountOut: "123000000000000000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: LIVE_MEMO, amountIn: req.amount },
        quoteRequest: { ...req },
      } as any,
      0.01,
      SWAP_COIN_META.NEAR,
      sent,
    )!;
    expect(n.intentsQuote?.depositMemo).toBe(LIVE_MEMO);
    expect(n.intentsRequest?.depositMode).toBe("MEMO");
    expect(n.intentsEcho?.depositMode).toBe("MEMO");
  });

  it("the route estimator's second-hop quote asks in MEMO mode for XLM only", async () => {
    const { quoteHop2, __resetHop2Cache } = await import("./hop2Quote");
    const quoted = vi.mocked(proxy.getIntentsQuote);
    quoted.mockReset();
    quoted.mockResolvedValue({ quote: { amountOut: "100000" } } as any);
    __resetHop2Cache();
    await quoteHop2({ fromTicker: "XLM", toTicker: "BTC", amount: 100, addressFor: () => "addr" });
    expect(quoted.mock.calls[0][0].depositMode).toBe("MEMO");
    __resetHop2Cache();
    await quoteHop2({ fromTicker: "ETH", toTicker: "BTC", amount: 1, addressFor: () => "addr" });
    expect("depositMode" in quoted.mock.calls[1][0]).toBe(false);
  });
});

describe("a wallet proxy that refuses depositMode is named in the error (F7 follow-up, 2026-09-29 send-safety audit)", () => {
  const xlmReq = { ...(buildIntentsRequestSafely({
    fromAsset: XLM_ASSET,
    toAsset: NEAR_ASSET,
    fromMeta: SWAP_COIN_META.XLM,
    amount: "100",
    slippage: 0.01,
    walletAddresses: WALLET,
  }) as any) };

  // The invoke rejection is the Rust error string, not an Error object.
  const refusals = [
    // A proxy that validates strictly (Ajv/Fastify wording).
    'proxy returned 400: {"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request","message":"body must NOT have additional properties"}',
    // zod .strict()
    'proxy returned 400: {"error":"VALIDATION","message":"Unrecognized key(s) in object: \'depositMode\'"}',
    // A proxy that strips the field and forwards: 1Click refuses the quote.
    'proxy returned 400: {"error":"UPSTREAM","message":"Upstream API request failed","upstreamStatus":400,"upstreamMessage":"Incorrect depositMode for originAsset from stellar chain","requestId":"00000000-0000-0000-0000-000000000000"}',
  ];

  for (const refusal of refusals) {
    it(`XLM: ${refusal.slice(22, 80)}…`, async () => {
      const err = await requestIntentsQuote(xlmReq, async () => {
        throw refusal;
      }).catch((e) => e);
      expect(err).toBeInstanceOf(IntentsProxyMemoUnsupportedError);
      // What the swap form shows.
      const shown = humanizeError(err);
      expect(shown.startsWith("XLM swaps need the wallet proxy to accept depositMode/memo")).toBe(true);
      // Before: "Quote request rejected by upstream: …" or the raw envelope.
      expect(shown).not.toMatch(/rejected by upstream/);
    });
  }

  it("the sentence cannot be mistaken for a pair minimum", () => {
    expect(parseMinAtomicFromUpstreamError(PROXY_MEMO_UNSUPPORTED_MESSAGE)).toBeNull();
  });

  it("other chains' errors, and XLM's other errors, pass through untouched", async () => {
    const ethReq = buildIntentsRequestSafely({
      fromAsset: SWAP_COIN_META.ETH.nearIntentsAsset!,
      toAsset: NEAR_ASSET,
      fromMeta: SWAP_COIN_META.ETH,
      amount: "1",
      slippage: 0.01,
      walletAddresses: WALLET,
    });
    const strict = refusals[0];
    await expect(requestIntentsQuote(ethReq, async () => { throw strict; })).rejects.toBe(strict);
    const low = 'proxy returned 400: {"error":"UPSTREAM","upstreamStatus":400,"upstreamMessage":"Amount is too low for bridge, try at least 12345678"}';
    await expect(requestIntentsQuote(xlmReq, async () => { throw low; })).rejects.toBe(low);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// XLM: the deposit
// ─────────────────────────────────────────────────────────────────────────

describe("XLM deposits carry the quote's memo (F7 follow-up, 2026-09-29 send-safety audit)", () => {
  it("the real Stellar payment carries Memo.text(depositMemo), to the shared address, for exactly amountIn", async () => {
    const r = await executeIntentsTrade(
      bound({ fromAsset: "XLM", amountIn: "1000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: LIVE_MEMO }),
    );
    expect(S.horizon.posted).toHaveLength(1);
    const tx = TransactionBuilder.fromXDR(S.horizon.posted[0], Networks.PUBLIC) as any;
    // TEXT, not ID — see intents-deposit-memo.ts for the ledger evidence.
    expect(tx.memo.type).toBe("text");
    expect(String(tx.memo.value)).toBe(LIVE_MEMO);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("payment");
    expect(tx.operations[0].destination).toBe(SHARED_XLM_DEPOSIT);
    expect(tx.operations[0].amount).toBe("100.0000000");
    expect(tx.source).toBe(xlmMe.address);
    expect(r.sourceTxHash).toBe(tx.hash().toString("hex"));
    expect(r.depositMemo).toBe(LIVE_MEMO);
    // The executor asked for it in exactly this shape.
    expect(S.stellar[0]).toEqual({
      sessionId: "session-1",
      fromAddress: xlmMe.address,
      to: SHARED_XLM_DEPOSIT,
      amount: "100",
      memo: { type: "text", value: LIVE_MEMO },
      destinationMustExist: true,
    });
  });

  it("a quote with no usable memo is refused before signing", async () => {
    for (const memo of [undefined, null, "", "   ", 188711688]) {
      __resetIntentsAttemptsForTests();
      const err = await executeIntentsTrade(
        bound({ fromAsset: "XLM", amountIn: "1000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: memo }),
      ).catch((e) => e);
      expect(err, String(memo)).toBeInstanceOf(IntentsDepositMemoError);
      expect(String(err.message)).toMatch(/Nothing was signed/);
    }
    expect(S.stellar).toEqual([]);
    expect(invokedWith("swap_sign_stellar_tx")).toEqual([]);
    expect(S.horizon.posted).toEqual([]);
  });

  it("a memo longer than Stellar's 28-byte MEMO_TEXT is refused, never truncated", async () => {
    const at28 = "é".repeat(14); // 28 bytes in UTF-8
    const over = "é".repeat(15); // 30 bytes
    const err = await executeIntentsTrade(
      bound({ fromAsset: "XLM", amountIn: "1000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: over }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(IntentsDepositMemoError);
    expect(String(err.message)).toMatch(/30 bytes/);
    expect(S.stellar).toEqual([]);
    // The boundary itself is fine.
    S.stellarImpl = async () => ({ txHash: "xlm-28" });
    await executeIntentsTrade(
      bound({ fromAsset: "XLM", amountIn: "1000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: at28 }),
    );
    expect(S.stellar[0].memo).toEqual({ type: "text", value: at28 });
  });

  it("two XLM swaps to the shared address with different memos both go out; the same memo twice is refused", async () => {
    S.stellarImpl = async (a) => ({ txHash: `xlm-${a.memo.value}` });
    const first = bound({ fromAsset: "XLM", amountIn: "1000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: "188711688" });
    const second = bound({ fromAsset: "XLM", amountIn: "2000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: "188711689" });
    await executeIntentsTrade(first);
    // Keyed by the address alone, this second, separate swap was refused as
    // "This quote was already used".
    await executeIntentsTrade(second);
    await expect(executeIntentsTrade(first)).rejects.toBeInstanceOf(IntentsQuoteAlreadyUsedError);
    expect(S.stellar.map((c) => c.memo.value)).toEqual(["188711688", "188711689"]);
    expect(isIntentsDepositUsed({ depositAddress: SHARED_XLM_DEPOSIT, depositMemo: "188711690" })).toBe(false);
    // The address-only key is not a memo deposit's key.
    expect(isIntentsDepositUsed(SHARED_XLM_DEPOSIT)).toBe(false);
  });

  it("the attempt key: address alone as before; address plus memo, byte for byte, when there is one", () => {
    // Unchanged for SIMPLE-mode deposits (EVM checksum casing is display only).
    expect(intentsDepositKey("0xAbC0000000000000000000000000000000000001")).toBe(
      "0xabc0000000000000000000000000000000000001",
    );
    expect(intentsDepositKey("DEP-1", null)).toBe("DEP-1");
    expect(intentsDepositKey("DEP-1", "")).toBe("DEP-1");
    // A memo deposit never collides with the bare address, nor with a memo
    // that differs only in case or padding.
    const k = intentsDepositKey(SHARED_XLM_DEPOSIT, LIVE_MEMO);
    expect(k).not.toBe(SHARED_XLM_DEPOSIT);
    expect(k).not.toBe(intentsDepositKey(SHARED_XLM_DEPOSIT, ` ${LIVE_MEMO}`));
    expect(intentsDepositKey(SHARED_XLM_DEPOSIT, "abc")).not.toBe(intentsDepositKey(SHARED_XLM_DEPOSIT, "ABC"));
  });

  it("the form hands out a fresh XLM quote at the same address after an earlier one was used", async () => {
    S.stellarImpl = async () => ({ txHash: "xlm-a" });
    await executeIntentsTrade(
      bound({ fromAsset: "XLM", amountIn: "1000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: "111" }),
    );
    const quote = (memo: string) =>
      ({ source: "intents", intentsQuote: { depositAddress: SHARED_XLM_DEPOSIT, depositMemo: memo } }) as any;
    const isUsed = (a: string, m?: string | null) => isIntentsDepositUsed({ depositAddress: a, depositMemo: m });
    // The next quote: same shared address, new memo — handed out.
    expect(selectHandedOutQuote({ quote: quote("222"), quoteKey: "k", currentKey: "k", isUsed })).not.toBeNull();
    // The used one is not.
    expect(selectHandedOutQuote({ quote: quote("111"), quoteKey: "k", currentKey: "k", isUsed })).toBeNull();
  });

  it("the notify and the status query carry the memo", async () => {
    S.stellarImpl = async () => ({ txHash: "xlm-hash" });
    const r = await executeIntentsTrade(
      bound({ fromAsset: "XLM", amountIn: "1000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: LIVE_MEMO }),
    );
    expect(S.notify).toEqual([{ depositAddress: SHARED_XLM_DEPOSIT, txHash: "xlm-hash", memo: LIVE_MEMO }]);

    S.statusQueue.push({ status: "SUCCESS" });
    await pollIntentsToTerminal({ depositAddress: r.depositAddress, depositMemo: r.depositMemo, intervalMs: 1 });
    expect(S.statusCalls).toEqual([[SHARED_XLM_DEPOSIT, LIVE_MEMO]]);
  });

  it("the API layer sends depositMemo to Rust only when there is one", async () => {
    await realProxy.configureProxy();
    vi.mocked(invoke).mockClear();
    await realProxy.getIntentsStatus(SHARED_XLM_DEPOSIT, LIVE_MEMO);
    await realProxy.getIntentsStatus("0xdep");
    await realProxy.notifyIntentsDeposit({ depositAddress: SHARED_XLM_DEPOSIT, txHash: "h", memo: LIVE_MEMO });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["intents_status", { depositAddress: SHARED_XLM_DEPOSIT, depositMemo: LIVE_MEMO }],
      // Unchanged for every chain without a memo.
      ["intents_status", { depositAddress: "0xdep" }],
      ["intents_deposit_submit", { req: { depositAddress: SHARED_XLM_DEPOSIT, txHash: "h", memo: LIVE_MEMO } }],
    ]);
  });

  it("status polling ignores an answer about another deposit at the shared address", async () => {
    const foreign = { status: "SUCCESS", quoteResponse: { quote: { depositAddress: SHARED_XLM_DEPOSIT, depositMemo: "999" } } };
    const ours = { status: "REFUNDED", quoteResponse: { quote: { depositAddress: SHARED_XLM_DEPOSIT, depositMemo: LIVE_MEMO } } };
    S.statusQueue.push(foreign, ours);
    const seen: any[] = [];
    const terminal = await pollIntentsToTerminal({
      depositAddress: SHARED_XLM_DEPOSIT,
      depositMemo: LIVE_MEMO,
      intervalMs: 1,
      onUpdate: (s) => seen.push(s),
    });
    expect(terminal).toBe(ours);
    expect(seen).toEqual([ours]);
    // No echo at all is accepted (absent is not evidence); no memo, no check.
    expect(statusDescribesDeposit({ status: "SUCCESS" }, { depositAddress: SHARED_XLM_DEPOSIT, depositMemo: LIVE_MEMO })).toBe(true);
    expect(statusDescribesDeposit(foreign, { depositAddress: SHARED_XLM_DEPOSIT })).toBe(true);
  });

  it("a poller for one XLM swap is not a poller for the next, and a resumed row polls with its memo", async () => {
    const polling = pollIntentsToTerminal({ depositAddress: SHARED_XLM_DEPOSIT, depositMemo: "A1", intervalMs: 1 });
    expect(isIntentsPollActive(SHARED_XLM_DEPOSIT, "A1")).toBe(true);
    expect(isIntentsPollActive(SHARED_XLM_DEPOSIT, "B2")).toBe(false);
    S.statusQueue.push({ status: "SUCCESS" });
    await polling;

    const row = (id: string, memo: string) =>
      ({
        id,
        fromAsset: "XLM",
        toAsset: "NEAR",
        fromAmount: "100",
        toAmount: "1",
        status: "pending",
        sourceTxHash: "h",
        sourceExplorerUrl: "",
        createdAt: new Date().toISOString(),
        depositAddress: SHARED_XLM_DEPOSIT,
        depositMemo: memo,
      }) as any;
    // Keyed by the address alone, B2 would have been skipped as "already polled".
    const active = (a: string, m?: string) => a === SHARED_XLM_DEPOSIT && m === "A1";
    expect(rowsToResume([row("a", "A1"), row("b", "B2")], Date.now(), active).map((r) => r.id)).toEqual(["b"]);

    const polled: any[] = [];
    await resumePendingIntentsSwaps({
      load: async () => [row("b", "B2")],
      update: async () => {},
      poll: async (args) => {
        polled.push(args);
        return { status: "SUCCESS" } as any;
      },
      isActive: () => false,
      now: () => Date.now(),
    });
    expect(polled).toEqual([{ depositAddress: SHARED_XLM_DEPOSIT, depositMemo: "B2", deadline: undefined, intervalMs: 30_000 }]);
  });

  it("an 1Click deposit address with no Stellar account is refused, not created", async () => {
    delete S.horizon.accounts[SHARED_XLM_DEPOSIT];
    const err = await executeIntentsTrade(
      bound({ fromAsset: "XLM", amountIn: "1000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: LIVE_MEMO }),
    ).catch((e) => e);
    expect(String(err?.message)).toMatch(/no Stellar account[\s\S]*Nothing was sent/);
    expect(invokedWith("swap_sign_stellar_tx")).toEqual([]);
    expect(S.horizon.posted).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// XLM: what the quote is bound to
// ─────────────────────────────────────────────────────────────────────────

describe("the deposit mode is part of what a quote is bound to (F7 follow-up, 2026-09-29 send-safety audit)", () => {
  it("an XLM quote made without MEMO mode is refused before signing", async () => {
    S.stellarImpl = async () => ({ txHash: "never" });
    const err = await executeIntentsTrade(
      bound({
        fromAsset: "XLM",
        amountIn: "1000000000",
        depositAddress: SHARED_XLM_DEPOSIT,
        depositMemo: LIVE_MEMO,
        requestOverrides: { depositMode: undefined },
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(IntentsQuoteMismatchError);
    expect(String(err.message)).toMatch(/SIMPLE deposit mode, and this deposit needs MEMO/);
    expect(S.stellar).toEqual([]);
  });

  it("a non-Stellar quote made in MEMO mode is refused too", async () => {
    const err = await executeIntentsTrade(
      bound({
        fromAsset: "SUI",
        amountIn: "1000000000",
        depositAddress: SUI_DEPOSIT,
        requestOverrides: { depositMode: "MEMO" },
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(IntentsQuoteMismatchError);
    expect(S.sui).toEqual([]);
  });

  it("1Click's echo of a different mode is a safety stop", async () => {
    const args: any = bound({ fromAsset: "XLM", amountIn: "1000000000", depositAddress: SHARED_XLM_DEPOSIT, depositMemo: LIVE_MEMO });
    args.quoteEcho = { ...args.quoteRequest, depositMode: "SIMPLE" };
    const err = await executeIntentsTrade(args).catch((e) => e);
    expect(err).toBeInstanceOf(SafetyInvariantError);
    expect(err.invariant).toBe("QUOTE_ECHO_MISMATCH");
    // The echo the lead captured (depositMode MEMO) matches; absent means SIMPLE.
    expect(echoMismatches(args.quoteRequest, { depositMode: "MEMO" })).toEqual([]);
    expect(echoMismatches({ ...args.quoteRequest, depositMode: undefined }, { depositMode: "SIMPLE" })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The confirm modal (one component, mounted by portrait and landscape)
// ─────────────────────────────────────────────────────────────────────────

describe("the confirm modal shows the memo it will attach (F7 follow-up, 2026-09-29 send-safety audit)", () => {
  const render = (fromAsset: string, intentsQuote: any, intentsRequest: any) =>
    renderToStaticMarkup(
      createElement(SwapConfirmModal, {
        open: true,
        fromAsset,
        toAsset: "NEAR",
        fromAmount: "100",
        quote: {
          source: "intents",
          routerLabel: "NEAR Intents",
          providerName: "solver-relay",
          mockDetected: false,
          intentsQuote,
          intentsRequest,
          intentsEcho: null,
          expectedReceive: "1.23",
          minReceived: "1.2",
          totalFeesSource: "0",
          affiliateFeeSource: "0",
          etaSeconds: 30,
          etaPretty: "~30s",
          warnings: [],
        },
        sourceAddress: fromAsset === "XLM" ? xlmMe.address : suiMe.address,
        destinationAddress: NEAR_DEST,
        onClose: () => {},
      }),
    );
  const xlmRequest = bound({ fromAsset: "XLM", amountIn: "1000000000", depositAddress: SHARED_XLM_DEPOSIT }).quoteRequest;

  it("an XLM quote: 'Deposit memo 188711688 (attached automatically)'", () => {
    const html = render(
      "XLM",
      { depositAddress: SHARED_XLM_DEPOSIT, depositMemo: LIVE_MEMO, amountIn: "1000000000", deadline: inMinutes(30) },
      xlmRequest,
    );
    expect(html).toContain("Deposit memo");
    expect(html).toContain(`${LIVE_MEMO} (attached automatically)`);
    expect(html).not.toContain("data-sign-gate");
  });

  it("an XLM quote without a memo disables Sign with the reason", () => {
    const html = render(
      "XLM",
      { depositAddress: SHARED_XLM_DEPOSIT, depositMemo: null, amountIn: "1000000000", deadline: inMinutes(30) },
      xlmRequest,
    );
    expect(html).not.toContain("Deposit memo");
    expect(html).toMatch(/data-sign-gate[^>]*>[^<]*has no deposit memo/);
  });

  it("a quote without a memo shows no memo row", () => {
    const html = render(
      "SUI",
      { depositAddress: SUI_DEPOSIT, amountIn: "1000000000", deadline: inMinutes(30) },
      bound({ fromAsset: "SUI", amountIn: "1000000000", depositAddress: SUI_DEPOSIT }).quoteRequest,
    );
    expect(html).not.toContain("Deposit memo");
  });
});

// Keep `proxy` referenced: the executor imports it through the mock above.
void proxy;
