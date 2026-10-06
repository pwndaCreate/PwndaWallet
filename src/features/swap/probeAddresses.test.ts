/**
 * The minimum probe's placeholder addresses must be REAL addresses.
 *
 * `PLACEHOLDER_ADDRESSES` fills the recipient/refundTo fields of the dry quote
 * the form fires on pair selection, for any chain the user has not derived
 * yet. Nothing is ever sent to them. That makes them feel like filler, and
 * they are not: 1Click validates both fields before it will price anything,
 * so a malformed one costs the pair its minimum hint entirely, silently, and
 * only for the users who have not derived that chain.
 *
 * This has now happened twice.
 *
 *  - 2026-09-05, ADA: no `cardano` entry at all. `addressForAssetId` threw,
 *    the probe died before any network call, and the thrown sentence
 *    ("...CIP-1852 path") was then read by the minimum parser as a floor of
 *    1852 atomic units. Fixed by adding the entry.
 *  - 2026-09-09, DASH: an entry that LOOKED right and was not. Thirty-four
 *    characters, version byte 0x4c, leading "X" - every property you would
 *    check by eye - but the base58check checksum did not verify. 1Click
 *    answered "recipient is not valid" and DASH never had a minimum hint.
 *
 * The second one is why this file derives rather than inspects. "It looks
 * like a Dash address" is exactly the check that passed on a string that was
 * not one. So each placeholder is regenerated here from the world-public
 * abandon test mnemonic, using the wallet's OWN derivation, and compared. A
 * placeholder that no longer matches is either a typo or a derivation change,
 * and both want a human.
 */
import { describe, expect, it } from "vitest";

import { PLACEHOLDER_ADDRESSES } from "./useSwapQuote";
import { deriveDashAtPath } from "../../wallets/dash-wallet";
import { deriveTrxAtPath, trxAdapter } from "../../wallets/trx-wallet";
import { deriveXrpAtPath, xrpAdapter } from "../../wallets/xrp-wallet";
import { aptAdapter } from "../../wallets/apt-wallet";

/** The standard BIP-39 test vector. World-public; holds nothing. */
const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("probe placeholder addresses", () => {
  it("uses the abandon mnemonic's real Dash address, checksum and all", () => {
    // m/44'/5'/0'/0/0 is the wallet's own Dash path (`dash-wallet.ts`
    // derivation.path), so the placeholder is the same address a fresh
    // import would produce rather than a hand-written lookalike.
    const derived = deriveDashAtPath(ABANDON, "m/44'/5'/0'/0/0");
    expect(PLACEHOLDER_ADDRESSES.dash).toBe(derived.address);
  });

  it("uses the abandon mnemonic's real XRP and TRON addresses (2026-09-29)", () => {
    // Both at the wallet's OWN default paths, read from the adapters rather
    // than restated, so a change of default shows up here as a failure.
    const pathOf = (d: typeof xrpAdapter.derivation) => (d?.kind === "bip39" ? d.path : "");
    const xrp = deriveXrpAtPath(ABANDON, pathOf(xrpAdapter.derivation));
    const tron = deriveTrxAtPath(ABANDON, pathOf(trxAdapter.derivation));
    expect(PLACEHOLDER_ADDRESSES.xrp).toBe(xrp.address);
    expect(PLACEHOLDER_ADDRESSES.tron).toBe(tron.address);
    // USDT on TRON is held by the TRON account itself.
    expect(PLACEHOLDER_ADDRESSES.usdtTron).toBe(tron.address);
  });

  it("uses the abandon mnemonic's real Aptos address (2026-10-06, the USDT/USDC legs)", () => {
    // Without it the resolver's Aptos branch would throw for every probe of
    // a USDT-APTOS or USDC-APTOS pair, and MIN would never load for them.
    expect(PLACEHOLDER_ADDRESSES.aptos).toBe(aptAdapter.deriveFromMnemonic(ABANDON).address);
  });

  it("rejects the 2026-09-09 lookalike by name", () => {
    // Named so a future edit that reintroduces it fails with the reason
    // rather than a diff. It is shaped correctly and 1Click still refuses it.
    expect(PLACEHOLDER_ADDRESSES.dash).not.toBe(
      "XbBKwyVpYDoXcAYUdJ1XBQzfAkr8aLBmL2",
    );
  });

  it("has an entry for every chain family the resolver asks for", () => {
    // The ADA failure of 2026-09-05 was an ABSENT key, not a wrong one, and
    // absence reads as `undefined` at the call site rather than as an error.
    for (const fam of [
      "evm",
      "btc",
      "ltc",
      "doge",
      "bch",
      "dash",
      "sol",
      "cardano",
      "near",
      "stellar",
      "sui",
      "xrp",
      "tron",
      "usdtTron",
      "aptos",
    ] as const) {
      expect(PLACEHOLDER_ADDRESSES[fam], `${fam} placeholder missing`)
        .toBeTruthy();
    }
  });
});
