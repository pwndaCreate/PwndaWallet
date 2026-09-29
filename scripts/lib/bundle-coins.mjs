// Which coins ship, and which files each one contributes.
//
// SPLIT OUT OF bundle-binaries.mjs 2026-09-12, and the reason is mechanical
// rather than aesthetic: bundle-binaries.mjs opens with `#!/usr/bin/env node`,
// and Vite's SSR transform hoists import statements above it, leaving the
// shebang stranded mid-file where `#` is not a valid token:
//
//     const __vite_ssr_import_0__ = await __vite_ssr_import__("node:fs", ...);#!/usr/bin/env node
//                                                                             ^
//     SyntaxError: Invalid or unexpected token
//
// So ANY vitest test importing that file fails to load. bundleDefaultCoins.test
// did exactly that, and had been passing only off a stale transform in
// node_modules/.vite -- clearing that cache surfaced a break that was already
// there. A test that passes only while a cache is warm is not protecting
// anything.
//
// These are the pure declarations: no I/O, no argv, no shebang. Both the
// bundler and the tests import them from here, so the contract has one home.

export const COIN_BINARIES = {
  particl: ["particld", "particl-cli", "particl-tx", "particl-wallet"],
  bitcoin: ["bitcoind", "bitcoin-cli", "bitcoin-tx", "bitcoin-wallet"],
  litecoin: ["litecoind", "litecoin-cli", "litecoin-tx", "litecoin-wallet"],
  bitcoincash: ["bitcoind", "bitcoin-cli", "bitcoin-tx", "bitcoin-wallet"],
  monero: ["monerod", "monero-wallet-rpc"],
  // PWNDA 2026-09-04: zephyr. Same daemon+wallet-rpc pair shape as monero
  // (Zephyr is a Monero fork). Get-SwapCoinBinaries.ps1 stages exactly these
  // two out of the release archive -- deliberately not zephyr-wallet-cli,
  // which nothing uses and which would otherwise be encrypted into every
  // installer.
  zephyr: ["zephyrd", "zephyr-wallet-rpc"],
  // PWNDA 2026-09-04: dogecoin + dash. Both were STAGED and GPG-verified by
  // Get-SwapCoinBinaries.ps1 and present in every dev tree (7 exes each), and
  // both were missing from BUNDLED_COINS with no comment saying so -- so they
  // worked on the operator's machine and would have been absent from every
  // shipped installer. Exactly the zephyr defect this file's own guard was
  // written for, twice more, undetected because that guard compared this file
  // against itself. Same four-binary shape as bitcoin; -qt, -util and test_*
  // are deliberately excluded (unused, and -qt alone is ~30 MB per coin).
  dogecoin: ["dogecoind", "dogecoin-cli", "dogecoin-tx", "dogecoin-wallet"],
  dash: ["dashd", "dash-cli", "dash-tx", "dash-wallet"],
  // PWNDA 2026-09-04: zano, unit A5. NOT a stock download -- the swap engine's
  // scratch wallet needs `generate_from_keys`, which upstream Zano does not
  // have, so this is the locally BUILT patched binary from
  // scripts/swap/zano-build/ (hyle-team/zano @ ee3de1e5 + the vendored patch).
  // Verified patched, not stock, by string-probing the built binary against the
  // stock one we already ship: generate_from_keys FOUND vs absent, with
  // getbalance present in both as the control proving the probe discriminates.
  // The two OpenSSL DLLs are listed because the build is STATIC=FALSE.
  zano: [
    "zanod",
    "simplewallet",
    "libcrypto-3-x64.dll",
    "libssl-3-x64.dll",
  ],
};

/**
 * Per-TARGET overrides of a coin's binary list, for a coin that ships a
 * different file set on different platforms. Anything not listed falls through
 * to `COIN_BINARIES` unchanged.
 *
 * zano on linux (2026-09-11): the Linux arm of the same patched build is STATIC
 * (`-D STATIC=TRUE` in scripts/swap/zano-build/build-zano-linux.sh, REU26's
 * proven recipe), so there is no OpenSSL runtime to ship beside it. The two
 * DLLs in the Windows list exist because THAT build is STATIC=FALSE. Demanding
 * them on Linux fails the build on a file that is not supposed to exist;
 * silently appending them would ship Windows DLLs to Linux users.
 */
export const PLATFORM_COIN_BINARIES = {
  linux: {
    zano: ["zanod", "simplewallet"],
  },
};

/**
 * `COIN_BINARIES` with `target`'s overrides applied — the list this bundler
 * will actually demand. Exported so `assemble-linux-grove.mjs` stages exactly
 * that, rather than a copy of it.
 */
export function coinBinariesFor(target) {
  const over = PLATFORM_COIN_BINARIES[target] ?? {};
  return Object.fromEntries(
    Object.entries(COIN_BINARIES).map(([coin, files]) => [coin, over[coin] ?? files]),
  );
}

/**
 * Engine coins that are KNOWINGLY not bundled, with the reason.
 *
 * Being in this map is a decision; being in neither this map nor
 * BUNDLED_COINS is an accident, and the guard below is what tells them apart.
 */
export const NOT_BUNDLED = {
  // (empty) Every coin the engine can run is bundled as of 2026-09-04, when
  // unit A5's patched Zano wallet was finally built. Keep the map: an entry
  // here is a DECLARED omission with a reason, which is what the guard below
  // distinguishes from an accidental one.
};

/**
 * Coins a given PLATFORM cannot ship, with the reason. Same contract as
 * `NOT_BUNDLED` — a declaration is a decision, silence is a bug — but scoped
 * to the target rather than to the product.
 *
 * # Why this had to exist (2026-09-06)
 *
 * `assemble-linux-grove.mjs` carried its own copy of `COIN_BINARIES` with a
 * comment saying it was "kept in sync by inspection". It was not: the bundler
 * gained zephyr, dogecoin, dash and zano on 2026-09-04 and the assembler kept
 * its five, so a Linux release staged 5 coins, the bundler demanded 9, and the
 * build died on the first one it could not find:
 *
 *     [assemble-linux-grove] all 5 coins present as Linux binaries
 *     [bundle] grove source missing: linux-grove/bin/zephyr/zephyrd
 *
 * That is the THIRD time this file's own lists have drifted from a sibling —
 * after the zephyr defect the v1 guard was written for and the dogecoin/dash
 * pair that v2 caught. The pattern is always the same: one fact in two places,
 * synchronised by a comment. So the assembler now IMPORTS these tables (the
 * reason it did not was "that script has no exports", which this commit
 * removes), and the platform's own gaps are declared here where the guard can
 * see them.
 *
 * # A declared gap must never cover a DEFAULT-ENABLED coin (2026-09-11)
 *
 * Until 2026-09-11 this table also exempted zephyr and zano on linux — and
 * both are in `DEFAULT_ENABLED_COINS` (swap_sidecar.rs). The supervisor drops
 * any enabled coin whose `bin/<coin>/` is empty (`seedable_coins`) and refuses
 * the toggle with "no daemon binary is seeded", so a Linux install came up
 * without either coin, silently, while Windows had both on by default. The
 * release log said so in one line — "(not on linux: zephyr, dogecoin, dash,
 * zano)" — and it took the operator reading that line to notice. The Linux
 * zephyr pair is the same pinned zip `Get-SwapCoinBinaries.ps1` already knew
 * (`-Platform linux-x64`); the Linux zano is the Linux arm of the same patched
 * build the Windows bundle ships (scripts/swap/zano-build/, static — see
 * `PLATFORM_COIN_BINARIES`). `scripts/bundleDefaultCoins.test.mjs` now refuses
 * an exemption that names a default-enabled coin, on any target.
 *
 * dogecoin / dash remain absent from `.swap-sidecar-work/linux-stage/cores`
 * (a hand-staged tree, per swap-runtime.json's "Staged, not assembled" note).
 * Neither is default-enabled — no lean mode, so enabling one is an explicit
 * multi-GB opt-in — which is why that gap costs a Linux user an opt-in and
 * not a default, and why it is still a declaration rather than a defect.
 */
export const NOT_BUNDLED_FOR = {
  linux: {
    dogecoin:
      "no Linux binaries staged in .swap-sidecar-work/linux-stage/cores (not default-enabled; " +
      "Get-SwapCoinBinaries.ps1 carries win64 GPG pins only)",
    dash:
      "no Linux binaries staged in .swap-sidecar-work/linux-stage/cores (not default-enabled; " +
      "Get-SwapCoinBinaries.ps1 carries win64 GPG pins only)",
  },
};

/**
 * The coins a target actually ships. Exported so
 * `assemble-linux-grove.mjs` stages exactly this set instead of mirroring it.
 */
export function bundledCoinsFor(target) {
  const skip = NOT_BUNDLED_FOR[target] ?? {};
  return BUNDLED_COINS.filter((c) => !skip[c]);
}

export const BUNDLED_COINS = [
  "particl",
  "bitcoin",
  "litecoin",
  "bitcoincash",
  "monero",
  "zephyr",
  "dogecoin",
  "dash",
  "zano",
];
