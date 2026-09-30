/**
 * What a Bitcoin-family send accepts, and what it pays (2026-09-29 send-safety
 * audit — the HIGH/MEDIUM/LOW findings other than the broadcast ladder).
 *
 * Every case drives the REAL adapter against the in-process fake explorer
 * (`utxo-fake-explorer.testkit.ts`) and inspects the transaction that reached
 * the broadcast endpoint — or asserts that nothing reached it at all. Each one
 * fails on the pre-fix code; the recorded run is in fixlog-utxo.md.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";

vi.mock("../lib/tauri", () => ({
  invoke: (cmd: string, args: unknown) => (globalThis as any).__utxoFakeInvoke(cmd, args),
}));

import { FakeExplorer, verifySignedTx, h160, hex } from "./utxo-fake-explorer.testkit";
import { btcAdapter, btcUtxoAccounts } from "./btc-wallet";
import { ltcAdapter, ltcUtxoAccounts, LTC_DUST_SAT } from "./ltc-wallet";
import { dogeAdapter, dogeUtxoAccounts } from "./doge-wallet";
import { dashAdapter, dashUtxoAccounts } from "./dash-wallet";
import { bchAdapter, bchUtxoAccounts, encodeCashAddr, parseRecipient } from "./bch-wallet";
import { rvnAdapter } from "./rvn-wallet";
import type { ChainAdapter } from "./types";
import type { UtxoAccountSpec } from "./utxo-account";

const M =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(M, ""));
const pubAt = (path: string) => root.derive(path).publicKey!;
const privAt = (path: string) => Buffer.from(root.derive(path).privateKey!).toString("hex");
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
const BTC_NET = bitcoin.networks.bitcoin;
const LTC_NET = net(0x30, 0x32, "ltc", 0xb0);
const DOGE_NET = net(0x1e, 0x16, "doge", 0x9e);
const DASH_NET = net(0x4c, 0x10, "dash", 0xcc);
const RVN_NET = net(0x3c, 0x7a, "rvn-unused", 0x80);

afterEach(() => {
  vi.unstubAllGlobals();
});

function newFake(): FakeExplorer {
  const fake = new FakeExplorer();
  vi.stubGlobal("__utxoFakeInvoke", fake.invokeImpl);
  vi.stubGlobal("fetch", fake.fetchImpl);
  return fake;
}

/** Fund `values` (base units) at receive/0 of an account; returns that address. */
function fundAccount(
  fake: FakeExplorer,
  spec: UtxoAccountSpec,
  lock: (pub: Uint8Array) => Uint8Array,
  values: number[],
): string {
  const acct = root.derive(spec.accountPath);
  const r0 = acct.deriveChild(0).deriveChild(0);
  const addr = spec.deriveAddress(r0);
  for (const v of values) fake.fund(addr, lock(r0.publicKey!), v);
  return addr;
}

async function rejects(p: Promise<unknown>): Promise<Error> {
  return p.then(
    (r) => {
      throw new Error(`expected a refusal, the send returned ${JSON.stringify(r)}`);
    },
    (e) => e as Error,
  );
}

function onlyPush(fake: FakeExplorer): string {
  const pushed = fake.distinctPushedHex();
  expect(pushed, "exactly one signed transaction should have been broadcast").toHaveLength(1);
  return pushed[0];
}

// ── HIGH: amounts are parsed strictly ───────────────────────────────────────

describe("amounts are parsed strictly — '1,5' is refused, never sent as 1 (2026-09-29 send-safety audit)", () => {
  type AccountChain = {
    name: string;
    adapter: ChainAdapter;
    spec: UtxoAccountSpec;
    lock: (pub: Uint8Array) => Uint8Array;
    to: string;
    fund: number;
  };
  const CHAINS: AccountChain[] = [
    { name: "BTC", adapter: btcAdapter, spec: btcUtxoAccounts[0], lock: p2wpkh, fund: 2e8,
      to: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubAt("m/84'/0'/1'/0/0")) }).address! },
    { name: "LTC", adapter: ltcAdapter, spec: ltcUtxoAccounts[0], lock: p2wpkh, fund: 2e8,
      to: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubAt("m/84'/2'/1'/0/0")), network: LTC_NET }).address! },
    { name: "DOGE", adapter: dogeAdapter, spec: dogeUtxoAccounts[0], lock: p2pkh, fund: 200e8,
      to: bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubAt("m/44'/3'/1'/0/0")), network: DOGE_NET }).address! },
    { name: "DASH", adapter: dashAdapter, spec: dashUtxoAccounts[0], lock: p2pkh, fund: 2e8,
      to: bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubAt("m/44'/5'/1'/0/0")), network: DASH_NET }).address! },
    { name: "BCH", adapter: bchAdapter, spec: bchUtxoAccounts[0], lock: p2pkh, fund: 2e8,
      to: encodeCashAddr(h160(pubAt("m/44'/145'/1'/0/0")), "p2pkh") },
  ];
  const BAD = ["1,5", "1.000,50", "0.9abc", "1e-8", "-1", "0.123456789", ""];

  for (const c of CHAINS) {
    it(`${c.name} (account-wide) refuses every malformed amount and broadcasts nothing`, async () => {
      for (const amount of BAD) {
        const fake = newFake();
        const from = fundAccount(fake, c.spec, c.lock, [c.fund]);
        const err = await rejects(c.adapter.sendFromAccount!(M, c.to, amount, from, {}));
        expect(err.message, `amount ${JSON.stringify(amount)}`).toMatch(/amount|decimal|greater than zero/i);
        expect(fake.pushes, `amount ${JSON.stringify(amount)} reached a broadcast endpoint`).toHaveLength(0);
      }
    });
  }

  it("the single-key paths refuse '1,5' too (BTC, LTC, DOGE, DASH, BCH, RVN)", async () => {
    const cases: Array<[string, ChainAdapter, string, string, (f: FakeExplorer) => void]> = [
      ["BTC", btcAdapter, "m/84'/0'/0'/0/0", CHAINS[0].to, (f) => {
        const n = root.derive("m/84'/0'/0'/0/0");
        f.fund(bitcoin.payments.p2wpkh({ pubkey: Buffer.from(n.publicKey!) }).address!, p2wpkh(n.publicKey!), 2e8);
      }],
      ["LTC", ltcAdapter, "m/84'/2'/0'/0/0", CHAINS[1].to, (f) => {
        const n = root.derive("m/84'/2'/0'/0/0");
        f.fund(bitcoin.payments.p2wpkh({ pubkey: Buffer.from(n.publicKey!), network: LTC_NET }).address!, p2wpkh(n.publicKey!), 2e8);
      }],
      ["DOGE", dogeAdapter, "m/44'/3'/0'/0/0", CHAINS[2].to, (f) => {
        const n = root.derive("m/44'/3'/0'/0/0");
        f.fund(bitcoin.payments.p2pkh({ pubkey: Buffer.from(n.publicKey!), network: DOGE_NET }).address!, p2pkh(n.publicKey!), 200e8);
      }],
      ["DASH", dashAdapter, "m/44'/5'/0'/0/0", CHAINS[3].to, (f) => {
        const n = root.derive("m/44'/5'/0'/0/0");
        f.fund(bitcoin.payments.p2pkh({ pubkey: Buffer.from(n.publicKey!), network: DASH_NET }).address!, p2pkh(n.publicKey!), 2e8);
      }],
      ["BCH", bchAdapter, "m/44'/145'/0'/0/0", CHAINS[4].to, (f) => {
        const n = root.derive("m/44'/145'/0'/0/0");
        f.fund(encodeCashAddr(h160(n.publicKey!), "p2pkh"), p2pkh(n.publicKey!), 2e8);
      }],
      ["RVN", rvnAdapter, "m/44'/175'/0'/0/0",
        bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubAt("m/44'/175'/1'/0/0")), network: RVN_NET }).address!,
        (f) => {
          const n = root.derive("m/44'/175'/0'/0/0");
          f.fund(bitcoin.payments.p2pkh({ pubkey: Buffer.from(n.publicKey!), network: RVN_NET }).address!, p2pkh(n.publicKey!), 200e8);
        }],
    ];
    for (const [name, adapter, path, to, fundIt] of cases) {
      const fake = newFake();
      fundIt(fake);
      const err = await rejects(adapter.sendTransaction(privAt(path), to, "1,5"));
      expect(err.message, name).toMatch(/amount|decimal/i);
      expect(fake.pushes, `${name} broadcast a '1,5' send`).toHaveLength(0);
    }
  });
});

/**
 * P2SH32 CashAddr of the 32-byte hash `(i * 7 + 3) & 0xff` for i = 0..31,
 * produced by BasicSwap's `interface/bch/contrib/cashaddress.py`
 * (`Address("P2SH32", h).cash_address()`, version byte 11) — an implementation
 * independent of `bch-wallet.ts`, which reproduces the CashAddr spec's own
 * P2PKH/P2SH vectors (see bch-recipient.test.ts).
 */
const P2SH32_VECTOR = {
  address: "bitcoincash:pvps5ygcrunz6dpmgfy4q467v4k8x75p3z8ed8dy4wetnsx8em2acv2t9lryf",
};

// ── HIGH: BCH recipients ────────────────────────────────────────────────────

describe("BCH recipients (2026-09-29 send-safety audit)", () => {
  function bchFake() {
    const fake = newFake();
    const from = fundAccount(fake, bchUtxoAccounts[0], p2pkh, [50_000_000]);
    return { fake, from };
  }

  it("refuses a BTC-format legacy address (1… and 3…) and broadcasts nothing", async () => {
    const pk = Buffer.from(pubAt("m/44'/145'/1'/0/0"));
    const legacyP2pkh = bitcoin.payments.p2pkh({ pubkey: pk }).address!; // 1…
    // What a pasted BTC SegWit-wrapped deposit address looks like: on BCH its
    // output is spendable by anyone who learns the redeem script.
    const btcP2shP2wpkh = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: pk }) }).address!; // 3…
    for (const to of [legacyP2pkh, btcP2shP2wpkh]) {
      expect(() => parseRecipient(to), to).toThrow(/CashAddr/);
      const { fake, from } = bchFake();
      const err = await rejects(bchAdapter.sendFromAccount!(M, to, "0.1", from, {}));
      expect(err.message).toMatch(/CashAddr/);
      expect(fake.pushes).toHaveLength(0);
    }
  });

  it("a P2SH32 CashAddr gets OP_HASH256 <32 bytes> OP_EQUAL — not a 20-byte push around 32 bytes", async () => {
    const hash32 = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
    // Encoded by an independent CashAddr implementation (BasicSwap's
    // `contrib/cashaddress.py`, version byte 11 = P2SH, 256-bit hash) — see
    // bch-recipient.test.ts for how the vector was produced.
    const to = P2SH32_VECTOR.address;
    expect(hex(parseRecipient(to).hash)).toBe(hex(hash32));
    const { fake, from } = bchFake();
    await bchAdapter.sendFromAccount!(M, to, "0.1", from, {});
    const tx = bitcoin.Transaction.fromHex(onlyPush(fake));
    expect(hex(tx.outs[0].script)).toBe("aa20" + hex(hash32) + "87");
  });

  it("the send-time fee rate is capped: a 5000 sat/B oracle reading does not reach the transaction", async () => {
    const { fake, from } = bchFake();
    fake.fees.blockchairPerByte = 5000;
    await bchAdapter.sendFromAccount!(M, encodeCashAddr(h160(pubAt("m/44'/145'/1'/0/0")), "p2pkh"), "0.1", from, {});
    const v = verifySignedTx(onlyPush(fake), "bch", fake.prevOut);
    expect(v.problems).toEqual([]);
    // ≤ BCH_MAX_FEE_RATE (10 sat/B), plus the estimate's slack: inputs are
    // budgeted at their 148-byte maximum and a signature is often a byte shorter.
    expect(v.fee / v.vsize).toBeLessThanOrEqual(10 * 1.05);
    expect(v.fee / v.vsize).toBeGreaterThanOrEqual(1);
  });
});


// ── MEDIUM: DOGE fee oracle clamp ───────────────────────────────────────────

describe("DOGE fee rate is clamped to a sane band (2026-09-29 send-safety audit)", () => {
  const to = bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubAt("m/44'/3'/1'/0/0")), network: DOGE_NET }).address!;

  for (const [label, blockcypherPerKb, blockchairPerByte] of [
    ["BlockCypher's live medium rate, 58,349,538 sat/kB", 58_349_538, 1],
    ["BlockCypher down, Blockchair's live 500,000 sat/B", 0, 500_000],
  ] as const) {
    it(`${label}: the send goes through at ≤ 0.04 DOGE/kB instead of throwing`, async () => {
      const fake = newFake();
      fake.fees.blockcypherPerKb = blockcypherPerKb;
      fake.fees.blockchairPerByte = blockchairPerByte;
      const from = fundAccount(fake, dogeUtxoAccounts[0], p2pkh, [100e8]);
      await dogeAdapter.sendFromAccount!(M, to, "10", from, {});
      const v = verifySignedTx(onlyPush(fake), "p2pkh", fake.prevOut);
      expect(v.problems).toEqual([]);
      const perByte = v.fee / v.vsize;
      expect(perByte).toBeGreaterThanOrEqual(1000); // Dogecoin Core's recommended 0.01 DOGE/kB
      expect(perByte).toBeLessThanOrEqual(4000 * 1.02); // the band's ceiling, + estimate slack
      const est = await dogeAdapter.getFeeEstimate();
      expect(Number(est.normal.value)).toBeLessThanOrEqual(0.04 * 0.226 + 1e-8);
    });
  }

  it("folding sub-0.01-DOGE change into the fee does not trip the 5000 sat/B guard", async () => {
    // One 1-DOGE coin, sending 0.989: the 0.00874 DOGE of change is below
    // Dogecoin's soft-dust line, so it goes to the fee — 1.1 M sat on a
    // 192-byte transaction, ~5,700 sat/B. bitcoinjs' default guard refused it.
    const fake = newFake();
    const from = fundAccount(fake, dogeUtxoAccounts[0], p2pkh, [100_000_000]);
    await dogeAdapter.sendFromAccount!(M, to, "0.989", from, {});
    const v = verifySignedTx(onlyPush(fake), "p2pkh", fake.prevOut);
    expect(v.problems).toEqual([]);
    expect(v.outputs).toHaveLength(1);
    expect(v.fee).toBe(100_000_000 - 98_900_000);
  });
});

// ── LOW: fabricated SegWit addresses on chains without SegWit ────────────────

describe("DOGE and DASH never pay a bech32 address (2026-09-29 send-safety audit)", () => {
  it("a checksum-valid doge1… / dash1… address is refused before anything is signed", async () => {
    for (const [name, adapter, spec, hrp] of [
      ["DOGE", dogeAdapter, dogeUtxoAccounts[0], "doge"],
      ["DASH", dashAdapter, dashUtxoAccounts[0], "dash"],
    ] as const) {
      const fake = newFake();
      const from = fundAccount(fake, spec, p2pkh, [200e8]);
      const fabricated = bitcoin.address.toBech32(Buffer.from(h160(pubAt("m/44'/0'/9'/0/0"))), 0, hrp);
      await rejects(adapter.sendFromAccount!(M, fabricated, "1", from, {}));
      expect(fake.pushes, name).toHaveLength(0);
    }
  });
});

// ── MEDIUM: RVN broadcast request shape ─────────────────────────────────────

describe("RVN broadcasts the raw hex to BlockBook's /api/v2/sendtx/ (2026-09-29 send-safety audit)", () => {
  it("POSTs the unquoted hex, text/plain, to the slash-terminated path", async () => {
    const fake = newFake();
    const n = root.derive("m/44'/175'/0'/0/0");
    const from = bitcoin.payments.p2pkh({ pubkey: Buffer.from(n.publicKey!), network: RVN_NET }).address!;
    fake.fund(from, p2pkh(n.publicKey!), 100e8);
    const to = bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubAt("m/44'/175'/1'/0/0")), network: RVN_NET }).address!;
    const r = await rvnAdapter.sendTransaction(privAt("m/44'/175'/0'/0/0"), to, "10");
    const bb = fake.pushes.filter((p) => p.via.startsWith("blockbook"));
    expect(bb).toHaveLength(1);
    expect(bb[0].url).toBe("https://blockbook.ravencoin.org/api/v2/sendtx/");
    expect(bb[0].method).toBe("POST");
    expect(bb[0].contentType).toMatch(/^text\/plain/);
    expect(bb[0].rawBody).toMatch(/^[0-9a-f]+$/);
    expect(r.hash).toBe(bitcoin.Transaction.fromHex(bb[0].rawBody).getId());
  });
});

// ── MEDIUM: the recipient output is sized from its script ───────────────────

describe("the fee covers the recipient's actual output size (2026-09-29 send-safety audit)", () => {
  const pk = Buffer.from(pubAt("m/84'/0'/1'/0/0"));
  const xonly = pk.subarray(1, 33);
  const cases: Array<[string, ChainAdapter, UtxoAccountSpec, string]> = [
    ["BTC → P2TR", btcAdapter, btcUtxoAccounts[0], bitcoin.payments.p2tr({ internalPubkey: xonly, network: BTC_NET }).address!],
    ["BTC → P2WSH", btcAdapter, btcUtxoAccounts[0],
      bitcoin.payments.p2wsh({ redeem: bitcoin.payments.p2pkh({ pubkey: pk }), network: BTC_NET }).address!],
    ["BTC → P2PKH", btcAdapter, btcUtxoAccounts[0], bitcoin.payments.p2pkh({ pubkey: pk, network: BTC_NET }).address!],
    ["LTC → P2TR", ltcAdapter, ltcUtxoAccounts[0], bitcoin.payments.p2tr({ internalPubkey: xonly, network: LTC_NET }).address!],
  ];
  for (const [label, adapter, spec, to] of cases) {
    it(`${label} at the 1 sat/vB tier pays at least 1 sat/vB`, async () => {
      const fake = newFake();
      const from = fundAccount(fake, spec, p2wpkh, [100_000_000]);
      await adapter.sendFromAccount!(M, to, "0.5", from, { feeRate: 1 });
      const v = verifySignedTx(onlyPush(fake), "p2wpkh", fake.prevOut);
      expect(v.problems).toEqual([]);
      expect(v.fee / v.vsize, `${v.fee} sat over ${v.vsize} vB`).toBeGreaterThanOrEqual(1);
    });
  }
});

// ── MEDIUM: Litecoin's dust threshold ───────────────────────────────────────

describe("LTC change below Litecoin's 2,940-lit P2WPKH dust line is folded, not emitted (2026-09-29 send-safety audit)", () => {
  it("LTC_DUST_SAT is Litecoin Core's threshold for a P2WPKH output (30,000 lit/kB × 98 B)", () => {
    expect(LTC_DUST_SAT).toBe(2_940);
  });

  it("a send that would leave 1,000 lits of change pays it to the fee instead", async () => {
    const fake = newFake();
    const from = fundAccount(fake, ltcUtxoAccounts[0], p2wpkh, [100_000_000]);
    // 1 input, 2 P2WPKH outputs at 1 lit/vB = 141 lits; leave 1,000 of change.
    const to = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubAt("m/84'/2'/1'/0/0")), network: LTC_NET }).address!;
    const amount = ((100_000_000 - 141 - 1_000) / 1e8).toFixed(8);
    await ltcAdapter.sendFromAccount!(M, to, amount, from, { feeRate: 1 });
    const v = verifySignedTx(onlyPush(fake), "p2wpkh", fake.prevOut);
    expect(v.problems).toEqual([]);
    expect(v.outputs.map((o) => o.value).filter((x) => x < 2_940)).toEqual([]);
    expect(v.outputs).toHaveLength(1);
  });
});

// ── MEDIUM: single-key paths size the fee from the real transaction ─────────

describe("single-key sends price the transaction they actually build (2026-09-29 send-safety audit)", () => {
  it("BTC: three inputs at the modal's 3 sat/vB tier pay ≥ 3 sat/vB (was a fixed 140 vB at the oracle rate)", async () => {
    const fake = newFake();
    fake.fees.esplora = { "1": 1, "3": 1, "6": 1, "144": 1 };
    const n = root.derive("m/84'/0'/0'/0/0");
    const from = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(n.publicKey!) }).address!;
    for (const v of [40_000_000, 30_000_000, 30_000_000]) fake.fund(from, p2wpkh(n.publicKey!), v);
    const to = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubAt("m/84'/0'/1'/0/0")) }).address!;
    await btcAdapter.sendTransaction(privAt("m/84'/0'/0'/0/0"), to, "0.95", undefined, { feeRate: 3 } as any);
    const v = verifySignedTx(onlyPush(fake), "p2wpkh", fake.prevOut);
    expect(v.problems).toEqual([]);
    expect(v.inputs).toBe(3);
    expect(v.fee / v.vsize).toBeGreaterThanOrEqual(3);
  });

  it("LTC legacy (Exodus L… address): three P2PKH inputs at 1 lit/vB pay ≥ 1 lit/vB (was a fixed 226 vB)", async () => {
    const fake = newFake();
    fake.fees.mempoolRecommended = { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 };
    const n = root.derive("m/44'/2'/0'/0/0");
    const from = bitcoin.payments.p2pkh({ pubkey: Buffer.from(n.publicKey!), network: LTC_NET }).address!;
    for (const v of [40_000_000, 30_000_000, 30_000_000]) fake.fund(from, p2pkh(n.publicKey!), v);
    const to = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubAt("m/84'/2'/1'/0/0")), network: LTC_NET }).address!;
    await ltcAdapter.sendTransaction(privAt("m/44'/2'/0'/0/0"), to, "0.95");
    const v = verifySignedTx(onlyPush(fake), "p2pkh", fake.prevOut);
    expect(v.problems).toEqual([]);
    expect(v.inputs).toBe(3);
    expect(v.fee / v.vsize).toBeGreaterThanOrEqual(1);
  });

  it("RVN: three inputs pay ≥ 0.01 RVN/kB of the real size (was a fixed 226 bytes)", async () => {
    const fake = newFake();
    const n = root.derive("m/44'/175'/0'/0/0");
    const from = bitcoin.payments.p2pkh({ pubkey: Buffer.from(n.publicKey!), network: RVN_NET }).address!;
    for (const v of [40e8, 30e8, 30e8]) fake.fund(from, p2pkh(n.publicKey!), v);
    const to = bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubAt("m/44'/175'/1'/0/0")), network: RVN_NET }).address!;
    await rvnAdapter.sendTransaction(privAt("m/44'/175'/0'/0/0"), to, "95");
    const v = verifySignedTx(onlyPush(fake), "p2pkh", fake.prevOut);
    expect(v.problems).toEqual([]);
    expect(v.inputs).toBe(3);
    // 0.01 RVN/kB = 1,000 sat per byte.
    expect(v.fee / v.vsize).toBeGreaterThanOrEqual(1000);
  });

  it("DASH: 100 duffs of change is folded into the fee, not emitted as a dust output", async () => {
    const fake = newFake();
    fake.fees.blockcypherPerKb = 10_000; // 10 duffs/B
    const n = root.derive("m/44'/5'/0'/0/0");
    const from = bitcoin.payments.p2pkh({ pubkey: Buffer.from(n.publicKey!), network: DASH_NET }).address!;
    fake.fund(from, p2pkh(n.publicKey!), 100_000_000);
    const to = bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubAt("m/44'/5'/1'/0/0")), network: DASH_NET }).address!;
    const amount = ((100_000_000 - 2_260 - 100) / 1e8).toFixed(8);
    await dashAdapter.sendTransaction(privAt("m/44'/5'/0'/0/0"), to, amount);
    const v = verifySignedTx(onlyPush(fake), "p2pkh", fake.prevOut);
    expect(v.problems).toEqual([]);
    expect(v.outputs.map((o) => o.value).filter((x) => x < 546)).toEqual([]);
  });
});

// ── LOW: recipient hygiene ──────────────────────────────────────────────────

describe("recipient hygiene (2026-09-29 send-safety audit)", () => {
  const to = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubAt("m/84'/0'/1'/0/0")) }).address!;
  const script = hex(bitcoin.address.toOutputScript(to));

  for (const [label, typed] of [
    ["surrounding whitespace / a pasted newline", `  ${to}\n`],
    ["a bitcoin: payment URI", `bitcoin:${to}?amount=0.1&label=invoice`],
  ] as const) {
    it(`BTC accepts ${label}, paying the address itself`, async () => {
      const fake = newFake();
      const from = fundAccount(fake, btcUtxoAccounts[0], p2wpkh, [100_000_000]);
      await btcAdapter.sendFromAccount!(M, typed, "0.1", from, { feeRate: 1 });
      const tx = bitcoin.Transaction.fromHex(onlyPush(fake));
      expect(hex(tx.outs[0].script)).toBe(script);
    });
  }

  it("BTC refuses a payment below the recipient's dust threshold (294 sat for P2WPKH)", async () => {
    const fake = newFake();
    const from = fundAccount(fake, btcUtxoAccounts[0], p2wpkh, [100_000_000]);
    const err = await rejects(btcAdapter.sendFromAccount!(M, to, "0.00000100", from, { feeRate: 1 }));
    expect(err.message).toMatch(/dust/i);
    expect(fake.pushes).toHaveLength(0);
  });

  it("BTC refuses a future-SegWit (v2+) address rather than paying an output anyone may spend", async () => {
    const fake = newFake();
    const from = fundAccount(fake, btcUtxoAccounts[0], p2wpkh, [100_000_000]);
    const v2 = bitcoin.address.toBech32(Buffer.alloc(32, 7), 2, "bc");
    await rejects(btcAdapter.sendFromAccount!(M, v2, "0.1", from, { feeRate: 1 }));
    expect(fake.pushes).toHaveLength(0);
  });
});
