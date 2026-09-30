/**
 * A lost broadcast reply must never read as "Transaction failed"
 * (2026-09-29 send-safety audit — CRITICAL).
 *
 * # The incident
 *
 * Every Bitcoin-family adapter broadcast by walking a ladder of explorers and
 * threw "All N source(s) failed" when none answered with a txid. The audit ran
 * the real adapters against a fake explorer network in which the FIRST
 * endpoint relayed the transaction but its reply was lost (a dropped
 * connection, the proxy's 30 s timeout) and the rest answered 429/430/403. The
 * UI said "Transaction failed" with the form still filled; one more press
 * re-scanned the account, the explorers no longer listed the inputs the first
 * transaction had spent, so the wallet built a NEW transaction from other
 * coins — no shared input, nothing for the network to reject — and the
 * recipient was paid twice. Reproduced on BTC, LTC, DOGE, DASH and BCH.
 *
 * # What these pin, per chain
 *
 *  - the txid is known before broadcast and every endpoint gets the SAME bytes;
 *  - a reply that is lost while nothing else is known → `SendOutcomeUnknownError`
 *    carrying that txid (the UI closes the form and says "may have been sent");
 *  - a lost reply for a transaction the explorers can see → success;
 *  - "already in mempool / already exists" from any endpoint → success;
 *  - every endpoint refusing it outright → an ordinary Error that quotes EACH
 *    endpoint's reason (the old ladders kept only the last one).
 *
 * Each case fails on the pre-fix code: there, every one of these ended in the
 * same plain "All N source(s) failed" error (BTC: `HTTP 400 from <host>`, with
 * no reason at all) — see fixlog-utxo.md for the recorded run.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";

vi.mock("../lib/tauri", () => ({
  invoke: (cmd: string, args: unknown) => (globalThis as any).__utxoFakeInvoke(cmd, args),
}));

import {
  FakeExplorer,
  verifySignedTx,
  h160,
  type PushOutcome,
  type SigKind,
} from "./utxo-fake-explorer.testkit";
import { btcAdapter, btcUtxoAccounts } from "./btc-wallet";
import { ltcAdapter, ltcUtxoAccounts } from "./ltc-wallet";
import { dogeAdapter, dogeUtxoAccounts } from "./doge-wallet";
import { dashAdapter, dashUtxoAccounts } from "./dash-wallet";
import { bchAdapter, bchUtxoAccounts, encodeCashAddr } from "./bch-wallet";
import { rvnAdapter } from "./rvn-wallet";
import { isSendOutcomeUnknown } from "./send-outcome";
import type { ChainAdapter } from "./types";
import type { UtxoAccountSpec } from "./utxo-account";

const M =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(M, ""));
const pubAt = (path: string) => root.derive(path).publicKey!;
const p2pkh = (pub: Uint8Array) => bitcoin.payments.p2pkh({ hash: Buffer.from(h160(pub)) }).output!;
const p2wpkh = (pub: Uint8Array) => bitcoin.payments.p2wpkh({ hash: Buffer.from(h160(pub)) }).output!;

const net = (pubKeyHash: number, scriptHash: number, bech32: string, wif: number): bitcoin.Network => ({
  messagePrefix: "",
  bech32,
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash,
  scriptHash,
  wif,
});
const LTC_NET = net(0x30, 0x32, "ltc", 0xb0);
const DOGE_NET = net(0x1e, 0x16, "doge", 0x9e);
const DASH_NET = net(0x4c, 0x10, "dash", 0xcc);
const RVN_NET = net(0x3c, 0x7a, "rvn-unused", 0x80);

type Chain = {
  name: string;
  adapter: ChainAdapter;
  spec: UtxoAccountSpec;
  sig: SigKind;
  lock: (pub: Uint8Array) => Uint8Array;
  recipient: string;
  /** Base units per "coin" in the scenario (DOGE is scaled up 100×). */
  unit: number;
  feeRate?: number;
  /** Broadcast endpoints that take the hex, in ladder order (fake's `via`). */
  ladder: string[];
};

const CHAINS: Chain[] = [
  {
    name: "BTC",
    adapter: btcAdapter,
    spec: btcUtxoAccounts[0],
    sig: "p2wpkh",
    lock: p2wpkh,
    recipient: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubAt("m/84'/0'/1'/0/0")) }).address!,
    unit: 1e8,
    feeRate: 2,
    ladder: ["esplora:blockstream.info", "esplora:mempool.space"],
  },
  {
    name: "LTC",
    adapter: ltcAdapter,
    spec: ltcUtxoAccounts[0],
    sig: "p2wpkh",
    lock: p2wpkh,
    recipient: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubAt("m/84'/2'/1'/0/0")), network: LTC_NET }).address!,
    unit: 1e8,
    feeRate: 2,
    ladder: ["blockcypher", "blockchair", "esplora:litecoinspace.org"],
  },
  {
    name: "DOGE",
    adapter: dogeAdapter,
    spec: dogeUtxoAccounts[0],
    sig: "p2pkh",
    lock: p2pkh,
    recipient: bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubAt("m/44'/3'/1'/0/0")), network: DOGE_NET }).address!,
    unit: 100e8,
    ladder: ["blockcypher", "blockchair", "dogechain"],
  },
  {
    name: "DASH",
    adapter: dashAdapter,
    spec: dashUtxoAccounts[0],
    sig: "p2pkh",
    lock: p2pkh,
    recipient: bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubAt("m/44'/5'/1'/0/0")), network: DASH_NET }).address!,
    unit: 1e8,
    feeRate: 10,
    ladder: ["blockcypher", "blockchair"],
  },
  {
    name: "BCH",
    adapter: bchAdapter,
    spec: bchUtxoAccounts[0],
    sig: "bch",
    lock: p2pkh,
    recipient: encodeCashAddr(h160(pubAt("m/44'/145'/1'/0/0")), "p2pkh"),
    unit: 1e8,
    feeRate: 1,
    ladder: ["blockchair", "bitcore", "haskoin:api.blockchain.info", "haskoin:api.haskoin.com"],
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

function newFake(): FakeExplorer {
  const fake = new FakeExplorer();
  vi.stubGlobal("__utxoFakeInvoke", fake.invokeImpl);
  vi.stubGlobal("fetch", fake.fetchImpl);
  return fake;
}

/** receive/0 = 0.3, receive/1 = 0.7, change/0 used-and-empty; send 0.9 → both inputs + change. */
function seed(c: Chain, fake: FakeExplorer) {
  const acct = root.derive(c.spec.accountPath);
  const node = (chain: number, i: number) => acct.deriveChild(chain).deriveChild(i);
  const r0 = node(0, 0);
  const r1 = node(0, 1);
  fake.fund(c.spec.deriveAddress(r0), c.lock(r0.publicKey!), Math.round(0.3 * c.unit));
  fake.fund(c.spec.deriveAddress(r1), c.lock(r1.publicKey!), Math.round(0.7 * c.unit));
  fake.markUsed(c.spec.deriveAddress(node(1, 0)));
  return { from: c.spec.deriveAddress(r0) };
}

const amountOf = (c: Chain) => ((0.9 * c.unit) / 1e8).toFixed(8);

async function send(c: Chain, from: string) {
  return c.adapter.sendFromAccount!(M, c.recipient, amountOf(c), from, { feeRate: c.feeRate });
}

async function sendError(c: Chain, from: string): Promise<any> {
  return send(c, from).then(
    (r) => {
      throw new Error(`expected the send to throw, it returned ${JSON.stringify(r)}`);
    },
    (e) => e,
  );
}

const LIMITED: PushOutcome = { status: 429, body: '{"error": "Limits reached."}' };

/** A node-style "I already have this transaction" reply, as each explorer phrases it. */
function alreadyKnown(via: string, txid: string): PushOutcome {
  if (via === "blockcypher") {
    return { status: 400, body: JSON.stringify({ error: `Error validating transaction: Transaction with hash ${txid} already exists.` }) };
  }
  if (via === "blockchair") {
    return { status: 400, body: JSON.stringify({ data: null, context: { code: 400, error: "Invalid transaction. Error: 18: txn-already-in-mempool" } }) };
  }
  if (via.startsWith("esplora:")) {
    return { status: 400, body: 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}' };
  }
  if (via === "dogechain") return { status: 200, body: JSON.stringify({ success: 0, error: "transaction already in block chain" }) };
  return { status: 400, body: JSON.stringify({ error: "txn-already-known" }) };
}

/** A distinct, definitive node rejection per endpoint — so a message that
 *  keeps only the LAST endpoint's reply cannot pass. */
const REASONS = [
  "min relay fee not met, 100 < 226",
  "bad-txns-inputs-missingorspent",
  "mempool min fee not met, 180 < 1000",
  "non-mandatory-script-verify-flag (Signature must be zero for failed CHECK(MULTI)SIG operation)",
];
function rejection(via: string, reason: string): PushOutcome {
  if (via === "blockcypher") return { status: 400, body: JSON.stringify({ error: `Error sending transaction: -26: ${reason}` }) };
  if (via === "blockchair") return { status: 400, body: JSON.stringify({ data: null, context: { code: 400, error: `Invalid transaction. Error: ${reason}` } }) };
  if (via.startsWith("esplora:")) return { status: 400, body: `sendrawtransaction RPC error: {"code":-26,"message":"${reason}"}` };
  if (via === "dogechain") return { status: 200, body: JSON.stringify({ success: 0, error: reason }) };
  return { status: 400, body: JSON.stringify({ error: `-26: ${reason}` }) };
}

for (const c of CHAINS) {
  describe(`${c.name}: broadcasting a signed transaction (2026-09-29 send-safety audit)`, () => {
    it("the first endpoint accepts → success with the LOCAL txid, marked pending, signatures valid", async () => {
      const fake = newFake();
      const { from } = seed(c, fake);
      const r = await send(c, from);
      const pushed = fake.distinctPushedHex();
      expect(pushed).toHaveLength(1);
      const v = verifySignedTx(pushed[0], c.sig, fake.prevOut);
      expect(v.problems).toEqual([]);
      expect(r.hash).toBe(v.txid);
      // A UTXO broadcast is in the mempool, not confirmed.
      expect(r.pending).toBe(true);
      expect(fake.pushes.map((p) => p.via)).toEqual([c.ladder[0]]);
    });

    it("a LOST reply with nothing else known is UNKNOWN, carries the txid, and no second tx is built", async () => {
      const fake = newFake();
      const { from } = seed(c, fake);
      fake.onPush = (via) => (via === c.ladder[0] ? "drop" : LIMITED);
      const err = await sendError(c, from);
      expect(
        isSendOutcomeUnknown(err),
        `expected SendOutcomeUnknownError, got: ${String(err?.message ?? err)}`,
      ).toBe(true);
      // Sign once: every endpoint was offered the identical bytes.
      const pushed = fake.distinctPushedHex();
      expect(pushed).toHaveLength(1);
      expect(err.hash).toBe(bitcoin.Transaction.fromHex(pushed[0]).getId());
      // The whole ladder was tried with those bytes before giving up.
      expect(new Set(fake.pushes.filter((p) => p.hex).map((p) => p.via))).toEqual(new Set(c.ladder));
    });

    it("a lost reply for a transaction the explorers can see → success, not failure", async () => {
      const fake = newFake();
      const { from } = seed(c, fake);
      fake.onPush = (via) => (via === c.ladder[0] ? "relay-then-drop" : LIMITED);
      const r = await send(c, from);
      const pushed = fake.distinctPushedHex();
      expect(pushed).toHaveLength(1);
      expect(r.hash).toBe(bitcoin.Transaction.fromHex(pushed[0]).getId());
      expect(r.pending).toBe(true);
    });

    it("'already in mempool / already exists' from a later endpoint → success", async () => {
      const fake = newFake();
      const { from } = seed(c, fake);
      // The first push is lost unseen (lookups cannot find it), so only the
      // later endpoints' "already have it" replies can establish success.
      fake.onPush = (via, _hex, txid) => (via === c.ladder[0] ? "drop" : alreadyKnown(via, txid));
      const r = await send(c, from);
      const pushed = fake.distinctPushedHex();
      expect(pushed).toHaveLength(1);
      expect(r.hash).toBe(bitcoin.Transaction.fromHex(pushed[0]).getId());
    });

    it("every endpoint refusing it outright → a plain Error quoting EACH endpoint's reason", async () => {
      const fake = newFake();
      const { from } = seed(c, fake);
      const reasonFor = new Map(c.ladder.map((via, i) => [via, REASONS[i % REASONS.length]]));
      fake.onPush = (via) => rejection(via, reasonFor.get(via) ?? REASONS[0]);
      const err = await sendError(c, from);
      expect(isSendOutcomeUnknown(err), "a definitive rejection is not an unknown outcome").toBe(false);
      expect(err).toBeInstanceOf(Error);
      for (const via of c.ladder) {
        expect(String(err.message), `${via}'s reason is missing from the error`).toContain(
          reasonFor.get(via)!.split(",")[0],
        );
      }
      expect(fake.distinctPushedHex()).toHaveLength(1);
    });
  });
}

// ── RVN: single-key send (RVN has no account-wide path) ─────────────────────

describe("RVN: broadcasting a signed transaction (2026-09-29 send-safety audit)", () => {
  const node = root.derive("m/44'/175'/0'/0/0");
  const from = bitcoin.payments.p2pkh({ pubkey: Buffer.from(node.publicKey!), network: RVN_NET }).address!;
  const to = bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubAt("m/44'/175'/1'/0/0")), network: RVN_NET }).address!;
  const priv = Buffer.from(node.privateKey!).toString("hex");

  function rvnFake() {
    const fake = newFake();
    fake.fund(from, p2pkh(node.publicKey!), 100e8);
    return fake;
  }

  it("BlockBook accepts → success with the local txid", async () => {
    const fake = rvnFake();
    const r = await rvnAdapter.sendTransaction(priv, to, "10");
    const pushed = fake.distinctPushedHex();
    expect(pushed).toHaveLength(1);
    const v = verifySignedTx(pushed[0], "p2pkh", fake.prevOut);
    expect(v.problems).toEqual([]);
    expect(r.hash).toBe(v.txid);
  });

  it("a lost BlockBook reply is UNKNOWN with the txid", async () => {
    const fake = rvnFake();
    fake.onPush = () => "drop";
    const err = await rvnAdapter.sendTransaction(priv, to, "10").then(
      () => null,
      (e) => e,
    );
    expect(isSendOutcomeUnknown(err), `got: ${String(err?.message ?? err)}`).toBe(true);
    const pushed = fake.distinctPushedHex();
    expect(pushed).toHaveLength(1);
    expect(err.hash).toBe(bitcoin.Transaction.fromHex(pushed[0]).getId());
  });

  it("a BlockBook rejection with the Insight mirrors dead → plain Error with the node's reason", async () => {
    const fake = rvnFake();
    fake.onPush = () => ({ status: 400, body: JSON.stringify({ error: "-26: 66: min relay fee not met" }) });
    const err = await rvnAdapter.sendTransaction(priv, to, "10").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(String(err.message)).toContain("min relay fee not met");
  });
});
