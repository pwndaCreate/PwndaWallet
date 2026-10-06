/**
 * Which transactions signal replace-by-fee (operator request, 2026-10-01).
 *
 * EVERY Bitcoin transaction the wallet builds: the account-wide send (which is
 * also what a NEAR Intents BTC deposit uses) on each of the four BTC accounts,
 * the single-key send on each of the three script types, and the legacy
 * sweep. On 6b4e160 each of these signed nSequence 0xffffffff on every input
 * (bitcoinjs-lib's default), so none could ever be replaced; every BTC case
 * below fails there (checked by running this file against that version of
 * `btc-wallet.ts`; see the fix log).
 *
 * NOTHING else. Litecoin nodes refuse replacements by default — Litecoin Core
 * v0.21.5.8 ships `DEFAULT_ENABLE_REPLACEMENT = false` (src/validation.h:80)
 * and replaces only under `-mempoolreplacement` (src/validation.cpp:660-672) —
 * so LTC keeps 0xffffffff, as do DOGE, DASH, BCH and RVN, whose builders this
 * change does not touch. Those cases pass on both versions: they pin that the
 * change stayed where it belongs.
 *
 * And every BTC transaction is recorded as the app's own before its first
 * push (`btc-own-txs.ts`) — the gate a speed-up checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";

vi.mock("../lib/tauri", () => ({
  invoke: (cmd: string, args: unknown) => (globalThis as any).__utxoFakeInvoke(cmd, args),
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

import { FakeExplorer, h160 } from "./utxo-fake-explorer.testkit";
import { btcAdapter, btcUtxoAccounts, deriveLegacyBtcFromMnemonic, sweepLegacyBtcToAddress } from "./btc-wallet";
import { ltcAdapter, ltcUtxoAccounts } from "./ltc-wallet";
import { dogeAdapter, dogeUtxoAccounts } from "./doge-wallet";
import { dashAdapter, dashUtxoAccounts } from "./dash-wallet";
import { bchAdapter, bchUtxoAccounts, encodeCashAddr } from "./bch-wallet";
import { rvnAdapter } from "./rvn-wallet";
import { _ownBtcTxWritesForTests, _resetOwnBtcTxsForTests, isOwnBtcTx } from "./btc-own-txs";
import { isSendOutcomeUnknown } from "./send-outcome";
import type { ChainAdapter } from "./types";
import type { UtxoAccountSpec } from "./utxo-account";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(M, ""));
const NET = bitcoin.networks.bitcoin;
const pubAt = (path: string) => Buffer.from(root.derive(path).publicKey!);
const privAt = (path: string) => Buffer.from(root.derive(path).privateKey!).toString("hex");
const p2wpkh = (pub: Uint8Array, network = NET) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pub), network }).output!;
const p2pkh = (pub: Uint8Array) => bitcoin.payments.p2pkh({ hash: Buffer.from(h160(pub)) }).output!;
const p2sh = (pub: Uint8Array) =>
  bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pub), network: NET }), network: NET }).output!;
const addressOf = (script: Uint8Array) => bitcoin.address.fromOutputScript(script, NET);
const TO = addressOf(p2wpkh(pubAt("m/84'/0'/9'/0/0")));

beforeEach(() => {
  memory.clear();
  _resetOwnBtcTxsForTests();
});
afterEach(() => vi.unstubAllGlobals());

function newFake(): FakeExplorer {
  const fake = new FakeExplorer();
  vi.stubGlobal("__utxoFakeInvoke", fake.invokeImpl);
  vi.stubGlobal("fetch", fake.fetchImpl);
  return fake;
}

function onlyPush(fake: FakeExplorer): bitcoin.Transaction {
  const hexes = fake.distinctPushedHex();
  expect(hexes, "exactly one signed transaction should have been pushed").toHaveLength(1);
  return bitcoin.Transaction.fromHex(hexes[0]);
}

const sequences = (tx: bitcoin.Transaction) => tx.ins.map((i) => i.sequence.toString(16));
const RBF = (n: number) => Array(n).fill("fffffffd");
const FINAL = (n: number) => Array(n).fill("ffffffff");

// ── BTC: every builder signals ──────────────────────────────────────────────

describe("BTC: every transaction the wallet builds signals replace-by-fee (0xfffffffd)", () => {
  for (const spec of btcUtxoAccounts) {
    const lock = spec.scriptType === "p2wpkh" ? p2wpkh : spec.scriptType === "p2sh-p2wpkh" ? p2sh : p2pkh;
    it(`account-wide send (and swap deposit) — ${spec.label}`, async () => {
      const fake = newFake();
      const at = (c: number, i: number) => `${spec.accountPath}/${c}/${i}`;
      fake.fund(addressOf(lock(pubAt(at(0, 0)))), lock(pubAt(at(0, 0))), 30_000_000);
      fake.fund(addressOf(lock(pubAt(at(0, 1)))), lock(pubAt(at(0, 1))), 70_000_000);
      await btcAdapter.sendFromAccount!(M, TO, "0.9", addressOf(lock(pubAt(at(0, 0)))), { feeRate: 2 });
      const tx = onlyPush(fake);
      expect(sequences(tx)).toEqual(RBF(2));
      // Final and without a relative lock, exactly as before: version 2, locktime 0.
      expect([tx.version, tx.locktime]).toEqual([2, 0]);
    });
  }

  for (const [kind, lock] of [
    ["p2wpkh", p2wpkh],
    ["p2sh-p2wpkh", p2sh],
    ["p2pkh", p2pkh],
  ] as const) {
    it(`single-key send — a ${kind} key`, async () => {
      const fake = newFake();
      const path = kind === "p2wpkh" ? "m/84'/0'/0'/0/0" : kind === "p2sh-p2wpkh" ? "m/49'/0'/0'/0/0" : "m/44'/0'/0'/0/0";
      fake.fund(addressOf(lock(pubAt(path))), lock(pubAt(path)), 100_000_000);
      await btcAdapter.sendTransaction(privAt(path), TO, "0.5", undefined, { feeRate: 3 });
      expect(sequences(onlyPush(fake))).toEqual(RBF(1));
    });
  }

  it("the legacy-address sweep", async () => {
    const fake = newFake();
    const legacy = deriveLegacyBtcFromMnemonic(M);
    fake.fund(legacy.address, p2wpkh(pubAt("m/44'/0'/0'/0/0")), 1_000_000);
    fake.fund(legacy.address, p2wpkh(pubAt("m/44'/0'/0'/0/0")), 2_000_000);
    await sweepLegacyBtcToAddress(legacy.privateKey, TO, 2);
    expect(sequences(onlyPush(fake))).toEqual(RBF(2));
  });
});

describe("BTC: every transaction is recorded as the app's own before it is pushed", () => {
  it("a send that was accepted", async () => {
    const fake = newFake();
    fake.fund(addressOf(p2wpkh(pubAt("m/84'/0'/0'/0/0"))), p2wpkh(pubAt("m/84'/0'/0'/0/0")), 50_000_000);
    const r = await btcAdapter.sendFromAccount!(M, TO, "0.1", undefined, { feeRate: 2 });
    expect(await isOwnBtcTx(r.hash)).toBe(true);
    // …and written down, so a restart still knows it.
    await _ownBtcTxWritesForTests();
    expect(JSON.stringify(memory.get("btc-own-txs.json|txids"))).toContain(r.hash);
  });

  it("a send whose reply was lost is recorded too: it may be on the network", async () => {
    const fake = newFake();
    fake.fund(addressOf(p2wpkh(pubAt("m/84'/0'/0'/0/0"))), p2wpkh(pubAt("m/84'/0'/0'/0/0")), 50_000_000);
    fake.onPush = (via) => (via === "esplora:blockstream.info" ? "drop" : { status: 429, body: "Too Many Requests" });
    const e = await btcAdapter.sendFromAccount!(M, TO, "0.1", undefined, { feeRate: 2 }).then(
      () => null,
      (err) => err,
    );
    expect(isSendOutcomeUnknown(e)).toBe(true);
    expect(await isOwnBtcTx(e.hash)).toBe(true);
  });
});

// ── Everything else: unchanged ──────────────────────────────────────────────

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

type Other = {
  name: string;
  adapter: ChainAdapter;
  spec: UtxoAccountSpec;
  lock: (pub: Uint8Array) => Uint8Array;
  recipient: string;
  unit: number;
  feeRate?: number;
};
const OTHERS: Other[] = [
  {
    name: "LTC (Litecoin nodes refuse replacements by default)",
    adapter: ltcAdapter,
    spec: ltcUtxoAccounts[0],
    lock: (pub) => p2wpkh(pub, LTC_NET),
    recipient: bitcoin.payments.p2wpkh({ pubkey: pubAt("m/84'/2'/1'/0/0"), network: LTC_NET }).address!,
    unit: 1e8,
    feeRate: 2,
  },
  {
    name: "DOGE",
    adapter: dogeAdapter,
    spec: dogeUtxoAccounts[0],
    lock: p2pkh,
    recipient: bitcoin.payments.p2pkh({ pubkey: pubAt("m/44'/3'/1'/0/0"), network: DOGE_NET }).address!,
    unit: 100e8,
  },
  {
    name: "DASH",
    adapter: dashAdapter,
    spec: dashUtxoAccounts[0],
    lock: p2pkh,
    recipient: bitcoin.payments.p2pkh({ pubkey: pubAt("m/44'/5'/1'/0/0"), network: DASH_NET }).address!,
    unit: 1e8,
    feeRate: 10,
  },
  {
    name: "BCH",
    adapter: bchAdapter,
    spec: bchUtxoAccounts[0],
    lock: p2pkh,
    recipient: encodeCashAddr(h160(pubAt("m/44'/145'/1'/0/0")), "p2pkh"),
    unit: 1e8,
    feeRate: 1,
  },
];

describe("every other UTXO chain is unchanged: nSequence 0xffffffff", () => {
  for (const c of OTHERS) {
    it(`${c.name}: account-wide send`, async () => {
      const fake = newFake();
      const acct = root.derive(c.spec.accountPath);
      const r0 = acct.deriveChild(0).deriveChild(0);
      const r1 = acct.deriveChild(0).deriveChild(1);
      fake.fund(c.spec.deriveAddress(r0), c.lock(r0.publicKey!), Math.round(0.3 * c.unit));
      fake.fund(c.spec.deriveAddress(r1), c.lock(r1.publicKey!), Math.round(0.7 * c.unit));
      const amount = ((0.9 * c.unit) / 1e8).toFixed(8);
      const r = await c.adapter.sendFromAccount!(M, c.recipient, amount, c.spec.deriveAddress(r0), { feeRate: c.feeRate });
      const tx = onlyPush(fake);
      expect(sequences(tx)).toEqual(FINAL(2));
      // Not a BTC transaction: never offered a speed-up.
      expect(await isOwnBtcTx(r.hash)).toBe(false);
    });
  }

  it("RVN: single-key send", async () => {
    const fake = newFake();
    const node = root.derive("m/44'/175'/0'/0/0");
    fake.fund(bitcoin.payments.p2pkh({ pubkey: Buffer.from(node.publicKey!), network: RVN_NET }).address!, p2pkh(node.publicKey!), 100e8);
    const to = bitcoin.payments.p2pkh({ pubkey: pubAt("m/44'/175'/1'/0/0"), network: RVN_NET }).address!;
    await rvnAdapter.sendTransaction(Buffer.from(node.privateKey!).toString("hex"), to, "10");
    expect(sequences(onlyPush(fake))).toEqual(FINAL(1));
  });
});
