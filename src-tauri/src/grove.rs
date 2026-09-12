//! Pwnda Grove runtime identity — *what engine is actually about to run*.
//!
//! # Why this module exists
//!
//! Grove is PWNDA's distribution of BasicSwap: a pinned upstream tag plus the
//! re-appliable series in `upstream/patches/`. `scripts/apply-engine-patches.mjs`
//! writes a `pwnda-grove.json` stamp into the runtime it patched, and re-measures
//! the `PWNDA-PATCH-<n>` markers on `--check` so a lying stamp is reported as
//! `GROVE-STAMP-DRIFT`.
//!
//! All of that lived **only in Node**. The supervisor that actually launches the
//! engine ([`crate::swap_sidecar`]) asked exactly one question — "is there a
//! `python.exe`?" — and started whatever it found. That is the same blind spot
//! that produced the incident the identifier was invented for: on 2026-08-25
//! PWNDA-PATCH-9, the change-address fix that stops funds landing past the BIP-44
//! gap limit, was found **absent from the running mainnet node** three days after
//! being committed and documented. The bug it fixes had therefore never stopped
//! happening, and nothing reported the gap because nothing was checking *the
//! running thing* — only the repo.
//!
//! So the launcher now reads the stamp and says what it found.
//!
//! # What this module does NOT do
//!
//! It does not re-measure markers. The stamp is a **claim**; the markers in the
//! files each patch touches are the **evidence**, and re-deriving that in Rust
//! would mean carrying a second copy of the patch parser that can disagree with
//! the first. `apply-engine-patches.mjs --check` remains the authority on
//! marker-level truth.
//!
//! What Rust *can* cheaply answer, and could not before, is the question that
//! actually bit us: **does the runtime on disk claim to be the engine this build
//! was written against?** A stamp reading `+p11` under a binary expecting `+p12`
//! is exactly the 2026-08-25 fault, and it is now visible at a glance.
//!
//! # Why a mismatch WARNS rather than blocks
//!
//! Refusing to start on a stamp mismatch would let a metadata problem strand a
//! user's node — and the stamp is the weaker of the two signals by construction
//! (an unstamped-but-correct runtime is entirely possible; a hand-staged dev tree
//! is the normal case). Detection, surfaced loudly, is the deliverable here; the
//! patch that follows is the operator's call. This mirrors the project's
//! loud-in-log-precedes-notification discipline.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Filename the Node stamper writes. Mirrors `scripts/lib/grove-id.mjs::STAMP_FILE`.
pub const STAMP_FILE: &str = "pwnda-grove.json";

/// Distribution slug. Mirrors `grove-id.mjs::DISTRO_SLUG`.
pub const DISTRO_SLUG: &str = "pwnda-grove";

/// The upstream BasicSwap version this build is written against.
///
/// Pinned by `upstream/README.md`'s table and `scripts/fetch-swap-runtime.mjs`'s
/// `PIN_BASICSWAP_TAG`. Kept honest by [`tests::expected_version_matches_the_pin`]
/// — the constant cannot drift from the pin without a test going red, which is the
/// whole point: a *restated* version in a comment is what went stale before.
pub const EXPECTED_UPSTREAM_VERSION: &str = "0.18.6";

/// How many patches the series carries. Kept honest by
/// [`tests::expected_patch_level_matches_the_series`], which counts
/// `upstream/patches/*.patch` — so appending a patch and forgetting this constant
/// fails the build rather than silently shipping a supervisor that accepts a
/// runtime one patch behind.
/// NOTE (2026-09-04): the series has 24 files but the ENGINE level is 23.
/// Patch 0022 fixes the shared ADS *test* helpers, and the basicswap wheel
/// ships the package without its test suite, so no assembled runtime can ever
/// carry it. `apply-engine-patches.mjs` marks such patches EXEMPT and keeps
/// them out of the level in BOTH directions -- otherwise a source tree (which
/// has tests/) would report p23 while a runtime reported p22, and this
/// constant could only ever match one of them.
///
/// 21 -> 23 on 2026-09-04: 0023 (BCH electrum branches on BCHInterface's
/// overrides + the P2SH lock scripthash) and 0024 (WalletManager cashaddr
/// scripthash). Both touch `basicswap/`, so both count. This constant was the
/// ONLY thing that caught the two sides drifting -- the patches, the runtime
/// stamp and the shipped bundle had all moved to p23 while this said 21, and
/// a supervisor built from it would have rejected the very runtime the same
/// build ships. Exactly the paired-site shape 0020/0021/0023 are named for.
///
/// 23 -> 25 on 2026-09-04 (later the same day): 0025 (prepare skips
/// host-managed wallets; `waitForDaemonRPC` stops retrying a credential
/// rejection — the ten-minute ZANO start/stop) and 0026 (ZEPH/ZANO in the
/// console UI: settings page, offers page, the JS coin registries). Both
/// touch `basicswap/`, so both count.
///
/// 26 -> 27 on 2026-09-05: 0028 prices ZEPH as `zephyr-protocol` rather than
/// `zephyr`, a different CoinGecko asset worth about 4% as much — the console
/// valued a 67.27 ZEPH balance at $1.19 against the wallet's $27.08, and the
/// same rates feed the offer book. (0027 landed with the p27 runtime, which
/// stamps p26: the level is a COUNT of engine patches, and 0022 is exempt.)
/// 27 -> 29 on 2026-09-08: 0029 (lock-tx-B RPC errors counted CONSECUTIVELY,
/// and never escalating a PREREFUND bid whose remedy is chain-A only -- a
/// transient Monero outage had been parking live swaps in BID_ERROR, which
/// is terminal for the adaptor-sig machine) and 0030 (pwndaRecoverStalledBid
/// returns such a bid to the timelock path instead of refusing it on the
/// grounds that the timelock path -- the thing BID_ERROR stops -- will
/// handle it). Both touch `basicswap/`, so both count.
/// 29 -> 30 on 2026-09-09: 0031 (`PART_PRUNE` makes upstream's Particl conf
/// writer emit `prune=` and omit `spentindex`/`txindex`). It touches
/// `basicswap/`, so it counts. The patch has to exist at all because `prepare`
/// starts particld itself, so the supervisor cannot fix the conf afterwards --
/// particld aborts with "You need to rebuild the database using -reindex to
/// change -spentindex". Off by default; absent the env var upstream behaviour
/// is byte-identical.
/// 30 -> 31 on 2026-09-09: 0032 (`PART_WALLET_SCAN_FROM` skips or bounds the
/// `extkeyimportmaster` birthday scan). It touches `basicswap/`, so it counts.
/// Needed because a restored snapshot cannot be started at all without it: a
/// scan-everything wallet either blows the 10 s RPC timeout (151 s rescan) or,
/// created against an empty chain first, ends up below `pruneheight` and
/// particld refuses to start. Off by default; absent the env var the call is
/// upstream's own single-argument form.
pub const EXPECTED_PATCH_LEVEL: u32 = 32;

/// The identifier this build expects a correctly-patched runtime to carry,
/// e.g. `pwnda-grove 0.18.5+p26`.
///
/// `+pN` is semver **build metadata** on purpose (it does not affect precedence),
/// so upstream still sorts as upstream.
pub fn expected_id() -> String {
    format!(
        "{} {}+p{}",
        DISTRO_SLUG, EXPECTED_UPSTREAM_VERSION, EXPECTED_PATCH_LEVEL
    )
}

/// What the supervisor found when it looked at the runtime it is about to start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum EngineIdentity {
    /// No interpreter on disk — nothing installed yet. Not a fault.
    NoRuntime,
    /// A runtime is installed but carries no stamp. Either it predates the
    /// stamper or it was staged by hand; its patch level is **unknown**, which is
    /// a weaker statement than "wrong" and is reported as such.
    Unstamped,
    /// Stamped, and the stamp equals what this build expects.
    Ok { id: String },
    /// Stamped, and the stamp disagrees with this build. The 2026-08-25 shape.
    ///
    /// Whether this is anyone's PROBLEM is not carried here: it depends on
    /// whether the build ships an engine payload to self-heal from, which is
    /// already reported as `SidecarStatus::bundle_available` (the same
    /// `bundle_has(.., "grove")` check `reconcile_bundled_engine` gates on).
    /// The UI pairs the two rather than duplicating the answer.
    Drift { stamped: String, expected: String },
}

impl EngineIdentity {
    /// True when the runtime is present and not known-good — i.e. worth saying
    /// out loud. `NoRuntime` is deliberately *not* a concern: "not installed" is
    /// an ordinary pre-install state, already carried by `runtime_installed`.
    pub fn is_concerning(&self) -> bool {
        matches!(self, Self::Unstamped | Self::Drift { .. })
    }
}

/// The runtime root that owns a given interpreter.
///
/// Derived from the interpreter rather than from the app's `runtime_dir()`
/// because `PWNDA_SWAP_SIDECAR_PYTHON` can point the supervisor at a hand-built
/// venv somewhere else entirely — and a dev runtime is exactly where an
/// unstamped or stale tree is most likely to be, so it is the case that most
/// needs identifying rather than the one to skip.
///
/// * Windows embeddable — `<root>/python.exe`  -> `<root>`
/// * POSIX prefix layout — `<root>/bin/python3` -> `<root>`
pub fn runtime_root_for(python: &Path) -> Option<PathBuf> {
    let parent = python.parent()?;
    if parent.file_name().and_then(|n| n.to_str()) == Some("bin") {
        return parent.parent().map(Path::to_path_buf);
    }
    Some(parent.to_path_buf())
}

/// Every place a stamp may sit, in resolution order.
///
/// Mirrors `grove-id.mjs::stampCandidates`, and it needs all three for the same
/// reason that function does: the **applier** targets the directory holding
/// `basicswap/` (site-packages) while the **supervisor** knows the runtime root.
/// Those are different directories, and an earlier Node wiring stamped one and
/// read the other. The third form is the Linux layout, whose `python3.NN` segment
/// has to be scanned for rather than guessed.
fn stamp_candidates(runtime_dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![
        runtime_dir.join(STAMP_FILE),
        runtime_dir.join("Lib").join("site-packages").join(STAMP_FILE),
    ];
    // <runtime>/lib/python3.12/site-packages/pwnda-grove.json — the version
    // segment is not knowable ahead of time, so enumerate rather than assume.
    if let Ok(entries) = std::fs::read_dir(runtime_dir.join("lib")) {
        let mut found: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("python"))
            })
            .map(|p| p.join("site-packages").join(STAMP_FILE))
            .collect();
        // Deterministic order: a runtime with two python dirs must not identify
        // differently between runs.
        found.sort();
        out.extend(found);
    }
    out
}

/// The `id` field of the first stamp found, if any.
///
/// A stamp that exists but is unparseable, or carries no `id`, reads the same as
/// no stamp: we know we do not know. It deliberately does not error — an
/// unreadable metadata file is not a reason to refuse to start an engine.
pub fn read_stamp_id(runtime_dir: &Path) -> Option<String> {
    for path in stamp_candidates(runtime_dir) {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
            if !id.trim().is_empty() {
                return Some(id.trim().to_string());
            }
        }
    }
    None
}

/// Identify the runtime the supervisor is about to start.
///
/// `runtime_installed` is passed in rather than re-derived so this stays a pure
/// function of (directory, interpreter-present) and can be tested without a
/// Tauri `AppHandle`.
pub fn identify(runtime_dir: &Path, runtime_installed: bool) -> EngineIdentity {
    if !runtime_installed {
        return EngineIdentity::NoRuntime;
    }
    match read_stamp_id(runtime_dir) {
        None => EngineIdentity::Unstamped,
        Some(stamped) => {
            let expected = expected_id();
            if stamped == expected {
                EngineIdentity::Ok { id: stamped }
            } else {
                EngineIdentity::Drift { stamped, expected }
            }
        }
    }
}

/// One line for the log, phrased so the fix is obvious from the message alone.
pub fn describe(identity: &EngineIdentity) -> String {
    match identity {
        EngineIdentity::NoRuntime => "no swap engine installed".to_string(),
        EngineIdentity::Unstamped => format!(
            "swap engine carries no {STAMP_FILE} — patch level UNKNOWN (expected {}). \
             Run: node scripts/apply-engine-patches.mjs --check",
            expected_id()
        ),
        EngineIdentity::Ok { id } => format!("swap engine is {id}"),
        EngineIdentity::Drift { stamped, expected } => format!(
            "GROVE-STAMP-DRIFT: swap engine claims {stamped}, this build expects {expected}. \
             The running engine is NOT the one this build was written against. \
             Run: node scripts/apply-engine-patches.mjs --check"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo_root() -> PathBuf {
        // CARGO_MANIFEST_DIR is <repo>/src-tauri
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent")
            .to_path_buf()
    }

    /// Per-test scratch dir. Tagged per test because these all run in one
    /// process — a shared pid-only name would let one test read another's stamp.
    /// Cleared on entry so a rerun after a failure starts from nothing.
    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "pwnda-grove-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// Only the FORMAT is asserted here. Restating the version would re-arm the
    /// exact trap this module exists to close -- and the two guard tests below
    /// already pin both constants to the repo, so a wrong value fails there,
    /// where the message can name the remedy.
    #[test]
    fn expected_id_has_the_grove_shape() {
        let id = expected_id();
        assert!(id.starts_with("pwnda-grove "), "bad slug: {id}");
        let rest = id.trim_start_matches("pwnda-grove ");
        let (ver, patch) = rest.split_once("+p").expect("missing +p<N>: {id}");
        assert_eq!(ver, EXPECTED_UPSTREAM_VERSION);
        assert_eq!(patch.parse::<u32>().unwrap(), EXPECTED_PATCH_LEVEL);
        assert_eq!(ver.split('.').count(), 3, "version is not x.y.z: {ver}");
    }

    #[test]
    fn runtime_root_resolves_both_platform_layouts() {
        // Windows embeddable
        assert_eq!(
            runtime_root_for(Path::new("/x/runtime/python.exe")),
            Some(PathBuf::from("/x/runtime"))
        );
        // POSIX prefix — the `bin/` hop must not be mistaken for the root, or
        // the Linux stamp scan would look under `<root>/bin/lib/python*`.
        assert_eq!(
            runtime_root_for(Path::new("/x/runtime/bin/python3")),
            Some(PathBuf::from("/x/runtime"))
        );
    }

    /// The constant must equal the number of patches actually in the series.
    ///
    /// This is the guard that makes [`EXPECTED_PATCH_LEVEL`] load-bearing instead
    /// of decorative: append `0013-*.patch` and this goes red, so the supervisor
    /// can never quietly keep accepting a runtime one patch behind the repo.
    #[test]
    fn expected_patch_level_matches_the_series() {
        let dir = repo_root().join("upstream").join("patches");
        let mut engine = 0u32;
        let mut exempt: Vec<String> = Vec::new();
        for entry in fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
            .flatten()
        {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("patch") {
                continue;
            }
            let text = fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));

            // The SAME rule apply-engine-patches.mjs::isPackageExempt uses: a
            // patch that touches nothing under `basicswap/` is not an engine
            // patch and cannot reach an assembled runtime, because the wheel
            // ships the package without its test suite. Counted here so this
            // guard keeps working -- adding a real engine patch without bumping
            // the constant must still fail -- while a test-only patch does not
            // make the constant permanently unreachable.
            //
            // Restated rather than shared because the two live in different
            // languages; the risk of them drifting is why both name the rule in
            // the same words and why this message points at the other one.
            // BOTH header sides. `diff --git` is missing from 0009-0012, and
            // `--- a/` is `/dev/null` for the file-creating patches 0013/0015
            // (the ZEPH and ZANO coin modules) -- either omission alone
            // mislabels real engine patches as exempt.
            let touches_package = text.lines().any(|l| {
                l.starts_with("--- a/basicswap/") || l.starts_with("+++ b/basicswap/")
            });
            if touches_package {
                engine += 1;
            } else {
                exempt.push(
                    path.file_name()
                        .and_then(|x| x.to_str())
                        .unwrap_or("?")
                        .to_string(),
                );
            }
        }
        exempt.sort();
        assert_eq!(
            engine, EXPECTED_PATCH_LEVEL,
            "upstream/patches/ holds {engine} ENGINE patches but \
             EXPECTED_PATCH_LEVEL is {EXPECTED_PATCH_LEVEL}. Update the constant \
             (and re-stamp the runtime). Non-engine patches, excluded because no \
             runtime can carry them and they must not make this constant \
             unreachable: {exempt:?}. The rule matches \
             apply-engine-patches.mjs::isPackageExempt -- a patch touching no \
             basicswap/ path."
        );
        assert!(
            engine > 0,
            "no engine patches counted at all -- the layout moved and this test \
             went blind rather than red"
        );
    }

    /// The constant must equal the pinned upstream tag.
    ///
    /// `scripts/fetch-swap-runtime.mjs` is the machine-readable half of the pin
    /// table in `upstream/README.md`; parsing it here means moving the pin without
    /// updating this module is a test failure rather than a stale comment. That
    /// stale comment is not hypothetical — `swap_sidecar.rs` restated `v0.17.9`
    /// for two days after the pin moved to `v0.18.4`.
    /// [GROVE FIX 2026-09-12] Derive the expectation from the pinned SOURCE's
    /// `__version__`, NOT from the tag string.
    ///
    /// Upstream does not always bump `basicswap/__init__.py` when it tags.
    /// v0.18.7 and v0.18.6 BOTH declare `__version__ = "0.18.6"`, and nothing in
    /// the gap touched that file. This test used to strip the "v" off
    /// PIN_BASICSWAP_TAG, so moving the pin to v0.18.7 made it demand "0.18.7"
    /// from a runtime that can only ever report "0.18.6" — an assertion no build
    /// could satisfy.
    ///
    /// It is upstream's own bug and it is known: their matrix channel has
    /// "The new version still has 0.18.6 in basicswap/__init__.py" and a user
    /// reporting the UI nagging him to update a node that is already updated,
    /// for exactly this reason. We should not encode their slip as our
    /// invariant. What a runtime reports is what the package declares, so that
    /// is what this compares against.
    #[test]
    fn expected_version_matches_the_pin() {
        let path = repo_root()
            .join("upstream")
            .join("basicswap")
            .join("basicswap")
            .join("__init__.py");
        let src = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        let marker = "__version__ = \"";
        let start = src
            .find(marker)
            .expect("__version__ not found in the pinned basicswap source")
            + marker.len();
        let declared = &src[start..start + src[start..].find('"').expect("unterminated version")];
        assert_eq!(
            declared, EXPECTED_UPSTREAM_VERSION,
            "the pinned source declares {declared} but EXPECTED_UPSTREAM_VERSION is              {EXPECTED_UPSTREAM_VERSION}"
        );
    }

    /// The tag still has to be recorded somewhere a human reads, even when it
    /// cannot be compared against `__version__`. This asserts the two pins that
    /// DO name the tag agree with each other, so the runtime-identity gap above
    /// cannot also hide a pin-table/fetch-script split.
    #[test]
    fn pin_table_and_fetch_script_name_the_same_tag() {
        let fetch = fs::read_to_string(repo_root().join("scripts").join("fetch-swap-runtime.mjs"))
            .expect("cannot read fetch-swap-runtime.mjs");
        let marker = "const PIN_BASICSWAP_TAG = \"";
        let start = fetch.find(marker).expect("PIN_BASICSWAP_TAG not found") + marker.len();
        let tag = &fetch[start..start + fetch[start..].find('"').expect("unterminated pin")];

        let readme = fs::read_to_string(repo_root().join("upstream").join("README.md"))
            .expect("cannot read upstream/README.md");
        assert!(
            readme.contains(&format!("**{tag}**")),
            "fetch-swap-runtime pins {tag} but upstream/README.md's table does not name it"
        );
    }

    fn write_stamp(at: &Path, id: &str) {
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(at, format!(r#"{{"name":"Pwnda Grove","id":"{id}"}}"#)).unwrap();
    }

    #[test]
    fn reads_a_stamp_at_the_runtime_root() {
        let tmp = tmpdir("root");
        write_stamp(&tmp.join(STAMP_FILE), &expected_id());
        assert_eq!(read_stamp_id(&tmp).as_deref(), Some(expected_id().as_str()));
    }

    #[test]
    fn reads_a_stamp_in_the_windows_site_packages_layout() {
        let tmp = tmpdir("win");
        write_stamp(
            &tmp.join("Lib").join("site-packages").join(STAMP_FILE),
            &expected_id(),
        );
        assert_eq!(read_stamp_id(&tmp).as_deref(), Some(expected_id().as_str()));
    }

    /// The Linux layout the Node `--check` walk cannot even discover on its own
    /// (it keys on `python.exe` + `Lib/`), so Rust must not inherit that blind spot.
    #[test]
    fn reads_a_stamp_in_the_linux_versioned_layout() {
        let tmp = tmpdir("linux");
        write_stamp(
            &tmp.join("lib")
                .join("python3.12")
                .join("site-packages")
                .join(STAMP_FILE),
            &expected_id(),
        );
        assert_eq!(read_stamp_id(&tmp).as_deref(), Some(expected_id().as_str()));
    }

    #[test]
    fn no_runtime_beats_every_other_verdict() {
        let tmp = tmpdir("noruntime");
        write_stamp(&tmp.join(STAMP_FILE), &expected_id());
        assert_eq!(identify(&tmp, false), EngineIdentity::NoRuntime);
    }

    #[test]
    fn an_installed_runtime_with_no_stamp_is_unstamped_not_ok() {
        let tmp = tmpdir("unstamped");
        assert_eq!(identify(&tmp, true), EngineIdentity::Unstamped);
        assert!(identify(&tmp, true).is_concerning());
    }

    /// The 2026-08-25 shape: a runtime one patch behind the build.
    #[test]
    fn a_patch_behind_is_reported_as_drift() {
        let tmp = tmpdir("drift");
        let behind = format!(
            "pwnda-grove {}+p{}",
            EXPECTED_UPSTREAM_VERSION,
            EXPECTED_PATCH_LEVEL - 1
        );
        write_stamp(&tmp.join(STAMP_FILE), &behind);
        let got = identify(&tmp, true);
        assert_eq!(
            got,
            EngineIdentity::Drift {
                stamped: behind,
                expected: expected_id(),
            }
        );
        assert!(got.is_concerning());
        assert!(describe(&got).contains("GROVE-STAMP-DRIFT"));
    }

    /// An older upstream base is drift too, not just a lower patch level.
    #[test]
    fn an_older_upstream_base_is_drift() {
        let tmp = tmpdir("oldbase");
        write_stamp(&tmp.join(STAMP_FILE), "pwnda-grove 0.17.9+p12");
        assert!(identify(&tmp, true).is_concerning());
    }

    #[test]
    fn a_matching_stamp_is_ok_and_not_concerning() {
        let tmp = tmpdir("ok");
        write_stamp(&tmp.join(STAMP_FILE), &expected_id());
        let got = identify(&tmp, true);
        assert_eq!(got, EngineIdentity::Ok { id: expected_id() });
        assert!(!got.is_concerning());
    }

    /// A corrupt stamp must read as "unknown", never as a match — the failure
    /// mode to avoid is a parse error quietly becoming a pass.
    #[test]
    fn a_corrupt_stamp_reads_as_unstamped() {
        let tmp = tmpdir("corrupt");
        fs::write(tmp.join(STAMP_FILE), "{not json").unwrap();
        assert_eq!(identify(&tmp, true), EngineIdentity::Unstamped);
    }
}
