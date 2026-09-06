//! Per-install ed25519 signing keypair for the swap proxy.
//!
//! This module compiles into **both** PwndaWallet and PwndaLite — no
//! `#[cfg(feature = "full")]` guard. It owns the OS-keyring seed lifecycle
//! and the canonical signed-request envelope. A caller selects its keyring
//! slot with a `KeyringAccount` value:
//!
//!   * `swap`         → `KeyringAccount::SWAP`         ("client-sig-key")
//!
//! (The leaderboard uplink, which shared this module via a second
//! `KeyringAccount::LEADERBOARD` slot + an unpadded-base64 encoding, was
//! removed 2026-07-06 in the pure-wallet cutover.)
//!
//! ## Canonical signing message
//!
//! ```text
//! <UPPERCASE_METHOD>\n<path-with-query>\n<timestamp-decimal>\n<nonce-base64>\n<sha256(body)-hex-lowercase>
//! ```
//!
//! Single LF (0x0A) between fields, NO trailing LF. Pinned by the swap test
//! fixture in `swap/auth.rs` against the wallet-proxy server's published
//! vector.
//!
//! ## Base64 encoding
//!
//!   * **Swap server** — `X-Client-Pubkey` and `X-Client-Sig` are STANDARD
//!     base64 WITH `=` padding. The test vector at `swap/auth.rs::tests`
//!     ends in `==`. Use [`pubkey_b64_padded`] / [`sign_request_padded`].
//!   * **Nonce** — standard base64 WITH `==` padding for the 16-byte
//!     random nonce. [`random_nonce_b64`] returns padded.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

const KEYRING_SERVICE: &str = "pwnda-wallet";

/// Identifies which keyring slot a caller wants. Each variant gets its
/// own seed → its own pubkey → its own independent server identity.
#[derive(Debug, Clone, Copy)]
pub struct KeyringAccount(&'static str);

impl KeyringAccount {
    /// Swap proxy keypair (`X-Client-Sig` for `wallet.pwnda.org`).
    pub const SWAP: Self = Self("client-sig-key");

    /// Swap-desk state-store encryption key (a 32-byte secret used as the
    /// AES-256-GCM key for `desk/store.rs`). Kept in a SEPARATE keyring slot
    /// from the signing seed — never reuse a signing key as a cipher key. Loaded
    /// without a password prompt (the OS session unlocks the keyring), so the
    /// background refund watchers can decrypt persisted swap state at startup.
    pub const DESK_STORE: Self = Self("desk-store-key");

    pub fn as_str(self) -> &'static str {
        self.0
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("seed format error: {0}")]
    Format(&'static str),
    #[error("entropy error: {0}")]
    Random(String),
    #[error("io: {0}")]
    Io(String),
    #[error("base64: {0}")]
    Base64(String),
}

impl From<keyring::Error> for AuthError {
    fn from(e: keyring::Error) -> Self {
        AuthError::Keyring(e.to_string())
    }
}

/// Generic auth-state file (per-account "enrolledAt + clockOffsetSecs").
/// Persisted next to the wallet data dir under a caller-chosen filename.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthStateFile {
    pub enrolled_at: Option<String>,
    pub clock_offset_secs: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PubkeyFile {
    pubkey: String,
}

/// Load the per-install seed from the OS keyring (per account), generating
/// + persisting it on first call. Returned bytes are wrapped in
/// `Zeroizing` so they're wiped on drop.
pub fn load_or_create_seed(account: KeyringAccount) -> Result<Zeroizing<[u8; 32]>, AuthError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, account.as_str())?;
    match entry.get_password() {
        Ok(b64) => {
            let bytes = B64
                .decode(b64.as_bytes())
                .map_err(|e| AuthError::Base64(e.to_string()))?;
            if bytes.len() != 32 {
                return Err(AuthError::Format("seed must be 32 bytes"));
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            Ok(Zeroizing::new(arr))
        }
        Err(keyring::Error::NoEntry) => {
            let mut arr = [0u8; 32];
            getrandom::getrandom(&mut arr).map_err(|e| AuthError::Random(e.to_string()))?;
            let b64 = B64.encode(arr);
            entry.set_password(&b64)?;
            Ok(Zeroizing::new(arr))
        }
        Err(e) => Err(AuthError::Keyring(e.to_string())),
    }
}

/// Persist the public key to a JSON file next to the vault. Filename is
/// caller-chosen (the swap slot uses its own file).
pub fn write_pubkey_file(
    data_dir: &Path,
    filename: &str,
    pubkey_b64: &str,
) -> Result<(), AuthError> {
    std::fs::create_dir_all(data_dir).map_err(|e| AuthError::Io(e.to_string()))?;
    let path = data_dir.join(filename);
    let contents = serde_json::to_string_pretty(&PubkeyFile {
        pubkey: pubkey_b64.to_string(),
    })
    .map_err(|e| AuthError::Io(e.to_string()))?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if existing.trim() == contents.trim() {
            return Ok(());
        }
    }
    std::fs::write(&path, contents).map_err(|e| AuthError::Io(e.to_string()))?;
    Ok(())
}

/// On-disk shape of the auth-state file since 2026-08-12: one entry per
/// server ORIGIN, so switching the proxy URL in Settings does not carry a
/// stale `enrolledAt` / `clockOffsetSecs` measured against a different
/// server. The pre-keyed flat shape (`{"enrolledAt":..,"clockOffsetSecs":..}`)
/// is migrated on read by attributing it to `legacy_origin` - for shipped
/// installs that is the production default the flat file was written
/// against. (A dev install that ran with a custom VITE_PROXY_URL loses the
/// flat entry; harmless, auto re-enroll recovers it.)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct KeyedAuthStates {
    origins: std::collections::BTreeMap<String, AuthStateFile>,
}

fn read_keyed(data_dir: &Path, filename: &str, legacy_origin: &str) -> KeyedAuthStates {
    let path = data_dir.join(filename);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return KeyedAuthStates::default(),
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return KeyedAuthStates::default(),
    };
    if value.get("origins").is_some() {
        serde_json::from_value(value).unwrap_or_default()
    } else {
        // Legacy flat file: attribute its single entry to `legacy_origin`.
        let flat: AuthStateFile = serde_json::from_value(value).unwrap_or_default();
        let mut keyed = KeyedAuthStates::default();
        if flat.enrolled_at.is_some() || flat.clock_offset_secs != 0 {
            keyed.origins.insert(legacy_origin.to_string(), flat);
        }
        keyed
    }
}

/// Read the auth state for one server origin. Absent origin (or absent /
/// unparseable file) yields the default: not enrolled, zero clock offset.
pub fn read_state_for_origin(
    data_dir: &Path,
    filename: &str,
    origin: &str,
    legacy_origin: &str,
) -> AuthStateFile {
    read_keyed(data_dir, filename, legacy_origin)
        .origins
        .get(origin)
        .cloned()
        .unwrap_or_default()
}

/// Write the auth state for one server origin, preserving every other
/// origin's entry (and migrating a legacy flat file in the process).
pub fn write_state_for_origin(
    data_dir: &Path,
    filename: &str,
    origin: &str,
    legacy_origin: &str,
    state: &AuthStateFile,
) -> Result<(), AuthError> {
    std::fs::create_dir_all(data_dir).map_err(|e| AuthError::Io(e.to_string()))?;
    let mut keyed = read_keyed(data_dir, filename, legacy_origin);
    keyed.origins.insert(origin.to_string(), state.clone());
    let path = data_dir.join(filename);
    let s = serde_json::to_string_pretty(&keyed).map_err(|e| AuthError::Io(e.to_string()))?;
    std::fs::write(&path, s).map_err(|e| AuthError::Io(e.to_string()))?;
    Ok(())
}

/// Raw ed25519 public key bytes derived from `seed`.
pub fn pubkey_bytes(seed: &[u8; 32]) -> [u8; 32] {
    let sk = SigningKey::from_bytes(seed);
    sk.verifying_key().to_bytes()
}

/// Base64-encode the public key WITH `=` padding (swap-server compatible).
pub fn pubkey_b64_padded(seed: &[u8; 32]) -> String {
    B64.encode(pubkey_bytes(seed))
}

/// 16 random bytes, base64 with `==` padding (matches the swap server's nonce vector).
pub fn random_nonce_b64() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("getrandom for nonce");
    B64.encode(buf)
}

/// Current Unix seconds with the persisted clock-skew offset applied.
pub fn now_with_offset(offset_secs: i64) -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let t = now + offset_secs;
    if t < 0 {
        0
    } else {
        t as u64
    }
}

/// Build the canonical signing message and produce the **raw** signature bytes.
/// Encoding is the caller's responsibility — pick `_padded` or `_nopad` per
/// the target server's contract.
pub fn sign_request_bytes(
    seed: &[u8; 32],
    method: &str,
    path: &str,
    timestamp: u64,
    nonce_b64: &str,
    body: &[u8],
) -> [u8; 64] {
    let body_hash_hex = hex::encode(Sha256::digest(body));
    let canonical = format!(
        "{}\n{}\n{}\n{}\n{}",
        method.to_uppercase(),
        path,
        timestamp,
        nonce_b64,
        body_hash_hex
    );
    let sk = SigningKey::from_bytes(seed);
    sk.sign(canonical.as_bytes()).to_bytes()
}

/// Signature base64 WITH `=` padding (swap-server compatible).
pub fn sign_request_padded(
    seed: &[u8; 32],
    method: &str,
    path: &str,
    timestamp: u64,
    nonce_b64: &str,
    body: &[u8],
) -> String {
    B64.encode(sign_request_bytes(seed, method, path, timestamp, nonce_b64, body))
}

/// Headers bundle to attach to a signed request.
pub struct SignedRequestHeaders {
    pub pubkey: String,
    pub timestamp: String,
    pub nonce: String,
    pub signature: String,
}

/// Build padded headers (swap-server compatible).
pub fn build_headers_padded(
    seed: &[u8; 32],
    method: &str,
    path: &str,
    body: &[u8],
    clock_offset_secs: i64,
) -> SignedRequestHeaders {
    let ts = now_with_offset(clock_offset_secs);
    let nonce = random_nonce_b64();
    let signature = sign_request_padded(seed, method, path, ts, &nonce, body);
    SignedRequestHeaders {
        pubkey: pubkey_b64_padded(seed),
        timestamp: ts.to_string(),
        nonce,
        signature,
    }
}

/// Tag a path so callers know whether to sign it — the swap server
/// enforces signatures only on `/api/*`.
pub fn path_requires_signature(path: &str) -> bool {
    path.starts_with("/api/")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression lock against the SWAP server's published vector
    /// (padded signature). Mirrors the original `swap/auth.rs::tests`
    /// fixture verbatim so we don't drift from the wallet-proxy contract.
    #[test]
    fn swap_signing_fixture_matches_server_vector() {
        let seed_bytes = B64
            .decode(b"d2FsbGV0LXByb3h5LXRlc3QtdmVjdG9yLXNlZWQhISE=")
            .unwrap();
        assert_eq!(seed_bytes.len(), 32);
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&seed_bytes);

        let expected_pub = "enEFZWlkvQx0O/tnqR1QtqUqvYZgZuYHFTGHAnCqDHw=";
        assert_eq!(
            pubkey_b64_padded(&seed),
            expected_pub,
            "padded public-key derivation drifted",
        );

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
        let actual = sign_request_padded(&seed, method, path, timestamp, nonce_b64, body);
        assert_eq!(actual, expected, "padded signature drifted from server vector");
    }

    #[test]
    fn empty_body_sha_matches_published_constant() {
        let h = hex::encode(Sha256::digest(b""));
        assert_eq!(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn path_signing_classifier() {
        assert!(path_requires_signature("/api/intents/quote"));
        assert!(path_requires_signature("/api/v1/status"));
        assert!(!path_requires_signature("/healthz"));
        assert!(!path_requires_signature("/enroll"));
    }

    #[test]
    fn nonce_is_22_base64_chars_with_padding() {
        // 16 bytes → 22 base64 chars + `==` = 24 total. Standard base64.
        let n = random_nonce_b64();
        assert_eq!(n.len(), 24);
        assert!(n.ends_with("=="));
    }

    // ---- per-origin auth-state store ----

    const LEGACY: &str = "https://wallet.pwnda.org";
    const FILE: &str = "proxy-auth-state.json";

    /// Fresh scratch dir per test. Deterministic name (no randomness needed
    /// in tests); wiped at entry so reruns start clean.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pwnda-authstate-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_reads_default_state() {
        let dir = scratch("missing");
        let s = read_state_for_origin(&dir, FILE, LEGACY, LEGACY);
        assert!(s.enrolled_at.is_none());
        assert_eq!(s.clock_offset_secs, 0);
    }

    #[test]
    fn legacy_flat_file_is_attributed_to_the_legacy_origin_only() {
        let dir = scratch("legacy");
        std::fs::write(
            dir.join(FILE),
            r#"{"enrolledAt":"2026-05-06T00:00:00Z","clockOffsetSecs":-3}"#,
        )
        .unwrap();

        // The legacy origin sees the migrated values...
        let s = read_state_for_origin(&dir, FILE, LEGACY, LEGACY);
        assert_eq!(s.enrolled_at.as_deref(), Some("2026-05-06T00:00:00Z"));
        assert_eq!(s.clock_offset_secs, -3);

        // ...any other origin starts fresh.
        let other = read_state_for_origin(&dir, FILE, "https://example.org", LEGACY);
        assert!(other.enrolled_at.is_none());
        assert_eq!(other.clock_offset_secs, 0);
    }

    #[test]
    fn write_migrates_legacy_and_keeps_origins_isolated() {
        let dir = scratch("isolate");
        std::fs::write(
            dir.join(FILE),
            r#"{"enrolledAt":"2026-05-06T00:00:00Z","clockOffsetSecs":7}"#,
        )
        .unwrap();

        // Enroll at a second origin.
        let new_state = AuthStateFile {
            enrolled_at: Some("2026-08-12T00:00:00Z".into()),
            clock_offset_secs: 0,
        };
        write_state_for_origin(&dir, FILE, "https://example.org", LEGACY, &new_state).unwrap();

        // Second origin reads its own entry.
        let b = read_state_for_origin(&dir, FILE, "https://example.org", LEGACY);
        assert_eq!(b.enrolled_at.as_deref(), Some("2026-08-12T00:00:00Z"));

        // The migrated legacy entry survived the write untouched.
        let a = read_state_for_origin(&dir, FILE, LEGACY, LEGACY);
        assert_eq!(a.enrolled_at.as_deref(), Some("2026-05-06T00:00:00Z"));
        assert_eq!(a.clock_offset_secs, 7);

        // And the file is now the keyed shape (a second write must not
        // re-attribute anything).
        let raw = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(raw.contains("\"origins\""));
    }

    #[test]
    fn write_is_idempotent_over_the_keyed_shape() {
        let dir = scratch("idempotent");
        let st = AuthStateFile {
            enrolled_at: Some("2026-08-12T00:00:00Z".into()),
            clock_offset_secs: 2,
        };
        write_state_for_origin(&dir, FILE, LEGACY, LEGACY, &st).unwrap();
        write_state_for_origin(&dir, FILE, LEGACY, LEGACY, &st).unwrap();
        let s = read_state_for_origin(&dir, FILE, LEGACY, LEGACY);
        assert_eq!(s.enrolled_at.as_deref(), Some("2026-08-12T00:00:00Z"));
        assert_eq!(s.clock_offset_secs, 2);
    }

    #[test]
    fn corrupt_file_reads_default_and_is_recoverable_by_write() {
        let dir = scratch("corrupt");
        std::fs::write(dir.join(FILE), "not json at all").unwrap();
        let s = read_state_for_origin(&dir, FILE, LEGACY, LEGACY);
        assert!(s.enrolled_at.is_none());
        let st = AuthStateFile {
            enrolled_at: Some("x".into()),
            clock_offset_secs: 0,
        };
        write_state_for_origin(&dir, FILE, LEGACY, LEGACY, &st).unwrap();
        assert_eq!(
            read_state_for_origin(&dir, FILE, LEGACY, LEGACY).enrolled_at.as_deref(),
            Some("x")
        );
    }
}
