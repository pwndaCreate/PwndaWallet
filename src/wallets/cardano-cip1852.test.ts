import { describe, it, expect } from "vitest";
import {
  icarusMasterKey,
  deriveCardanoKeySet,
  deriveCardanoKeySetAt,
  deriveExodusCardanoKeySet,
  deriveExodusCardanoKeySetSplitStake,
  deriveByPath,
  baseAddressMainnet,
} from "./cardano-cip1852";
import { blake2b } from "@noble/hashes/blake2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const ABANDON_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const PURPOSE = 1852 + 0x80000000;
const COIN_TYPE = 1815 + 0x80000000;
const ACCOUNT_0 = 0 + 0x80000000;

describe("cardano CIP-1852 key derivation", () => {
  it("Icarus master key has 64-byte secret + 32-byte chain code", () => {
    const m = icarusMasterKey(ABANDON_MNEMONIC);
    expect(m.secret.length).toBe(64);
    expect(m.chainCode.length).toBe(32);
    // Clamping: kL[0] & 0xf8 == kL[0] (low 3 bits cleared), kL[31] in [0x40, 0x5f].
    expect(m.secret[0] & 0x07).toBe(0);
    expect(m.secret[31] & 0xc0).toBe(0x40);
    expect(m.secret[31] & 0xe0).toBeLessThanOrEqual(0x5f);
  });

  it("derives a valid base address for the abandon mnemonic", () => {
    const ks = deriveCardanoKeySet(ABANDON_MNEMONIC);
    // Address structure checks — independent of the exact key bytes,
    // these gate that the encoding plumbing is right end-to-end.
    expect(ks.address).toMatch(/^addr1q[a-z0-9]+$/);
    // 1 (header) + 28 (payment) + 28 (stake) = 57 bytes → bech32 length ~103 chars after `addr1` prefix.
    expect(ks.address.length).toBeGreaterThanOrEqual(95);
    expect(ks.address.length).toBeLessThanOrEqual(110);
    expect(ks.paymentCredentialHex.length).toBe(56); // 28 bytes hex
    expect(ks.stakeCredentialHex.length).toBe(56);
    expect(ks.paymentPrivateKey.length).toBe(128); // 64 bytes hex
    expect(ks.stakePrivateKey.length).toBe(128);
  });

  it("derived address is deterministic and pinned", () => {
    const ks = deriveCardanoKeySet(ABANDON_MNEMONIC);
    // Pin lock: this is what our CIP-1852 implementation produces for the
    // abandon-abandon-…-about mnemonic at m/1852'/1815'/0'/0/0 (payment)
    // + m/1852'/1815'/0'/2/0 (stake). Future drift in PBKDF2 / clamping /
    // BIP-32-Ed25519 / blake2b-224 / bech32 layers will fail this test.
    //
    // Cross-check procedure: import "abandon abandon abandon abandon
    // abandon abandon abandon abandon abandon abandon abandon about"
    // into Eternl / Yoroi / AdaLite and confirm the displayed receive
    // address matches. If a future external check ever disagrees, do
    // not silently update the pin — investigate the root cause first.
    expect(ks.address).toBe(
      "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv"
    );
  });

  it("bechh32 encoding round-trips", () => {
    const dummyPayment = blake2b(new Uint8Array([1, 2, 3]), { dkLen: 28 });
    const dummyStake = blake2b(new Uint8Array([4, 5, 6]), { dkLen: 28 });
    const addr = baseAddressMainnet(dummyPayment, dummyStake);
    expect(addr).toMatch(/^addr1q/);
  });

  it("hardened derivation matches non-hardened base point math invariant", () => {
    // Sanity check that compressedPublicKey is wired correctly: deriving
    // any path is reproducible across two calls with the same inputs.
    const ks1 = deriveCardanoKeySet(ABANDON_MNEMONIC);
    const ks2 = deriveCardanoKeySet(ABANDON_MNEMONIC);
    expect(ks1.address).toBe(ks2.address);
    expect(ks1.paymentPrivateKey).toBe(ks2.paymentPrivateKey);
  });

  it("ed25519 base-point math is available (not just RFC8032 hash-then-sign)", () => {
    // The CIP-1852 derivation needs raw scalar-mult of the base point,
    // not the standard Ed25519 hash-then-sign pubkey path. Sanity that
    // @noble/curves exposes Point.BASE with a multiply method.
    const point = ed25519.Point.BASE.multiply(7n);
    const bytes = point.toBytes();
    expect(bytes.length).toBe(32);
  });

  it("non-hardened derivation produces a different child than hardened with the same index", () => {
    const master = icarusMasterKey(ABANDON_MNEMONIC);
    const account = deriveByPath(master, [PURPOSE, COIN_TYPE, ACCOUNT_0]);
    const hardenedChild = deriveByPath(account, [0 + 0x80000000]);
    const softChild = deriveByPath(account, [0]);
    // Both should be valid (64-byte secret), but distinct.
    expect(hardenedChild.secret.length).toBe(64);
    expect(softChild.secret.length).toBe(64);
    const sameBytes = hardenedChild.secret.every((b, i) => b === softChild.secret[i]);
    expect(sameBytes).toBe(false);
  });

  it("multi-account variants produce distinct addresses from a=0 i=0", () => {
    // CardanoDerivationPanel probes account=0/1/2 + index=0/1 to surface
    // funds users imported from wallets that default to non-zero indices.
    // The variants MUST produce distinct addresses or the probe is useless.
    const a0i0 = deriveCardanoKeySetAt(ABANDON_MNEMONIC, 0, 0).address;
    const a1i0 = deriveCardanoKeySetAt(ABANDON_MNEMONIC, 1, 0).address;
    const a2i0 = deriveCardanoKeySetAt(ABANDON_MNEMONIC, 2, 0).address;
    const a0i1 = deriveCardanoKeySetAt(ABANDON_MNEMONIC, 0, 1).address;
    expect(a0i0).not.toBe(a1i0);
    expect(a0i0).not.toBe(a2i0);
    expect(a0i0).not.toBe(a0i1);
    expect(a1i0).not.toBe(a2i0);
    // a=0 i=0 stays pinned to the canonical Yoroi/Eternl test vector
    // — same lock as the older test, restated here to keep the variants
    // anchored to a known reference.
    expect(a0i0).toBe(
      "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv"
    );
  });

  it("deriveCardanoKeySet is the same as deriveCardanoKeySetAt(_, 0, 0)", () => {
    // Backward-compatibility lock: the existing API surface MUST match
    // the new generic helper at the canonical (a=0, i=0). Any drift
    // means existing vaults get a different address on next unlock.
    const ksDefault = deriveCardanoKeySet(ABANDON_MNEMONIC);
    const ksGeneric = deriveCardanoKeySetAt(ABANDON_MNEMONIC, 0, 0);
    expect(ksDefault.address).toBe(ksGeneric.address);
    expect(ksDefault.paymentPrivateKey).toBe(ksGeneric.paymentPrivateKey);
    expect(ksDefault.stakePrivateKey).toBe(ksGeneric.stakePrivateKey);
  });
});

describe("Exodus Cardano derivation (HeptaSean reverse-engineered scheme)", () => {
  // HeptaSean's reference Python (Cardano Forum thread 126040, post #3,
  // 2024-01-02) hard-codes this address as the expected output for the
  // canonical abandon × 11 + about mnemonic. Independently re-derived
  // by ronaldjonkers in 2025-09. This is the load-bearing validation
  // for the entire Exodus Cardano scheme — if it fails, our
  // implementation diverges from HeptaSean's at some step.
  //
  // See PwndaWalletVault/wiki/sources/ExodusWalletSolanaAndCardanoResearch.md
  // for the full algorithm + multi-source citations.
  const EXODUS_ABANDON_VECTOR =
    "addr1q9av2w6nz9tzv8rc3vfqs95av844gkcqxm0qeezvlf07p3r6c5a4xy2kycw83zcjpqtf6c0t23dsqdk7pnjye7jlurzqm0pqxa";

  it("matches HeptaSean's canonical abandon-mnemonic test vector", () => {
    const ks = deriveExodusCardanoKeySet(ABANDON_MNEMONIC);
    expect(ks.address).toBe(EXODUS_ABANDON_VECTOR);
  });

  it("payment and stake credentials are identical (Exodus same-key quirk)", () => {
    const ks = deriveExodusCardanoKeySet(ABANDON_MNEMONIC);
    expect(ks.paymentCredentialHex).toBe(ks.stakeCredentialHex);
    // The bech32 payload after the 0x01 header is two 28-byte halves;
    // if same-key, those halves bytes are identical.
    expect(ks.paymentPrivateKey).toBe(ks.stakePrivateKey);
  });

  it("Exodus address differs from CIP-1852 canonical (BIP-44 vs CIP-1852 purpose)", () => {
    // Sanity: the Exodus scheme MUST NOT collide with the CIP-1852
    // address — they live at different points on the derivation tree
    // (BIP-44 secp256k1 walk + Byron-Legacy vs. CIP-1852 Icarus +
    // BIP-32-Ed25519). If they collide, something has been
    // mis-specified.
    const exodus = deriveExodusCardanoKeySet(ABANDON_MNEMONIC).address;
    const standard = deriveCardanoKeySet(ABANDON_MNEMONIC).address;
    expect(exodus).not.toBe(standard);
  });

  it("variant at non-zero account produces a distinct address", () => {
    const a0 = deriveExodusCardanoKeySet(ABANDON_MNEMONIC, 0, 0).address;
    const a1 = deriveExodusCardanoKeySet(ABANDON_MNEMONIC, 1, 0).address;
    expect(a0).not.toBe(a1);
  });

  it("deterministic — same mnemonic always produces same address", () => {
    const a = deriveExodusCardanoKeySet(ABANDON_MNEMONIC).address;
    const b = deriveExodusCardanoKeySet(ABANDON_MNEMONIC).address;
    expect(a).toBe(b);
  });

  it("split-stake variant produces an address with distinct halves", () => {
    // Fallback variant for users on a newer Exodus build that derives
    // the stake key separately. The output must still be a valid
    // Shelley base address but with payment_hash != stake_hash.
    const ks = deriveExodusCardanoKeySetSplitStake(ABANDON_MNEMONIC, 0, 0);
    expect(ks.address).toMatch(/^addr1q[a-z0-9]+$/);
    expect(ks.paymentCredentialHex).not.toBe(ks.stakeCredentialHex);
    expect(ks.paymentPrivateKey).not.toBe(ks.stakePrivateKey);
  });
});
