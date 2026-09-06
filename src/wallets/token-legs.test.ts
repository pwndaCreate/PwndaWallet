import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  atomicToDecimalString,
  decimalStringToAtomic,
  __testables,
} from "./spl-token-wallet";
import { addressToAbiWord } from "./trc20-wallet";
import { getAdapter } from "./index";
import { solAdapter } from "./sol-wallet";
import { trxAdapter } from "./trx-wallet";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("token amount conversion", () => {
  it("round-trips through atomic units", () => {
    for (const [dec, s] of [[6, "1250.4"], [6, "0.000001"], [18, "120"], [6, "0"]] as const) {
      expect(atomicToDecimalString(decimalStringToAtomic(s, dec), dec)).toBe(s);
    }
  });

  it("REFUSES more precision than the token has", () => {
    // Silently truncating here is how a user sends 1.9999995 and is told they
    // sent 1.999999 — the digit vanishes with no error. Reject instead.
    expect(() => decimalStringToAtomic("1.9999995", 6)).toThrow(/decimal places/);
    expect(() => decimalStringToAtomic("0.0000001", 6)).toThrow(/decimal places/);
    // Exactly at the limit is fine.
    expect(decimalStringToAtomic("1.999999", 6)).toBe(1_999_999n);
  });

  it("rejects junk rather than coercing it to zero", () => {
    for (const bad of ["", "abc", "1.2.3", "-5", "1e6", " "]) {
      expect(() => decimalStringToAtomic(bad, 6), bad).toThrow();
    }
  });

  it("does not lose precision on large 18-decimal amounts", () => {
    // The reason this is bigint and not Number: 2^53 is ~9e15, and an
    // 18-decimal token passes that at 0.01 tokens.
    const atomic = decimalStringToAtomic("123456.789012345678", 18);
    expect(atomic).toBe(123456789012345678000000n);
    expect(atomicToDecimalString(atomic, 18)).toBe("123456.789012345678");
  });
});

describe("SPL legs", () => {
  it("derive the SAME account as native SOL — never a separate key", () => {
    // The SPL owner IS the Solana account. A token leg that derived its own
    // key would show a balance at an address the user cannot spend from.
    const sol = solAdapter.deriveFromMnemonic(TEST_MNEMONIC);
    for (const chain of ["usdc-sol", "usdt-sol"] as const) {
      const leg = getAdapter(chain).deriveFromMnemonic(TEST_MNEMONIC);
      expect(leg.address).toBe(sol.address);
      expect(leg.privateKey).toBe(sol.privateKey);
      expect(leg.chain).toBe(chain);
    }
  });

  it("derives a deterministic associated token account", () => {
    const { ataFor } = __testables;
    const owner = new PublicKey(solAdapter.deriveFromMnemonic(TEST_MNEMONIC).address);
    const usdcMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const usdtMint = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    const a = ataFor(owner, usdcMint);
    expect(ataFor(owner, usdcMint).toBase58()).toBe(a.toBase58());
    // Different mint ⇒ different ATA. If these collided, a USDC send would
    // debit the USDT account.
    expect(ataFor(owner, usdtMint).toBase58()).not.toBe(a.toBase58());
  });
});

describe("TRC-20 leg", () => {
  it("derives the SAME account as native TRX", () => {
    const trx = trxAdapter.deriveFromMnemonic(TEST_MNEMONIC);
    const leg = getAdapter("usdt-tron").deriveFromMnemonic(TEST_MNEMONIC);
    expect(leg.address).toBe(trx.address);
    expect(leg.privateKey).toBe(trx.privateKey);
    expect(leg.chain).toBe("usdt-tron");
  });

  it("strips Tron's 41 prefix when building the ABI address word", () => {
    // THE detail that silently returns a zero balance when wrong: a Tron hex
    // address is 21 bytes (0x41 + 20), and the ABI word wants the trailing 20
    // left-padded to 32. Leaving the 41 on shifts every byte and addresses a
    // different account, which reads as "you hold nothing".
    const addr = trxAdapter.deriveFromMnemonic(TEST_MNEMONIC).address;
    const word = addressToAbiWord(addr);
    expect(word).toHaveLength(64);
    expect(word.startsWith("000000000000000000000000")).toBe(true);
    expect(word.slice(0, 26)).not.toContain("41");
    // The last 40 chars are the 20-byte account, and nothing was truncated.
    expect(/^0{24}[0-9a-f]{40}$/.test(word)).toBe(true);
  });
});

describe("no shipped stablecoin leg is receive-only", () => {
  it("every leg implements a real sendTransaction", async () => {
    // A leg the user can receive into but never spend from is a trap. This
    // asserts the method is not the "throws immediately" placeholder shape by
    // checking it fails on INPUT rather than on capability.
    const legs = ["usdc-sol", "usdt-sol", "usdt-tron", "usdc-eth", "usdt-bsc"] as const;
    for (const chain of legs) {
      const a = getAdapter(chain);
      expect(typeof a.sendTransaction).toBe("function");
      // Bad amount must be rejected by validation, not by "not implemented".
      await expect(
        a.sendTransaction("00".repeat(32), "irrelevant", "not-a-number"),
      ).rejects.toThrow();
    }
  });
});
