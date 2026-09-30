/**
 * Every Bitcoin derivation the import picker can choose is an account the
 * wallet can scan and spend (2026-09-29 send-safety audit).
 *
 * `derivation-detector.ts` auto-selects the funded derivation — BIP-84, BIP-49,
 * BIP-44, or the pre-2026-05-06 PwndaWallet quirk — and the wallet then SHOWS
 * that address. Before the fix only the two P2WPKH choices had an account spec:
 * a BIP-49 or BIP-44 wallet read 0 on the dashboard and could not send. This
 * ties the picker's addresses to the adapter's accounts, so a derivation added
 * to one without the other fails here rather than in a user's wallet.
 */
import { describe, it, expect } from "vitest";
import {
  derivePerChoice,
  DEFAULT_DERIVATION_CHOICE,
} from "./derivation-detector";
import { btcAdapter, btcUtxoAccounts } from "../../wallets/btc-wallet";
import { ltcAdapter, ltcUtxoAccounts } from "../../wallets/ltc-wallet";
import { utxoAccountSpecFor } from "../../wallets/utxo-account";

const M =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("BTC: each picker choice is an account the adapter scans and spends", () => {
  const cases: Array<{ choice: string; accountPath: string; scriptType: string; prefix: RegExp }> = [
    { choice: "bip84", accountPath: "m/84'/0'/0'", scriptType: "p2wpkh", prefix: /^bc1q/ },
    { choice: "bip49", accountPath: "m/49'/0'/0'", scriptType: "p2sh-p2wpkh", prefix: /^3/ },
    { choice: "bip44", accountPath: "m/44'/0'/0'", scriptType: "p2pkh", prefix: /^1/ },
    { choice: "pwnda-legacy", accountPath: "m/44'/0'/0'", scriptType: "p2wpkh", prefix: /^bc1q/ },
  ];
  for (const c of cases) {
    it(`${c.choice} → ${c.accountPath} (${c.scriptType})`, () => {
      const shown = derivePerChoice(M, { ...DEFAULT_DERIVATION_CHOICE, bitcoin: c.choice }).bitcoin.address;
      expect(shown).toMatch(c.prefix);
      const spec = utxoAccountSpecFor(M, btcUtxoAccounts, shown);
      expect(spec, `no BTC account derives ${shown}`).not.toBeNull();
      expect(spec!.accountPath).toBe(c.accountPath);
      expect(spec!.scriptType).toBe(c.scriptType);
      expect(btcAdapter.supportsAccountSend!(M, shown)).toBe(true);
    });
  }
});

describe("LTC: the legacy choice is the legacy account", () => {
  it("bip44-legacy → ltcUtxoAccounts[1]; account-wide send stays BIP-84-only (its own sweep path)", () => {
    const shown = derivePerChoice(M, { ...DEFAULT_DERIVATION_CHOICE, litecoin: "bip44-legacy" }).litecoin.address;
    expect(utxoAccountSpecFor(M, ltcUtxoAccounts, shown)).toBe(ltcUtxoAccounts[1]);
    expect(ltcAdapter.supportsAccountSend!(M, shown)).toBe(false);
  });
});
