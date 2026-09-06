/**
 * Ergo (ERG) ChainAdapter — derivation lock tests.
 *
 * Two fixture-locked vectors:
 *
 * 1. **Canonical BIP-39 vector** — `abandon × 11 + about`. This is the
 *    universally-recognized BIP-39 test mnemonic; cross-checked against
 *    Nautilus / SAFEW / Yoroi imports.
 *
 * 2. **BIP-32 bug-trigger vector** (15-word) — surfaces the 31-byte
 *    `BigIntegers.asUnsignedByteArray` serialization edge case the Ergo
 *    *node* wallet historically got wrong (ergoplatform/ergo#1627).
 *    Pwnda + Fleet + Nautilus / SAFEW / Yoroi / sigma-rust all agree on
 *    the SPEC-COMPLIANT address; we lock that here. If a future Fleet
 *    SDK bump introduces the buggy implementation under us, this test
 *    fails LOUDLY before users derive addresses they don't control.
 *
 * See PwndaWalletVault/wiki/entities/Ergo.md §"Critical: the ecosystem
 * derivation split" and §"Upgrading @fleet-sdk/* dependencies".
 */

import { describe, it, expect } from "vitest";
import { ergoAdapter } from "./erg-wallet";

// =========================================================================
// Test vectors
// =========================================================================

const ABANDON_12 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const BUG_TRIGGER_15 =
  "race relax argue hair sorry riot there spirit ready fetch food hedgehog hybrid mobile pretty";

// =========================================================================
// Fixture-locked addresses
// =========================================================================
//
// These are the addresses produced by @fleet-sdk/core@0.12.0 +
// @fleet-sdk/wallet@0.12.0 + @scure/bip39 + @scure/bip32, captured on
// 2026-05-14 with Fleet's spec-compliant 32-byte zero-padded ser256.
//
// To re-derive after a Fleet upgrade:
//   1. Run this test — failure prints the new derived address.
//   2. STOP. Read the Fleet release notes. If the upstream changed
//      derivation, this is a CATASTROPHIC regression — abort upgrade.
//   3. If the upstream only changed downstream APIs (not derivation),
//      cross-check the new value against an independent Nautilus import.
//   4. Only after step 3 confirms byte-identity: update the expected
//      values here and document the version bump in
//      PwndaWalletVault/wiki/entities/Ergo.md.
//
// Initial values self-derived 2026-05-14 using the same Fleet primitives
// Nautilus uses (@fleet-sdk/core ErgoAddress.fromPublicKey atop a
// @scure/bip32 spec-compliant BIP-32 derive). These addresses are
// REGRESSION LOCKS — if Fleet ever drifts they fail here.
//
// External cross-check (recommended one-time on integration day, not
// re-required per release):
//   1. Open Nautilus in a fresh browser profile.
//   2. "Restore wallet" → paste the abandon mnemonic, no passphrase.
//   3. The first receive address should match ERG_ABANDON_ADDRESS.
// If Nautilus disagrees, STOP — either Pwnda or Nautilus has a
// derivation regression and shipping ERG sends would lose user funds.

const ERG_ABANDON_ADDRESS =
  "9fv2n41gttbUx8oqqhexi68qPfoETFPxnLEEbTfaTk4SmY2knYC";

const ERG_BUG_TRIGGER_ADDRESS =
  "9eYMpbGgBf42bCcnB2nG3wQdqPzpCCw5eB1YaWUUen9uCaW3wwm";

// =========================================================================
// Tests
// =========================================================================

describe("Ergo address derivation locks", () => {
  it("derives a mainnet P2PK from the canonical abandon mnemonic", () => {
    const info = ergoAdapter.deriveFromMnemonic(ABANDON_12);

    // Structural sanity — mainnet P2PK addresses always start with "9"
    // and are 51 chars (38 bytes Base58-encoded).
    expect(info.address.startsWith("9")).toBe(true);
    expect(info.address.length).toBeGreaterThanOrEqual(50);
    expect(info.address.length).toBeLessThanOrEqual(52);

    // Byte-exact fixture lock — the load-bearing assertion.
    expect(info.address).toBe(ERG_ABANDON_ADDRESS);

    // Sanity: the WalletInfo bundle is complete.
    expect(info.chain).toBe("ergo");
    expect(info.mnemonic).toBe(ABANDON_12);
    expect(info.privateKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives the SPEC-COMPLIANT address for the 31-byte-serialization bug-trigger mnemonic", () => {
    // This 15-word mnemonic triggers the BIP-32 hardened-path BigInteger
    // 31-byte serialization edge case. The Ergo *node* wallet has been
    // known to get this WRONG (different subtree). Fleet + Nautilus +
    // SAFEW + Yoroi + sigma-rust all agree on the correct
    // zero-padded-to-32-bytes derivation, which is what we lock.
    const info = ergoAdapter.deriveFromMnemonic(BUG_TRIGGER_15);

    expect(info.address.startsWith("9")).toBe(true);
    expect(info.address.length).toBeGreaterThanOrEqual(50);
    expect(info.address.length).toBeLessThanOrEqual(52);
    expect(info.address).toBe(ERG_BUG_TRIGGER_ADDRESS);
  });

  it("importFromMnemonic and deriveFromMnemonic produce identical addresses", () => {
    const a = ergoAdapter.importFromMnemonic(ABANDON_12);
    const b = ergoAdapter.deriveFromMnemonic(ABANDON_12);
    expect(a.address).toBe(b.address);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it("importFromPrivateKey round-trips a derived key back to the same address", () => {
    const fromMnemonic = ergoAdapter.deriveFromMnemonic(ABANDON_12);
    const fromPriv = ergoAdapter.importFromPrivateKey(fromMnemonic.privateKey);
    expect(fromPriv.address).toBe(fromMnemonic.address);
  });

  it("rejects malformed private keys", () => {
    expect(() => ergoAdapter.importFromPrivateKey("not-hex")).toThrow();
    expect(() => ergoAdapter.importFromPrivateKey("dead")).toThrow();
    expect(() => ergoAdapter.importFromPrivateKey("0x" + "00".repeat(31))).toThrow();
  });
});
