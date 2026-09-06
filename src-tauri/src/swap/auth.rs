//! X-Client-Sig auth for the wallet-proxy server.
//!
//! Per the server contract (May 6 2026), every request to `/api/*` must be
//! signed with a per-install ed25519 keypair. The server pins the public key
//! at enrollment and replays its derived bytes against the signature on each
//! request.
//!
//! ## Refactor (2026-05-16)
//!
//! The pure-crypto bits live in [`crate::auth_keypair`] so the leaderboard
//! uplink can share the canonical-message envelope without dragging in the
//! swap module (which is `#[cfg(feature = "full")]`-gated). This file is
//! now a thin re-export wrapper plus swap-specific file-name constants.
//! Public API and behaviour are unchanged.
//!
//! ## Storage
//!
//! * **Seed (32 bytes)** — OS keyring under `(service="pwnda-wallet",
//!   account="client-sig-key")`. On Windows that's the Credential Manager.
//!   The seed is generated once on first run and never re-derived.
//! * **Public key (32 bytes, base64 with `=` padding)** — plaintext file
//!   `client_sig_pubkey.json` next to `wallet.dat`. Lets users / auditors
//!   read the pubkey without touching the keyring.
//! * **Auth state** — `proxy-auth-state.json` next to `wallet.dat`. Holds
//!   `enrolledAt` (ISO8601) and `clockOffsetSecs` (server_time - local_time).
//!
//! ## Canonical signing message
//!
//! ```text
//! <UPPERCASE_METHOD>\n<path-with-query>\n<timestamp-decimal>\n<nonce-base64>\n<sha256(body)-hex-lowercase>
//! ```
//!
//! Single LF (0x0A) between fields, NO trailing LF.

use std::path::Path;
use zeroize::Zeroizing;

use crate::auth_keypair::{
    self, build_headers_padded, load_or_create_seed as kp_load_or_create_seed,
    pubkey_b64_padded, random_nonce_b64 as kp_random_nonce_b64, sign_request_padded,
    KeyringAccount,
};

// Public re-exports — preserve the symbols swap/commands.rs and
// swap/proxy.rs already import. `now_with_offset` is re-exported for
// API continuity even though no current swap call site uses it.
#[allow(unused_imports)]
pub use crate::auth_keypair::{
    now_with_offset, path_requires_signature, AuthError, AuthStateFile, SignedRequestHeaders,
};

pub const PUBKEY_FILE: &str = "client_sig_pubkey.json";
pub const STATE_FILE: &str = "proxy-auth-state.json";

/// Load (or create) the swap-server signing seed.
pub fn load_or_create_seed() -> Result<Zeroizing<[u8; 32]>, AuthError> {
    kp_load_or_create_seed(KeyringAccount::SWAP)
}

/// Persist the swap pubkey file next to `wallet.dat`.
pub fn write_pubkey_file(data_dir: &Path, pubkey_b64: &str) -> Result<(), AuthError> {
    auth_keypair::write_pubkey_file(data_dir, PUBKEY_FILE, pubkey_b64)
}

/// The origin legacy (pre-2026-08-12, flat-shape) auth-state files are
/// attributed to on migration: the production default every shipped build
/// enrolled against. See `auth_keypair::read_state_for_origin`.
pub const LEGACY_STATE_ORIGIN: &str = "https://wallet.pwnda.org";

/// Normalize a proxy BASE URL to its origin (`scheme://host[:port]`,
/// lowercase, default port elided) for auth-state keying. Enrollment and
/// clock offset are properties of the SERVER, so two spellings of the same
/// server ("https://X", "https://X/") must share one entry, and two
/// different servers must never share one.
pub fn origin_of(base_url: &str) -> String {
    match url::Url::parse(base_url.trim()) {
        Ok(u) => {
            let o = u.origin();
            if o.is_tuple() {
                o.ascii_serialization()
            } else {
                origin_fallback(base_url)
            }
        }
        Err(_) => origin_fallback(base_url),
    }
}

/// Unparseable / opaque-origin input still needs a deterministic key so a
/// weird-but-accepted URL round-trips to the same entry.
fn origin_fallback(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// Read the auth state for the server at `base_url` (keyed by origin).
pub fn read_state(data_dir: &Path, base_url: &str) -> AuthStateFile {
    auth_keypair::read_state_for_origin(
        data_dir,
        STATE_FILE,
        &origin_of(base_url),
        LEGACY_STATE_ORIGIN,
    )
}

/// Write the auth state for the server at `base_url` (keyed by origin),
/// preserving other origins' entries.
pub fn write_state(
    data_dir: &Path,
    base_url: &str,
    state: &AuthStateFile,
) -> Result<(), AuthError> {
    auth_keypair::write_state_for_origin(
        data_dir,
        STATE_FILE,
        &origin_of(base_url),
        LEGACY_STATE_ORIGIN,
        state,
    )
}

/// Swap-server-compatible (padded base64) public key encoding.
pub fn pubkey_b64(seed: &[u8; 32]) -> String {
    pubkey_b64_padded(seed)
}

/// 16 random bytes, base64 with `==` padding.
#[allow(dead_code)]
pub fn random_nonce_b64() -> String {
    kp_random_nonce_b64()
}

/// Build the canonical signing message and produce the padded base64
/// signature (swap-server contract).
#[allow(dead_code)]
pub fn sign_request(
    seed: &[u8; 32],
    method: &str,
    path: &str,
    timestamp: u64,
    nonce_b64: &str,
    body: &[u8],
) -> String {
    sign_request_padded(seed, method, path, timestamp, nonce_b64, body)
}

/// Bundle of headers + payload to attach to a signed request.
/// Swap-server form (padded base64 throughout).
pub fn build_headers(
    seed: &[u8; 32],
    method: &str,
    path: &str,
    body: &[u8],
    clock_offset_secs: i64,
) -> SignedRequestHeaders {
    build_headers_padded(seed, method, path, body, clock_offset_secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    /// **Server signing fixture (regression lock).**
    ///
    /// Pinned against the test vector the swap server agent published on
    /// May 6 2026. Identical to the pre-refactor assertion — the swap
    /// re-exports must produce the same output as the original
    /// implementation byte-for-byte. The deeper unit tests live in
    /// `crate::auth_keypair::tests`; this one is the load-bearing
    /// contract assertion for the swap path.
    #[test]
    fn signing_fixture_matches_server_vector() {
        let seed_bytes = B64
            .decode(b"d2FsbGV0LXByb3h5LXRlc3QtdmVjdG9yLXNlZWQhISE=")
            .unwrap();
        assert_eq!(seed_bytes.len(), 32);
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&seed_bytes);

        let expected_pub = "enEFZWlkvQx0O/tnqR1QtqUqvYZgZuYHFTGHAnCqDHw=";
        assert_eq!(pubkey_b64(&seed), expected_pub, "public-key derivation drifted");

        let nonce_b64 = "AAECAwQFBgcICQoLDA0ODw==";
        let timestamp = 1715000000u64;
        let body = br#"{"swapType":"EXACT_INPUT"}"#;
        let path = "/api/intents/quote";
        let method = "POST";

        let body_hash = hex::encode(Sha256::digest(body));
        assert_eq!(
            body_hash, "0a23d68f713be7ab8071f42b3448bdfd90b94a8ca7d61a39f80c38535db92a44",
            "body SHA-256 drifted",
        );

        let expected =
            "+dMTE9j7j5yf1X5aDlyF7RQ0bQutBvMN+/HV5NSkLbd9uBWEPWcX0u8qZONHc9sONzi3LY0B13H4FbOrXwamBQ==";
        let actual = sign_request(&seed, method, path, timestamp, nonce_b64, body);
        assert_eq!(actual, expected, "signature drifted from server vector");
    }

    #[test]
    fn origin_normalization_matrix() {
        // Same server, many spellings -> one key.
        assert_eq!(origin_of("https://wallet.pwnda.org"), "https://wallet.pwnda.org");
        assert_eq!(origin_of("https://wallet.pwnda.org/"), "https://wallet.pwnda.org");
        assert_eq!(origin_of("https://WALLET.PWNDA.ORG"), "https://wallet.pwnda.org");
        assert_eq!(origin_of("https://wallet.pwnda.org:443"), "https://wallet.pwnda.org");
        assert_eq!(origin_of(" https://wallet.pwnda.org "), "https://wallet.pwnda.org");
        // A path prefix does not change the identity of the SERVER.
        assert_eq!(origin_of("https://wallet.pwnda.org/sub"), "https://wallet.pwnda.org");
        // Non-default port is a different origin and must be kept.
        assert_eq!(origin_of("https://wallet.pwnda.org:8443"), "https://wallet.pwnda.org:8443");
        // Localhost dev servers.
        assert_eq!(origin_of("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
        assert_eq!(origin_of("http://localhost:8787/"), "http://localhost:8787");
        // Different servers never collide.
        assert_ne!(origin_of("https://a.example"), origin_of("https://b.example"));
    }
}
