/**
 * A NEAR Intents BTC deposit signals replace-by-fee, by either of the two
 * paths that build one, and its speed-up keeps the deposit's address and
 * amount to the satoshi (operator request, 2026-10-01). A deposit one satoshi
 * short is refunded rather than swapped, so "pays every recipient the same"
 * is the property the swap depends on.
 *
 *  - The account-wide path (`executeAccountUtxoTransfer` → the BTC adapter's
 *    `sendFromAccount`), every wallet whose phrase is loaded: run for real
 *    against the fake explorer.
 *  - The single-address fallback (`executeUtxoTransfer`, PSBT built here,
 *    signed in Rust): the PSBT handed to the signer carries 0xfffffffd on
 *    every input for BTC, and still 0xffffffff for LTC, whose nodes refuse
 *    replacements by default. The Rust signer is stubbed; it signs the
 *    sequences it is given (`swap/btc.rs`: `SighashCache` over the PSBT's own
 *    unsigned transaction), so no Rust change is needed.
 *
 * The BTC cases fail on 6b4e160 (0xffffffff everywhere).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";

const S = vi.hoisted(() => ({ signed: [] as Array<{ psbtHex: string; chain: string }>, rawTx: "00" }));
vi.mock("../../lib/tauri", () => ({
  invoke: (cmd: string, args: unknown) => (globalThis as any).__utxoFakeInvoke(cmd, args),
}));
vi.mock("../../api/swap-rust", () => ({
  signPsbt: vi.fn(async (_sid: string, psbtHex: string, chain: string) => {
    S.signed.push({ psbtHex, chain });
    return { rawTx: S.rawTx };
  }),
  broadcastTx: vi.fn(async () => "accepted"),
  signEvm: vi.fn(),
}));
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

import { FakeExplorer } from "../../wallets/utxo-fake-explorer.testkit";
import { executeAccountUtxoTransfer, executeUtxoTransfer } from "./swap-sources";
import { quoteBtcSpeedUp, speedUpBtcTransaction } from "../../wallets/btc-rbf";
import { _resetOwnBtcTxsForTests, isOwnBtcTx } from "../../wallets/btc-own-txs";
import { _clearTxReplacementsForTests } from "../../wallets/tx-replacements";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(M, ""));
const NET = bitcoin.networks.bitcoin;
const p2wpkh = (path: string, network = NET) =>
  bitcoin.payments.p2wpkh({ pubkey: Buffer.from(root.derive(path).publicKey!), network });
const FROM = p2wpkh("m/84'/0'/0'/0/0");
const DEPOSIT = p2wpkh("m/84'/0'/7'/0/0").address!;

beforeEach(() => {
  S.signed.length = 0;
  S.rawTx = "00";
  memory.clear();
  _resetOwnBtcTxsForTests();
  _clearTxReplacementsForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe("the account-wide deposit (the path every phrase wallet takes)", () => {
  it("signals RBF, and its speed-up pays the deposit address the exact same amount", async () => {
    const fake = new FakeExplorer();
    vi.stubGlobal("__utxoFakeInvoke", fake.invokeImpl);
    vi.stubGlobal("fetch", fake.fetchImpl);
    fake.fund(FROM.address!, FROM.output!, 30_000_000);

    const r = await executeAccountUtxoTransfer({
      chainKey: "bitcoin",
      mnemonic: M,
      fromAddress: FROM.address!,
      depositAddress: DEPOSIT,
      amountAtomic: "12345678",
      decimals: 8,
      ticker: "BTC",
    });
    const pushed = fake.distinctPushedHex();
    expect(pushed).toHaveLength(1);
    const deposit = bitcoin.Transaction.fromHex(pushed[0]);
    expect(deposit.getId()).toBe(r.txHash);
    expect(deposit.ins.map((i) => i.sequence)).toEqual([0xfffffffd]);
    expect(await isOwnBtcTx(r.txHash)).toBe(true);

    const quote = await quoteBtcSpeedUp({ txid: r.txHash, secret: { mnemonic: M }, targetRate: 30 });
    await speedUpBtcTransaction({ txid: r.txHash, secret: { mnemonic: M }, targetRate: 30, expectFeeSat: quote.newFeeSat });
    const after = fake.distinctPushedHex();
    expect(after).toHaveLength(2);
    const replacement = bitcoin.Transaction.fromHex(after[1]);
    const paid = (tx: bitcoin.Transaction) =>
      tx.outs.filter((o) => bitcoin.address.fromOutputScript(o.script, NET) === DEPOSIT).map((o) => Number(o.value));
    expect(paid(deposit)).toEqual([12_345_678]);
    expect(paid(replacement)).toEqual([12_345_678]);
    expect(replacement.ins.map((i) => i.sequence)).toEqual([0xfffffffd]);
  });
});

describe("the single-address fallback (PSBT built in TypeScript, signed in Rust)", () => {
  function stubEsplora(base: string, address: string, script: Uint8Array) {
    const prev = "5e".repeat(32);
    vi.stubGlobal("fetch", async (input: any) => {
      const url = String(input);
      if (url === `${base}/address/${address}/utxo`) {
        return new Response(JSON.stringify([{ txid: prev, vout: 0, value: 1_000_000 }]));
      }
      if (url === `${base}/tx/${prev}`) {
        return new Response(JSON.stringify({ vout: [{ scriptpubkey: Buffer.from(script).toString("hex") }] }));
      }
      if (url === `${base}/fee-estimates`) return new Response(JSON.stringify({ "3": 4 }));
      return new Response("not found", { status: 404 });
    });
  }

  it("BTC: every input of the PSBT the signer gets is 0xfffffffd, and the signed deposit is recorded as the app's own", async () => {
    const base = "https://blockstream.info/api";
    stubEsplora(base, FROM.address!, FROM.output!);
    // What Rust returns: any signed transaction; its id is what is recorded.
    const signed = new bitcoin.Transaction();
    signed.addInput(Buffer.alloc(32, 1), 0, 0xfffffffd);
    signed.addOutput(FROM.output!, 900_000n);
    S.rawTx = signed.toHex();
    await executeUtxoTransfer({
      sessionId: "s",
      chain: "btc",
      fromAddress: FROM.address!,
      depositAddress: DEPOSIT,
      amountAtomic: "500000",
      rpcUrl: base,
    });
    expect(S.signed).toHaveLength(1);
    const psbt = bitcoin.Psbt.fromHex(S.signed[0].psbtHex);
    expect(psbt.txInputs.map((i) => i.sequence)).toEqual([0xfffffffd]);
    expect(await isOwnBtcTx(signed.getId())).toBe(true);
  });

  it("LTC: unchanged, 0xffffffff — Litecoin nodes refuse replacements by default", async () => {
    const LTC = { ...NET, bech32: "ltc", pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
    const from = p2wpkh("m/84'/2'/0'/0/0", LTC);
    const to = p2wpkh("m/84'/2'/7'/0/0", LTC).address!;
    const base = "https://litecoinspace.org/api";
    stubEsplora(base, from.address!, from.output!);
    await executeUtxoTransfer({
      sessionId: "s",
      chain: "ltc",
      fromAddress: from.address!,
      depositAddress: to,
      amountAtomic: "500000",
      rpcUrl: base,
    });
    const psbt = bitcoin.Psbt.fromHex(S.signed[0].psbtHex);
    expect(psbt.txInputs.map((i) => i.sequence)).toEqual([0xffffffff]);
  });
});
