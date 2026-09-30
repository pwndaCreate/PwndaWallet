/**
 * `executeIntentsTrade` driven through the REAL asset registry
 * (2026-09-29 send-safety audit).
 *
 * The shipped executor tests (`swap-execute.test.ts`) mock `./swap-data` with a
 * hand-written ETH row, so they never saw the registry — which is why nobody
 * saw F1: every stablecoin leg lacked `tokenContract`, and the executor built a
 * native-coin transfer of the token amount (100 USDC-BSC → 100 BNB). Here only
 * the I/O edges are stubbed: Tauri, the relay, chain RPCs, the signer (a real
 * ethers signature over a throwaway key), and the per-chain submitters that
 * would touch a network. Nothing signs with a real key or reaches a network.
 *
 * Each block names the finding it pins; each assertion fails on the code as it
 * was before the fix (see fixlog-intents.md for how that was checked).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  signEvm: [] as any[],
  broadcastRaw: [] as string[],
  notify: [] as any[],
  order: [] as string[],
  notifyFails: false,
  broadcastImpl: null as null | ((raw: string) => Promise<{ txHash: string }>),
  estimateGas: null as null | ((call: any) => string),
  nativeBalance: 1000n * 10n ** 18n,
  tokenBalance: 10n ** 30n,
  sol: [] as any[],
  spl: [] as any[],
  utxoRust: [] as any[],
  adapterSends: [] as any[],
  accountSends: [] as any[],
  supportsAccount: true,
  accountUtxos: { primary: 0n, change: 402_888_049n },
}));

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(async () => undefined) }));

// The account a fake LTC/DOGE/DASH adapter "holds", modelled on the incident:
// primary address empty since 2026-08-22, 4.02888049 LTC on a change address.
const PRIMARY_LTC = "ltc1qty7jwkskqt8m82w73hxcsrh7gxkf90x27pxjn3";

function fakeAdapter(chain: string) {
  return {
    chain,
    async sendTransaction(_pk: string, to: string, amount: string) {
      S.adapterSends.push({ chain, to, amount });
      return { hash: `${chain}-hash` };
    },
    supportsAccountSend(_m: string, address: string) {
      return S.supportsAccount && address.length > 0;
    },
    async sendFromAccount(
      mnemonic: string,
      to: string,
      amount: string,
      fromAddress?: string,
      opts?: { feeRate?: number },
    ) {
      S.accountSends.push({ chain, mnemonic, to, amount, fromAddress, opts });
      // What the adapter does: gather every address of the account.
      const held = S.accountUtxos.primary + S.accountUtxos.change;
      const want = BigInt(Math.round(parseFloat(amount) * 1e8));
      if (held < want) throw new Error("insufficient funds across the account");
      return { hash: `${chain}-account-hash` };
    },
    async getFeeEstimate() {
      return { normal: { value: "10" }, fast: { value: "25.2" }, unit: "sat/vB", fetchedAt: 0 };
    },
  };
}

vi.mock("../../wallets", () => ({
  getAdapter: vi.fn((chain: string) => fakeAdapter(chain)),
  getAdapterByChain: vi.fn(() => null),
  ALL_CHAINS: [],
}));

vi.mock("../../api/proxy", () => ({
  buildSwapKitTx: vi.fn(),
  trackSwapKitSwap: vi.fn(),
  getIntentsStatus: vi.fn(),
  notifyIntentsDeposit: vi.fn(async (req: unknown) => {
    S.order.push("notify");
    S.notify.push(req);
    if (S.notifyFails) throw new Error("proxy returned 503: upstream unavailable");
    return {};
  }),
}));

vi.mock("../../api/swap-rust", () => ({
  signPsbt: vi.fn(async () => {
    throw new Error("signPsbt must not be called in these tests");
  }),
  broadcastTx: vi.fn(),
  getNearAddress: vi.fn(async () => ({ accountId: "ab".repeat(32), publicKey: "ed25519:x" })),
  getSolanaAddress: vi.fn(async () => "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"),
  getUtxoAddress: vi.fn(async () => PRIMARY_LTC),
  signEvm: vi.fn(async (_sid: string, tx: any) => {
    S.order.push("sign");
    S.signEvm.push(tx);
    const { Wallet, Transaction } = await import("ethers");
    const w = new Wallet("0x" + "11".repeat(32));
    const t = Transaction.from({
      type: 0,
      chainId: tx.chainId,
      nonce: Number(BigInt(tx.nonce)),
      gasPrice: BigInt(tx.gasPrice),
      gasLimit: BigInt(tx.gas),
      to: tx.to,
      value: BigInt(tx.value),
      data: tx.data,
    });
    return { rawTx: await w.signTransaction(t) };
  }),
  broadcastEvmVerified: vi.fn(async (_urls: string[], raw: string) => {
    S.order.push("broadcast");
    S.broadcastRaw.push(raw);
    if (S.broadcastImpl) return { ...(await S.broadcastImpl(raw)), urlUsed: "stub", attempts: [] };
    const { keccak256 } = await import("ethers");
    return { txHash: keccak256(raw), urlUsed: "stub", attempts: [] };
  }),
}));

vi.mock("../../wallets/chain-rpcs", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    jsonRpcCall: vi.fn(async (_urls: string[], method: string, params: any[]) => {
      if (method === "eth_gasPrice") return "0x3b9aca00"; // 1 gwei
      if (method === "eth_getBalance") return "0x" + S.nativeBalance.toString(16);
      if (method === "eth_call") return "0x" + S.tokenBalance.toString(16).padStart(64, "0");
      if (method === "eth_getTransactionCount") return "0x5";
      if (method === "eth_estimateGas") {
        if (S.estimateGas) return S.estimateGas(params[0]);
        throw new Error("method not supported by this stub");
      }
      throw new Error("unexpected rpc " + method);
    }),
  };
});

vi.mock("./swap-sources", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    executeSolanaTransfer: vi.fn(async (a: any) => {
      S.sol.push(a);
      return { txHash: "sol-hash" };
    }),
    executeSplTransfer: vi.fn(async (a: any) => {
      S.spl.push(a);
      return { txHash: "spl-hash" };
    }),
    executeNearNativeTransfer: vi.fn(async () => ({ txHash: "near-hash" })),
    executeCardanoTransfer: vi.fn(async () => ({ txHash: "ada-hash" })),
    // The single-address Rust PSBT builder. F10: never used while the
    // adapter's account-wide send is available.
    executeUtxoTransfer: vi.fn(async (a: any) => {
      S.utxoRust.push(a);
      throw new Error(`No UTXOs found at ${a.fromAddress}. Did the funding tx confirm?`);
    }),
  };
});

const { executeIntentsTrade, pollIntentsToTerminal, intentsStatusToHistory } = await import(
  "./swap-execute"
);
const { SWAP_COIN_META, getSwapCoinMeta, getDropdownTickers } = await import("./swap-data");
const { defaultBlockchainFor } = await import("./intents-dedup");
const { STABLECOIN_NETWORKS } = await import("../../wallets/stablecoins");
const { parseErc20TransferCalldata } = await import("./erc20-calldata");
const { __resetIntentsAttemptsForTests, IntentsQuoteAlreadyUsedError } = await import(
  "./intents-attempts"
);
const { IntentsQuoteMismatchError, IntentsQuoteExpiredError } = await import(
  "./intents-quote-binding"
);
const { isSendOutcomeUnknown } = await import("../../wallets/send-outcome");
const { SafetyInvariantError } = await import("./safety-invariants");
const { decimalToBaseUnitsBigInt } = await import("./swap-sources");
const proxy = await import("../../api/proxy");

const USER_EVM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"; // abandon…about m/44'/60'/0'/0/0
const BTC_DEST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const BTC_ASSET = "nep141:btc.omft.near";
let depositCounter = 0;
/** A fresh EVM deposit address per test — each quote has its own. */
function nextEvmDeposit(): string {
  depositCounter += 1;
  return "0x" + depositCounter.toString(16).padStart(40, "0");
}
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/** Everything `executeIntentsTrade` needs for `fromAsset`, bound correctly. */
function bound(args: {
  fromAsset: string;
  amountIn: string;
  depositAddress: string;
  sourceAddress: string;
  fromBlockchain?: any;
  deadline?: string;
  quoteOverrides?: Record<string, unknown>;
  requestOverrides?: Record<string, unknown>;
  sourceSecret?: any;
  onBroadcast?: any;
}) {
  const meta =
    (args.fromBlockchain ? getSwapCoinMeta(args.fromAsset, args.fromBlockchain) : null) ??
    SWAP_COIN_META[args.fromAsset.toUpperCase()];
  // Well past every origin chain's landing margin (BTC's is the longest), so
  // only the tests about deadlines meet the deposit-window check. A default of
  // 30 minutes sat exactly on LTC's 30-minute margin and flaked on timing.
  const deadline = args.deadline ?? inMinutes(180);
  return {
    sessionId: "s",
    fromAsset: args.fromAsset,
    fromBlockchain: args.fromBlockchain,
    intentsQuote: {
      depositAddress: args.depositAddress,
      amountIn: args.amountIn,
      deadline,
      ...(args.quoteOverrides ?? {}),
    } as any,
    sourceAddress: args.sourceAddress,
    userIntendedAtomic: BigInt(args.amountIn),
    sourceSecret: args.sourceSecret,
    quoteRequest: {
      originAsset: meta.nearIntentsAsset!,
      destinationAsset: BTC_ASSET,
      amount: args.amountIn,
      recipient: BTC_DEST,
      refundTo: args.sourceAddress,
      deadline,
      ...(args.requestOverrides ?? {}),
    },
    destinationAsset: BTC_ASSET,
    destinationAddress: BTC_DEST,
    onBroadcast: args.onBroadcast,
  };
}

beforeEach(() => {
  for (const k of [
    "signEvm",
    "broadcastRaw",
    "notify",
    "order",
    "sol",
    "spl",
    "utxoRust",
    "adapterSends",
    "accountSends",
  ] as const) {
    (S as any)[k].length = 0;
  }
  S.notifyFails = false;
  S.broadcastImpl = null;
  S.estimateGas = null;
  S.nativeBalance = 1000n * 10n ** 18n;
  S.tokenBalance = 10n ** 30n;
  S.supportsAccount = true;
  S.accountUtxos = { primary: 0n, change: 402_888_049n };
  __resetIntentsAttemptsForTests();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────
// F1 — stablecoin sources deposit the TOKEN, per the catalog
// ─────────────────────────────────────────────────────────────────────────

const intentsSources = getDropdownTickers({ sourceOnly: true, router: "intents" });
const evmSources = intentsSources.filter((t) => SWAP_COIN_META[t]?.chainKind === "EVM");
const stableByKey = new Map(STABLECOIN_NETWORKS.map((n) => [n.chain.toUpperCase(), n]));

describe("F1: every EVM source on the NEAR tab builds the right transfer (2026-09-29 send-safety audit)", () => {
  it("the NEAR-tab EVM source roster includes the stablecoin legs the audit named", () => {
    for (const leg of ["USDC-ETH", "USDT-BSC", "USDC-BSC", "USDC-ARB", "USDT0-POL", "USDC-MONAD"]) {
      expect(evmSources, leg).toContain(leg);
    }
  });

  for (const leg of evmSources) {
    const stable = stableByKey.get(leg);
    it(`${leg}: ${stable ? `ERC-20 transfer on ${stable.contract}` : "native transfer"}`, async () => {
      const meta = SWAP_COIN_META[leg];
      const amountIn = (100n * 10n ** BigInt(meta.decimals)).toString(); // 100 units
      const deposit = nextEvmDeposit();
      const r = await executeIntentsTrade(
        bound({ fromAsset: leg, amountIn, depositAddress: deposit, sourceAddress: USER_EVM }),
      );
      expect(r.sourceTxHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(S.signEvm).toHaveLength(1);
      const tx = S.signEvm[0];
      if (stable) {
        // The 2026-09-29 incident shape was `to = deposit, value = amountIn,
        // data = 0x` — 100 BNB for 100 USDT-BSC.
        expect(tx.to.toLowerCase()).toBe(stable.contract.toLowerCase());
        expect(BigInt(tx.value)).toBe(0n);
        const parsed = parseErc20TransferCalldata(tx.data);
        expect(parsed, "calldata must be transfer(address,uint256)").not.toBeNull();
        expect(parsed!.recipient).toBe(deposit.toLowerCase());
        expect(parsed!.amount).toBe(BigInt(amountIn));
      } else {
        expect(tx.to.toLowerCase()).toBe(deposit.toLowerCase());
        expect(BigInt(tx.value)).toBe(BigInt(amountIn));
        expect(tx.data).toBe("0x");
      }
    });
  }

  it("USDC-SOL and USDT-SOL deposit an SPL transfer of the catalog's mint; SOL a native transfer", async () => {
    for (const leg of ["USDC-SOL", "USDT-SOL", "SOL"]) {
      const amountIn = "250000000";
      await executeIntentsTrade(
        bound({
          fromAsset: leg,
          amountIn,
          depositAddress: `Dep${leg.replace(/-/g, "")}1111111111111111111111111111111`,
          sourceAddress: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
          fromBlockchain: defaultBlockchainFor(leg, { sourceOnly: true }) ?? undefined,
        }),
      );
    }
    // Before the fix all three went through the native SOL transfer: 250 USDC
    // (6 dp) left as 0.25 SOL.
    expect(S.spl.map((c) => c.mint)).toEqual([
      stableByKey.get("USDC-SOL")!.contract,
      stableByKey.get("USDT-SOL")!.contract,
    ]);
    expect(S.spl.every((c) => c.amountAtomic === "250000000")).toBe(true);
    expect(S.sol).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F2 — one quote, one signature; notify cannot fail a broadcast deposit
// ─────────────────────────────────────────────────────────────────────────

const ETH_AMOUNT = "5000000000000000"; // 0.005 ETH

describe("F2: a broadcast deposit is never reported as failed, and never signed twice (2026-09-29 send-safety audit)", () => {
  it("a relay error from notify AFTER the broadcast does not reject the call", async () => {
    S.notifyFails = true;
    const r = await executeIntentsTrade(
      bound({ fromAsset: "ETH", amountIn: ETH_AMOUNT, depositAddress: nextEvmDeposit(), sourceAddress: USER_EVM }),
    );
    // Before: `proxy returned 503` rejected the whole call, no hash returned.
    expect(r.sourceTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(S.broadcastRaw).toHaveLength(1);
    expect(proxy.notifyIntentsDeposit).toHaveBeenCalled();
  });

  it("hands the hash to onBroadcast BEFORE notifying 1Click", async () => {
    const seen: any[] = [];
    const deposit = nextEvmDeposit();
    await executeIntentsTrade(
      bound({
        fromAsset: "ETH",
        amountIn: ETH_AMOUNT,
        depositAddress: deposit,
        sourceAddress: USER_EVM,
        onBroadcast: (info: any) => {
          S.order.push("history");
          seen.push(info);
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].depositAddress).toBe(deposit);
    expect(seen[0].sourceTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(S.order).toEqual(["sign", "broadcast", "history", "notify"]);
  });

  it("refuses to sign a second deposit for the same quote", async () => {
    const args = bound({
      fromAsset: "ETH",
      amountIn: ETH_AMOUNT,
      depositAddress: nextEvmDeposit(),
      sourceAddress: USER_EVM,
    });
    await executeIntentsTrade(args);
    // Before: a Retry re-ran the whole flow with a fresh nonce — a second
    // signed deposit to the same address.
    await expect(executeIntentsTrade(args)).rejects.toBeInstanceOf(IntentsQuoteAlreadyUsedError);
    expect(S.signEvm).toHaveLength(1);
    expect(S.broadcastRaw).toHaveLength(1);
  });

  it("an RPC that accepted the bytes and then could not show them is an UNKNOWN outcome, with the hash", async () => {
    S.broadcastImpl = async () => {
      throw new Error(
        "RPC returned 0: All 2 EVM RPCs failed broadcast or verification\n" +
          "  https://a.example (verify): broadcast accepted hash 0xabc but eth_getTransactionByHash returned null on the same node — the submission likely never reached the mempool\n" +
          "  https://b.example (broadcast): network error: operation timed out",
      );
    };
    // The follow-up lookup by hash finds nothing either.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: null }))));
    const err = await executeIntentsTrade(
      bound({ fromAsset: "ETH", amountIn: ETH_AMOUNT, depositAddress: nextEvmDeposit(), sourceAddress: USER_EVM }),
    ).catch((e) => e);
    // Before: an ordinary Error, which the modal showed as "Broadcast failed.
    // Retry" — and Retry signed a new transaction.
    expect(isSendOutcomeUnknown(err)).toBe(true);
    const { keccak256 } = await import("ethers");
    expect(err.hash).toBe(keccak256(S.broadcastRaw[0]));
  });

  it("finds a deposit the verified broadcast gave up on, by its hash", async () => {
    S.broadcastImpl = async () => {
      throw new Error(
        "RPC returned 0: All 1 EVM RPCs failed broadcast or verification\n" +
          "  https://a.example (verify): verification call failed: network error: timeout",
      );
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: { hash: "0x1" } }))),
    );
    const r = await executeIntentsTrade(
      bound({ fromAsset: "ETH", amountIn: ETH_AMOUNT, depositAddress: nextEvmDeposit(), sourceAddress: USER_EVM }),
    );
    const { keccak256 } = await import("ethers");
    expect(r.sourceTxHash).toBe(keccak256(S.broadcastRaw[0]));
  });

  it("a submission every RPC refused is an ordinary failure (nothing went out)", async () => {
    S.broadcastImpl = async () => {
      throw new Error(
        "RPC returned 0: All 2 EVM RPCs failed broadcast or verification\n" +
          '  https://a.example (broadcast): RPC error: {"code":-32000,"message":"insufficient funds for gas * price + value"}\n' +
          "  https://b.example (broadcast): RPC returned 429: Too Many Requests",
      );
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: null }))));
    const err = await executeIntentsTrade(
      bound({ fromAsset: "ETH", amountIn: ETH_AMOUNT, depositAddress: nextEvmDeposit(), sourceAddress: USER_EVM }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(String(err.message)).toMatch(/not sent/);
  });

  it("a verified hash that disagrees with the signed bytes is UNKNOWN, not 'failed before broadcasting'", async () => {
    S.broadcastImpl = async () => ({ txHash: "0x" + "ee".repeat(32) });
    const err = await executeIntentsTrade(
      bound({ fromAsset: "ETH", amountIn: ETH_AMOUNT, depositAddress: nextEvmDeposit(), sourceAddress: USER_EVM }),
    ).catch((e) => e);
    // Before: SafetyInvariantError(VERIFIED_HASH_MISMATCH), shown under
    // "Safety check failed before broadcasting … No funds have moved".
    expect(err).not.toBeInstanceOf(SafetyInvariantError);
    expect(isSendOutcomeUnknown(err)).toBe(true);
    const { keccak256 } = await import("ethers");
    expect(err.hash).toBe(keccak256(S.broadcastRaw[0]));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F3 — a quote is signed only for the swap it was made for
// ─────────────────────────────────────────────────────────────────────────

describe("F3: a quote made for another pair or amount is refused before signing (2026-09-29 send-safety audit)", () => {
  it("the audit's scenario: form says BNB, quote was for ETH, same '0.5'", async () => {
    const half = (5n * 10n ** 17n).toString();
    const args = bound({ fromAsset: "BNB", amountIn: half, depositAddress: nextEvmDeposit(), sourceAddress: USER_EVM });
    // The quote's request: ETH, as fetched before the debounce caught up.
    args.quoteRequest.originAsset = SWAP_COIN_META.ETH.nearIntentsAsset!;
    const err = await executeIntentsTrade(args).catch((e) => e);
    // Before: 0.5 BNB signed and sent on BSC to the ETH swap's deposit address.
    expect(err).toBeInstanceOf(IntentsQuoteMismatchError);
    expect(S.signEvm).toHaveLength(0);
  });

  it("refuses a different amount, recipient or refund address", async () => {
    for (const override of [
      { amount: "4000000000000000" },
      // A PLACEHOLDER address leaking into a real quote would pay a public seed.
      { recipient: "bc1qa0000000000000000000000000000000000000" },
      { refundTo: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
      { destinationAsset: "nep141:sol.omft.near" },
    ]) {
      const err = await executeIntentsTrade(
        bound({
          fromAsset: "ETH",
          amountIn: ETH_AMOUNT,
          depositAddress: nextEvmDeposit(),
          sourceAddress: USER_EVM,
          requestOverrides: override,
        }),
      ).catch((e) => e);
      expect(err, JSON.stringify(override)).toBeInstanceOf(IntentsQuoteMismatchError);
    }
    expect(S.signEvm).toHaveLength(0);
  });

  it("refuses when 1Click's echo of the request differs from what was sent", async () => {
    const args: any = bound({
      fromAsset: "ETH",
      amountIn: ETH_AMOUNT,
      depositAddress: nextEvmDeposit(),
      sourceAddress: USER_EVM,
    });
    args.quoteEcho = { ...args.quoteRequest, recipient: "bc1qevil0000000000000000000000000000000000" };
    const err = await executeIntentsTrade(args).catch((e) => e);
    expect(err).toBeInstanceOf(SafetyInvariantError);
    expect(err.invariant).toBe("QUOTE_ECHO_MISMATCH");
    expect(S.signEvm).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F4 — the deposit window
// ─────────────────────────────────────────────────────────────────────────

describe("F4: an expired or nearly-expired quote is refused before signing (2026-09-29 send-safety audit)", () => {
  it("refuses a quote whose deadline has passed", async () => {
    const err = await executeIntentsTrade(
      bound({
        fromAsset: "ETH",
        amountIn: ETH_AMOUNT,
        depositAddress: nextEvmDeposit(),
        sourceAddress: USER_EVM,
        deadline: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).catch((e) => e);
    // Before: the deadline was never read, and the deposit went out.
    expect(err).toBeInstanceOf(IntentsQuoteExpiredError);
    expect(S.signEvm).toHaveLength(0);
  });

  it("an ETH deposit needs 10 minutes of window left", async () => {
    const tight = await executeIntentsTrade(
      bound({
        fromAsset: "ETH",
        amountIn: ETH_AMOUNT,
        depositAddress: nextEvmDeposit(),
        sourceAddress: USER_EVM,
        deadline: inMinutes(8),
      }),
    ).catch((e) => e);
    expect(tight).toBeInstanceOf(IntentsQuoteExpiredError);
    await executeIntentsTrade(
      bound({
        fromAsset: "ETH",
        amountIn: ETH_AMOUNT,
        depositAddress: nextEvmDeposit(),
        sourceAddress: USER_EVM,
        deadline: inMinutes(12),
      }),
    );
    expect(S.signEvm).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F5 — INCOMPLETE_DEPOSIT is not terminal
// ─────────────────────────────────────────────────────────────────────────

describe("F5: INCOMPLETE_DEPOSIT keeps the swap followed (2026-09-29 send-safety audit)", () => {
  it("maps INCOMPLETE_DEPOSIT to pending, not failed", () => {
    expect(intentsStatusToHistory("INCOMPLETE_DEPOSIT")).toBe("pending");
    expect(intentsStatusToHistory("REFUNDED")).toBe("refunded");
  });

  it("polls past INCOMPLETE_DEPOSIT to the refund", async () => {
    const statuses = ["PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "INCOMPLETE_DEPOSIT", "REFUNDED"];
    vi.mocked(proxy.getIntentsStatus).mockImplementation(async () => ({
      status: statuses.shift() ?? "REFUNDED",
    }) as any);
    const terminal = await pollIntentsToTerminal({ depositAddress: "D", intervalMs: 1 });
    expect(terminal.status).toBe("REFUNDED");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F6 — XRP, TRX and USDT-TRON as sources
// ─────────────────────────────────────────────────────────────────────────

describe("F6: the TS-signed XRP / Tron sources reach their adapters (2026-09-29 send-safety audit)", () => {
  for (const [ticker, chainKey, source] of [
    ["XRP", "xrp", "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3"],
    ["TRX", "tron", "TPrkFhZ8LH8Mruco8vXyA496TaeFBrbmeU"],
    ["USDT-TRON", "usdt-tron", "TPrkFhZ8LH8Mruco8vXyA496TaeFBrbmeU"],
  ] as const) {
    it(`${ticker} → the ${chainKey} adapter, amount in display units`, async () => {
      const r = await executeIntentsTrade(
        bound({
          fromAsset: ticker,
          amountIn: "2500000",
          depositAddress: `DEP-${ticker}`,
          sourceAddress: source,
          // Exactly what the swap views pass: defaultBlockchainFor(...).
          fromBlockchain: defaultBlockchainFor(ticker, { sourceOnly: true }) ?? undefined,
          sourceSecret: { kind: "privateKey", value: "00".repeat(32) },
        }),
      );
      // Before: "No RPC URL configured for XRP/TRX/USDT-TRON", every time.
      expect(r.sourceTxHash).toBe(`${chainKey}-hash`);
      expect(S.adapterSends).toEqual([{ chain: chainKey, to: `DEP-${ticker}`, amount: "2.5" }]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// F7 — sources the executor cannot deposit from are not offered
// ─────────────────────────────────────────────────────────────────────────

describe("F7: the NEAR source roster offers only executable sources (2026-09-29 send-safety audit)", () => {
  // XLM and SUI were dropped here on 2026-09-29 because the executor had no
  // deposit path for either. They are back since 2026-09-30, with one each;
  // their deposits are driven through this same registry in
  // `xlmSuiIntentsSource.test.ts`.
  it("offers XLM and SUI (deposit paths since 2026-09-30) and DASH (account-wide, F10)", () => {
    expect(intentsSources).toContain("XLM");
    expect(intentsSources).toContain("SUI");
    expect(intentsSources).toContain("DASH");
    const dest = getDropdownTickers({ router: "intents" });
    expect(dest).toContain("XLM");
    expect(dest).toContain("SUI");
  });

  it("no offered source lands on the executor's refusal arm", async () => {
    // The arm that remains is XMR/ZEPH/ZANO's "out of scope". A roster entry
    // of those kinds would be offered and then refused after the password.
    for (const t of intentsSources) {
      expect(["XMR", "ZEPH", "ZANO"], t).not.toContain(SWAP_COIN_META[t]?.chainKind);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F10 — UTXO deposits spend the whole account (the live LTC incident)
// ─────────────────────────────────────────────────────────────────────────

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("F10: UTXO swap deposits spend the account like Send does (2026-09-29 live incident)", () => {
  it("LTC with an empty primary address and a funded change address deposits via sendFromAccount", async () => {
    // The operator's swap: 0.31324582 LTC → USDC-POL.
    const amountIn = decimalToBaseUnitsBigInt("0.31324582", 8).toString();
    expect(amountIn).toBe("31324582");
    const r = await executeIntentsTrade(
      bound({
        fromAsset: "LTC",
        amountIn,
        depositAddress: "ltc1qdeposit0000000000000000000000000000000",
        sourceAddress: PRIMARY_LTC,
        fromBlockchain: defaultBlockchainFor("LTC", { sourceOnly: true }) ?? undefined,
        sourceSecret: { kind: "mnemonic", value: MNEMONIC },
      }),
    );
    expect(r.sourceTxHash).toBe("litecoin-account-hash");
    expect(S.accountSends).toHaveLength(1);
    expect(S.accountSends[0]).toMatchObject({
      chain: "litecoin",
      mnemonic: MNEMONIC,
      to: "ltc1qdeposit0000000000000000000000000000000",
      amount: "0.31324582",
      fromAddress: PRIMARY_LTC,
      opts: { feeRate: 26 }, // the fast tier, rounded up
    });
    // Before: the single-address builder read the empty primary address and
    // threw "No UTXOs found at ltc1qty7… Did the funding tx confirm?".
    expect(S.utxoRust).toHaveLength(0);
  });

  it("never signs twice: the same quote is refused, and the adapter is called once", async () => {
    const args = bound({
      fromAsset: "LTC",
      amountIn: "31324582",
      depositAddress: "ltc1qdeposit1111111111111111111111111111111",
      sourceAddress: PRIMARY_LTC,
      sourceSecret: { kind: "mnemonic", value: MNEMONIC },
    });
    await executeIntentsTrade(args);
    await expect(executeIntentsTrade(args)).rejects.toBeInstanceOf(IntentsQuoteAlreadyUsedError);
    expect(S.accountSends).toHaveLength(1);
    expect(S.utxoRust).toHaveLength(0);
  });

  it("a failed account send is NOT retried through the single-address path", async () => {
    S.accountUtxos = { primary: 0n, change: 1_000n }; // not enough anywhere
    const err = await executeIntentsTrade(
      bound({
        fromAsset: "LTC",
        amountIn: "31324582",
        depositAddress: "ltc1qdeposit2222222222222222222222222222222",
        sourceAddress: PRIMARY_LTC,
        sourceSecret: { kind: "mnemonic", value: MNEMONIC },
      }),
    ).catch((e) => e);
    expect(String(err?.message)).toMatch(/insufficient funds across the account/);
    expect(S.utxoRust).toHaveLength(0);
  });

  it("BTC, DOGE, BCH and DASH take the same path", async () => {
    const cases: Array<[string, string]> = [
      ["BTC", "bitcoin"],
      ["DOGE", "dogecoin"],
      ["BCH", "bitcoin-cash"],
      ["DASH", "dash"],
    ];
    for (const [ticker] of cases) {
      await executeIntentsTrade(
        bound({
          fromAsset: ticker,
          amountIn: "100000000",
          depositAddress: `dep-${ticker}`,
          sourceAddress: `primary-${ticker}`,
          deadline: inMinutes(ticker === "BTC" ? 120 : 60),
          sourceSecret: { kind: "mnemonic", value: MNEMONIC },
        }),
      );
    }
    expect(S.accountSends.map((c) => [c.chain, c.amount])).toEqual(
      cases.map(([, chain]) => [chain, "1"]),
    );
    expect(S.utxoRust).toHaveLength(0);
  });

  it("falls back to the single-address path only when the account scan does not cover the wallet", async () => {
    S.supportsAccount = false;
    const err = await executeIntentsTrade(
      bound({
        fromAsset: "LTC",
        amountIn: "31324582",
        depositAddress: "ltc1qdeposit3333333333333333333333333333333",
        sourceAddress: PRIMARY_LTC,
        sourceSecret: { kind: "mnemonic", value: MNEMONIC },
      }),
    ).catch((e) => e);
    expect(S.accountSends).toHaveLength(0);
    expect(S.utxoRust).toHaveLength(1);
    expect(err).toBeInstanceOf(Error);
  });

  it("DASH without account send refuses before signing (it has no single-address path)", async () => {
    S.supportsAccount = false;
    const err = await executeIntentsTrade(
      bound({
        fromAsset: "DASH",
        amountIn: "100000000",
        depositAddress: "dep-dash-x",
        sourceAddress: "primary-dash",
        deadline: inMinutes(60),
        sourceSecret: { kind: "mnemonic", value: MNEMONIC },
      }),
    ).catch((e) => e);
    expect(String(err?.message)).toMatch(/Nothing was sent/);
    expect(S.accountSends).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// EXTRA — gas limit from eth_estimateGas
// ─────────────────────────────────────────────────────────────────────────

describe("EXTRA: the EVM deposit's gas limit comes from eth_estimateGas (2026-09-29 send-safety audit)", () => {
  it("uses the estimate plus 25 % (Arbitrum's native transfer estimates 21 595)", async () => {
    S.estimateGas = () => "0x545b"; // 21 595
    await executeIntentsTrade(
      bound({ fromAsset: "ETH", amountIn: ETH_AMOUNT, depositAddress: nextEvmDeposit(), sourceAddress: USER_EVM }),
    );
    // Before: a flat 21 000 — below what the chain asked for.
    expect(S.signEvm[0].gas).toBe(26_994);
  });

  it("estimates the exact token transfer, then falls back to the fixed limits when it cannot", async () => {
    const calls: any[] = [];
    S.estimateGas = (call) => {
      calls.push(call);
      return "0xc350"; // 50 000
    };
    const deposit = nextEvmDeposit();
    await executeIntentsTrade(
      bound({ fromAsset: "USDC-ARB", amountIn: "100000000", depositAddress: deposit, sourceAddress: USER_EVM }),
    );
    expect(calls[0].to.toLowerCase()).toBe(stableByKey.get("USDC-ARB")!.contract.toLowerCase());
    expect(parseErc20TransferCalldata(calls[0].data)!.recipient).toBe(deposit.toLowerCase());
    expect(S.signEvm[0].gas).toBe(62_500);

    S.estimateGas = null; // estimation unavailable
    await executeIntentsTrade(
      bound({ fromAsset: "USDC-ARB", amountIn: "100000000", depositAddress: nextEvmDeposit(), sourceAddress: USER_EVM }),
    );
    await executeIntentsTrade(
      bound({ fromAsset: "ETH", amountIn: ETH_AMOUNT, depositAddress: nextEvmDeposit(), sourceAddress: USER_EVM }),
    );
    expect(S.signEvm[1].gas).toBe(100_000);
    expect(S.signEvm[2].gas).toBe(21_000);
  });
});
