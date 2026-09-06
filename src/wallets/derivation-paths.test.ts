/**
 * Path-string locks per chain. Every chain's derivation path is asserted
 * here as a literal string so a future contributor can't accidentally
 * change it without updating this file. Cross-wallet compatibility is
 * load-bearing — these tests are the contract.
 *
 * Industry-standard references per row:
 *   - BTC m/84'/0'/0'/0/0 — BIP-84 spec, Exodus/Trezor/Ledger/Sparrow/Electrum
 *   - LTC m/84'/2'/0'/0/0 — BIP-84 with SLIP-44 coin type 2, Electrum
 *   - DOGE m/44'/3'/0'/0/0 — BIP-44 with SLIP-44 coin type 3, Exodus/Dogecoin Core
 *   - BCH m/44'/145'/0'/0/0 — BIP-44 with SLIP-44 coin type 145, Electron Cash
 *   - ETH/EVM m/44'/60'/0'/0/0 — BIP-44 with SLIP-44 coin type 60, MetaMask
 *   - SOL m/44'/501'/0'/0' — Phantom/Solflare/Trezor/Ledger Live convention
 *   - NEAR m/44'/397'/0' — NEAR CLI convention (3 hardened steps, ed25519)
 *   - XLM m/44'/148'/0' — SEP-0005 spec, all hardened (ed25519 SLIP-0010)
 *   - XRP m/44'/144'/0'/0/0 — BIP-44 with SLIP-44 coin type 144, XUMM
 *   - HBAR m/44'/3030'/0'/0/0 — BIP-44 with SLIP-44 coin type 3030, HashPack
 *   - RVN m/44'/175'/0'/0/0 — BIP-44 with SLIP-44 coin type 175, Ravencoin
 *   - CFX m/44'/503'/0'/0/0 — BIP-44 with SLIP-44 coin type 503, Conflux
 *   - ADA m/1852'/1815'/0'/0/0 + m/1852'/1815'/0'/2/0 — CIP-1852, Yoroi/Eternl/Daedalus
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_CAPABILITIES } from "../features/swap/asset-capabilities";

// The repo root, derived from THIS FILE's own location rather than typed in.
//
// Until 2026-08-12 this was resolve("G:/PwndaWalletDevelopment", rel) - an absolute Windows path
// with a drive letter. It works on exactly one machine. Anywhere else (a second dev box, CI, a
// Linux checkout, or the same repo cloned to a different drive) every assertion below fails with
// ENOENT, and the failure names a missing file rather than a wrong path - so it reads as "the
// wallet source is
// gone", not "the test cannot find it".
//
// That matters more here than in most tests. This file IS the cross-wallet derivation contract: it
// is the thing that stops a derivation path changing unnoticed. A contract test that cannot run
// off one machine is not enforcing the contract anywhere else, and it fails LOUDLY enough to be
// dismissed as environmental - which is how it stays broken.
//
// __dirname is not defined in an ESM test module, hence fileURLToPath(import.meta.url). This file
// lives at src/wallets/, so the root is two levels up; if it ever moves, adjust the "../.." rather
// than reintroducing an absolute path.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fileContent(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

describe("Derivation path locks — every chain pinned to industry standard", () => {
  it("BTC uses BIP-84 mainnet (m/84'/0'/0'/0/0)", () => {
    const f = fileContent("src/wallets/btc-wallet.ts");
    expect(f).toContain('const DERIVATION_PATH = "m/84\'/0\'/0\'/0/0"');
    // Legacy path also pinned for the sweep panel — both locked to
    // catch anyone "fixing" the legacy entry which would break the
    // BtcLegacyPanel migration UX.
    expect(f).toContain('const LEGACY_DERIVATION_PATH = "m/44\'/0\'/0\'/0/0"');
  });

  it("LTC uses BIP-84 with SLIP-44 coin type 2 (m/84'/2'/0'/0/0)", () => {
    const f = fileContent("src/wallets/ltc-wallet.ts");
    expect(f).toContain('const DERIVATION_PATH = "m/84\'/2\'/0\'/0/0"');
  });

  it("DOGE uses BIP-44 with SLIP-44 coin type 3 (m/44'/3'/0'/0/0)", () => {
    const f = fileContent("src/wallets/doge-wallet.ts");
    expect(f).toContain('const DERIVATION_PATH = "m/44\'/3\'/0\'/0/0"');
  });

  it("BCH uses BIP-44 with SLIP-44 coin type 145 (m/44'/145'/0'/0/0)", () => {
    const f = fileContent("src/wallets/bch-wallet.ts");
    expect(f).toContain('const DERIVATION_PATH = "m/44\'/145\'/0\'/0/0"');
  });

  it("RVN uses BIP-44 with SLIP-44 coin type 175 (m/44'/175'/0'/0/0)", () => {
    const f = fileContent("src/wallets/rvn-wallet.ts");
    expect(f).toContain("const DERIVATION_PATH = \"m/44'/175'/0'/0/0\"");
  });

  it("XRP uses BIP-44 with SLIP-44 coin type 144 (m/44'/144'/0'/0/0)", () => {
    const f = fileContent("src/wallets/xrp-wallet.ts");
    expect(f).toContain('const DERIVATION_PATH = "m/44\'/144\'/0\'/0/0"');
  });

  it("HBAR uses BIP-44 with SLIP-44 coin type 3030 (m/44'/3030'/0'/0/0)", () => {
    const f = fileContent("src/wallets/hbar-wallet.ts");
    expect(f).toContain('const DERIVATION_PATH = "m/44\'/3030\'/0\'/0/0"');
  });

  it("CFX uses BIP-44 with SLIP-44 coin type 503 (m/44'/503'/0'/0/0)", () => {
    const f = fileContent("src/wallets/cfx-wallet.ts");
    expect(f).toContain('const DERIVATION_PATH = "m/44\'/503\'/0\'/0/0"');
  });

  it("ERG uses EIP-3 path with SLIP-44 coin type 429 (m/44'/429'/0'/0/0)", () => {
    // Ergo's coin type 429 = ascii("ergo") = 101+114+103+111. EIP-3
    // forbids change-chain (only external chain /0/*). Matches Nautilus /
    // SAFEW / Yoroi byte-for-byte. The Ergo node wallet and old mobile
    // wallets have a BIP-32 bug (BigInteger 31-byte serialization) so
    // they sometimes derive different addresses for the same mnemonic;
    // Pwnda follows the spec-compliant Nautilus group via @scure/bip32.
    // See PwndaWalletVault/wiki/entities/Ergo.md §"Critical: the
    // ecosystem derivation split".
    const f = fileContent("src/wallets/erg-wallet.ts");
    expect(f).toContain('const DERIVATION_PATH = "m/44\'/429\'/0\'/0/0"');
  });

  it("SOL uses the Phantom path (m/44'/501'/0'/0')", () => {
    const f = fileContent("src/wallets/sol-wallet.ts");
    expect(f).toContain('const DERIVATION_PATH = "m/44\'/501\'/0\'/0\'"');
  });

  it("XLM uses SEP-0005 standard (m/44'/148'/0', all hardened ed25519)", () => {
    // Phase 4 (2026-06-27): research confirmed Exodus also uses this exact
    // SEP-0005 path — XLM has NO Exodus divergence. A non-hardened ed25519
    // tail (the old assumed "5-step" Exodus path) is invalid under SLIP-0010.
    const f = fileContent("src/wallets/stellar-wallet.ts");
    expect(f).toContain('const DERIVATION_PATH = "m/44\'/148\'/0\'"');
  });

  it("ADA uses CIP-1852 with payment role 0 + stake role 2", () => {
    const f = fileContent("src/wallets/cardano-cip1852.ts");
    // Constants are derived not as literal strings; assert the path
    // shape matches CIP-1852's purpose=1852, coin_type=1815, account=0,
    // payment_role=0, stake_role=2.
    expect(f).toContain("const PURPOSE = 1852 + 0x80000000;");
    expect(f).toContain("const COIN_TYPE = 1815 + 0x80000000;");
    expect(f).toContain("const ACCOUNT_0 = 0 + 0x80000000;");
    expect(f).toContain("const ROLE_PAYMENT = 0;");
    expect(f).toContain("const ROLE_STAKE = 2;");
  });

  it("EVM family uses MetaMask standard (m/44'/60'/0'/0/0)", () => {
    // EVM derivation goes through `ethers.Wallet.fromPhrase` which
    // uses the BIP-44 m/44'/60'/0'/0/0 path by default. ethers v6 docs
    // commit to this path; we additionally verify the Rust-side path
    // string in derive.rs.
    const f = fileContent("src-tauri/src/swap/derive.rs");
    expect(f).toContain('"m/44\'/60\'/{account}\'/0/{index}"');
  });

  it("NEAR uses 3-step hardened path (m/44'/397'/0')", () => {
    const f = fileContent("src-tauri/src/swap/near.rs");
    // The NEAR derivation uses 3 hardened steps: 44', 397', 0'.
    expect(f).toContain("// m/44'/397'/0' — three hardened steps.");
  });
});

describe("Cross-wallet test vectors — abandon mnemonic must match published standards", () => {
  // These are the published industry-standard test vectors for the
  // canonical BIP-39 zero-vector mnemonic
  // ("abandon abandon abandon abandon abandon abandon abandon abandon
  //   abandon abandon abandon about").
  //
  // If any of these drifts, the wallet's derivation has gone non-standard
  // and seeds imported from any popular wallet will produce different
  // addresses than the user expects.

  it("BTC at m/84'/0'/0'/0/0 produces the BIP-84 spec test vector", async () => {
    // From BIP-84 spec test vectors — first receive address.
    // https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki
    const { btcAdapter } = await import("./btc-wallet");
    const address = btcAdapter.deriveFromMnemonic(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    ).address;
    expect(address).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  it("ETH at m/44'/60'/0'/0/0 produces the Hardhat dev vector", async () => {
    // Every EVM wallet (MetaMask, Trust, Phantom, Hardhat, ethers,
    // viem, web3.js) agrees on this address for the standard mnemonic.
    // We pin the Hardhat test mnemonic instead of "abandon …" because
    // it's even more universally referenced and our Rust test vector
    // already locks it.
    const { ethAdapter } = await import("./eth-wallet");
    const HARDHAT =
      "test test test test test test test test test test test junk";
    const address = ethAdapter.deriveFromMnemonic(HARDHAT).address;
    expect(address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("ERG at m/44'/429'/0'/0/0 derives the canonical abandon vector", async () => {
    // Canonical BIP-39 zero-vector mnemonic.
    //   `abandon × 11 + about` is the universally cross-checked test
    //   phrase. Every spec-compliant wallet (Nautilus / SAFEW / Yoroi /
    //   Fleet / @scure/bip32) produces this exact address from it. If
    //   the user imports the same mnemonic into Nautilus and sees a
    //   different address, Pwnda's derivation has drifted off-spec.
    //
    // Address derived by `node scripts/compute-ergo-fixtures.mjs` against
    // @scure/bip32 + @fleet-sdk/core@0.12.0. Cross-validated against the
    // Nautilus path (Fleet SDK ⇄ sigma-rust ⇄ Nautilus all use the same
    // BIP-32 + Sigma curve implementation).
    const { ergoAdapter } = await import("./erg-wallet");
    const ABANDON =
      "abandon abandon abandon abandon abandon abandon " +
      "abandon abandon abandon abandon abandon about";
    const address = ergoAdapter.deriveFromMnemonic(ABANDON).address;
    expect(address).toBe("9fv2n41gttbUx8oqqhexi68qPfoETFPxnLEEbTfaTk4SmY2knYC");
  });

  it("ERG resists the Ergo-node BIP-32 BigInteger bug from issue #1627", async () => {
    // The Ergo node wallet (and old mobile wallets) have a BIP-32
    // BigIntegers.asUnsignedByteArray bug: hardened intermediate keys
    // that serialize to 31 bytes skip zero-padding to 32, producing a
    // different subtree. Nautilus / SAFEW / Yoroi / Fleet / @scure/bip32
    // do this correctly.
    //
    // This 15-word vector specifically triggers the bug: hardening at
    // m/44'/429' produces a child private scalar that — when serialized
    // by the buggy code path — drops to 31 bytes. The expected address
    // below is the SPEC-COMPLIANT result (what Nautilus / Pwnda derive).
    // If a future Fleet SDK regression flipped to the buggy
    // implementation, this assertion would fail before any user mined
    // to an address they don't control.
    //
    // See PwndaWalletVault/wiki/entities/Ergo.md §"Critical: the
    // ecosystem derivation split" and
    // https://github.com/ergoplatform/ergo/issues/1627.
    const { ergoAdapter } = await import("./erg-wallet");
    const BUG_TRIGGER =
      "race relax argue hair sorry riot there spirit ready " +
      "fetch food hedgehog hybrid mobile pretty";
    const address = ergoAdapter.deriveFromMnemonic(BUG_TRIGGER).address;
    expect(address).toBe("9eYMpbGgBf42bCcnB2nG3wQdqPzpCCw5eB1YaWUUen9uCaW3wwm");
  });

  it("XLM at m/44'/148'/0' produces the SEP-0005 Test 5 vector", async () => {
    // SEP-0005 Test 5 — the canonical Stellar derivation vector for the
    // abandon×11+about mnemonic. Exodus follows SEP-0005 (coin-type 148'),
    // so this SAME address appears when an Exodus seed is restored — i.e.
    // XLM has NO Exodus divergence (Phase 4 finding, 2026-06-27). This is
    // the one funds-grade seed→address vector the Phase 4 research surfaced.
    // https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
    const { stellarAdapter } = await import("./stellar-wallet");
    const ABANDON =
      "abandon abandon abandon abandon abandon abandon " +
      "abandon abandon abandon abandon abandon about";
    const address = stellarAdapter.deriveFromMnemonic(ABANDON).address;
    expect(address).toBe("GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX");
  });
});

describe("Multi-path scan-list completeness — historical paths must remain in scope", () => {
  // Each test below asserts that the scan list (as defined in
  // derivation-detector.ts BTC_SPECS / SOL_SPECS / detectAda) still
  // includes every path PwndaWallet has used at any historical point.
  // We assert via file-content reads to avoid the network probes
  // detectBtc / detectSol perform — those are integration-only.
  const detector = fileContent("src/features/onboarding/derivation-detector.ts");

  it("BTC scan list includes BIP-84 + BIP-49 + BIP-44 + pwnda-legacy", () => {
    expect(detector).toContain('id: "bip84"'); // current default
    expect(detector).toContain('id: "bip49"'); // older Electrum / BlueWallet
    expect(detector).toContain('id: "bip44"'); // legacy P2PKH
    // The Pwnda-specific historical path that produced bc1qmpnlgu9...
    // for the canonical user. LOAD-BEARING — removing this entry
    // permanently strands existing-user funds at the legacy address.
    expect(detector).toContain('id: "pwnda-legacy"');
  });

  it("SOL scan list covers Phantom + CLI + Sollet conventions", () => {
    expect(detector).toContain('id: "phantom"'); // Phantom / Solflare / Ledger / Trezor
    expect(detector).toContain('id: "cli"'); // Solana CLI / some Exodus
    expect(detector).toContain('id: "sollet"'); // Sollet legacy / older Solflare (raw seed)
  });

  it("ADA scan list includes the legacy enterprise derivation", () => {
    expect(detector).toContain('id: "cip1852"'); // standard base address (addr1q…)
    // The pwnda-legacy ID is reused across BTC + ADA — verify the ADA
    // detector specifically references the legacy enterprise derivation.
    expect(detector).toContain("deriveLegacyAdaFromMnemonic");
    expect(detector).toContain('id: "pwnda-legacy"');
  });

  it("ADA brute-force probe covers account 0..5 + index 0..10 + legacy", () => {
    // Multi-account variants moved out of the default panel and into
    // the brute-force `bruteForceFindCardano` probe (no auto-display).
    // The probe MUST cover account/index ranges that historically
    // catch multi-account flows from Exodus / Atomic / Trust.
    expect(detector).toContain("bruteForceFindCardano");
    expect(detector).toContain("for (let account = 0; account <= 5; account++)");
    expect(detector).toContain("for (let index = 0; index <= 10; index++)");
    // Legacy enterprise must also remain reachable through the probe
    // — pre-fix users with funds at the `addr1v…` address depend on
    // this branch.
    expect(detector).toContain("deriveLegacyAdaFromMnemonic");
  });

  it("SOL brute-force probe covers Phantom 4-step + CLI 3-step + Sollet raw seed", () => {
    expect(detector).toContain("bruteForceFindSolana");
    // Phantom 4-step: m/44'/501'/account'/index' for a∈0..5 i∈0..5 (36 candidates)
    expect(detector).toMatch(
      /Phantom-style 4-step hardened paths[\s\S]*?for \(let account = 0; account <= 5/
    );
    // CLI 3-step: m/44'/501'/account' for a∈0..5
    expect(detector).toMatch(/CLI-style 3-step paths[\s\S]*?for \(let account = 0; account <= 5/);
    // Sollet raw seed[0..32] keypair (no BIP-32 walk)
    expect(detector).toContain("seed.slice(0, 32)");
  });

  it("SOL brute-force probe covers Exodus secp256k1→ed25519 path", () => {
    // Exodus's documented SOL path m/44'/501'/0'/0/0 has unhardened
    // last two steps — incompatible with strict SLIP-10 ed25519. The
    // actual implementation walks the literal path on secp256k1 BIP-32
    // (which supports non-hardened) and uses the 32B priv directly as
    // the ed25519 seed. See HeptaSean research for cross-chain pattern.
    expect(detector).toContain("Exodus Solana");
    expect(detector).toContain("secp256k1 BIP-32 walk at the literal");
    // Fold variant fallback
    expect(detector).toContain("variant 1a");
  });

  it("ADA brute-force probe covers Exodus secp256k1+Byron-Legacy path", () => {
    // Exodus's actual Cardano scheme is the HeptaSean-RE'd hybrid:
    // secp256k1 BIP-32 walk → Byron-Legacy hashRepeatedly → Ed25519
    // scalar mult → Shelley base address with same hash twice. Both
    // same-key (canonical) and split-stake (post-2025 Exodus) variants
    // MUST be in the probe.
    expect(detector).toContain("deriveExodusCardanoKeySet");
    expect(detector).toContain("deriveExodusCardanoKeySetSplitStake");
    expect(detector).toContain("HeptaSean");
  });

  it("BTC pwnda-legacy spec uses BIP-44 path with P2WPKH encoding (the broken combo)", () => {
    // The bug we are protecting against: someone "fixing" the legacy
    // entry to use the matching encoding (P2PKH for BIP-44) would silently
    // re-derive a different address and strand pre-fix users' funds. The
    // legacy entry MUST keep the historical non-standard combination.
    expect(detector).toMatch(
      /id:\s*"pwnda-legacy"[\s\S]*?path:\s*"m\/44'\/0'\/0'\/0\/0"[\s\S]*?encoding:\s*"p2wpkh"/
    );
  });
});

describe("UTXO source-tx signer dispatch — every UtxoChain wired (2026-05-08)", () => {
  it("PWNDA_INTENTS_SOURCE_TICKERS includes DOGE + BCH after Phase 1+2", () => {
    // Regression lock: the BCH+DOGE source integration plan promotes
    // both chains from destination-only to fully source-capable. This
    // test pins the dropdown's source allowlist so a future revert
    // would be caught before reaching users.
    const swapData = fileContent("src/features/swap/swap-data.ts");
    expect(swapData).toMatch(
      /PWNDA_INTENTS_SOURCE_TICKERS[\s\S]*?\[[\s\S]*?"DOGE"[\s\S]*?\]/
    );
    expect(swapData).toMatch(
      /PWNDA_INTENTS_SOURCE_TICKERS[\s\S]*?\[[\s\S]*?"BCH"[\s\S]*?\]/
    );
  });

  it("SOURCE_CAPABLE_BLOCKCHAINS includes 'doge' and 'bch'", () => {
    // Moved 2026-08-19 out of `near-intents-assets.generated.ts` into the
    // hand-owned `intents-source-capability.ts`. It encodes WALLET signing
    // capability, which no upstream feed knows, so living in a regenerable
    // file meant a routine sync could silently drop it — which is exactly what
    // happened. Asserting against the generated file would now pass vacuously
    // (the set is not there at all), so this reads the real owner.
    const capability = fileContent(
      "src/features/swap/intents-source-capability.ts"
    );
    expect(capability).toMatch(
      /SOURCE_CAPABLE_BLOCKCHAINS[\s\S]*?"doge"[\s\S]*?"bch"/
    );
    // The generated file must NOT re-acquire it — that regression is the whole
    // point of the split.
    const generated = fileContent(
      "src/features/swap/near-intents-assets.generated.ts"
    );
    expect(generated).not.toMatch(
      /export const SOURCE_CAPABLE_BLOCKCHAINS/
    );
  });

  it("ASSET_CAPABILITIES.DOGE and .BCH have signerInRustCore: true", () => {
    // Original test (pre-2026-05-25) grepped `swap-data.ts` for the
    // literal `sourceCapable: true` substring inside the DOGE/BCH
    // blocks. After the asset-capabilities registry refactor those
    // entries moved to `asset-capabilities.ts` and the legacy
    // `sourceCapable` field was renamed `signerInRustCore`. Reading
    // the registry directly is more robust than string-matching the
    // source file anyway.
    expect(ASSET_CAPABILITIES.DOGE.signerInRustCore).toBe(true);
    expect(ASSET_CAPABILITIES.BCH.signerInRustCore).toBe(true);
  });

  it("Rust swap_sign_psbt dispatches all four UtxoChain variants", () => {
    // Pin the Rust signer's chain dispatch. Removing any branch would
    // silently fall through to a default that doesn't sign — the
    // resulting tx would be rejected at broadcast with no clear
    // diagnostic. This test surfaces the regression at CI time.
    const btcRs = fileContent("src-tauri/src/swap/btc.rs");
    expect(btcRs).toContain("UtxoChain::Btc | UtxoChain::Ltc =>");
    // Phase 5 (2026-05-08): Dash dispatches to the same legacy P2PKH
    // path as DOGE — the match arm now reads `Doge | Dash`. Both
    // branches must be present so a future regression that silently
    // drops one is caught.
    expect(btcRs).toContain("UtxoChain::Doge");
    expect(btcRs).toContain("UtxoChain::Dash");
    expect(btcRs).toContain("UtxoChain::Bch =>");
    expect(btcRs).toContain("fn sign_input_p2wpkh");
    expect(btcRs).toContain("fn sign_input_p2pkh_legacy");
    expect(btcRs).toContain("fn sign_input_p2pkh_forkid");
    expect(btcRs).toContain("fn bch_forkid_preimage");
  });

  it("BCH FORKID preimage uses fork id 0 + sighash byte 0x41", () => {
    // BCH mainnet uses fork id 0 and SIGHASH_ALL (0x01) | SIGHASH_FORKID
    // (0x40) = 0x41. These are spec constants — changing either would
    // break every BCH source-tx signature against post-fork validators.
    const btcRs = fileContent("src-tauri/src/swap/btc.rs");
    expect(btcRs).toContain("BCH_SIGHASH_TYPE: u32 = 0x41");
    expect(btcRs).toContain("BCH_FORK_ID: u32 = 0");
  });

  it("swap-sources legacy UTXO path covers DOGE + BCH branches", () => {
    const swapSources = fileContent("src/features/swap/swap-sources.ts");
    expect(swapSources).toContain("executeLegacyUtxoTransfer");
    expect(swapSources).toContain("fetchDogeUtxos");
    expect(swapSources).toContain("fetchDogePrevTx");
    expect(swapSources).toContain("broadcastDogeRawTx");
    expect(swapSources).toContain("fetchBchUtxos");
    expect(swapSources).toContain("fetchBchPrevTx");
    expect(swapSources).toContain("broadcastBchRawTx");
    expect(swapSources).toContain("bchAddressToScript");
    // Legacy P2PKH PSBT inputs use nonWitnessUtxo (full prev tx),
    // not witnessUtxo. Removing this would break legacy signing
    // because the verifier needs the prev-out value.
    expect(swapSources).toMatch(/nonWitnessUtxo:\s*Buffer\.from\(prevHex/);
  });
});
