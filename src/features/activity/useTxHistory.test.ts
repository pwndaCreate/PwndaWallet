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

describe("mergeChainTx — the wallet's net across its own addresses (2026-09-17)", () => {
  // Real rows from the operator's LTC account, as litecoinspace reports them
  // per address (meta.netSat is the signed per-address net).
  const send = (addr: string, netSat: number): ChainTx =>
    tx("40499728e987750c", {
      direction: netSat < 0 ? "out" : "in",
      amount: (Math.abs(netSat) / 1e8).toFixed(8),
      timestamp: 1789270836,
      fee: netSat < 0 ? "0.00001410" : undefined,
      counterparty: netSat < 0 ? "ltc1qchange2" : undefined,
      meta: { netSat, outputs: ["ltc1qrecipient", "ltc1qchange2"] },
    });

  it("a send whose change went to another own address shows what actually left", () => {
    const txByChain = {
      "litecoin:ltc1qchange0": [send("ltc1qchange0", -352247525)],
      "litecoin:ltc1qchange2": [send("ltc1qchange2", 232246115)],
    };
    const [row] = mergeChainTx({ txByChain }, "litecoin").txs;
    // Was "-3.52247525" (the whole input) before netting.
    expect(row.direction).toBe("out");
    expect(row.amount).toBe("1.20001410");
    expect(row.fee).toBe("0.00001410");
    // The counterparty is the recipient, not our own change address.
    expect(row.counterparty).toBe("ltc1qrecipient");
  });

  it("the P2P fee spend nets to the fee plus the network fee", () => {
    const fee = (netSat: number): ChainTx =>
      tx("8b75e0fc044521ad", {
        direction: netSat < 0 ? "out" : "in",
        amount: (Math.abs(netSat) / 1e8).toFixed(8),
        meta: { netSat, outputs: ["ltc1qfeeaddress", "ltc1qchange3"] },
      });
    const txByChain = {
      "litecoin:ltc1qchange2": [fee(-232246115)],
      "litecoin:ltc1qchange3": [fee(232195866)],
    };
    const [row] = mergeChainTx({ txByChain }, "litecoin").txs;
    expect(row).toMatchObject({ direction: "out", amount: "0.00050249", counterparty: "ltc1qfeeaddress" });
  });

  it("a row it cannot sign (mempool) keeps the first occurrence, unchanged", () => {
    const a = tx("unconf", { direction: "pending", amount: "3.0" });
    const b = tx("unconf", { direction: "pending", amount: "2.0" });
    const txByChain = { "litecoin:a": [a], "litecoin:b": [b] };
    expect(mergeChainTx({ txByChain }, "litecoin").txs).toEqual([a]);
  });

  it("a tx under one address only is returned as-is", () => {
    const payout = tx("0683dbe03a9d3255", { amount: "0.09999817", meta: { netSat: 9999817 } });
    const txByChain = { "litecoin:ltc1qrx8z2": [payout], "litecoin:other": [] };
    expect(mergeChainTx({ txByChain }, "litecoin").txs).toEqual([payout]);
  });
});
