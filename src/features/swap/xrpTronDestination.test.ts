/**
 * XRP, TRX and USDT on TRON as NEAR Intents legs: the ADDRESS half
 * (2026-09-29). `xrpTronSource.test.ts` covers the sending half.
 *
 * Until this date `addressForAssetId` threw for all three, unconditionally:
 *
 *   "TRON destination is supported but the wallet has no derived TRON
 *    address yet — open the TRON chain in the dashboard."
 *
 * There was no bundle field to read, so no amount of opening the TRON chain
 * could satisfy it. The main quote path hid the gap by falling back to the
 * view's own per-ticker address. The MIN probe, the pair-change minimum probe
 * and the Earn/convert estimates have no such fallback, and failed on every
 * XRP / TRX / USDT-TRON pair. The MIN button then printed the sentence above
 * as "NEAR said: …" after "did not quote at any size up to 3.44465723 LTC",
 * for a pair NEAR was never asked about. NEAR quotes it: 3.44465723 LTC →
 * 688.7 TRX, live, the same evening.
 *
 * The last two blocks are the checks that would have caught it on the day the
 * three rows were added: every asset the NEAR picker offers must resolve an
 * address from a fully derived wallet, and a fault that stops a request from
 * being built must never be reported as NEAR's answer.
 */
import { readFileSync } from "node:fs";

import bs58check from "bs58check";
import { classicAddressToXAddress } from "xrpl";
import { describe, expect, it } from "vitest";

import {
  IntentsValidationError,
  addressForAssetId,
  assertValidTronAddress,
  assertValidXrpAddress,
  deriveWalletAddresses,
  type WalletAddresses,
} from "./asset-address-resolver";
import { ASSET_CAPABILITIES } from "./asset-capabilities";
import { probeBuildFault } from "./intents-pair-min-probe";
import { getDropdownTickers } from "./swap-data";
import { PLACEHOLDER_ADDRESSES } from "./useSwapQuote";
import { deriveTrxAtPath } from "../../wallets/trx-wallet";
import { deriveXrpAtPath } from "../../wallets/xrp-wallet";

/** The standard BIP-39 test vector. World-public; holds nothing of ours. */
const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const XRP_ASSET = ASSET_CAPABILITIES.XRP.nearIntentsAsset!;
const TRX_ASSET = ASSET_CAPABILITIES.TRX.nearIntentsAsset!;
const USDT_TRON_ASSET = ASSET_CAPABILITIES["USDT-TRON"].nearIntentsAsset!;
const LTC_ASSET = ASSET_CAPABILITIES.LTC.nearIntentsAsset!;

// Derived with the wallet's own derivers, never typed by eye: see
// `probeAddresses.test.ts` for the DASH lookalike that looked right.
const XRP_ADDR = deriveXrpAtPath(ABANDON, "m/44'/144'/0'/0/0").address;
const TRON_ADDR = deriveTrxAtPath(ABANDON, "m/44'/60'/0'/0/0").address;
// A second, different TRON account from the same seed: TRX's own coin type,
// the path the derivation profile picks for an Exodus/Atomic import.
const TRON_ALT = deriveTrxAtPath(ABANDON, "m/44'/195'/0'/0/0").address;

const WALLET: WalletAddresses = {
  ltc: PLACEHOLDER_ADDRESSES.ltc,
  xrp: XRP_ADDR,
  tron: TRON_ADDR,
  usdtTron: TRON_ADDR,
};

describe("the three branches that used to throw unconditionally", () => {
  it("resolves XRP to the wallet's XRP account", () => {
    expect(addressForAssetId(XRP_ASSET, WALLET)).toBe(XRP_ADDR);
  });

  it("resolves TRX to the wallet's TRON account", () => {
    expect(addressForAssetId(TRX_ASSET, WALLET)).toBe(TRON_ADDR);
  });

  it("delivers USDT to the USDT-TRON entry and TRX to the TRX entry", () => {
    // The same account in the normal case. When a derivation choice splits
    // them, each asset must land where the dashboard shows THAT asset, or the
    // swap completes and the balance row never moves.
    const split: WalletAddresses = { tron: TRON_ADDR, usdtTron: TRON_ALT };
    expect(TRON_ALT).not.toBe(TRON_ADDR);
    expect(addressForAssetId(USDT_TRON_ASSET, split)).toBe(TRON_ALT);
    expect(addressForAssetId(TRX_ASSET, split)).toBe(TRON_ADDR);
  });

  it("works in both directions, as recipient and as refund address", () => {
    // `refundTo` goes through the same function with the ORIGIN asset, so
    // the XRP and TRON source legs of 2026-09-09 depended on this too.
    for (const asset of [XRP_ASSET, TRX_ASSET, USDT_TRON_ASSET]) {
      expect(() => addressForAssetId(asset, WALLET)).not.toThrow();
    }
  });

  it("says what to do when the chain really is missing", () => {
    expect(() => addressForAssetId(TRX_ASSET, {})).toThrow(/No derived TRON address/);
    expect(() => addressForAssetId(XRP_ASSET, {})).toThrow(/No derived XRP address/);
    expect(() => addressForAssetId(USDT_TRON_ASSET, { tron: TRON_ADDR })).toThrow(
      /No derived USDT \(TRON\) address/,
    );
    // The retired sentence, by name, so it cannot quietly come back.
    expect(() => addressForAssetId(TRX_ASSET, {})).not.toThrow(/is supported but/);
  });

  it("refuses a TRON token the wallet has no balance row for", () => {
    expect(() =>
      addressForAssetId(
        "nep141:tron-0000000000000000000000000000000000000000.omft.near",
        WALLET,
      ),
    ).toThrow(/only USDT on TRON/);
  });
});

describe("address checks", () => {
  it("accepts a derived TRON address", () => {
    expect(() => assertValidTronAddress(TRON_ADDR)).not.toThrow();
    expect(() => assertValidTronAddress(TRON_ALT)).not.toThrow();
  });

  it("rejects a TRON lookalike whose checksum fails", () => {
    // Same shape: 34 chars, leading T, base58. One character changed.
    const last = TRON_ADDR.slice(-1);
    const lookalike = TRON_ADDR.slice(0, -1) + (last === "a" ? "b" : "a");
    expect(lookalike).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(() => assertValidTronAddress(lookalike)).toThrow(IntentsValidationError);
  });

  it("rejects valid base58check with the wrong version byte", () => {
    // Version 0x42 also encodes to 34 characters starting with "T", and its
    // checksum is fine. Only the version check stops it.
    const wrongVersion = bs58check.encode(Uint8Array.from([0x42, ...Array(20).fill(7)]));
    expect(wrongVersion).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(() => assertValidTronAddress(wrongVersion)).toThrow(IntentsValidationError);
  });

  it("rejects an EVM address offered as a TRON recipient", () => {
    // Pwnda's default TRON key IS the EVM key, so this confusion is one
    // encoding step away rather than hypothetical.
    expect(() =>
      assertValidTronAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94"),
    ).toThrow(IntentsValidationError);
  });

  it("accepts a derived XRP address and rejects its X-address form", () => {
    expect(() => assertValidXrpAddress(XRP_ADDR)).not.toThrow();
    // An X-address folds a destination tag into the address. The wallet
    // never produces one, and one should not ride in as a recipient.
    const x = classicAddressToXAddress(XRP_ADDR, false, false);
    expect(() => assertValidXrpAddress(x)).toThrow(IntentsValidationError);
  });

  it("rejects an XRP lookalike whose checksum fails", () => {
    const last = XRP_ADDR.slice(-1);
    const lookalike = XRP_ADDR.slice(0, -1) + (last === "a" ? "b" : "a");
    expect(() => assertValidXrpAddress(lookalike)).toThrow(IntentsValidationError);
  });
});

describe("the bundle is filled from the wallet entries", () => {
  it("reads xrp, tron and usdt-tron, each from its own entry", () => {
    const bundle = deriveWalletAddresses({
      xrp: { address: XRP_ADDR },
      tron: { address: TRON_ADDR },
      "usdt-tron": { address: TRON_ALT },
    });
    expect(bundle.xrp).toBe(XRP_ADDR);
    expect(bundle.tron).toBe(TRON_ADDR);
    expect(bundle.usdtTron).toBe(TRON_ALT);
  });
});

describe("every asset the NEAR picker offers resolves an address", () => {
  // The check that was missing. `PLACEHOLDER_ADDRESSES` is a fully derived
  // wallet by construction (its type is `Required<WalletAddresses>`), so any
  // throw here is an asset the picker offers and the resolver cannot serve.
  const offered = [
    ...new Set([
      ...getDropdownTickers({ router: "intents" }),
      ...getDropdownTickers({ router: "intents", sourceOnly: true }),
    ]),
  ];

  it("covers the whole picker, including the three that failed", () => {
    expect(offered.length).toBeGreaterThan(20);
    for (const t of ["XRP", "TRX", "USDT-TRON"]) expect(offered).toContain(t);
  });

  it.each(offered)("%s resolves", (ticker) => {
    const asset = ASSET_CAPABILITIES[ticker]?.nearIntentsAsset;
    expect(asset, `${ticker} is offered on NEAR with no asset id`).toBeTruthy();
    expect(() => addressForAssetId(asset!, PLACEHOLDER_ADDRESSES)).not.toThrow();
  });
});

describe("a request that cannot be built is not NEAR's answer", () => {
  it("probeBuildFault names the missing address", () => {
    expect(probeBuildFault(LTC_ASSET, TRX_ASSET, { ltc: PLACEHOLDER_ADDRESSES.ltc })).toMatch(
      /No derived TRON address/,
    );
    expect(probeBuildFault(TRX_ASSET, LTC_ASSET, { ltc: PLACEHOLDER_ADDRESSES.ltc })).toMatch(
      /No derived TRON address/,
    );
    expect(probeBuildFault(LTC_ASSET, TRX_ASSET, WALLET)).toBeNull();
  });

  it("the MIN toast handles a local fault before it can say 'NEAR said'", () => {
    // Wiring check on the shared form (portrait and landscape both mount it).
    const src = readFileSync(new URL("./SwapForm.tsx", import.meta.url), "utf8");
    const localBranch = src.indexOf("} else if (local) {");
    const nearSaid = src.indexOf("NEAR said: ");
    expect(localBranch, "SwapForm has no local-fault branch").toBeGreaterThan(-1);
    expect(nearSaid).toBeGreaterThan(localBranch);
  });

  it("probeMinimumNow checks the build before searching", () => {
    const src = readFileSync(new URL("./useSwapQuote.ts", import.meta.url), "utf8");
    const check = src.indexOf("probeBuildFault(fromToken.assetId, toToken.assetId, probeWallet)");
    const firstProbe = src.indexOf("await probePairFloor(");
    expect(check, "probeMinimumNow no longer pre-checks the build").toBeGreaterThan(-1);
    expect(firstProbe).toBeGreaterThan(check);
  });
});
