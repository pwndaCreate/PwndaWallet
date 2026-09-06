//! NEAR account-key derivation for the 1Click flow + NEP-413 messages.
//!
//! Scope: derive an ed25519 keypair from the BIP-39 seed at SLIP-44 path
//! `m/44'/397'/0'`, expose its public key as the NEAR account ID hex,
//! and sign NEP-413 messages (handled in [`super::nep413`]). Arbitrary
//! borsh-encoded NEAR transactions are signed via the
//! `swap_sign_near_tx` Tauri command (in [`super::commands`]) — that
//! command takes raw bytes and signs with the same key derived here.

use ed25519_dalek::SigningKey;
use sha2::Sha512;
use zeroize::Zeroizing;

/// Derive the 32-byte ed25519 seed (= the secret key) for the NEAR account
/// at `m/44'/397'/0'`. We use the SLIP-10 ed25519 derivation specified in
/// SLIP-0010, which is the same one near-cli-rs and Ledger use.
///
/// SLIP-10 ed25519 derivation: at each step, the chain code + index are HMAC-
/// SHA512-keyed by the parent chain code; left half is the new key, right
/// half is the new chain code. Hardened derivation only (always `'`).
pub fn near_secret_from_seed(seed: &[u8]) -> Zeroizing<[u8; 32]> {
    // Master from "ed25519 seed" per SLIP-10.
    let i = hmac_sha512(b"ed25519 seed", seed);
    let mut key = [0u8; 32];
    key.copy_from_slice(&i[..32]);
    let mut cc = [0u8; 32];
    cc.copy_from_slice(&i[32..]);

    // m/44'/397'/0' — three hardened steps.
    for idx in [44u32 | 0x8000_0000, 397u32 | 0x8000_0000, 0u32 | 0x8000_0000] {
        let mut data = Vec::with_capacity(1 + 32 + 4);
        data.push(0x00);
        data.extend_from_slice(&key);
        data.extend_from_slice(&idx.to_be_bytes());
        let h = hmac_sha512(&cc, &data);
        key.copy_from_slice(&h[..32]);
        cc.copy_from_slice(&h[32..]);
    }
    Zeroizing::new(key)
}

fn hmac_sha512(key: &[u8], data: &[u8]) -> [u8; 64] {
    use hmac::{Hmac, Mac};
    let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data);
    let result = mac.finalize().into_bytes();
    let mut out = [0u8; 64];
    out.copy_from_slice(&result);
    out
}

/// Public NEAR account form: `ed25519:<base58(32 raw pubkey bytes)>`.
pub fn public_key(secret: &[u8; 32]) -> String {
    let sk = SigningKey::from_bytes(secret);
    let pk = sk.verifying_key();
    format!("ed25519:{}", bs58::encode(pk.to_bytes()).into_string())
}

// `sign_near_transfer` and `SignNearTransferInput` were earlier-draft
// stubs for an on-chain Transfer-action signer. Removed 2026-05-06
// because the current flow signs the borsh-encoded transaction bytes
// via `swap_sign_near_tx` (in `commands.rs`) — that's a generic-bytes
// signer keyed off the same derivation, called from
// `executeNearNativeTransfer` in `swap-sources.ts` after the JS layer
// borsh-encodes the Transaction itself.
