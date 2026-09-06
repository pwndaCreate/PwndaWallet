//! Swap module — client-side cryptography and proxy client for SwapKit /
//! NEAR Intents 1Click flows.
//!
//! ## Responsibilities (per ClientSideIntegration / Agent Brief B)
//!
//! * **Signing** happens here. The webview never touches private key material.
//!   See [`derive`], [`evm`], [`btc`], [`near`], [`solana`].
//! * **Vault decryption** uses the same PBKDF2-SHA256 + AES-GCM-256 scheme as
//!   the existing TS-side `crypto.ts`, so a single unlock unlocks both worlds.
//!   The mnemonic is held in [`zeroize::Zeroizing`] and wiped on lock or
//!   timeout. See [`keystore`].
//! * **Proxy calls** go to the user's wallet-proxy (the URL is injected at
//!   build time via `VITE_PROXY_URL`/`PWNDA_PROXY_URL`). This module never
//!   talks directly to `api.swapkit.dev` or `chaindefuser.com`.
//! * **Broadcasting** goes from Rust directly to a configured chain RPC.
//!   See [`broadcast`].
//!
//! ## Hard rules
//! 1. There is **no command** that exports a raw private key, mnemonic, or
//!    seed bytes. The Tauri capability allow-list (`capabilities/main.json`)
//!    is the second line of defense.
//! 2. Errors never embed key material. They name the failing field, never
//!    the value.
//! 3. The session unlock auto-relocks after [`SESSION_TTL_SECS`] seconds.

pub mod auth;
pub mod broadcast;
pub mod btc;
pub mod commands;
pub mod cosmos;
pub mod derive;
pub mod evm;
pub mod keystore;
pub mod near;
pub mod nep413;
pub mod proxy;
pub mod safety_log;
pub mod solana;
pub mod state;
// Phase 6 (2026-05-08): Stellar XDR signer.
pub mod stellar;
// Phase 7 (2026-05-08): Sui BCS signer.
pub mod sui;

pub const SESSION_TTL_SECS: u64 = 300;
