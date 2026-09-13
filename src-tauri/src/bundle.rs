//! Encrypted binary bundles — the CONSUMER side (binary-bundling-plan).
//!
//! AV-sensitive binaries (the miners, and the Grove/BasicSwap runtime + coin
//! daemons) ship **inside the installer**, compressed with xz -9 and encrypted
//! with AES-256-GCM, dormant until the user opts in. This module decrypts,
//! decompresses, **verifies, then unpacks** a named payload. The producer is
//! `scripts/bundle-binaries.mjs`.
//!
//! # The encryption is OBFUSCATION, not confidentiality — say it out loud
//!
//! The binaries are public downloads and the key ships in **plaintext**
//! (`binaries/bundle-key.bin`) right beside the blobs. The cipher's only job is
//! to raise entropy so an AV archive-unpacker cannot recurse into a `.enc` and
//! match a miner signature *inside the installer*. Trust comes from the SHA256
//! gate below, not from the cipher — a bundled payload and a fresh download are
//! trust-equivalent because both terminate at the same hash check.
//!
//! # Container format (per payload)
//!
//! ```text
//! plaintext:  tar of the payload's files
//!   -> xz -9                              (scripts/bundle-binaries.mjs: `xz -9`)
//!   -> AES-256-GCM(nonce || ciphertext+tag)   <name>.enc  (nonce = first 12 bytes)
//! ```
//!
//! `bundle-manifest.json` records, per payload, `enc_file` and the SHA256 of the
//! **decompressed tar** (`tar_sha256`) — the integrity gate, checked before any
//! file is written.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use zeroize::Zeroize;

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const GCM_TAG_LEN: usize = 16;

const MANIFEST_FILE: &str = "bundle-manifest.json";
const KEY_FILE: &str = "bundle-key.bin";

#[derive(Debug, Deserialize)]
struct BundleManifest {
    /// `"win32"` | `"linux"` — the platform the payloads were built FOR
    /// (`scripts/bundle-binaries.mjs`'s `target`). Optional because manifests
    /// that predate the field carry none; those are trusted as before.
    ///
    /// Read since 2026-09-12. Until then nothing on the consumer side looked at
    /// it: `src-tauri/binaries/` is shared by the Windows and Linux builds, a
    /// Linux release run rewrote it with `"target": "linux"`, `tauri dev` copied
    /// it into `target/debug/binaries/`, and the Windows engine reconcile tried
    /// to unpack a Linux Python runtime over the Windows one on every start.
    #[serde(default)]
    target: Option<String>,
    payloads: Vec<PayloadEntry>,
}

/// This binary's platform, in the manifest's vocabulary.
pub fn platform_tag() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unsupported"
    }
}

/// `Err` naming both platforms when the manifest was built for another one.
fn check_target(manifest: &BundleManifest) -> Result<(), String> {
    match manifest.target.as_deref() {
        Some(t) if t != platform_tag() => Err(format!(
            "bundle: payloads were built for {t}, this is {} — refusing to unpack \
             another platform's binaries",
            platform_tag()
        )),
        _ => Ok(()),
    }
}

#[derive(Debug, Deserialize, Clone)]
struct PayloadEntry {
    /// Manifest key, e.g. "xmrig", "grove-runtime", "coin-bitcoincash".
    name: String,
    /// The `<name>.enc` file, relative to `<resource>/binaries/`.
    enc_file: String,
    /// SHA256 (hex) of the DECOMPRESSED tar. The integrity gate.
    tar_sha256: String,
}

/// Write a real, encrypted, this-platform bundle holding `files` — the shape
/// `scripts/bundle-binaries.mjs` produces — for tests OUTSIDE this module that
/// need an installable payload (the engine first-install test in
/// `swap_sidecar.rs`). Panics on any I/O error; test-only.
#[cfg(test)]
pub(crate) fn write_fixture_bundle(resource_dir: &Path, payload: &str, files: &[(&str, &[u8])]) {
    use std::io::Write;
    let bindir = bundle_dir(resource_dir);
    std::fs::create_dir_all(&bindir).unwrap();
    let mut tar_buf: Vec<u8> = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_buf);
        for (name, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, name, &data[..]).unwrap();
        }
        builder.finish().unwrap();
    }
    let tar_sha = hex::encode(Sha256::digest(&tar_buf));
    let mut xz_buf: Vec<u8> = Vec::new();
    lzma_rs::xz_compress(&mut &tar_buf[..], &mut xz_buf).unwrap();
    let key = [9u8; KEY_LEN];
    let nonce = [5u8; NONCE_LEN];
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), &xz_buf[..]).unwrap();
    let mut enc = nonce.to_vec();
    enc.extend_from_slice(&ct);
    std::fs::write(bindir.join(format!("{payload}.enc")), &enc).unwrap();
    std::fs::write(bindir.join(KEY_FILE), key).unwrap();
    let manifest = format!(
        r#"{{"target":"{}","payloads":[{{"name":"{payload}","enc_file":"{payload}.enc","tar_sha256":"{tar_sha}"}}]}}"#,
        platform_tag()
    );
    std::fs::File::create(bindir.join(MANIFEST_FILE))
        .unwrap()
        .write_all(manifest.as_bytes())
        .unwrap();
}

/// `<resource_dir>/binaries` — where the producer writes the `.enc` blobs, the
/// manifest, and the plaintext key (same dir the sidecar `.gz` payloads use).
fn bundle_dir(resource_dir: &Path) -> std::path::PathBuf {
    resource_dir.join("binaries")
}

fn read_manifest(resource_dir: &Path) -> Result<BundleManifest, String> {
    let p = bundle_dir(resource_dir).join(MANIFEST_FILE);
    let raw =
        std::fs::read_to_string(&p).map_err(|e| format!("bundle: no manifest at {}: {e}", p.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("bundle: manifest parse error: {e}"))
}

fn read_key(resource_dir: &Path) -> Result<[u8; KEY_LEN], String> {
    let p = bundle_dir(resource_dir).join(KEY_FILE);
    let bytes = std::fs::read(&p).map_err(|e| format!("bundle: no key at {}: {e}", p.display()))?;
    if bytes.len() != KEY_LEN {
        return Err(format!(
            "bundle: key is {} bytes, expected {KEY_LEN}",
            bytes.len()
        ));
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// True iff an encrypted bundle exists in `resource_dir` and names `payload`.
/// Cheap enough to gate a resolver tier on — reads only the small manifest.
///
/// A manifest built for another platform answers **false**: a payload this
/// binary must not unpack is not a payload it has. Every caller (the engine
/// reconcile, the setup install, the miners stage, `bundle_available`) gates on
/// this, so one check covers all of them.
pub fn bundle_has(resource_dir: &Path, payload: &str) -> bool {
    read_manifest(resource_dir)
        .map(|m| check_target(&m).is_ok() && m.payloads.iter().any(|p| p.name == payload))
        .unwrap_or(false)
}

/// Decrypt → xz-decompress → **SHA256-verify** → untar `payload` into `dest_dir`.
///
/// The whole decompressed tar is hashed and checked **before a single file is
/// written** — same discipline as `wallet_rpc_common::extract_bundled_sidecar`,
/// so a tampered or truncated bundle never reaches disk as an executable. AES-GCM
/// authentication is the first gate (a flipped byte fails the tag); the SHA256 is
/// the second, independent one (catches a valid-but-wrong payload).
pub fn extract_encrypted_bundle(
    resource_dir: &Path,
    payload: &str,
    dest_dir: &Path,
) -> Result<(), String> {
    let manifest = read_manifest(resource_dir)?;
    // Before decrypting a byte: another platform's payload is refused outright,
    // not unpacked and left to fail at exec time (see `BundleManifest::target`).
    check_target(&manifest).map_err(|e| format!("{e} (payload {payload})"))?;
    let entry: PayloadEntry = manifest
        .payloads
        .iter()
        .find(|p| p.name == payload)
        .cloned()
        .ok_or_else(|| format!("bundle: no payload named {payload}"))?;

    let enc_path = bundle_dir(resource_dir).join(&entry.enc_file);
    let enc = std::fs::read(&enc_path)
        .map_err(|e| format!("bundle: cannot read {}: {e}", enc_path.display()))?;
    if enc.len() < NONCE_LEN + GCM_TAG_LEN {
        return Err(format!(
            "bundle {payload}: .enc is {} bytes — too short to hold nonce + tag",
            enc.len()
        ));
    }

    // AES-256-GCM: nonce is the first 12 bytes; the rest is ciphertext+tag.
    let mut key = read_key(resource_dir)?;
    let (nonce_bytes, ciphertext) = enc.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let decrypted = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| {
            format!("bundle {payload}: AES-GCM authentication failed (tampered blob or wrong key)")
        });
    key.zeroize(); // the key is public, but do not leave 32 bytes on the stack a moment longer than needed
    let xz_bytes = decrypted?;

    // xz -> tar (pure-Rust lzma-rs; no liblzma link).
    let mut tar_bytes: Vec<u8> = Vec::new();
    lzma_rs::xz_decompress(&mut &xz_bytes[..], &mut tar_bytes)
        .map_err(|e| format!("bundle {payload}: xz decompress failed: {e:?}"))?;

    // VERIFY BEFORE WRITE — the load-bearing gate.
    let got = hex::encode(Sha256::digest(&tar_bytes));
    if !got.eq_ignore_ascii_case(&entry.tar_sha256) {
        return Err(format!(
            "bundle {payload}: tar SHA256 mismatch (expected {}, got {got}) — refusing to unpack",
            entry.tar_sha256
        ));
    }

    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("bundle {payload}: cannot create {}: {e}", dest_dir.display()))?;

    // Untar into dest_dir. Only reached after the hash gate, so the bytes are
    // trusted. On Unix the +x bits ride in the tar (the Linux producer tars
    // already-executable binaries); on Windows the mode is ignored, which is
    // fine — Windows executability is by extension.
    let mut archive = tar::Archive::new(&tar_bytes[..]);
    archive.set_preserve_permissions(true);
    archive.set_overwrite(true);
    archive
        .unpack(dest_dir)
        .map_err(|e| format!("bundle {payload}: untar into {} failed: {e}", dest_dir.display()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
    use std::io::Write;

    /// Build a real bundle in a temp dir the way the producer would, then prove
    /// the round trip and each failure gate. This is the offline half of T8 — no
    /// network, no external `xz` (we compress in-process via lzma-rs's encoder).
    struct Fixture {
        dir: std::path::PathBuf,
        key: [u8; KEY_LEN],
    }

    fn write_bundle(payload: &str, files: &[(&str, &[u8])], tamper: Tamper) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "pwnda-bundle-test-{}-{}",
            payload,
            std::process::id()
        ));
        let bindir = root.join("binaries");
        std::fs::create_dir_all(&bindir).unwrap();

        // tar the files (in memory)
        let mut tar_buf: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            for (name, data) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, name, &data[..]).unwrap();
            }
            builder.finish().unwrap();
        }
        let tar_sha = hex::encode(Sha256::digest(&tar_buf));

        // tar -> xz (lzma-rs encoder, so the test needs no external `xz`)
        let mut xz_buf: Vec<u8> = Vec::new();
        lzma_rs::xz_compress(&mut &tar_buf[..], &mut xz_buf).unwrap();

        // xz -> AES-256-GCM
        let key = [7u8; KEY_LEN];
        let nonce = [3u8; NONCE_LEN];
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let mut ct = cipher
            .encrypt(Nonce::from_slice(&nonce), &xz_buf[..])
            .unwrap();
        if matches!(tamper, Tamper::Ciphertext) {
            ct[0] ^= 0xFF; // flip a byte -> GCM tag must reject
        }
        let mut enc = nonce.to_vec();
        enc.extend_from_slice(&ct);
        std::fs::write(bindir.join(format!("{payload}.enc")), &enc).unwrap();

        // key + manifest
        std::fs::write(bindir.join(KEY_FILE), key).unwrap();
        let stored_sha = if matches!(tamper, Tamper::TarHash) {
            "0".repeat(64) // valid decrypt+decompress, wrong recorded hash -> SHA256 gate rejects
        } else {
            tar_sha
        };
        let manifest = format!(
            r#"{{"payloads":[{{"name":"{payload}","enc_file":"{payload}.enc","tar_sha256":"{stored_sha}"}}]}}"#
        );
        let mut mf = std::fs::File::create(bindir.join(MANIFEST_FILE)).unwrap();
        mf.write_all(manifest.as_bytes()).unwrap();

        Fixture { dir: root, key }
    }

    enum Tamper {
        None,
        Ciphertext,
        TarHash,
    }

    #[test]
    fn round_trip_extracts_the_files() {
        let f = write_bundle(
            "demo",
            &[("bin/thing.exe", b"MZ hello miner"), ("readme.txt", b"hi")],
            Tamper::None,
        );
        let dest = f.dir.join("out");
        extract_encrypted_bundle(&f.dir, "demo", &dest).expect("round trip");
        assert_eq!(
            std::fs::read(dest.join("bin/thing.exe")).unwrap(),
            b"MZ hello miner"
        );
        assert_eq!(std::fs::read(dest.join("readme.txt")).unwrap(), b"hi");
        let _ = std::fs::remove_dir_all(&f.dir);
        let _ = f.key; // silence unused
    }

    #[test]
    fn tampered_ciphertext_fails_the_gcm_tag_before_any_write() {
        let f = write_bundle("demo2", &[("x", b"data")], Tamper::Ciphertext);
        let dest = f.dir.join("out");
        let err = extract_encrypted_bundle(&f.dir, "demo2", &dest).unwrap_err();
        assert!(err.contains("authentication failed"), "got: {err}");
        assert!(!dest.exists(), "nothing must be written on a failed decrypt");
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    #[test]
    fn wrong_tar_hash_fails_before_any_write() {
        let f = write_bundle("demo3", &[("x", b"data")], Tamper::TarHash);
        let dest = f.dir.join("out");
        let err = extract_encrypted_bundle(&f.dir, "demo3", &dest).unwrap_err();
        assert!(err.contains("SHA256 mismatch"), "got: {err}");
        assert!(!dest.exists(), "nothing must be written on a hash mismatch");
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// End-to-end proof against a REAL bundle produced by
    /// scripts/bundle-binaries.mjs. `#[ignore]` because it needs a ~50 MB
    /// artifact on disk:
    ///   node scripts/bundle-binaries.mjs win32 --only=grove --out=<DIR>/binaries
    ///   PWNDA_BUNDLE_TEST_RESOURCE=<DIR> cargo test --features full --lib \
    ///       bundle::tests::live_grove_round_trip -- --ignored --nocapture
    #[test]
    #[ignore = "needs a real bundle; PWNDA_BUNDLE_TEST_RESOURCE=<dir with binaries/>, PWNDA_BUNDLE_TEST_PAYLOAD=grove|miners, PWNDA_BUNDLE_TEST_EXPECT=<rel path that must exist>"]
    fn live_round_trip() {
        let resource =
            std::path::PathBuf::from(std::env::var("PWNDA_BUNDLE_TEST_RESOURCE").expect("resource env"));
        let payload = std::env::var("PWNDA_BUNDLE_TEST_PAYLOAD").unwrap_or_else(|_| "grove".into());
        let expect = std::env::var("PWNDA_BUNDLE_TEST_EXPECT")
            .unwrap_or_else(|_| "runtime/python.exe".into());
        let dest = std::env::temp_dir()
            .join(format!("pwnda-bundle-extract-{}-{}", payload, std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        extract_encrypted_bundle(&resource, &payload, &dest).expect("extract");
        // Accept the .exe path or its suffixless twin so one env var works on
        // both platforms.
        let want = dest.join(&expect);
        let want_noexe =
            dest.join(expect.strip_suffix(".exe").unwrap_or(&expect));
        assert!(
            want.is_file() || want_noexe.is_file(),
            "expected {} after extracting {payload}, not found",
            want.display()
        );
        println!("live {payload} round trip OK -> {}", dest.display());
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn missing_payload_is_a_clear_error() {
        let f = write_bundle("demo4", &[("x", b"d")], Tamper::None);
        let err = extract_encrypted_bundle(&f.dir, "not-there", &f.dir.join("out")).unwrap_err();
        assert!(err.contains("no payload named"), "got: {err}");
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// 2026-09-12: `src-tauri/binaries/` carried a `"target": "linux"` manifest
    /// (a Linux release run rewrote the shared dir), `tauri dev` copied it into
    /// a Windows build's resources, and the engine reconcile tried to unpack a
    /// Linux Python runtime over the Windows one on every start.
    #[test]
    fn another_platforms_bundle_is_neither_present_nor_extractable() {
        let f = write_bundle("demo5", &[("x", b"d")], Tamper::None);
        let mf = f.dir.join("binaries").join(MANIFEST_FILE);
        let raw = std::fs::read_to_string(&mf).unwrap();
        let with_target = |t: &str| raw.replacen('{', &format!(r#"{{"target":"{t}","#), 1);
        let other = if platform_tag() == "linux" { "win32" } else { "linux" };

        std::fs::write(&mf, with_target(other)).unwrap();
        assert!(!bundle_has(&f.dir, "demo5"), "a foreign bundle must not count as present");
        let dest = f.dir.join("out");
        let err = extract_encrypted_bundle(&f.dir, "demo5", &dest).unwrap_err();
        assert!(err.contains(&format!("built for {other}")), "got: {err}");
        assert!(!dest.exists(), "nothing may be written for another platform");

        // Positive control: this platform's own tag, and no tag at all (a
        // manifest older than the field), both still extract.
        std::fs::write(&mf, with_target(platform_tag())).unwrap();
        assert!(bundle_has(&f.dir, "demo5"));
        extract_encrypted_bundle(&f.dir, "demo5", &dest).expect("same platform extracts");
        std::fs::write(&mf, &raw).unwrap();
        assert!(bundle_has(&f.dir, "demo5"), "an untagged manifest is trusted as before");
        let _ = std::fs::remove_dir_all(&f.dir);
    }
}
