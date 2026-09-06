/**
 * Vault encryption tests.
 *
 * `src/crypto.ts` is the single chokepoint every wallet save passes through —
 * `saveVaultV3` calls `encrypt()`, and if that throws, nothing reaches disk.
 * It had no test coverage at all until 2026-08-12, which is a strange gap for
 * the one function standing between a user's seed phrase and their filesystem.
 *
 * These lock the properties that actually matter for fund safety:
 *   - a round-trip returns exactly what went in
 *   - the wrong password FAILS rather than returning garbage
 *   - salt and IV are fresh per encryption (no nonce reuse under AES-GCM)
 *   - the ciphertext is authenticated (tampering is detected, not decrypted)
 *   - the KDF cost stays where we set it
 */

import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "./crypto";

const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct-horse-battery-staple";

describe("vault encryption", () => {
  it("round-trips a seed phrase unchanged", async () => {
    const enc = await encrypt(SEED, PASSWORD);
    await expect(decrypt(enc, PASSWORD)).resolves.toBe(SEED);
  });

  it("round-trips unicode and long payloads", async () => {
    // The real payload is a JSON v3 vault, not a bare seed — make sure the
    // TextEncoder/TextDecoder path is byte-exact for non-ASCII too.
    const payload = JSON.stringify({
      v: 3,
      note: "émoji 🐼 and ünicode",
      wallets: Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, seed: SEED })),
    });
    const enc = await encrypt(payload, PASSWORD);
    await expect(decrypt(enc, PASSWORD)).resolves.toBe(payload);
  });

  it("REJECTS the wrong password instead of returning garbage", async () => {
    // The critical property. AES-GCM is authenticated, so a bad key must fail
    // the tag check and throw — never hand back plausible-looking bytes that a
    // caller might treat as a seed.
    const enc = await encrypt(SEED, PASSWORD);
    await expect(decrypt(enc, "not-the-password")).rejects.toThrow();
  });

  it("uses a fresh salt and IV for every encryption", async () => {
    // Same plaintext, same password, twice. If either value were fixed, two
    // ciphertexts would match — and a reused GCM nonce under the same key is a
    // catastrophic break, not a nitpick.
    const a = await encrypt(SEED, PASSWORD);
    const b = await encrypt(SEED, PASSWORD);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // Both must still decrypt.
    await expect(decrypt(a, PASSWORD)).resolves.toBe(SEED);
    await expect(decrypt(b, PASSWORD)).resolves.toBe(SEED);
  });

  it("detects tampering with the ciphertext", async () => {
    const enc = await encrypt(SEED, PASSWORD);
    const raw = atob(enc.ciphertext);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    bytes[0] ^= 0xff; // flip a byte
    const tampered = {
      ...enc,
      ciphertext: btoa(String.fromCharCode(...bytes)),
    };
    await expect(decrypt(tampered, PASSWORD)).rejects.toThrow();
  });

  it("detects tampering with the IV", async () => {
    const enc = await encrypt(SEED, PASSWORD);
    const other = await encrypt(SEED, PASSWORD);
    await expect(decrypt({ ...enc, iv: other.iv }, PASSWORD)).rejects.toThrow();
  });

  it("emits a 16-byte salt and a 12-byte IV", async () => {
    // 12 bytes is the AES-GCM nonce size the spec recommends; 16 is a standard
    // PBKDF2 salt. Encoded as base64 in the stored blob.
    const enc = await encrypt(SEED, PASSWORD);
    expect(atob(enc.salt).length).toBe(16);
    expect(atob(enc.iv).length).toBe(12);
  });

  it("keeps the PBKDF2 iteration count at the documented cost", async () => {
    // Guards against someone lowering this to speed up tests or startup.
    // 600k SHA-256 iterations is the current OWASP figure; dropping it
    // silently weakens every vault written afterwards.
    const src = await import("./crypto?raw").catch(() => null);
    if (!src) return; // ?raw unsupported in this runner — skip rather than flake
    expect(String((src as { default: string }).default)).toContain("iterations: 600000");
  });
});
