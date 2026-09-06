//! Sui transaction signing — Phase 7 (2026-05-08).
//!
//! Sui transactions are BCS-encoded `TransactionData` structures wrapped
//! in an intent envelope before signing. The signing primitive is:
//!
//! ```text
//!     intent_message = [intent_scope, intent_version, intent_app_id] || BCS(tx_data)
//!     digest = BLAKE2b-256(intent_message)
//!     sig = ed25519(secret, digest)
//!     wire_signature = [flag(0x00) || sig(64 bytes) || pubkey(32 bytes)]   // 97 bytes
//! ```
//!
//! Where `intent_scope = 0` (TransactionData), `intent_version = 0` (V0),
//! `intent_app_id = 0` (Sui).
//!
//! TS callers in `swap-sources.ts::executeSuiTransfer` build the BCS-encoded
//! TransactionData (object refs, gas data, programmable transaction
//! commands). Rust signs the digest. The wire signature format is
//! base64-encoded for Sui RPC submission.
//!
//! Sui supports multiple signature schemes (ed25519 = flag 0x00,
//! Secp256k1 = 0x01, Secp256r1 = 0x02, Multisig = 0x03). Pwnda uses
//! ed25519 only.

use blake2::{Blake2b, Digest};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum SuiError {
    #[error("invalid base64 tx bytes: {0}")]
    BadBase64(String),
    /// Reserved — kept so additions don't have to extend the enum.
    #[allow(dead_code)]
    #[error("invalid BCS shape")]
    BadBcs,
}

/// Sui ed25519 signature scheme flag.
pub const SIGNATURE_SCHEME_ED25519: u8 = 0x00;

/// Intent envelope prefix for `TransactionData` — `[scope, version, app_id]`.
/// All three bytes are 0 for the canonical Sui mainnet TransactionData
/// envelope.
pub const INTENT_TRANSACTION_DATA: [u8; 3] = [0x00, 0x00, 0x00];

/// SLIP-10 ed25519 hardened derivation, path `m/44'/784'/0'/0'/0'`. Five
/// hardened segments — the Sui CLI default account 0 path.
pub fn sui_secret_from_seed(seed: &[u8]) -> Zeroizing<[u8; 32]> {
    use hmac::{Hmac, Mac};
    use sha2::Sha512;
    fn hmac(key: &[u8], data: &[u8]) -> [u8; 64] {
        let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(key).unwrap();
        mac.update(data);
        let r = mac.finalize().into_bytes();
        let mut out = [0u8; 64];
        out.copy_from_slice(&r);
        out
    }

    let i = hmac(b"ed25519 seed", seed);
    let mut key = [0u8; 32];
    key.copy_from_slice(&i[..32]);
    let mut cc = [0u8; 32];
    cc.copy_from_slice(&i[32..]);

    for idx in [
        44u32 | 0x8000_0000,
        784u32 | 0x8000_0000,
        0u32 | 0x8000_0000,
        0u32 | 0x8000_0000,
        0u32 | 0x8000_0000,
    ] {
        let mut data = Vec::with_capacity(1 + 32 + 4);
        data.push(0x00);
        data.extend_from_slice(&key);
        data.extend_from_slice(&idx.to_be_bytes());
        let h = hmac(&cc, &data);
        key.copy_from_slice(&h[..32]);
        cc.copy_from_slice(&h[32..]);
    }
    Zeroizing::new(key)
}

/// 32-byte BLAKE2b-256 hash. Used for both Sui address derivation
/// (`addr = BLAKE2b-256(flag || pubkey)[..32]`) and tx digest
/// (`digest = BLAKE2b-256(intent || BCS(tx_data))`).
fn blake2b_256(data: &[u8]) -> [u8; 32] {
    type B = Blake2b<blake2::digest::consts::U32>;
    let mut hasher = B::new();
    hasher.update(data);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Sui address from public key. Computes BLAKE2b-256 of `flag || pubkey`
/// and takes the full 32-byte digest as the address bytes. Display form:
/// `0x` + lowercase hex.
pub fn sui_address(pk: &[u8; 32]) -> String {
    let mut input = Vec::with_capacity(33);
    input.push(SIGNATURE_SCHEME_ED25519);
    input.extend_from_slice(pk);
    let h = blake2b_256(&input);
    format!("0x{}", hex::encode(h))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignSuiInput {
    /// BCS-encoded `TransactionData`, base64-encoded. The TS caller
    /// constructs this; Rust never builds Sui transactions itself.
    pub tx_bytes_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedSui {
    /// Sui-format wire signature: flag (1) || sig (64) || pubkey (32) = 97 bytes.
    /// Base64-encoded for Sui RPC's `signatures: [...]` field.
    pub signature_base64: String,
    /// Full 32-byte ed25519 public key, base64. Useful for the TS layer
    /// to build PaySui-style commands that reference the sender's pubkey
    /// independent of the signature itself.
    pub public_key_base64: String,
}

/// Sign a Sui TransactionData with ed25519. Wraps the bytes in the intent
/// envelope, BLAKE2b-256-hashes, and signs.
pub fn sign_tx(secret: &[u8; 32], input: &SignSuiInput) -> Result<SignedSui, SuiError> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    let tx_bytes = B64
        .decode(input.tx_bytes_base64.as_bytes())
        .map_err(|e| SuiError::BadBase64(e.to_string()))?;

    // intent || tx_bytes
    let mut to_hash = Vec::with_capacity(3 + tx_bytes.len());
    to_hash.extend_from_slice(&INTENT_TRANSACTION_DATA);
    to_hash.extend_from_slice(&tx_bytes);
    let digest = blake2b_256(&to_hash);

    let signing = SigningKey::from_bytes(secret);
    let pk = signing.verifying_key().to_bytes();
    let sig = signing.sign(&digest);

    // Wire format: flag || sig || pubkey (97 bytes).
    let mut wire = Vec::with_capacity(1 + 64 + 32);
    wire.push(SIGNATURE_SCHEME_ED25519);
    wire.extend_from_slice(&sig.to_bytes());
    wire.extend_from_slice(&pk);

    Ok(SignedSui {
        signature_base64: B64.encode(&wire),
        public_key_base64: B64.encode(pk),
    })
}

/// Sui public key from secret — used by the address-derivation surface.
pub fn sui_public_key(secret: &[u8; 32]) -> [u8; 32] {
    let signing = SigningKey::from_bytes(secret);
    signing.verifying_key().to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    /// Pin the BLAKE2b-256 of a known input. Catches future drift in the
    /// blake2 dep.
    #[test]
    fn blake2b_256_known_vector() {
        let h = blake2b_256(b"hello");
        // BLAKE2b-256("hello") computed independently via official spec.
        // The 32-byte digest below is the canonical value.
        assert_eq!(
            hex::encode(h),
            "324dcf027dd4a30a932c441f365a25e86b173defa4b8e58948253471b81b72cf"
        );
    }

    /// Address shape: `0x` + 64 hex chars. Lock the format.
    #[test]
    fn address_shape() {
        let pk = [0x42u8; 32];
        let addr = sui_address(&pk);
        assert_eq!(addr.len(), 66);
        assert!(addr.starts_with("0x"));
        for c in addr[2..].chars() {
            assert!(c.is_ascii_hexdigit() && (c.is_ascii_digit() || c.is_ascii_lowercase()));
        }
    }

    /// Sign roundtrip: derive secret, sign, decode wire signature, verify
    /// length + flag + pubkey location.
    #[test]
    fn derive_then_sign_roundtrip() {
        let seed = [0x42u8; 64];
        let sk = sui_secret_from_seed(&seed);
        let pk = sui_public_key(&sk);

        let input = SignSuiInput {
            tx_bytes_base64: B64.encode([1u8; 16]),
        };
        let signed = sign_tx(&sk, &input).unwrap();
        let wire = B64.decode(&signed.signature_base64).unwrap();
        assert_eq!(wire.len(), 97);
        assert_eq!(wire[0], SIGNATURE_SCHEME_ED25519);
        assert_eq!(&wire[65..], &pk[..]);
    }
}
