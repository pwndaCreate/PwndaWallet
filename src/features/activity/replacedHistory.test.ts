/**
 * After a BTC speed-up the history shows the replacement, not two pending
 * sends (operator request, 2026-10-01).
 *
 * The original and its replacement spend the same coins; the network keeps
 * one. The history did not notice: a routine poll merges a small page into
 * the rows it holds and KEEPS held rows the page does not list
 * (`mergeHistoryPage`), so the original's mempool row stayed beside the
 * replacement's until the next full read. These pin the fix in
 * `useTxHistory.ts`: rows of replaced transactions are dropped from what is
 * held the moment a replacement is recorded, and from every page read after.
 *
 * The hook itself needs React to run, which this repo's tests do not have;
 * its pure part (`prunedOfReplacements`) is tested directly, and its wiring
 * is pinned by reading the source, as `txDetails.test.ts` pins the layouts'.
 * Both fail on 6b4e160: no `prunedOfReplacements`, no wiring.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeChainTx, prunedOfReplacements } from "./useTxHistory";
import { mergeHistoryPage } from "./txHistorySchedule";
import { _clearTxReplacementsForTests, recordTxReplacement } from "../../wallets/tx-replacements";
import type { ChainTx } from "../../wallets/types";

const ORIGINAL = "0a".repeat(32);
const REPLACEMENT = "0b".repeat(32);
const ME = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const CHANGE = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";
const PEER = "bc1qe5xk329xk5tfz3ldvfqxqxahajdva5jl4jzcmy";

/** A per-address Esplora row of a pending 0.01 BTC send (`esploraTxToChainTx`'s shape). */
function pending(hash: string, address: string, netSat: number, feeSat: number): ChainTx {
  return {
    chain: "bitcoin",
    hash,
    direction: "pending",
    amount: (Math.abs(netSat) / 1e8).toFixed(8),
    fee: undefined,
    confirmations: 0,
    meta: { netSat, source: "esplora", inputs: [ME], outputs: [PEER, CHANGE], feeSat },
  };
}

beforeEach(() => _clearTxReplacementsForTests());

describe("the history after a speed-up", () => {
  it("before the fix's prune: a small-page merge keeps the original beside the replacement — two pending sends", () => {
    const held = [pending(ORIGINAL, ME, -2_000_000, 282)];
    // The next small page: the explorer has dropped the original.
    const page = [pending(REPLACEMENT, ME, -2_000_000, 1974)];
    const merged = mergeHistoryPage(held, page, 50);
    expect(merged.map((t) => t.hash).sort()).toEqual([ORIGINAL, REPLACEMENT].sort());
  });

  it("prunedOfReplacements drops the original from every list of its chain, and only returns lists that changed", () => {
    const lists: Record<string, ChainTx[]> = {
      [`bitcoin:${ME}`]: [pending(REPLACEMENT, ME, -2_000_000, 1974), pending(ORIGINAL, ME, -2_000_000, 282)],
      [`bitcoin:${CHANGE}`]: [pending(ORIGINAL, CHANGE, 999_718, 282)],
      [`bitcoin:${PEER}`]: [],
      [`litecoin:ltc1qx`]: [pending(ORIGINAL, "ltc1qx", -1, 1)],
    };
    expect(prunedOfReplacements(lists, "bitcoin")).toEqual({});
    recordTxReplacement({ chain: "bitcoin", replaced: ORIGINAL, by: REPLACEMENT });
    const changed = prunedOfReplacements(lists, "bitcoin");
    expect(Object.keys(changed).sort()).toEqual([`bitcoin:${CHANGE}`, `bitcoin:${ME}`].sort());
    expect(changed[`bitcoin:${ME}`].map((t) => t.hash)).toEqual([REPLACEMENT]);
    expect(changed[`bitcoin:${CHANGE}`]).toEqual([]);
    // The merged account history: one pending send, the replacement.
    const { txs } = mergeChainTx({ txByChain: { ...lists, ...changed } }, "bitcoin");
    expect(txs.map((t) => t.hash)).toEqual([REPLACEMENT]);
  });
});

describe("useTxHistory is wired to the replacement record", () => {
  const src = readFileSync(
    resolve(fileURLToPath(new URL(".", import.meta.url)), "useTxHistory.ts"),
    "utf8",
  );

  it("every page read passes through the filter", () => {
    expect(src).toMatch(/withoutReplacedRows\(\s*chain,\s*await readPairHistory\(/);
  });

  it("the cache it hydrates from does too", () => {
    expect(src).toMatch(/next\[k\] = withoutReplacedRows\(p\.chain, cached\.items\)/);
  });

  it("a recorded replacement prunes what is held, flushes, and re-reads that chain in full", () => {
    expect(src).toMatch(/onTxReplacement\(\(r\) => \{[\s\S]*prunedOfReplacements\(heldTx\.current, r\.chain\)[\s\S]*prunedOfReplacements\(pendingTx\.current, r\.chain\)[\s\S]*flushNow\(\)[\s\S]*fetchOne\(r\.chain, k\.slice\(prefix\.length\), true\)/);
  });
});
