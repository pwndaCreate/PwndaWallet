/**
 * An ADA swap deposit spends from the address the wallet SHOWS (2026-09-29
 * send-safety audit).
 *
 * `executeCardanoTransfer` re-derived CIP-1852 account 0 / index 0 and spent
 * that, logging a warning when it disagreed with the displayed address. For a
 * wallet imported on any other derivation the deposit came out of a different
 * address than the one on screen — the fault the dashboard Send had
 * (`cardanoSend.test.ts`). The Send button was fixed on its own branch; this
 * pins the swap deposit, which calls `sendAda` directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent: Array<Record<string, unknown>> = [];

vi.mock("../../wallets/cardano-tx", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../wallets/cardano-tx")>();
  return {
    ...real,
    sendAda: vi.fn(async (args: Record<string, unknown>) => {
      sent.push(args);
      return { txHash: "ab".repeat(32), feeLovelace: 170_000n };
    }),
  };
});

const { executeCardanoTransfer } = await import("./swap-sources");
const { deriveCardanoKeySet, deriveCardanoKeySetAt } = await import(
  "../../wallets/cardano-cip1852"
);

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Any mainnet key-hash address works as the deposit: sendAda is stubbed.
const DEPOSIT = deriveCardanoKeySetAt(MNEMONIC, 3, 3).address;

beforeEach(() => {
  sent.length = 0;
});

describe("ADA swap deposits spend the displayed address", () => {
  it("a wallet shown on account 1 deposits from account 1, with that address's key", async () => {
    const shown = deriveCardanoKeySetAt(MNEMONIC, 1, 0).address;
    // Control: the case the old code got wrong is a NON-default address.
    expect(shown).not.toBe(deriveCardanoKeySet(MNEMONIC).address);

    await executeCardanoTransfer({
      mnemonic: MNEMONIC,
      fromAddress: shown,
      depositAddress: DEPOSIT,
      amountAtomic: "2500000",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].fromAddress).toBe(shown);
    expect(sent[0].toAddress).toBe(DEPOSIT);
    expect(sent[0].amountLovelace).toBe(2_500_000n);
    // The key that controls `shown`, not the default one.
    expect(sent[0].signer).toBeDefined();
  });

  it("refuses an address this recovery phrase does not control, signing nothing", async () => {
    const stranger = deriveCardanoKeySetAt(
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
      0,
      0,
    ).address;
    await expect(
      executeCardanoTransfer({
        mnemonic: MNEMONIC,
        fromAddress: stranger,
        depositAddress: DEPOSIT,
        amountAtomic: "2500000",
      }),
    ).rejects.toThrow(/does not control the ADA address it shows[\s\S]*Nothing was sent/);
    expect(sent).toHaveLength(0);
  });

  it("with no displayed address, falls back to account 0 / index 0 as before", async () => {
    await executeCardanoTransfer({
      mnemonic: MNEMONIC,
      fromAddress: "",
      depositAddress: DEPOSIT,
      amountAtomic: "2500000",
    });
    expect(sent[0].fromAddress).toBe(deriveCardanoKeySet(MNEMONIC).address);
    expect(sent[0].signer).toBeUndefined();
  });
});
