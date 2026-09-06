/**
 * Regression lock for `mergeChainTx` (2026-08-23).
 *
 * Root cause: `txByChain` is keyed per `{chain}:{address}`, and the
 * "Recent" widgets (WalletLandscapeView, WalletTxHistorySubview) used to
 * look up exactly one key — `{activeChain}:{addressByChain[activeChain]}`.
 * A UTXO chain's displayed address is only ONE address the wallet
 * controls; `resolveUtxoAccountBalance`'s gap walk can find funds on a
 * change address the display address never touches. The balance sweep
 * counted that change address's funds correctly (whole-account scan);
 * the single-key "Recent" lookup never asked that address for its
 * history, so a real incoming transaction was permanently invisible in
 * the UI no matter how many polls ran. The incident: an LTC swap payout
 * landed at a change index one past the standard gap limit — balance
 * total updated, "Recent" stayed empty.
 *
 * `mergeChainTx` replaces the single-key lookup with a per-chain merge
 * across every address key present for that chain.
 */
import { describe, expect, it } from "vitest";
import { mergeChainTx } from "./useTxHistory";
import type { ChainTx } from "../../wallets/types";

function tx(hash: string, overrides: Partial<ChainTx> = {}): ChainTx {
  return {
    chain: "litecoin",
    hash,
    direction: "in",
    amount: "1.0",
    timestamp: 1000,
    ...overrides,
  };
}

describe("mergeChainTx", () => {
  it("surfaces a transaction that only exists under a non-displayed address's key", () => {
    // The exact shape of the incident: the displayed address (index 0) has
    // no history at all; the swap payout only shows up under the change
    // address the account scan separately discovered.
    const txByChain = {
      "litecoin:ltc1qDISPLAYED": [],
      "litecoin:ltc1qCHANGE20": [tx("swap-payout")],
    };
    const { txs } = mergeChainTx({ txByChain }, "litecoin");
    expect(txs.map((t) => t.hash)).toEqual(["swap-payout"]);
  });

  it("merges and sorts across every address key for the chain, newest first", () => {
    const txByChain = {
      "litecoin:addrA": [tx("old", { timestamp: 100 })],
      "litecoin:addrB": [tx("new", { timestamp: 300 })],
      "litecoin:addrC": [tx("mid", { timestamp: 200 })],
    };
    const { txs } = mergeChainTx({ txByChain }, "litecoin");
    expect(txs.map((t) => t.hash)).toEqual(["new", "mid", "old"]);
  });

  it("dedupes a transaction that appears under more than one of the chain's addresses", () => {
    // A self-transfer / sweep can legitimately show up under both the
    // source and change address. One row, not two.
    const shared = tx("self-sweep");
    const txByChain = {
      "litecoin:addrA": [shared],
      "litecoin:addrB": [shared],
    };
    const { txs } = mergeChainTx({ txByChain }, "litecoin");
    expect(txs).toHaveLength(1);
  });

  it("ignores keys belonging to other chains", () => {
    const txByChain = {
      "litecoin:addrA": [tx("ltc-tx")],
      "bitcoin:addrA": [tx("btc-tx")],
    };
    const { txs } = mergeChainTx({ txByChain }, "litecoin");
    expect(txs.map((t) => t.hash)).toEqual(["ltc-tx"]);
  });

  it("reports loading true if any of the chain's address keys is loading", () => {
    const txByChain = { "litecoin:addrA": [], "litecoin:addrB": [] };
    const loading = { "litecoin:addrA": false, "litecoin:addrB": true };
    expect(mergeChainTx({ txByChain, loading }, "litecoin").loading).toBe(true);
  });

  it("reports an error only when a matching key actually has one", () => {
    const txByChain = { "litecoin:addrA": [] };
    const errors = { "litecoin:addrA": "explorer 429" };
    expect(mergeChainTx({ txByChain, errors }, "litecoin").error).toBe(
      "explorer 429"
    );
    expect(mergeChainTx({ txByChain }, "litecoin").error).toBeNull();
  });

  it("tolerates loading/errors being omitted entirely", () => {
    const txByChain = { "litecoin:addrA": [tx("a")] };
    expect(() => mergeChainTx({ txByChain }, "litecoin")).not.toThrow();
  });
});
