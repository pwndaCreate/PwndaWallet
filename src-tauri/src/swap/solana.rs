//! Solana ed25519 signing — minimal scope.
//!
//! v1 limit: signs a pre-built Solana **message** (the deterministic part of
//! a transaction; per Solana RFC the wallet signs the serialized message
//! bytes, not the full tx). The proxy `/v3/swap` for SwapKit's Jupiter routes
//! returns these bytes; the client signs them, prepends signatures, and
//! re-serializes for broadcast.
//!
//! Solana message construction (the harder bits — recent blockhash, account
//! ordering, instruction packing) lives in `solana-sdk`, which is gigantic.
//! We avoid pulling that dep and trust the proxy's swap endpoint to hand us
//! ready-to-sign bytes. For v2 we may bring in `solana-message-bin` or a
//! similar focused crate.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::Sha512;
use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum SolError {
    #[error("invalid base64 message: {0}")]
    BadBase64(String),
    #[error("invalid hex message: {0}")]
    BadHex(String),
    /// Reserved — same reason as `Nep413Error::BadKey`. Caller passes a
    /// `&[u8; 32]` so length is type-enforced.
    #[allow(dead_code)]
    #[error("invalid seed (need 32 bytes)")]
    BadSeed,
}

/// Derive the 32-byte ed25519 seed for the Solana account at the standard
/// Phantom/Solflare path `m/44'/501'/0'/0'`. Uses SLIP-10 ed25519 hardened
/// derivation (same scheme as NEAR).
pub fn sol_secret_from_seed(seed: &[u8]) -> Zeroizing<[u8; 32]> {
    use hmac::{Hmac, Mac};
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
        501u32 | 0x8000_0000,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignSolanaInput {
    /// Either base64-encoded (preferred) or `0x`-prefixed hex.
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedSolana {
    pub public_key: String,
    /// 64-byte ed25519 signature, base58 encoded (Solana's canonical encoding).
    pub signature: String,
}

pub fn sign_message(secret: &[u8; 32], input: &SignSolanaInput) -> Result<SignedSolana, SolError> {
    let bytes = if let Some(hex_body) =
        input.message.strip_prefix("0x").or_else(|| input.message.strip_prefix("0X"))
    {
        hex::decode(hex_body).map_err(|e| SolError::BadHex(e.to_string()))?
    } else {
        B64.decode(&input.message).map_err(|e| SolError::BadBase64(e.to_string()))?
    };
    let sk = SigningKey::from_bytes(secret);
    let sig = sk.sign(&bytes);
    let pk = sk.verifying_key();
    Ok(SignedSolana {
        public_key: bs58::encode(pk.to_bytes()).into_string(),
        signature: bs58::encode(sig.to_bytes()).into_string(),
    })
}
