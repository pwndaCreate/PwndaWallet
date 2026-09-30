/**
 * TRON history fallback (operator report 2026-09-30: TRX in the Activity
 * header's error list).
 *
 * TronGrid 429s a keyless client past ~3 requests a second. The TRX reader's
 * fallback asked TronStack for the same `/v1/accounts/<a>/transactions` path,
 * and TronStack serves no `/v1/*` at all — read 2026-09-30 for the test
 * seed's address: `HTTP 404`, nginx "404 Not Found" page. So a TronGrid 429
 * became the pair's error, reported as
 *
 *     HTTP 404 from https://api.tronstack.io/v1/accounts/TPrkFhZ8…/transactions?limit=50&only_confirmed=true: <html>…404 Not Found…
 *
 * (reproduced against the base commit's adapter with TronGrid's 429
 * simulated and TronStack real). TronScan's public API
 * (`apilist.tronscanapi.com`, allowlisted) is the fallback now; it answered
 * 41 TRX transfers for the same address.
 *
 * Fixtures keep the live responses' shape (2026-09-30), trimmed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_proxy", () => ({
  proxyGetJson: vi.fn(),
  proxyPostJson: vi.fn(),
  httpProxyCall: vi.fn(),
}));

import { httpProxyCall, proxyGetJson } from "./_proxy";
import { TRONGRID_RATE, trxAdapter } from "./trx-wallet";
import { usdtTronAdapter } from "./trc20-wallet";
import {
  fetchTrxHistory,
  trongridTrc20Row,
  trongridTrxRow,
  tronscanTrc20Row,
  tronscanTrxRow,
} from "./tron-history";

const ME = "TPrkFhZ8LH8Mruco8vXyA496TaeFBrbmeU";
const PEER = "TGZpbHGcKJwq6oX9VhJnbENsntjpk1gkCv";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRONGRID_429 = (url: string) =>
  new Error(`HTTP 429 from ${url}: {"Error":"request rate exceeded the allowed_rps(3)"}`);
const TRONSTACK_404 = (url: string) =>
  new Error(`HTTP 404 from ${url}: <html>\r\n<head><title>404 Not Found</title></head>`);

/** TronGrid `/v1/accounts/<a>/transactions` item (live shape). */
const trongridTransfer = {
  ret: [{ contractRet: "SUCCESS", fee: 0 }],
  txID: "4e2833df3963c5f328ea09d249055336dce2fcdc706c278bc1b4f00f4825167b",
  net_usage: 268,
  net_fee: 0,
  energy_fee: 0,
  blockNumber: 86405017,
  block_timestamp: 1789887306000,
  raw_data: {
    contract: [
      {
        parameter: {
          value: {
            amount: 8000000,
            owner_address: "419858effd232b4033e47d90003d41ec34ecaeda94",
            to_address: "41485c9b41cc3c6ffc22002e468f392ad8b69fc611",
          },
        },
        type: "TransferContract",
      },
    ],
  },
};

/** TronScan `/api/transfer/trx` item (live shape). */
const tronscanTransfer = {
  amount: "8000000",
  block_timestamp: 1789887306000,
  block: 86405017,
  from: ME,
  to: PEER,
  hash: "4e2833df3963c5f328ea09d249055336dce2fcdc706c278bc1b4f00f4825167b",
  confirmed: 1,
  contract_type: "TransferContract",
  contract_ret: "SUCCESS",
  revert: 0,
};

/** TronScan `/api/token_trc20/transfers` item (live shape). */
const tronscanUsdt = {
  transaction_id: "1427f6a4293c41189a7cbc446377addafb5dc91f686aca93c2b946000a8f450c",
  status: 0,
  block_ts: 1786512348000,
  from_address: ME,
  to_address: "TJYiBmqg6gK5oaerGFznH1dVm5bmgCs1SE",
  block: 85280438,
  contract_address: USDT,
  quant: "100",
  event_type: "Transfer",
  confirmed: true,
  contractRet: "SUCCESS",
  finalResult: "SUCCESS",
};

const toBase58 = (hex: string) =>
  hex === "419858effd232b4033e47d90003d41ec34ecaeda94" ? ME : hex === "41485c9b41cc3c6ffc22002e468f392ad8b69fc611" ? PEER : "T?";

const savedSpacing = TRONGRID_RATE.minSpacingMs;
beforeEach(() => {
  TRONGRID_RATE.minSpacingMs = 0;
  vi.mocked(proxyGetJson).mockReset();
  vi.mocked(httpProxyCall).mockReset();
  // No test here may reach a real host (the pre-fix TRC-20 reader fetched
  // TronGrid directly).
  vi.stubGlobal("fetch", vi.fn(async (u: unknown) => {
    throw TRONGRID_429(String(u));
  }));
});
afterEach(() => {
  TRONGRID_RATE.minSpacingMs = savedSpacing;
  vi.unstubAllGlobals();
});

/** The proxy as the live hosts behaved: TronGrid rate-limited, TronStack no /v1, TronScan answering. */
function liveLikeProxy() {
  vi.mocked(proxyGetJson).mockImplementation(async (url: string) => {
    if (url.startsWith("https://api.trongrid.io/")) throw TRONGRID_429(url);
    if (url.startsWith("https://api.tronstack.io/v1/")) throw TRONSTACK_404(url);
    if (url.startsWith("https://apilist.tronscanapi.com/api/transfer/trx?")) return { data: [tronscanTransfer] };
    if (url.startsWith("https://apilist.tronscanapi.com/api/token_trc20/transfers?")) {
      return { total: 1, token_transfers: [tronscanUsdt] };
    }
    throw new Error(`unexpected url ${url}`);
  });
  vi.mocked(httpProxyCall).mockImplementation(async (o: { url: string }) => ({
    status: 404,
    body: "<html>404 Not Found</html>",
    headers: [],
  }));
}

describe("a TronGrid 429 no longer fails TRON history (operator report 2026-09-30)", () => {
  it("TRX: TronScan answers when TronGrid rate-limits", async () => {
    liveLikeProxy();
    const page = await trxAdapter.getTransactionHistory(ME, { limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      hash: tronscanTransfer.hash,
      direction: "out",
      amount: "8.000000",
      height: 86405017,
      counterparty: PEER,
      meta: { source: "apilist.tronscanapi.com" },
    });
    const urls = vi.mocked(proxyGetJson).mock.calls.map(([u]) => u);
    expect(urls.some((u) => u.includes("api.tronstack.io"))).toBe(false);
  });

  it("USDT (TRC-20): TronScan answers when TronGrid rate-limits", async () => {
    liveLikeProxy();
    const page = await usdtTronAdapter.getTransactionHistory(ME, { limit: 50 });
    expect(page.items[0]).toMatchObject({
      hash: tronscanUsdt.transaction_id,
      direction: "out",
      amount: "0.0001",
      height: 85280438,
    });
  });

  it("when both fail, the error names both hosts and TronGrid's 429", async () => {
    await expect(
      fetchTrxHistory(
        ME,
        { limit: 50 },
        {
          tronGrid: async (p) => {
            throw TRONGRID_429(`https://api.trongrid.io${p}`);
          },
          tronScan: async () => {
            throw "http request to https://apilist.tronscanapi.com/api/transfer/trx failed: timeout";
          },
        },
        toBase58,
      ),
    ).rejects.toThrow(
      "every TRX history source failed — api.trongrid.io: HTTP 429 (request rate exceeded the allowed_rps(3)); apilist.tronscanapi.com: http request to https://apilist.tronscanapi.com/api/transfer/trx failed: timeout",
    );
  });

  it("TronGrid first when it answers", async () => {
    const calls: string[] = [];
    const page = await fetchTrxHistory(
      ME,
      { limit: 50 },
      {
        tronGrid: async (p) => {
          calls.push(p);
          return { data: [trongridTransfer], meta: { fingerprint: "fp1" } };
        },
        tronScan: async () => {
          throw new Error("must not be asked");
        },
      },
      toBase58,
    );
    expect(calls).toEqual([`/v1/accounts/${ME}/transactions?limit=50&only_confirmed=true`]);
    expect(page.items[0].meta?.source).toBe("api.trongrid.io");
    expect(JSON.parse(page.cursor!)).toEqual({ s: "tg", p: "fp1" });
  });
});

describe("TRON rows carry what the details view needs", () => {
  it("TRX sent: the fee this wallet paid (0 = free bandwidth) and the block", () => {
    const row = trongridTrxRow(trongridTransfer, ME, toBase58)!;
    expect(row).toMatchObject({ direction: "out", amount: "8.000000", fee: "0.000000", height: 86405017, timestamp: 1789887306 });
    expect(row.confirmations).toBeUndefined(); // read confirmed-only: no count, final
  });

  it("TRX received: no fee (the sender paid it); a failed contract result is `failed`", () => {
    const incoming = {
      ...trongridTransfer,
      ret: [{ contractRet: "SUCCESS", fee: 1100000 }],
      raw_data: {
        contract: [
          {
            ...trongridTransfer.raw_data.contract[0],
            parameter: {
              value: {
                amount: 1,
                owner_address: "41485c9b41cc3c6ffc22002e468f392ad8b69fc611",
                to_address: "419858effd232b4033e47d90003d41ec34ecaeda94",
              },
            },
          },
        ],
      },
    };
    expect(trongridTrxRow(incoming, ME, toBase58)).toMatchObject({ direction: "in", fee: undefined, counterparty: PEER });
    const failed = { ...trongridTransfer, ret: [{ contractRet: "OUT_OF_ENERGY", fee: 1100000 }] };
    expect(trongridTrxRow(failed, ME, toBase58)).toMatchObject({
      direction: "failed",
      fee: "1.100000",
      meta: { failure: "OUT_OF_ENERGY", intended: "out" },
    });
    expect(tronscanTrxRow({ ...tronscanTransfer, contract_ret: "REVERT" }, ME)?.direction).toBe("failed");
  });

  it("TRC-20: an Approval on TronGrid's list is not a transfer", () => {
    const cfg = { chain: "usdt-tron" as const, ticker: "USDT", contract: USDT, decimals: 6 };
    const base = {
      transaction_id: "99313b3bda3c7c0320de2d9555f275c3d6fa4cbf36b19afa843ba0d12cc06e5e",
      token_info: { symbol: "USDT", address: USDT, decimals: 6 },
      block_timestamp: 1772483553000,
      from: "TQ1KrMpqF64R1Vkw1g68gWPbfw1fwvscZf",
      to: ME,
      type: "Transfer",
      value: "100",
    };
    expect(trongridTrc20Row(base, ME, cfg)).toMatchObject({ direction: "in", amount: "0.0001", counterparty: base.from });
    expect(trongridTrc20Row({ ...base, type: "Approval", value: "1000000000000" }, ME, cfg)).toBeNull();
    expect(tronscanTrc20Row({ ...tronscanUsdt, event_type: "Approval" }, ME, cfg)).toBeNull();
  });
});
