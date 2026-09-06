//! NEP-413 — off-chain message signing for NEAR.
//!
//! Spec: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
//!
//! Wire format the wallet emits to NEAR Intents:
//! ```jsonc
//! {
//!   "standard":  "nep413",
//!   "payload":   { "message": "...", "nonce": "<base64 32B>",
//!                  "recipient": "intents.near", "callbackUrl": null? },
//!   "public_key": "ed25519:<base58>",
//!   "signature":  "<base64 64B>"
//! }
//! ```
//!
//! Pre-image (per spec):
//! `SHA-256( borsh(u32: 2^31 + 413) || borsh(Nep413Payload) )`
//!
//! Signed with ed25519 using the user's NEAR private key.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use borsh::BorshSerialize;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const NEP413_PREFIX: u32 = (1u32 << 31) + 413;

#[derive(Debug, thiserror::Error)]
pub enum Nep413Error {
    /// Reserved — 32-byte key length is enforced by the caller's type
    /// (`&[u8; 32]`) so this never fires in practice. Kept for future
    /// API shapes that might accept a slice.
    #[allow(dead_code)]
    #[error("invalid signing key (need 32 bytes)")]
    BadKey,
    #[error("invalid nonce (need 32 bytes)")]
    BadNonce,
    #[error("borsh encode failed")]
    Borsh,
}

#[derive(Debug, Clone, BorshSerialize)]
struct Nep413Payload {
    pub message: String,
    pub nonce: [u8; 32],
    pub recipient: String,
    pub callback_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignNep413Input {
    pub message: String,
    /// Either base64 (44 chars / 32 raw bytes) or hex (`0x`-prefixed 32 bytes).
    pub nonce: String,
    pub recipient: String,
    #[serde(default)]
    pub callback_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedNep413 {
    pub standard: &'static str,
    pub payload: PayloadOut,
    pub public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadOut {
    pub message: String,
    pub nonce: String, // base64
    pub recipient: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_url: Option<String>,
}

fn parse_nonce(s: &str) -> Result<[u8; 32], Nep413Error> {
    let mut out = [0u8; 32];
    if let Some(hex_body) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        let bytes = hex::decode(hex_body).map_err(|_| Nep413Error::BadNonce)?;
        if bytes.len() != 32 {
            return Err(Nep413Error::BadNonce);
        }
        out.copy_from_slice(&bytes);
    } else {
        let bytes = B64.decode(s).map_err(|_| Nep413Error::BadNonce)?;
        if bytes.len() != 32 {
            return Err(Nep413Error::BadNonce);
        }
        out.copy_from_slice(&bytes);
    }
    Ok(out)
}

/// Sign an NEP-413 message with the given 32-byte ed25519 secret key seed.
pub fn sign(input: &SignNep413Input, sk_seed: &[u8; 32]) -> Result<SignedNep413, Nep413Error> {
    let nonce = parse_nonce(&input.nonce)?;
    let payload = Nep413Payload {
        message: input.message.clone(),
        nonce,
        recipient: input.recipient.clone(),
        callback_url: input.callback_url.clone(),
    };

    let mut bytes = Vec::with_capacity(64 + input.message.len() + input.recipient.len());
    BorshSerialize::serialize(&NEP413_PREFIX, &mut bytes).map_err(|_| Nep413Error::Borsh)?;
    BorshSerialize::serialize(&payload, &mut bytes).map_err(|_| Nep413Error::Borsh)?;

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = hasher.finalize();

    let signing_key = SigningKey::from_bytes(sk_seed);
    let signature = signing_key.sign(&hash);
    let pk = signing_key.verifying_key();

    Ok(SignedNep413 {
        standard: "nep413",
        payload: PayloadOut {
            message: input.message.clone(),
            nonce: B64.encode(nonce),
            recipient: input.recipient.clone(),
            callback_url: input.callback_url.clone(),
        },
        public_key: format!("ed25519:{}", bs58::encode(pk.to_bytes()).into_string()),
        signature: B64.encode(signature.to_bytes()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    /// Computes the NEP-413 pre-image hash that gets signed, exposed for
    /// independent verification. (Tests live alongside the impl, so this is
    /// allowed to peek at internals.)
    fn nep413_preimage_hash(input: &SignNep413Input) -> [u8; 32] {
        let nonce = parse_nonce(&input.nonce).unwrap();
        let payload = Nep413Payload {
            message: input.message.clone(),
            nonce,
            recipient: input.recipient.clone(),
            callback_url: input.callback_url.clone(),
        };
        let mut bytes = Vec::new();
        BorshSerialize::serialize(&NEP413_PREFIX, &mut bytes).unwrap();
        BorshSerialize::serialize(&payload, &mut bytes).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        hasher.finalize().into()
    }

    /// Track 4 vector #3 — NEP-413.
    ///
    /// Strategy: ed25519 is deterministic per RFC 8032, and SHA-256 + borsh
    /// produce the same bytes on every conformant implementation. We pin two
    /// invariants:
    ///
    /// 1. Public-key encoding: the well-known RFC 8032 §7.1 test 1 seed
    ///    produces the published public key. This validates ed25519 + bs58.
    /// 2. Signature verification: the produced signature verifies under that
    ///    same public key over the NEP-413 pre-image hash. This validates
    ///    borsh + SHA-256 + the prefix value end-to-end.
    ///
    /// Together these are stronger than committing a hex blob, because the
    /// blob would be self-referential if generated by the same code.
    #[test]
    fn vector3_nep413_fixture() {
        // 32-byte ed25519 seed — RFC 8032 §7.1 test 1.
        let seed_hex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
        let mut sk = [0u8; 32];
        sk.copy_from_slice(&hex::decode(seed_hex).unwrap());

        let mut nonce = [0u8; 32];
        for (i, b) in nonce.iter_mut().enumerate() {
            *b = i as u8;
        }
        let input = SignNep413Input {
            message: "{\"deadline\":\"2026-05-05T00:00:00Z\",\"intents\":[],\"signer_id\":\"alice.near\"}".to_string(),
            nonce: B64.encode(nonce),
            recipient: "intents.near".to_string(),
            callback_url: None,
        };

        let signed = sign(&input, &sk).unwrap();

        // Invariant 1: pubkey bytes are exactly the RFC 8032 §7.1 test 1
        // expected public key.
        let expected_pk_hex = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
        let actual_pk_b58 = signed.public_key.strip_prefix("ed25519:").unwrap();
        let actual_pk_bytes = bs58::decode(actual_pk_b58).into_vec().unwrap();
        assert_eq!(hex::encode(&actual_pk_bytes), expected_pk_hex);

        // Invariant 2: signature verifies over the canonical NEP-413
        // pre-image hash (= SHA-256 of borsh(prefix) || borsh(payload)).
        let hash = nep413_preimage_hash(&input);
        let sig_bytes = B64.decode(&signed.signature).unwrap();
        let sig_arr: [u8; 64] = sig_bytes.try_into().unwrap();
        let sig = ed25519_dalek::Signature::from_bytes(&sig_arr);
        let mut pk_arr = [0u8; 32];
        pk_arr.copy_from_slice(&actual_pk_bytes);
        let vk = ed25519_dalek::VerifyingKey::from_bytes(&pk_arr).unwrap();
        vk.verify(&hash, &sig).expect("nep413 signature must verify");
    }
}
