//! Vault decryption that mirrors the JS `crypto.ts` scheme so a single
//! passphrase unlocks both worlds.
//!
//! Format (input):
//! ```jsonc
//! {
//!   "salt":       "<base64 16 bytes>",
//!   "iv":         "<base64 12 bytes>",
//!   "ciphertext": "<base64 plaintext_aes_gcm_256_with_16B_tag_appended>"
//! }
//! ```
//!
//! KDF: `PBKDF2-HMAC-SHA256`, 600 000 iterations, 32-byte output.
//! Cipher: `AES-256-GCM`, 12-byte IV, 16-byte auth tag (default for AES-GCM-256).
//!
//! The plaintext is the JSON-stringified `VaultPayload` (see `src/store.ts`).

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

const PBKDF2_ITERATIONS: u32 = 600_000;
const KEY_LEN: usize = 32;

#[derive(Debug, Deserialize)]
pub struct EncryptedVault {
    pub salt: String,
    pub iv: String,
    pub ciphertext: String,
}

/// Plaintext shape — kept in lockstep with `src/store.ts::VaultPayload`.
/// Only the fields the swap module actually needs are decoded here.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct VaultPayload {
    pub v: u32,
    pub bip39: String,
    #[serde(default)]
    pub xmr_seed: Option<String>,
    #[serde(default, rename = "xmrSeedFormat")]
    pub xmr_seed_format: Option<String>,
    #[serde(default, rename = "xmrRestoreHeight")]
    pub xmr_restore_height: Option<u64>,
    #[serde(default, rename = "zphSeed")]
    pub zph_seed: Option<String>,
    #[serde(default, rename = "zphRestoreHeight")]
    pub zph_restore_height: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("base64 decode failed for {field}")]
    BadBase64 { field: &'static str },
    #[error("salt must be 16 bytes (got {0})")]
    BadSaltLength(usize),
    #[error("iv must be 12 bytes (got {0})")]
    BadIvLength(usize),
    #[error("decryption failed (wrong password or corrupted vault)")]
    Decrypt,
    #[error("vault payload was not valid JSON")]
    BadJson,
    #[error("vault has no bip39 mnemonic")]
    MissingMnemonic,
}

/// Decrypt the vault using `password`. The returned mnemonic is wrapped so it
/// is wiped from memory when dropped.
pub fn decrypt_vault(
    enc: &EncryptedVault,
    password: &str,
) -> Result<Zeroizing<String>, VaultError> {
    let salt = B64
        .decode(&enc.salt)
        .map_err(|_| VaultError::BadBase64 { field: "salt" })?;
    if salt.len() != 16 {
        return Err(VaultError::BadSaltLength(salt.len()));
    }
    let iv = B64
        .decode(&enc.iv)
        .map_err(|_| VaultError::BadBase64 { field: "iv" })?;
    if iv.len() != 12 {
        return Err(VaultError::BadIvLength(iv.len()));
    }
    let ciphertext = B64
        .decode(&enc.ciphertext)
        .map_err(|_| VaultError::BadBase64 { field: "ciphertext" })?;

    // Derive 32-byte AES key.
    let mut key_bytes = Zeroizing::new([0u8; KEY_LEN]);
    pbkdf2::pbkdf2_hmac::<Sha256>(
        password.as_bytes(),
        &salt,
        PBKDF2_ITERATIONS,
        &mut key_bytes[..],
    );

    let key = Key::<Aes256Gcm>::from_slice(&key_bytes[..]);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(&iv);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| VaultError::Decrypt)?;

    // Move the plaintext into a Zeroizing<String> immediately.
    let plaintext_str: Zeroizing<String> = Zeroizing::new(
        String::from_utf8(plaintext).map_err(|_| VaultError::BadJson)?,
    );

    let bip39 = bip39_from_payload(&plaintext_str)?;
    if bip39.trim().is_empty() {
        return Err(VaultError::MissingMnemonic);
    }
    Ok(Zeroizing::new(bip39))
}

/// Pull the BIP-39 mnemonic out of a decrypted vault, v2 **or** v3.
///
/// # Why this is not a plain `serde_json::from_str::<VaultPayload>`
///
/// It was, and it broke every caller the moment the vault moved to v3. `v3`
/// has no top-level `bip39` — it holds `wallets: [{ kind, seed, ... }]` — and
/// `VaultPayload::bip39` is a non-`Option` `String`, so serde failed the whole
/// parse and the user saw `vault payload was not valid JSON` on a vault that
/// was perfectly valid. The message actively misled: it names the payload as
/// the broken thing when the reader was what had gone stale.
///
/// This is the paired-site shape again — `src/vault-schema.ts` and this struct
/// are two representations of one schema, and only one of them was migrated.
/// The comment above `VaultPayload` said "kept in lockstep with
/// `src/store.ts::VaultPayload`", which was true when written and became false
/// silently, because a comment cannot notice a schema bump.
///
/// # Which wallet is chosen, for v3
///
/// Mirrors `vault-schema.ts::projectV3ToV2` under its default (no active
/// wallet): `groupIdForWallet` falls back to `primaryGroupId`, which is the
/// group of the FIRST `kind === "bip39"` entry — so the first bip39 wallet is
/// the default there and here. When `lastActiveWalletId` is present its group
/// wins, matching the same function's non-default branch. Getting this wrong
/// would hand the swap engine a different seed than the UI is showing, so it
/// follows the TS rule rather than inventing one.
fn bip39_from_payload(plaintext: &str) -> Result<String, VaultError> {
    let value: serde_json::Value =
        serde_json::from_str(plaintext).map_err(|_| VaultError::BadJson)?;

    // Absent `v` means the oldest flat shape; treat it as v2 rather than failing.
    let version = value.get("v").and_then(serde_json::Value::as_u64).unwrap_or(2);
    if version < 3 {
        let parsed: VaultPayload =
            serde_json::from_value(value).map_err(|_| VaultError::BadJson)?;
        return Ok(parsed.bip39);
    }

    let wallets = value
        .get("wallets")
        .and_then(serde_json::Value::as_array)
        .ok_or(VaultError::BadJson)?;

    let kind_of = |w: &serde_json::Value| -> Option<String> {
        w.get("kind").and_then(serde_json::Value::as_str).map(str::to_owned)
    };
    // groupKey(w) = w.groupId ?? w.id
    let group_key = |w: &serde_json::Value| -> Option<String> {
        w.get("groupId")
            .and_then(serde_json::Value::as_str)
            .or_else(|| w.get("id").and_then(serde_json::Value::as_str))
            .map(str::to_owned)
    };
    let is_bip39 = |w: &&serde_json::Value| kind_of(w).as_deref() == Some("bip39");

    // primaryGroupId: the group of the first bip39 entry, else of the first entry.
    let primary_group = wallets
        .iter()
        .find(is_bip39)
        .or_else(|| wallets.first())
        .and_then(group_key);

    let active_id = value
        .get("lastActiveWalletId")
        .and_then(serde_json::Value::as_str)
        .filter(|id| *id != "all");
    let wanted_group = active_id
        .and_then(|id| {
            wallets
                .iter()
                .find(|w| w.get("id").and_then(serde_json::Value::as_str) == Some(id))
                .and_then(group_key)
        })
        .or(primary_group);

    let chosen = wallets
        .iter()
        .filter(is_bip39)
        .find(|w| wanted_group.is_none() || group_key(w) == wanted_group)
        // A vault whose active group has no bip39 entry (e.g. an XMR-only
        // group) still has one elsewhere; fall back rather than report the
        // vault as seedless, which reads as corruption.
        .or_else(|| wallets.iter().find(is_bip39));

    Ok(chosen
        .and_then(|w| w.get("seed").and_then(serde_json::Value::as_str))
        .unwrap_or_default()
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit};
    use sha2::Sha256;

    /// Reproduces the exact JS `encrypt()` from `src/crypto.ts` so we can
    /// round-trip a fixture without bringing in node.
    fn encrypt_for_test(plaintext: &str, password: &str) -> EncryptedVault {
        let salt: [u8; 16] = [42u8; 16];
        let iv: [u8; 12] = [7u8; 12];
        let mut key = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(
            password.as_bytes(),
            &salt,
            PBKDF2_ITERATIONS,
            &mut key,
        );
        let cipher = Aes256Gcm::new((&key).into());
        let ct = cipher.encrypt((&iv).into(), plaintext.as_bytes()).unwrap();
        EncryptedVault {
            salt: B64.encode(salt),
            iv: B64.encode(iv),
            ciphertext: B64.encode(ct),
        }
    }

    /// The v3 vault the app actually writes today. Before `bip39_from_payload`
    /// this failed the whole parse -- `VaultPayload::bip39` is a non-Option
    /// String and v3 has no top-level `bip39` -- and every caller surfaced
    /// "vault payload was not valid JSON" for a completely valid vault.
    #[test]
    fn v3_payload_yields_the_bip39_wallets_seed() {
        let payload = serde_json::json!({
            "v": 3,
            "wallets": [
                { "id": "w-xmr", "name": "Main", "kind": "xmr", "seed": "xmr words", "createdAt": 1 },
                { "id": "w-b39", "name": "Wallet", "kind": "bip39", "seed": "abandon ability able", "createdAt": 2 }
            ]
        })
        .to_string();
        assert_eq!(
            bip39_from_payload(&payload).unwrap(),
            "abandon ability able"
        );
    }

    /// v2 must keep working byte-for-byte -- the v3 branch is additive.
    #[test]
    fn v2_payload_still_reads_the_flat_field() {
        let payload = serde_json::json!({ "v": 2, "bip39": "flat words" }).to_string();
        assert_eq!(bip39_from_payload(&payload).unwrap(), "flat words");
    }

    /// `lastActiveWalletId` selects its GROUP's bip39 entry, mirroring
    /// `vault-schema.ts::groupIdForWallet`. Picking the wrong one would hand
    /// the swap engine a different seed than the UI shows.
    #[test]
    fn v3_honours_the_active_wallets_group() {
        let payload = serde_json::json!({
            "v": 3,
            "lastActiveWalletId": "w-xmr-b",
            "wallets": [
                { "id": "w-b39-a", "kind": "bip39", "seed": "group a seed", "groupId": "g-a", "createdAt": 1 },
                { "id": "w-xmr-b", "kind": "xmr",   "seed": "xmr b",        "groupId": "g-b", "createdAt": 2 },
                { "id": "w-b39-b", "kind": "bip39", "seed": "group b seed", "groupId": "g-b", "createdAt": 3 }
            ]
        })
        .to_string();
        assert_eq!(bip39_from_payload(&payload).unwrap(), "group b seed");
    }

    /// With no active id, the default is the FIRST bip39 entry -- which is what
    /// `primaryGroupId` resolves to on the TS side.
    #[test]
    fn v3_without_an_active_id_takes_the_first_bip39() {
        let payload = serde_json::json!({
            "v": 3,
            "wallets": [
                { "id": "w1", "kind": "bip39", "seed": "first", "groupId": "g1", "createdAt": 1 },
                { "id": "w2", "kind": "bip39", "seed": "second", "groupId": "g2", "createdAt": 2 }
            ]
        })
        .to_string();
        assert_eq!(bip39_from_payload(&payload).unwrap(), "first");
    }

    /// A seedless vault must report MissingMnemonic through decrypt_vault, not
    /// BadJson: "no mnemonic" and "unparseable" send a reader to different bugs.
    #[test]
    fn v3_with_no_bip39_entry_is_empty_not_a_parse_error() {
        let payload = serde_json::json!({
            "v": 3,
            "wallets": [{ "id": "w-xmr", "kind": "xmr", "seed": "xmr only", "createdAt": 1 }]
        })
        .to_string();
        assert_eq!(bip39_from_payload(&payload).unwrap(), "");
    }

    /// Genuinely malformed input must still be BadJson.
    #[test]
    fn non_json_is_still_a_parse_error() {
        assert!(matches!(
            bip39_from_payload("not json at all"),
            Err(VaultError::BadJson)
        ));
    }

    /// FALSIFICATION, kept permanently: the pre-fix approach -- deserialising a
    /// v3 payload straight into `VaultPayload` -- must still fail. If this ever
    /// starts passing, `VaultPayload` has gained a defaulted `bip39` and would
    /// silently hand callers an EMPTY mnemonic instead of erroring, which is
    /// worse than the bug this replaced.
    #[test]
    fn the_old_direct_deserialise_still_cannot_read_v3() {
        let v3 = serde_json::json!({
            "v": 3,
            "wallets": [{ "id": "w", "kind": "bip39", "seed": "s", "createdAt": 1 }]
        })
        .to_string();
        assert!(serde_json::from_str::<VaultPayload>(&v3).is_err());
        // ...while the replacement reads it fine.
        assert_eq!(bip39_from_payload(&v3).unwrap(), "s");
    }

    #[test]
    fn decrypt_round_trip() {
        let payload = serde_json::json!({
            "v": 2,
            "bip39": "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "xmrSeed": null
        });
        let pt = serde_json::to_string(&payload).unwrap();
        let enc = encrypt_for_test(&pt, "hunter2");
        let m = decrypt_vault(&enc, "hunter2").expect("decrypt should succeed");
        assert!(m.starts_with("abandon abandon"));
    }

    #[test]
    fn decrypt_wrong_password() {
        let payload = serde_json::json!({
            "v": 2,
            "bip39": "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        });
        let pt = serde_json::to_string(&payload).unwrap();
        let enc = encrypt_for_test(&pt, "hunter2");
        let r = decrypt_vault(&enc, "wrong");
        assert!(matches!(r, Err(VaultError::Decrypt)));
    }
}
