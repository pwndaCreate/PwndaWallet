// One-off helper to compute the expected Ergo addresses for the two
// fixture-locked derivation-test mnemonics. Run once; paste the printed
// addresses into `src/wallets/derivation-paths.test.ts` to convert the
// `.todo` cases into real assertions. After conversion, this script's
// only future purpose is re-deriving the values if Fleet SDK is bumped.
//
//   node scripts/compute-ergo-fixtures.mjs
//
// Cross-validate the printed addresses against Nautilus / SAFEW (import
// each mnemonic into one of those wallets and confirm the address
// matches byte-for-byte). They MUST match — Fleet uses sigma-rust and
// Nautilus / SAFEW / Yoroi are all in the spec-compliant BIP-32 group.

import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { ErgoAddress } from "@fleet-sdk/core";

const DERIVATION_PATH = "m/44'/429'/0'/0/0";

const FIXTURES = [
  {
    label: "abandon × 11 + about (canonical BIP-39 test vector)",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  },
  {
    label: "issue #1627 BIP-32 31-byte bug-trigger (Nautilus side)",
    mnemonic:
      "race relax argue hair sorry riot there spirit ready fetch food hedgehog hybrid mobile pretty",
  },
];

for (const f of FIXTURES) {
  const seed = mnemonicToSeedSync(f.mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(DERIVATION_PATH);
  if (!child.publicKey) {
    console.error(`[fixture] no public key for ${f.label}`);
    process.exit(1);
  }
  const address = ErgoAddress.fromPublicKey(child.publicKey).encode();
  console.log(`${f.label}`);
  console.log(`  mnemonic: ${f.mnemonic}`);
  console.log(`  address:  ${address}`);
  console.log(`  privHex:  ${Buffer.from(child.privateKey).toString("hex")}`);
  console.log();
}
