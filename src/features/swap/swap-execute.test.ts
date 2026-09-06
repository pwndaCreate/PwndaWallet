/**
 * Hard-stop tests for the SwapKit broadcast guard.
 *
 * The contract this file enforces:
 *   When a SwapKit route carries the mock-server UUID (or
 *   `VITE_SWAPKIT_LIVE` is false), `executeSwapKitTrade` MUST throw
 *   `MockSwapAttemptedError` AFTER the sign step succeeds and BEFORE
 *   any chain-RPC call is attempted.
 *
 * Why test this with mocks rather than e2e: the production deps
 * (`buildSwapKitTx`, `signEvm`, `broadcastTx`) call into Tauri's IPC,
 * which only exists inside the Tauri webview at runtime. We mock at
 * the module boundary so the test runs in plain Node and asserts the
 * call ordering directly — particularly that `broadcastTx` is *never*
 * invoked when mock mode is active.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { MOCK_SWAPKIT_ROUTE_ID } from "./router-modes";

function keccak256TxHash(rawTxHex: string): string {
  const c = rawTxHex.startsWith("0x") ? rawTxHex.slice(2) : rawTxHex;
  const bytes = new Uint8Array(c.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return "0x" + Array.from(keccak_256(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Force the production "live" flag on for SwapKit so that the *only*
// reason the test sees mock mode is the UUID heuristic. This proves the
// "defence in depth" claim: even with the env saying live, the UUID
// alone forces the guard to fire.
vi.stubEnv("VITE_SWAPKIT_LIVE", "true");
vi.stubEnv("VITE_INTENTS_LIVE", "true");

// ── Mock the Tauri-side I/O boundary BEFORE the SUT module loads. ──
// `vi.mock` is hoisted by Vitest so these run before the import below.
vi.mock("../../api/proxy", () => ({
  buildSwapKitTx: vi.fn(),
  trackSwapKitSwap: vi.fn(),
  notifyIntentsDeposit: vi.fn(),
  getIntentsStatus: vi.fn(),
}));
vi.mock("../../api/swap-rust", () => ({
  signEvm: vi.fn(),
  signPsbt: vi.fn(),
  broadcastTx: vi.fn(),
  // Verified-broadcast helper added 2026-05-06 for the P0 fake-success
  // bug. The default impl throws — individual tests opt in to a
  // resolved value by `mockResolvedValueOnce` when they need success.
  broadcastEvmVerified: vi.fn(),
  getNearAddress: vi.fn(),
  getSolanaAddress: vi.fn(),
  getUtxoAddress: vi.fn(),
}));
// `swap-data` pulls in `../../wallets`, which loads the full chain
// adapter set (ethers, tiny-secp256k1 wasm, etc.) — none of which the
// SUT actually needs at runtime here. Stub it down to the SWAP_COIN_META
// fields executeSwapKitTrade reads for ETH.
vi.mock("./swap-data", () => ({
  SWAP_COIN_META: {
    ETH: {
      ticker: "ETH",
      chainKind: "EVM",
      swapKitAsset: "ETH.ETH",
      evmChainId: 1,
      decimals: 18,
      defaultRpcUrl: "https://example.invalid/rpc",
      explorerTxUrl: (h: string) => `https://etherscan.io/tx/${h}`,
      explorerAddressUrl: (a: string) => `https://etherscan.io/address/${a}`,
    },
  },
  broadcastChainKind: (k: string) => k,
}));

// SUT comes after the mocks so the mocks are applied to its imports.
const { executeSwapKitTrade, MockSwapAttemptedError } = await import(
  "./swap-execute"
);
const { buildSwapKitTx } = await import("../../api/proxy");
const { signEvm, broadcastTx, broadcastEvmVerified } = await import(
  "../../api/swap-rust"
);

const MOCK_DEST = "0x0000000000000000000000000000000000000002";

/**
 * Encode a minimal RLP item — bytes-only support, sufficient for legacy
 * EVM tx fields. Numbers are pre-converted to byte arrays by the caller.
 */
function rlpEncodeBytes(b: Uint8Array): Uint8Array {
  if (b.length === 1 && b[0] < 0x80) return b;
  if (b.length < 56) {
    const out = new Uint8Array(b.length + 1);
    out[0] = 0x80 + b.length;
    out.set(b, 1);
    return out;
  }
  // long-bytes path is unused for our small fixture values.
  throw new Error("RLP encoder fixture: long-bytes not supported");
}

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const it of items) total += it.length;
  let header: Uint8Array;
  if (total < 56) {
    header = new Uint8Array([0xc0 + total]);
  } else if (total < 256) {
    header = new Uint8Array([0xf8, total]);
  } else if (total < 65536) {
    header = new Uint8Array([0xf9, (total >> 8) & 0xff, total & 0xff]);
  } else {
    throw new Error("RLP encoder fixture: list >= 64 KB not supported");
  }
  const out = new Uint8Array(header.length + total);
  out.set(header, 0);
  let off = header.length;
  for (const it of items) {
    out.set(it, off);
    off += it.length;
  }
  return out;
}

function bigintToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  const padded = hex.length % 2 === 0 ? hex : "0" + hex;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hexToBytesFixture(hex: string): Uint8Array {
  const c = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHexFixture(b: Uint8Array): string {
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a synthetic but RLP-VALID signed legacy EVM tx with a given
 * recipient + value. The signature fields are placeholders (v=27, r=1,
 * s=1); the safety-invariant decoder only inspects to/value, so the
 * signature is irrelevant for our test fixtures.
 */
function makeSignedLegacyTx(opts: { to: string; valueHex: string }): string {
  const fields = [
    bigintToBytes(0n), // nonce
    bigintToBytes(1n), // gasPrice
    bigintToBytes(21000n), // gasLimit
    hexToBytesFixture(opts.to), // to
    bigintToBytes(BigInt(opts.valueHex)), // value
    new Uint8Array(0), // data
    bigintToBytes(27n), // v
    bigintToBytes(1n), // r
    bigintToBytes(1n), // s
  ].map(rlpEncodeBytes);
  return bytesToHexFixture(rlpEncodeList(fields));
}

const SIGNED_PAYLOAD = makeSignedLegacyTx({
  to: MOCK_DEST,
  valueHex: "0xb1a2bc2ec50000", // 0.05 ETH — matches buildSwapKitTx mock
});

beforeEach(() => {
  vi.clearAllMocks();
  // SwapKit's /swap step always succeeds and returns a synthetic EVM tx
  // pointed at the mock destination. The mock UUID lives on the *route*,
  // not the built tx, so this body is intentionally innocuous.
  vi.mocked(buildSwapKitTx).mockResolvedValue({
    meta: { txType: "EVM" },
    transaction: {
      chainId: 1,
      to: MOCK_DEST,
      value: "0xb1a2bc2ec50000", // 0.05 ETH in wei (the burn-test scenario)
      gas: 21000,
      gasPrice: "0x1",
      nonce: "0x0",
    },
  } as any);
  // signEvm returns the synthetic raw tx — the sign path always succeeds.
  vi.mocked(signEvm).mockResolvedValue({ rawTx: SIGNED_PAYLOAD });
  // broadcastTx, if ever called, would throw loudly. The mock-mode
  // tests assert it is NEVER called. Tests that exercise the live
  // broadcast path opt-in to a resolved value via mockResolvedValueOnce.
  vi.mocked(broadcastTx).mockImplementation(async () => {
    throw new Error("broadcastTx must not be called in mock mode");
  });
  // Same for the verified-broadcast helper. Tests that want to
  // simulate "RPC accepted + verified" set this to a resolved value.
  // The mock-mode tests assert it is NEVER called, so the default
  // throw doubles as a guard.
  vi.mocked(broadcastEvmVerified).mockImplementation(async () => {
    throw new Error("broadcastEvmVerified must not be called in mock mode");
  });
});

const baseInput = {
  sessionId: "deadbeef",
  fromAsset: "ETH",
  sourceAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  destinationAddress: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  broadcastRpcUrl: "https://example.invalid/rpc",
};

describe("executeSwapKitTrade — mock-mode hard-stop", () => {
  it(
    "throws MockSwapAttemptedError before broadcast when the route id is the mock UUID",
    async () => {
      const route = {
        routeId: MOCK_SWAPKIT_ROUTE_ID,
        providers: ["MOCK_THORCHAIN"],
        expectedBuyAmount: "1.234",
      } as any;

      let caught: unknown = null;
      try {
        await executeSwapKitTrade({ ...baseInput, route });
      } catch (e) {
        caught = e;
      }

      // Typed error
      expect(caught).toBeInstanceOf(MockSwapAttemptedError);
      const err = caught as InstanceType<typeof MockSwapAttemptedError>;
      expect(err.reason).toBe("MOCK_UUID_DETECTED");
      expect(err.signedTxHex).toBe(SIGNED_PAYLOAD);
      expect(err.destinationAddress).toBe(MOCK_DEST);
      expect(err.chainKind).toBe("EVM");
      expect(err.message).toMatch(/Mock routing is enabled/);

      // Sign DID happen — signed payload is in the error.
      expect(signEvm).toHaveBeenCalledTimes(1);

      // Broadcast did NOT happen — this is the load-bearing assertion.
      expect(broadcastTx).not.toHaveBeenCalled();
      expect(broadcastEvmVerified).not.toHaveBeenCalled();
    }
  );

  it(
    "throws MockSwapAttemptedError when the env flag says mock, even with a non-mock UUID",
    async () => {
      // Re-stub env mid-test: SwapKit live = false. The route is otherwise
      // a perfectly normal one — the env flag alone should force the guard.
      vi.stubEnv("VITE_SWAPKIT_LIVE", "false");

      // The env stub above only takes effect for fresh imports of
      // `router-modes.ts` (which reads `import.meta.env` at module-load
      // time). Re-import everything in an isolated module graph.
      vi.resetModules();
      vi.stubEnv("VITE_SWAPKIT_LIVE", "false");
      vi.stubEnv("VITE_INTENTS_LIVE", "true");
      vi.doMock("../../api/proxy", () => ({
        buildSwapKitTx: vi.fn().mockResolvedValue({
          meta: { txType: "EVM" },
          transaction: {
            chainId: 1,
            to: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
            value: "0x1",
            gas: 21000,
            gasPrice: "0x1",
            nonce: "0x0",
          },
        }),
      }));
      vi.doMock("../../api/swap-rust", () => ({
        signEvm: vi.fn().mockResolvedValue({ rawTx: SIGNED_PAYLOAD }),
        signPsbt: vi.fn(),
        broadcastTx: vi.fn().mockImplementation(async () => {
          throw new Error("broadcastTx must not be called in mock mode");
        }),
      }));
      vi.doMock("./swap-data", () => ({
        SWAP_COIN_META: {
          ETH: {
            ticker: "ETH",
            chainKind: "EVM",
            swapKitAsset: "ETH.ETH",
            evmChainId: 1,
            decimals: 18,
            defaultRpcUrl: "https://example.invalid/rpc",
            explorerTxUrl: (h: string) => h,
            explorerAddressUrl: (a: string) => a,
          },
        },
        broadcastChainKind: (k: string) => k,
      }));

      const isolated = await import("./swap-execute");
      const isolatedSwapRust = await import("../../api/swap-rust");

      // A non-mock UUID — the only thing forcing mock here is the env flag.
      const route = {
        routeId: "11111111-2222-3333-4444-555555555555",
        providers: ["THORCHAIN"],
        expectedBuyAmount: "1.0",
      } as any;

      let caught: unknown = null;
      try {
        await isolated.executeSwapKitTrade({ ...baseInput, route });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(isolated.MockSwapAttemptedError);
      const err = caught as InstanceType<typeof isolated.MockSwapAttemptedError>;
      expect(err.reason).toBe("ENV_FLAG_MOCK");
      expect(isolatedSwapRust.broadcastTx).not.toHaveBeenCalled();

      vi.unstubAllEnvs();
    }
  );

  it(
    "is catchable by `instanceof` — important so the modal can branch on it",
    async () => {
      const route = {
        routeId: MOCK_SWAPKIT_ROUTE_ID,
        providers: [],
        expectedBuyAmount: "1.0",
      } as any;

      let asTyped: InstanceType<typeof MockSwapAttemptedError> | null = null;
      try {
        await executeSwapKitTrade({ ...baseInput, route });
      } catch (e) {
        if (e instanceof MockSwapAttemptedError) asTyped = e;
      }
      expect(asTyped).not.toBeNull();
      expect(asTyped!.signedTxHex.length).toBeGreaterThan(0);
    }
  );
});

describe("executeIntentsTrade — deposit tx value bounds (P0 5-sextillion fix)", () => {
  // Three regressions. The bug: `decimalToBaseUnits(amountIn, 18)` was
  // applied to `amountIn` even though 1Click returns it in atomic units
  // already. A 0.005 ETH swap (`amountIn = "5000000000000000"` wei)
  // re-converted to ~5 × 10^33 wei. The verified-broadcast layer
  // caught it before the user broadcast it, but the value should
  // never have been wrong in the first place.

  const ETH_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const BTC_ADDR = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
  // 0.00847 ETH (the user's actual balance during the bug repro), in wei.
  const BALANCE_WEI = "0x1e1cdb31e90000"; // 8472000000000000 wei
  // 0.005 ETH = 5e15 wei.
  const AMOUNT_IN_WEI = "5000000000000000";
  // Expected `value` field on the unsigned tx — the wei BigInt of the
  // atomic-units string, NOT a re-conversion through ×10^18.
  const EXPECTED_VALUE_HEX = "0x" + BigInt(AMOUNT_IN_WEI).toString(16);

  function makeMockChainRpcs(jsonRpcMockImpl: (
    urls: string[],
    method: string,
    params?: unknown[],
  ) => Promise<string>) {
    return {
      RPC_DEFAULTS: {
        ETH: {
          label: "Ethereum",
          probe: "evm" as const,
          envVar: "VITE_ETH_RPC_URL",
          defaults: ["https://example.invalid/rpc"],
        },
      },
      ETH_RPCS: () => ["https://example.invalid/rpc"],
      tryRpcUrls: vi.fn(),
      jsonRpcCall: vi.fn(jsonRpcMockImpl),
      probeRpcList: vi.fn(),
      probeChain: vi.fn(),
      AllRpcsFailedError: class extends Error {},
      rpcsFor: () => ["https://example.invalid/rpc"],
      warnChainOnce: vi.fn(),
    };
  }

  it("uses quote.amountIn directly as the tx value — no ×10^18 re-conversion", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_INTENTS_LIVE", "true");
    let capturedUnsignedTx: any = null;

    vi.doMock("../../api/proxy", () => ({
      buildSwapKitTx: vi.fn(),
      trackSwapKitSwap: vi.fn(),
      notifyIntentsDeposit: vi.fn(),
      getIntentsStatus: vi.fn(),
    }));
    vi.doMock("../../api/swap-rust", () => ({
      signEvm: vi.fn(async (_sid: string, tx: any) => {
        capturedUnsignedTx = tx;
        // Echo the captured tx into a real RLP-encoded signed legacy
        // tx so the post-sign safety invariant can decode it.
        const rawTx = makeSignedLegacyTx({ to: tx.to, valueHex: tx.value });
        return { rawTx };
      }),
      signPsbt: vi.fn(),
      broadcastTx: vi.fn(),
      broadcastEvmVerified: vi.fn(async (_urls: string[], rawTx: string) => ({
        // Use keccak256(signed) so the verified-hash invariant passes.
        txHash: keccak256TxHash(rawTx),
        urlUsed: "https://example.invalid/rpc",
        attempts: [],
      })),
      getNearAddress: vi.fn(),
      getSolanaAddress: vi.fn(),
      getUtxoAddress: vi.fn(),
    }));
    vi.doMock("./swap-data", () => ({
      SWAP_COIN_META: {
        ETH: {
          ticker: "ETH",
          chainKind: "EVM",
          swapKitAsset: "ETH.ETH",
          nearIntentsAsset: "nep141:eth.omft.near",
          evmChainId: 1,
          decimals: 18,
          defaultRpcUrl: "https://example.invalid/rpc",
          rpcFallbacks: ["https://example.invalid/rpc"],
          explorerTxUrl: (h: string) => h,
          explorerAddressUrl: (a: string) => a,
        },
      },
      broadcastChainKind: (k: string) => k,
    }));
    vi.doMock("../../wallets/chain-rpcs", () =>
      makeMockChainRpcs(async (_urls, method) => {
        if (method === "eth_gasPrice") return "0x174876e800"; // 100 gwei
        if (method === "eth_getBalance") return BALANCE_WEI;
        if (method === "eth_getTransactionCount") return "0x0";
        throw new Error(`unexpected method ${method}`);
      }),
    );
    vi.doMock("./swap-sources", () => ({
      executeNearNativeTransfer: vi.fn(),
      executeSolanaTransfer: vi.fn(),
      executeUtxoTransfer: vi.fn(),
      decimalToBaseUnitsBigInt: (s: string, d: number) =>
        BigInt(s.split(".")[0]) * 10n ** BigInt(d),
      atomicStringToBigInt: (s: string) => BigInt(s.split(".")[0]),
    }));

    const isolated = await import("./swap-execute");

    await isolated.executeIntentsTrade({
      sessionId: "deadbeef",
      fromAsset: "ETH",
      sourceAddress: ETH_ADDR,
      intentsQuote: {
        depositAddress: ETH_ADDR,
        amountIn: AMOUNT_IN_WEI,
      } as any,
      userIntendedAtomic: BigInt(AMOUNT_IN_WEI),
    });

    // The captured `unsignedTx.value` MUST be the wei BigInt hex of
    // the atomic-units `amountIn` — NOT the result of multiplying by
    // 10^18 (which would have produced 0x...sextillion).
    expect(capturedUnsignedTx).not.toBeNull();
    expect(capturedUnsignedTx.value).toBe(EXPECTED_VALUE_HEX);
    // Sanity: 0.005 ETH = 5e15 wei = 0x11c37937e08000.
    expect(capturedUnsignedTx.value).toBe("0x11c37937e08000");

    vi.unstubAllEnvs();
  });

  it("rejects tx with value > 2× user balance via InsufficientFundsValidationError", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_INTENTS_LIVE", "true");

    // Simulate the actual bug: amountIn already in wei but the value
    // ends up being absurdly large. We fake this by passing the
    // already-bloated value as if a future re-introduction of the
    // bug forced it through. (We can't easily simulate the bug
    // itself since the new code path doesn't have it.)
    const ABSURD_AMOUNT = "5000000000000000000002293657548000"; // ~5e33 wei

    vi.doMock("../../api/proxy", () => ({
      buildSwapKitTx: vi.fn(),
      trackSwapKitSwap: vi.fn(),
      notifyIntentsDeposit: vi.fn(),
      getIntentsStatus: vi.fn(),
    }));
    const broadcastEvmVerifiedMock = vi.fn();
    vi.doMock("../../api/swap-rust", () => ({
      signEvm: vi.fn().mockResolvedValue({ rawTx: SIGNED_PAYLOAD }),
      signPsbt: vi.fn(),
      broadcastTx: vi.fn(),
      broadcastEvmVerified: broadcastEvmVerifiedMock,
      getNearAddress: vi.fn(),
      getSolanaAddress: vi.fn(),
      getUtxoAddress: vi.fn(),
    }));
    vi.doMock("./swap-data", () => ({
      SWAP_COIN_META: {
        ETH: {
          ticker: "ETH",
          chainKind: "EVM",
          swapKitAsset: "ETH.ETH",
          nearIntentsAsset: "nep141:eth.omft.near",
          evmChainId: 1,
          decimals: 18,
          defaultRpcUrl: "https://example.invalid/rpc",
          rpcFallbacks: ["https://example.invalid/rpc"],
          explorerTxUrl: (h: string) => h,
          explorerAddressUrl: (a: string) => a,
        },
      },
      broadcastChainKind: (k: string) => k,
    }));
    vi.doMock("../../wallets/chain-rpcs", () =>
      makeMockChainRpcs(async (_urls, method) => {
        if (method === "eth_gasPrice") return "0x1"; // 1 wei (negligible)
        if (method === "eth_getBalance") return BALANCE_WEI; // 8.47e15 wei
        if (method === "eth_getTransactionCount") return "0x0";
        throw new Error(`unexpected method ${method}`);
      }),
    );
    vi.doMock("./swap-sources", () => ({
      executeNearNativeTransfer: vi.fn(),
      executeSolanaTransfer: vi.fn(),
      executeUtxoTransfer: vi.fn(),
      decimalToBaseUnitsBigInt: (s: string, d: number) =>
        BigInt(s.split(".")[0]) * 10n ** BigInt(d),
      atomicStringToBigInt: (s: string) => BigInt(s.split(".")[0]),
    }));

    const isolated = await import("./swap-execute");

    let caught: unknown = null;
    try {
      await isolated.executeIntentsTrade({
        sessionId: "deadbeef",
        fromAsset: "ETH",
        sourceAddress: ETH_ADDR,
        intentsQuote: {
          depositAddress: ETH_ADDR,
          amountIn: ABSURD_AMOUNT,
        } as any,
        // User intended 0.005 ETH = 5e15 wei. The quote's amountIn is
        // ABSURD (5e33), so the SafetyInvariant layer's first guard
        // fires and refuses to proceed.
        userIntendedAtomic: BigInt(AMOUNT_IN_WEI),
      });
    } catch (e) {
      caught = e;
    }

    // The first invariant to fire is QUOTE_AMOUNT_VS_USER_INTENT —
    // the quote-vs-user comparison runs BEFORE the balance fetch, so
    // a quote with a 10^18× drift never even reaches the balance gate.
    expect(caught).toBeInstanceOf(isolated.SafetyInvariantError);
    const err = caught as InstanceType<typeof isolated.SafetyInvariantError>;
    expect(err.invariant).toBe("QUOTE_AMOUNT_VS_USER_INTENT");
    expect(err.context.quoteAmountAtomic).toBe(ABSURD_AMOUNT);
    expect(err.context.userIntendedAtomic).toBe(AMOUNT_IN_WEI);

    // Critical: broadcast was NEVER attempted.
    expect(broadcastEvmVerifiedMock).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it("refreshes nonce on every executeIntentsTrade attempt — fetched immediately before signing", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_INTENTS_LIVE", "true");

    let nonceCallCount = 0;
    vi.doMock("../../api/proxy", () => ({
      buildSwapKitTx: vi.fn(),
      trackSwapKitSwap: vi.fn(),
      notifyIntentsDeposit: vi.fn(),
      getIntentsStatus: vi.fn(),
    }));
    vi.doMock("../../api/swap-rust", () => ({
      signEvm: vi.fn(async (_sid: string, tx: any) => ({
        rawTx: makeSignedLegacyTx({ to: tx.to, valueHex: tx.value }),
      })),
      signPsbt: vi.fn(),
      broadcastTx: vi.fn(),
      broadcastEvmVerified: vi.fn(async (_urls: string[], rawTx: string) => ({
        txHash: keccak256TxHash(rawTx),
        urlUsed: "https://example.invalid/rpc",
        attempts: [],
      })),
      getNearAddress: vi.fn(),
      getSolanaAddress: vi.fn(),
      getUtxoAddress: vi.fn(),
    }));
    vi.doMock("./swap-data", () => ({
      SWAP_COIN_META: {
        ETH: {
          ticker: "ETH",
          chainKind: "EVM",
          swapKitAsset: "ETH.ETH",
          nearIntentsAsset: "nep141:eth.omft.near",
          evmChainId: 1,
          decimals: 18,
          defaultRpcUrl: "https://example.invalid/rpc",
          rpcFallbacks: ["https://example.invalid/rpc"],
          explorerTxUrl: (h: string) => h,
          explorerAddressUrl: (a: string) => a,
        },
      },
      broadcastChainKind: (k: string) => k,
    }));
    vi.doMock("../../wallets/chain-rpcs", () =>
      makeMockChainRpcs(async (_urls, method) => {
        if (method === "eth_gasPrice") return "0x1";
        if (method === "eth_getBalance") return BALANCE_WEI;
        if (method === "eth_getTransactionCount") {
          nonceCallCount += 1;
          return "0x" + nonceCallCount.toString(16);
        }
        throw new Error(`unexpected method ${method}`);
      }),
    );
    vi.doMock("./swap-sources", () => ({
      executeNearNativeTransfer: vi.fn(),
      executeSolanaTransfer: vi.fn(),
      executeUtxoTransfer: vi.fn(),
      decimalToBaseUnitsBigInt: (s: string, d: number) =>
        BigInt(s.split(".")[0]) * 10n ** BigInt(d),
      atomicStringToBigInt: (s: string) => BigInt(s.split(".")[0]),
    }));

    const isolated = await import("./swap-execute");

    const baseArgs = {
      sessionId: "deadbeef",
      fromAsset: "ETH",
      sourceAddress: ETH_ADDR,
      intentsQuote: {
        depositAddress: ETH_ADDR,
        amountIn: AMOUNT_IN_WEI,
      } as any,
      userIntendedAtomic: BigInt(AMOUNT_IN_WEI),
    };

    // First call.
    await isolated.executeIntentsTrade(baseArgs);
    expect(nonceCallCount).toBe(1);

    // Retry — must re-read nonce, not cache.
    await isolated.executeIntentsTrade(baseArgs);
    expect(nonceCallCount).toBe(2);

    // Third attempt — same.
    await isolated.executeIntentsTrade(baseArgs);
    expect(nonceCallCount).toBe(3);

    vi.unstubAllEnvs();
  });
});

describe("executeSwapKitTrade — verified broadcast (P0 fake-success fix)", () => {
  // Live SwapKit mode + a non-mock route id, so `executeSwapKitTrade`
  // reaches the verified-broadcast call instead of the mock-mode
  // hard-stop. This is the path the user clicked through on
  // 2026-05-06 — sign succeeded but the broadcast 429'd; the wallet
  // displayed a hash that never reached the network. The regression
  // test enforces:
  //   1. When verified-broadcast throws, executeSwapKitTrade throws.
  //   2. No tx hash is "leaked" out of the function.
  //   3. The mock is called exactly once (no silent retry-and-show).
  //
  // We isolate the module graph because the prior describe() block's
  // `vi.unstubAllEnvs()` clears the top-level `VITE_SWAPKIT_LIVE`
  // stub, and `router-modes.ts` reads that env at module-load time
  // — so a fresh import is the only way to evaluate it as `true`
  // for these tests.

  const liveRoute = {
    routeId: "11111111-2222-3333-4444-555555555555",
    providers: ["THORCHAIN"],
    expectedBuyAmount: "1.0",
  } as const;

  it(
    "throws when broadcastEvmVerified throws — no fake hash returned",
    async () => {
      vi.resetModules();
      vi.stubEnv("VITE_SWAPKIT_LIVE", "true");
      vi.stubEnv("VITE_INTENTS_LIVE", "true");
      vi.doMock("../../api/proxy", () => ({
        buildSwapKitTx: vi.fn().mockResolvedValue({
          meta: { txType: "EVM" },
          transaction: {
            chainId: 1,
            to: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
            value: "0x1",
            gas: 21000,
            gasPrice: "0x1",
            nonce: "0x0",
          },
        }),
        trackSwapKitSwap: vi.fn(),
        notifyIntentsDeposit: vi.fn(),
        getIntentsStatus: vi.fn(),
      }));
      vi.doMock("../../api/swap-rust", () => ({
        signEvm: vi.fn().mockResolvedValue({ rawTx: SIGNED_PAYLOAD }),
        signPsbt: vi.fn(),
        broadcastTx: vi.fn().mockImplementation(async () => {
          throw new Error("broadcastTx must not be called for EVM after the P0 fix");
        }),
        // Simulate the real-world failure: every RPC in the fallback
        // list 429'd, Rust's evm_broadcast_verified returns the typed
        // multi-line audit-trail error.
        broadcastEvmVerified: vi.fn().mockRejectedValueOnce(
          new Error(
            "All 4 EVM RPCs failed broadcast or verification\n" +
              "  https://eth.llamarpc.com (broadcast): RPC returned 429: Too Many Requests\n" +
              "  https://eth.drpc.org (broadcast): RPC returned 429: Too Many Requests\n" +
              "  https://rpc.ankr.com/eth (broadcast): RPC returned 429: Too Many Requests\n" +
              "  https://ethereum-rpc.publicnode.com (broadcast): RPC returned 429: Too Many Requests",
          ),
        ),
        getNearAddress: vi.fn(),
        getSolanaAddress: vi.fn(),
        getUtxoAddress: vi.fn(),
      }));
      vi.doMock("./swap-data", () => ({
        SWAP_COIN_META: {
          ETH: {
            ticker: "ETH",
            chainKind: "EVM",
            swapKitAsset: "ETH.ETH",
            evmChainId: 1,
            decimals: 18,
            defaultRpcUrl: "https://example.invalid/rpc",
            rpcFallbacks: ["https://example.invalid/rpc"],
            explorerTxUrl: (h: string) => `https://etherscan.io/tx/${h}`,
            explorerAddressUrl: (a: string) => `https://etherscan.io/address/${a}`,
          },
        },
        broadcastChainKind: (k: string) => k,
      }));

      const isolated = await import("./swap-execute");
      const isolatedSwapRust = await import("../../api/swap-rust");

      let result: { sourceTxHash?: string } | null = null;
      let caught: unknown = null;
      try {
        result = await isolated.executeSwapKitTrade({
          ...baseInput,
          route: liveRoute as any,
        });
      } catch (e) {
        caught = e;
      }

      // Function MUST throw — not return.
      expect(caught).not.toBeNull();
      expect(result).toBeNull();
      expect(String((caught as Error).message)).toMatch(/All 4 EVM RPCs failed/);

      // Verified broadcast called exactly once. The legacy single-URL
      // `broadcastTx` MUST NOT be called for EVM — that was the path
      // that produced the fake-success bug.
      expect(isolatedSwapRust.broadcastEvmVerified).toHaveBeenCalledTimes(1);
      expect(isolatedSwapRust.broadcastTx).not.toHaveBeenCalled();

      vi.unstubAllEnvs();
    },
  );

  it(
    "returns the verified hash when broadcastEvmVerified succeeds",
    async () => {
      vi.resetModules();
      vi.stubEnv("VITE_SWAPKIT_LIVE", "true");
      vi.stubEnv("VITE_INTENTS_LIVE", "true");
      vi.doMock("../../api/proxy", () => ({
        buildSwapKitTx: vi.fn().mockResolvedValue({
          meta: { txType: "EVM" },
          transaction: {
            chainId: 1,
            to: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
            value: "0x1",
            gas: 21000,
            gasPrice: "0x1",
            nonce: "0x0",
          },
        }),
        trackSwapKitSwap: vi.fn(),
        notifyIntentsDeposit: vi.fn(),
        getIntentsStatus: vi.fn(),
      }));
      vi.doMock("../../api/swap-rust", () => ({
        signEvm: vi.fn().mockResolvedValue({ rawTx: SIGNED_PAYLOAD }),
        signPsbt: vi.fn(),
        broadcastTx: vi.fn(),
        broadcastEvmVerified: vi.fn().mockResolvedValueOnce({
          txHash:
            "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
          urlUsed: "https://eth.llamarpc.com",
          attempts: [],
        }),
        getNearAddress: vi.fn(),
        getSolanaAddress: vi.fn(),
        getUtxoAddress: vi.fn(),
      }));
      vi.doMock("./swap-data", () => ({
        SWAP_COIN_META: {
          ETH: {
            ticker: "ETH",
            chainKind: "EVM",
            swapKitAsset: "ETH.ETH",
            evmChainId: 1,
            decimals: 18,
            defaultRpcUrl: "https://example.invalid/rpc",
            rpcFallbacks: ["https://example.invalid/rpc"],
            explorerTxUrl: (h: string) => `https://etherscan.io/tx/${h}`,
            explorerAddressUrl: (a: string) => `https://etherscan.io/address/${a}`,
          },
        },
        broadcastChainKind: (k: string) => k,
      }));

      const isolated = await import("./swap-execute");
      const isolatedSwapRust = await import("../../api/swap-rust");

      const result = await isolated.executeSwapKitTrade({
        ...baseInput,
        route: liveRoute as any,
      });

      expect(result.sourceTxHash).toBe(
        "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
      );
      // The returned hash MUST be the one Rust verified, NOT the local
      // signing hash. The fixture uses a fresh deadbeef hash that
      // couldn't be derived from SIGNED_PAYLOAD.
      expect(result.sourceTxHash).not.toEqual(SIGNED_PAYLOAD);
      expect(isolatedSwapRust.broadcastEvmVerified).toHaveBeenCalledTimes(1);
      expect(isolatedSwapRust.broadcastTx).not.toHaveBeenCalled();

      vi.unstubAllEnvs();
    },
  );
});
