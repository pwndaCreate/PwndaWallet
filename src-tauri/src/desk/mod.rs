//! `pwnda-desk` — the client half of the operator-run atomic-swap desk.
//!
//! This is the third swap provider in the wallet, beside SwapKit and
//! NEAR-Intents. Unlike those one-shot `build -> sign -> broadcast` executors,
//! an atomic swap is a multi-step protocol (several signatures spread across
//! T+10-60 min, plus an unattended claim-or-refund) that needs a durable state
//! machine and background chain watchers. That is why this is a new Rust *tier*
//! rather than another variant of the existing swap executor.
//!
//! ## Module map (mirrors the Go reference client under `pwnda-desk-handoff/`)
//!
//! | Module | Responsibility | Go reference |
//! |---|---|---|
//! | [`wire`] | serde mirror of every desk DTO + a round-trip test per message | `reference-client/wire.go` |
//! | [`client`] | enroll + signed `/api/desk/*` calls | `reference-client/client.go` |
//! | [`engine`] | the 8.1 client state machine + safety gating | `reference-client/safety.go` |
//! | [`watch`] | the `ChainObserver` trait + the refund watcher | `reference-client/safety.go` |
//! | [`observer`] | the REAL observer: both legs via our own engine's `watch_lock` | `desk_watch.py` |
//! | [`depth`] | how deep a counterparty lock must be before we act on it | `quote` + the preset floors |
//! | [`reclaim`] | abort-table row 2: the leader's refund leaks `s_a`, so we sweep chain B | `xmr_reclaim` |
//! | [`store`] | durable encrypted swap-state (survives app restart) | (Rust-only; the Go harness is in-memory) |
//! | [`crypto`] | the SEAM the vendored adaptor-sig library plugs into | (the Go harness uses schema stand-ins) |
//! | [`refund`] | what the watcher does at T1: guards, assembly, broadcast | (the Go harness stops at the trigger) |
//! | [`sidecar`] | the line-delimited-JSON stdio transport to the Python engine | `reference-client/bridge.go` |
//! | `rung2b` | Stage-B conformance: M3 pre-sig agreement + the M5 gate, on preprod | (the desk runs its own side) |
//! | [`rehydrate`] | startup respawn of refund watchers + the stop-flag registry | (Rust-only; the Go harness is one process) |
//! | `arm` | the rung-3 arm gate — the ONLY path that installs the real engine | (Rust-only; testnet-only by construction) |
//! | [`conductor`] | the rung-3 funded choreography: observe→lock→claim, role-dispatched | `reference-client/statemachine.go` |
//!
//! ## Reuse (no new crypto, no re-enrollment)
//!
//! The desk shares the wallet's EXISTING X-Client-Sig rail
//! ([`crate::swap::auth`] / [`crate::swap::proxy`]) — the SAME enrolled ed25519
//! pubkey is the desk identity. [`crate::auth_keypair::path_requires_signature`]
//! is `path.starts_with("/api/")`, so `/api/desk/*` is signed automatically and
//! `/enroll` stays unsigned. The client tier adds no signing code of its own.
//!
//! ## Trust boundary (non-negotiable — sub-plan 04 D)
//!
//! Keys never leave the Rust core. What crosses the wire is curve POINTS, DLEq
//! proofs, pre-signed SIGNATURES, txids, and a view key — NEVER a spend scalar.
//! Every desk message is ADVICE: every client signature is gated on the client's
//! OWN chain observation, and the refund watcher recovers funds with the desk
//! offline or hostile. Those invariants live in `engine`/`watch`; this file is
//! only the wire shapes they exchange.
//!
//! Full-wallet-only: the whole module is `#[cfg(feature = "full")]`-gated in
//! `lib.rs` (it is never part of the mining-only PwndaLite build).

pub mod client;
pub mod commands;
pub mod conductor;
pub mod crypto;
#[cfg(test)]
pub mod conformance;
pub mod arm;
pub mod depth;
pub mod engine;
pub mod observer;
pub mod reclaim;
// Test-only on purpose, like `conformance` and `rung2b`: it exists to run inside
// `cargo test --lib desk::` — the suite's step 1 — because an integration test in
// `tests/` is invisible to that gate (the reason it was moved in from there).
#[cfg(test)]
pub mod real_witness;
pub mod refund;
#[cfg(test)]
pub mod rung2b;
pub mod rehydrate;
pub mod sidecar;
pub mod store;
pub mod watch;
pub mod wire;
