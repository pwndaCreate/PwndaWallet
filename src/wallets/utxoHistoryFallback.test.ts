/**
 * Dogecoin and Dash history when BlockCypher and Blockchair refuse
 * (operator request, 2026-10-01: Activity read "rate limited: Dogecoin,
 * Dash").
 *
 *  - DOGE's only history source was Blockchair (430, IP blacklisted, from the
 *    operator's machine on 2026-09-30). Now Bitcore (`api.bitcore.io`, on the
 *    Rust proxy allowlist, the DOGE balance's first source) answers when it
 *    refuses.
 *  - DASH's only history source was BlockCypher (`429 {"error": "Limits
 *    reached."}`). Now Insight (`insight.dash.org`, on the allowlist, the DASH
 *    balance's first source) is read first, BlockCypher second.
 *
 * Layouts are the live answers read for the world-public test seed's
 * addresses on 2026-10-01; txids and the other parties' addresses invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProxyReq = { method: string; url: string; body?: string };
const proxy = vi.hoisted(() => ({
  routes: [] as Array<[string, () => { status: number; body: string }]>,
  calls: [] as string[],
}));

vi.mock("../lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args: ProxyReq) => {
    if (cmd !== "http_proxy_call") throw new Error(`unexpected invoke ${cmd}`);
    proxy.calls.push(args.url);
    const hit = proxy.routes.find(([prefix]) => args.url.startsWith(prefix));
    return { ...(hit ? hit[1]() : { status: 404, body: "no route" }), headers: [] };
  }),
}));

import { BITCORE_DOGE_COINS, bitcoreCoinsToTxs, clearDogeHistoryCache, dogeAdapter } from "./doge-wallet";
import { dashAdapter, insightTxToChainTx } from "./dash-wallet";

const ok = (body: unknown) => () => ({ status: 200, body: JSON.stringify(body) });
const refused = (status: number, body: unknown) => () => ({ status, body: JSON.stringify(body) });
const BLOCKCHAIR_430 = refused(430, { data: null, context: { code: 430, error: "Your IP address is temporary blacklisted" } });
const BLOCKCYPHER_429 = refused(429, { error: "Limits reached." });

beforeEach(() => {
  proxy.routes = [];
  proxy.calls = [];
});
afterEach(() => {
  clearDogeHistoryCache();
  vi.clearAllMocks();
});

// =========================================================================
// DOGE — Blockchair, then Bitcore
// =========================================================================

describe("DOGE history: Bitcore when Blockchair refuses", () => {
  const ME = "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC"; // the public test seed's
  const BITCORE = "https://api.bitcore.io/api/DOGE/mainnet";
  const tx = (n: string) => n.repeat(64 / n.length);
  /** One coin in Bitcore's live layout. */
  const coin = (mintTxid: string, mintHeight: number, value: number, spentTxid = "", spentHeight = -2) => ({
    chain: "DOGE",
    network: "mainnet",
    coinbase: false,
    mintIndex: 0,
    spentTxid,
    mintTxid,
    mintHeight,
    spentHeight,
    address: ME,
    script: "76a9144a483568665dcdfa68dd58a1f62893448a64333988ac",
    value,
    confirmations: -1,
    sequenceNumber: 4294967295,
  });
  /** Bitcore's `/tx/{txid}` in its live layout. */
  const detail = (txid: string, height: number, iso: string, fee: number) => ({
    txid,
    network: "mainnet",
    chain: "DOGE",
    blockHeight: height,
    blockHash: "39".repeat(32),
    blockTime: iso,
    blockTimeNormalized: iso,
    coinbase: false,
    locktime: -1,
    inputCount: 1,
    outputCount: 1,
    size: 191,
    fee,
    value: 212527260000,
    confirmations: 279727,
  });

  it("Blockchair 430: the coins from Bitcore make the rows, each with its time and fee", async () => {
    // Was: Blockchair was the only source, so this read failed and Activity
    // said "rate limited: Dogecoin".
    proxy.routes = [
      ["https://api.blockchair.com/", BLOCKCHAIR_430],
      [`${BITCORE}/address/${ME}/txs?limit=${BITCORE_DOGE_COINS}`, ok([coin(tx("d1"), 6116929, 214674000000, tx("8a"), 6116929), coin(tx("3c"), 5864041, 1500000000, tx("9f"), 5864041)])],
      [`${BITCORE}/tx/${tx("8a")}`, ok(detail(tx("8a"), 6116929, "2026-03-09T19:54:16.000Z", 2146740000))],
      [`${BITCORE}/tx/${tx("d1")}`, ok(detail(tx("d1"), 6116929, "2026-03-09T19:54:16.000Z", 2000000))],
      [`${BITCORE}/tx/${tx("9f")}`, ok(detail(tx("9f"), 5864041, "2025-09-05T08:57:06.000Z", 1000000))],
      [`${BITCORE}/tx/${tx("3c")}`, ok(detail(tx("3c"), 5864041, "2025-09-05T08:57:06.000Z", 1000000))],
    ];
    const { items } = await dogeAdapter.getTransactionHistory(ME, { limit: 25 });
    expect(items.map((r) => [r.hash.slice(0, 2), r.direction, r.amount])).toEqual([
      ["d1", "in", "2146.74000000"],
      ["8a", "out", "2146.74000000"],
      ["3c", "in", "15.00000000"],
      ["9f", "out", "15.00000000"],
    ]);
    const spend = items.find((r) => r.hash === tx("8a"))!;
    expect(spend).toMatchObject({
      fee: "21.46740000",
      height: 6116929,
      timestamp: Date.parse("2026-03-09T19:54:16.000Z") / 1000,
      meta: { netSat: -214674000000, source: "api.bitcore.io" },
    });
    expect(spend.confirmations).toBeUndefined();
    expect(items.find((r) => r.hash === tx("d1"))!.fee).toBeUndefined();
  });

  it("a coin's mint and spend net per transaction: a send whose change came back is one 'out' of the difference", () => {
    // Coin A (1.0) spent by S, which minted change coin B (0.6999) back here.
    const txs = bitcoreCoinsToTxs(
      [coin(tx("bb"), 200, 69_990_000), coin(tx("aa"), 100, 100_000_000, tx("bb"), 200)],
      ME,
    );
    expect(txs).toEqual([
      { txid: tx("bb"), net: -30_010_000, height: 200 },
      { txid: tx("aa"), net: 100_000_000, height: 100 },
    ]);
  });

  it("a transaction still in the mempool comes first, with no height and a count of 0", async () => {
    proxy.routes = [
      ["https://api.blockchair.com/", BLOCKCHAIR_430],
      [`${BITCORE}/address/`, ok([coin(tx("e1"), -1, 5_000_000), coin(tx("c1"), 6000000, 1_000_000)])],
      [`${BITCORE}/tx/${tx("e1")}`, ok(detail(tx("e1"), -1, "2026-10-01T00:00:00.000Z", 0))],
      [`${BITCORE}/tx/${tx("c1")}`, ok(detail(tx("c1"), 6000000, "2026-01-01T00:00:00.000Z", 0))],
    ];
    const { items } = await dogeAdapter.getTransactionHistory(ME);
    expect(items[0]).toMatchObject({ hash: tx("e1"), direction: "in", confirmations: 0 });
    expect(items[0].height).toBeUndefined();
  });

  it("a confirmed transaction's time and fee are read once per session", async () => {
    proxy.routes = [
      ["https://api.blockchair.com/", BLOCKCHAIR_430],
      [`${BITCORE}/address/`, ok([coin(tx("c2"), 6000000, 1_000_000)])],
      [`${BITCORE}/tx/${tx("c2")}`, ok(detail(tx("c2"), 6000000, "2026-01-01T00:00:00.000Z", 0))],
    ];
    await dogeAdapter.getTransactionHistory(ME);
    await dogeAdapter.getTransactionHistory(ME);
    expect(proxy.calls.filter((u) => u.startsWith(`${BITCORE}/tx/`))).toHaveLength(1);
  });

  it("both refusing throws, naming each source", async () => {
    proxy.routes = [
      ["https://api.blockchair.com/", BLOCKCHAIR_430],
      [`${BITCORE}/`, refused(503, { error: "unavailable" })],
    ];
    await expect(dogeAdapter.getTransactionHistory(ME)).rejects.toThrow(
      /All 2 DOGE source\(s\) failed — blockchair: HTTP 430 .*; bitcore: HTTP 503/,
    );
  });

  describe("Blockchair, still the first source", () => {
    const address = (txids: string[]) => ({ data: { [ME]: { address: { received: 0, spent: 0 }, transactions: txids } } });
    const txDash = (txid: string, blockId: number) => ({
      transaction: { hash: txid, time: "2026-09-30 10:00:00", block_id: blockId, fee: 2_260_000 },
      inputs: [{ recipient: "DInventedSenderAddressxxxxxxxxxxxxx", value: 102_260_000 }],
      outputs: [{ recipient: ME, value: 100_000_000 }],
    });

    it("answers as before; a mempool row (block_id -1) no longer reads as mined at height -1", async () => {
      proxy.routes = [
        [`https://api.blockchair.com/dogecoin/dashboards/address/${ME}`, ok(address([tx("f1"), tx("f2")]))],
        ["https://api.blockchair.com/dogecoin/dashboards/transactions/", ok({ data: { [tx("f1")]: txDash(tx("f1"), -1), [tx("f2")]: txDash(tx("f2"), 6000000) } })],
      ];
      const { items } = await dogeAdapter.getTransactionHistory(ME);
      expect(items.map((r) => [r.hash.slice(0, 2), r.direction, r.amount, r.height, r.confirmations])).toEqual([
        ["f1", "in", "1.00000000", undefined, 0],
        ["f2", "in", "1.00000000", 6000000, undefined],
      ]);
      expect(proxy.calls.some((u) => u.startsWith("https://api.bitcore.io/"))).toBe(false);
    });

    it("every detail batch failing is a failed read: Bitcore is asked, not 'no transactions'", async () => {
      proxy.routes = [
        [`https://api.blockchair.com/dogecoin/dashboards/address/${ME}`, ok(address([tx("f3")]))],
        ["https://api.blockchair.com/dogecoin/dashboards/transactions/", BLOCKCHAIR_430],
        [`${BITCORE}/address/`, ok([coin(tx("f3"), 6000000, 100_000_000)])],
        [`${BITCORE}/tx/${tx("f3")}`, ok(detail(tx("f3"), 6000000, "2026-09-30T10:00:00.000Z", 0))],
      ];
      const { items } = await dogeAdapter.getTransactionHistory(ME);
      expect(items.map((r) => [r.hash.slice(0, 2), r.meta?.source])).toEqual([["f3", "api.bitcore.io"]]);
    });
  });
});

// =========================================================================
// DASH — Insight, then BlockCypher
// =========================================================================

describe("DASH history: Insight first, BlockCypher second", () => {
  const ME = "XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5"; // the public test seed's
  const THEM = "XyEESvmAig9ypH3yuHXLTuJZsAU9fKxj4W";
  const SENDER = "XeZCVj3o3KG5uLBWWPyaQcooMreFSigDFV";
  const INSIGHT = `https://insight.dash.org/insight-api/addrs/${ME}/txs`;
  /** One Insight transaction in its live layout (scripts trimmed). */
  const insightTx = (
    txid: string,
    vin: Array<[string, number]>,
    vout: Array<[string, string]>,
    height = 1988337,
  ) => ({
    txid,
    version: 1,
    locktime: 0,
    vin: vin.map(([addr, valueSat], n) => ({ txid: "77".repeat(32), vout: 0, sequence: 4294967295, n, addr, valueSat, value: valueSat / 1e8, doubleSpentTxID: null })),
    vout: vout.map(([addr, value], n) => ({ value, n, scriptPubKey: { addresses: [addr], type: "pubkeyhash" }, spentTxId: null, spentIndex: null, spentHeight: null })),
    blockhash: height > 0 ? "00".repeat(32) : undefined,
    blockheight: height,
    confirmations: height > 0 ? 559509 : 0,
    time: 1702665932,
    blocktime: height > 0 ? 1702665932 : undefined,
    valueOut: 0.001172,
    size: 191,
    valueIn: 0.00122,
    fees: 0.000048,
    txlock: true,
  });

  it("BlockCypher refusing (429, live) no longer leaves Dash without history", async () => {
    // Was: BlockCypher was the only source, so this read failed and Activity
    // said "rate limited: Dash".
    proxy.routes = [
      ["https://api.blockcypher.com/", BLOCKCYPHER_429],
      [INSIGHT, ok({ totalItems: 2, from: 0, to: 2, items: [insightTx("35".repeat(32), [[ME, 122000]], [[THEM, "0.00117200"]]), insightTx("77".repeat(32), [[SENDER, 200000]], [[ME, "0.00122000"], [SENDER, "0.00071220"]], 1988331)] })],
    ];
    const { items } = await dashAdapter.getTransactionHistory(ME);
    expect(items.map((r) => [r.direction, r.amount, r.fee])).toEqual([
      ["out", "0.00122000", "0.00004800"],
      ["in", "0.00122000", undefined],
    ]);
    expect(proxy.calls.some((u) => u.startsWith("https://api.blockcypher.com/"))).toBe(false);
  });

  it("an Insight row names every input and output, its fee and net, for the details and the account merge", () => {
    const row = insightTxToChainTx(insightTx("35".repeat(32), [[ME, 122000]], [[THEM, "0.00117200"]]), ME);
    expect(row).toMatchObject({
      chain: "dash",
      direction: "out",
      amount: "0.00122000",
      fee: "0.00004800",
      counterparty: THEM,
      height: 1988337,
      confirmations: 559509,
      timestamp: 1702665932,
      meta: { netSat: -122000, feeSat: 4800, source: "insight.dash.org", inputs: [ME], outputs: [THEM] },
    });
    const pending = insightTxToChainTx(insightTx("36".repeat(32), [[SENDER, 200000]], [[ME, "0.00100000"]], -1), ME);
    expect(pending).toMatchObject({ direction: "in", amount: "0.00100000", confirmations: 0, timestamp: 1702665932 });
    expect(pending.height).toBeUndefined();
  });

  it("asks Insight for at most 50 (it refuses more: `range should be less than or equal to 50`)", async () => {
    proxy.routes = [[INSIGHT, ok({ totalItems: 0, from: 0, to: 0, items: [] })]];
    await dashAdapter.getTransactionHistory(ME, { limit: 200 });
    expect(proxy.calls[0]).toBe(`${INSIGHT}?from=0&to=50`);
  });

  it("Insight failing: BlockCypher's txrefs answer, as before", async () => {
    proxy.routes = [
      [INSIGHT, refused(503, '"from" (0) and "to" (51) range should be less than or equal to 50')],
      [
        `https://api.blockcypher.com/v1/dash/main/addrs/${ME}?`,
        ok({ txrefs: [{ tx_hash: "12".repeat(32), block_height: 2000000, confirmations: 10, confirmed: "2026-09-01T00:00:00Z", spent: false, tx_input_n: -1, tx_output_n: 0, value: 5_000_000 }] }),
      ],
    ];
    const { items } = await dashAdapter.getTransactionHistory(ME);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ direction: "in", amount: "0.05000000" });
  });

  it("both refusing throws, naming each source", async () => {
    proxy.routes = [
      [INSIGHT, refused(503, "unavailable")],
      ["https://api.blockcypher.com/", BLOCKCYPHER_429],
    ];
    await expect(dashAdapter.getTransactionHistory(ME)).rejects.toThrow(
      /All 2 DASH source\(s\) failed — insight: HTTP 503.*; blockcypher: HTTP 429/,
    );
  });
});
