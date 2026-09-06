/**
 * End-to-end brute-force find tests. The probe must:
 *   1. Find the canonical abandon-mnemonic test vectors at their known
 *      derivations (positive cases).
 *   2. Find addresses derived at non-default account/index combinations
 *      (the actual UX problem we're solving).
 *   3. Return null when the address doesn't belong to this seed
 *      (avoid false positives that would mislead the user).
 *   4. Stay bounded in cost (see PROBE_BUDGET_MS below).
 */

import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";

// A WALL-CLOCK BUDGET MEASURES THE MACHINE AS WELL AS THE CODE, so it is stated once, generously,
// and is overridable.
//
// These two assertions exist to catch an ALGORITHMIC regression - a second full pass, an accidental
// O(n^2), a per-candidate seed re-derivation - in a probe that walks 67 candidates. A real
// regression of that kind costs SECONDS. The original budget was 500ms, which is roughly what the
// probe takes on the machine it was written on, so it had almost no headroom: a desk-side Linux box
// ran it in 574ms and failed, having found nothing wrong. A perf test that fails on a slower host
// gets dismissed as environmental, and a test everyone dismisses is not protecting anything.
//
// 2500ms still fails loudly on any regression worth catching while surviving a loaded or slower
// machine. PWNDA_PROBE_BUDGET_MS overrides it - raise it on a slow CI runner rather than deleting
// the assertion.
const PROBE_BUDGET_MS = Number(process.env.PWNDA_PROBE_BUDGET_MS ?? 2500);
import {
  bruteForceFindCardano,
  bruteForceFindSolana,
} from "./derivation-detector";
import {
  deriveCardanoKeySetAt,
  deriveExodusCardanoKeySet,
  deriveExodusCardanoKeySetSplitStake,
} from "../../wallets/cardano-cip1852";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { sha512 } from "@noble/hashes/sha2.js";
import { Keypair } from "@solana/web3.js";
import { derivePath as solDerivePath } from "ed25519-hd-key";
import { Buffer } from "buffer";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * Upper bound for a full-candidate probe, in milliseconds.
 *
 * This is a runaway-cost guard, NOT a benchmark. Each candidate runs real key
 * derivation (PBKDF2 4096-iter SHA-512 per seed, plus ed25519/secp256k1 walks),
 * so the wall-clock is dominated by host CPU and by whatever else is running —
 * it is not a property of our code alone.
 *
 * These assertions were pinned at 500ms until 2026-08-12, chosen on the
 * original Windows dev box. On other hardware the same unchanged code measures
 * 700-1200ms, so the suite failed for reasons that had nothing to do with a
 * regression. The budget is now set with enough headroom that only a real
 * blow-up (a candidate set that grew several-fold, or an accidental O(n²))
 * trips it, while remaining tight enough that such a blow-up can't hide.
 *
 * If you need a true performance signal, measure it on fixed hardware and
 * track it over time — a unit-test assertion is the wrong instrument.
 */
// (The budget itself is declared once, above, as an env-overridable constant —
// both branches added one of these independently and the merge kept both.)

// Pinned vector for the canonical Yoroi/Eternl/cardano-serialization-lib
// test mnemonic at CIP-1852 a=0 i=0. See `cardano-cip1852.test.ts:55`.
const ABANDON_ADA_CANONICAL =
  "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv";

describe("bruteForceFindCardano", () => {
  it("finds the canonical CIP-1852 a=0 i=0 vector and returns id 'cip1852'", () => {
    const match = bruteForceFindCardano(ABANDON, ABANDON_ADA_CANONICAL);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("cip1852");
    expect(match!.address).toBe(ABANDON_ADA_CANONICAL);
    expect(match!.path).toContain("m/1852'/1815'/0'/0/0");
  });

  it("finds non-default account variants (a=2 i=3 → cip1852-a2-i3)", () => {
    const target = deriveCardanoKeySetAt(ABANDON, 2, 3).address;
    const match = bruteForceFindCardano(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("cip1852-a2-i3");
    expect(match!.address).toBe(target);
    expect(match!.path).toContain("m/1852'/1815'/2'/0/3");
  });

  it("finds the highest index in the probe range (a=5 i=10)", () => {
    const target = deriveCardanoKeySetAt(ABANDON, 5, 10).address;
    const match = bruteForceFindCardano(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("cip1852-a5-i10");
  });

  it("returns null for an address that doesn't belong to this seed", () => {
    // Fabricated bech32 — addr1q + random body. Must NOT match anything.
    const fake =
      "addr1q9random00000000000000000000000000000000000000000000000000000000000000000000000000000000abcdefghij";
    const match = bruteForceFindCardano(ABANDON, fake);
    expect(match).toBeNull();
  });

  it("returns null for an empty / whitespace input", () => {
    expect(bruteForceFindCardano(ABANDON, "")).toBeNull();
    expect(bruteForceFindCardano(ABANDON, "   ")).toBeNull();
  });

  it("normalizes address case (bech32 is case-insensitive within a charset)", () => {
    // bech32 encodings are lowercase in practice. We lowercase both
    // sides before comparing — a user pasting an UPPERCASE address
    // (some wallets display them that way for QR codes) should still
    // match.
    const upper = ABANDON_ADA_CANONICAL.toUpperCase();
    const match = bruteForceFindCardano(ABANDON, upper);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("cip1852");
  });

  it("completes the full 67-candidate probe without exploding in cost", () => {
    const start = performance.now();
    bruteForceFindCardano(ABANDON, "addr1q9definitely_not_a_real_address_at_all_no_seed_can_match");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(PROBE_BUDGET_MS);
  });

  it("finds Exodus same-key canonical address (HeptaSean's reverse-engineered scheme)", () => {
    // Exodus's actual algorithm: secp256k1 BIP-32 walk at
    // m/44'/1815'/0'/0/0 → Byron-Legacy hashRepeatedly → Ed25519 scalar
    // mult → blake2b-224 → Shelley base header 0x01 + same hash twice.
    // HeptaSean's canonical abandon vector — multi-source corroborated.
    const target = deriveExodusCardanoKeySet(ABANDON, 0, 0).address;
    expect(target).toBe(
      "addr1q9av2w6nz9tzv8rc3vfqs95av844gkcqxm0qeezvlf07p3r6c5a4xy2kycw83zcjpqtf6c0t23dsqdk7pnjye7jlurzqm0pqxa"
    );
    const match = bruteForceFindCardano(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("exodus-cardano");
    expect(match!.label).toContain("Exodus");
    expect(target).not.toBe(ABANDON_ADA_CANONICAL); // != CIP-1852 address
  });

  it("finds Exodus same-key variant at non-zero account (a=3 i=2 → 'exodus-cardano-a3-i2')", () => {
    const target = deriveExodusCardanoKeySet(ABANDON, 3, 2).address;
    const match = bruteForceFindCardano(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("exodus-cardano-a3-i2");
    expect(match!.path).toContain("m/44'/1815'/3'/0/2");
  });

  it("finds Exodus split-stake fallback (separate stake key, distinct halves)", () => {
    // Fallback for newer Exodus builds where payment+stake hashes
    // differ in the Shelley address. User's reported addr1q8qf6lk…
    // has distinct halves and is a likely candidate for this branch.
    const target = deriveExodusCardanoKeySetSplitStake(ABANDON, 0, 0).address;
    const match = bruteForceFindCardano(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("exodus-cardano-split");
    expect(match!.label).toContain("split-stake");
  });

  it("finds Exodus split-stake variant at non-zero account (a=2 i=4)", () => {
    const target = deriveExodusCardanoKeySetSplitStake(ABANDON, 2, 4).address;
    const match = bruteForceFindCardano(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("exodus-cardano-split-a2-i4");
  });

  it("Exodus probe stays bounded with both same-key + split-stake variants", () => {
    const start = performance.now();
    bruteForceFindCardano(ABANDON, "addr1q9definitely_not_a_real_address_at_all_no_seed_can_match");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(PROBE_BUDGET_MS);
  });
});

describe("bruteForceFindSolana", () => {
  function deriveSolAt(path: string): string {
    const seed = mnemonicToSeedSync(ABANDON);
    const derived = solDerivePath(path, Buffer.from(seed).toString("hex"));
    return Keypair.fromSeed(Uint8Array.from(derived.key)).publicKey.toBase58();
  }

  it("finds the Phantom standard path (m/44'/501'/0'/0' → id 'phantom')", () => {
    const target = deriveSolAt("m/44'/501'/0'/0'");
    const match = bruteForceFindSolana(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("phantom");
    expect(match!.path).toBe("m/44'/501'/0'/0'");
  });

  it("finds non-default Phantom variants (a=2 i=4 → phantom-a2-i4)", () => {
    const target = deriveSolAt("m/44'/501'/2'/4'");
    const match = bruteForceFindSolana(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("phantom-a2-i4");
  });

  it("finds CLI 3-step variant (m/44'/501'/0' → id 'cli')", () => {
    const target = deriveSolAt("m/44'/501'/0'");
    const match = bruteForceFindSolana(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("cli");
  });

  it("finds CLI account variant (m/44'/501'/3' → cli-a3)", () => {
    const target = deriveSolAt("m/44'/501'/3'");
    const match = bruteForceFindSolana(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("cli-a3");
  });

  it("finds the Sollet raw-seed variant", () => {
    const seed = mnemonicToSeedSync(ABANDON);
    const target = Keypair.fromSeed(seed.slice(0, 32)).publicKey.toBase58();
    const match = bruteForceFindSolana(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("sollet");
  });

  it("returns null for an address that doesn't belong to this seed", () => {
    // Random valid-looking base58 that doesn't match anything we derive.
    // SkhQFnLVc5gy7Rz1F2Ph2JwjjiM6qBHUmsM163KSUMj is the user's reported
    // Exodus address — unrelated to the abandon mnemonic, so must be null.
    const match = bruteForceFindSolana(
      ABANDON,
      "SkhQFnLVc5gy7Rz1F2Ph2JwjjiM6qBHUmsM163KSUMj"
    );
    expect(match).toBeNull();
  });

  it("finds Exodus secp256k1→ed25519 default path (id 'exodus')", () => {
    // Exodus's documented Solana path is `m/44'/501'/0'/0/0` with last
    // two steps unhardened. The most likely actual implementation
    // (per HeptaSean's house-style analysis of their Cardano scheme):
    // walk the path on secp256k1 BIP-32 (which supports non-hardened),
    // take the resulting 32-byte private key, use it directly as the
    // ed25519 seed via Keypair.fromSeed.
    const seed = mnemonicToSeedSync(ABANDON);
    const node = HDKey.fromMasterSeed(seed).derive("m/44'/501'/0'/0/0");
    const target = Keypair.fromSeed(node.privateKey!).publicKey.toBase58();
    const match = bruteForceFindSolana(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("exodus");
    expect(match!.label).toContain("Exodus");
    expect(match!.path).toBe("m/44'/501'/0'/0/0");
  });

  it("finds Exodus variant at non-zero account/index (a=2 i=4 → 'exodus-a2-i4')", () => {
    const seed = mnemonicToSeedSync(ABANDON);
    const node = HDKey.fromMasterSeed(seed).derive("m/44'/501'/2'/0/4");
    const target = Keypair.fromSeed(node.privateKey!).publicKey.toBase58();
    const match = bruteForceFindSolana(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("exodus-a2-i4");
    expect(match!.path).toBe("m/44'/501'/2'/0/4");
  });

  it("finds Exodus SHA-512-fold variant fallback (id 'exodus-folded')", () => {
    // Variant 1a from the research — same secp256k1 walk + one SHA-512
    // fold of the resulting priv before using as the ed25519 seed.
    const seed = mnemonicToSeedSync(ABANDON);
    const node = HDKey.fromMasterSeed(seed).derive("m/44'/501'/0'/0/0");
    const folded = sha512(node.privateKey!).slice(0, 32);
    const target = Keypair.fromSeed(folded).publicKey.toBase58();
    const match = bruteForceFindSolana(ABANDON, target);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("exodus-folded");
  });

  it("completes the full 49-candidate probe without exploding in cost", () => {
    const start = performance.now();
    bruteForceFindSolana(ABANDON, "thisIsNotARealAddressAtAllAndShouldNotMatch11111");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(PROBE_BUDGET_MS);
  });
});
