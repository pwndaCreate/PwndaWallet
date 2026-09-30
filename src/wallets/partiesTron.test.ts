/**
 * `getTransactionParties` on TRX and USDT (TRC-20) — operator request
 * 2026-09-30: "in the info I can see which address each transaction was sent
 * and received from".
 *
 * Read live on 2026-09-30, one request per endpoint, for the world-public
 * test seed's TRON address TPrkFhZ8LH8Mruco8vXyA496TaeFBrbmeU:
 *  - TronGrid `/wallet/gettransactionbyid` prints `owner_address` /
 *    `to_address` as `41…` hex; `/wallet/gettransactioninfobyid` prints its
 *    logs' contract and topic words with no `41` / `0x`;
 *  - TronScan `/api/transaction-info` prints base58, TRC-20 transfers under
 *    `trc20TransferInfo`;
 *  - both answer an unknown txid with HTTP 200 `{}`;
 *  - a failed USDT transfer (`OUT_OF_ENERGY`) has no log, only calldata.
 *
 * Two hex ↔ base58 pairs below are pinned from those reads, each rendered by
 * a different service than the one that printed the hex, so the conversion
 * is checked against an implementation that is not this wallet's. Other
 * addresses and txids are invented, in the same layout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_proxy", () => ({
  proxyGetJson: vi.fn(),
  proxyPostJson: vi.fn(),
  httpProxyCall: vi.fn(),
}));

import { proxyGetJson } from "./_proxy";
import { TRONGRID_RATE, ethAddressToTron, hexToTronAddress, trxAdapter } from "./trx-wallet";
import { usdtTronAdapter } from "./trc20-wallet";
import { trongridTxParties } from "./tron-history";

const ME = "TPrkFhZ8LH8Mruco8vXyA496TaeFBrbmeU";
const ME_HEX = "419858effd232b4033e47d90003d41ec34ecaeda94";
/** Pinned: TronGrid printed this owner hex for txid a2d16408…, TronScan printed this base58. */
const THKK_HEX = "4155513d10be34026b15011b7e2376d722112f358b";
const THKK = "THkKkv9HXAdRtDavATVTMcf6QoZksB1s69";
/** Pinned: the Transfer topic word in txid 1427f6a4…'s log; TronGrid's TRC-20 list named it TJYi…. */
const TJYI_WORD = "0000000000000000000000005e17185f3bffd3039063fad2e2c9731c112b367b";
const TJYI = "TJYiBmqg6gK5oaerGFznH1dVm5bmgCs1SE";

const USDT_HEX20 = "a614f803b6fd780986a42c78ec9c7f77e6ded13c"; // TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const OTHER_HEX20 = "8bcaad8b10d2410fc0e5452609d8abfea205f379";
const OTHER = ethAddressToTron("0x" + OTHER_HEX20);
const THIRD = ethAddressToTron("0x" + "37".repeat(20));
const TXID = "c7".repeat(32);

const word = (hex20: string) => "0".repeat(24) + hex20;
const TG = "https://api.trongrid.io";
const TS = "https://apilist.tronscanapi.com";

let calls: string[] = [];

/** The proxy answering by URL; `Error`s are thrown as `proxyGetJson` throws them. */
function stub(routes: Array<[string, unknown]>) {
  vi.mocked(proxyGetJson).mockImplementation(async (url: string) => {
    calls.push(url);
    const hit = routes.find(([p]) => url.startsWith(p));
    if (!hit) throw new Error(`TEST TRIPWIRE: unexpected ${url}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  });
}

const http = (status: number, url: string, body = "") => new Error(`HTTP ${status} from ${url}: ${body}`);

/** TronGrid `/wallet/gettransactionbyid` for a TRX transfer. */
function trxById(owner: string, to: string, over: Record<string, unknown> = {}) {
  return {
    raw_data: {
      contract: [
        {
          parameter: { value: { owner_address: owner, to_address: to, amount: 8000000 }, type_url: "type.googleapis.com/protocol.TransferContract" },
          type: "TransferContract",
        },
      ],
      timestamp: 1789887303247,
    },
    ret: [{ contractRet: "SUCCESS" }],
    txID: TXID,
    ...over,
  };
}

/** TronGrid `/wallet/gettransactioninfobyid` for a TRC-20 call. */
function info(logs: unknown[] | undefined, over: Record<string, unknown> = {}) {
  return {
    id: TXID,
    blockNumber: 85280438,
    blockTimeStamp: 1786512348000,
    contract_address: "41" + USDT_HEX20,
    receipt: { energy_usage_total: 64285, net_usage: 346, result: "SUCCESS" },
    ...(logs ? { log: logs } : {}),
    ...over,
  };
}

const usdtLog = (fromHex20: string, toHex20: string, contract = USDT_HEX20) => ({
  address: contract,
  topics: [TOPIC, word(fromHex20), word(toHex20)],
  data: "0000000000000000000000000000000000000000000000000000000000000064",
});

beforeEach(() => {
  calls = [];
  vi.mocked(proxyGetJson).mockReset();
  TRONGRID_RATE.minSpacingMs = 0;
});

describe("hex → base58 agrees with the services' own rendering", () => {
  it("TronGrid's owner hex for a2d16408… is TronScan's THkKkv…", () => {
    expect(hexToTronAddress(THKK_HEX)).toBe(THKK);
    expect(hexToTronAddress(ME_HEX)).toBe(ME);
  });

  it("gettransactionbyid's hex becomes T… parties", () => {
    expect(trongridTxParties(trxById(THKK_HEX, ME_HEX), TXID, hexToTronAddress)).toEqual({ from: [THKK], to: [ME] });
    expect(trongridTxParties({}, TXID, hexToTronAddress)).toBeNull();
    expect(() => trongridTxParties({ Error: "class java.lang.NullPointerException : null" }, TXID, hexToTronAddress)).toThrow(
      /NullPointerException/,
    );
  });
});

describe("TRX — TronGrid gettransactionbyid, then TronScan transaction-info", () => {
  it("send: owner and to_address, from TronGrid, one request", async () => {
    stub([[`${TG}/wallet/gettransactionbyid?value=${TXID}`, trxById(ME_HEX, "41" + OTHER_HEX20)]]);
    expect(await trxAdapter.getTransactionParties!(TXID, ME)).toEqual({ from: [ME], to: [OTHER], source: "api.trongrid.io" });
    expect(calls).toHaveLength(1);
  });

  it("receive, from TronScan when TronGrid is rate-limited", async () => {
    stub([
      [TG, http(429, `${TG}/wallet/gettransactionbyid`, '{"Error":"request rate exceeded"}')],
      [
        `${TS}/api/transaction-info?hash=${TXID}`,
        {
          hash: TXID,
          block: 86405017,
          contractType: 1,
          contractRet: "SUCCESS",
          confirmed: true,
          ownerAddress: THKK,
          toAddress: ME,
          contractData: { amount: 8000000, owner_address: THKK, to_address: ME },
        },
      ],
    ]);
    expect(await trxAdapter.getTransactionParties!(TXID.toUpperCase(), ME)).toEqual({
      from: [THKK],
      to: [ME],
      source: "apilist.tronscanapi.com",
    });
  });

  it("not found: `{}` from TronGrid, so TronScan is asked, `{}` too → null", async () => {
    stub([
      [TG, {}],
      [TS, {}],
    ]);
    expect(await trxAdapter.getTransactionParties!(TXID, ME)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("every source failed: throws, naming both hosts and their status", async () => {
    stub([
      [TG, http(429, `${TG}/wallet/gettransactionbyid`, '{"Error":"request rate exceeded"}')],
      [TS, http(503, `${TS}/api/transaction-info`, "<html>busy</html>")],
    ]);
    await expect(trxAdapter.getTransactionParties!(TXID, ME)).rejects.toThrow(
      "every TRX transaction source failed — api.trongrid.io: HTTP 429 (request rate exceeded); apilist.tronscanapi.com: HTTP 503",
    );
  });

  it("not a txid: null, no request", async () => {
    stub([]);
    expect(await trxAdapter.getTransactionParties!("not-a-hash", ME)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("USDT (TRC-20) — the token transfer's parties, not the transaction's `to` (the contract)", () => {
  it("send: the Transfer log's topics, TJYi… as TronGrid's own list named it; one request", async () => {
    const log = { address: USDT_HEX20, topics: [TOPIC, word(ME_HEX.slice(2)), TJYI_WORD], data: "64".padStart(64, "0") };
    stub([[`${TG}/wallet/gettransactioninfobyid?value=${TXID}`, info([log])]]);
    expect(await usdtTronAdapter.getTransactionParties!(TXID, ME)).toEqual({ from: [ME], to: [TJYI], source: "api.trongrid.io" });
    expect(calls).toHaveLength(1);
  });

  it("several transfers, and another token's: only the USDT transfers involving the wallet", async () => {
    stub([
      [
        `${TG}/wallet/gettransactioninfobyid`,
        info([usdtLog("37".repeat(20), OTHER_HEX20), usdtLog(OTHER_HEX20, ME_HEX.slice(2)), usdtLog(ME_HEX.slice(2), OTHER_HEX20, "11".repeat(20))]),
      ],
    ]);
    expect(await usdtTronAdapter.getTransactionParties!(TXID, ME)).toMatchObject({ from: [OTHER], to: [ME] });
    // None involving the asker: all of this token's.
    expect(await usdtTronAdapter.getTransactionParties!(TXID, "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf")).toMatchObject({
      from: [THIRD, OTHER],
      to: [OTHER, ME],
    });
  });

  it("failed on chain (OUT_OF_ENERGY, no log): the calldata names whom it was for", async () => {
    stub([
      [
        `${TG}/wallet/gettransactioninfobyid`,
        info(undefined, { receipt: { net_usage: 345, result: "OUT_OF_ENERGY" }, result: "FAILED", contractResult: [""] }),
      ],
      [
        `${TG}/wallet/gettransactionbyid`,
        {
          raw_data: {
            contract: [
              {
                parameter: {
                  value: {
                    owner_address: ME_HEX,
                    contract_address: "41" + USDT_HEX20,
                    data: "a9059cbb" + word(OTHER_HEX20) + "000000000000000000000000000000000000000000000000000001210f76ea40",
                  },
                  type_url: "type.googleapis.com/protocol.TriggerSmartContract",
                },
                type: "TriggerSmartContract",
              },
            ],
            fee_limit: 9000000,
          },
          ret: [{ contractRet: "OUT_OF_ENERGY" }],
          txID: TXID,
        },
      ],
    ]);
    expect(await usdtTronAdapter.getTransactionParties!(TXID, ME)).toEqual({ from: [ME], to: [OTHER], source: "api.trongrid.io" });
  });

  it("receive, from TronScan's trc20TransferInfo when TronGrid is down", async () => {
    stub([
      [TG, http(503, `${TG}/wallet/gettransactioninfobyid`)],
      [
        `${TS}/api/transaction-info?hash=${TXID}`,
        {
          hash: TXID,
          contractType: 31,
          contractRet: "SUCCESS",
          ownerAddress: "TQ1KrMpqF64R1Vkw1g68gWPbfw1fwvscZf",
          toAddress: USDT,
          contractData: { data: "a9059cbb" + word(ME_HEX.slice(2)) + "64".padStart(64, "0"), owner_address: "TQ1KrMpqF64R1Vkw1g68gWPbfw1fwvscZf", contract_address: USDT },
          trc20TransferInfo: [
            { symbol: "USDT", contract_address: USDT, type: "Transfer", decimals: 6, from_address: "TQ1KrMpqF64R1Vkw1g68gWPbfw1fwvscZf", to_address: ME, amount_str: "100", status: 0 },
          ],
        },
      ],
    ]);
    expect(await usdtTronAdapter.getTransactionParties!(TXID, ME)).toEqual({
      from: ["TQ1KrMpqF64R1Vkw1g68gWPbfw1fwvscZf"],
      to: [ME],
      source: "apilist.tronscanapi.com",
    });
  });

  it("TronScan, failed transfer (no trc20TransferInfo): its contractData calldata", async () => {
    stub([
      [TG, http(429, `${TG}/wallet/gettransactioninfobyid`)],
      [
        TS,
        {
          hash: TXID,
          contractType: 31,
          contractRet: "REVERT",
          ownerAddress: ME,
          toAddress: USDT,
          contractData: { data: "a9059cbb" + word(OTHER_HEX20) + "1".padStart(64, "0"), owner_address: ME, contract_address: USDT },
        },
      ],
    ]);
    expect(await usdtTronAdapter.getTransactionParties!(TXID, ME)).toMatchObject({ from: [ME], to: [OTHER] });
  });

  it("not executed yet or unknown: `{}` from both → null", async () => {
    stub([
      [TG, {}],
      [TS, {}],
    ]);
    expect(await usdtTronAdapter.getTransactionParties!(TXID, ME)).toBeNull();
  });

  it("every source failed: throws with the leg's ticker", async () => {
    stub([
      [TG, http(429, `${TG}/wallet/gettransactioninfobyid`)],
      [TS, new Error("host 'apilist.tronscanapi.com' timed out")],
    ]);
    await expect(usdtTronAdapter.getTransactionParties!(TXID, ME)).rejects.toThrow(
      "every USDT transaction source failed — api.trongrid.io: HTTP 429; apilist.tronscanapi.com: host 'apilist.tronscanapi.com' timed out",
    );
  });
});
