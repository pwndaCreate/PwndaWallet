/**
 * Regression locks for ADA on NEAR Intents.
 *
 * 2026-05-25: ADA shipped destination-only (receive AVAX→ADA etc.).
 * 2026-06-21: ADA promoted to ALSO be a source — its deposit tx is signed
 *   in the TS Cardano stack (cardano-tx.ts via executeCardanoTransfer),
 *   NOT a Rust signer (`tsSourceSigner: "cardano"` in asset-capabilities;
 *   `signerInRustCore` stays false). See [[ada-swap-source]].
 *
 * Tests cover:
 *   - SWAP_COIN_META entry shape (sourceCapable now TRUE, coverageNote set)
 *   - Routability: Intents-routable, NOT SwapKit-routable (asset id null)
 *   - Source-capability gates: ADA NOW appears in the FROM dropdown
 *   - Address resolver: dispatches `nep141:cardano.omft.near` to the
 *     wallet's CIP-1852 base address (`addr1…`), validates format
 *   - deriveWalletAddresses picks up `walletsByChain.cardano.address`
 *   - Intents-dedup: SYMBOL_NATIVE_CHAIN["ADA"] === "cardano"
 */
import { describe, expect, it } from "vitest";
import {
  SWAP_COIN_META,
  getDropdownTickers,
  isDestinationOnlyTicker,
  isIntentsRoutable,
  isSourceCapable,
  isSwapKitRoutable,
} from "./swap-data";
import {
  IntentsValidationError,
  addressForAssetId,
  assertValidCardanoAddress,
  deriveWalletAddresses,
} from "./asset-address-resolver";
import { defaultBlockchainFor } from "./intents-dedup";
import { NEAR_INTENTS_ASSETS } from "./near-intents-assets.generated";

// Canonical CIP-1852 base address derived from the BIP-39 ABANDON
// vector at m/1852'/1815'/0'/0/0 (payment) + m/1852'/1815'/0'/2/0
// (stake). Pinned in `cardano-cip1852.test.ts`; reused here as the
// "Pwnda-derived address (post-CIP-1852 fix)" target the user named.
const PWNDA_ADA =
  "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj0vs2qd4a6vmnq9hd6sy3yzkj";

// Exodus same-key fork — distinct from the CIP-1852 standard. Per the
// derivation-paths wiki this is a 36-candidate brute-force pattern;
// the import-time picker handles surfacing them. The resolver here
// just returns whatever the user's wallet derived — but the test
// ensures we don't *transform* a CIP-1852 address into anything else.
const EXODUS_LOOKING_ADDR =
  "addr1qy7wpr5jghltw3fc8d2lhfuy6xfqksuvrjsjp34qsnn03y8ngwhdz3tjkw88hg5dvpv8h6vsg9thtdz5nzhux8fphvqstk5p2x";

describe("ADA bidirectional — SWAP_COIN_META + routability", () => {
  it("has a SWAP_COIN_META entry with the expected shape", () => {
    const meta = SWAP_COIN_META.ADA;
    expect(meta).toBeDefined();
    expect(meta.ticker).toBe("ADA");
    expect(meta.chainKind).toBe("CARDANO");
    expect(meta.decimals).toBe(6);
    expect(meta.sourceCapable).toBe(true); // TS-signed source (2026-06-21)
    expect(meta.nearIntentsAsset).toBe("nep141:cardano.omft.near");
  });

  it("is NOT SwapKit-routable (swapKitAsset null until empirically confirmed)", () => {
    expect(SWAP_COIN_META.ADA.swapKitAsset).toBeNull();
    expect(isSwapKitRoutable("AVAX", "ADA")).toBe(false);
    expect(isSwapKitRoutable("ETH", "ADA")).toBe(false);
  });

  it("IS Intents-routable as a destination from any Intents-routable source", () => {
    expect(isIntentsRoutable("AVAX", "ADA")).toBe(true);
    expect(isIntentsRoutable("ETH", "ADA")).toBe(true);
    expect(isIntentsRoutable("BTC", "ADA")).toBe(true);
    expect(isIntentsRoutable("SOL", "ADA")).toBe(true);
  });

  it("IS source-capable (TS Cardano signer, not Rust)", () => {
    expect(isSourceCapable("ADA")).toBe(true);
    // signerInRustCore stays false — the capability comes from the TS
    // signer flag (`tsSourceSigner`), not a Rust `swap_sign_cardano`.
    expect(SWAP_COIN_META.ADA.sourceCapable).toBe(true);
  });

  it("carries a non-empty coverageNote shown in the destination UI", () => {
    expect(SWAP_COIN_META.ADA.coverageNote).toBeTruthy();
    expect(SWAP_COIN_META.ADA.coverageNote!.length).toBeGreaterThan(20);
    expect(SWAP_COIN_META.ADA.coverageNote!.length).toBeLessThanOrEqual(150);
  });
});

describe("ADA dropdown filtering — bidirectional", () => {
  it("appears in the source-side dropdown (2026-06-21)", () => {
    expect(getDropdownTickers({ sourceOnly: true })).toContain("ADA");
  });

  it("DOES appear in the destination-side dropdown", () => {
    expect(getDropdownTickers({ sourceOnly: false })).toContain("ADA");
  });

  it("is NO LONGER a destination-only ticker", () => {
    expect(isDestinationOnlyTicker("ADA")).toBe(false);
  });
});

describe("Cardano address resolver — addressForAssetId", () => {
  it("returns the Pwnda-derived CIP-1852 address unchanged", () => {
    const wallet = { cardano: PWNDA_ADA };
    const result = addressForAssetId("nep141:cardano.omft.near", wallet);
    expect(result).toBe(PWNDA_ADA);
  });

  it("returns whatever the wallet adapter provides (does NOT transform)", () => {
    // The resolver is a router, not a derivation engine. If the wallet
    // imported an Exodus-style address (pre-2026-05-06 fix), the resolver
    // still returns it — the import wizard's job is to surface the
    // mismatch, not the resolver's. Pins the no-transformation contract.
    const wallet = { cardano: EXODUS_LOOKING_ADDR };
    const result = addressForAssetId("nep141:cardano.omft.near", wallet);
    expect(result).toBe(EXODUS_LOOKING_ADDR);
  });

  it("throws IntentsValidationError when no cardano address is derived", () => {
    expect(() =>
      addressForAssetId("nep141:cardano.omft.near", { evm: "0x0".padEnd(42, "0") })
    ).toThrow(IntentsValidationError);
  });

  it("throws IntentsValidationError when cardano address is malformed", () => {
    expect(() =>
      addressForAssetId("nep141:cardano.omft.near", {
        cardano: "not-a-cardano-address",
      })
    ).toThrow(IntentsValidationError);
  });
});

describe("assertValidCardanoAddress — format validator", () => {
  it("accepts a standard CIP-19 mainnet base address (addr1…)", () => {
    expect(() => assertValidCardanoAddress(PWNDA_ADA)).not.toThrow();
  });

  it("accepts the Exodus same-key variant (still a valid addr1 base address)", () => {
    // Both Pwnda's CIP-1852 default AND Exodus same-key produce addr1
    // base addresses on mainnet. The validator only checks the format,
    // not the derivation scheme.
    expect(() => assertValidCardanoAddress(EXODUS_LOOKING_ADDR)).not.toThrow();
  });

  it("rejects testnet addresses (addr_test1…) — mainnet-only contract", () => {
    expect(() =>
      assertValidCardanoAddress(
        "addr_test1qrh78w4fa46l3w8sds2k7yxs7lph5jrsmmmnj9ka9xnq3uvfaqxd24ts08fz9wmrr7"
      )
    ).toThrow(IntentsValidationError);
  });

  it("rejects bare strings without the addr1 prefix", () => {
    expect(() => assertValidCardanoAddress("just-some-junk")).toThrow(
      IntentsValidationError
    );
    expect(() => assertValidCardanoAddress("")).toThrow(IntentsValidationError);
  });

  it("rejects an EVM hex address pasted by mistake", () => {
    expect(() =>
      assertValidCardanoAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
    ).toThrow(IntentsValidationError);
  });
});

describe("deriveWalletAddresses — picks up cardano", () => {
  it("includes cardano when walletsByChain has it", () => {
    const addrs = deriveWalletAddresses({
      cardano: { address: PWNDA_ADA },
      ethereum: { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
    });
    expect(addrs.cardano).toBe(PWNDA_ADA);
    expect(addrs.evm).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("returns cardano as undefined when the adapter isn't loaded yet", () => {
    const addrs = deriveWalletAddresses({
      ethereum: { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
    });
    expect(addrs.cardano).toBeUndefined();
  });
});

describe("deriveWalletAddresses — registry-driven (2026-05-26 convergence)", () => {
  // After the asset-capabilities registry refactor + the NEAR adapter
  // fix, `deriveWalletAddresses` derives its bundle from
  // `ASSET_CAPABILITIES` (via `walletsByChainKey`) rather than a
  // hand-maintained switch. These tests pin the new behavior so a
  // future change to the registry or the wallet-key → bundle-field
  // lookup doesn't quietly drop a field.

  it("includes near when walletsByChain has the new first-party NEAR adapter", () => {
    // Pre-2026-05-26 this asserted `near === undefined` and the
    // resolver had a `near: undefined, // no first-party NEAR adapter
    // in v1` line. After Fix 1 the morning of 2026-05-26, NEAR has a
    // TypeScript adapter (`near-wallet.ts`) and `walletsByChain.near`
    // is populated at vault-load. The registry-driven resolver now
    // surfaces that address in `bundle.near` automatically.
    const NEAR_HEX = "5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412";
    const addrs = deriveWalletAddresses({
      near: { address: NEAR_HEX },
    });
    expect(addrs.near).toBe(NEAR_HEX);
  });

  it("EVM-family assets all collapse to a single bundle.evm field", () => {
    // The registry has 6 EVM-family entries (ETH, AVAX, POL, FLR, MON,
    // BNB) — all share `walletsByChainKey: "ethereum"`. The resolver
    // populates `bundle.evm` ONCE from `walletsByChain.ethereum`.
    const EVM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const addrs = deriveWalletAddresses({
      ethereum: { address: EVM },
    });
    expect(addrs.evm).toBe(EVM);
  });

  it("does NOT include monero or zephyr (intentionally not in the bundle)", () => {
    // Monero + Zephyr have wallet adapters but the resolver doesn't
    // target them — XMR and the Zephyr ecosystem don't route through
    // NEAR Intents in v1.x. The wallet-key → bundle-field lookup
    // returns `null` for both, so the resolver skips them even when
    // the wallet store has entries.
    const addrs = deriveWalletAddresses({
      monero: { address: "4Aexample…" },
      zephyr: { address: "ZephExample…" },
      bitcoin: { address: "bc1qexample" },
    });
    expect("monero" in addrs).toBe(false);
    expect("zephyr" in addrs).toBe(false);
    // Bitcoin (which DOES route through Intents) still lands.
    expect(addrs.btc).toBe("bc1qexample");
  });

  it("populates every Intents-resolver bundle field when a full walletsByChain is given", () => {
    const wallets = {
      ethereum: { address: "0x0000000000000000000000000000000000000001" },
      bitcoin: { address: "bc1qtestbtc0" },
      litecoin: { address: "ltc1qtestltc0" },
      dogecoin: { address: "Dtestdoge000" },
      "bitcoin-cash": { address: "bitcoincash:qtestbch" },
      dash: { address: "Xtestdash00" },
      solana: { address: "Soltestsol00" },
      near: { address: "deadbeef".repeat(8) }, // 64-char hex implicit account
      stellar: { address: "Gteststellar0" },
      sui: { address: "0xtestsui" },
      cardano: { address: "addr1qtestada" },
    };
    const addrs = deriveWalletAddresses(wallets);
    expect(addrs.evm).toBe(wallets.ethereum.address);
    expect(addrs.btc).toBe(wallets.bitcoin.address);
    expect(addrs.ltc).toBe(wallets.litecoin.address);
    expect(addrs.doge).toBe(wallets.dogecoin.address);
    expect(addrs.bch).toBe(wallets["bitcoin-cash"].address);
    expect(addrs.dash).toBe(wallets.dash.address);
    expect(addrs.sol).toBe(wallets.solana.address);
    expect(addrs.near).toBe(wallets.near.address);
    expect(addrs.stellar).toBe(wallets.stellar.address);
    expect(addrs.sui).toBe(wallets.sui.address);
    expect(addrs.cardano).toBe(wallets.cardano.address);
  });

  it("a brand-new asset with a known walletsByChainKey auto-routes its address through the bundle", () => {
    // The contract that makes the convergence valuable: adding a new
    // EVM asset (say WETH on Polygon) to ASSET_CAPABILITIES with
    // `walletsByChainKey: "ethereum"` does NOT require updating
    // `deriveWalletAddresses` — the ethereum → evm mapping is
    // already in the wallet-key-to-bundle-field lookup. The new
    // asset's `addressForAssetId` call lands `bundle.evm`
    // automatically.
    //
    // Verified indirectly: every registry entry's walletsByChainKey
    // either maps to a bundle field via the lookup, maps to null
    // (intentional skip), or is undefined (e.g. NEAR pre-2026-05-26).
    // No registry entry escapes the lookup without surfacing either
    // an address or a documented null. The crucial property is:
    // bundle keys are ONLY those defined by the WalletAddresses
    // interface — never an arbitrary new key the resolver doesn't
    // understand. The TypeScript Record<keyof WalletAddresses>
    // signature of the lookup map enforces this at compile time.
    const allEvm = deriveWalletAddresses({
      ethereum: { address: "0xtest" },
    });
    expect(allEvm.evm).toBe("0xtest");
    // monero / zephyr are explicitly NOT in the bundle (the lookup
    // maps both to null). This is the structural guarantee — adding
    // a new asset whose walletsByChainKey is "monero" wouldn't
    // accidentally surface a `bundle.monero` field that the
    // resolver doesn't know how to handle.
    expect("monero" in allEvm).toBe(false);
    expect("zephyr" in allEvm).toBe(false);
    // Other Intents-resolver fields are present with undefined
    // values (consistent with pre-2026-05-26 behavior — the
    // resolver throws an actionable IntentsValidationError when it
    // hits an undefined field, rather than a confusing key-missing
    // crash).
    expect("btc" in allEvm).toBe(true);
    expect(allEvm.btc).toBeUndefined();
  });
});

describe("intents-dedup — Cardano native-chain mapping", () => {
  it("defaultBlockchainFor('ADA') returns 'cardano' (destination side)", () => {
    expect(defaultBlockchainFor("ADA")).toBe("cardano");
  });

  it("defaultBlockchainFor('ADA', { sourceOnly: true }) returns 'cardano' (TS source signer)", () => {
    expect(defaultBlockchainFor("ADA", { sourceOnly: true })).toBe("cardano");
  });

  it("has exactly one NEAR_INTENTS_ASSETS row for ADA on cardano", () => {
    const adaRows = NEAR_INTENTS_ASSETS.filter((a) => a.symbol === "ADA");
    expect(adaRows.length).toBe(1);
    expect(adaRows[0].assetId).toBe("nep141:cardano.omft.near");
    expect(adaRows[0].blockchain).toBe("cardano");
    expect(adaRows[0].decimals).toBe(6);
  });
});
