/**
 * Which send path a wallet takes. Each `false` here is a fund-visibility bug
 * if it flips the wrong way — in one direction the user cannot spend a funded
 * wallet, in the other we scan an account they are not on and tell them the
 * same lie for a different reason.
 */
import { describe, it, expect } from "vitest";
import { shouldUseAccountSend } from "./accountSend";

const ELIGIBLE = {
  hasAccountSend: true,
  accountMatches: true,
  hasMnemonic: true,
} as const;

describe("shouldUseAccountSend", () => {
  it("routes an eligible UTXO wallet through the account path", () => {
    expect(shouldUseAccountSend({ ...ELIGIBLE })).toBe(true);
  });

  it("does not route chains whose adapter has no account path", () => {
    // ETH, SOL, XRP… — account-model chains that never split.
    expect(shouldUseAccountSend({ ...ELIGIBLE, hasAccountSend: false })).toBe(false);
  });

  it("does not route a private-key-only import", () => {
    // No mnemonic means no siblings can be derived, so the account path has
    // nothing to gather. Falling back is correct, not a degradation.
    expect(shouldUseAccountSend({ ...ELIGIBLE, hasMnemonic: false })).toBe(false);
  });

  it("does not route a wallet on a different account of the same chain", () => {
    // The LTC BIP-44 legacy case. Scanning BIP-84 for a legacy wallet would
    // report "insufficient funds" over a funded wallet — the exact failure
    // account-wide sending exists to remove.
    expect(shouldUseAccountSend({ ...ELIGIBLE, accountMatches: false })).toBe(false);
  });

  it("does not route token sends", () => {
    // The account path spends the native coin. A token send must keep using
    // the adapter's own token branch.
    expect(shouldUseAccountSend({ ...ELIGIBLE, assetType: "USDT" })).toBe(false);
  });

  it("needs every condition — no single flag can carry it", () => {
    const flags = ["hasAccountSend", "accountMatches", "hasMnemonic"] as const;
    for (const off of flags) {
      expect(
        shouldUseAccountSend({ ...ELIGIBLE, [off]: false }),
        `${off}=false must block the account path`,
      ).toBe(false);
    }
  });
});
