/**
 * "Speed up" an unconfirmed BTC transaction (operator request, 2026-10-01).
 *
 * The real send builds the original against the in-process fake explorer
 * (`utxo-fake-explorer.testkit.ts`; nothing opens a socket and nothing is
 * broadcast anywhere), then the real speed-up reads it back from the fake's
 * Esplora, builds the replacement, signs it once and pushes it once. Every
 * replacement is DECODED and checked here — inputs, sequences, outputs, fee,
 * vsize, the BIP125 rules — and every signature is verified against a sighash
 * bitcoinjs-lib computes, not the code under test.
 *
 * On 6b4e160 none of this exists (`btc-rbf.ts` is new), and every BTC
 * transaction the wallet built carried nSequence 0xffffffff, so none could
 * have been replaced; `btc-rbf-scope.test.ts` pins that half.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as tinysecp from "tiny-secp256k1";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";

vi.mock("../lib/tauri", () => ({
  invoke: (cmd: string, args: unknown) => (globalThis as any).__utxoFakeInvoke(cmd, args),
}));

// The account-state cache and the own-transaction record, in memory.
const memory = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: async (file: string) => ({
      get: async (k: string) => memory.get(`${file}|${k}`) ?? null,
      set: async (k: string, v: unknown) => {
        memory.set(`${file}|${k}`, v);
      },
      save: async () => {},
      entries: async () => [],
    }),
  },
}));

import { FakeExplorer, h160, hex } from "./utxo-fake-explorer.testkit";
import { btcAdapter, deriveLegacyBtcFromMnemonic, sweepLegacyBtcToAddress } from "./btc-wallet";
import {
  __testing,
  assertReplacementOf,
  findOwnBtcKeys,
  isBtcSpeedUpRefusal,
  quoteBtcSpeedUp,
  readBtcTx,
  speedUpBtcTransaction,
  type BtcSpeedUpQuote,
} from "./btc-rbf";
import { BTC_RBF_SEQUENCE, replacementRuleViolation } from "./btc-rbf-policy";
import { _resetOwnBtcTxsForTests, isOwnBtcTx, rememberOwnBtcTx } from "./btc-own-txs";
import {
  _clearTxReplacementsForTests,
  onTxReplacement,
  txReplacementOf,
  withoutReplacedRows,
} from "./tx-replacements";
import { isSendOutcomeUnknown } from "./send-outcome";
import type { ChainTx } from "./types";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(M, ""));
const NET = bitcoin.networks.bitcoin;
const pubAt = (path: string) => Buffer.from(root.derive(path).publicKey!);
const privAt = (path: string) => Buffer.from(root.derive(path).privateKey!).toString("hex");
const p2wpkhOut = (pub: Uint8Array) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pub), network: NET }).output!;
const p2shP2wpkhOut = (pub: Uint8Array) =>
  bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pub), network: NET }), network: NET })
    .output!;
const p2pkhOut = (pub: Uint8Array) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(pub), network: NET }).output!;
const addressOf = (script: Uint8Array) => bitcoin.address.fromOutputScript(script, NET);

type Kind = "p2wpkh" | "p2sh" | "p2pkh";
type Account = { name: string; path: string; lock: (pub: Uint8Array) => Uint8Array; kind: Kind };
/** The four BTC accounts the wallet can be (`btcUtxoAccounts`). */
const ACCOUNTS: Account[] = [
  { name: "BIP-84 native SegWit", path: "m/84'/0'/0'", lock: p2wpkhOut, kind: "p2wpkh" },
  { name: "BIP-49 wrapped SegWit", path: "m/49'/0'/0'", lock: p2shP2wpkhOut, kind: "p2sh" },
  { name: "BIP-44 legacy", path: "m/44'/0'/0'", lock: p2pkhOut, kind: "p2pkh" },
  { name: "BIP-44 path, SegWit encoding (pre-2026-05-06)", path: "m/44'/0'/0'", lock: p2wpkhOut, kind: "p2wpkh" },
];
const addrAt = (a: Account, chain: 0 | 1, i: number) => addressOf(a.lock(pubAt(`${a.path}/${chain}/${i}`)));

/** A recipient on an account the speed-up never walks (m/84'/0'/9'): not the wallet's. */
const TO = addressOf(p2wpkhOut(pubAt("m/84'/0'/9'/0/0")));
const SECRET = { mnemonic: M };

function scriptKind(s: Uint8Array): Kind | "other" {
  if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14) return "p2wpkh";
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return "p2sh";
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9) return "p2pkh";
  return "other";
}

/**
 * Every input's signature against a sighash bitcoinjs-lib computes itself,
 * tiny-secp256k1 verifying (the same check `btc-bip49-bip44-accounts.test.ts`
 * makes, for the three types the wallet signs).
 */
function verifyInputs(tx: bitcoin.Transaction, prevOut: Map<string, { script: Uint8Array; value: number }>): string[] {
  const problems: string[] = [];
  const p2pkhCode = (pub: Uint8Array) => p2pkhOut(pub);
  tx.ins.forEach((inp, i) => {
    const prev = prevOut.get(`${hex(Uint8Array.from(inp.hash).reverse())}:${inp.index}`);
    if (!prev) return void problems.push(`input ${i}: unknown outpoint`);
    const kind = scriptKind(prev.script);
    let sig: Uint8Array;
    let pub: Uint8Array;
    let digest: Uint8Array;
    if (kind === "p2pkh") {
      const chunks = bitcoin.script.decompile(inp.script) as Uint8Array[];
      [sig, pub] = chunks;
      if (hex(p2pkhOut(pub)) !== hex(prev.script)) problems.push(`input ${i}: key does not own it`);
      digest = tx.hashForSignature(i, prev.script, sig[sig.length - 1]);
    } else if (kind === "p2sh") {
      const [redeem] = bitcoin.script.decompile(inp.script) as Uint8Array[];
      [sig, pub] = inp.witness as unknown as [Uint8Array, Uint8Array];
      if (hex(redeem) !== "0014" + hex(h160(pub))) problems.push(`input ${i}: wrong redeem script`);
      digest = tx.hashForWitnessV0(i, p2pkhCode(pub), BigInt(prev.value), sig[sig.length - 1]);
    } else if (kind === "p2wpkh") {
      [sig, pub] = inp.witness as unknown as [Uint8Array, Uint8Array];
      if (hex(p2wpkhOut(pub)) !== hex(prev.script)) problems.push(`input ${i}: key does not own it`);
      digest = tx.hashForWitnessV0(i, p2pkhCode(pub), BigInt(prev.value), sig[sig.length - 1]);
    } else {
      return void problems.push(`input ${i}: unexpected type`);
    }
    const d = bitcoin.script.signature.decode(Buffer.from(sig));
    if (!tinysecp.verify(digest, pub, Uint8Array.from(d.signature))) problems.push(`input ${i}: bad signature`);
  });
  return problems;
}

const feeOf = (tx: bitcoin.Transaction, prevOut: Map<string, { value: number }>) =>
  tx.ins.reduce((s, inp) => s + prevOut.get(`${hex(Uint8Array.from(inp.hash).reverse())}:${inp.index}`)!.value, 0) -
  tx.outs.reduce((s, o) => s + Number(o.value), 0);

beforeEach(() => {
  memory.clear();
  _resetOwnBtcTxsForTests();
  _clearTxReplacementsForTests();
});
afterEach(() => vi.unstubAllGlobals());

function newFake(): FakeExplorer {
  const fake = new FakeExplorer();
  vi.stubGlobal("__utxoFakeInvoke", fake.invokeImpl);
  vi.stubGlobal("fetch", fake.fetchImpl);
  return fake;
}

/** The one transaction pushed since `from` pushes. */
function pushedSince(fake: FakeExplorer, from: number): bitcoin.Transaction {
  const hexes = [...new Set(fake.pushes.slice(from).map((p) => p.hex).filter(Boolean))];
  expect(hexes, "exactly one signed transaction should have been pushed").toHaveLength(1);
  return bitcoin.Transaction.fromHex(hexes[0]);
}

/**
 * The original: an account-wide send of 0.9 BTC at 2 sat/vB from receive/0
 * (0.3) and receive/1 (0.7) of `a`, change to change/0. Built by the wallet's
 * own send, so it is RBF-signalling and recorded as the app's own.
 */
async function sendOriginal(fake: FakeExplorer, a: Account, amount = "0.9") {
  fake.fund(addrAt(a, 0, 0), a.lock(pubAt(`${a.path}/0/0`)), 30_000_000);
  fake.fund(addrAt(a, 0, 1), a.lock(pubAt(`${a.path}/0/1`)), 70_000_000);
  const r = await btcAdapter.sendFromAccount!(M, TO, amount, addrAt(a, 0, 0), { feeRate: 2 });
  const tx = pushedSince(fake, 0);
  expect(r.hash).toBe(tx.getId());
  return { txid: tx.getId(), tx, pushesBefore: fake.pushes.length };
}

async function refusal(p: Promise<unknown>): Promise<any> {
  return p.then(
    (r) => {
      throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
    },
    (e) => e,
  );
}

/** The replacement checked against the original, field by field. */
function expectReplacement(
  fake: FakeExplorer,
  original: bitcoin.Transaction,
  replacement: bitcoin.Transaction,
  quote: BtcSpeedUpQuote,
) {
  // Same coins, same order, every one signalling.
  expect(replacement.ins.map((i) => `${hex(Uint8Array.from(i.hash).reverse())}:${i.index}`)).toEqual(
    original.ins.map((i) => `${hex(Uint8Array.from(i.hash).reverse())}:${i.index}`),
  );
  expect(replacement.ins.map((i) => i.sequence)).toEqual(original.ins.map(() => BTC_RBF_SEQUENCE));
  expect(replacement.version).toBe(original.version);
  expect(replacement.locktime).toBe(original.locktime);
  // Same outputs; only the change is lower, by exactly the extra fee.
  expect(replacement.outs.map((o) => hex(o.script))).toEqual(original.outs.map((o) => hex(o.script)));
  replacement.outs.forEach((o, vout) => {
    const was = Number(original.outs[vout].value);
    expect(Number(o.value), `output ${vout}`).toBe(vout === quote.change.vout ? was - quote.extraFeeSat : was);
  });
  // The fee shown, on a size within the bound it was priced at, keeping every rule.
  const originalFee = feeOf(original, fake.prevOut);
  const fee = feeOf(replacement, fake.prevOut);
  expect(fee).toBe(quote.newFeeSat);
  expect(fee - originalFee).toBe(quote.extraFeeSat);
  expect(replacement.virtualSize()).toBeLessThanOrEqual(quote.replacementVsize);
  expect(
    replacementRuleViolation({
      originalFeeSat: originalFee,
      originalVsize: original.virtualSize(),
      replacementFeeSat: fee,
      replacementVsize: replacement.virtualSize(),
    }),
  ).toBeNull();
  expect(verifyInputs(replacement, fake.prevOut)).toEqual([]);
}

// ── The four account types ──────────────────────────────────────────────────

for (const a of ACCOUNTS) {
  describe(`${a.name}: a stuck send is replaced with a higher fee`, () => {
    it("same inputs and recipient, change lower by the extra fee, signed once, pushed once", async () => {
      const fake = newFake();
      const { txid, tx: original, pushesBefore } = await sendOriginal(fake, a);
      expect(original.ins.every((i) => i.sequence === BTC_RBF_SEQUENCE)).toBe(true);

      const quote = await quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: 14 });
      expect(fake.pushes).toHaveLength(pushesBefore); // a quote signs and sends nothing
      expect(quote.currentRate).toBeCloseTo(feeOf(original, fake.prevOut) / original.virtualSize(), 6);
      expect(quote.targetRate).toBe(14);
      expect(quote.newFeeSat).toBe(Math.ceil(14 * quote.replacementVsize));
      expect(quote.change).toMatchObject({ address: addrAt(a, 1, 0) });
      expect(quote.recipients).toEqual([{ vout: 0, address: TO, valueSat: 90_000_000 }]);

      const replaced: string[] = [];
      onTxReplacement((r) => replaced.push(`${r.replaced}>${r.by}`));
      const r = await speedUpBtcTransaction({ txid, secret: SECRET, targetRate: 14, expectFeeSat: quote.newFeeSat });

      const replacement = pushedSince(fake, pushesBefore);
      expectReplacement(fake, original, replacement, quote);
      expect(Number(replacement.outs[0].value)).toBe(90_000_000);
      expect(r).toMatchObject({ hash: replacement.getId(), pending: true, replaces: txid });
      // The history is told; the replacement is the app's own, so it can be sped up again.
      expect(replaced).toEqual([`${txid}>${replacement.getId()}`]);
      expect(txReplacementOf("bitcoin", txid)?.by).toBe(replacement.getId());
      expect(await isOwnBtcTx(replacement.getId())).toBe(true);
    });
  });
}

describe("a private-key wallet: the key's own coins, change back to its address", () => {
  it("is found by its three encodings and replaced like an account send", async () => {
    const fake = newFake();
    const path = "m/84'/0'/0'/0/0";
    fake.fund(addressOf(p2wpkhOut(pubAt(path))), p2wpkhOut(pubAt(path)), 50_000_000);
    await btcAdapter.sendTransaction(privAt(path), TO, "0.2", undefined, { feeRate: 2 });
    const original = pushedSince(fake, 0);
    const secret = { privateKey: privAt(path) };
    const quote = await quoteBtcSpeedUp({ txid: original.getId(), secret, targetRate: 14 });
    expect(quote.change.address).toBe(addressOf(p2wpkhOut(pubAt(path))));
    const before = fake.pushes.length;
    await speedUpBtcTransaction({ txid: original.getId(), secret, targetRate: 14, expectFeeSat: quote.newFeeSat });
    expectReplacement(fake, original, pushedSince(fake, before), quote);
  });
});

describe("the rate: the network's fast tier, never below the replacement minimum", () => {
  it("a target at or below what the original pays is raised to the minimum", async () => {
    const fake = newFake();
    const { txid, tx: original } = await sendOriginal(fake, ACCOUNTS[0]);
    const quote = await quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: 1 });
    expect(quote.atMinimum).toBe(true);
    expect(quote.newFeeSat).toBe(quote.minimumFeeSat);
    expect(quote.minimumFeeSat).toBe(feeOf(original, fake.prevOut) + quote.replacementVsize);
    const none = await quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: null });
    expect(none).toMatchObject({ atMinimum: true, newFeeSat: quote.minimumFeeSat, targetRate: null });
  });
});

// ── A NEAR Intents deposit keeps its address and amount ────────────────────

describe("a deposit: the recipient's output is byte-for-byte the original's", () => {
  it("an exact-amount deposit keeps its exact amount; only the change pays", async () => {
    const fake = newFake();
    const DEPOSIT = addressOf(p2wpkhOut(pubAt("m/84'/0'/7'/0/0")));
    const a = ACCOUNTS[0];
    fake.fund(addrAt(a, 0, 0), a.lock(pubAt(`${a.path}/0/0`)), 30_000_000);
    await btcAdapter.sendFromAccount!(M, DEPOSIT, "0.12345678", addrAt(a, 0, 0), { feeRate: 3 });
    const original = pushedSince(fake, 0);
    const quote = await quoteBtcSpeedUp({ txid: original.getId(), secret: SECRET, targetRate: 25 });
    const before = fake.pushes.length;
    await speedUpBtcTransaction({ txid: original.getId(), secret: SECRET, targetRate: 25, expectFeeSat: quote.newFeeSat });
    const replacement = pushedSince(fake, before);
    expectReplacement(fake, original, replacement, quote);
    const deposit = replacement.outs.find((o) => addressOf(o.script) === DEPOSIT)!;
    expect(Number(deposit.value)).toBe(12_345_678);
  });
});

// ── Refusals: decided before anything is signed ────────────────────────────

describe("what is refused, with a plain reason, and nothing pushed", () => {
  async function expectRefused(fake: FakeExplorer, txid: string, code: string, text: RegExp) {
    const before = fake.pushes.length;
    const e = await refusal(quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: 14 }));
    expect(isBtcSpeedUpRefusal(e), String(e?.message)).toBe(true);
    expect(e.code).toBe(code);
    expect(String(e.message)).toMatch(text);
    const e2 = await refusal(speedUpBtcTransaction({ txid, secret: SECRET, targetRate: 14, expectFeeSat: 1 }));
    expect(e2.code ?? e2.message).toBe(code);
    expect(fake.pushes).toHaveLength(before);
  }

  /** A transaction with the wallet's keys, signed here — not by the wallet's send. */
  function handBuilt(fake: FakeExplorer, sequence: number, extraForeignInput = false): string {
    const a = ACCOUNTS[0];
    const ours = fake.fund(addrAt(a, 0, 0), a.lock(pubAt(`${a.path}/0/0`)), 10_000_000);
    const foreignPub = pubAt("m/84'/0'/9'/0/5");
    const foreign = extraForeignInput ? fake.fund(addressOf(p2wpkhOut(foreignPub)), p2wpkhOut(foreignPub), 5_000_000) : null;
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: ours.txid, index: 0, sequence, witnessUtxo: { script: ours.script, value: BigInt(ours.value) } });
    if (foreign) {
      psbt.addInput({ hash: foreign.txid, index: 0, sequence, witnessUtxo: { script: foreign.script, value: BigInt(foreign.value) } });
    }
    psbt.addOutput({ address: TO, value: 4_000_000n });
    psbt.addOutput({ address: addrAt(a, 1, 0), value: BigInt(10_000_000 + (foreign ? 5_000_000 : 0) - 4_000_000 - 1_000) });
    const sign = (i: number, path: string) => {
      const node = root.derive(path);
      psbt.signInput(i, {
        publicKey: Buffer.from(node.publicKey!),
        sign: (h: Buffer) => Buffer.from(tinysecp.sign(h, node.privateKey!)),
      });
    };
    sign(0, `${a.path}/0/0`);
    if (foreign) sign(1, "m/84'/0'/9'/0/5");
    psbt.finalizeAllInputs();
    return fake.relay(psbt.extractTransaction().toHex());
  }

  it("a confirmed transaction: there is nothing to speed up", async () => {
    const fake = newFake();
    const { txid } = await sendOriginal(fake, ACCOUNTS[0]);
    fake.confirmed.add(txid);
    await expectRefused(fake, txid, "confirmed", /confirmed already/);
  });

  it("a transaction that does not signal replace-by-fee (every send before 2026-10-01)", async () => {
    const fake = newFake();
    const txid = handBuilt(fake, 0xffffffff);
    rememberOwnBtcTx(txid);
    await expectRefused(fake, txid, "not-rbf", /without replace-by-fee/);
  });

  it("one the app did not build — the swap engine can spend the same keys — even though every input is the wallet's", async () => {
    const fake = newFake();
    const txid = handBuilt(fake, BTC_RBF_SEQUENCE);
    await expectRefused(fake, txid, "not-own-tx", /did not send it/);
  });

  it("an input that is not the wallet's: never signed", async () => {
    const fake = newFake();
    const txid = handBuilt(fake, BTC_RBF_SEQUENCE, true);
    rememberOwnBtcTx(txid);
    await expectRefused(fake, txid, "not-own-inputs", /Not every coin/);
  });

  it("an output already spent by a child: replacing would cancel the child too", async () => {
    const fake = newFake();
    const { txid, tx } = await sendOriginal(fake, ACCOUNTS[0]);
    // A child spending the change (output 1), as a later send could.
    const changeNode = root.derive("m/84'/0'/0'/1/0");
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({
      hash: txid,
      index: 1,
      sequence: BTC_RBF_SEQUENCE,
      witnessUtxo: { script: tx.outs[1].script, value: tx.outs[1].value },
    });
    psbt.addOutput({ address: TO, value: tx.outs[1].value - 500n });
    psbt.signInput(0, {
      publicKey: Buffer.from(changeNode.publicKey!),
      sign: (h: Buffer) => Buffer.from(tinysecp.sign(h, changeNode.privateKey!)),
    });
    psbt.finalizeAllInputs();
    const child = fake.relay(psbt.extractTransaction().toHex());
    await expectRefused(fake, txid, "descendants", new RegExp(`already spent by ${child}`));
  });

  it("no change output (the legacy sweep pays one output): would need another input, which is not done", async () => {
    const fake = newFake();
    const legacy = deriveLegacyBtcFromMnemonic(M);
    fake.fund(legacy.address, p2wpkhOut(pubAt("m/44'/0'/0'/0/0")), 1_000_000);
    await sweepLegacyBtcToAddress(legacy.privateKey, TO, 2);
    const sweep = pushedSince(fake, 0);
    expect(sweep.ins.every((i) => i.sequence === BTC_RBF_SEQUENCE)).toBe(true);
    await expectRefused(fake, sweep.getId(), "no-change", /no change output.*another of your coins added as an input/s);
  });

  it("change too small to pay the extra fee and stay above dust", async () => {
    const fake = newFake();
    const a = ACCOUNTS[0];
    fake.fund(addrAt(a, 0, 0), a.lock(pubAt(`${a.path}/0/0`)), 1_000_000);
    // 1 input, 2 outputs at 2 sat/vB is 282 sat: change of 900 sat stays (> 546).
    await btcAdapter.sendFromAccount!(M, TO, (1_000_000 - 282 - 900) / 1e8 + "", addrAt(a, 0, 0), { feeRate: 2 });
    const original = pushedSince(fake, 0);
    expect(original.outs).toHaveLength(2);
    expect(Number(original.outs[1].value)).toBe(900);
    await expectRefused(fake, original.getId(), "dust", /cannot pay the extra .* and stay above the dust limit/);
  });

  it("a transaction no explorer knows", async () => {
    const fake = newFake();
    await expectRefused(fake, "ee".repeat(32), "not-found", /does not show this transaction/);
  });

  it("one replaced already this session: the replacement is the one to speed up", async () => {
    const fake = newFake();
    const { txid } = await sendOriginal(fake, ACCOUNTS[0]);
    const q = await quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: 14 });
    const r = await speedUpBtcTransaction({ txid, secret: SECRET, targetRate: 14, expectFeeSat: q.newFeeSat });
    await expectRefused(fake, txid, "replaced", new RegExp(`replaced already, by ${r.hash}`));
    // …and the replacement itself can be sped up again.
    const again = await quoteBtcSpeedUp({ txid: r.hash, secret: SECRET, targetRate: 40 });
    expect(again.newFeeSat).toBeGreaterThan(q.newFeeSat);
  });
});

describe("the fee the user confirmed is the fee sent", () => {
  it("a different fee is refused, unsigned and unsent", async () => {
    const fake = newFake();
    const { txid, pushesBefore } = await sendOriginal(fake, ACCOUNTS[0]);
    const q = await quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: 14 });
    const e = await refusal(
      speedUpBtcTransaction({ txid, secret: SECRET, targetRate: 20, expectFeeSat: q.newFeeSat }),
    );
    expect(String(e.message)).toMatch(/not the .* BTC shown.*Nothing was sent/);
    expect(fake.pushes).toHaveLength(pushesBefore);
  });

  it("a second press while the first is signing is refused: one replacement", async () => {
    const fake = newFake();
    const { txid, pushesBefore } = await sendOriginal(fake, ACCOUNTS[0]);
    const q = await quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: 14 });
    const args = { txid, secret: SECRET, targetRate: 14, expectFeeSat: q.newFeeSat };
    const [first, second] = await Promise.allSettled([speedUpBtcTransaction(args), speedUpBtcTransaction(args)]);
    expect(first.status).toBe("fulfilled");
    expect(second.status === "rejected" && (second.reason as any).code).toBe("busy");
    pushedSince(fake, pushesBefore);
  });
});

// ── The broadcast: once, honestly ──────────────────────────────────────────

describe("the replacement's broadcast", () => {
  it("a lost reply is 'may have been sent' with the replacement's txid; the original is not marked replaced", async () => {
    const fake = newFake();
    const { txid, pushesBefore } = await sendOriginal(fake, ACCOUNTS[0]);
    const q = await quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: 14 });
    fake.onPush = (via) => (via === "esplora:blockstream.info" ? "drop" : { status: 429, body: "Too Many Requests" });
    const e = await refusal(speedUpBtcTransaction({ txid, secret: SECRET, targetRate: 14, expectFeeSat: q.newFeeSat }));
    expect(isSendOutcomeUnknown(e), String(e?.message)).toBe(true);
    const replacement = pushedSince(fake, pushesBefore);
    expect(e.hash).toBe(replacement.getId());
    expect(txReplacementOf("bitcoin", txid)).toBeUndefined();
    expect(await isOwnBtcTx(replacement.getId())).toBe(true); // recorded before the push
  });

  it("every node refusing it (e.g. too low a fee) is a plain error: nothing changed", async () => {
    const fake = newFake();
    const { txid } = await sendOriginal(fake, ACCOUNTS[0]);
    const q = await quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: 14 });
    fake.onPush = () => ({
      status: 400,
      body: 'sendrawtransaction RPC error: {"code":-26,"message":"insufficient fee, rejecting replacement"}',
    });
    const e = await refusal(speedUpBtcTransaction({ txid, secret: SECRET, targetRate: 14, expectFeeSat: q.newFeeSat }));
    expect(isSendOutcomeUnknown(e)).toBe(false);
    expect(String(e.message)).toMatch(/nothing was sent.*insufficient fee/s);
    expect(txReplacementOf("bitcoin", txid)).toBeUndefined();
  });
});

// ── Reading the original: what is trusted ──────────────────────────────────

describe("reading the original", () => {
  it("a host serving another transaction's bytes is passed over; both doing so is an error, not a guess", async () => {
    const fake = newFake();
    const { txid } = await sendOriginal(fake, ACCOUNTS[0]);
    const decoy = [...fake.raw.values()].find((h) => bitcoin.Transaction.fromHex(h).getId() !== txid)!;
    const base = fake.fetchImpl;
    vi.stubGlobal("fetch", async (input: any, init?: any) =>
      String(input).startsWith("https://blockstream.info/") && String(input).endsWith(`/tx/${txid}/hex`)
        ? new Response(decoy, { status: 200 })
        : base(input, init),
    );
    expect((await readBtcTx(txid))?.tx.getId()).toBe(txid);
    vi.stubGlobal("fetch", async (input: any, init?: any) =>
      String(input).endsWith(`/tx/${txid}/hex`) ? new Response(decoy, { status: 200 }) : base(input, init),
    );
    await expect(readBtcTx(txid)).rejects.toThrow(/served a different transaction.*served a different transaction/);
  });

  it("an explorer whose input list is not the transaction's own is refused", async () => {
    const fake = newFake();
    const { txid } = await sendOriginal(fake, ACCOUNTS[0]);
    const base = fake.fetchImpl;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const r = await base(input, init);
      if (!String(input).endsWith(`/tx/${txid}`)) return r;
      const j = JSON.parse(await r.text());
      j.vin[0].vout = 7;
      return new Response(JSON.stringify(j), { status: 200 });
    });
    await expect(readBtcTx(txid)).rejects.toThrow(/not the transaction's own/);
  });
});

describe("finding the wallet's own keys", () => {
  it("a scan's recorded path is re-derived, never taken as given", async () => {
    const real = addrAt(ACCOUNTS[0], 1, 3);
    // A record naming the wrong path for a real address: the key that signs
    // is the one the walk derives, at the right path.
    const lied = await findOwnBtcKeys(SECRET, [real, TO], {
      known: [
        { address: real, path: "m/84'/0'/0'/1/4" },
        { address: TO, path: "m/84'/0'/0'/0/0" },
      ],
    });
    expect(lied.get(real)?.path).toBe("m/84'/0'/0'/1/3");
    expect(Buffer.from(lied.get(real)!.privateKey).toString("hex")).toBe(privAt("m/84'/0'/0'/1/3"));
    // …and a record cannot make a foreign address the wallet's.
    expect(lied.has(TO)).toBe(false);
    const told = await findOwnBtcKeys(SECRET, [real], { known: [{ address: real, path: "m/84'/0'/0'/1/3" }] });
    expect(told.get(real)).toMatchObject({ path: "m/84'/0'/0'/1/3", chainIndex: 1, scriptType: "p2wpkh" });
  });

  it("a recorded index past the usual depth is reached (the walk goes 100 past the highest one recorded)", async () => {
    const deep = addrAt(ACCOUNTS[0], 1, 260);
    const none = await findOwnBtcKeys(SECRET, [deep]);
    expect(none.has(deep)).toBe(false); // 200 deep by default
    const found = await findOwnBtcKeys(SECRET, [deep], { known: [{ address: addrAt(ACCOUNTS[0], 1, 250), path: "m/84'/0'/0'/1/250" }] });
    expect(found.get(deep)?.path).toBe("m/84'/0'/0'/1/260");
  });

  it("each account is walked as its own script type; a foreign address is not the wallet's", async () => {
    const want = [addrAt(ACCOUNTS[1], 0, 5), addrAt(ACCOUNTS[2], 1, 2), addrAt(ACCOUNTS[3], 0, 1), TO];
    const found = await findOwnBtcKeys(SECRET, want, { depth: 10 });
    expect([...found.values()].map((k) => k.path).sort()).toEqual(
      ["m/44'/0'/0'/0/1", "m/44'/0'/0'/1/2", "m/49'/0'/0'/0/5"].sort(),
    );
    expect(found.has(TO)).toBe(false);
  });
});

describe("which output is the change", () => {
  const { pickChange } = __testing;
  const key = (chainIndex: 0 | 1 | null) => ({ chainIndex }) as any;

  it("one of the wallet's beside the payment; the change-chain one when the payment is the wallet's too", () => {
    expect(pickChange([{ vout: 0, address: "x", valueSat: 1 }, { vout: 1, address: "c", valueSat: 2 }], new Map([["c", key(1)]])).vout).toBe(1);
    expect(
      pickChange(
        [{ vout: 0, address: "r", valueSat: 1 }, { vout: 1, address: "c", valueSat: 2 }],
        new Map([["r", key(0)], ["c", key(1)]]),
      ).vout,
    ).toBe(1);
  });

  it("a single output, none of the wallet's, or two it cannot tell apart: refused", () => {
    expect(() => pickChange([{ vout: 0, address: "c", valueSat: 1 }], new Map([["c", key(1)]]))).toThrow(/no change output/);
    expect(() => pickChange([{ vout: 0, address: "x", valueSat: 1 }, { vout: 1, address: "y", valueSat: 2 }], new Map())).toThrow(
      /no change output/,
    );
    expect(() =>
      pickChange(
        [{ vout: 0, address: "a", valueSat: 1 }, { vout: 1, address: "b", valueSat: 2 }],
        new Map([["a", key(1)], ["b", key(1)]]),
      ),
    ).toThrow(/cannot be told which one/);
  });
});

describe("assertReplacementOf: a replacement that differs is stopped before it is sent", () => {
  it("a changed recipient amount, a non-signalling input or a different fee are each refused", async () => {
    const fake = newFake();
    const { txid, tx: original } = await sendOriginal(fake, ACCOUNTS[0]);
    const quote = await quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: 14 });
    const view = { tx: original, feeSat: feeOf(original, fake.prevOut), vsize: original.virtualSize() };
    const good = original.clone();
    good.outs[quote.change.vout].value = BigInt(quote.change.afterSat);
    expect(() => assertReplacementOf(view, good, quote)).not.toThrow();

    const paysLess = good.clone();
    paysLess.outs[0].value -= 1n;
    expect(() => assertReplacementOf(view, paysLess, quote)).toThrow(/pays output 0/);
    const final = good.clone();
    final.ins[0].sequence = 0xffffffff;
    expect(() => assertReplacementOf(view, final, quote)).toThrow(/does not signal/);
    const cheaper = good.clone();
    cheaper.outs[quote.change.vout].value += 1n;
    expect(() => assertReplacementOf(view, cheaper, quote)).toThrow(/pays output|fees/);
  });
});

describe("the history: the original leaves it, the replacement stays", () => {
  it("an unconfirmed replaced row is dropped; a confirmed one (the original won after all) is kept", async () => {
    const fake = newFake();
    const { txid } = await sendOriginal(fake, ACCOUNTS[0]);
    const q = await quoteBtcSpeedUp({ txid, secret: SECRET, targetRate: 14 });
    const r = await speedUpBtcTransaction({ txid, secret: SECRET, targetRate: 14, expectFeeSat: q.newFeeSat });
    const row = (hash: string, over: Partial<ChainTx> = {}): ChainTx => ({
      chain: "bitcoin",
      hash,
      direction: "pending",
      amount: "0.9",
      confirmations: 0,
      ...over,
    });
    const rows = [row(r.hash), row(txid)];
    expect(withoutReplacedRows("bitcoin", rows).map((t) => t.hash)).toEqual([r.hash]);
    const mined = [row(txid, { direction: "out", confirmations: undefined, height: 900_001 })];
    expect(withoutReplacedRows("bitcoin", mined)).toBe(mined);
  });
});
