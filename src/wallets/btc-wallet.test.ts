import { describe, it, expect } from "vitest";
import { btcAdapter, deriveLegacyBtcFromMnemonic } from "./btc-wallet";

const ABANDON_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("btc-wallet derivation", () => {
  it("derives the BIP-84 spec vector address from the abandon mnemonic", () => {
    // BIP-84 §Test vectors — first receive address. This is the same
    // value Exodus, Trust Wallet, Trezor Suite, Ledger Live, Phantom
    // and Sparrow produce for this seed at m/84'/0'/0'/0/0.
    const w = btcAdapter.deriveFromMnemonic(ABANDON_MNEMONIC);
    expect(w.address).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(w.chain).toBe("bitcoin");
    expect(w.privateKey.length).toBe(64);
  });

  it("legacy helper returns the pre-2026-05-06 non-standard address", () => {
    // m/44'/0'/0'/0/0 derived as a key, encoded as P2WPKH bech32 — what
    // PwndaWallet builds prior to the BIP-84 fix produced. Locks in the
    // value so the sweep UX surfaces the right address for migration.
    const legacy = deriveLegacyBtcFromMnemonic(ABANDON_MNEMONIC);
    expect(legacy.address).toMatch(/^bc1q[a-z0-9]+$/);
    expect(legacy.address).not.toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    // The legacy address for this seed is deterministic; pin it.
    expect(legacy.address).toBe("bc1qmxrw6qdh5g3ztfcwm0et5l8mvws4eva24kmp8m");
  });

  it("standard and legacy addresses differ for the same mnemonic", () => {
    const standard = btcAdapter.deriveFromMnemonic(ABANDON_MNEMONIC);
    const legacy = deriveLegacyBtcFromMnemonic(ABANDON_MNEMONIC);
    expect(standard.address).not.toBe(legacy.address);
    expect(standard.privateKey).not.toBe(legacy.privateKey);
  });
});
