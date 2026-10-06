/**
 * EVM history sources (operator report 2026-09-30: the landscape Activity
 * header listed 17 EVM rows — every chain served by *.blockscout.com, and the
 * three Monad rows — as "errors", and BSC answered "no transactions" when its
 * explorer had said "chain not supported").
 *
 * Live, read-only, with the world-public test address on 2026-09-30:
 *  - `https://eth.blockscout.com/api?module=account&action=txlist…` →
 *    HTTP 429 `{"message":"Too many requests. Increase limits now at
 *    https://dev.blockscout.com","result":null,"status":"0"}`,
 *    `x-ratelimit-limit: 10`; the same instance's
 *    `/api/v2/addresses/<a>/transactions` → HTTP 200, 50 items,
 *    `x-ratelimit-limit: 180`.
 *  - `https://api.routescan.io/v2/network/mainnet/evm/56/etherscan/api?…`
 *    → HTTP 200 `{"status":"0","message":"chain not supported","result":null}`.
 *  - `explorer.monad.xyz` → ENOTFOUND (and not on the proxy allowlist).
 *
 * The fixtures below keep the live responses' SHAPE, trimmed to the fields
 * the reader uses. Every network call goes through a fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_proxy", () => ({
  proxyGetJson: vi.fn(),
  proxyPostJson: vi.fn(),
  httpProxyCall: vi.fn(),
}));

import { proxyGetJson } from "./_proxy";
import {
  blockscoutTransferRow,
  blockscoutTxRow,
  blockscoutV2,
  etherscanCompatible,
  etherscanRow,
  etherscanRows,
  fetchEvmHistory,
  type EvmHistoryConfig,
} from "./evm-history";
import { isHistoryUnavailable } from "./tx-history-errors";
import {
  arbitrumAdapter,
  bscAdapter,
  ethAdapter,
  monadAdapter,
  usdcArbAdapter,
  usdcBscAdapter,
  usdcMonadAdapter,
  usdt0MonadAdapter,
  usdtBscAdapter,
} from "./eth-wallet";

const ME = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x7cEcd9e9E0Ba9F29f553402E4DD6d3c1Ea2C2759";
const BLOCKSCOUT_429 = `HTTP 429 from https://eth.blockscout.com/api?module=account&action=txlist&address=${ME}: {"message":"Too many requests. Increase limits now at https://dev.blockscout.com","result":null,"status":"0"}`;

/** A Blockscout v2 `/transactions` item, trimmed. */
function v2Tx(over: Record<string, unknown> = {}) {
  return {
    hash: "0x6f3d89611e63302fcc132ce970d9416e7cf18ebe7ffb02cce5255ae9e2a08930",
    from: { hash: OTHER },
    to: { hash: ME },
    value: "9698659261008",
    fee: { type: "actual", value: "37775797204200" },
    status: "ok",
    result: "success",
    timestamp: "2026-09-28T04:16:11.000000Z",
    block_number: 26073497,
    confirmations: 16885,
    method: null,
    ...over,
  };
}

/** A Routescan (Etherscan-style) `txlist` row, trimmed. */
function esTx(over: Record<string, unknown> = {}) {
  return {
    hash: "0xf451ddcb62aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa",
    from: ME.toLowerCase(),
    to: OTHER.toLowerCase(),
    value: "1000000000000000000",
    gasUsed: "21000",
    gasPrice: "1000000000",
    isError: "0",
    txreceipt_status: "1",
    timeStamp: "1790000000",
    blockNumber: "26000000",
    confirmations: "19125",
    ...over,
  };
}

const NATIVE: EvmHistoryConfig = {
  chain: "ethereum",
  displayName: "Ethereum",
  explorers: [
    blockscoutV2("https://eth.blockscout.com"),
    etherscanCompatible("https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api"),
  ],
  decimals: 18,
};

beforeEach(() => {
  vi.mocked(proxyGetJson).mockReset();
});

describe("source selection and fallback (operator report 2026-09-30)", () => {
  it("reads Blockscout's v2 API, not the rate-limited Etherscan-style /api", async () => {
    const urls: string[] = [];
    const page = await fetchEvmHistory(NATIVE, ME, { limit: 50 }, async (url) => {
      urls.push(url);
      return { items: [v2Tx()], next_page_params: null };
    });
    expect(urls).toEqual([`https://eth.blockscout.com/api/v2/addresses/${ME}/transactions`]);
    expect(page.items).toHaveLength(1);
  });

  it("falls back to the next source when the first is rate-limited, and says which answered", async () => {
    const urls: string[] = [];
    const page = await fetchEvmHistory(NATIVE, ME, { limit: 50 }, async (url) => {
      urls.push(url);
      if (url.includes("blockscout")) throw new Error(BLOCKSCOUT_429);
      return { status: "1", message: "OK", result: [esTx()] };
    });
    expect(urls[1]).toMatch(/^https:\/\/api\.routescan\.io\/v2\/network\/mainnet\/evm\/1\/etherscan\/api\?module=account&action=txlist&address=/);
    // No fixed endblock: `endblock=99999999` is below Arbitrum's and Optimism's heights.
    expect(urls[1]).not.toMatch(/endblock/);
    expect(page.items[0]).toMatchObject({ direction: "out", amount: "1", meta: { source: "api.routescan.io" } });
  });

  it("when every source fails, the error names each source and why", async () => {
    await expect(
      fetchEvmHistory(NATIVE, ME, undefined, async (url) => {
        if (url.includes("blockscout")) throw new Error(BLOCKSCOUT_429);
        throw new Error(`HTTP 503 from ${url}: <html>busy</html>`);
      }),
    ).rejects.toThrow(
      "every history source failed — eth.blockscout.com: HTTP 429 (Too many requests. Increase limits now at https://dev.blockscout.com); api.routescan.io: HTTP 503",
    );
  });

  it("a continuation cursor goes back to the source that issued it", async () => {
    const first = await fetchEvmHistory(NATIVE, ME, { limit: 50 }, async () => ({
      items: [v2Tx()],
      next_page_params: { block_number: 26073497, index: 120, items_count: 50 },
    }));
    expect(first.cursor).toBeDefined();
    const urls: string[] = [];
    await fetchEvmHistory(NATIVE, ME, { limit: 50, cursor: first.cursor }, async (url) => {
      urls.push(url);
      return { items: [], next_page_params: null };
    });
    expect(urls).toEqual([
      `https://eth.blockscout.com/api/v2/addresses/${ME}/transactions?block_number=26073497&index=120&items_count=50`,
    ]);
  });
});

describe("an Etherscan-style status 0 is a failure unless it is the 'no transactions' answer", () => {
  it("'chain not supported' throws — the old reader returned [] (BSC's 'no transactions')", () => {
    expect(() => etherscanRows({ status: "0", message: "chain not supported", result: null })).toThrow(
      "explorer refused: chain not supported",
    );
    expect(() => etherscanRows({ status: "0", message: "NOTOK", result: "Max rate limit reached" })).toThrow(
      "explorer refused: NOTOK: Max rate limit reached",
    );
  });

  it("'No transactions found' with an empty array is an empty list", () => {
    expect(etherscanRows({ status: "0", message: "No transactions found", result: [] })).toEqual([]);
    expect(etherscanRows({ status: "1", message: "OK", result: [esTx()] })).toHaveLength(1);
  });

  it("a page that lists one transaction twice (Routescan, read 2026-09-30) yields one row", async () => {
    const page = await fetchEvmHistory(
      { ...NATIVE, explorers: [NATIVE.explorers[1]] },
      ME,
      { limit: 50 },
      async () => ({ status: "1", message: "OK", result: [esTx({ confirmations: "19125" }), esTx({ confirmations: "19126" })] }),
    );
    expect(page.items).toHaveLength(1);
  });
});

describe("chains with no keyless source say so — never an error, never 'no transactions'", () => {
  const unavailable = [
    [bscAdapter, "BNB Smart Chain"],
    [usdtBscAdapter, "USDT (BNB Chain)"],
    [usdcBscAdapter, "USDC (BNB Chain)"],
    [monadAdapter, "Monad"],
    [usdcMonadAdapter, "USDC (Monad)"],
    // Named "USDT (Monad · USD₮0)" since 2026-10-06 (operator request
    // 2026-10-01: a USD₮0 leg reads USDT, with USD₮0 as its note).
    [usdt0MonadAdapter, "USDT (Monad · USD₮0)"],
  ] as const;

  for (const [adapter, name] of unavailable) {
    it(`${adapter.chain}: "history not available for ${name} yet", with no request made`, async () => {
      const err = await adapter.getTransactionHistory(ME).catch((e: unknown) => e);
      expect(isHistoryUnavailable(err)).toBe(true);
      expect((err as Error).message).toBe(`history not available for ${name} yet`);
      expect(proxyGetJson).not.toHaveBeenCalled();
    });
  }
});

describe("the real adapters, through the proxy", () => {
  it("ETH: Blockscout 429 → Routescan answers (the old code threw after its only source 429'd)", async () => {
    vi.mocked(proxyGetJson).mockImplementation(async (url: string) => {
      if (url.startsWith("https://eth.blockscout.com/")) throw new Error(BLOCKSCOUT_429);
      if (url.startsWith("https://api.routescan.io/v2/network/mainnet/evm/1/")) {
        return { status: "1", message: "OK", result: [esTx()] };
      }
      throw new Error(`unexpected url ${url}`);
    });
    const page = await ethAdapter.getTransactionHistory(ME, { limit: 50 });
    expect(page.items.map((t) => t.hash)).toEqual([esTx().hash]);
  });

  it("an L2 native coin and its token leg read their OWN chain's Blockscout v2", async () => {
    const urls: string[] = [];
    vi.mocked(proxyGetJson).mockImplementation(async (url: string) => {
      urls.push(url);
      return { items: [], next_page_params: null };
    });
    await arbitrumAdapter.getTransactionHistory(ME);
    await usdcArbAdapter.getTransactionHistory(ME);
    expect(urls).toEqual([
      `https://arbitrum.blockscout.com/api/v2/addresses/${ME}/transactions`,
      `https://arbitrum.blockscout.com/api/v2/addresses/${ME}/token-transfers?type=ERC-20&token=0xaf88d065e77c8cC2239327C5EDb3A432268e5831`,
    ]);
  });
});

describe("the Claude sandbox mock serves the route the reader now uses", () => {
  it("wallet_populated: the funded EVM rows arrive through Blockscout v2", async () => {
    vi.stubEnv("VITE_MOCK_STATE", "wallet_populated");
    try {
      const { getFetchMock } = await import("../lib/tauri-mocks");
      const res = getFetchMock(`https://eth.blockscout.com/api/v2/addresses/${ME}/transactions`, "GET", undefined);
      expect(res?.status).toBe(200);
      const rows = (JSON.parse(res!.body).items as unknown[]).map((r) =>
        blockscoutTxRow(r, ME.toLowerCase(), { chain: "ethereum", decimals: 18 }, "sandbox"),
      );
      expect(rows.map((r) => [r?.direction, r?.amount])).toEqual([
        ["out", "0.12"],
        ["in", "1.37"],
      ]);
      const tokens = getFetchMock(
        `https://arbitrum.blockscout.com/api/v2/addresses/${ME}/token-transfers?type=ERC-20&token=0xaf88`,
        "GET",
        undefined,
      );
      expect(JSON.parse(tokens!.body)).toEqual({ items: [], next_page_params: null });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("rows carry what the details view needs", () => {
  const cfg = { chain: "ethereum" as const, decimals: 18 };

  it("incoming: sender, amount, height, count, time — and no fee (the sender paid it)", () => {
    const row = blockscoutTxRow(v2Tx(), ME.toLowerCase(), cfg, "eth.blockscout.com")!;
    expect(row).toMatchObject({
      hash: v2Tx().hash,
      direction: "in",
      amount: "0.000009698659261008",
      timestamp: Date.parse("2026-09-28T04:16:11Z") / 1000,
      height: 26073497,
      confirmations: 16885,
      counterparty: OTHER,
      meta: { from: OTHER, to: ME, intended: "in" },
    });
    expect(row.fee).toBeUndefined();
  });

  it("outgoing: the fee this wallet paid, in the native coin", () => {
    const row = blockscoutTxRow(v2Tx({ from: { hash: ME }, to: { hash: OTHER } }), ME.toLowerCase(), cfg, "x")!;
    expect(row).toMatchObject({ direction: "out", fee: "0.0000377757972042", counterparty: OTHER });
  });

  it("a reverted transaction is `failed`, not money received (the old reader ignored status)", () => {
    const row = blockscoutTxRow(v2Tx({ status: "error", result: "Reverted" }), ME.toLowerCase(), cfg, "x")!;
    expect(row.direction).toBe("failed");
    expect(row.meta).toMatchObject({ intended: "in", failure: "Reverted" });
    // Etherscan-style rows mark a revert with isError "1".
    const es = etherscanRow(esTx({ isError: "1", txreceipt_status: "0" }), ME.toLowerCase(), cfg, "x")!;
    expect(es).toMatchObject({ direction: "failed", fee: "0.000021", meta: { intended: "out" } });
  });

  it("a mempool transaction has 0 confirmations, not 'no count'", () => {
    const row = blockscoutTxRow(v2Tx({ block_number: null, result: "pending", confirmations: 0 }), ME.toLowerCase(), cfg, "x")!;
    expect(row.confirmations).toBe(0);
    expect(row.direction).toBe("in");
  });

  it("an ERC-20 transfer keeps its log index and uses the configured decimals", () => {
    const tt = {
      transaction_hash: "0x2c9af6a8429a8badc3a81f7288a3e93ecd766c7eb15ca9f8ad98bacd4d64171f",
      from: { hash: ME },
      to: { hash: "0x44A3831B70E4cfBA7d73262Dc78443664cAbe644" },
      total: { decimals: "6", value: "10000000" },
      token: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: "6" },
      timestamp: "2025-09-04T16:21:35.000000Z",
      block_number: 23290907,
      log_index: 12,
      method: "0xa0b86991",
      type: "token_transfer",
    };
    const tcfg = { chain: "usdc-eth" as const, decimals: 6, tokenContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" };
    expect(blockscoutTransferRow(tt, ME.toLowerCase(), tcfg, "x")).toMatchObject({
      direction: "out",
      amount: "10",
      height: 23290907,
      confirmations: undefined,
      meta: { logIndex: 12, contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    });
    // A different token on the same list is not this leg's row.
    expect(blockscoutTransferRow({ ...tt, token: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" } }, ME.toLowerCase(), tcfg, "x")).toBeNull();
  });

  it("a token SEND gets the gas this wallet paid, from the address's own transaction list", async () => {
    const tokenCfg: EvmHistoryConfig = {
      chain: "usdc-eth",
      displayName: "USDC (Ethereum)",
      explorers: [blockscoutV2("https://eth.blockscout.com")],
      tokenContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
    };
    const sent = {
      transaction_hash: "0x2c9a",
      from: { hash: ME },
      to: { hash: OTHER },
      total: { decimals: "6", value: "10000000" },
      token: { address: tokenCfg.tokenContract },
      timestamp: "2025-09-04T16:21:35.000000Z",
      block_number: 23290907,
      log_index: 12,
    };
    const received = { ...sent, transaction_hash: "0x7777", from: { hash: OTHER }, to: { hash: ME }, log_index: 3 };
    const urls: string[] = [];
    const page = await fetchEvmHistory(tokenCfg, ME, { limit: 50 }, async (url) => {
      urls.push(url);
      if (url.includes("/token-transfers")) return { items: [sent, received], next_page_params: null };
      // The address's own transactions: the send (fee 0.0000708 ETH) and an
      // unrelated one someone else sent.
      return {
        items: [
          v2Tx({ hash: "0x2C9A", from: { hash: ME }, to: { hash: tokenCfg.tokenContract }, fee: { value: "70849000000000" } }),
          v2Tx({ hash: "0x7777", fee: { value: "1" } }),
        ],
        next_page_params: null,
      };
    });
    expect(urls[1]).toBe(`https://eth.blockscout.com/api/v2/addresses/${ME}/transactions`);
    expect(page.items.find((t) => t.hash === "0x2c9a")?.fee).toBe("0.000070849");
    // The receiver pays no fee; nothing is borrowed from someone else's transaction.
    expect(page.items.find((t) => t.hash === "0x7777")?.fee).toBeUndefined();
  });

  it("…and when that read fails, the transfers still load, fee unknown", async () => {
    const page = await fetchEvmHistory(
      {
        chain: "usdc-eth",
        displayName: "USDC (Ethereum)",
        explorers: [blockscoutV2("https://eth.blockscout.com")],
        tokenContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        decimals: 6,
      },
      ME,
      undefined,
      async (url) => {
        if (url.includes("/token-transfers")) {
          return {
            items: [{ transaction_hash: "0x2c9a", from: { hash: ME }, to: { hash: OTHER }, total: { value: "1" }, block_number: 1 }],
            next_page_params: null,
          };
        }
        throw new Error(BLOCKSCOUT_429);
      },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].fee).toBeUndefined();
  });
});
