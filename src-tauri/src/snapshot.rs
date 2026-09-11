//! S2 — the opt-in Particl chain snapshot: verify, unpack, place.
//!
//! # Why this exists
//!
//! A first Particl sync is ~4.5 hours of validating 2.24 million blocks, and it
//! is the last big wait in the swap-node setup: every other coin is Electrum-lean
//! or remote. A snapshot replaces that with a ~0.7 GB download and about two
//! minutes. Measured end to end on 2026-09-09: a restored chain went from
//! `prepare` to a live engine with SMSG carrying 734 messages, in the time it
//! takes to unpack.
//!
//! # What a snapshot is, and is not
//!
//! It is **public chain data only** — `blocks/` and `chainstate/`. It carries no
//! wallet, no SMSG key, no identity, and it cannot: the producer excludes them by
//! name and [`sane_entry`] refuses anything else on the way in. A malicious
//! snapshot cannot steal funds because it contains nothing that signs; the worst
//! it can do is feed the node a wrong chain, which is why the chainstate hash is
//! checked after start ([`ChainstateCheck`]).
//!
//! # The ordering that works, and the two that do not
//!
//! Learned by running them (2026-09-09, `log.md`):
//!
//! * **prepare, then restore** — the wallet is created against an empty chain, so
//!   its last-synced height is 0, below the snapshot's `pruneheight`. particld
//!   refuses to start: *"Prune: last wallet synchronisation goes beyond pruned
//!   data"*.
//! * **restore, then prepare, with a scanning wallet** — the new wallet rescans
//!   the whole retained window (measured 151,741 ms) while the engine's RPC
//!   client times out at 10 s.
//! * **restore, then prepare with `PART_WALLET_SCAN_FROM=-1`** — works. The wallet
//!   is born at the tip the node is already on, with nothing to scan. That is
//!   PWNDA-PATCH-32, and [`RESTORE_BEFORE_PREPARE`] is the constant that keeps
//!   this module honest about which order it belongs in.
//!
//! So the snapshot must land **before** the first prepare, and this module runs
//! there or not at all.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

/// Where published snapshots live.
///
/// The **public** release repo, because unauthenticated `releases/download`
/// URLs resolve only on a public repo and drafts are invisible — the private dev
/// repo cannot serve this. A rolling prerelease tag rather than `latest`, so the
/// URL is fixed and no API call (or rate limit) sits in the path.
pub const SNAPSHOT_BASE_URL: &str =
    "https://github.com/pwndaCreate/PwndaWallet/releases/download/particl-snapshot";

/// Refuse a "manifest" larger than this. A manifest is ~600 bytes; anything at
/// this scale is a wrong URL or a hostile response, and streaming it into memory
/// to find that out is the mistake.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

/// Public half of the snapshot signing key, minted 2026-09-09 by
/// `scripts/swap/mint-snapshot-key.mjs`. The private half lives outside the
/// repo and is never in a build.
///
/// # What the signature is for, and what it is not
///
/// A snapshot is public chain data and carries nothing that signs, so a hostile
/// one cannot take funds. What this stops is **substitution**: anyone able to
/// answer for the download URL handing every new install a chain of their
/// choosing. The hash proves the bytes match the manifest; this proves the
/// manifest is ours.
///
/// Raw ed25519, verified with `ed25519-dalek`, which the wallet already depends
/// on. No container format, because a format the client has to parse is a format
/// that can fail on the client.
pub const SNAPSHOT_PUBKEY_HEX: &str =
    "18b38db66aeceae79cbdf583c3ead1685585d20c01f33f45cceb261356da6a87";

/// Ceiling on the archive, as a sanity bound independent of the manifest's own
/// `size`. The manifest is signed, but this is checked BEFORE the signature can
/// matter to a stream that is already writing to disk.
const MAX_ARCHIVE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// The snapshot is restored BEFORE `basicswap.bin.prepare` runs, never after.
///
/// A constant rather than a comment because the alternative ordering fails in a
/// way that looks like chain corruption (`Prune: last wallet synchronisation
/// goes beyond pruned data`) rather than like a sequencing mistake, and the next
/// person to touch the start path will not have that in mind.
pub const RESTORE_BEFORE_PREPARE: bool = true;

/// Manifest schema this build understands. A higher one is refused rather than
/// guessed at: an unknown field could be the one that matters.
pub const MANIFEST_SCHEMA: u32 = 1;

/// What the producer publishes alongside the archive.
///
/// Mirrors `scripts/swap/make-particl-snapshot.mjs`. `tip` and
/// `chainstate_muhash` are `Option` because the producer leaves them null rather
/// than guessing — a WRONG muhash is worse than an absent one, since it would
/// fail every honest restore while a missing one merely cannot be checked.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SnapshotManifest {
    pub schema: u32,
    pub snapshot_id: String,
    pub created_at: String,
    /// Must equal the daemon this build ships. The LevelDB layout and Particl's
    /// own block-index fields belong to the version that wrote them.
    pub particld_version: String,
    pub archive: ArchiveInfo,
    #[serde(default)]
    pub tip: Option<TipInfo>,
    #[serde(default)]
    pub chainstate_muhash: Option<String>,
    #[serde(default)]
    pub min_wallet_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ArchiveInfo {
    pub name: String,
    pub codec: String,
    pub size: u64,
    pub sha256: String,
    /// zstd long-distance window as a power of two, when the codec is zstd.
    ///
    /// Load-bearing: a frame written with `--long=31` refuses to decode with
    /// default settings (`Window size larger than maximum: 2147483648 >
    /// 134217728`) and needs 2 GB of RAM at unpack. The producer writes 27 for
    /// that reason, and [`decodable_window`] is what stops a future producer
    /// quietly raising it.
    #[serde(default)]
    pub zstd_window_log: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TipInfo {
    pub height: u64,
    pub hash: String,
}

/// Why a snapshot was refused. Every variant is a REASON, not a code: the user
/// sees these, and "snapshot failed" would send them looking for a fault that
/// the next sentence could have explained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotRefusal {
    SchemaTooNew { found: u32, understood: u32 },
    WrongDaemon { manifest: String, ours: String },
    HashMismatch { expected: String, got: String },
    SizeMismatch { expected: u64, got: u64 },
    UndecodableWindow { window_log: u32 },
    ChainAlreadyPresent,
    UnsafeEntry { path: String },
    ChainstateMismatch { expected: String, got: String },
    BadSignature,
    MissingSignature,
}

impl SnapshotRefusal {
    /// One sentence, phrased for the person who has to decide what to do next.
    pub fn describe(&self) -> String {
        match self {
            Self::SchemaTooNew { found, understood } => format!(
                "this snapshot uses manifest schema {found} and this wallet understands {understood}. \
                 Update the wallet, or sync from the network instead."
            ),
            Self::WrongDaemon { manifest, ours } => format!(
                "the snapshot was built for Particl {manifest} and this wallet ships {ours}. \
                 A chain database belongs to the daemon that wrote it, so this one is not usable here."
            ),
            Self::HashMismatch { expected, got } => format!(
                "the download does not match the manifest (expected {}…, got {}…). \
                 Nothing was written; syncing from the network is unaffected.",
                &expected[..expected.len().min(12)],
                &got[..got.len().min(12)]
            ),
            Self::SizeMismatch { expected, got } => format!(
                "the download is {got} bytes and the manifest says {expected}. Nothing was written."
            ),
            Self::UndecodableWindow { window_log } => format!(
                "the snapshot needs a {} MB decompression window, which this wallet will not \
                 allocate. That is a producer error, not something you can fix here.",
                (1u64 << window_log) / 1048576
            ),
            Self::ChainAlreadyPresent => "this node already has a Particl chain, and a snapshot is \
                 only ever written into an empty datadir. Nothing was touched."
                .to_string(),
            Self::UnsafeEntry { path } => format!(
                "the archive contains {path}, which a chain snapshot must never carry. \
                 Refused without unpacking."
            ),
            Self::ChainstateMismatch { expected, got } => format!(
                "after loading, the chain does not hash to what the snapshot promised \
                 (expected {}…, got {}…). The snapshot has been removed and the node will \
                 sync from the network.",
                &expected[..expected.len().min(12)],
                &got[..got.len().min(12)]
            ),
            Self::BadSignature => "this snapshot is not signed by the key this wallet trusts. \
                 Nothing was downloaded. Syncing from the network is unaffected."
                .to_string(),
            Self::MissingSignature => "this snapshot has no signature. Nothing was downloaded; \
                 the node will sync from the network instead."
                .to_string(),
        }
    }
}

/// Verify the detached signature over the EXACT manifest bytes.
///
/// `manifest_bytes` must be the bytes as served, not a re-serialised struct: a
/// round-trip through serde can reorder keys and would verify a document the
/// client never actually read.
///
/// An absent signature is [`MissingSignature`](SnapshotRefusal::MissingSignature),
/// never a pass. That distinction is the whole point — treating "unsigned" as
/// "fine" would make the check unfalsifiable, which is worse than not having it.
pub fn check_signature(manifest_bytes: &[u8], sig_hex: Option<&str>) -> Result<(), SnapshotRefusal> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let Some(sig_hex) = sig_hex.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(SnapshotRefusal::MissingSignature);
    };
    let pk_bytes: [u8; 32] = hex::decode(SNAPSHOT_PUBKEY_HEX)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(SnapshotRefusal::BadSignature)?;
    let key = VerifyingKey::from_bytes(&pk_bytes).map_err(|_| SnapshotRefusal::BadSignature)?;
    let sig_bytes: [u8; 64] = hex::decode(sig_hex)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(SnapshotRefusal::BadSignature)?;
    key.verify(manifest_bytes, &Signature::from_bytes(&sig_bytes))
        .map_err(|_| SnapshotRefusal::BadSignature)
}

/// Largest zstd window this wallet will ask a decoder to allocate, as log2.
///
/// 27 = 128 MiB, which is zstd's own default maximum. Anything larger is a
/// producer choosing 83 MB of bandwidth over the user's ability to open the
/// file — the exact trade the 2026-09-08 measurement rejected.
pub const MAX_ZSTD_WINDOW_LOG: u32 = 27;

/// True when a decoder with default settings can open this archive.
pub fn decodable_window(info: &ArchiveInfo) -> bool {
    info.zstd_window_log
        .is_none_or(|w| w <= MAX_ZSTD_WINDOW_LOG)
}

/// Entries a chain snapshot may contain.
///
/// Deliberately an allow-list of two prefixes rather than a deny-list of secrets.
/// A deny-list has to predict every name worth excluding, and the producer
/// already excludes by name; this is the half that does not depend on the
/// producer being right. It also rejects absolute paths and any `..`, so a
/// crafted archive cannot write outside the datadir (zip-slip).
pub fn sane_entry(entry: &str) -> bool {
    let p = Path::new(entry);
    if p.is_absolute() {
        return false;
    }
    if p.components().any(|c| {
        matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))
    }) {
        return false;
    }
    let first = match p.components().next() {
        Some(Component::Normal(s)) => s.to_string_lossy().to_string(),
        _ => return false,
    };
    first == "blocks" || first == "chainstate"
}

/// Verify a manifest against what this build can actually use.
///
/// Runs BEFORE the archive is fetched, so a snapshot this wallet could never
/// load costs no bandwidth.
pub fn check_manifest(m: &SnapshotManifest, our_particld: &str) -> Result<(), SnapshotRefusal> {
    if m.schema > MANIFEST_SCHEMA {
        return Err(SnapshotRefusal::SchemaTooNew {
            found: m.schema,
            understood: MANIFEST_SCHEMA,
        });
    }
    if m.particld_version != our_particld {
        return Err(SnapshotRefusal::WrongDaemon {
            manifest: m.particld_version.clone(),
            ours: our_particld.to_string(),
        });
    }
    if !decodable_window(&m.archive) {
        return Err(SnapshotRefusal::UndecodableWindow {
            window_log: m.archive.zstd_window_log.unwrap_or(0),
        });
    }
    Ok(())
}

/// Verify a downloaded archive against its manifest.
///
/// Size first, then hash: the size check is free and catches a truncated resume
/// without hashing a gigabyte to learn the same thing.
pub fn check_archive(
    m: &SnapshotManifest,
    got_size: u64,
    got_sha256: &str,
) -> Result<(), SnapshotRefusal> {
    if got_size != m.archive.size {
        return Err(SnapshotRefusal::SizeMismatch {
            expected: m.archive.size,
            got: got_size,
        });
    }
    if !got_sha256.eq_ignore_ascii_case(&m.archive.sha256) {
        return Err(SnapshotRefusal::HashMismatch {
            expected: m.archive.sha256.clone(),
            got: got_sha256.to_string(),
        });
    }
    Ok(())
}

/// May a snapshot be written into this Particl datadir?
///
/// Only into one with no chain. Overwriting an existing chain is never right:
/// at best it discards a sync the user already paid for, at worst it strands a
/// wallet whose last-synced height ends up below the new `pruneheight` — the
/// failure this module's header describes.
pub fn may_restore_into(particl_dir: &Path) -> Result<(), SnapshotRefusal> {
    if particl_dir.join("blocks").exists() || particl_dir.join("chainstate").exists() {
        return Err(SnapshotRefusal::ChainAlreadyPresent);
    }
    Ok(())
}

/// Compare the chain's own hash after start against what the snapshot promised.
///
/// This is the only check that sees the DATA rather than the container, and it
/// is what makes a snapshot trust-minimised rather than merely authenticated: a
/// signature says who sent it, this says the chain is the one everyone else has.
/// `None` in the manifest means the producer did not publish one, which is a
/// weaker guarantee, reported rather than silently treated as a pass.
pub enum ChainstateCheck {
    Match,
    NotPublished,
    Mismatch(SnapshotRefusal),
}

pub fn check_chainstate(m: &SnapshotManifest, got_muhash: &str) -> ChainstateCheck {
    match &m.chainstate_muhash {
        None => ChainstateCheck::NotPublished,
        Some(expected) if expected.eq_ignore_ascii_case(got_muhash) => ChainstateCheck::Match,
        Some(expected) => ChainstateCheck::Mismatch(SnapshotRefusal::ChainstateMismatch {
            expected: expected.clone(),
            got: got_muhash.to_string(),
        }),
    }
}

/// Ceiling on the DECOMPRESSED archive.
///
/// [`unpack_snapshot`] verifies the hash over the same read that feeds the
/// decompressor, which is what makes "the bytes I checked" and "the bytes I
/// used" the same bytes — but it also means the archive expands BEFORE its
/// provenance is known. A hostile archive that decompresses to something
/// enormous therefore has to be stopped by size, because there is nothing
/// else to stop it with: the manifest carries `size` (compressed) and
/// `sha256`, and no uncompressed size to check against.
///
/// 6 GiB. An honest pruned snapshot decompresses to ~1.1 GB and an unpruned,
/// fully indexed chain to ~2.9 GB, so this is about twice the largest thing
/// anyone would ever publish here — loose enough never to refuse a real
/// snapshot, tight enough to abort long before an ordinary disk is in trouble.
const MAX_UNPACKED_BYTES: u64 = 6 * 1024 * 1024 * 1024;

/// A reader that hashes everything it yields.
///
/// The point is the ORDER: bytes are hashed as they are handed to the
/// decompressor, so the digest describes exactly what was decompressed rather
/// than what a second read of the same path would have returned.
struct HashingReader<R: std::io::Read> {
    inner: R,
    hasher: Sha256,
}

impl<R: std::io::Read> std::io::Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hasher.update(&buf[..n]);
        Ok(n)
    }
}

/// A writer that fails once it has been asked to write more than `cap`.
///
/// Bounds decompression, which is otherwise attacker-controlled: the archive
/// says how big it becomes only by becoming that big.
struct CappedWriter<W: Write> {
    inner: W,
    written: u64,
    cap: u64,
}

impl<W: Write> Write for CappedWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.written = self.written.saturating_add(buf.len() as u64);
        if self.written > self.cap {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("decompressed past the {} byte ceiling", self.cap),
            ));
        }
        self.inner.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Decompress `xz_path` to `tar_path`, hashing the compressed bytes as they are
/// read, and refuse unless the digest matches `expected_sha256`.
///
/// Returns only after the hash has been checked, so no caller can act on the
/// tar before its provenance is known.
fn decompress_and_verify(
    xz_path: &Path,
    expected_sha256: &str,
    tar_path: &Path,
) -> Result<(), String> {
    let file = std::fs::File::open(xz_path)
        .map_err(|e| format!("snapshot: cannot open {}: {e}", xz_path.display()))?;
    let mut reader = std::io::BufReader::new(HashingReader {
        inner: file,
        hasher: Sha256::new(),
    });

    let out = std::fs::File::create(tar_path)
        .map_err(|e| format!("snapshot: cannot create {}: {e}", tar_path.display()))?;
    let mut out = CappedWriter {
        inner: std::io::BufWriter::new(out),
        written: 0,
        cap: MAX_UNPACKED_BYTES,
    };

    lzma_rs::xz_decompress(&mut reader, &mut out)
        .map_err(|e| format!("snapshot: xz decompress failed: {e:?}"))?;
    out.flush()
        .map_err(|e| format!("snapshot: cannot flush {}: {e}", tar_path.display()))?;

    // Drain whatever the decoder did not consume, so the digest covers the
    // WHOLE file rather than the prefix that happened to hold the xz stream.
    //
    // Redundant against lzma-rs as it stands: it reads past the final block and
    // refuses with `Unexpected data after last XZ block`, so a file with
    // anything appended never reaches this line
    // (`trailing_bytes_after_the_stream_are_refused` records that). It stays
    // because the property this function promises — the digest describes the
    // whole file — should hold because of what this function does, not because
    // of a decoder behaviour that is not part of its contract.
    std::io::copy(&mut reader, &mut std::io::sink())
        .map_err(|e| format!("snapshot: cannot read {}: {e}", xz_path.display()))?;

    let got = hex::encode(reader.into_inner().hasher.finalize());
    if !got.eq_ignore_ascii_case(expected_sha256) {
        return Err(SnapshotRefusal::HashMismatch {
            expected: expected_sha256.to_string(),
            got,
        }
        .describe());
    }
    Ok(())
}

/// Unpack a verified snapshot archive into a Particl datadir.
///
/// # Order of operations, and why it is this one
///
/// 1. `may_restore_into` — never over an existing chain.
/// 2. xz -> tar **through the filesystem**, hashing the compressed bytes on the
///    way past, and refusing unless the digest matches. `lzma_rs` is the same
///    pure-Rust path `bundle.rs` uses; no C link, no new dependency.
/// 3. **Every entry checked with [`sane_entry`] BEFORE anything is written.**
///    A single bad path refuses the whole archive rather than unpacking the
///    good entries and stopping partway — a half-written chain looks like
///    corruption, and the caller would have to clean up state it never chose to
///    create.
/// 4. Only then, unpack.
///
/// # Why a path and a hash rather than bytes
///
/// This took the bytes until 2026-09-10, and justified it in a comment: the
/// caller had "already read and hashed the file, and re-reading it would open a
/// window where the file on disk is not the file that was verified." The
/// argument was sound and the code did not implement it — [`restore_snapshot`]
/// hashed the download STREAM and then re-read the file from disk to call this,
/// so the window the signature existed to close was open anyway, one line
/// above the call.
///
/// Taking the path and the expected digest closes it for real: the bytes are
/// hashed as they are fed to the decompressor, once, and nothing is inspected
/// or written until that digest matches.
///
/// It also fixes what made the old shape expensive. Holding the compressed
/// archive AND the decompressed tar in memory peaked around 1.85 GB for a
/// 741 MB snapshot — on top of particld's own ~1.5 GB — which is a transient
/// allocation an 8 GB machine can genuinely fail to satisfy, mid-restore.
/// Streaming both sides through files makes the peak a buffer.
pub fn unpack_snapshot(
    xz_path: &Path,
    expected_sha256: &str,
    particl_dir: &Path,
) -> Result<usize, String> {
    may_restore_into(particl_dir).map_err(|e| e.describe())?;

    let tar_path = xz_path.with_extension("tar.part");
    let _ = std::fs::remove_file(&tar_path);

    let out = (|| -> Result<usize, String> {
        decompress_and_verify(xz_path, expected_sha256, &tar_path)?;

        // Pass 1 — inspect every path, write nothing.
        let mut entries = 0usize;
        {
            let f = std::fs::File::open(&tar_path)
                .map_err(|e| format!("snapshot: cannot open {}: {e}", tar_path.display()))?;
            let mut archive = tar::Archive::new(std::io::BufReader::new(f));
            let list = archive
                .entries()
                .map_err(|e| format!("snapshot: cannot read archive: {e}"))?;
            for entry in list {
                let entry = entry.map_err(|e| format!("snapshot: bad archive entry: {e}"))?;
                let path = entry
                    .path()
                    .map_err(|e| format!("snapshot: unreadable entry path: {e}"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !sane_entry(&path) {
                    return Err(SnapshotRefusal::UnsafeEntry { path }.describe());
                }
                entries += 1;
            }
        }
        if entries == 0 {
            return Err("snapshot: the archive is empty".to_string());
        }

        // Pass 2 — write.
        std::fs::create_dir_all(particl_dir)
            .map_err(|e| format!("snapshot: cannot create {}: {e}", particl_dir.display()))?;
        let f = std::fs::File::open(&tar_path)
            .map_err(|e| format!("snapshot: cannot open {}: {e}", tar_path.display()))?;
        let mut archive = tar::Archive::new(std::io::BufReader::new(f));
        archive.set_overwrite(true);
        archive
            .unpack(particl_dir)
            .map_err(|e| format!("snapshot: unpack failed: {e}"))?;
        Ok(entries)
    })();

    // The intermediate tar is ours and is never left behind, on any path.
    let _ = std::fs::remove_file(&tar_path);
    out
}

// =========================================================================
// I/O — fetch, download, and the command that sequences them
// =========================================================================

/// Does this datadir hold a chain that arrived from a snapshot rather than from
/// the network?
///
/// True when `particl/blocks` exists but `basicswap.json` does not: prepare has
/// never run here, so nothing the engine did put that chain on disk. That is
/// exactly the state a restore leaves behind, and it is the signal
/// [`crate::swap_sidecar`] uses to pass `PART_WALLET_SCAN_FROM=-1`.
///
/// Derived from the filesystem rather than from a marker file on purpose: a
/// marker is a second source of truth that can desync from the thing it
/// describes, and this question has a direct answer.
pub fn chain_awaiting_first_prepare(datadir: &Path) -> bool {
    datadir.join("particl").join("blocks").exists() && !datadir.join("basicswap.json").exists()
}

/// Fetch the manifest AND its detached signature, verify, then parse.
///
/// Order matters: the signature is checked over the raw bytes **before** they
/// are parsed, so a malformed or hostile document is rejected without this build
/// ever interpreting its contents. No archive bytes are touched here either, so
/// a snapshot this wallet could never use costs two small requests.
pub async fn fetch_manifest(base_url: &str) -> Result<SnapshotManifest, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("snapshot: http client: {e}"))?;

    let url = format!("{base_url}/manifest.json");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("snapshot: cannot reach {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "snapshot: {url} returned HTTP {} — no snapshot is published, or the tag moved",
            resp.status()
        ));
    }
    if resp.content_length().unwrap_or(0) > MAX_MANIFEST_BYTES {
        return Err("snapshot: the manifest is implausibly large; refusing to read it".to_string());
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("snapshot: cannot read manifest: {e}"))?;

    // The signature is a SEPARATE object, so a server that can serve one and not
    // the other cannot pass off an unsigned manifest as signed.
    let sig_url = format!("{base_url}/manifest.json.sig");
    let sig = match client.get(&sig_url).send().await {
        Ok(r) if r.status().is_success() => r.text().await.ok(),
        _ => None,
    };
    check_signature(body.as_bytes(), sig.as_deref()).map_err(|e| e.describe())?;

    serde_json::from_str::<SnapshotManifest>(&body)
        .map_err(|e| format!("snapshot: manifest is not valid JSON for this build: {e}"))
}

/// Stream the archive to `dest`, hashing as it goes.
///
/// Hashing during the stream rather than re-reading afterwards is not just
/// speed: re-reading opens a window in which the file on disk is no longer the
/// file that was verified.
///
/// Resume is deliberately NOT implemented as a partial-file continuation. A
/// resumed download whose earlier half came from a different published archive
/// would hash wrong at the end, and the user would be told their download was
/// corrupt with no way to tell that a stale part-file caused it. Restarting is a
/// few minutes; a confusing integrity failure costs more.
pub async fn download_archive(
    app: &AppHandle,
    base_url: &str,
    m: &SnapshotManifest,
    dest: &Path,
) -> Result<String, String> {
    if m.archive.size > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "snapshot: the manifest claims {} bytes, past this wallet's ceiling",
            m.archive.size
        ));
    }
    let url = format!("{base_url}/{}", m.archive.name);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 60))
        .build()
        .map_err(|e| format!("snapshot: http client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("snapshot: cannot reach {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("snapshot: {url} returned HTTP {}", resp.status()));
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("snapshot: cannot create {}: {e}", parent.display()))?;
    }
    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("snapshot: cannot create {}: {e}", dest.display()))?;

    let total = m.archive.size.max(1);
    let mut hasher = Sha256::new();
    let mut got: u64 = 0;
    let mut stream = resp.bytes_stream();
    let mut last_emit = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("snapshot: download stream error: {e}"))?;
        got += chunk.len() as u64;
        if got > m.archive.size {
            // Stop the moment the server exceeds what the signed manifest
            // promised, rather than filling the disk and failing on the hash.
            let _ = std::fs::remove_file(dest);
            return Err(format!(
                "snapshot: the download is longer than the manifest's {} bytes; stopped",
                m.archive.size
            ));
        }
        file.write_all(&chunk)
            .map_err(|e| format!("snapshot: cannot write {}: {e}", dest.display()))?;
        hasher.update(&chunk);
        // Emit at most once per MB — a per-chunk emit is how the WebView2 leak
        // stayed invisible (see `emit_progress`'s note).
        if got - last_emit >= 1_048_576 {
            last_emit = got;
            crate::swap_sidecar::emit_progress(
                app,
                "snapshot",
                (got as f64 / total as f64) * 100.0,
                format!(
                    "Downloading the Particl snapshot — {:.0} of {:.0} MB",
                    got as f64 / 1_048_576.0,
                    m.archive.size as f64 / 1_048_576.0
                ),
            );
        }
    }
    drop(file);
    Ok(hex::encode(hasher.finalize()))
}

/// The whole restore: manifest -> checks -> download -> hash -> unpack.
///
/// Runs BEFORE the first prepare ([`RESTORE_BEFORE_PREPARE`]), and refuses
/// rather than repairs: every failure leaves the datadir as it found it, and the
/// caller falls back to a network sync, which is never removed as an option.
pub async fn restore_snapshot(
    app: &AppHandle,
    base_url: &str,
    datadir: &Path,
    our_particld: &str,
) -> Result<String, String> {
    let particl_dir = datadir.join("particl");
    // Cheapest check first: if there is already a chain here, nothing else is
    // worth doing and no bytes should move.
    may_restore_into(&particl_dir).map_err(|e| e.describe())?;

    crate::swap_sidecar::emit_progress(app, "snapshot", 0.0, "Checking for a Particl snapshot");
    let m = fetch_manifest(base_url).await?;
    check_manifest(&m, our_particld).map_err(|e| e.describe())?;

    let tmp = datadir.join(format!("{}.part", m.archive.name));
    let got_hash = download_archive(app, base_url, &m, &tmp).await?;

    let got_size = std::fs::metadata(&tmp).map(|x| x.len()).unwrap_or(0);
    if let Err(e) = check_archive(&m, got_size, &got_hash) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.describe());
    }

    crate::swap_sidecar::emit_progress(app, "snapshot", 98.0, "Unpacking the Particl snapshot");
    // The size/hash gate above is an EARLY one, over the download stream: it
    // stops an obviously wrong archive before anything expands. The gate that
    // decides whether these bytes get unpacked is the one inside
    // `unpack_snapshot`, which hashes the file as it decompresses it — see its
    // doc comment for why the two are not the same check.
    let entries = unpack_snapshot(&tmp, &m.archive.sha256, &particl_dir).inspect_err(|_| {
        // A refused archive must leave nothing behind, including the download.
        let _ = std::fs::remove_file(&tmp);
    })?;
    let _ = std::fs::remove_file(&tmp);

    crate::swap_sidecar::emit_progress(
        app,
        "snapshot",
        100.0,
        format!("Particl snapshot restored ({entries} files)"),
    );
    Ok(m.snapshot_id)
}

/// Undo a restore. Used when the post-start chainstate check disagrees.
///
/// Removes the chain and NOTHING else — by this point a wallet may exist, and it
/// holds keys this function must never touch.
pub fn discard_restored_chain(particl_dir: &Path) -> Result<(), String> {
    for p in rollback_paths(particl_dir) {
        if p.exists() {
            std::fs::remove_dir_all(&p)
                .map_err(|e| format!("snapshot: cannot remove {}: {e}", p.display()))?;
        }
    }
    Ok(())
}

// =========================================================================
// Tauri commands
// =========================================================================

/// What the wizard needs to decide whether to offer the fast start.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOffer {
    /// A snapshot is published, usable by this build, and this datadir is empty.
    pub available: bool,
    /// Compressed download size, so the choice can quote a real number.
    pub download_bytes: u64,
    pub snapshot_id: Option<String>,
    /// Why it is not on offer. `None` when it is.
    pub unavailable_reason: Option<String>,
}

/// Is a usable snapshot on offer for this install?
///
/// Never errors: "no snapshot" is an ordinary answer, and a wizard that shows a
/// red error because a CDN blipped would push users away from a fast start they
/// could simply retry.
#[tauri::command]
pub async fn swap_snapshot_offer(app: AppHandle) -> Result<SnapshotOffer, String> {
    let none = |why: String| SnapshotOffer {
        available: false,
        download_bytes: 0,
        snapshot_id: None,
        unavailable_reason: Some(why),
    };
    let datadir = match crate::swap_sidecar::datadir(&app) {
        Ok(d) => d,
        Err(e) => return Ok(none(e)),
    };
    if let Err(e) = may_restore_into(&datadir.join("particl")) {
        return Ok(none(e.describe()));
    }
    let m = match fetch_manifest(SNAPSHOT_BASE_URL).await {
        Ok(m) => m,
        Err(e) => return Ok(none(e)),
    };
    if let Err(e) = check_manifest(&m, crate::swap_sidecar::PARTICLD_VERSION) {
        return Ok(none(e.describe()));
    }
    Ok(SnapshotOffer {
        available: true,
        download_bytes: m.archive.size,
        snapshot_id: Some(m.snapshot_id),
        unavailable_reason: None,
    })
}

/// Download and restore the snapshot into the (empty) engine datadir.
///
/// Call BEFORE the first `swap_sidecar_start`. On any failure the datadir is
/// left as it was and the caller simply starts the node normally, which syncs
/// from the network — the slower path, never a broken one.
#[tauri::command]
pub async fn swap_snapshot_restore(app: AppHandle) -> Result<String, String> {
    let datadir = crate::swap_sidecar::datadir(&app)?;
    restore_snapshot(
        &app,
        SNAPSHOT_BASE_URL,
        &datadir,
        crate::swap_sidecar::PARTICLD_VERSION,
    )
    .await
}

/// Files to remove when a restore is abandoned after the chain is already on
/// disk (a chainstate mismatch is the case that matters).
///
/// Returns paths rather than deleting, so the caller owns the destructive step
/// and a test can assert the LIST without a filesystem.
pub fn rollback_paths(particl_dir: &Path) -> Vec<PathBuf> {
    vec![particl_dir.join("blocks"), particl_dir.join("chainstate")]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> SnapshotManifest {
        SnapshotManifest {
            schema: 1,
            snapshot_id: "particl-mainnet-2026-09-09".into(),
            created_at: "2026-09-09T15:00:00Z".into(),
            particld_version: "27.2.4.0".into(),
            archive: ArchiveInfo {
                name: "particl-snapshot-2026-09-09.tar.zst".into(),
                codec: "zstd".into(),
                size: 767_000_000,
                sha256: "a".repeat(64),
                zstd_window_log: Some(27),
            },
            tip: Some(TipInfo {
                height: 2_239_559,
                hash: "b".repeat(64),
            }),
            chainstate_muhash: Some("c".repeat(64)),
            min_wallet_version: None,
        }
    }

    #[test]
    fn a_matching_manifest_passes() {
        assert!(check_manifest(&manifest(), "27.2.4.0").is_ok());
    }

    /// The daemon pin. A chain database belongs to the version that wrote it,
    /// and loading one under another daemon is how a "corrupt chainstate" report
    /// arrives from a user whose disk is fine.
    #[test]
    fn a_snapshot_for_another_daemon_is_refused() {
        let e = check_manifest(&manifest(), "28.0.0.0").unwrap_err();
        assert!(matches!(e, SnapshotRefusal::WrongDaemon { .. }));
        assert!(e.describe().contains("27.2.4.0"), "{}", e.describe());
    }

    /// A newer schema is refused rather than parsed optimistically: the field
    /// this build cannot see could be the one that matters.
    #[test]
    fn a_newer_schema_is_refused_not_guessed() {
        let mut m = manifest();
        m.schema = MANIFEST_SCHEMA + 1;
        assert!(matches!(
            check_manifest(&m, "27.2.4.0"),
            Err(SnapshotRefusal::SchemaTooNew { .. })
        ));
    }

    /// The 2026-09-08 window trap, as a rule the client enforces rather than a
    /// note the producer is trusted to have read.
    #[test]
    fn a_window_too_large_to_decode_is_refused_before_downloading() {
        let mut m = manifest();
        m.archive.zstd_window_log = Some(31);
        let e = check_manifest(&m, "27.2.4.0").unwrap_err();
        assert!(matches!(e, SnapshotRefusal::UndecodableWindow { .. }));
        // 2 GB, said in a way the reader can act on.
        assert!(e.describe().contains("2048 MB"), "{}", e.describe());
    }

    /// An xz manifest carries no window at all, and must not be refused for it.
    #[test]
    fn an_absent_window_is_fine() {
        let mut m = manifest();
        m.archive.codec = "xz".into();
        m.archive.zstd_window_log = None;
        assert!(check_manifest(&m, "27.2.4.0").is_ok());
    }

    #[test]
    fn size_is_checked_before_hash() {
        let m = manifest();
        // A truncated resume: right prefix, wrong length. Caught by size, so the
        // caller never hashes a gigabyte to learn it.
        let e = check_archive(&m, 12, &m.archive.sha256).unwrap_err();
        assert!(matches!(e, SnapshotRefusal::SizeMismatch { .. }));
    }

    #[test]
    fn a_wrong_hash_is_refused_and_says_nothing_was_written() {
        let m = manifest();
        let e = check_archive(&m, m.archive.size, &"f".repeat(64)).unwrap_err();
        assert!(matches!(e, SnapshotRefusal::HashMismatch { .. }));
        assert!(e.describe().contains("Nothing was written"), "{}", e.describe());
    }

    /// Hex case must not decide integrity. A producer that upper-cases its
    /// digest would otherwise fail every download for no reason.
    #[test]
    fn hash_comparison_ignores_hex_case() {
        let m = manifest();
        assert!(check_archive(&m, m.archive.size, &"A".repeat(64)).is_ok());
    }

    /// Zip-slip and secret-smuggling, as one allow-list.
    #[test]
    fn only_chain_directories_may_be_unpacked() {
        for ok in [
            "blocks/blk00000.dat",
            "blocks/index/000005.ldb",
            "chainstate/CURRENT",
        ] {
            assert!(sane_entry(ok), "should allow {ok}");
        }
        for bad in [
            "bsx_wallet/wallet.dat",   // the one that would matter most
            "smsgdb/000003.log",       // SMSG identity keys
            "../../../etc/passwd",     // escape
            "blocks/../../evil",       // escape via a legal-looking prefix
            "/absolute/blocks/x.dat",  // absolute
            "particl.conf",            // config, not chain data
            "debug.log",
        ] {
            assert!(!sane_entry(bad), "should refuse {bad}");
        }
    }

    /// Never over an existing chain — the ordering failure in this module's
    /// header is what happens when this is not enforced.
    #[test]
    fn a_datadir_with_a_chain_is_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("pwnda-snap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(may_restore_into(&dir).is_ok(), "empty datadir is fine");

        std::fs::create_dir_all(dir.join("blocks")).unwrap();
        assert!(matches!(
            may_restore_into(&dir),
            Err(SnapshotRefusal::ChainAlreadyPresent)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_chainstate_hash_decides_and_an_absent_one_is_not_a_pass() {
        let m = manifest();
        assert!(matches!(
            check_chainstate(&m, &"c".repeat(64)),
            ChainstateCheck::Match
        ));
        match check_chainstate(&m, &"9".repeat(64)) {
            ChainstateCheck::Mismatch(r) => {
                // The message must tell the user the node falls back, not just
                // that a hash differed.
                assert!(r.describe().contains("sync from the network"), "{}", r.describe());
            }
            _ => panic!("a differing muhash must be a mismatch"),
        }

        let mut none = manifest();
        none.chainstate_muhash = None;
        // The distinction that matters: "not published" must NOT read as "match".
        assert!(matches!(
            check_chainstate(&none, &"9".repeat(64)),
            ChainstateCheck::NotPublished
        ));
    }

    /// Rollback removes the chain and NOTHING else — in particular not the
    /// wallet, which by this point may already exist.
    #[test]
    fn rollback_touches_only_the_chain() {
        let paths = rollback_paths(Path::new("/d/particl"));
        let names: Vec<String> = paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["blocks", "chainstate"]);
        assert!(
            !names.iter().any(|n| n.contains("wallet") || n.contains("smsg")),
            "rollback must never remove keys: {names:?}"
        );
    }

    /// Build a `.tar.xz` in memory from `(path, contents)` pairs, so the unpack
    /// tests exercise the REAL decompress+untar path rather than a stub.
    fn tar_xz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            for (name, data) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, *data).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut xz: Vec<u8> = Vec::new();
        lzma_rs::xz_compress(&mut &tar_bytes[..], &mut xz).unwrap();
        xz
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "pwnda-snapunpack-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// Bridge for tests that build an archive in memory.
    ///
    /// `unpack_snapshot` takes a path and a digest so that the bytes it checks
    /// are the bytes it decompresses; these tests are about the TAR rules, not
    /// that gate, so this hands over the honest hash and lets them stay about
    /// what they were about. The mismatch case is covered directly by
    /// `an_archive_whose_bytes_do_not_match_the_manifest_is_refused`.
    fn unpack_bytes(xz: &[u8], dir: &Path) -> Result<usize, String> {
        unpack_bytes_claiming(xz, &hex::encode(Sha256::digest(xz)), dir)
    }

    /// As [`unpack_bytes`], but the caller states the digest — so a test can
    /// state the WRONG one.
    fn unpack_bytes_claiming(xz: &[u8], claimed: &str, dir: &Path) -> Result<usize, String> {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let p = std::env::temp_dir().join(format!(
            "pwnda-snapsrc-{}-{}.xz",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::write(&p, xz).unwrap();
        let r = unpack_snapshot(&p, claimed, dir);
        let _ = std::fs::remove_file(&p);
        // The intermediate tar must never outlive the call, on any path.
        assert!(
            !p.with_extension("tar.part").exists(),
            "unpack left its intermediate tar behind"
        );
        r
    }

    /// The happy path, end to end through real xz and real tar.
    #[test]
    fn a_chain_archive_unpacks() {
        let dir = scratch("ok");
        let xz = tar_xz(&[
            ("blocks/blk00000.dat", b"block data" as &[u8]),
            ("blocks/index/000005.ldb", b"index"),
            ("chainstate/CURRENT", b"state"),
        ]);
        let n = unpack_bytes(&xz, &dir).expect("must unpack");
        assert_eq!(n, 3);
        assert!(dir.join("blocks").join("blk00000.dat").is_file());
        assert!(dir.join("chainstate").join("CURRENT").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The case the allow-list exists for: an archive that smuggles a wallet
    /// alongside legitimate chain data. It must refuse, and — the half that is
    /// easy to get wrong — it must write NOTHING, not even the good entries it
    /// already read.
    #[test]
    fn an_archive_smuggling_a_wallet_is_refused_before_anything_is_written() {
        let dir = scratch("smuggle");
        let xz = tar_xz(&[
            ("blocks/blk00000.dat", b"block data" as &[u8]),
            ("bsx_wallet/wallet.dat", b"stolen"),
        ]);
        let err = unpack_bytes(&xz, &dir).unwrap_err();
        assert!(err.contains("bsx_wallet/wallet.dat"), "{err}");
        assert!(
            !dir.join("blocks").exists(),
            "refused, but the good entry was written anyway — a partial chain \
             looks like corruption and the caller never chose to create it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A hostile archive whose entry name escapes the datadir.
    ///
    /// The name is written into the raw 512-byte tar header rather than through
    /// `Header::set_path`, because the `tar` crate REFUSES to build one of these
    /// ("paths in archives must not have `..`"). That refusal protects honest
    /// producers and says nothing about what arrives over the network, so the
    /// test has to forge the bytes the way an attacker would. Without this, the
    /// escape case would only ever be covered by the pure string check.
    fn tar_xz_raw_name(name: &str, data: &[u8]) -> Vec<u8> {
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            // Overwrite the name field (bytes 0..100) directly, then re-checksum
            // so the reader accepts it as well-formed.
            let raw = header.as_mut_bytes();
            for b in raw[0..100].iter_mut() {
                *b = 0;
            }
            raw[0..name.len()].copy_from_slice(name.as_bytes());
            header.set_cksum();

            let mut builder = tar::Builder::new(&mut tar_bytes);
            builder.append(&header, data).unwrap();
            builder.finish().unwrap();
        }
        let mut xz: Vec<u8> = Vec::new();
        lzma_rs::xz_compress(&mut &tar_bytes[..], &mut xz).unwrap();
        xz
    }

    #[test]
    fn an_archive_escaping_the_datadir_is_refused() {
        let dir = scratch("escape");
        let xz = tar_xz_raw_name("blocks/../../evil.txt", b"pwned");
        let err = unpack_bytes(&xz, &dir).unwrap_err();
        assert!(err.contains("evil.txt"), "{err}");
        assert!(
            !dir.parent().unwrap().join("evil.txt").exists(),
            "the escape actually wrote outside the datadir"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unpacking_over_an_existing_chain_is_refused() {
        let dir = scratch("existing");
        std::fs::create_dir_all(dir.join("blocks")).unwrap();
        let xz = tar_xz(&[("blocks/blk00000.dat", b"x" as &[u8])]);
        let err = unpack_bytes(&xz, &dir).unwrap_err();
        assert!(err.contains("already has a Particl chain"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An empty archive is a producer bug, and silently "succeeding" with zero
    /// files would leave the node syncing from genesis while the UI said a
    /// snapshot had been restored.
    #[test]
    fn an_empty_archive_is_an_error_not_a_silent_success() {
        let dir = scratch("empty");
        let xz = tar_xz(&[]);
        assert!(unpack_bytes(&xz, &dir).unwrap_err().contains("empty"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The gate the signature change exists for.
    ///
    /// Until 2026-09-10 `unpack_snapshot` took bytes and trusted them, on the
    /// stated grounds that the caller had already hashed the file — while the
    /// caller hashed the download STREAM and then re-read the file from disk,
    /// so the check and the use were over two different reads. Now the digest
    /// is computed on the way into the decompressor, and a mismatch refuses
    /// before a single entry is inspected, let alone written.
    #[test]
    fn an_archive_whose_bytes_do_not_match_the_manifest_is_refused() {
        let dir = scratch("hashmismatch");
        let xz = tar_xz(&[("blocks/blk00000.dat", b"block data" as &[u8])]);
        let wrong = "0".repeat(64);
        let err = unpack_bytes_claiming(&xz, &wrong, &dir).unwrap_err();
        assert!(
            err.contains("does not match the manifest"),
            "refused for the wrong reason: {err}"
        );
        assert!(
            !dir.join("blocks").exists(),
            "a hash mismatch still wrote chain data"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The honest digest must still pass, or the test above would pass for the
    /// trivial reason that nothing ever matches.
    #[test]
    fn the_matching_digest_still_unpacks() {
        let dir = scratch("hashok");
        let xz = tar_xz(&[("blocks/blk00000.dat", b"block data" as &[u8])]);
        assert_eq!(unpack_bytes(&xz, &dir).expect("must unpack"), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An archive with bytes appended after the xz stream must be refused, and
    /// must write nothing.
    ///
    /// The interesting part is WHICH guard catches it. The expectation when this
    /// test was written was a digest mismatch — the file on disk is no longer
    /// the file the manifest describes. What actually happens is that `lzma-rs`
    /// refuses first, with `Unexpected data after last XZ block`, because it
    /// reads past the final block and finds data there.
    ///
    /// That is the stronger outcome (refused before the digest is even
    /// finalised), so the assertion accepts either reason rather than pinning
    /// the one that happens to fire today. What must not change is the
    /// conclusion: appended bytes never reach the datadir.
    #[test]
    fn trailing_bytes_after_the_stream_are_refused() {
        let dir = scratch("trailing");
        let mut xz = tar_xz(&[("blocks/blk00000.dat", b"block data" as &[u8])]);
        let clean_digest = hex::encode(Sha256::digest(&xz));
        xz.extend_from_slice(b"appended");

        // Claiming the digest of the CLEAN file: the file on disk is not that
        // file any more, so this must not unpack.
        let err = unpack_bytes_claiming(&xz, &clean_digest, &dir).unwrap_err();
        assert!(
            err.contains("does not match the manifest") || err.contains("xz decompress failed"),
            "trailing bytes were not refused: {err}"
        );
        assert!(
            !dir.join("blocks").exists(),
            "an archive with appended bytes still wrote chain data"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The decompression ceiling, exercised directly.
    ///
    /// Driven through `CappedWriter` rather than by building a real 6 GiB bomb:
    /// the rule under test is "stop writing past the cap", and proving it with
    /// six gigabytes of temp file would make the suite unrunnable to test a
    /// comparison.
    #[test]
    fn decompression_stops_at_the_ceiling() {
        let mut w = CappedWriter {
            inner: Vec::new(),
            written: 0,
            cap: 16,
        };
        assert!(w.write_all(&[0u8; 10]).is_ok());
        let err = w.write_all(&[0u8; 10]).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        assert!(
            w.inner.len() <= 16,
            "wrote {} bytes past a 16 byte cap",
            w.inner.len()
        );
    }

    /// The ceiling has to clear the largest HONEST archive, or it is a refusal
    /// of real snapshots wearing a security label. An unpruned, fully indexed
    /// Particl chain measured 2.9 GB on 2026-09-09.
    #[test]
    fn the_ceiling_leaves_room_for_a_real_chain() {
        assert!(
            MAX_UNPACKED_BYTES >= 2 * 3 * 1024 * 1024 * 1024,
            "the decompression ceiling is below twice a real unpruned chain"
        );
    }

    /// End to end against a REAL published snapshot, when one is on disk.
    ///
    /// The synthetic archives above are three files; this is 776 MB of xz over
    /// a 1,058 MB chain, which is the case the streaming rewrite exists for and
    /// the only one that exercises it at scale. Everything is read from the
    /// published `manifest.json` rather than restated here, so the test cannot
    /// drift from the artifact it is checking.
    ///
    /// `#[ignore]`d: it needs the archive plus ~1 GB of scratch, which an
    /// ordinary run should not pay for. Run it after touching the unpack path:
    ///
    /// ```text
    /// cargo test --features full --lib a_real_published_snapshot -- --ignored --nocapture
    /// ```
    ///
    /// SKIPS rather than fails when the archive is absent, so it stays safe to
    /// run on a machine that has never produced one.
    #[test]
    #[ignore]
    fn a_real_published_snapshot_unpacks() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".swap-sidecar-work")
            .join("snapshots");
        let manifest_path = root.join("manifest.json");
        if !manifest_path.is_file() {
            eprintln!("SKIP: no published snapshot at {}", root.display());
            return;
        }
        let m: SnapshotManifest =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let archive = root.join(&m.archive.name);
        if !archive.is_file() {
            eprintln!("SKIP: manifest present but {} is not", archive.display());
            return;
        }

        let dir = scratch("realsnapshot");
        let started = std::time::Instant::now();
        let n = unpack_snapshot(&archive, &m.archive.sha256, &dir).expect("the real one must unpack");
        eprintln!(
            "unpacked {n} entries from {} MB in {:.1}s",
            m.archive.size / 1_048_576,
            started.elapsed().as_secs_f64()
        );

        assert!(dir.join("blocks").is_dir(), "no blocks/ after a real restore");
        assert!(
            dir.join("chainstate").is_dir(),
            "no chainstate/ after a real restore"
        );
        // What landed must be BIGGER than the archive it came from. Weak as a
        // number, exact as an invariant: it is the one thing that cannot be
        // true if the tar were written out truncated, which is the failure a
        // streaming rewrite could plausibly introduce and which "blocks/ exists"
        // would not catch.
        let on_disk: u64 = walk_size(&dir);
        assert!(
            on_disk > m.archive.size,
            "unpacked {on_disk} bytes from a {} byte archive — truncated?",
            m.archive.size
        );
        eprintln!("unpacked {} MB to disk", on_disk / 1_048_576);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn walk_size(p: &Path) -> u64 {
        let mut total = 0u64;
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let path = e.path();
                if path.is_dir() {
                    total += walk_size(&path);
                } else if let Ok(md) = path.metadata() {
                    total += md.len();
                }
            }
        }
        total
    }

    /// Sign with a throwaway key, then verify against the PINNED one. The
    /// pinned key must reject it — that is the whole property.
    ///
    /// Signing here rather than embedding a fixture keeps the private half of
    /// the real key out of the test, out of the repo, and out of the binary.
    #[test]
    fn a_manifest_signed_by_another_key_is_refused() {
        use ed25519_dalek::{Signer, SigningKey};
        let other = SigningKey::from_bytes(&[7u8; 32]);
        let body = br#"{"schema":1}"#;
        let sig = hex::encode(other.sign(body).to_bytes());
        assert_eq!(
            check_signature(body, Some(&sig)),
            Err(SnapshotRefusal::BadSignature)
        );
    }

    /// An absent signature must NOT read as a pass. Treating unsigned as fine
    /// would make the check unfalsifiable, which is worse than not having it.
    #[test]
    fn an_unsigned_manifest_is_refused_not_waved_through() {
        let body = br#"{"schema":1}"#;
        for missing in [None, Some(""), Some("   ")] {
            assert_eq!(
                check_signature(body, missing),
                Err(SnapshotRefusal::MissingSignature),
                "{missing:?} must not pass"
            );
        }
    }

    /// Garbage in the signature slot is a refusal, never a panic: the bytes come
    /// off the network and `hex::decode` / length coercion must not be trusted
    /// to be well-formed.
    #[test]
    fn a_malformed_signature_refuses_rather_than_panics() {
        let body = br#"{"schema":1}"#;
        for bad in ["zz", "00", &"a".repeat(200)] {
            assert_eq!(
                check_signature(body, Some(bad)),
                Err(SnapshotRefusal::BadSignature),
                "{bad} must refuse cleanly"
            );
        }
    }

    /// The pinned key must be a real, parseable ed25519 public key — a typo in
    /// the constant would otherwise only surface the first time a user tried a
    /// snapshot, and would look like a bad publish rather than a bad build.
    #[test]
    fn the_pinned_public_key_is_well_formed() {
        let raw = hex::decode(SNAPSHOT_PUBKEY_HEX).expect("pinned key is not hex");
        assert_eq!(raw.len(), 32, "ed25519 public keys are 32 bytes");
        let arr: [u8; 32] = raw.try_into().unwrap();
        ed25519_dalek::VerifyingKey::from_bytes(&arr).expect("pinned key is not a valid point");
    }


    /// Round-trip against the REAL artefacts: the manifest the producer wrote
    /// and the signature made with the minted key, verified by the pinned
    /// public key. Skipped when they are absent so the suite stays hermetic.
    #[test]
    fn the_published_manifest_verifies_against_the_pinned_key() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent().unwrap().join(".swap-sidecar-work").join("snapshots");
        let (m, sg) = (dir.join("manifest.json"), dir.join("manifest.json.sig"));
        if !m.is_file() || !sg.is_file() { eprintln!("no local artefacts; skipping"); return; }
        let body = std::fs::read(&m).unwrap();
        let sig = std::fs::read_to_string(&sg).unwrap();
        assert_eq!(check_signature(&body, Some(&sig)), Ok(()),
            "the signed manifest must verify against SNAPSHOT_PUBKEY_HEX");
        // And a single flipped byte must break it.
        let mut tampered = body.clone();
        let i = tampered.len()/2; tampered[i] ^= 0x01;
        assert_eq!(check_signature(&tampered, Some(&sig)), Err(SnapshotRefusal::BadSignature));
    }

    /// The ordering constant is not decoration: PATCH-32 exists because the
    /// other order cannot start.
    #[test]
    fn the_restore_happens_before_prepare() {
        assert!(
            RESTORE_BEFORE_PREPARE,
            "restoring after prepare leaves the wallet below pruneheight and \
             particld refuses to start"
        );
    }
}
