/**
 * Bitcoin wallets on the BIP-49 and BIP-44 derivations (2026-09-29 send-safety
 * audit).
 *
 * # The incident
 *
 * Import picks the FUNDED derivation (`derivation-detector.ts`): a seed from an
 * older Electrum or BlueWallet lands on BIP-49 (`m/49'/0'/0'`, P2SH-P2WPKH,
 * `3…`), one from Bitcoin Core legacy or Atomic on BIP-44 (`m/44'/0'/0'`,
 * P2PKH, `1…`). Then:
 *
 *  - the dashboard read 0 — only the BIP-84 account was ever scanned
 *    (`utxoAccounts[0]`, `resolveUtxoAccountBalance`);
 *  - Send fell to the single-key path (`supportsAccountSend` knew only the
 *    two P2WPKH accounts), which re-encoded the key as P2WPKH, found no coins
 *    at that address, and failed "No UTXOs available".
 *
 * The coins could not be moved from the app. The audit verified it offline.
 *
 * # What is pinned
 *
 *  - the two account specs derive the published addresses;
 *  - the balance is found at those addresses, on both chains;
 *  - an account-wide send spends them, priced at the real input size (91 vB
 *    wrapped SegWit, 148 vB legacy), with change of the SAME type at the
 *    lowest unused change index;
 *  - every signature verifies against a sighash computed here, by bitcoinjs-lib
 *    — `hashForWitnessV0` for P2SH-P2WPKH, legacy `hashForSignature` for P2PKH —
 *    not by the adapter;
 *  - a legacy input's previous transaction is fetched, with a fallback, and
 *    checked, before anything is signed;
 *  - the single-key path spends a BIP-49/BIP-44 key's coins as what they are.
 *
 * Nothing opens a socket: `fetch` and the Rust proxy are the in-process fake
 * explorer. Every case fails on the pre-fix code; see fixlog-btc-accounts.md.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as tinysecp from "tiny-secp256k1";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";

vi.mock("../lib/tauri", () => ({
  invoke: (cmd: string, args: unknown) => (globalThis as any).__utxoFakeInvoke(cmd, args),
}));

// The account-state cache, in memory, so each test starts from nothing.
const memory = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: async () => ({
      get: async (k: string) => memory.get(k) ?? null,
      set: async (k: string, v: unknown) => {
        memory.set(k, v);
      },
      save: async () => {},
    }),
  },
}));

import { FakeExplorer, h160, hex, addrKey } from "./utxo-fake-explorer.testkit";
import { btcAdapter, btcUtxoAccounts, btcAddressFor, deriveLegacyBtcFromMnemonic } from "./btc-wallet";
import { resolveUtxoAccountBalance } from "./utxo-account-balance";
import { isSendOutcomeUnknown } from "./send-outcome";

const M =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(M, ""));
const NET = bitcoin.networks.bitcoin;
const pubAt = (path: string) => Buffer.from(root.derive(path).publicKey!);
const privAt = (path: string) => Buffer.from(root.derive(path).privateKey!).toString("hex");

// Locking scripts, built here with bitcoinjs-lib, not with the adapter.
const p2wpkhOut = (pub: Uint8Array) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pub), network: NET }).output!;
const p2shP2wpkhOut = (pub: Uint8Array) =>
  bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pub), network: NET }), network: NET })
    .output!;
const p2pkhOut = (pub: Uint8Array) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(pub), network: NET }).output!;
const addressOf = (script: Uint8Array) => bitcoin.address.fromOutputScript(script, NET);

/** The published first receive addresses of the "abandon … about" seed. */
const BIP49_RECV0 = "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf";
const BIP44_RECV0 = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA";
const BIP84_RECV0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

type Kind = "p2wpkh" | "p2sh" | "p2pkh";
type Account = {
  name: string;
  path: string;
  lock: (pub: Uint8Array) => Uint8Array;
  kind: Kind;
  recv0: string;
  /** vbytes the send is priced at: one input, and the change output. */
  inputVB: number;
  changeVB: number;
  overheadVB: number;
};
const ACCOUNTS: Account[] = [
  { name: "BIP-49 wrapped SegWit", path: "m/49'/0'/0'", lock: p2shP2wpkhOut, kind: "p2sh", recv0: BIP49_RECV0, inputVB: 91, changeVB: 32, overheadVB: 11 },
  { name: "BIP-44 legacy", path: "m/44'/0'/0'", lock: p2pkhOut, kind: "p2pkh", recv0: BIP44_RECV0, inputVB: 148, changeVB: 34, overheadVB: 10 },
];
const at = (a: Account, chain: 0 | 1, i: number) => `${a.path}/${chain}/${i}`;
const addrAt = (a: Account, chain: 0 | 1, i: number) => addressOf(a.lock(pubAt(at(a, chain, i))));

/** An external recipient: native SegWit, another account of the same seed. */
const TO = addressOf(p2wpkhOut(pubAt("m/84'/0'/9'/0/0")));

function scriptKind(s: Uint8Array): Kind | "other" {
  if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14) return "p2wpkh";
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return "p2sh";
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9) return "p2pkh";
  return "other";
}

/**
 * Check every input's signature against a sighash bitcoinjs-lib computes
 * itself, with tiny-secp256k1 doing the ECDSA verify. The testkit's
 * `verifySignedTx` has no P2SH-P2WPKH case, hence this:
 *
 *  - P2WPKH: empty scriptSig, witness [sig, pub]; BIP-143 `hashForWitnessV0`
 *    over the P2PKH scriptCode of the key.
 *  - P2SH-P2WPKH: scriptSig pushes ONLY the redeem script `0014{hash160(pub)}`,
 *    whose hash160 is the one in the spent output; witness [sig, pub];
 *    `hashForWitnessV0` over the key's P2PKH scriptCode, committing to the
 *    spent VALUE.
 *  - P2PKH: scriptSig [sig, pub], no witness; legacy `hashForSignature` over
 *    the spent output's script.
 */
function verifyInputs(txHex: string, prevOut: Map<string, { script: Uint8Array; value: number }>) {
  const tx = bitcoin.Transaction.fromHex(txHex);
  const problems: string[] = [];
  const kinds: string[] = [];
  let inSum = 0;
  tx.ins.forEach((inp, i) => {
    const prev = prevOut.get(`${hex(Uint8Array.from(inp.hash).reverse())}:${inp.index}`);
    if (!prev) {
      problems.push(`input ${i}: spends an unknown outpoint`);
      return;
    }
    inSum += prev.value;
    const kind = scriptKind(prev.script);
    kinds.push(kind);
    let sig: Uint8Array;
    let pub: Uint8Array;
    let digest: Uint8Array;
    const scriptCode = (p: Uint8Array) => p2pkhOut(p);
    if (kind === "p2pkh") {
      if (inp.witness.length > 0) problems.push(`input ${i}: a legacy input carries a witness`);
      const chunks = bitcoin.script.decompile(inp.script) as Uint8Array[];
      if (!chunks || chunks.length !== 2) {
        problems.push(`input ${i}: scriptSig is not [sig, pubkey]`);
        return;
      }
      [sig, pub] = chunks;
      if (hex(p2pkhOut(pub)) !== hex(prev.script)) problems.push(`input ${i}: key does not own the output`);
      digest = tx.hashForSignature(i, prev.script, sig[sig.length - 1]);
    } else if (kind === "p2sh") {
      const chunks = bitcoin.script.decompile(inp.script) as Uint8Array[];
      if (!chunks || chunks.length !== 1) {
        problems.push(`input ${i}: scriptSig must push only the redeem script`);
        return;
      }
      const redeem = chunks[0];
      [sig, pub] = inp.witness as unknown as [Uint8Array, Uint8Array];
      if (hex(redeem) !== "0014" + hex(h160(pub))) problems.push(`input ${i}: redeem script is not the key's P2WPKH program`);
      const wrapped = bitcoin.payments.p2sh({ hash: Buffer.from(h160(redeem)) }).output!;
      if (hex(wrapped) !== hex(prev.script)) problems.push(`input ${i}: redeem script does not hash to the spent output`);
      digest = tx.hashForWitnessV0(i, scriptCode(pub), BigInt(prev.value), sig[sig.length - 1]);
    } else if (kind === "p2wpkh") {
      if (inp.script.length > 0) problems.push(`input ${i}: a native SegWit input has a scriptSig`);
      [sig, pub] = inp.witness as unknown as [Uint8Array, Uint8Array];
      if (hex(p2wpkhOut(pub)) !== hex(prev.script)) problems.push(`input ${i}: key does not own the output`);
      digest = tx.hashForWitnessV0(i, scriptCode(pub), BigInt(prev.value), sig[sig.length - 1]);
    } else {
      problems.push(`input ${i}: spends an output of an unexpected type`);
      return;
    }
    if (sig[sig.length - 1] !== bitcoin.Transaction.SIGHASH_ALL) problems.push(`input ${i}: not SIGHASH_ALL`);
    const d = bitcoin.script.signature.decode(Buffer.from(sig));
    if (!tinysecp.verify(digest, pub, Uint8Array.from(d.signature))) {
      problems.push(`input ${i}: signature does not verify`);
    }
  });
  const outputs = tx.outs.map((o) => ({ script: o.script, value: Number(o.value) }));
  return {
    problems,
    kinds,
    outputs,
    fee: inSum - outputs.reduce((s, o) => s + o.value, 0),
    vsize: tx.virtualSize(),
    txid: tx.getId(),
  };
}

beforeEach(() => memory.clear());
afterEach(() => vi.unstubAllGlobals());

function newFake(): FakeExplorer {
  const fake = new FakeExplorer();
  vi.stubGlobal("__utxoFakeInvoke", fake.invokeImpl);
  vi.stubGlobal("fetch", fake.fetchImpl);
  return fake;
}

function fundAt(fake: FakeExplorer, a: Account, chain: 0 | 1, i: number, sat: number): string {
  const pub = pubAt(at(a, chain, i));
  const address = addressOf(a.lock(pub));
  fake.fund(address, a.lock(pub), sat);
  return address;
}

function onlyPush(fake: FakeExplorer): string {
  const pushed = fake.distinctPushedHex();
  expect(pushed, "exactly one signed transaction should have been broadcast").toHaveLength(1);
  return pushed[0];
}

async function rejects(p: Promise<unknown>): Promise<any> {
  return p.then(
    (r) => {
      throw new Error(`expected a refusal, the send returned ${JSON.stringify(r)}`);
    },
    (e) => e,
  );
}

// ── The specs ───────────────────────────────────────────────────────────────

describe("BIP-49 and BIP-44 account specs derive the published addresses (2026-09-29 send-safety audit)", () => {
  const spec = (path: string, needle: RegExp) =>
    btcUtxoAccounts.find((s) => s.accountPath === path && needle.test(s.label));

  it("BIP-49: receive/0 is 37VucYS… (m/49'/0'/0'/0/0 of the abandon seed)", () => {
    const s = spec("m/49'/0'/0'", /49/);
    expect(s, "no BIP-49 account spec").toBeDefined();
    const node = root.derive("m/49'/0'/0'").deriveChild(0).deriveChild(0);
    expect(s!.deriveAddress(node)).toBe(BIP49_RECV0);
  });

  it("BIP-49's encoder reproduces the BIP's own (testnet) test vector: m/49'/1'/0'/0/0 → 2Mww8dC…", () => {
    // BIP-49 §Test vectors publish this seed on testnet only.
    expect(btcAddressFor(pubAt("m/49'/1'/0'/0/0"), "p2sh-p2wpkh", bitcoin.networks.testnet)).toBe(
      "2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2",
    );
  });

  it("BIP-44 legacy: receive/0 is 1LqBGSK… (m/44'/0'/0'/0/0 of the abandon seed)", () => {
    const s = spec("m/44'/0'/0'", /legacy/i);
    expect(s, "no BIP-44 P2PKH account spec").toBeDefined();
    const node = root.derive("m/44'/0'/0'").deriveChild(0).deriveChild(0);
    expect(s!.deriveAddress(node)).toBe(BIP44_RECV0);
  });

  it("both agree with bitcoinjs-lib's own payments on receive AND change, several indices deep", () => {
    for (const a of ACCOUNTS) {
      const s = btcUtxoAccounts.find((x) => x.accountPath === a.path && scriptKind(bitcoin.address.toOutputScript(x.deriveAddress(root.derive(a.path).deriveChild(0).deriveChild(0)), NET)) === a.kind);
      expect(s, `${a.name}: no spec`).toBeDefined();
      for (const chain of [0, 1] as const) {
        for (let i = 0; i < 4; i++) {
          const node = root.derive(a.path).deriveChild(chain).deriveChild(i);
          expect(s!.deriveAddress(node), `${a.name} ${chain}/${i}`).toBe(addrAt(a, chain, i));
        }
      }
    }
  });

  it("the BIP-84 default and the pre-2026-05-06 quirk are unchanged, and BIP-84 is still first", () => {
    expect(btcUtxoAccounts[0].accountPath).toBe("m/84'/0'/0'");
    expect(btcUtxoAccounts[0].deriveAddress(root.derive("m/84'/0'/0'/0/0"))).toBe(BIP84_RECV0);
    expect(btcAdapter.supportsAccountSend!(M, deriveLegacyBtcFromMnemonic(M).address)).toBe(true);
  });
});

// ── The balance ─────────────────────────────────────────────────────────────

for (const a of ACCOUNTS) {
  describe(`${a.name}: the dashboard scans the account it displays (2026-09-29 send-safety audit)`, () => {
    it("finds the balance at the right addresses, on the receive AND change chains", async () => {
      const fake = newFake();
      fundAt(fake, a, 0, 0, 30_000_000);
      fundAt(fake, a, 1, 3, 20_000_000);

      const s = await resolveUtxoAccountBalance("bitcoin", btcUtxoAccounts, M, a.recv0);

      // The old code scanned BIP-84 whatever was displayed: 0 here.
      expect(s.complete).toBe(true);
      expect(s.totalSat).toBe(50_000_000);
      const funded = s.entries.filter((e) => e.balanceSat > 0);
      expect(funded.map((e) => [e.path, e.address])).toEqual([
        [at(a, 0, 0), addrAt(a, 0, 0)],
        [at(a, 1, 3), addrAt(a, 1, 3)],
      ]);
      expect(s.account?.accountPath).toBe(a.path);
    });
  });
}

describe("the BIP-84 default still scans BIP-84 (regression)", () => {
  it("a BIP-84 wallet's balance is its BIP-84 account's", async () => {
    const fake = newFake();
    const pub = pubAt("m/84'/0'/0'/0/0");
    fake.fund(BIP84_RECV0, p2wpkhOut(pub), 12_345_678);
    // The same key's BIP-49 and BIP-44 accounts hold nothing to confuse it.
    const s = await resolveUtxoAccountBalance("bitcoin", btcUtxoAccounts, M, BIP84_RECV0);
    expect(s.totalSat).toBe(12_345_678);
    expect(s.account?.accountPath).toBe("m/84'/0'/0'");
  });
});

// ── The account-wide send ───────────────────────────────────────────────────

for (const a of ACCOUNTS) {
  describe(`${a.name}: an account-wide send spends the account (2026-09-29 send-safety audit)`, () => {
    it("supportsAccountSend accepts the displayed address (it was false, so Send fell to the single-key path)", () => {
      expect(btcAdapter.supportsAccountSend!(M, a.recv0)).toBe(true);
    });

    it("spends receive/0 and receive/1, change of the same type at the lowest unused change index, signatures verified", async () => {
      const fake = newFake();
      fundAt(fake, a, 0, 0, 30_000_000);
      fundAt(fake, a, 0, 1, 70_000_000);
      fake.markUsed(addrAt(a, 1, 0)); // change/0 used and empty → change goes to change/1

      const r = await btcAdapter.sendFromAccount!(M, TO, "0.9", a.recv0, { feeRate: 5 });

      const txHex = onlyPush(fake);
      const v = verifyInputs(txHex, fake.prevOut);
      expect(v.problems).toEqual([]);
      expect(r.hash).toBe(v.txid);
      expect(r.pending).toBe(true);
      // Both inputs are the account's own type — never re-encoded as P2WPKH.
      expect(v.kinds).toEqual([a.kind, a.kind]);
      // Recipient first, then change: same type, change/1, not the displayed address.
      expect(v.outputs).toHaveLength(2);
      expect(addressOf(v.outputs[0].script)).toBe(TO);
      expect(v.outputs[0].value).toBe(90_000_000);
      expect(hex(v.outputs[1].script)).toBe(hex(a.lock(pubAt(at(a, 1, 1)))));
      expect(addressOf(v.outputs[1].script)).not.toBe(a.recv0);
      expect(scriptKind(v.outputs[1].script)).toBe(a.kind);
    });

    it(`prices each input at ${a.inputVB} vB — the fee is exactly the planned size at the chosen rate, and covers the real size`, async () => {
      const fake = newFake();
      fundAt(fake, a, 0, 0, 30_000_000);
      fundAt(fake, a, 0, 1, 70_000_000);

      await btcAdapter.sendFromAccount!(M, TO, "0.9", a.recv0, { feeRate: 5 });
      const v = verifyInputs(onlyPush(fake), fake.prevOut);

      // overhead + 2 inputs + the recipient's real P2WPKH output (31) + change.
      const plannedVB = a.overheadVB + 2 * a.inputVB + 31 + a.changeVB;
      expect(v.fee).toBe(5 * plannedVB);
      expect(v.vsize).toBeLessThanOrEqual(plannedVB);
      expect(v.fee / v.vsize).toBeGreaterThanOrEqual(5);
    });

    it("an insufficient account is refused before anything is signed, in account terms", async () => {
      const fake = newFake();
      fundAt(fake, a, 0, 0, 10_000_000);
      const err = await rejects(btcAdapter.sendFromAccount!(M, TO, "0.5", a.recv0, { feeRate: 5 }));
      expect(String(err.message)).toMatch(/Insufficient funds/);
      expect(fake.pushes).toHaveLength(0);
    });
  });
}

describe("BIP-44 legacy inputs carry the whole previous transaction (2026-09-29 send-safety audit)", () => {
  const a = ACCOUNTS[1];

  it("fetches each spent transaction once, from Esplora, before signing", async () => {
    const fake = newFake();
    const u0 = fake.fund(addrAt(a, 0, 0), a.lock(pubAt(at(a, 0, 0))), 30_000_000);
    const u1 = fake.fund(addrAt(a, 0, 1), a.lock(pubAt(at(a, 0, 1))), 70_000_000);
    await btcAdapter.sendFromAccount!(M, TO, "0.9", a.recv0, { feeRate: 5 });
    for (const u of [u0, u1]) {
      expect(fake.requests.filter((q) => q.endsWith(`/tx/${u.txid}/hex`))).toHaveLength(1);
    }
    expect(verifyInputs(onlyPush(fake), fake.prevOut).problems).toEqual([]);
  });

  it("falls back to the second Esplora host when the first cannot serve it", async () => {
    const fake = newFake();
    fundAt(fake, a, 0, 0, 100_000_000);
    const base = fake.fetchImpl;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = String(input);
      if (url.startsWith("https://blockstream.info/") && /\/tx\/[0-9a-f]{64}\/hex$/.test(url)) {
        return new Response("upstream timeout", { status: 502 });
      }
      return base(input, init);
    });
    await btcAdapter.sendFromAccount!(M, TO, "0.5", a.recv0, { feeRate: 5 });
    expect(verifyInputs(onlyPush(fake), fake.prevOut).problems).toEqual([]);
  });

  it("a host that serves a DIFFERENT transaction is passed over, not signed against", async () => {
    const fake = newFake();
    fundAt(fake, a, 0, 0, 100_000_000);
    const decoy = fake.fund(addrAt(a, 0, 5), a.lock(pubAt(at(a, 0, 5))), 1_000);
    fake.utxos.delete(addrKey(addrAt(a, 0, 5)));
    const base = fake.fetchImpl;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = String(input);
      if (url.startsWith("https://blockstream.info/") && /\/tx\/[0-9a-f]{64}\/hex$/.test(url)) {
        return new Response(fake.raw.get(decoy.txid)!, { status: 200 });
      }
      return base(input, init);
    });
    await btcAdapter.sendFromAccount!(M, TO, "0.5", a.recv0, { feeRate: 5 });
    expect(verifyInputs(onlyPush(fake), fake.prevOut).problems).toEqual([]);
  });

  it("no host can serve it → refused with every host's reason, nothing broadcast", async () => {
    const fake = newFake();
    fundAt(fake, a, 0, 0, 100_000_000);
    const base = fake.fetchImpl;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      if (/\/tx\/[0-9a-f]{64}\/hex$/.test(String(input))) return new Response("nope", { status: 503 });
      return base(input, init);
    });
    const err = await rejects(btcAdapter.sendFromAccount!(M, TO, "0.5", a.recv0, { feeRate: 5 }));
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(String(err.message)).toMatch(/blockstream\.info: HTTP 503.*mempool\.space: HTTP 503/);
    expect(String(err.message)).toMatch(/Nothing was sent/);
    expect(fake.pushes).toHaveLength(0);
  });

  it("an explorer that lists a different value than the transaction it spends is refused — legacy sighash does not commit to the amount", async () => {
    const fake = newFake();
    const addr = fundAt(fake, a, 0, 0, 100_000_000);
    // The UTXO list now claims half the real value; spending on that claim
    // would hand the other half to the miner.
    fake.utxos.get(addrKey(addr))![0].value = 50_000_000;
    const err = await rejects(btcAdapter.sendFromAccount!(M, TO, "0.1", a.recv0, { feeRate: 5 }));
    expect(String(err.message)).toMatch(/explorer listed 50000000 sat/);
    expect(fake.pushes).toHaveLength(0);
  });
});

describe("a broadcast whose reply is lost is still 'may have been sent' for the new account types", () => {
  for (const a of ACCOUNTS) {
    it(`${a.name}: one signed transaction, UNKNOWN with its txid`, async () => {
      const fake = newFake();
      fundAt(fake, a, 0, 0, 100_000_000);
      fake.onPush = (via) => (via === "esplora:blockstream.info" ? "drop" : { status: 429, body: "Too Many Requests" });
      const err = await rejects(btcAdapter.sendFromAccount!(M, TO, "0.5", a.recv0, { feeRate: 5 }));
      expect(isSendOutcomeUnknown(err), String(err?.message ?? err)).toBe(true);
      const pushed = onlyPush(fake);
      expect(err.hash).toBe(bitcoin.Transaction.fromHex(pushed).getId());
    });
  }
});

// ── The single-key fallback ─────────────────────────────────────────────────

for (const a of ACCOUNTS) {
  describe(`${a.name}: the single-key send spends the key's coins as what they are (2026-09-29 send-safety audit)`, () => {
    it("finds the coins at the key's own encoding, signs that type, returns change there", async () => {
      const fake = newFake();
      fundAt(fake, a, 0, 0, 100_000_000);

      // The old path re-encoded this key as P2WPKH: "No UTXOs available".
      const r = await btcAdapter.sendTransaction(privAt(at(a, 0, 0)), TO, "0.5", undefined, { feeRate: 3 });

      const v = verifyInputs(onlyPush(fake), fake.prevOut);
      expect(v.problems).toEqual([]);
      expect(r.hash).toBe(v.txid);
      expect(v.kinds).toEqual([a.kind]);
      expect(addressOf(v.outputs[1].script)).toBe(a.recv0);
      // Native SegWit is asked first — the one encoding a key import displays.
      const utxoAsks = fake.requests.filter((q) => /\/address\/[^/]+\/utxo$/.test(q));
      expect(utxoAsks[0]).toContain(addressOf(p2wpkhOut(pubAt(at(a, 0, 0)))));
      expect(v.fee).toBe(3 * (a.overheadVB + a.inputVB + 31 + a.changeVB));
    });
  });
}

describe("the single-key send is unchanged for a native SegWit key (regression)", () => {
  it("spends P2WPKH coins with one UTXO lookup", async () => {
    const fake = newFake();
    const pub = pubAt("m/84'/0'/0'/0/0");
    fake.fund(BIP84_RECV0, p2wpkhOut(pub), 100_000_000);
    await btcAdapter.sendTransaction(privAt("m/84'/0'/0'/0/0"), TO, "0.5", undefined, { feeRate: 3 });
    const v = verifyInputs(onlyPush(fake), fake.prevOut);
    expect(v.problems).toEqual([]);
    expect(v.kinds).toEqual(["p2wpkh"]);
    expect(fake.requests.filter((q) => /\/address\/[^/]+\/utxo$/.test(q))).toHaveLength(1);
  });

  it("a key with coins at none of its encodings is refused, naming all three", async () => {
    const fake = newFake();
    const err = await rejects(btcAdapter.sendTransaction(privAt("m/49'/0'/0'/0/0"), TO, "0.5"));
    expect(String(err.message)).toMatch(/No UTXOs available/);
    expect(String(err.message)).toContain(BIP49_RECV0);
    expect(fake.pushes).toHaveLength(0);
  });
});
