/**
 * The fresh receive address comes from the account the wallet DISPLAYS
 * (2026-09-29 send-safety audit).
 *
 * `useUtxoReceiveAddress` rotated through `utxoAccounts[0]` — BIP-84 — whatever
 * wallet was on screen. For a BIP-49 or BIP-44 Bitcoin wallet (or a legacy LTC
 * one) it handed out a BIP-84 address; once the dashboard scans the DISPLAYED
 * account, a deposit to that address lands where nothing adds it up. These pin
 * `utxoReceiveAddressFor`, the hook's pure half.
 */
import { describe, it, expect } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { utxoReceiveAddressFor } from "./utxoAccountRegistry";
import { btcUtxoAccounts } from "../wallets/btc-wallet";
import { ltcUtxoAccounts, deriveLtcLegacyFromMnemonic } from "../wallets/ltc-wallet";
import { deriveDashAtPath } from "../wallets/dash-wallet";
import { firstUnusedReceiveAddress, deriveUtxoAddresses, type UtxoAccountSpec } from "../wallets/utxo-account";
import type { UtxoAccountSummary } from "../wallets/utxo-account-balance";

const M =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(M, ""));
const BIP49 = btcUtxoAccounts.find((s) => s.accountPath === "m/49'/0'/0'")!;
const BIP84 = btcUtxoAccounts[0];

/** A complete summary whose used receive indexes are `used`, for `spec`. */
function summaryOf(spec: UtxoAccountSpec, used: number[]): UtxoAccountSummary {
  const entries = used.map((i) => {
    const [d] = deriveUtxoAddresses(M, spec, 0, i, 1);
    return { path: d.path, address: d.address, chainIndex: 0 as const, index: i, balanceSat: 1, used: true };
  });
  return {
    chain: spec.chain,
    totalSat: entries.length,
    balance: "0",
    entries,
    scanned: 80,
    complete: true,
    deep: true,
    strandedSat: 0,
    strandedEntries: [],
    requiredGapLimit: 20,
    account: { accountPath: spec.accountPath, label: spec.label },
  };
}

describe("receive rotation follows the displayed account (2026-09-29 send-safety audit)", () => {
  const shown49 = BIP49.deriveAddress(root.derive("m/49'/0'/0'/0/0"));

  it("a BIP-49 wallet is handed its own next 3… address, not a BIP-84 one", () => {
    const summary = summaryOf(BIP49, [0, 1]);
    const next = utxoReceiveAddressFor("bitcoin", M, shown49, summary);
    expect(next).toBe(BIP49.deriveAddress(root.derive("m/49'/0'/0'/0/2")));
    expect(next).toMatch(/^3/);
    // What the hook computed before: the BIP-84 account's index 2.
    expect(firstUnusedReceiveAddress(M, BIP84, summary)?.address).toMatch(/^bc1q/);
  });

  it("a legacy-LTC wallet is handed its own next L… address", () => {
    const legacy = ltcUtxoAccounts[1];
    const next = utxoReceiveAddressFor(
      "litecoin",
      M,
      deriveLtcLegacyFromMnemonic(M).address,
      summaryOf(legacy, [0]),
    );
    expect(next).toBe(deriveUtxoAddresses(M, legacy, 0, 1, 1)[0].address);
    expect(next).toMatch(/^L/);
  });

  it("another account's summary (a derivation switch, before the rescan lands) moves nothing: receive/0 of the SHOWN account", () => {
    // The BIP-84 summary says indexes 0..5 are used — of BIP-84, not BIP-49.
    const next = utxoReceiveAddressFor("bitcoin", M, shown49, summaryOf(BIP84, [0, 1, 2, 3, 4, 5]));
    expect(next).toBe(shown49);
  });

  it("a wallet with no account (DASH on Atomic's path) gets no rotation", () => {
    const shown = deriveDashAtPath(M, "m/44'/5'/0'").address;
    expect(utxoReceiveAddressFor("dash", M, shown, undefined)).toBeNull();
  });

  it("the default BIP-84 wallet rotates exactly as before (regression)", () => {
    const shown84 = BIP84.deriveAddress(root.derive("m/84'/0'/0'/0/0"));
    expect(utxoReceiveAddressFor("bitcoin", M, shown84, summaryOf(BIP84, [0, 1, 2]))).toBe(
      BIP84.deriveAddress(root.derive("m/84'/0'/0'/0/3")),
    );
  });
});
