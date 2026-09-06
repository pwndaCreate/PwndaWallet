/**
 * WALLET-side capability for NEAR Intents chains. **Hand-owned. Never generated.**
 *
 * # Why this file exists
 *
 * `near-intents-assets.generated.ts` answers "what does NEAR Intents offer?" —
 * a question only the upstream 1Click catalog can answer, so that file is
 * safe to regenerate wholesale.
 *
 * This file answers a completely different question: **"what can THIS WALLET
 * do?"** — specifically, for which chains can we build and sign a deposit
 * transaction. No upstream feed knows that; it is a fact about our own signers.
 *
 * The two used to live in the same file. That was a real defect, not a tidiness
 * issue: on 2026-08-19 a routine `node scripts/sync-near-intents-assets.mjs`
 * silently overwrote this set with the script's stale 14-chain list, dropping
 * ltc/bch/monad/dash/stellar/sui/cardano and breaking four tests. The generated
 * file had even documented the hazard against itself — "the bootstrap generator
 * is stale ... so this file, not the script, is the live source of truth for
 * this set" — which is an unstable arrangement: a file that says DO NOT EDIT
 * while being the only correct copy.
 *
 * Splitting them makes regeneration mechanically safe: the script writes only
 * upstream facts and physically cannot clobber wallet knowledge, because wallet
 * knowledge is not in the file it writes.
 *
 * # What "source-capable" means
 *
 * The user can SEND from this chain (we can produce a signed deposit tx), not
 * merely receive on it. Address derivation alone is NOT enough — xrp/tron/ton
 * derive fine, so a user can receive, but no source-tx signer is wired, so they
 * cannot be the *from* side of an Intents swap.
 *
 * # When to edit
 *
 * Add a chain here the moment a source-tx signer lands for it — Rust
 * (`swap_sign_evm`, `swap_sign_psbt`, `swap_sign_solana`, `swap_sign_near_tx`,
 * `swap_sign_stellar_tx`, `swap_sign_sui_tx`) or TypeScript (Cardano, below).
 * Adding a chain that has no signer will offer the user a swap the wallet
 * cannot execute.
 */

import type { IntentsBlockchain } from "./near-intents-assets.generated";

export const SOURCE_CAPABLE_BLOCKCHAINS: ReadonlySet<IntentsBlockchain> =
  new Set<IntentsBlockchain>([
    // EVM family — swap_sign_evm.
    "eth",
    "arb",
    "base",
    "op",
    "pol",
    "avax",
    "bnb",
    // Phase 3 (Monad) — EVM-compatible, reuses swap_sign_evm with chainId 143.
    "monad",

    // UTXO family — swap_sign_psbt / legacy p2pkh input signing.
    "btc",
    "ltc",
    "doge",
    "bch",
    // Phase 5 (Dash) — extends the UtxoChain enum + sign_input_p2pkh_legacy.
    "dash",

    // Account-model chains with dedicated Rust signers.
    "sol",
    "near",
    // Phase 6 (Stellar) — swap_sign_stellar_tx (XDR + ed25519).
    "stellar",
    // Phase 7 (Sui) — swap_sign_sui_tx (BCS + ed25519 + intent envelope).
    "sui",

    // 2026-06-21 (ADA source) — Cardano is the one TS-SIGNED source: its
    // deposit tx is built, signed and submitted in `cardano-tx.ts`, so there is
    // deliberately no `swap_sign_cardano` in the Rust core. ADA is fully
    // source AND destination capable. (A stale 2026-05-25 comment elsewhere
    // once claimed Cardano was destination-only; that was superseded and the
    // contradiction is now removed.) Upstream constraint that still applies:
    // NEAR Intents carries NATIVE ADA ONLY on Cardano — no Cardano-native
    // tokens — so the chain is single-asset on this route.
    "cardano",

    // NOT source-capable (deliberate): xrp, tron, ton. Address derivation works
    // so the user can RECEIVE on them, but no source-tx signer is wired, so
    // they cannot be the FROM side. Move them up when a signer lands.
  ]);
