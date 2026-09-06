//! Durable, encrypted swap-state store — the wallet's claim/refund capability.
//!
//! Losing this after a lock = losing funds. A multi-step atomic swap holds value
//! in a joint 2-of-2 output for T+10-60 min; the material needed to claim or
//! refund (the per-swap secret scalar share, the pre-signed refund/reclaim sigs,
//! the adaptor/joint points, the lock txids, the T0/T1 deadlines) MUST survive an
//! app restart, or the background refund watcher can never fire. This module is
//! the persistence the Go harness didn't need (it ran in one process); the real
//! wallet cannot.
//!
//! ## At rest
//!
//! One AES-256-GCM-sealed file per swap under `<data_dir>/desk-swaps/<id>.enc`
//! (next to `wallet.dat`, like the other sidecar files). Format: a random 12-byte
//! nonce prepended to the ciphertext. The swap id is the AEAD **associated data**,
//! so a record is cryptographically bound to its filename — a file copied to
//! another id's name fails authentication rather than silently loading.
//!
//! The key is a dedicated 32-byte secret in the OS keyring
//! ([`crate::auth_keypair::KeyringAccount::DESK_STORE`]) — separate from the
//! ed25519 signing seed, and readable WITHOUT a password prompt so the refund
//! watchers can rehydrate at startup ([`DeskStore::load_all`]).
//!
//! ## Zeroize story
//!
//! [`StoredSwap`] derives `ZeroizeOnDrop`, so every field (including the secret
//! scalar share, view key, and pre-signatures) is wiped when a record drops. The
//! decrypted plaintext buffer is held in `Zeroizing<Vec<u8>>` and wiped after
//! deserialization. No `Debug` is derived — the secret material never lands in a
//! log line.

#![allow(dead_code)] // consumed by desk/commands.rs + the Stage-A driver + startup rehydrate (later)

use std::io::Write;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use super::wire;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("desk-store key error: {0}")]
    Key(String),
    #[error("io: {0}")]
    Io(String),
    #[error("encryption failed")]
    Encrypt,
    #[error("decryption/authentication failed for swap {0} (wrong key, tampered, or wrong id)")]
    Decrypt(String),
    #[error("corrupt record for swap {0}: {1}")]
    Corrupt(String, &'static str),
    #[error("serialization: {0}")]
    Serde(String),
    #[error("invalid swap id (must be non-empty, <=128 chars, [A-Za-z0-9_-])")]
    InvalidId,
}

/// The durable record for one in-flight swap. Fields are filled in as the swap
/// progresses (seeded at accept-time from M1, then updated through keys/lock).
/// No `Debug` — it holds secret material. `ZeroizeOnDrop` wipes it on drop.
#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct StoredSwap {
    // --- identity + terms ---
    pub swap_id: String,
    pub pair: String,
    pub direction: String,
    /// The desk's role ("LEADER" | "FOLLOWER"); the client is always the
    /// opposite. Kept as the raw string so [`engine::ClientRole::from_desk_role`]
    /// reconstructs the role after a restart.
    pub desk_role: String,
    pub amount_a: String,
    pub amount_b: String,
    /// Last-known desk state string (e.g. "A_LOCKED"). Advisory; the engine
    /// re-derives what is safe to do from its own observation on rehydrate.
    pub state: String,

    // --- addresses ---
    pub payout_address: String,
    pub refund_address: String,
    pub script_address: String,
    pub chain_a_lock_addr: Option<String>,
    pub chain_b_joint_addr: Option<String>,
    pub chain_b_joint_key: Option<String>,

    // --- desk-provided points (from M1) ---
    pub desk_key_share_point: String,
    pub desk_chain_a_pubkey: String,
    pub adaptor_point: Option<String>,
    pub view_key: Option<String>,
    pub dleq_proof: Option<String>,
    /// The leader-proof capability as NEGOTIATED for this swap — the desk's M1
    /// answer, not our request and not the current config.
    ///
    /// It rides the swap record for the same reason `t2_engine_slot` above does:
    /// a swap rehydrated after a restart must validate the way it HANDSHOOK. If
    /// this were read from config at rehydrate time, flipping the setting
    /// between a lock and its recovery would change the shape a live swap
    /// expects, and the mismatch would surface as a validator rejecting a
    /// message the counterparty believed was correct.
    ///
    /// `#[serde(default)]` so records written before the capability existed load
    /// as `false`, which is what they in fact negotiated.
    #[serde(default)]
    pub leader_proof: bool,

    // --- client-side material (filled as the swap progresses) ---
    pub client_key_share_point: Option<String>,
    /// Handle to the SIDECAR's encrypted state for this swap. The spend-scalar
    /// share lives THERE, never here — so this store holds no spend authority at
    /// all, only the pointer needed to address the engine after a restart.
    pub engine_ref: Option<String>,
    /// Pre-signed refund (reclaim-our-own-coin) adaptor pre-signature, split into
    /// its two hex halves. Signed BEFORE any funds move so recovery is always
    /// possible.
    pub refund_presig_r_enc: Option<String>,
    pub refund_presig_sp: Option<String>,
    /// Pre-signed claim adaptor pre-signature (when the desk returns one at M3).
    pub claim_presig_r_enc: Option<String>,
    pub claim_presig_sp: Option<String>,

    // --- lock txids (our own broadcast + the observed counterparty lock) ---
    pub lock_a_txid: Option<String>,
    pub lock_b_txid: Option<String>,

    /// The LEADER's chain-A refund, once we have seen one. Not a failure record
    /// — publishing it leaks `s_a`, which is what lets us reclaim chain B
    /// (abort-table row 2). Persisted so a restart mid-reclaim can resume
    /// without having to ask the desk for the txid again, which matters because
    /// the desk may be exactly what went away.
    ///
    /// `#[serde(default)]`, like `key_provenance`: records written before this
    /// field existed load with `None` rather than failing to decrypt.
    #[serde(default)]
    pub refund_txid: Option<String>,
    /// Our chain-B reclaim, once broadcast. Its presence is what stops a later
    /// watcher re-firing.
    #[serde(default)]
    pub reclaim_txid: Option<String>,

    // --- deadlines (absolute; unix seconds, plus Cardano slots when present) ---
    pub t0: i64,
    pub t1: i64,
    pub t2: i64,
    pub t1_slot: Option<i64>,
    pub t2_slot: Option<i64>,

    /// CC-2 (T2 provenance): the T2 committed by the ENGINE THAT ACTS on the
    /// chain-A leg, kept SEPARATE from the wire's `t2`/`t2_slot` above — those
    /// are the desk's ADVERTISEMENT, and on the 2026-07-30 rung the two
    /// disagreed by 1200s (D48): a swipe signed against the advertisement
    /// carries `invalid_before` in the future and the node rejects it.
    ///
    /// Deliberately a SECOND field rather than an overwrite: keeping both is
    /// what makes a future disagreement visible instead of silently resolved.
    ///
    /// Provenance by role — derive from the layer that ACTS on the leg:
    ///  - we LEAD: our own engine's derived `t2_slot` (the value we send in M2;
    ///    the desk's copy is an echo of us)
    ///  - we FOLLOW: `AcceptResponse.t2Slot` (the desk's engine commits its own
    ///    chain-A slots), else the desk's `effective-config` `ada` block
    ///  - neither readable: `None` — could-not-look. The deep abort REFUSES to
    ///    arm on `None` and never falls back to the advertised `t2`.
    #[serde(default)]
    pub t2_engine_slot: Option<i64>,
    /// The unix-seconds projection of `t2_engine_slot` for local SCHEDULING
    /// (the deep-abort decision, the swipe watcher, the C46 hold). Anchored as
    /// `t1 + (engine T2 slot − engine T1 slot)`: 1 slot = 1 s on
    /// preprod/mainnet, so the engine's DELTA rides on the same wall-clock T1
    /// anchor the T1 refund watcher already runs on. The slot above stays the
    /// authoritative chain fact; this is its clock shadow.
    #[serde(default)]
    pub t2_engine_unix: Option<i64>,

    /// When this record was created (unix seconds), for housekeeping.
    pub created_at: i64,

    /// Where this swap's key material came from ("mock" | "vendored").
    ///
    /// Persisted because a refund attempted LATER — possibly after an app
    /// upgrade — has to know whether the pre-signatures on disk are real. It
    /// defaults to "mock", which is the SAFE default: mock material is refused
    /// by the broadcaster rather than published. See `desk::crypto`.
    #[serde(default)]
    pub key_provenance: String,
}

impl StoredSwap {
    /// Seed a durable record from the M1 accept response at accept-time. The
    /// client-side material (`client_key_share_point`, `engine_ref`,
    /// presigs, lock txids) are `None` until the handshake fills them in.
    pub fn from_accept(
        m1: &wire::AcceptResponse,
        payout_address: &str,
        refund_address: &str,
        created_at: i64,
    ) -> Self {
        Self {
            // Straight off M1: the negotiated answer, so a rehydrated swap
            // validates the way it handshook rather than the way config reads now.
            leader_proof: m1.leader_proof,
            swap_id: m1.swap_id.clone(),
            pair: m1.pair.clone(),
            direction: m1.direction.clone(),
            desk_role: m1.desk_role.clone(),
            amount_a: m1.amount_a.clone(),
            amount_b: m1.amount_b.clone(),
            state: "ACCEPTED".to_string(),
            payout_address: payout_address.to_string(),
            refund_address: refund_address.to_string(),
            script_address: m1.script_address.clone(),
            chain_a_lock_addr: None,
            chain_b_joint_addr: None,
            chain_b_joint_key: None,
            desk_key_share_point: m1.desk_key_share_point.clone(),
            desk_chain_a_pubkey: m1.desk_chain_a_pubkey.clone(),
            adaptor_point: m1.adaptor_point.clone(),
            view_key: m1.view_key.clone(),
            dleq_proof: m1.dleq_proof.clone(),
            client_key_share_point: None,
            engine_ref: None,
            refund_presig_r_enc: None,
            refund_presig_sp: None,
            claim_presig_r_enc: None,
            claim_presig_sp: None,
            lock_a_txid: None,
            lock_b_txid: None,
            refund_txid: None,
            reclaim_txid: None,
            t0: m1.t0,
            t1: m1.t1,
            t2: m1.t2,
            t1_slot: m1.t1_slot,
            t2_slot: m1.t2_slot,
            // CC-2: populated by `accept_and_persist` AFTER the engine has
            // minted our material — at construction time the acting engine has
            // not spoken yet, and `None` here must read as could-not-look, not
            // as agreement with the advertisement above.
            t2_engine_slot: None,
            t2_engine_unix: None,
            created_at,
            key_provenance: String::new(),
        }
    }
}

/// The encrypted per-swap store. Cheap to construct; holds the AES key in a
/// `Zeroizing` buffer for the lifetime of the handle.
pub struct DeskStore {
    dir: PathBuf,
    key: Zeroizing<[u8; 32]>,
}

impl DeskStore {
    /// Open the store under `<data_dir>/desk-swaps/`, using the AES key from the
    /// OS keyring (created on first use). No password prompt, so this is safe to
    /// call on a background/startup path.
    pub fn open(data_dir: &Path) -> Result<Self, StoreError> {
        let key = crate::auth_keypair::load_or_create_seed(
            crate::auth_keypair::KeyringAccount::DESK_STORE,
        )
        .map_err(|e| StoreError::Key(e.to_string()))?;
        Self::open_with_key(data_dir, key)
    }

    /// Open with an explicit key (tests, or a caller that manages the key
    /// itself). Ensures the directory exists.
    pub fn open_with_key(data_dir: &Path, key: Zeroizing<[u8; 32]>) -> Result<Self, StoreError> {
        let dir = data_dir.join("desk-swaps");
        std::fs::create_dir_all(&dir).map_err(|e| StoreError::Io(e.to_string()))?;
        Ok(Self { dir, key })
    }

    /// Encrypt + atomically persist a record (`tmp` file + `sync_all` + rename,
    /// so a crash mid-write can never leave a torn record).
    pub fn save(&self, rec: &StoredSwap) -> Result<(), StoreError> {
        let id = validate_id(&rec.swap_id)?;
        let plaintext =
            Zeroizing::new(serde_json::to_vec(rec).map_err(|e| StoreError::Serde(e.to_string()))?);
        let blob = self.encrypt(id, &plaintext)?;

        let path = self.dir.join(format!("{id}.enc"));
        let tmp = self.dir.join(format!("{id}.enc.tmp"));
        {
            let mut f = std::fs::File::create(&tmp).map_err(io_err)?;
            f.write_all(&blob).map_err(io_err)?;
            f.sync_all().map_err(io_err)?;
        }
        std::fs::rename(&tmp, &path).map_err(io_err)?;
        Ok(())
    }

    /// Load + decrypt one record by swap id.
    pub fn load(&self, swap_id: &str) -> Result<StoredSwap, StoreError> {
        let id = validate_id(swap_id)?;
        let blob = std::fs::read(self.dir.join(format!("{id}.enc"))).map_err(io_err)?;
        let plaintext = self.decrypt(id, &blob)?;
        serde_json::from_slice(&plaintext)
            .map_err(|_| StoreError::Corrupt(id.to_string(), "record is not valid JSON"))
    }

    /// Rehydrate ALL persisted swaps — the startup path that reconstructs
    /// in-flight swaps and (re)spawns their refund watchers. A record that fails
    /// to decrypt or parse is SKIPPED with a warning rather than aborting the
    /// whole rehydrate: one bad file must not strand every other swap.
    pub fn load_all(&self) -> Result<Vec<StoredSwap>, StoreError> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.dir).map_err(io_err)? {
            let path = entry.map_err(io_err)?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("enc") {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s,
                None => continue,
            };
            let id = match validate_id(stem) {
                Ok(i) => i,
                Err(_) => continue,
            };
            let blob = match std::fs::read(&path) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("[desk::store] skipping unreadable file {id}.enc: {e}");
                    continue;
                }
            };
            match self
                .decrypt(id, &blob)
                .and_then(|pt| decode(id, &pt))
            {
                Ok(rec) => out.push(rec),
                Err(e) => eprintln!("[desk::store] skipping undecodable record {id}.enc: {e}"),
            }
        }
        Ok(out)
    }

    /// The swap ids currently persisted.
    pub fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        let mut ids = Vec::new();
        for entry in std::fs::read_dir(&self.dir).map_err(io_err)? {
            let path = entry.map_err(io_err)?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("enc") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if validate_id(stem).is_ok() {
                    ids.push(stem.to_string());
                }
            }
        }
        Ok(ids)
    }

    /// Delete a record once its swap has reached a terminal state (settled /
    /// refunded / aborted). Idempotent — a missing file is `Ok`.
    pub fn remove(&self, swap_id: &str) -> Result<(), StoreError> {
        let id = validate_id(swap_id)?;
        match std::fs::remove_file(self.dir.join(format!("{id}.enc"))) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StoreError::Io(e.to_string())),
        }
    }

    fn encrypt(&self, aad_id: &str, plaintext: &[u8]) -> Result<Vec<u8>, StoreError> {
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key[..]));
        let mut nonce_bytes = [0u8; 12];
        getrandom::getrandom(&mut nonce_bytes).map_err(|e| StoreError::Key(e.to_string()))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad: aad_id.as_bytes(),
                },
            )
            .map_err(|_| StoreError::Encrypt)?;
        let mut out = Vec::with_capacity(nonce_bytes.len() + ct.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    fn decrypt(&self, aad_id: &str, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, StoreError> {
        // 12-byte nonce + at least the 16-byte GCM tag.
        if blob.len() < 12 + 16 {
            return Err(StoreError::Corrupt(aad_id.to_string(), "blob too short"));
        }
        let (nonce_bytes, ct) = blob.split_at(12);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key[..]));
        let nonce = Nonce::from_slice(nonce_bytes);
        let pt = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: ct,
                    aad: aad_id.as_bytes(),
                },
            )
            .map_err(|_| StoreError::Decrypt(aad_id.to_string()))?;
        Ok(Zeroizing::new(pt))
    }
}

fn decode(id: &str, plaintext: &[u8]) -> Result<StoredSwap, StoreError> {
    serde_json::from_slice(plaintext)
        .map_err(|_| StoreError::Corrupt(id.to_string(), "record is not valid JSON"))
}

fn io_err(e: std::io::Error) -> StoreError {
    StoreError::Io(e.to_string())
}

/// Guard against path traversal / odd filenames: a swap id must be a short
/// alphanumeric-ish token (the desk issues hex ids). Anything with a path
/// separator, `.`, or `/` is rejected before it touches the filesystem.
fn validate_id(id: &str) -> Result<&str, StoreError> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(id)
    } else {
        Err(StoreError::InvalidId)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_data_dir() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "pwnda-desk-store-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn test_key() -> Zeroizing<[u8; 32]> {
        Zeroizing::new([7u8; 32])
    }

    fn sample(id: &str) -> StoredSwap {
        StoredSwap {
            leader_proof: false,
            refund_txid: None,
            reclaim_txid: None,
            swap_id: id.to_string(),
            pair: "XMR/ADA".to_string(),
            direction: "SELL_FOLLOWER".to_string(),
            desk_role: "LEADER".to_string(),
            amount_a: "27".to_string(),
            amount_b: "0.1".to_string(),
            state: "A_LOCKED".to_string(),
            payout_address: "addr_payout".to_string(),
            refund_address: "addr_refund".to_string(),
            script_address: "addr_script".to_string(),
            chain_a_lock_addr: Some("addr_a_lock".to_string()),
            chain_b_joint_addr: Some("xmr_joint".to_string()),
            chain_b_joint_key: Some("jointkey".to_string()),
            desk_key_share_point: "dksp".to_string(),
            desk_chain_a_pubkey: "dcap".to_string(),
            adaptor_point: None,
            view_key: Some("viewkey".to_string()),
            dleq_proof: None,
            client_key_share_point: Some("cksp".to_string()),
            engine_ref: Some("eng-ref-1".to_string()),
            refund_presig_r_enc: Some("rr".to_string()),
            refund_presig_sp: Some("rs".to_string()),
            claim_presig_r_enc: None,
            claim_presig_sp: None,
            lock_a_txid: None,
            lock_b_txid: Some("lockb_txid".to_string()),
            t0: 1783792067,
            t1: 1783792072,
            t2: 1783792077,
            t1_slot: None,
            t2_slot: None,
            t2_engine_slot: None,
            t2_engine_unix: None,
            created_at: 1783792000,
            key_provenance: "mock".to_string(),
        }
    }

    /// CC-2: a record written BEFORE the engine-T2 fields existed must load
    /// with `None` (could-not-look), not fail to decode — same contract as
    /// `refund_txid`. Exercised on the real decrypt path by stripping the new
    /// fields from a serialized record, as an old build would have written it.
    #[test]
    fn a_pre_cc2_record_loads_with_no_engine_t2() {
        let mut v = serde_json::to_value(sample("dd05")).unwrap();
        let o = v.as_object_mut().unwrap();
        o.remove("t2_engine_slot");
        o.remove("t2_engine_unix");
        let old: StoredSwap = serde_json::from_value(v).unwrap();
        assert_eq!(old.t2_engine_slot, None);
        assert_eq!(old.t2_engine_unix, None);
        assert_eq!(
            old.t2, 1783792077,
            "the advertised t2 still loads; only the engine fields default"
        );
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = temp_data_dir();
        let store = DeskStore::open_with_key(&dir, test_key()).unwrap();
        let rec = sample("aa01");
        store.save(&rec).unwrap();
        let loaded = store.load("aa01").unwrap();
        assert!(loaded == rec, "loaded record must equal the saved one");
        assert_eq!(loaded.engine_ref.as_deref(), Some("eng-ref-1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The restart proof: a fresh `DeskStore` over the same dir + key (a new app
    /// launch) reads back the record and can rehydrate a watcher from it.
    #[test]
    fn reopen_simulates_restart_and_rehydrates() {
        let dir = temp_data_dir();
        {
            let store = DeskStore::open_with_key(&dir, test_key()).unwrap();
            store.save(&sample("bb02")).unwrap();
            store.save(&sample("bb03")).unwrap();
        } // store dropped — simulate process exit
        let reopened = DeskStore::open_with_key(&dir, test_key()).unwrap();
        let all = reopened.load_all().unwrap();
        assert_eq!(all.len(), 2, "both in-flight swaps must rehydrate");
        let mut ids: Vec<_> = all.iter().map(|s| s.swap_id.clone()).collect();
        ids.sort();
        assert_eq!(ids, vec!["bb02".to_string(), "bb03".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_key_fails_authentication() {
        let dir = temp_data_dir();
        DeskStore::open_with_key(&dir, test_key())
            .unwrap()
            .save(&sample("cc04"))
            .unwrap();
        let other = DeskStore::open_with_key(&dir, Zeroizing::new([9u8; 32])).unwrap();
        assert!(matches!(other.load("cc04"), Err(StoreError::Decrypt(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampered_ciphertext_fails_authentication() {
        let dir = temp_data_dir();
        let store = DeskStore::open_with_key(&dir, test_key()).unwrap();
        store.save(&sample("dd05")).unwrap();
        // Flip a byte in the sealed file.
        let path = dir.join("desk-swaps").join("dd05.enc");
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        std::fs::write(&path, &bytes).unwrap();
        assert!(matches!(store.load("dd05"), Err(StoreError::Decrypt(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The AAD binding: a sealed file renamed to a different swap id fails to
    /// authenticate (it was sealed with the original id as associated data).
    #[test]
    fn record_is_bound_to_its_swap_id() {
        let dir = temp_data_dir();
        let store = DeskStore::open_with_key(&dir, test_key()).unwrap();
        store.save(&sample("ee06")).unwrap();
        let src = dir.join("desk-swaps").join("ee06.enc");
        let dst = dir.join("desk-swaps").join("ee07.enc");
        std::fs::copy(&src, &dst).unwrap();
        // Reads fine under its real id...
        assert!(store.load("ee06").is_ok());
        // ...but the copy under a different id fails the AAD check.
        assert!(matches!(store.load("ee07"), Err(StoreError::Decrypt(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_is_idempotent() {
        let dir = temp_data_dir();
        let store = DeskStore::open_with_key(&dir, test_key()).unwrap();
        store.save(&sample("ff08")).unwrap();
        store.remove("ff08").unwrap();
        assert!(store.load("ff08").is_err());
        store.remove("ff08").unwrap(); // second remove is a no-op
        assert!(store.load_all().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_all_skips_corrupt_files() {
        let dir = temp_data_dir();
        let store = DeskStore::open_with_key(&dir, test_key()).unwrap();
        store.save(&sample("aa10")).unwrap();
        // Drop a junk .enc file next to the good one.
        std::fs::write(dir.join("desk-swaps").join("garbage.enc"), b"not encrypted").unwrap();
        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 1, "the good record loads; the junk one is skipped");
        assert_eq!(all[0].swap_id, "aa10");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_ids_are_rejected() {
        let dir = temp_data_dir();
        let store = DeskStore::open_with_key(&dir, test_key()).unwrap();
        for bad in ["../etc/passwd", "a/b", "with space", "dot.dot", ""] {
            assert!(matches!(store.load(bad), Err(StoreError::InvalidId)), "id {bad:?} must be rejected");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn from_accept_seeds_the_record() {
        let m1: wire::AcceptResponse = serde_json::from_str(r#"{"swapId":"gg11","pair":"XMR/ADA","direction":"BUY_FOLLOWER","deskRole":"FOLLOWER","coinIn":"ADA","coinOut":"XMR","amountA":"3","amountB":"0.009","t0":1,"t1":2,"t2":3,"t1Slot":null,"t2Slot":null,"deskKeySharePoint":"dk","deskChainAPubkey":"dc","adaptorPoint":"ap","viewKey":"vk","dleqProof":null,"commitments":[],"scriptAddress":"addr","expiresAt":1}"#).unwrap();
        let rec = StoredSwap::from_accept(&m1, "payout", "refund", 42);
        assert_eq!(rec.swap_id, "gg11");
        assert_eq!(rec.desk_role, "FOLLOWER");
        assert_eq!(rec.adaptor_point.as_deref(), Some("ap")); // desk-as-follower carries it in M1
        assert_eq!(rec.state, "ACCEPTED");
        assert!(rec.engine_ref.is_none());
        assert_eq!(rec.t1, 2);
        assert_eq!(rec.created_at, 42);
    }

    /// This store holds the claim/refund capability for swaps that may already
    /// be locked on chain, so a field added to [`StoredSwap`] must not orphan a
    /// record written before it existed. `refund_txid`/`reclaim_txid` carry
    /// `#[serde(default)]` for that reason — this asserts it rather than
    /// trusting the attribute, because the failure mode is a record that will
    /// not load at exactly the moment its funds need recovering.
    #[test]
    fn a_record_written_before_the_reclaim_fields_existed_still_loads() {
        let mut v = serde_json::to_value(&sample("old1")).unwrap();
        let obj = v.as_object_mut().unwrap();
        obj.remove("refund_txid").expect("field should be present today");
        obj.remove("reclaim_txid").expect("field should be present today");
        // Also drop key_provenance, the previous field added this way, so the
        // test covers the accumulated shape of an OLD record rather than one
        // that is old in a single respect.
        obj.remove("key_provenance");

        let back: StoredSwap = serde_json::from_value(v).expect("an older record must still load");
        assert_eq!(back.swap_id, "old1");
        assert!(back.refund_txid.is_none());
        assert!(back.reclaim_txid.is_none());
        // The safe default: unrecognized provenance is treated as mock, which
        // the broadcaster refuses rather than acts on.
        assert!(!crate::desk::crypto::KeyProvenance::parse(&back.key_provenance).is_real());
    }
}
