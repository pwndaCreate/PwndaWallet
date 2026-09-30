/**
 * Row identity and deduplication in the Activity data path (operator report
 * 2026-09-30: repeated rows in Activity, and "errors on …").
 *
 * The key is `txRowKey` = chain | hash (hex lower-cased) | asset | side |
 * log index or receipt id (`src/wallets/tx-row-key.ts` explains each part).
 * The bugs pinned here, each on code in this folder:
 *
 *  - `mergeHistoryPage` keyed rows by bare hash: two legs of one transaction
 *    (a Zephyr conversion's `out` ZEPH and `in` ZEPHUSD) replaced each other
 *    on every poll.
 *  - `mergeChainTx` grouped by bare hash and NETTED the group, even when
 *    every row came from the same address: the conversion lost a leg.
 *  - an explorer page listing one transaction twice (Routescan, 2026-09-30)
 *    was two rows.
 *  - state kept every `chain:address` key it had ever seen, so merging all
 *    of a chain's keys could mix in a previous wallet's history.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChainTx } from "../../wallets/types";
import { dedupeTxRows, normalizeTxHash, txRowKey } from "../../wallets/tx-row-key";
import { mergeChainTx, pruneToKeys } from "./useTxHistory";
import { mergeHistoryPage } from "./txHistorySchedule";

const zph = (direction: ChainTx["direction"], asset: string, amount: string): ChainTx => ({
  chain: "zephyr",
  hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  direction,
  amount,
  timestamp: 1789000000,
  meta: { asset_type: asset },
});

describe("txRowKey", () => {
  it("hex hashes compare case-insensitively; base58 signatures do not", () => {
    expect(normalizeTxHash("0xABCdef")).toBe("0xabcdef");
    expect(normalizeTxHash("4E2833DF")).toBe("4e2833df");
    expect(normalizeTxHash("BiuXnScWdSgKAHZdv8bzzy9UPYAiWd4tu3gMt5ELMNBP")).toBe(
      "BiuXnScWdSgKAHZdv8bzzy9UPYAiWd4tu3gMt5ELMNBP",
    );
  });

  it("a settling row keeps its key (pending → out, out → failed)", () => {
    const pending: ChainTx = { chain: "monero", hash: "ff", direction: "pending", amount: "1" };
    expect(txRowKey({ ...pending, direction: "out" })).toBe(txRowKey(pending));
    expect(txRowKey({ ...pending, direction: "failed" })).toBe(txRowKey(pending));
    // A reverted INCOMING transfer keys like the incoming row it was.
    const incoming: ChainTx = { chain: "ethereum", hash: "0xab", direction: "in", amount: "1" };
    expect(txRowKey({ ...incoming, direction: "failed", meta: { intended: "in" } })).toBe(txRowKey(incoming));
  });

  it("two transfers in one transaction stay two rows when the source says which log", () => {
    const a: ChainTx = { chain: "usdc-eth", hash: "0xab", direction: "in", amount: "5", meta: { logIndex: 3 } };
    const b: ChainTx = { ...a, meta: { logIndex: 7 } };
    expect(dedupeTxRows([a, b])).toHaveLength(2);
    expect(dedupeTxRows([a, { ...a }])).toHaveLength(1);
  });
});

describe("mergeHistoryPage (poll merge)", () => {
  it("keeps both legs of a Zephyr conversion (keyed by hash, one leg replaced the other)", () => {
    const out = zph("out", "ZPH", "100.000000000000");
    const inn = zph("in", "ZSD", "25.000000000000");
    const merged = mergeHistoryPage([out, inn], [out, inn], 50);
    expect(merged).toHaveLength(2);
  });

  it("the same transaction under a differently-cased hash is one row", () => {
    const held: ChainTx = { chain: "ethereum", hash: "0xABCD", direction: "in", amount: "1", timestamp: 10, confirmations: 1 };
    const fresh: ChainTx = { ...held, hash: "0xabcd", confirmations: 7 };
    const merged = mergeHistoryPage([held], [fresh], 50);
    expect(merged).toEqual([fresh]);
  });
});

describe("mergeChainTx (the views' per-chain merge)", () => {
  it("rows from ONE address are kept as the adapter returned them — a conversion keeps both legs", () => {
    const out = zph("out", "ZPH", "100.000000000000");
    const inn = zph("in", "ZSD", "25.000000000000");
    const { txs } = mergeChainTx({ txByChain: { "zephyr:ZEPHYRme": [out, inn] } }, "zephyr");
    expect(txs).toHaveLength(2);
    expect(txs.map((t) => (t.meta as { asset_type: string }).asset_type).sort()).toEqual(["ZPH", "ZSD"]);
  });

  it("an exact duplicate within one list collapses", () => {
    const row: ChainTx = { chain: "ethereum", hash: "0xf451", direction: "out", amount: "1", timestamp: 5 };
    const { txs } = mergeChainTx({ txByChain: { "ethereum:0xme": [row, { ...row, confirmations: 2 }] } }, "ethereum");
    expect(txs).toHaveLength(1);
  });

  it("the same transaction under two own addresses is still netted (UTXO, unchanged)", () => {
    const a: ChainTx = { chain: "litecoin", hash: "40499728", direction: "out", amount: "3.52247525", meta: { netSat: -352247525 } };
    const b: ChainTx = { chain: "litecoin", hash: "40499728", direction: "in", amount: "2.32246115", meta: { netSat: 232246115 } };
    const { txs } = mergeChainTx({ txByChain: { "litecoin:c0": [a], "litecoin:c2": [b] } }, "litecoin");
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ direction: "out", amount: "1.20001410" });
  });
});

describe("the lists' React keys are unique (operator report 2026-09-30)", () => {
  // The build the operator ran listed one LTC send 7 times and one BCH
  // receipt 4 times, each copy with the same key; switching ALL / SENT /
  // RECEIVED then changed the side panel but not the rows. Both views now
  // pass the flattened rows through `dedupeTxRows` before rendering.
  it("both views dedupe the flattened rows by their key", () => {
    for (const view of ["ActivityLandscapeView.tsx", "ActivityViewPortrait.tsx"]) {
      const src = readFileSync(resolve(__dirname, view), "utf8");
      expect(src).toContain("dedupChainTxsAgainstSwaps(dedupeTxRows(out), swapHashes)");
    }
  });

  it("seven copies of one row become one", () => {
    const ltc: ChainTx = { chain: "litecoin", hash: "0af8b931", direction: "out", amount: "4.02888049" };
    const rows = dedupeTxRows(Array.from({ length: 7 }, () => ({ ...ltc })));
    expect(rows).toHaveLength(1);
    expect(new Set(rows.map(txRowKey)).size).toBe(rows.length);
  });
});

describe("pruneToKeys (state follows the current wallet)", () => {
  it("drops keys outside the current pair set, and returns the same object when nothing is dropped", () => {
    const m = { "ethereum:0xold": [1], "ethereum:0xnew": [2] };
    expect(pruneToKeys(m, new Set(["ethereum:0xnew"]))).toEqual({ "ethereum:0xnew": [2] });
    expect(pruneToKeys(m, new Set(Object.keys(m)))).toBe(m);
  });

  it("without pruning, the per-chain merge would mix a previous wallet's rows in", () => {
    const txByChain = {
      "ethereum:0xPREVIOUS": [{ chain: "ethereum", hash: "0x01", direction: "in", amount: "9" } as ChainTx],
      "ethereum:0xCURRENT": [{ chain: "ethereum", hash: "0x02", direction: "in", amount: "1" } as ChainTx],
    };
    expect(mergeChainTx({ txByChain }, "ethereum").txs).toHaveLength(2);
    const pruned = pruneToKeys(txByChain, new Set(["ethereum:0xCURRENT"]));
    expect(mergeChainTx({ txByChain: pruned }, "ethereum").txs.map((t) => t.hash)).toEqual(["0x02"]);
  });
});
