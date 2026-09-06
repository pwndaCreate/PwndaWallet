/**
 * Regression lock for the NEAR Intents asset → user-address resolver.
 *
 * The contract this test protects:
 *   1. The Hardhat dev mnemonic (`test test test test … junk`) at
 *      m/44'/60'/0'/0/0 produces `0xf39Fd6...2266` — the same vector
 *      pinned by `cargo test swap::derive::vector1_bip39_to_eth_address`
 *      and the entire EVM family. The resolver MUST return that value
 *      for every EVM-namespaced 1Click asset id.
 *   2. BTC at the BIP-84 zero-vector mnemonic produces
 *      `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`. Returned for
 *      `nep141:btc.omft.near`.
 *   3. Every chain not in v1's (BTC + EVM) supported list throws
 *      `IntentsValidationError("not yet supported as NEAR Intents
 *      endpoint")` — clean local rejection rather than a 5xx round trip.
 *   4. Format validators reject malformed addresses.
 */
import { describe, expect, it } from "vitest";
import {
  IntentsValidationError,
  addressForAssetId,
  assertValidBtcAddress,
  assertValidEvmAddress,
  type WalletAddresses,
} from "./asset-address-resolver";

// Hardhat dev mnemonic vector — same one pinned in the Rust core's
// `vector1_bip39_to_eth_address`. Cross-checked against every EVM
// library in existence; locking it here ensures a future refactor that
// drifts EVM derivation will fail loud.
const HARDHAT_EVM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// BIP-84 zero-vector first receive address — matches the BIP-84 spec
// and the Rust `vector2_bip84_to_btc_p2wpkh` test.
const ABANDON_BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

const HARDHAT_WALLET: WalletAddresses = {
  evm: HARDHAT_EVM,
  btc: ABANDON_BTC,
};

describe("addressForAssetId — Round 1 (BTC + EVM)", () => {
  it("returns Hardhat EVM address for nep141:eth.omft.near", () => {
    expect(addressForAssetId("nep141:eth.omft.near", HARDHAT_WALLET)).toBe(
      HARDHAT_EVM
    );
  });

  it("returns Hardhat EVM address for the Polygon asset id", () => {
    expect(addressForAssetId("nep141:pol.omft.near", HARDHAT_WALLET)).toBe(
      HARDHAT_EVM
    );
  });

  it("returns Hardhat EVM address for chain-prefixed Arbitrum tokens", () => {
    // 1Click identifies non-native ERC-20 tokens with a `<chain>-<addr>`
    // body (e.g. arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831 = USDC
    // on Arbitrum). The same EVM address spends them all.
    expect(
      addressForAssetId(
        "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
        HARDHAT_WALLET
      )
    ).toBe(HARDHAT_EVM);
    expect(
      addressForAssetId(
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        HARDHAT_WALLET
      )
    ).toBe(HARDHAT_EVM);
  });

  it("returns BTC bech32 for nep141:btc.omft.near", () => {
    expect(addressForAssetId("nep141:btc.omft.near", HARDHAT_WALLET)).toBe(
      ABANDON_BTC
    );
  });

  it("throws IntentsValidationError when the EVM address isn't derived yet", () => {
    expect(() =>
      addressForAssetId("nep141:eth.omft.near", { btc: ABANDON_BTC })
    ).toThrow(IntentsValidationError);
  });

  it("throws IntentsValidationError when the BTC address isn't derived yet", () => {
    expect(() =>
      addressForAssetId("nep141:btc.omft.near", { evm: HARDHAT_EVM })
    ).toThrow(IntentsValidationError);
  });
});

describe("addressForAssetId — extended chain coverage (2026-05-07)", () => {
  // Asset coverage was widened to include SOL / NEAR-native / bridged
  // tokens / per-chain destination receivers. The chains that previously
  // returned "not yet supported" now return a derived address when the
  // wallet has one, or a clean "no derived address" message when not.
  it("resolves nep141:sol.omft.near to the wallet's SOL address", () => {
    const HARDHAT_SOL = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
    expect(
      addressForAssetId("nep141:sol.omft.near", { ...HARDHAT_WALLET, sol: HARDHAT_SOL })
    ).toBe(HARDHAT_SOL);
  });

  it("resolves nep141:wrap.near to the wallet's NEAR account", () => {
    const HARDHAT_NEAR =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(
      addressForAssetId("nep141:wrap.near", { ...HARDHAT_WALLET, near: HARDHAT_NEAR })
    ).toBe(HARDHAT_NEAR);
  });

  it("rejects nep141:sol.omft.near when no SOL wallet derived", () => {
    expect(() =>
      addressForAssetId("nep141:sol.omft.near", HARDHAT_WALLET)
    ).toThrow(/No derived Solana address/i);
  });

  it("rejects nep141:wrap.near when no NEAR wallet derived", () => {
    expect(() =>
      addressForAssetId("nep141:wrap.near", HARDHAT_WALLET)
    ).toThrow(/No derived NEAR address/i);
  });

  it("rejects nep141:ltc.omft.near when no LTC wallet derived", () => {
    expect(() =>
      addressForAssetId("nep141:ltc.omft.near", HARDHAT_WALLET)
    ).toThrow(/No derived LTC address/i);
  });

  it("rejects nep141:doge.omft.near when no DOGE wallet derived", () => {
    expect(() =>
      addressForAssetId("nep141:doge.omft.near", HARDHAT_WALLET)
    ).toThrow(/No derived DOGE address/i);
  });

  it("rejects nep141:bch.omft.near when no BCH wallet derived", () => {
    expect(() =>
      addressForAssetId("nep141:bch.omft.near", HARDHAT_WALLET)
    ).toThrow(/No derived BCH address/i);
  });

  it("rejects unrecognized asset ids", () => {
    expect(() =>
      addressForAssetId("nep141:totally-fake-not-near", HARDHAT_WALLET)
    ).toThrow(IntentsValidationError);
    expect(() =>
      addressForAssetId("nep141:totally-fake-not-near", HARDHAT_WALLET)
    ).toThrow(/Unrecognized/);
  });

  it("rejects asset ids outside any recognized namespace", () => {
    expect(() => addressForAssetId("ETH.ETH", HARDHAT_WALLET)).toThrow(
      IntentsValidationError
    );
    // Phase 0 (2026-05-08) widened dispatch to nep141 / nep245 / 1cs_v1.
    // Anything outside all three throws with a message naming all three.
    expect(() => addressForAssetId("BTC.BTC", HARDHAT_WALLET)).toThrow(
      /not in any recognized NEAR Intents namespace/
    );
  });
});

describe("format validators", () => {
  it("accepts valid EVM addresses", () => {
    expect(() => assertValidEvmAddress(HARDHAT_EVM)).not.toThrow();
    // Lower-case form (no checksum) is also valid syntactically.
    expect(() =>
      assertValidEvmAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")
    ).not.toThrow();
  });

  it("rejects malformed EVM addresses", () => {
    expect(() => assertValidEvmAddress("0xshort")).toThrow();
    expect(() =>
      assertValidEvmAddress("f39fd6e51aad88f6f4ce6ab8827279cfffb92266")
    ).toThrow(); // no 0x prefix
    expect(() => assertValidEvmAddress(ABANDON_BTC)).toThrow();
  });

  it("accepts valid BTC bech32 mainnet addresses", () => {
    expect(() => assertValidBtcAddress(ABANDON_BTC)).not.toThrow();
  });

  it("rejects EVM-formatted address as a BTC recipient (the original bug)", () => {
    // This is the exact failure mode that produced the 502: feeding
    // the user's hex EVM address into the BTC recipient slot.
    expect(() => assertValidBtcAddress(HARDHAT_EVM)).toThrow(
      IntentsValidationError
    );
    expect(() => assertValidBtcAddress(HARDHAT_EVM)).toThrow(
      /not a valid BTC mainnet bech32/
    );
  });

  it("rejects testnet/regtest BTC addresses (we only ship mainnet today)", () => {
    expect(() =>
      assertValidBtcAddress("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3")
    ).toThrow();
  });
});
