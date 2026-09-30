/**
 * `getTransactionParties` on the UTXO adapters (BTC, LTC, BCH, DOGE, DASH,
 * RVN) — operator request 2026-09-30: "in the info I can see which address
 * each transaction was sent and received from".
 *
 * Every explorer's answer below keeps the field layout read live on
 * 2026-09-30 (one read-only request per endpoint, the world-public test
 * seed's addresses), trimmed to what the reader uses; txids and third-party
 * addresses are invented. BlockCypher 429'd every probe from this machine
 * (`{"error": "Limits reached."}`), so its layout is the one its docs and this
 * repo's own BlockCypher readers (`BlockCypherFullTx`) use.
 *
 * Each explorer answers an UNKNOWN txid in its own way, and those exact
 * shapes are pinned too: a dead route's 404 page must never pass for "the
 * chain does not know this transaction".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_proxy", () => ({
  httpProxyCall: vi.fn(),
  proxyGetJson: vi.fn(),
  proxyPostJson: vi.fn(),
}));

import { httpProxyCall } from "./_proxy";
import { readUtxoAnswer, type HttpAnswer } from "./parties-a-utxo";
import { btcAdapter } from "./btc-wallet";
import { ltcAdapter } from "./ltc-wallet";
import { bchAdapter, encodeCashAddr } from "./bch-wallet";
import { dogeAdapter } from "./doge-wallet";
import { dashAdapter } from "./dash-wallet";
import { rvnAdapter } from "./rvn-wallet";

// The world-public test seed's addresses ("abandon … about").
const BTC_ME = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const LTC_ME = "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh";
const BCH_ME = "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6";
const DASH_ME = "XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5";
const RVN_ME = "RDjNvZL1TJQ7R8L23jDutdEioQG4eTC38V";
const DOGE_ME = "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC";

const TXID = "a1".repeat(32);
const ok = (body: unknown): HttpAnswer => ({ status: 200, body: JSON.stringify(body) });

/** Esplora `/tx/:txid`, as blockstream.info / mempool.space / litecoinspace print it. */
function esplora(over: Record<string, unknown> = {}) {
  return {
    txid: TXID,
    version: 1,
    vin: [
      { txid: "b2".repeat(32), vout: 0, prevout: { scriptpubkey_type: "v0_p2wpkh", scriptpubkey_address: "bc1qsomeoneelse0000000000000000000000000", value: 294 }, is_coinbase: false },
      { txid: "b3".repeat(32), vout: 0, prevout: { scriptpubkey_type: "v0_p2wpkh", scriptpubkey_address: BTC_ME, value: 670 }, is_coinbase: false },
      // A second input from the same address: listed once.
      { txid: "b4".repeat(32), vout: 1, prevout: { scriptpubkey_type: "v0_p2wpkh", scriptpubkey_address: BTC_ME, value: 1000 }, is_coinbase: false },
    ],
    vout: [
      { scriptpubkey_type: "v0_p2wpkh", scriptpubkey_address: "bc1qrecipient000000000000000000000000000", value: 700 },
      // An OP_RETURN has no address (the test address's sweeps burn to one).
      { scriptpubkey: "6a0400000000", scriptpubkey_asm: "OP_RETURN OP_PUSHBYTES_4 00000000", scriptpubkey_type: "op_return", value: 0 },
      { scriptpubkey_type: "v0_p2wpkh", scriptpubkey_address: BTC_ME, value: 100 },
    ],
    fee: 164,
    status: { confirmed: true, block_height: 956025, block_time: 1782796117 },
    ...over,
  };
}

let fetchCalls: string[] = [];
let proxyCalls: string[] = [];

beforeEach(() => {
  fetchCalls = [];
  proxyCalls = [];
  vi.mocked(httpProxyCall).mockReset();
  vi.unstubAllGlobals();
});

/** `fetch` answering by URL prefix; anything else is a test bug. */
function stubFetch(routes: Array<[string, HttpAnswer | Error]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      const hit = routes.find(([p]) => url.startsWith(p));
      if (!hit) throw new Error(`TEST TRIPWIRE: unexpected fetch ${url}`);
      if (hit[1] instanceof Error) throw hit[1];
      return new Response(hit[1].body, { status: hit[1].status });
    }),
  );
}

/** The Rust proxy answering by URL prefix. */
function stubProxy(routes: Array<[string, HttpAnswer | Error]>) {
  vi.mocked(httpProxyCall).mockImplementation(async ({ url }) => {
    proxyCalls.push(url);
    const hit = routes.find(([p]) => url.startsWith(p));
    if (!hit) throw new Error(`TEST TRIPWIRE: unexpected proxy call ${url}`);
    if (hit[1] instanceof Error) throw hit[1];
    return { status: hit[1].status, body: hit[1].body, headers: [] };
  });
}

describe("each explorer's transaction, read as parties", () => {
  it("Esplora: every input address and every output address, once each, bare scripts skipped", () => {
    expect(readUtxoAnswer("esplora", ok(esplora()), TXID)).toEqual({
      from: ["bc1qsomeoneelse0000000000000000000000000", BTC_ME],
      to: ["bc1qrecipient000000000000000000000000000", BTC_ME],
    });
  });

  it("Esplora: a coinbase input (prevout null) names no sender", () => {
    const coinbase = esplora({ vin: [{ txid: "0".repeat(64), vout: 4294967295, prevout: null, is_coinbase: true }] });
    expect(readUtxoAnswer("esplora", ok(coinbase), TXID)?.from).toEqual([]);
  });

  it("BlockCypher: `inputs[].addresses` / `outputs[].addresses`; an OP_RETURN's addresses are null", () => {
    const tx = {
      hash: TXID,
      block_height: 2_300_000,
      confirmations: 12,
      fees: 2260,
      inputs: [{ prev_hash: "c1".repeat(32), output_index: 1, output_value: 50_000, addresses: [DASH_ME], script_type: "pay-to-pubkey-hash" }],
      outputs: [
        { value: 40_000, addresses: ["XyEESvmAig9ypH3yuHXLTuJZsAU9fKxj4W"], script_type: "pay-to-pubkey-hash" },
        { value: 0, addresses: null, script_type: "null-data", data_hex: "00" },
        { value: 7_740, addresses: [DASH_ME], script_type: "pay-to-pubkey-hash" },
      ],
    };
    expect(readUtxoAnswer("blockcypher", ok(tx), TXID)).toEqual({
      from: [DASH_ME],
      to: ["XyEESvmAig9ypH3yuHXLTuJZsAU9fKxj4W", DASH_ME],
    });
  });

  it("Blockchair: `data[txid].inputs[].recipient` / `outputs[].recipient`", () => {
    const body = {
      data: {
        [TXID]: {
          transaction: { block_id: 3184742, hash: TXID, time: "2026-09-26 14:46:03", fee: 13337 },
          inputs: [{ index: 0, value: 26674, recipient: LTC_ME, type: "witness_v0_keyhash", is_from_coinbase: false }],
          outputs: [{ index: 0, value: 13337, recipient: "ltc1qmpulet0rhxmpd2sy6upd8kgw9rjt67sls0wmc3", type: "witness_v0_keyhash" }],
        },
      },
      context: { code: 200, results: 1, state: 3187050 },
    };
    expect(readUtxoAnswer("blockchair", ok(body), TXID)).toEqual({
      from: [LTC_ME],
      to: ["ltc1qmpulet0rhxmpd2sy6upd8kgw9rjt67sls0wmc3"],
    });
  });

  it("haskoin: `inputs[].address` (not for a coinbase) / `outputs[].address`", () => {
    const tx = {
      txid: TXID,
      fee: 219,
      inputs: [{ coinbase: false, txid: "d1".repeat(32), output: 1, value: 13672219, address: "bitcoincash:qqa7phd0wdslpmpjktu2qz85y98huz9vyvhm5e7ln3" }],
      outputs: [
        { address: BCH_ME, value: 46858, spent: true },
        { address: null, value: 0, spent: false },
        { address: "bitcoincash:qpz3tvphx9pw9dv2p0v6cw4vsnvamhtpdqx6c0r9g3", value: 13625142, spent: true },
      ],
      block: { height: 963772, position: 45 },
    };
    expect(readUtxoAnswer("haskoin", ok(tx), TXID)).toEqual({
      from: ["bitcoincash:qqa7phd0wdslpmpjktu2qz85y98huz9vyvhm5e7ln3"],
      to: [BCH_ME, "bitcoincash:qpz3tvphx9pw9dv2p0v6cw4vsnvamhtpdqx6c0r9g3"],
    });
  });

  it("BlockBook: `vin[].addresses` / `vout[].addresses`, skipping `isAddress: false` (an OP_RETURN)", () => {
    const tx = {
      txid: TXID,
      vin: [
        { txid: "e1".repeat(32), vout: 1, n: 0, addresses: ["RAyS1GhY9KgKJHX9N6KfTG8pRdU9vy8F7d"], isAddress: true, value: "2000000" },
        { txid: "e2".repeat(32), n: 1, addresses: [RVN_ME], isAddress: true, value: "1000000" },
      ],
      vout: [
        { value: "2504680", n: 0, addresses: ["RKFUXeJhxaSe2FVF8RSA6PtvBHP91iiUKv"], isAddress: true },
        { value: "0", n: 1, addresses: ["OP_RETURN 00"], isAddress: false },
      ],
      blockHeight: 2989949,
      fees: "495320",
    };
    expect(readUtxoAnswer("blockbook", ok(tx), TXID)).toEqual({
      from: ["RAyS1GhY9KgKJHX9N6KfTG8pRdU9vy8F7d", RVN_ME],
      to: ["RKFUXeJhxaSe2FVF8RSA6PtvBHP91iiUKv"],
    });
  });

  it("Insight: `vin[].addr` / `vout[].scriptPubKey.addresses`", () => {
    const tx = {
      txid: TXID,
      vin: [
        { txid: "f1".repeat(32), vout: 0, n: 0, addr: "Xi74oGDCNagLS877dtuUyA5v6PfC6QvmZ5", valueSat: 10000 },
        { txid: "f2".repeat(32), vout: 0, n: 1, addr: "Xi74oGDCNagLS877dtuUyA5v6PfC6QvmZ5", valueSat: 10000 },
        { txid: "f3".repeat(32), vout: 1, n: 2, addr: "Xpnhu28idj5ZzAhk1jR1jBeMk74WY6NFuh", valueSat: 895542 },
      ],
      vout: [
        { value: "0.01000000", n: 0, scriptPubKey: { addresses: [DASH_ME], type: "pubkeyhash" } },
        { value: "0.00005000", n: 1, scriptPubKey: { addresses: ["Xer7BZwHoXoFxBUoLwzmit1TzHuyvx4Z4v"], type: "pubkeyhash" } },
      ],
    };
    expect(readUtxoAnswer("insight", ok(tx), TXID)).toEqual({
      from: ["Xi74oGDCNagLS877dtuUyA5v6PfC6QvmZ5", "Xpnhu28idj5ZzAhk1jR1jBeMk74WY6NFuh"],
      to: [DASH_ME, "Xer7BZwHoXoFxBUoLwzmit1TzHuyvx4Z4v"],
    });
  });
});

describe("each explorer's own 'unknown txid' is null; anything else is a failure", () => {
  const unknown: Array<[Parameters<typeof readUtxoAnswer>[0], HttpAnswer]> = [
    ["esplora", { status: 404, body: "Transaction not found" }],
    ["blockcypher", { status: 404, body: JSON.stringify({ error: `Transaction ${TXID} not found.` }) }],
    ["blockchair", ok({ data: [], context: { code: 200, source: "D", results: 0, state: 3187050 } })],
    ["haskoin", { status: 404, body: JSON.stringify({ error: "not-found-or-invalid-arg", message: "Item not found or argument invalid" }) }],
    ["blockbook", { status: 400, body: JSON.stringify({ error: `Transaction '${TXID}' not found` }) }],
    ["insight", { status: 404, body: "Not found" }],
  ];
  for (const [kind, answer] of unknown) {
    it(`${kind}: ${answer.status} ${answer.body.slice(0, 50)} → null`, () => {
      expect(readUtxoAnswer(kind, answer, TXID)).toBeNull();
    });
  }

  it("a dead route's HTML 404 is a failure, not an unknown txid (rvn.cryptoscope.io → 301 → this, 2026-09-30)", () => {
    const page = { status: 404, body: "<!DOCTYPE html>\n<html lang=\"en\"><head><title>Ravencoin explorer</title></head></html>" };
    expect(() => readUtxoAnswer("insight", page, TXID)).toThrow(/HTTP 404/);
    expect(() => readUtxoAnswer("esplora", page, TXID)).toThrow(/HTTP 404/);
  });

  it("rate limits and blacklists are failures, with the explorer's reason", () => {
    expect(() =>
      readUtxoAnswer("blockcypher", { status: 429, body: JSON.stringify({ error: "Limits reached." }) }, TXID),
    ).toThrow(/HTTP 429.*Limits reached/);
    const blacklisted = {
      status: 430,
      body: JSON.stringify({ data: null, context: { code: 430, error: "Your IP address is temporary blacklisted due to exceeding usage of API resources." } }),
    };
    expect(() => readUtxoAnswer("blockchair", blacklisted, TXID)).toThrow(/HTTP 430.*blacklisted/);
  });

  it("an answer about another transaction is not this one's", () => {
    expect(() => readUtxoAnswer("esplora", ok(esplora({ txid: "c9".repeat(32) })), TXID)).toThrow(/unexpected response/);
  });
});

describe("BTC — Esplora over fetch, blockstream.info then mempool.space", () => {
  it("send: the wallet's inputs are the senders; source names the host that answered", async () => {
    stubFetch([["https://blockstream.info/api/tx/", ok(esplora())]]);
    const p = await btcAdapter.getTransactionParties!(TXID, BTC_ME);
    expect(p).toEqual({
      from: ["bc1qsomeoneelse0000000000000000000000000", BTC_ME],
      to: ["bc1qrecipient000000000000000000000000000", BTC_ME],
      source: "blockstream.info",
    });
    expect(fetchCalls).toEqual([`https://blockstream.info/api/tx/${TXID}`]);
  });

  it("receive, with blockstream.info rate-limited: mempool.space answers", async () => {
    const receive = esplora({
      vin: [{ txid: "b5".repeat(32), vout: 0, prevout: { scriptpubkey_address: "bc1q923wsupdm5xm0ctaahcc7ljfuf2v4ashu8nsem", value: 900 }, is_coinbase: false }],
      vout: [{ scriptpubkey_address: BTC_ME, value: 670 }],
    });
    stubFetch([
      ["https://blockstream.info/", { status: 429, body: "Too Many Requests" }],
      ["https://mempool.space/", ok(receive)],
    ]);
    const p = await btcAdapter.getTransactionParties!(TXID.toUpperCase(), BTC_ME);
    expect(p).toEqual({ from: ["bc1q923wsupdm5xm0ctaahcc7ljfuf2v4ashu8nsem"], to: [BTC_ME], source: "mempool.space" });
  });

  it("not found: blockstream.info does not know it, so mempool.space is asked too — then null", async () => {
    stubFetch([
      ["https://blockstream.info/", { status: 404, body: "Transaction not found" }],
      ["https://mempool.space/", { status: 404, body: "Transaction not found" }],
    ]);
    expect(await btcAdapter.getTransactionParties!(TXID, BTC_ME)).toBeNull();
    expect(fetchCalls).toHaveLength(2);
  });

  it("one host does not know it and the other is down: still null — the chain was asked", async () => {
    stubFetch([
      ["https://blockstream.info/", { status: 404, body: "Transaction not found" }],
      ["https://mempool.space/", new TypeError("Failed to fetch")],
    ]);
    expect(await btcAdapter.getTransactionParties!(TXID, BTC_ME)).toBeNull();
  });

  it("every host failed: throws, naming each host and its status", async () => {
    stubFetch([
      ["https://blockstream.info/", { status: 503, body: "<html>busy</html>" }],
      ["https://mempool.space/", { status: 429, body: "" }],
    ]);
    await expect(btcAdapter.getTransactionParties!(TXID, BTC_ME)).rejects.toThrow(
      "every BTC transaction source failed — blockstream.info: HTTP 503; mempool.space: HTTP 429",
    );
  });

  it("a string that is not a txid (an EVM hash, say) is null without a request", async () => {
    stubFetch([]);
    expect(await btcAdapter.getTransactionParties!("0x" + "ab".repeat(32), BTC_ME)).toBeNull();
    expect(fetchCalls).toEqual([]);
  });
});

describe("LTC — litecoinspace, BlockCypher, Blockchair through the proxy (the history's order)", () => {
  const ltcTx = esplora({
    vin: [{ txid: "b6".repeat(32), vout: 0, prevout: { scriptpubkey_address: LTC_ME, value: 26674 }, is_coinbase: false }],
    vout: [{ scriptpubkey_address: "ltc1qmpulet0rhxmpd2sy6upd8kgw9rjt67sls0wmc3", value: 13337 }],
  });

  it("send, from litecoinspace; nothing else asked", async () => {
    stubProxy([["https://litecoinspace.org/api/tx/", ok(ltcTx)]]);
    expect(await ltcAdapter.getTransactionParties!(TXID, LTC_ME)).toEqual({
      from: [LTC_ME],
      to: ["ltc1qmpulet0rhxmpd2sy6upd8kgw9rjt67sls0wmc3"],
      source: "litecoinspace.org",
    });
    expect(proxyCalls).toEqual([`https://litecoinspace.org/api/tx/${TXID}`]);
  });

  it("receive, from BlockCypher when litecoinspace is down; asked for more than 20 inputs/outputs", async () => {
    stubProxy([
      ["https://litecoinspace.org/", { status: 502, body: "<html>Bad Gateway</html>" }],
      [
        "https://api.blockcypher.com/v1/ltc/main/txs/",
        ok({
          hash: TXID,
          inputs: [{ output_value: 60000, addresses: ["ltc1q38y3q4h79x3klv8gr98nl0ylp5j2gyq3h9dqn4"] }],
          outputs: [
            { value: 20000, addresses: [LTC_ME] },
            { value: 39000, addresses: ["ltc1q38y3q4h79x3klv8gr98nl0ylp5j2gyq3h9dqn4"] },
          ],
        }),
      ],
    ]);
    expect(await ltcAdapter.getTransactionParties!(TXID, LTC_ME)).toEqual({
      from: ["ltc1q38y3q4h79x3klv8gr98nl0ylp5j2gyq3h9dqn4"],
      to: [LTC_ME, "ltc1q38y3q4h79x3klv8gr98nl0ylp5j2gyq3h9dqn4"],
      source: "api.blockcypher.com",
    });
    expect(proxyCalls[1]).toBe(`https://api.blockcypher.com/v1/ltc/main/txs/${TXID}?limit=100`);
  });

  it("not found anywhere that answered: null", async () => {
    stubProxy([
      ["https://litecoinspace.org/", { status: 404, body: "Transaction not found" }],
      ["https://api.blockcypher.com/", { status: 429, body: JSON.stringify({ error: "Limits reached." }) }],
      ["https://api.blockchair.com/", ok({ data: [], context: { code: 200, results: 0 } })],
    ]);
    expect(await ltcAdapter.getTransactionParties!(TXID, LTC_ME)).toBeNull();
    expect(proxyCalls).toHaveLength(3);
  });

  it("every source failed: throws with all three hosts and why", async () => {
    stubProxy([
      ["https://litecoinspace.org/", new Error("host 'litecoinspace.org' timed out")],
      ["https://api.blockcypher.com/", { status: 429, body: JSON.stringify({ error: "Limits reached." }) }],
      [
        "https://api.blockchair.com/",
        { status: 430, body: JSON.stringify({ data: null, context: { code: 430, error: "Your IP address is temporary blacklisted" } }) },
      ],
    ]);
    await expect(ltcAdapter.getTransactionParties!(TXID, LTC_ME)).rejects.toThrow(
      "every LTC transaction source failed — litecoinspace.org: host 'litecoinspace.org' timed out; " +
        "api.blockcypher.com: HTTP 429 (Limits reached.); api.blockchair.com: HTTP 430 (Your IP address is temporary blacklisted)",
    );
  });
});

describe("BCH — haskoin ×2 then Blockchair; addresses in the wallet's own CashAddr form", () => {
  const OTHER_BARE = encodeCashAddr(new Uint8Array(20).fill(7), "p2pkh").replace(/^bitcoincash:/, "");

  it("send, read from the second haskoin deployment when the first fails", async () => {
    stubProxy([
      ["https://api.blockchain.info/", { status: 503, body: "" }],
      [
        "https://api.haskoin.com/bch/transaction/",
        ok({
          txid: TXID,
          inputs: [{ coinbase: false, address: BCH_ME, value: 46858 }],
          outputs: [{ address: "bitcoincash:qr66ftgvaz0rq8m4xh0hsh0x00ah00jucgqwxj6cm8", value: 40037 }],
        }),
      ],
    ]);
    expect(await bchAdapter.getTransactionParties!(TXID, BCH_ME)).toEqual({
      from: [BCH_ME],
      to: ["bitcoincash:qr66ftgvaz0rq8m4xh0hsh0x00ah00jucgqwxj6cm8"],
      source: "api.haskoin.com",
    });
  });

  it("receive, from Blockchair: its bare CashAddr (`qrepx94s…` live) gains the prefix, so it matches the wallet's", async () => {
    stubProxy([
      ["https://api.blockchain.info/", { status: 404, body: JSON.stringify({ error: "not-found-or-invalid-arg", message: "Item not found or argument invalid" }) }],
      ["https://api.haskoin.com/", new Error("error sending request")],
      [
        "https://api.blockchair.com/bitcoin-cash/dashboards/transaction/",
        ok({
          data: {
            [TXID]: {
              transaction: { hash: TXID, block_id: 963641 },
              inputs: [{ recipient: OTHER_BARE, value: 1000000, type: "pubkeyhash" }],
              outputs: [
                { recipient: BCH_ME.replace(/^bitcoincash:/, ""), value: 46858, type: "pubkeyhash" },
                { recipient: OTHER_BARE, value: 950000, type: "pubkeyhash" },
              ],
            },
          },
          context: { code: 200, results: 1 },
        }),
      ],
    ]);
    expect(await bchAdapter.getTransactionParties!(TXID, BCH_ME)).toEqual({
      from: [`bitcoincash:${OTHER_BARE}`],
      to: [BCH_ME, `bitcoincash:${OTHER_BARE}`],
      source: "api.blockchair.com",
    });
  });

  it("not found: null; every source down: throws", async () => {
    const notFound = { status: 404, body: JSON.stringify({ error: "not-found-or-invalid-arg", message: "Item not found or argument invalid" }) };
    stubProxy([
      ["https://api.blockchain.info/", notFound],
      ["https://api.haskoin.com/", notFound],
      ["https://api.blockchair.com/", ok({ data: [], context: { code: 200, results: 0 } })],
    ]);
    expect(await bchAdapter.getTransactionParties!(TXID, BCH_ME)).toBeNull();

    stubProxy([
      ["https://api.blockchain.info/", { status: 500, body: "" }],
      ["https://api.haskoin.com/", { status: 500, body: "" }],
      ["https://api.blockchair.com/", { status: 430, body: JSON.stringify({ data: null, context: { code: 430, error: "blacklisted" } }) }],
    ]);
    await expect(bchAdapter.getTransactionParties!(TXID, BCH_ME)).rejects.toThrow(
      "every BCH transaction source failed — api.blockchain.info: HTTP 500; api.haskoin.com: HTTP 500; api.blockchair.com: HTTP 430 (blacklisted)",
    );
  });
});

describe("DOGE — Blockchair (the history's source), then BlockCypher", () => {
  it("Blockchair blacklisted (430): BlockCypher names the parties", async () => {
    stubProxy([
      ["https://api.blockchair.com/dogecoin/", { status: 430, body: JSON.stringify({ data: null, context: { code: 430, error: "blacklisted" } }) }],
      [
        "https://api.blockcypher.com/v1/doge/main/txs/",
        ok({ hash: TXID, inputs: [{ addresses: ["D8oHWEAe6sBdbbTmwmUXnvLvDmWNMNkyCb"] }], outputs: [{ addresses: [DOGE_ME] }] }),
      ],
    ]);
    expect(await dogeAdapter.getTransactionParties!(TXID, DOGE_ME)).toEqual({
      from: ["D8oHWEAe6sBdbbTmwmUXnvLvDmWNMNkyCb"],
      to: [DOGE_ME],
      source: "api.blockcypher.com",
    });
    expect(proxyCalls[0]).toBe(`https://api.blockchair.com/dogecoin/dashboards/transaction/${TXID}`);
  });
});

describe("DASH — BlockCypher (txrefs carry no addresses), Blockchair, Insight", () => {
  it("receive, from Insight after BlockCypher 429 and Blockchair 430", async () => {
    stubProxy([
      ["https://api.blockcypher.com/", { status: 429, body: JSON.stringify({ error: "Limits reached." }) }],
      ["https://api.blockchair.com/", { status: 430, body: JSON.stringify({ data: null, context: { code: 430, error: "blacklisted" } }) }],
      [
        "https://insight.dash.org/insight-api/tx/",
        ok({
          txid: TXID,
          vin: [{ addr: "XeZCVj3o3KG5uLBWWPyaQcooMreFSigDFV", valueSat: 2000000 }],
          vout: [
            { value: "0.01000000", scriptPubKey: { addresses: [DASH_ME] } },
            { value: "0.00990000", scriptPubKey: { addresses: ["XwQBodigf1cCp833XaxykfJGk52W8JQUhY"] } },
          ],
        }),
      ],
    ]);
    expect(await dashAdapter.getTransactionParties!(TXID, DASH_ME)).toEqual({
      from: ["XeZCVj3o3KG5uLBWWPyaQcooMreFSigDFV"],
      to: [DASH_ME, "XwQBodigf1cCp833XaxykfJGk52W8JQUhY"],
      source: "insight.dash.org",
    });
  });
});

describe("RVN — BlockBook, then the Insight mirrors", () => {
  it("send, from BlockBook", async () => {
    stubProxy([
      [
        "https://blockbook.ravencoin.org/api/v2/tx/",
        ok({ txid: TXID, vin: [{ addresses: [RVN_ME], isAddress: true, value: "1000000" }], vout: [{ addresses: ["RKFUXeJhxaSe2FVF8RSA6PtvBHP91iiUKv"], isAddress: true, value: "990000" }] }),
      ],
    ]);
    expect(await rvnAdapter.getTransactionParties!(TXID, RVN_ME)).toEqual({
      from: [RVN_ME],
      to: ["RKFUXeJhxaSe2FVF8RSA6PtvBHP91iiUKv"],
      source: "blockbook.ravencoin.org",
    });
  });

  it("BlockBook's 400 'not found' is null even while both mirrors are dead (as read live)", async () => {
    stubProxy([
      ["https://blockbook.ravencoin.org/", { status: 400, body: JSON.stringify({ error: `Transaction '${TXID}' not found` }) }],
      ["https://api.ravencoin.org/", new Error("error sending request for url")],
      ["https://rvn.cryptoscope.io/", { status: 404, body: "<!DOCTYPE html><html><body>404</body></html>" }],
    ]);
    expect(await rvnAdapter.getTransactionParties!(TXID, RVN_ME)).toBeNull();
  });

  it("every source failed: throws", async () => {
    stubProxy([
      ["https://blockbook.ravencoin.org/", { status: 502, body: "" }],
      ["https://api.ravencoin.org/", new Error("error sending request for url")],
      ["https://rvn.cryptoscope.io/", { status: 404, body: "<!DOCTYPE html><html><body>404</body></html>" }],
    ]);
    await expect(rvnAdapter.getTransactionParties!(TXID, RVN_ME)).rejects.toThrow(
      /^every RVN transaction source failed — blockbook\.ravencoin\.org: HTTP 502; api\.ravencoin\.org: error sending request for url; rvn\.cryptoscope\.io: HTTP 404$/,
    );
  });
});
