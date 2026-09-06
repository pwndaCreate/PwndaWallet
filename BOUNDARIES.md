# PwndaWallet — Module Boundaries

Every file under `src/features/<feature>/` belongs to that feature's slice. Cross-feature imports are restricted so the codebase stays composable — most notably so the mining subsystem can be linked into the standalone PwndaLite product without dragging in wallet/vault code.

This document is the **authoritative** source of truth for those restrictions. The boundary check script (`scripts/check-boundaries.mjs`, wired into `prebuild`) enforces them automatically. The CI `cargo build --no-default-features` smoke test enforces the equivalent on the Rust side.

If you're a future contributor (human or agent) and you want to import something from another feature folder, **read this file first** and update it if your change should be reflected in the rules. Don't bypass the boundary check by relaxing rules silently.

---

## Conventions

- **A feature folder owns its hook + view + types + helpers.** Co-locate everything. The folder is the unit of reuse.
- **Cross-feature imports are forbidden by default.** When you genuinely need to share, expose a public surface via the destination feature's `index.ts` (or a clearly named contract file like `<feature>/types.ts`).
- **Mining is the strictest feature.** Mining ships in two products (PwndaWallet, PwndaLite) and must compile cleanly without wallet/vault state. The mining row below is intentionally narrow.
- **Type-only imports from `src/wallets/index.ts` are fine** — TypeScript erases them at compile time, so the runtime barrel isn't pulled in. Use `import type { ChainType } from "../../wallets"` freely.
- **Runtime imports from `src/wallets/index.ts`** (`getAdapter`, `ALL_CHAINS`, etc.) drag in every chain adapter. Mining-side code must use `src/wallets/coin-metadata.ts` instead, which has no adapter imports.
- **Pure utilities** (`src/lib/`, `src/utils/`, `src/components/`) are free to import from any feature folder.
- **The design layer** (`src/design/`) is pure-utility-tier with one tightened restriction: it may NOT import from `src/features/**` (the failure mode the mining-modularization plan ripped out). Exception: `src/design/catalog/compositions/` files MAY import real feature views, so the catalog can render real layouts against mock state.

---

## Per-feature rules

| Feature folder | May import (in addition to bare deps + same-folder + `src/{components,lib,utils,design}`) | Banned |
|---|---|---|
| **mining** | `src/types/mining`, `src/wallets/coin-metadata`, type-only `ChainType` / `ChainAdapter` from `src/wallets/index` or `src/wallets/types`, `src/secure-random`, `src/platform/*` | All sibling feature folders, `src/store`, `src/crypto`, `src/state/*`, `src/wallets/*-wallet`, `src/wallets/xmr-*`, `src/wallets/zph-*`, `src/wallets/zano-*`, `src/wallets/ada-*`, `src/App`, `src/api/*` |
| **lite** (`src-lite/`) | Everything mining can import, **plus** `src/features/mining/**`, `src/wallets/usd-prices`, `src/styles.css`, `src/design/**`, `src/platform/*` | All sibling feature folders other than mining, `src/store`, `src/crypto`, `src/state/*`, `src/wallets/*-wallet`, `src/App` |
| **design** (`src/design/`) | `src/lib/`, `src/utils/`, type-only `ChainType` / `ChainAdapter` from `src/wallets/{index,types}` | All `src/features/**` folders, `src/store`, `src/crypto`, `src/state/*`, `src/App`, `src/wallets/*-wallet`, `src/api/*`. **Narrow exception**: files under `src/design/catalog/compositions/` MAY import real feature views — that's the whole point of compositions. |

### The sidecar fee has no feature folder, on purpose

`src-tauri/src/sidecar_fees/` has no `src/features/sidecar-fees/` counterpart and
should not grow one. Its entire TypeScript surface is three **read-only** bindings
in `src/api/basicswap.ts` (`sidecarFeesStatus`, `sidecarFeesHistory`,
`sidecarFeesQuote`).

That is a design constraint, not an omission. The Rust watcher issues the fee
payment as a *consequence* of detecting settlement, never on a frontend call — a
Rust `settle_fee()` invoked from TS would be defeated by patching the easier half
of the binary. So the rule is stated here in prose rather than as a table row,
because `scripts/check-boundaries.mjs` enforces folder-scoped import rules and
there is no folder to scope. What DOES enforce it is
`sidecar_fees::tests::no_command_can_trigger_settlement`, which fails the build if
a Tauri command named settle/collect/pay/charge ever appears in that module.

If a fee UI is ever built, it belongs in an existing feature folder (settings) as
a consumer of those three read-only bindings. Published schedule: `FEE.md`.
| **wallet** | `src/features/{vault,monero,zephyr,send,activity}` via their `index.ts`, `src/wallets/*`, `src/store`, `src/crypto`, `src/state/*` | — |
| **swap** | `src/wallets/*`, `src/store`, `src/crypto`, `src/state/*`, `src/api/*` | — |
| **swap-sidecar** | `src/api/basicswap`, `src/api/basicswapDaemon` (C2 daemon-direct routing bindings), `src/wallets/{usd-prices,coin-metadata}`, `src/store` (the plaintext opt-in + DEX-coin keys only), `src/features/swap/index` (router types via the public barrel) | Sibling feature internals, `src/crypto`, `src/App`. **Desktop-only** — PwndaLite must never link it (it drags in the whole swap engine surface). |
| **vault** | `src/wallets/*`, `src/store`, `src/crypto`, `src/state/*` | — |
| **send** | `src/wallets/*`, `src/store`, `src/state/*` | — |
| **monero / zephyr / zano** | `src/wallets/{xmr,zph,zano}-*`, `src/store`, `src/state/*` | — |
| **landscape** | All feature folders (it's the layout root) | — |
| **auth / onboarding** | `src/state/*`, `src/store`, `src/crypto` | — |
| **activity** | `src/wallets/*`, `src/state/*`, `src/features/swap/index` (runtime — the unified history view loads `loadSwapHistory` + drift helpers + `SwapHistoryEntry` type via swap's public barrel; nothing from swap's internals) | — |
| **settings** | `src/state/*`, `src/store`, `src/features/mining/*` (settings hosts the Miner Setup gateway), `src/api/proxy` (SWAP RELAY card: status/enroll/test + the server-URL override), `src/features/swap/router-modes` (router picker), `src/features/swap/{SweepBackSection,DexCnWalletCard}` (the swap-NODE surfaces that moved out of the Swap tab on 2026-09-05 — `settings/SwapNodeExtras.tsx` is their one host, mounted by both layouts), `src/features/swap-sidecar` (via its barrel), `src/wallets/chain-rpcs` (NETWORK card probes) | — |

The **mining** and **lite** rows are enforced by `scripts/check-boundaries.mjs` — both fail the build (exit 1) on any forbidden import. The other feature rows are documented here so they're discoverable, but the script doesn't yet check them — the cost is mostly false-positive triage. Add per-feature enforcement when the pattern repeats (e.g. when a third product variant arrives).

---

## When you add a new feature folder

1. Create `src/features/<feature>/` with at least a hook, a view, and (if it has its own state) types co-located.
2. Add a row to the table above with the import list.
3. If the feature is a candidate for sharing into a sibling product variant (the way mining is shared with PwndaLite), keep the allowed-imports list as narrow as the mining row and add a `feature` entry to the `RULES` object in `scripts/check-boundaries.mjs`.
4. If the feature has a public API other features should import, add an `index.ts` that re-exports the public surface; everything else in the folder is "private to the feature".

## When you remove a feature folder

1. Delete the row from this table.
2. Remove the corresponding entry from `scripts/check-boundaries.mjs::RULES` (if any).
3. Grep for stale imports anywhere in `src/` — there shouldn't be any after the folder is gone, but the boundary check won't catch dangling imports of nonexistent paths.

## When you can't avoid breaking a rule

Don't silently relax the rule. Either:
- The destination feature genuinely exposes something you need — add it to the public surface (`index.ts`), update this doc + the rule script.
- The shared logic doesn't belong to either feature — extract it to `src/lib/` or `src/components/`.
- The rule itself is wrong — open a discussion and revise this doc first.

The boundary check fails the build (exit 1) so a "fix later" merge is impossible without explicitly disabling the prebuild step.

---

## Backend (Rust)

`src-tauri/src/` has a parallel contract enforced by the `full` Cargo feature:

- Mining modules (`miners`, `pool_*`, `pool_dialects`, `proxy_pool`, `device_info`) compile into every build. (The `dev_fee` module + the `leaderboard` uplink were removed 2026-07-06 in the pure-wallet cutover — archived under `PwndaWalletVault/wiki/archive/`.)
- Wallet / swap / RPC modules (`swap`, `xmr_rpc`, `zph_rpc`, `sol_rpc`, `http_proxy`, `wallet_rpc_common`, `secure_random`, `auth_keypair`) are gated behind `#[cfg(feature = "full")]` and stripped from the lite build.
- The boundary check: `cargo build --no-default-features` must succeed. CI runs this on every PR.
- No mining-side Rust module should `use crate::swap`, `crate::xmr_rpc`, `crate::zph_rpc`, `crate::sol_rpc`, `crate::http_proxy`, `crate::wallet_rpc_common`, or `crate::secure_random`. Grep for new `^use crate::` edges before merging mining-side changes.

---

## Related

- [[PwndaWalletVault/wiki/synthesis/pwnda-mining-modularization]] — full plan that introduced this contract
- [[PwndaWalletVault/wiki/synthesis/pwnda-lite-plan]] — the second product that depends on this contract being honored
- `scripts/check-boundaries.mjs` — the automated check
- `CONTRIBUTING.md` § Module Boundaries (REQUIRED) — the agent-side rule
