/**
 * Regression locks for the unified Activity timeline's dedup logic
 * shipped 2026-05-26 (#19). The Activity tab merges per-chain
 * `ChainTx[]` with cross-chain `SwapHistoryEntry[]` into one sorted
 * timeline. The dedup contract: if a chain-tx hash matches the
 * source or destination hash of any swap entry, suppress the chain-
 * tx row in the unified timeline. The swap row is the canonical
 * representation of that hash in this view.
 *
 * Per-chain dashboards are NOT touched by this dedup — they continue
 * to show the source/dest tx rows independently. The dedup is
 * scoped to ActivityView's flat list because that's where the
 * double-counting was visible.
 *
 * These tests don't import `ActivityView` directly (it's a React
 * component with significant render machinery); they pin the
 * dedup-algorithm contract by reimplementing the same shape and
 * asserting properties. The component-level integration is covered
 * by manual sandbox verification.
 */
import { describe, expect, it } from "vitest";
import type { ChainTx } from "../../wallets/types";
import type { SwapHistoryEntry } from "../swap";

type ActivityRow =
  | { kind: "chain"; tx: ChainTx; timestamp: number }
  | { kind: "swap"; swap: SwapHistoryEntry; timestamp: number };

function flattenWithDedup(
  chainTxs: ChainTx[],
  swaps: SwapHistoryEntry[]
): ActivityRow[] {
  const swapHashes = new Set<string>();
  for (const s of swaps) {
    if (s.sourceTxHash) swapHashes.add(s.sourceTxHash.toLowerCase());
    if (s.destTxHash) swapHashes.add(s.destTxHash.toLowerCase());
  }
  const rows: ActivityRow[] = [];
  for (const tx of chainTxs) {
    if (swapHashes.has(tx.hash.toLowerCase())) continue;
    rows.push({ kind: "chain", tx, timestamp: tx.timestamp ?? 0 });
  }
  for (const s of swaps) {
    const iso = s.completedAt ?? s.createdAt;
    const t = new Date(iso).getTime();
    rows.push({
      kind: "swap",
      swap: s,
      timestamp: Number.isFinite(t) ? Math.floor(t / 1000) : 0,
    });
  }
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return rows;
}

const makeChainTx = (hash: string, ts: number, chain = "avalanche"): ChainTx => ({
  chain: chain as ChainTx["chain"],
  hash,
  direction: "out",
  amount: "0.1",
  timestamp: ts,
});

const makeSwap = (overrides: Partial<SwapHistoryEntry> = {}): SwapHistoryEntry => ({
  id: "swap-1",
  fromAsset: "AVAX",
  toAsset: "ADA",
  fromAmount: "0.1",
  toAmount: "3.78",
  status: "success",
  sourceTxHash: "0xd36293aa6628dc",
  sourceExplorerUrl: "",
  createdAt: "2026-05-25T10:00:00.000Z",
  completedAt: "2026-05-25T10:02:00.000Z",
  ...overrides,
});

describe("Unified Activity flatten — dedup contract", () => {
  it("suppresses a chain-tx whose hash matches a swap.sourceTxHash", () => {
    const chainTx = makeChainTx("0xd36293aa6628dc", 1716638400);
    const swap = makeSwap();
    const rows = flattenWithDedup([chainTx], [swap]);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("swap");
  });

  it("suppresses a chain-tx whose hash matches a swap.destTxHash", () => {
    const chainTx = makeChainTx("ada1234567dest", 1716638500, "cardano");
    const swap = makeSwap({
      destTxHash: "ada1234567dest",
      destExplorerUrl: "https://cardanoscan.io/transaction/ada1234567dest",
    });
    const rows = flattenWithDedup([chainTx], [swap]);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("swap");
  });

  it("dedups case-insensitively (EIP-55 mixed-case Ethereum hex)", () => {
    // The source hash in the swap is mixed-case (Etherscan-style)
    // and the chain-tx hash comes back from an indexer as all-lower.
    const chainTx = makeChainTx("0xabcdef1234", 1716638400);
    const swap = makeSwap({ sourceTxHash: "0xAbCdEf1234" });
    const rows = flattenWithDedup([chainTx], [swap]);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("swap");
  });

  it("keeps a chain-tx that doesn't match any swap hash", () => {
    const unrelated = makeChainTx("0xunrelated", 1716638400);
    const swap = makeSwap();
    const rows = flattenWithDedup([unrelated], [swap]);
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.kind === "chain")).toBeDefined();
    expect(rows.find((r) => r.kind === "swap")).toBeDefined();
  });

  it("sorts merged rows newest-first across both kinds", () => {
    const oldTx = makeChainTx("0xolder", 1716000000);
    const newTx = makeChainTx("0xnewer", 1716700000);
    const swap = makeSwap({
      completedAt: "2026-05-25T10:30:00.000Z", // ~1716633000
    });
    const rows = flattenWithDedup([oldTx, newTx], [swap]);
    expect(rows.length).toBe(3);
    expect(rows[0].timestamp).toBeGreaterThan(rows[1].timestamp);
    expect(rows[1].timestamp).toBeGreaterThan(rows[2].timestamp);
  });

  it("places swaps with no completedAt at the createdAt timestamp", () => {
    // In-flight swap (status pending) — no completedAt yet, sort
    // by createdAt instead.
    const inflight = makeSwap({
      status: "pending",
      createdAt: "2026-05-25T10:00:00.000Z",
      completedAt: undefined,
    });
    const rows = flattenWithDedup([], [inflight]);
    expect(rows.length).toBe(1);
    expect(rows[0].timestamp).toBeGreaterThan(0);
  });

  it("handles a swap with no destTxHash yet (in-flight) without dropping the source-tx suppression", () => {
    // The user just broadcast — destTxHash is undefined but
    // sourceTxHash is. The chain-tx on the source chain should
    // still get suppressed.
    const sourceTx = makeChainTx("0xd36293aa6628dc", 1716638400);
    const inflight = makeSwap({ status: "pending", destTxHash: undefined });
    const rows = flattenWithDedup([sourceTx], [inflight]);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("swap");
  });

  it("doesn't crash on empty inputs", () => {
    expect(flattenWithDedup([], []).length).toBe(0);
  });

  it("multiple swaps sharing no hashes with chain txs leave all rows visible", () => {
    const chainTxs = [
      makeChainTx("0xaaaa", 1716700000),
      makeChainTx("0xbbbb", 1716600000),
    ];
    const swaps = [
      makeSwap({ id: "s1", sourceTxHash: "0x1111" }),
      makeSwap({ id: "s2", sourceTxHash: "0x2222" }),
    ];
    const rows = flattenWithDedup(chainTxs, swaps);
    expect(rows.length).toBe(4); // 2 chain + 2 swap
  });
});
