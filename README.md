# PwndaWallet

A desktop multi-chain wallet with built-in mining and peer-to-peer atomic swaps.
Windows first; Linux bundles are produced by the same release pipeline.

**The BasicSwap engine ships inside the installer, bundled and supervised by the wallet,
with no second program and no account.** The peer-to-peer atomic-swap engine runs inside
the app rather than beside it, so there is no Docker and nothing else to install: you take
an offer from the Swap tab and the engine trades from your own wallet's accounts.

**Status.** In production since 2026: six signed releases (v0.6.0 to v0.6.5) and an in-app
updater.

- **Wallet.** One seed, many chains (Bitcoin, Litecoin, Bitcoin Cash, Ethereum and
  EVM networks, Solana, Cardano, Monero, Zephyr, Zano and more). Keys never leave the
  machine; the vault is PBKDF2 + AES-GCM.
- **Swap.** Three routes behind one form: an aggregator route (NEAR Intents), a
  peer-to-peer route (**Pwnda Grove**, a bundled BasicSwap engine with no
  counterparty but the other user, no custody, and refund by timelock), and
  the in-protocol Zephyr swaps.
- **Mine.** XMRig, SRBMiner and lolMiner managed in-app, with a mining-only sibling
  build (**PwndaLite**).

Built on Tauri 2 (Rust) + React 19 + Vite 6 + TypeScript.

## Install

Download the installer for your platform from the
[Releases](https://github.com/pwndaCreate/PwndaWallet/releases) page. The
installer carries everything the swap engine needs; nothing is downloaded at first run
unless you opt into a coin whose chain daemon is not bundled.

## Build from source

Prerequisites: Node 20+, Rust stable, and on Windows the MSVC build tools.

```bash
npm install
npm run check-types      # TypeScript
npm run test             # Vitest
npm run tauri:build      # production installer (runs the bundle checks first)
```

For the Rust side:

```bash
cd src-tauri && cargo test --lib
```

A fresh clone needs two things first. `tauri-build` refuses a `binaries/*` bundle resource that
matches nothing, and the release pipeline is what fills `src-tauri/binaries/`, so an empty
placeholder file there is enough for `cargo test`. And two tests read the pinned BasicSwap source,
which lives in `upstream/basicswap/` (the pin is in `scripts/fetch-swap-runtime.mjs`).
`.github/workflows/ci.yml` shows both steps.

`npm run tauri dev` starts the app against a local dev swap node. The swap engine
runtime is assembled under `.swap-sidecar-work/` by `scripts/fetch-swap-runtime.mjs`
and patched by `scripts/apply-engine-patches.mjs`; see
`PwndaWalletVault/wiki/synthesis/pwnda-grove.md` for the whole picture.

## Releases

`scripts/release-local.ps1 vX.Y.Z` builds the Windows MSI natively, the Linux bundles
in Docker, and uploads both as a GitHub Release. The runbook is
`PwndaWalletVault/wiki/synthesis/release-build-guide.md`.

## Pwnda Grove

The peer-to-peer swap route is [BasicSwap](https://github.com/basicswap/basicswap)
plus this project's patch series (`upstream/patches/`), applied over the upstream
package rather than forked. Each patch is documented in its own header; the series is
re-verified against the assembled runtime by `scripts/swap/verify-*.py`. Makers use
the engine's own console (Settings ▸ swap node ▸ *Open BasicSwap console*); takers use
the wallet's Swap tab.

Swap-engine wallets for BTC, LTC and BCH are the wallet's own accounts (an account-level
key is shared with the engine, under per-coin consent); Monero, Zephyr and Zano run
against the wallet's own wallet-rpc. Particl, which BasicSwap requires for its message
network, is the engine's own wallet.

## Repository layout

| Path | What |
|---|---|
| `src/` | Frontend: wallet adapters, views, the swap form and trackers |
| `src-tauri/` | Rust backend: process supervision, the swap-node sidecar, mining |
| `src-lite/` | PwndaLite (mining-only) entry |
| `upstream/patches/` | The Grove patch series over BasicSwap |
| `scripts/` | Build, bundling, release, and swap-runtime tooling |
| `PwndaWalletVault/` | The project wiki (Obsidian): architecture, entities, the incident log |
| `BOUNDARIES.md` | Per-feature import policy, enforced for the mining/lite slices |

## License

Apache-2.0. See `LICENSE`.
