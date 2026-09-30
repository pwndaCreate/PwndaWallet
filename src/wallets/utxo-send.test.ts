/**
 * The shared send helpers' rules, one table at a time (2026-09-29 send-safety
 * audit). The adapter-level tests (`utxo-broadcast-outcome.test.ts`,
 * `utxo-send-validation.test.ts`) prove each chain uses these; this file pins
 * what the rules ARE, so a change to one is a visible decision.
 */
import { describe, it, expect, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";

vi.mock("./_proxy", () => ({ httpProxyCall: vi.fn(), proxyGetJson: vi.fn(), proxyPostJson: vi.fn() }));

import {
  acceptPushReply,
  broadcastSignedTx,
  BroadcastReplyError,
  classifyBroadcastFailure,
  dustThresholdSat,
  DUST_RELAY_FEE_PER_KB,
  outputVBytes,
  parseSendAmountSat,
  stripPaymentUri,
  txidOfLegacyRawHex,
  type BroadcastEndpoint,
  type TxLookup,
} from "./utxo-send";
import { isSendOutcomeUnknown } from "./send-outcome";
import { planAccountSpend, P2WPKH_SIZING } from "./utxo-account";
import { clampDogeSatPerKb, DOGE_MAX_SAT_PER_KB, DOGE_MIN_SAT_PER_KB } from "./doge-wallet";

const reply = (status: number, body: string) =>
  new BroadcastReplyError(`HTTP ${status}: ${body}`, { status, body });

describe("classifyBroadcastFailure — what an endpoint's reply proves", () => {
  it("'already have it' in any phrasing is success", () => {
    for (const body of [
      'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}',
      '{"code":-27,"message":"Transaction outputs already in utxo set"}',
      "18: txn-already-in-mempool",
      "txn-already-known",
      "txn-same-nonwitness-data-in-mempool",
      '{"error":"Error validating transaction: Transaction with hash ab12 already exists."}',
    ]) {
      expect(classifyBroadcastFailure(reply(400, body)), body).toBe("known");
    }
  });

  it("a node's validation reason means THIS endpoint did not relay it", () => {
    for (const body of [
      '{"code":-26,"message":"min relay fee not met, 100 < 141"}',
      "mempool min fee not met",
      "dust",
      "bad-txns-inputs-missingorspent",
      "txn-mempool-conflict",
      "non-mandatory-script-verify-flag (Signature must be zero for failed CHECK(MULTI)SIG operation)",
      "-22: TX decode failed",
      "Missing inputs",
    ]) {
      expect(classifyBroadcastFailure(reply(400, body)), body).toBe("rejected");
    }
  });

  it("a request turned away before processing is 'refused'", () => {
    expect(classifyBroadcastFailure(reply(429, '{"error": "Limits reached."}'))).toBe("refused");
    expect(classifyBroadcastFailure(reply(430, "Your IP address is temporary blacklisted"))).toBe("refused");
    expect(classifyBroadcastFailure(reply(403, "<html>Just a moment...</html>"))).toBe("refused");
    expect(classifyBroadcastFailure(reply(404, "Not Found"))).toBe("refused");
    // A web page served with 200 (the dead FullStack host) is not an API reply.
    expect(classifyBroadcastFailure(reply(200, "<!doctype html><html>marketing</html>"))).toBe("refused");
    expect(
      classifyBroadcastFailure("host 'x.example' is not on the http_proxy allowlist (see http_proxy.rs)"),
    ).toBe("refused");
  });

  it("anything that does not rule out a relay is 'ambiguous'", () => {
    expect(classifyBroadcastFailure("http request to https://x failed: operation timed out")).toBe("ambiguous");
    expect(classifyBroadcastFailure(new TypeError("Failed to fetch"))).toBe("ambiguous");
    expect(classifyBroadcastFailure(reply(502, "Bad Gateway"))).toBe("ambiguous");
    expect(classifyBroadcastFailure(reply(500, "Internal Server Error"))).toBe("ambiguous");
    expect(classifyBroadcastFailure(reply(200, '{"weird":true}'))).toBe("ambiguous");
    expect(classifyBroadcastFailure(reply(400, "Invalid request"))).toBe("ambiguous");
  });
});

describe("acceptPushReply", () => {
  const T = "ab".repeat(32);
  it("returns the endpoint's txid from a 2xx reply", () => {
    expect(acceptPushReply(200, ` ${T}\n`, (b) => b.trim())).toBe(T);
  });
  it("a 2xx reply without a txid is not an acceptance", () => {
    expect(() => acceptPushReply(200, "OK", (b) => b.trim())).toThrow(BroadcastReplyError);
    expect(() => acceptPushReply(201, "{not json", (b) => JSON.parse(b).tx.hash)).toThrow(BroadcastReplyError);
  });
  it("a non-2xx reply carries its status and body", () => {
    try {
      acceptPushReply(429, "slow down", (b) => b);
      throw new Error("unreachable");
    } catch (e) {
      expect(e).toBeInstanceOf(BroadcastReplyError);
      expect((e as BroadcastReplyError).status).toBe(429);
      expect((e as BroadcastReplyError).body).toBe("slow down");
    }
  });
});

describe("broadcastSignedTx — the decision", () => {
  const TXID = "cd".repeat(32);
  const fail = (e: unknown): BroadcastEndpoint => ({ name: "e", send: async () => { throw e; } });
  const ok: BroadcastEndpoint = { name: "ok", send: async () => TXID };
  const seen = (found: boolean): TxLookup => ({ name: "l", find: async () => found });
  const run = (endpoints: BroadcastEndpoint[], lookups: TxLookup[] = []) =>
    broadcastSignedTx({ ticker: "T", txid: TXID, rawHex: "00", endpoints, lookups });

  it("the first acceptance wins and later endpoints are not asked", async () => {
    const later = vi.fn(async () => TXID);
    await expect(run([ok, { name: "later", send: later }])).resolves.toEqual({ hash: TXID, pending: true });
    expect(later).not.toHaveBeenCalled();
  });

  it("every endpoint rejected or refused → plain Error listing each", async () => {
    const e = await run([fail(reply(400, "min relay fee not met")), fail(reply(429, "limit"))]).catch((x) => x);
    expect(isSendOutcomeUnknown(e)).toBe(false);
    expect(e.message).toContain("min relay fee not met");
    expect(e.message).toContain("HTTP 429");
  });

  it("one ambiguous failure among rejections → SendOutcomeUnknownError with the txid", async () => {
    const e = await run([fail("operation timed out"), fail(reply(400, "dust"))]).catch((x) => x);
    expect(isSendOutcomeUnknown(e)).toBe(true);
    expect(e.hash).toBe(TXID);
  });

  it("a lookup that finds the txid turns an all-failed ladder into success", async () => {
    await expect(run([fail("operation timed out")], [seen(false), seen(true)])).resolves.toEqual({
      hash: TXID,
      pending: true,
    });
  });

  it("a lookup that throws proves nothing", async () => {
    const broken: TxLookup = { name: "b", find: async () => { throw new Error("down"); } };
    const e = await run([fail("operation timed out")], [broken]).catch((x) => x);
    expect(isSendOutcomeUnknown(e)).toBe(true);
  });

  it("refuses a malformed local txid and an empty ladder before sending anything", async () => {
    const send = vi.fn(async () => TXID);
    await expect(
      broadcastSignedTx({ ticker: "T", txid: "nope", rawHex: "00", endpoints: [{ name: "x", send }], lookups: [] }),
    ).rejects.toThrow(/invalid local txid/);
    await expect(run([])).rejects.toThrow(/no broadcast endpoint/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("dust thresholds follow each node's GetDustThreshold", () => {
  const h20 = Buffer.alloc(20, 1);
  const btc = {
    p2pkh: bitcoin.payments.p2pkh({ hash: h20 }).output!,
    p2sh: bitcoin.payments.p2sh({ hash: h20 }).output!,
    p2wpkh: bitcoin.payments.p2wpkh({ hash: h20 }).output!,
    p2tr: Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(2)]),
  };

  it("Bitcoin's familiar numbers at 3,000 sat/kB", () => {
    expect(dustThresholdSat(btc.p2pkh, DUST_RELAY_FEE_PER_KB.bitcoin)).toBe(546);
    expect(dustThresholdSat(btc.p2sh, DUST_RELAY_FEE_PER_KB.bitcoin)).toBe(540);
    expect(dustThresholdSat(btc.p2wpkh, DUST_RELAY_FEE_PER_KB.bitcoin)).toBe(294);
    expect(dustThresholdSat(btc.p2tr, DUST_RELAY_FEE_PER_KB.bitcoin)).toBe(330);
  });

  it("Litecoin's are ten times Bitcoin's (30,000 lit/kB)", () => {
    expect(dustThresholdSat(btc.p2wpkh, DUST_RELAY_FEE_PER_KB.litecoin)).toBe(2_940);
    expect(dustThresholdSat(btc.p2pkh, DUST_RELAY_FEE_PER_KB.litecoin)).toBe(5_460);
  });

  it("a BCH P2SH32 output (44 bytes) needs 576 sat", () => {
    const p2sh32 = Uint8Array.from([0xaa, 0x20, ...new Uint8Array(32), 0x87]);
    expect(outputVBytes(p2sh32.length)).toBe(44);
    expect(dustThresholdSat(p2sh32, DUST_RELAY_FEE_PER_KB["bitcoin-cash"])).toBe(576);
  });
});

describe("amounts, URIs and txids", () => {
  it("parseSendAmountSat is strict and exact", () => {
    expect(parseSendAmountSat("0.1", "BTC")).toBe(10_000_000);
    expect(parseSendAmountSat(" 1.5 ", "BTC")).toBe(150_000_000);
    for (const bad of ["1,5", "1.000,50", "0.9abc", "1e-8", "-1", ".5", "", "0.123456789"]) {
      expect(() => parseSendAmountSat(bad, "BTC"), bad).toThrow();
    }
    expect(() => parseSendAmountSat("0", "BTC")).toThrow(/greater than zero/);
    expect(() => parseSendAmountSat("90071993", "DOGE")).toThrow(/2\^53/);
  });

  it("stripPaymentUri keeps only the address, and only for the chain's own scheme", () => {
    expect(stripPaymentUri(" bitcoin:bc1qxyz?amount=1&label=a ", ["bitcoin"])).toBe("bc1qxyz");
    expect(stripPaymentUri("BITCOIN:BC1QXYZ", ["bitcoin"])).toBe("BC1QXYZ");
    expect(stripPaymentUri("litecoin:ltc1qxyz", ["bitcoin"])).toBe("litecoin:ltc1qxyz");
  });

  it("txidOfLegacyRawHex agrees with bitcoinjs-lib", () => {
    const tx = new bitcoin.Transaction();
    tx.addInput(new Uint8Array(32).fill(9), 1, 0xffffffff, Uint8Array.of(0x51));
    tx.addOutput(Uint8Array.of(0x51), 1234n);
    expect(txidOfLegacyRawHex(tx.toHex())).toBe(tx.getId());
  });
});

describe("planAccountSpend sizes the recipient output it is given", () => {
  const coin = [{ path: "p", address: "a", txid: "ee".repeat(32), vout: 0, valueSat: 100_000_000 }];
  it("a 43-vB P2TR recipient costs 12 vB more than the 31-vB default", () => {
    const base = planAccountSpend({ candidates: coin, sendSat: 50_000_000, feePerVB: 1, sizing: P2WPKH_SIZING, dustSat: 546 });
    const p2tr = planAccountSpend({
      candidates: coin, sendSat: 50_000_000, feePerVB: 1, sizing: P2WPKH_SIZING, dustSat: 546,
      recipientOutputVB: outputVBytes(34),
    });
    expect(base.feeSat).toBe(141);
    expect(p2tr.feeSat).toBe(153);
  });
});

describe("DOGE fee band", () => {
  it("clamps every reading into [0.01, 0.04] DOGE/kB", () => {
    expect(clampDogeSatPerKb(58_349_538)).toBe(DOGE_MAX_SAT_PER_KB);
    expect(clampDogeSatPerKb(500_000_000)).toBe(DOGE_MAX_SAT_PER_KB);
    expect(clampDogeSatPerKb(10_000)).toBe(DOGE_MIN_SAT_PER_KB);
    expect(clampDogeSatPerKb(2_500_000)).toBe(2_500_000);
    expect(clampDogeSatPerKb(null)).toBe(DOGE_MIN_SAT_PER_KB);
    expect(clampDogeSatPerKb(NaN)).toBe(DOGE_MIN_SAT_PER_KB);
    // The ceiling stays under bitcoinjs-lib's 5,000 sat/B (0.05 DOGE/kB) guard.
    expect(DOGE_MAX_SAT_PER_KB / 1000).toBeLessThan(5_000);
  });
});
