/**
 * The Activity header's per-chain status (operator report 2026-09-30).
 *
 * The landscape header read
 *   `· errors on ETH, USDT, USDT, USDC, USDC, USDC, USDC, USDC, USDT0, USDT0, USDC, USDT0, POL, TRX, ETH, ETH, ETH, MON, NEAR`
 * — tickers only (four chains read "ETH"), no reason, and NEAR, whose
 * history had no source at all, counted as an error. These tests pin what
 * the shared status (`historyStatus.ts`) says instead. The error strings are
 * the ones the base commit's adapters produced for the test seed on
 * 2026-09-30 (live harness; see the fix log).
 */
import { describe, expect, it } from "vitest";
import type { ChainTx } from "../../wallets/types";
import { HistoryUnavailableError } from "../../wallets/tx-history-errors";
import {
  chainHistoryStatuses,
  classifyHistoryFailure,
  summarizeHistoryStatus,
} from "./historyStatus";

/** Verbatim errors from the base commit (2026-09-30 harness run). */
const OLD = {
  ethereum:
    'All 1 source(s) failed: https://eth.blockscout.com/api — last error: HTTP 429 from https://eth.blockscout.com/api?module=account&action=txlist&address=0x9858EfFD232B4033E47d90003D41EC34EcaEda94&startblock=0&endblock=99999999&page=1&offset=50&sort=desc: {"message":"Too many requests. Increase limits now at https://dev.blockscout.com","result":null,"status":"0"}',
  monad:
    "All 1 source(s) failed: https://explorer.monad.xyz/api — last error: host 'explorer.monad.xyz' is not on the http_proxy allowlist (see http_proxy.rs)",
  tron:
    "HTTP 404 from https://api.tronstack.io/v1/accounts/TPrkFhZ8LH8Mruco8vXyA496TaeFBrbmeU/transactions?limit=50&only_confirmed=true: <html>\n<head><title>404 Not Found</title></head>",
  near: "NEAR transaction history is not available in this wallet yet. Look the account up on a NEAR explorer.",
};

const tx = (chain: ChainTx["chain"], hash: string, over: Partial<ChainTx> = {}): ChainTx => ({
  chain,
  hash,
  direction: "in",
  amount: "1",
  timestamp: 100,
  ...over,
});

describe("classifyHistoryFailure names the reason in a word", () => {
  it("the operator's failures, as the base commit reported them", () => {
    expect(classifyHistoryFailure(OLD.ethereum)).toBe("rate-limited");
    expect(classifyHistoryFailure(OLD.monad)).toBe("blocked");
    expect(classifyHistoryFailure(OLD.tron)).toBe("refused");
  });

  it("the new adapters' failures", () => {
    expect(
      classifyHistoryFailure(
        "every history source failed — eth.blockscout.com: HTTP 429 (Too many requests. Increase limits now at https://dev.blockscout.com); api.routescan.io: HTTP 503",
      ),
    ).toBe("rate-limited");
    expect(
      classifyHistoryFailure(
        "every TRX history source failed — api.trongrid.io: http request to https://api.trongrid.io/v1/x failed: error sending request for url; apilist.tronscanapi.com: timeout",
      ),
    ).toBe("unreachable");
    expect(classifyHistoryFailure("every history source failed — base.blockscout.com: HTTP 502")).toBe("explorer-error");
    expect(classifyHistoryFailure("NEAR history: unexpected response from NearBlocks")).toBe("bad-response");
  });
});

describe("'not available' is not an error (operator report 2026-09-30)", () => {
  it("a HistoryUnavailableError message is listed as unavailable, with no failure", () => {
    const msg = new HistoryUnavailableError("BNB Smart Chain").message;
    expect(msg).toBe("history not available for BNB Smart Chain yet");
    const [bsc] = chainHistoryStatuses(["bsc"], { txByChain: {}, errors: { "bsc:0xme": msg } });
    expect(bsc).toMatchObject({ unavailable: true, failure: null });
    const summary = summarizeHistoryStatus([bsc]);
    expect(summary.unavailable).toEqual(["BNB Smart Chain"]);
    expect(summary.failures).toEqual([]);
  });

  it("…whereas the base commit's NEAR message was a failure — which is what the header showed", () => {
    const [near] = chainHistoryStatuses(["near"], { txByChain: {}, errors: { "near:abc": OLD.near } });
    expect(near.unavailable).toBe(false);
    expect(near.failure).not.toBeNull();
  });
});

describe("the header names chains, not tickers, grouped by reason", () => {
  it("ETH on four chains is four names; USDC legs keep their network", () => {
    const errors = {
      "ethereum:0xme": OLD.ethereum,
      "arbitrum:0xme": OLD.ethereum.replaceAll("eth.blockscout", "arbitrum.blockscout"),
      "base:0xme": OLD.ethereum.replaceAll("eth.blockscout", "base.blockscout"),
      "usdc-arb:0xme": OLD.ethereum,
      "monad:0xme": OLD.monad,
      "tron:Tme": OLD.tron,
    };
    const statuses = chainHistoryStatuses(["ethereum", "arbitrum", "base", "usdc-arb", "monad", "tron"], {
      txByChain: {},
      errors,
    });
    const s = summarizeHistoryStatus(statuses);
    expect(s.failures.map((f) => [f.label, f.chains.map((c) => c.name)])).toEqual([
      ["rate limited", ["Ethereum", "Arbitrum", "Base", "USDC (Arbitrum)"]],
      ["source blocked", ["Monad"]],
      ["explorer refused", ["TRON"]],
    ]);
    // Each chain's full error rides along for the tooltip.
    expect(s.failures[0].chains[0].message).toBe(OLD.ethereum);
  });

  it("a USD₮0 leg reads as USDT with the note, so Optimism's two USDT legs stay apart (2026-10-06)", () => {
    // Operator request 2026-10-01: "USDT0" is not the name people know the
    // token by. Before, the header printed "USDT0 (Arbitrum)".
    const errors = {
      "usdt-op:0xme": OLD.ethereum,
      "usdt0-op:0xme": OLD.ethereum,
      "usdt0-arb:0xme": OLD.ethereum,
      "usdt-near:abc": "every history source failed — api.nearblocks.io: HTTP 503",
    };
    const statuses = chainHistoryStatuses(["usdt-op", "usdt0-op", "usdt0-arb", "usdt-near"], {
      txByChain: {},
      errors,
    });
    expect(summarizeHistoryStatus(statuses).failures.map((f) => [f.label, f.chains.map((c) => c.name)])).toEqual([
      ["rate limited", ["USDT (Optimism)", "USDT (Optimism · USD₮0)", "USDT (Arbitrum · USD₮0)"]],
      ["explorer error", ["USDT (NEAR)"]],
    ]);
  });
});

describe("one status per chain — a UTXO chain's rows are listed once", () => {
  it("chainsOwned repeats litecoin per account address; its rows are not repeated", () => {
    // App.tsx builds chainsOwned from every chain:address pair, so a litecoin
    // account with three used addresses appears three times. The views used
    // to read `${c}:${addressByChain[c]}` once PER ENTRY: the last address's
    // list, three times over, and never the other two.
    const txByChain = {
      "litecoin:ltc1qa": [tx("litecoin", "aa11")],
      "litecoin:ltc1qb": [tx("litecoin", "bb22")],
      "litecoin:ltc1qc": [tx("litecoin", "cc33")],
    };
    const statuses = chainHistoryStatuses(["litecoin", "litecoin", "litecoin"], { txByChain });
    expect(statuses).toHaveLength(1);
    expect(statuses[0].txs.map((t) => t.hash).sort()).toEqual(["aa11", "bb22", "cc33"]);

    // What the pre-fix flatten produced for the same input.
    const addressByChain: Record<string, string> = { litecoin: "ltc1qc" };
    const old: ChainTx[] = [];
    for (const c of ["litecoin", "litecoin", "litecoin"]) old.push(...(txByChain[`${c}:${addressByChain[c]}` as keyof typeof txByChain] ?? []));
    expect(old.map((t) => t.hash)).toEqual(["cc33", "cc33", "cc33"]);
  });
});
