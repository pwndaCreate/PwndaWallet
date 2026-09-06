/**
 * `sendBchFromAccount` — verifying the per-input scriptCode fix
 * cryptographically, not just by observing that it ran.
 *
 * ## Why a click-through in the sandbox isn't enough
 *
 * BCH bypasses PSBT entirely and hand-rolls a BIP-143-with-FORKID preimage
 * (`buildSighashPreimage` in `bch-wallet.ts`). The single-key `sendTransaction`
 * passes ONE `senderScript` as the scriptCode for every input — correct only
 * because every input shares an address. The account-wide fix passes each
 * input's OWN address's script.
 *
 * Get that per-input wiring wrong (e.g. always use the first input's script)
 * and the bug is invisible to a naive check: the code still signs with the
 * RIGHT private key per input (that lookup was never broken), so the
 * embedded pubkey in each scriptSig is always correct, the DER signature
 * decodes fine, and nothing throws. The transaction builds, "succeeds" in a
 * sandbox where broadcast is mocked, and only fails for a REAL user, at RELAY
 * time, with a generic script error — because the signature was computed
 * against the wrong preimage and does not verify.
 *
 * So this test recomputes each input's sighash INDEPENDENTLY (reimplementing
 * BIP-143-with-FORKID here rather than importing `buildSighashPreimage` from
 * the module under test — importing it would let a bug in that function hide
 * from a test that reuses the same buggy function to build its own
 * expectation) and verifies the embedded signature against it. A negative
 * control swaps in the OTHER input's scriptCode and asserts that does NOT
 * verify — proving the check can fail, not just that it can pass.
 */
import { describe, it, expect, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as tinysecp from "tiny-secp256k1";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

vi.mock("./_proxy", () => ({
  proxyGetJson: vi.fn(),
  proxyPostJson: vi.fn(),
  httpProxyCall: vi.fn(),
}));

import { proxyGetJson, httpProxyCall } from "./_proxy";
import { sendBchFromAccount, bchUtxoAccounts } from "./bch-wallet";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BLOCKCHAIR_BASE = "https://api.blockchair.com/bitcoin-cash";

// ---------------------------------------------------------------------------
// An INDEPENDENT reimplementation of BIP-143-with-FORKID, for verification
// only. Deliberately duplicated rather than imported — see the file doc.
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}
function dsha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}
function u32LE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function u64LE(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
function varInt(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  const b = new Uint8Array(3);
  b[0] = 0xfd;
  new DataView(b.buffer).setUint16(1, n, true);
  return b;
}
function reverseBytes(b: Uint8Array): Uint8Array {
  return Uint8Array.from(b).reverse();
}
function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function scriptP2PKH(hash: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac));
}
const BCH_SIGHASH = 0x41;

type IndependentInput = { txid: string; vout: number; value: bigint };
type IndependentOutput = { value: bigint; scriptPubKey: Uint8Array };

function independentSighash(
  inputs: IndependentInput[],
  outputs: IndependentOutput[],
  inputIndex: number,
  scriptCode: Uint8Array,
): Uint8Array {
  const hashPrevouts = dsha256(
    concatBytes(...inputs.map((i) => concatBytes(reverseBytes(hexToBytes(i.txid)), u32LE(i.vout)))),
  );
  const hashSequence = dsha256(concatBytes(...inputs.map(() => u32LE(0xffffffff))));
  const hashOutputs = dsha256(
    concatBytes(
      ...outputs.map((o) => concatBytes(u64LE(o.value), varInt(o.scriptPubKey.length), o.scriptPubKey)),
    ),
  );
  const input = inputs[inputIndex];
  return dsha256(
    concatBytes(
      u32LE(2), // version
      hashPrevouts,
      hashSequence,
      reverseBytes(hexToBytes(input.txid)),
      u32LE(input.vout),
      varInt(scriptCode.length),
      scriptCode,
      u64LE(input.value),
      u32LE(0xffffffff), // sequence
      hashOutputs,
      u32LE(0), // locktime
      u32LE(BCH_SIGHASH),
    ),
  );
}

describe("sendBchFromAccount — cross-address input signing", () => {
  it("signs each input against ITS OWN scriptCode, not a shared one", async () => {
    // Two funded addresses on the account, sized so a send must draw from
    // BOTH — the scenario where a shared/mixed-up scriptCode is possible.
    // Real derived addresses (m/44'/145'/0'/0/0 and /0/1) of the sandbox's
    // own standard test seed.
    const ADDR_A = "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6"; // 0/0
    const ADDR_B = "bitcoincash:qp8sfdhgjlq68hlzka9lcsxtcnvuvnd0xqxugfzzc5"; // 0/1
    const UTXO_A_TXID = "aa".repeat(32);
    const UTXO_B_TXID = "bb".repeat(32);
    const VALUE_A = 3_000_000;
    const VALUE_B = 7_000_000;

    function bareOf(addr: string) {
      return addr.includes(":") ? addr.split(":")[1] : addr;
    }

    (proxyGetJson as any).mockImplementation(async (url: string) => {
      if (url.includes("/stats")) return { data: { suggested_transaction_fee_per_byte_sat: 1 } };
      const m = /\/dashboards\/address\/([^/?]+)/.exec(url);
      if (m) {
        const addr = decodeURIComponent(m[1]);
        const bare = bareOf(addr);
        const known: Record<string, { value: number; txid: string }> = {
          [bareOf(ADDR_A)]: { value: VALUE_A, txid: UTXO_A_TXID },
          [bareOf(ADDR_B)]: { value: VALUE_B, txid: UTXO_B_TXID },
        };
        const hit = known[bare];
        const entry = hit
          ? { address: { balance: hit.value, transaction_count: 1 }, utxo: [{ transaction_hash: hit.txid, index: 0, value: hit.value }] }
          : { address: { balance: 0, transaction_count: 0 }, utxo: [] };
        return { data: { [addr]: entry, [bare]: entry } };
      }
      throw new Error("unmocked GET " + url);
    });

    let broadcastHex: string | null = null;
    (httpProxyCall as any).mockImplementation(async (opts: { url: string; body?: string }) => {
      if (opts.url.includes("/push/transaction")) {
        const m = /data=([0-9a-fA-F]+)/.exec(opts.body ?? "");
        broadcastHex = decodeURIComponent(m![1]);
        return { status: 200, body: JSON.stringify({ data: { transaction_hash: "ff".repeat(32) } }), headers: [] };
      }
      throw new Error("unmocked POST " + opts.url);
    });

    // 9M sats: B (7M) alone can't cover it, so both A and B must be spent.
    const sendSat = 9_000_000;
    const result = await sendBchFromAccount(MNEMONIC, ADDR_A, (sendSat / 1e8).toFixed(8), {
      gapLimit: 2,
    });
    expect(result.hash).toBeTruthy();
    expect(broadcastHex, "the send never reached broadcast").toBeTruthy();

    // BCH kept Bitcoin's pre-segwit wire format, so bitcoinjs-lib parses it
    // directly — no need to reimplement `serializeSignedTx`'s inverse.
    const tx = bitcoin.Transaction.fromHex(broadcastHex!);
    expect(tx.ins, "both funded addresses' UTXOs should have been needed").toHaveLength(2);

    // Derive the two signing keys independently of the adapter.
    const seed = mnemonicToSeedSync(MNEMONIC, "");
    const account = HDKey.fromMasterSeed(seed).derive(bchUtxoAccounts[0].accountPath);
    const pubA = tinysecp.pointFromScalar(account.deriveChild(0).deriveChild(0).privateKey!, true)!;
    const pubB = tinysecp.pointFromScalar(account.deriveChild(0).deriveChild(1).privateKey!, true)!;
    const scriptA = scriptP2PKH(ripemd160(sha256(pubA)));
    const scriptB = scriptP2PKH(ripemd160(sha256(pubB)));

    const byTxid = new Map([
      [UTXO_A_TXID, { script: scriptA, value: BigInt(VALUE_A), pub: pubA }],
      [UTXO_B_TXID, { script: scriptB, value: BigInt(VALUE_B), pub: pubB }],
    ]);

    const inputs: IndependentInput[] = tx.ins.map((inp) => {
      const txid = Buffer.from(reverseBytes(inp.hash)).toString("hex");
      const meta = byTxid.get(txid);
      expect(meta, `broadcast input ${txid} is not one of the two known UTXOs`).toBeTruthy();
      return { txid, vout: inp.index, value: meta!.value };
    });
    const outputs: IndependentOutput[] = tx.outs.map((o) => ({
      value: o.value,
      scriptPubKey: Uint8Array.from(o.script),
    }));

    for (let i = 0; i < tx.ins.length; i++) {
      const meta = byTxid.get(inputs[i].txid)!;
      const chunks = bitcoin.script.decompile(Buffer.from(tx.ins[i].script)) as Buffer[];
      expect(chunks, `input ${i} scriptSig must decompile to exactly [sig, pubkey]`).toHaveLength(2);
      const [sigWithHashType, pubkeyInScript] = chunks;

      // The embedded pubkey is always THIS input's own key by construction
      // (that lookup was never the bug) — asserted anyway as a sanity check
      // before the real assertion below.
      expect(Buffer.from(pubkeyInScript).toString("hex")).toBe(Buffer.from(meta.pub).toString("hex"));

      const sigDer = sigWithHashType.subarray(0, sigWithHashType.length - 1); // strip the trailing sighash byte
      const rightDigest = independentSighash(inputs, outputs, i, meta.script);
      const validAgainstOwnScript = secp256k1.verify(sigDer, rightDigest, meta.pub, {
        format: "der",
        lowS: true,
        prehash: false,
      });
      expect(
        validAgainstOwnScript,
        `input ${i}'s signature must verify against its OWN scriptCode — a mixed-up ` +
          "scriptCode would sign correctly with the right key but produce a " +
          "signature that fails exactly this check, and fails at relay time in " +
          "production, which is why this must be checked cryptographically and " +
          "not just by observing the send completed",
      ).toBe(true);

      // Negative control: the OTHER input's scriptCode must NOT verify here.
      // Without this, a verifier that always returns true (or a preimage
      // builder with the same bug on both sides) would pass vacuously.
      const otherTxid = i === 0 ? inputs[1].txid : inputs[0].txid;
      const otherScript = byTxid.get(otherTxid)!.script;
      const wrongDigest = independentSighash(inputs, outputs, i, otherScript);
      const validAgainstOtherScript = secp256k1.verify(sigDer, wrongDigest, meta.pub, {
        format: "der",
        lowS: true,
        prehash: false,
      });
      expect(
        validAgainstOtherScript,
        `input ${i}'s signature must NOT verify against the OTHER input's ` +
          "scriptCode — this is what per-input scriptCode actually protects " +
          "against, and this assertion is what proves the positive check above " +
          "can fail",
      ).toBe(false);
    }
  });
});
