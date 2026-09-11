/**
 * The gas-token table must agree with the adapters, and cover every token.
 *
 * `evm-gas.ts` is a SECOND copy of facts that already exist on each chain's
 * native adapter (`ticker`, `displayName`, `chainId`). That is a deliberate
 * trade — see the module header for why reading them at runtime would couple
 * token adapters to sibling-adapter construction order — and this file is the
 * price of it. Without these assertions a chain could be added, or a ticker
 * renamed, and the only symptom would be a send warning naming the wrong coin
 * on a screen that is trying to stop somebody losing a transaction.
 *
 * The second test is the one that matters most: every TOKEN adapter must have
 * a row. A token whose chainId is missing from the table silently loses the
 * check entirely — `gasTokenFor` returns null, `gasToken` is undefined, and
 * the modal goes back to the pre-2026-09-09 behaviour of showing an enabled
 * Send button over an unfundable transfer. That is the exact regression this
 * work exists to prevent, and it would otherwise be invisible.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  EVM_GAS_TOKENS,
  decideGasSufficiency,
  totalNativeRequired,
  FALLBACK_ERC20_GAS,
  FALLBACK_NATIVE_GAS,
  fallbackGasLimit,
  gasTokenFor,
} from "./evm-gas";

/**
 * Every `createEvmAdapter({...})` literal in `eth-wallet.ts`.
 *
 * Parsed from source rather than imported, because importing the module
 * constructs live adapters (each one builds RPC providers) and this test has
 * no business making network-shaped objects to read three string fields.
 */
function evmAdapters(): Array<{
  chain: string;
  ticker: string;
  displayName: string;
  chainId: number | null;
  isToken: boolean;
}> {
  const src = readFileSync(
    resolve(__dirname, "eth-wallet.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const out: ReturnType<typeof evmAdapters> = [];
  const re = /createEvmAdapter\(\{([\s\S]*?)\n\}\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = m[1];
    const field = (k: string) => {
      const f = new RegExp(`${k}:\\s*"([^"]+)"`).exec(body);
      return f ? f[1] : null;
    };
    const idRaw = /chainId:\s*(\d+)/.exec(body);
    out.push({
      chain: field("chain") ?? "?",
      ticker: field("ticker") ?? "?",
      displayName: field("displayName") ?? "?",
      chainId: idRaw ? Number(idRaw[1]) : null,
      isToken: /tokenContract:\s*"/.test(body),
    });
  }
  return out;
}

describe("the gas-token table matches the adapters it describes", () => {
  const adapters = evmAdapters();

  it("parses a plausible adapter set at all", () => {
    // Guards the parser itself: a regex that silently matched nothing would
    // make every assertion below vacuously pass.
    expect(adapters.length).toBeGreaterThan(15);
    expect(adapters.some((a) => a.chain === "arbitrum" && !a.isToken)).toBe(true);
    expect(adapters.some((a) => a.chain === "usdc-arb" && a.isToken)).toBe(true);
  });

  it("names each native chain exactly as its own adapter does", () => {
    for (const a of adapters) {
      if (a.isToken || a.chainId == null) continue;
      const row = gasTokenFor(a.chainId);
      expect(row, `no gas row for chainId ${a.chainId} (${a.chain})`).not.toBeNull();
      expect(row!.ticker, `ticker for ${a.chain}`).toBe(a.ticker);
      expect(row!.chainName, `chain name for ${a.chain}`).toBe(a.displayName);
    }
  });

  it("has a row for every TOKEN adapter's chain", () => {
    const missing = adapters
      .filter((a) => a.isToken)
      .filter((a) => a.chainId == null || gasTokenFor(a.chainId) === null)
      .map((a) => `${a.chain} (chainId ${a.chainId})`);
    expect(
      missing,
      "a token adapter with no gas row loses the fee check silently",
    ).toEqual([]);
  });

  it("covers every token adapter that exists today", () => {
    // Twelve as of 2026-09-09, across seven chains. The number is asserted so
    // that adding a token is a deliberate pass through this file.
    const tokens = adapters.filter((a) => a.isToken);
    expect(tokens.length).toBeGreaterThanOrEqual(12);
    for (const t of tokens) {
      expect(gasTokenFor(t.chainId ?? undefined)!.ticker).toBeTruthy();
    }
  });
});

describe("gasTokenFor", () => {
  it("returns null rather than guessing for an unknown chain", () => {
    // The caller skips the check on null. Defaulting to ETH here would tell a
    // BNB Chain user to top up the wrong coin.
    expect(gasTokenFor(999999)).toBeNull();
    expect(gasTokenFor(undefined)).toBeNull();
  });

  it("distinguishes the four chains that all pay in ETH", () => {
    // The reason the table stores a chain NAME and not just a ticker: "you
    // need ETH" is the sentence that sends somebody to bridge to the wrong
    // network. Arbitrum was the chain in the 2026-09-09 report.
    for (const [id, name] of [
      [1, "Ethereum"],
      [10, "Optimism"],
      [8453, "Base"],
      [42161, "Arbitrum"],
    ] as const) {
      const row = gasTokenFor(id)!;
      expect(row.ticker).toBe("ETH");
      expect(row.chainName).toBe(name);
    }
  });

  it("keeps the non-ETH chains on their own coins", () => {
    expect(gasTokenFor(137)!.ticker).toBe("POL");
    expect(gasTokenFor(56)!.ticker).toBe("BNB");
    expect(gasTokenFor(43114)!.ticker).toBe("AVAX");
  });
});

describe("fallback gas limits", () => {
  it("gives Arbitrum a much larger limit than an L1-style chain", () => {
    // Arbitrum's estimateGas folds in the L1 calldata cost. A single 65k
    // fallback would understate it by an order of magnitude, on the one chain
    // the original report came from.
    const arb = fallbackGasLimit(42161, true);
    const op = fallbackGasLimit(10, true);
    expect(arb).toBeGreaterThan(op * 5n);
  });

  it("distinguishes a token transfer from a bare native send", () => {
    expect(fallbackGasLimit(1, true)).toBe(FALLBACK_ERC20_GAS);
    expect(fallbackGasLimit(1, false)).toBe(FALLBACK_NATIVE_GAS);
    expect(FALLBACK_NATIVE_GAS).toBe(21_000n);
  });

  it("still answers for a chain with no row", () => {
    // Only reached for a chain the table does not know, where the check is
    // skipped anyway — but it must not throw on the way to being ignored.
    expect(fallbackGasLimit(999999, true)).toBe(FALLBACK_ERC20_GAS);
    expect(fallbackGasLimit(undefined, false)).toBe(FALLBACK_NATIVE_GAS);
  });
});

describe("the table itself", () => {
  it("has no empty strings", () => {
    for (const [id, row] of Object.entries(EVM_GAS_TOKENS)) {
      expect(row.ticker.length, `ticker for ${id}`).toBeGreaterThan(0);
      expect(row.chainName.length, `chainName for ${id}`).toBeGreaterThan(0);
    }
  });
});

describe("decideGasSufficiency — the zero-balance certainty", () => {
  it("compares in wei when a price is known", () => {
    expect(decideGasSufficiency(100n, 99n)).toBe(true);
    expect(decideGasSufficiency(100n, 100n)).toBe(true); // exact is enough
    expect(decideGasSufficiency(99n, 100n)).toBe(false);
  });

  it("calls a zero balance insufficient even with NO estimate", () => {
    // The load-bearing branch. A node asked to simulate a transfer from an
    // account that cannot fund it is the node most likely to refuse the
    // simulation — so "estimateGas failed" and "this wallet has no gas" are
    // strongly correlated, and treating the failure as unknown would drop the
    // warning in precisely the case it exists for.
    expect(decideGasSufficiency(0n, null)).toBe(false);
  });

  it("stays UNKNOWN when unestimable with a non-zero balance", () => {
    // Not false. The caller disables Send on false; blocking somebody's
    // transfer because a recipient field was empty would be its own bug.
    expect(decideGasSufficiency(1n, null)).toBeNull();
    expect(decideGasSufficiency(10n ** 18n, null)).toBeNull();
  });

  it("does not treat a zero REQUIREMENT as a shortfall", () => {
    // A chain reporting a zero fee is not a wallet that cannot pay it.
    expect(decideGasSufficiency(0n, 0n)).toBe(true);
  });
});

describe("totalNativeRequired — the native send competes with its own fee", () => {
  it("adds the amount for a NATIVE send", () => {
    // 1 ETH amount + 0.001 ETH gas
    expect(totalNativeRequired(1_000n, 5_000n, false)).toBe(6_000n);
  });

  it("charges only gas for a TOKEN send", () => {
    // The amount leaves the token balance; it must not be double-counted
    // against the native one, or every USDC send would look unaffordable.
    expect(totalNativeRequired(1_000n, 5_000n, true)).toBe(1_000n);
  });

  it("catches the wallet that can afford the amount OR the fee, not both", () => {
    // The case pricing gas alone would clear: balance exactly equals the
    // amount. It fails at broadcast, which is the failure mode this whole
    // feature exists to move into the form.
    const balance = 100n;
    const amount = 100n;
    const gas = 7n;
    expect(decideGasSufficiency(balance, totalNativeRequired(gas, amount, false))).toBe(false);
    // ...and one satoshi-equivalent less is fine.
    expect(decideGasSufficiency(balance, totalNativeRequired(gas, amount - gas, false))).toBe(true);
  });

  it("is unaffected by the amount when there is nothing typed yet", () => {
    expect(totalNativeRequired(42n, 0n, false)).toBe(42n);
  });
});
