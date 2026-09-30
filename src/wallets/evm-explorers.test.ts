/**
 * Every EVM adapter reads history from its OWN chain's explorer (2026-09-29
 * send-safety audit, finding M4).
 *
 * `usdt-op`, `usdc-arb`, `usdc-op` and `usdt0-arb` were configured with
 * `ETH_EXPLORERS`, so their `tokentx` history was asked of Ethereum's
 * Blockscout, which has never heard of an Optimism or Arbitrum transfer: a
 * send from any of them never appeared in Activity. A copy-paste slip in a
 * config literal has no other symptom, so this test reads the literals.
 *
 * Parsed from source rather than imported, as `evm-gas.test.ts` does:
 * importing `eth-wallet.ts` constructs every adapter, and this only needs two
 * fields from each.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The explorer list that serves each chain id in `eth-wallet.ts`. */
const EXPLORERS_FOR: Record<number, string> = {
  1: "ETH_EXPLORERS",
  10: "OP_EXPLORERS",
  14: "FLARE_EXPLORERS",
  56: "BSC_EXPLORERS",
  137: "POLYGON_EXPLORERS",
  143: "MONAD_EXPLORERS",
  8453: "BASE_EXPLORERS",
  42161: "ARB_EXPLORERS",
  43114: "AVAX_EXPLORERS",
};

const src = readFileSync(resolve(__dirname, "eth-wallet.ts"), "utf8").replace(/\r\n/g, "\n");
const adapters = [...src.matchAll(/createEvmAdapter\(\{([\s\S]*?)\n\}\);/g)].map((m) => ({
  chain: /chain:\s*"([^"]+)"/.exec(m[1])?.[1] ?? "?",
  chainId: Number(/chainId:\s*(\d+)/.exec(m[1])?.[1]),
  explorers: /explorerApis:\s*(\w+)/.exec(m[1])?.[1] ?? null,
}));

describe("M4 (2026-09-29 send-safety audit): token history reads its own chain's explorer", () => {
  it("parses the adapter list at all", () => {
    // Guards the parser: a regex matching nothing would pass everything below.
    expect(adapters.length).toBeGreaterThan(20);
    expect(adapters.some((a) => a.chain === "usdc-arb")).toBe(true);
  });

  it("every adapter uses the explorer of its own chain", () => {
    const wrong = adapters
      .filter((a) => a.explorers !== EXPLORERS_FOR[a.chainId])
      .map((a) => `${a.chain} (chain ${a.chainId}) reads ${a.explorers}`);
    expect(wrong).toEqual([]);
  });
});
