import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  paymentExtendedKey,
  paymentPublicKey,
  signBip32Ed25519,
} from "./cardano-cip1852";
import {
  decodeAddressBytes,
  selectUtxosForAmount,
} from "./cardano-tx";

const ABANDON_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("cardano BIP-32-Ed25519 signing", () => {
  it("produces a 64-byte signature that verifies against the derived pubkey", () => {
    const ext = paymentExtendedKey(ABANDON_MNEMONIC);
    const message = new TextEncoder().encode("test message for cardano signing");
    const sig = signBip32Ed25519(message, ext);
    expect(sig.length).toBe(64);
    const pubkey = paymentPublicKey(ABANDON_MNEMONIC);
    expect(pubkey.length).toBe(32);
    // Standard Ed25519 verification works because BIP-32-Ed25519
    // produces an RFC-8032-compatible (R, s) signature when the public
    // key is computed via raw scalar-mult of the base point. If our
    // signing is correct, `ed25519.verify` accepts.
    const ok = ed25519.verify(sig, message, pubkey);
    expect(ok).toBe(true);
  });

  it("signing is deterministic — same inputs produce the same signature", () => {
    const ext = paymentExtendedKey(ABANDON_MNEMONIC);
    const m = new TextEncoder().encode("deterministic test");
    const a = signBip32Ed25519(m, ext);
    const b = signBip32Ed25519(m, ext);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("signature changes with the message", () => {
    const ext = paymentExtendedKey(ABANDON_MNEMONIC);
    const a = signBip32Ed25519(new TextEncoder().encode("a"), ext);
    const b = signBip32Ed25519(new TextEncoder().encode("b"), ext);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe("cardano-tx UTXO selection", () => {
  const oneAda = 1_000_000n;

  it("returns an empty selection when no UTXOs are available", () => {
    const r = selectUtxosForAmount([], oneAda, 200_000n);
    expect(r.selected).toEqual([]);
    expect(r.totalInLovelace).toBe(0n);
  });

  it("picks a single largest UTXO when one covers the amount", () => {
    const utxos = [
      { tx_hash: "aa", tx_index: 0, value: "1000000" },
      { tx_hash: "bb", tx_index: 1, value: "10000000" },
      { tx_hash: "cc", tx_index: 2, value: "5000000" },
    ];
    const r = selectUtxosForAmount(utxos, 3_000_000n, 200_000n);
    expect(r.selected).toHaveLength(1);
    expect(r.selected[0].tx_hash).toBe("bb"); // largest first
  });

  it("accumulates multiple UTXOs when one isn't enough", () => {
    const utxos = [
      { tx_hash: "aa", tx_index: 0, value: "2000000" },
      { tx_hash: "bb", tx_index: 1, value: "2000000" },
      { tx_hash: "cc", tx_index: 2, value: "2000000" },
    ];
    const r = selectUtxosForAmount(utxos, 5_000_000n, 200_000n);
    expect(r.selected.length).toBeGreaterThanOrEqual(2);
    expect(r.totalInLovelace).toBeGreaterThanOrEqual(5_000_000n);
  });

  it("skips UTXOs that carry native assets", () => {
    const utxos = [
      {
        tx_hash: "aa",
        tx_index: 0,
        value: "10000000",
        asset_list: [
          { policy_id: "abc", asset_name: "MYTOKEN", quantity: "1" },
        ],
      },
      { tx_hash: "bb", tx_index: 1, value: "5000000" },
    ];
    const r = selectUtxosForAmount(utxos, 3_000_000n, 200_000n);
    // The asset-bearing UTXO should be skipped; only the bb one is used.
    expect(r.selected.map((u) => u.tx_hash)).toEqual(["bb"]);
  });
});

describe("cardano-tx address decoding", () => {
  it("decodes a base address bech32 to the expected length (57 bytes)", () => {
    const addr =
      "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv";
    const bytes = decodeAddressBytes(addr);
    expect(bytes.length).toBe(57); // 1 header + 28 payment + 28 stake
    expect(bytes[0]).toBe(0x01); // base, mainnet
  });

  it("decodes an enterprise address (legacy) to 29 bytes", () => {
    // A type-0x61 enterprise address has 1 header + 28 hash bytes.
    // We don't pin a specific value; just the length + header semantics.
    // The legacy ADA derivation produces this format from any seed; we
    // just verify the decoder handles it.
    const addr = "addr1vx7h9aldjn4dp5pc6csgzrhrfdxrccgnj0hxa6kmrkq26jg4wrpla";
    const bytes = decodeAddressBytes(addr);
    expect(bytes.length).toBe(29);
    expect(bytes[0]).toBe(0x61);
  });
});
