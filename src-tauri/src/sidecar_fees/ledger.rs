//! Durable per-swap fee records.
//!
//! **Never a running balance.** The operator rejected an accruing obligation:
//! each swap is charged on its own or not at all. What lives here is a transient
//! record per settled swap, not a debt.
//!
//! # Two deliberate departures from the sidecar's existing state files
//!
//! 1. **Reads return `Result`.** `swap_sidecar::read_optin` swallows every error
//!    into `default()`, which is right for consent and *wrong* here: a corrupt
//!    ledger silently reading as "no pending fees" is the lost-obligation hazard
//!    itself. A parse failure means *do not collect until reconciled*.
//! 2. **Writes are atomic.** Temp file + rename. The attempt marker is written
//!    immediately BEFORE a withdraw, so a crash in that window must leave a
//!    record that survives and is unambiguous.
//!
//! # At-most-once, on purpose
//!
//! Nothing spans "withdraw on a node we do not own" and "record the txid". A
//! crash between them is possible, so the choice is which way to fail. A missed
//! fee is a rounding error; a double charge takes a user's money twice and is a
//! defect on funds. So an [`FeeState::Attempting`] record found at startup
//! becomes [`FeeState::Indeterminate`] and is **never auto-retried** — it is
//! surfaced for a human to reconcile against the wallet.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Where a record can be in its life.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum FeeState {
    /// Seen, not yet terminal. Keep polling.
    Watching,
    /// Terminal, and nothing is owed. Closed.
    NoFee { reason: String },
    /// Eligible and priced, but the fee is **not live** — recorded by a dark
    /// run so the decision can be audited against real swaps before any money
    /// path is enabled. Closed: a dark run never becomes a charge retroactively,
    /// because charging for a swap that settled while collection was off would
    /// be a surprise to the user.
    Observed { ticker: String, amount: u64, notional: u64, at: String },
    /// A withdraw is about to be issued, or was issued and we have not yet
    /// recorded the outcome. Written BEFORE the network call.
    Attempting { ticker: String, amount: u64, at: String },
    /// Collected. Closed.
    Paid { ticker: String, amount: u64, txid: String, at: String },
    /// We attempted and cannot prove the outcome. NEVER retried automatically.
    Indeterminate { ticker: String, amount: u64, note: String },
    /// Eligible, but deferred — the send-scripted fallback (§1.7). Retried.
    Deferred { ticker: String, amount: u64, until: String, tries: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeeRecord {
    pub bid_id: String,
    #[serde(flatten)]
    pub state: FeeState,
    /// Free-text, for the history surface. Never parsed.
    ///
    /// Named `detail` and not `note` on purpose: `state` is `#[serde(flatten)]`d
    /// and `FeeState::Indeterminate` already carries a `note`, so two fields
    /// called `note` collapse into one key and serde refuses the record with
    /// `duplicate field \`note\``. Caught by `round_trips_every_state` — a
    /// flattened enum silently sharing a field name with its container is an
    /// easy bug to write and an invisible one to read.
    #[serde(default)]
    pub detail: String,
}

impl FeeRecord {
    pub fn watching(bid_id: &str) -> Self {
        Self { bid_id: bid_id.to_string(), state: FeeState::Watching, detail: String::new() }
    }
    /// Whether the watcher should keep resolving this bid.
    pub fn is_open(&self) -> bool {
        matches!(self.state, FeeState::Watching | FeeState::Deferred { .. })
    }
    /// Whether this record still represents money that might move.
    pub fn is_settled_forever(&self) -> bool {
        matches!(
            self.state,
            FeeState::NoFee { .. }
                | FeeState::Observed { .. }
                | FeeState::Paid { .. }
                | FeeState::Indeterminate { .. }
        )
    }
}

/// A bid id is a filename here, so it must not be able to escape the directory.
///
/// `pub(super)` so the watcher's sweep can screen a row's id with the SAME
/// rule the write path enforces. Two copies of this check would be two
/// chances to disagree, and the disagreement would surface as a whole poll
/// aborting on one malformed row.
pub(super) fn safe_id(bid_id: &str) -> Result<String, String> {
    let id = bid_id.trim();
    if id.is_empty() || id.len() > 128 {
        return Err(format!("implausible bid id {bid_id:?}"));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("bid id {bid_id:?} is not filename-safe"));
    }
    Ok(id.to_string())
}

pub fn record_path(dir: &Path, bid_id: &str) -> Result<PathBuf, String> {
    Ok(dir.join(format!("{}.json", safe_id(bid_id)?)))
}

/// Write atomically: a partially written record must never be readable.
pub fn write(dir: &Path, rec: &FeeRecord) -> Result<(), String> {
    let path = record_path(dir, &rec.bid_id)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let body = serde_json::to_string_pretty(rec).map_err(|e| format!("serialise: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    // Windows rename-over-existing needs the destination gone first.
    let _ = std::fs::remove_file(&path);
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename into {}: {e}", path.display()))?;
    Ok(())
}

/// Read one record. `Ok(None)` means absent; `Err` means present-but-unusable,
/// which is emphatically not the same thing.
pub fn read(dir: &Path, bid_id: &str) -> Result<Option<FeeRecord>, String> {
    let path = record_path(dir, bid_id)?;
    match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("record {} is corrupt: {e}", path.display())),
    }
}

/// Every record, for the startup rehydrate.
///
/// Returns the good records AND the paths that would not parse. The caller must
/// not treat a corrupt file as absent — see the module header.
pub fn load_all(dir: &Path) -> (Vec<FeeRecord>, Vec<String>) {
    let mut out = Vec::new();
    let mut bad = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (out, bad);
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&p) {
            Ok(s) => match serde_json::from_str::<FeeRecord>(&s) {
                Ok(r) => out.push(r),
                Err(err) => bad.push(format!("{}: {err}", p.display())),
            },
            Err(err) => bad.push(format!("{}: {err}", p.display())),
        }
    }
    out.sort_by(|a, b| a.bid_id.cmp(&b.bid_id));
    (out, bad)
}

/// The baseline marker: when this wallet FIRST began watching for fees.
///
/// Deliberately **not** a `.json` file. [`load_all`] treats every `*.json` in
/// this directory as a [`FeeRecord`], and [`reconcile_on_start`] refuses to
/// collect when any of them will not parse — so a marker carrying that
/// extension would have bricked the watcher the moment it was written.
/// `the_baseline_marker_is_not_mistaken_for_a_record` pins that.
const BASELINE_FILE: &str = "first-started.marker";

pub fn baseline_path(dir: &Path) -> PathBuf {
    dir.join(BASELINE_FILE)
}

/// Read the baseline, creating it at *now* the first time. Unix seconds.
///
/// **Bids created before this are never charged.** On a first live start the
/// swap node's database can already hold every swap the user has ever
/// completed, and charging those retroactively would take money for swaps that
/// settled while collection was off — the precise surprise [`FeeState::Observed`]
/// exists to avoid, applied to the case a dark run cannot cover because release
/// builds cannot run dark.
///
/// It is a written marker rather than something derived from the ledger because
/// it has to survive the ledger being empty for any reason: a fresh install, a
/// deleted directory, or an existing install upgrading into this code with no
/// records yet. Re-creating it later re-baselines to that moment, which
/// under-collects and can never over-collect.
///
/// A marker that exists but cannot be parsed is an **error**, not a reason to
/// start again: re-baselining silently would be harmless the first time and
/// would hide, every time after, that something is wrong with the directory we
/// are about to record payments in.
pub fn read_or_create_baseline(dir: &Path) -> Result<i64, String> {
    let path = baseline_path(dir);
    match std::fs::read_to_string(&path) {
        Ok(s) => chrono::DateTime::parse_from_rfc3339(s.trim())
            .map(|d| d.timestamp())
            .map_err(|e| {
                format!(
                    "the baseline marker {} is unreadable ({e}); refusing to guess when                      fee watching began, because guessing early charges swaps that                      settled before it",
                    path.display()
                )
            }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
            let now = chrono::Utc::now();
            std::fs::write(&path, now.to_rfc3339())
                .map_err(|e| format!("write {}: {e}", path.display()))?;
            Ok(now.timestamp())
        }
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Startup reconciliation: an `Attempting` record means we crashed mid-withdraw.
///
/// It becomes `Indeterminate` and is never retried. Returns how many were
/// converted, so the caller can say it out loud.
pub fn reconcile_on_start(dir: &Path) -> Result<usize, String> {
    let (records, bad) = load_all(dir);
    if !bad.is_empty() {
        return Err(format!(
            "{} unreadable fee record(s); refusing to collect until reconciled:\n  {}",
            bad.len(),
            bad.join("\n  ")
        ));
    }
    let mut n = 0;
    for mut rec in records {
        if let FeeState::Attempting { ticker, amount, at } = rec.state.clone() {
            rec.state = FeeState::Indeterminate {
                ticker,
                amount,
                note: format!(
                    "a withdraw was in flight at {at} when the wallet stopped; \
                     outcome unknown. NOT retried automatically — check the wallet \
                     for a matching payment before doing anything."
                ),
            };
            write(dir, &rec)?;
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .join(format!("pwnda-fee-ledger-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn round_trips_every_state() {
        let d = tmpdir("roundtrip");
        let states = [
            FeeState::Watching,
            FeeState::NoFee { reason: "noScriptlessLeg".into() },
            FeeState::Observed {
                ticker: "LTC".into(),
                amount: 22_738,
                notional: 1_000_000,
                at: "t".into(),
            },
            FeeState::Attempting { ticker: "LTC".into(), amount: 22_738, at: "t".into() },
            FeeState::Paid {
                ticker: "LTC".into(),
                amount: 22_738,
                txid: "deadbeef".into(),
                at: "t".into(),
            },
            FeeState::Indeterminate { ticker: "LTC".into(), amount: 1, note: "n".into() },
            FeeState::Deferred { ticker: "LTC".into(), amount: 1, until: "t".into(), tries: 2 },
        ];
        for (i, st) in states.iter().enumerate() {
            let rec = FeeRecord {
                bid_id: format!("bid{i}"),
                state: st.clone(),
                detail: String::new(),
            };
            write(&d, &rec).unwrap();
            assert_eq!(read(&d, &rec.bid_id).unwrap().unwrap(), rec);
        }
        let (all, bad) = load_all(&d);
        assert_eq!(all.len(), states.len());
        assert!(bad.is_empty());
    }

    #[test]
    fn absent_and_corrupt_are_different_answers() {
        let d = tmpdir("corrupt");
        assert_eq!(read(&d, "nope").unwrap(), None, "absent must be Ok(None)");

        std::fs::write(d.join("broken.json"), "{not json").unwrap();
        assert!(read(&d, "broken").is_err(), "corrupt must be Err, never Ok(None)");

        let (good, bad) = load_all(&d);
        assert!(good.is_empty());
        assert_eq!(bad.len(), 1, "load_all must REPORT the corrupt file");
    }

    /// The whole point of the Result-typed read: a corrupt ledger must stop
    /// collection, not read as "nothing owed".
    #[test]
    fn reconcile_refuses_when_a_record_is_unreadable() {
        let d = tmpdir("refuse");
        std::fs::write(d.join("broken.json"), "{").unwrap();
        let err = reconcile_on_start(&d).expect_err("must refuse");
        assert!(err.contains("refusing to collect"), "{err}");
    }

    /// At-most-once. A crash mid-withdraw must NOT re-issue the payment.
    #[test]
    fn an_interrupted_attempt_becomes_indeterminate_and_is_not_retried() {
        let d = tmpdir("attempt");
        let rec = FeeRecord {
            bid_id: "abc123".into(),
            state: FeeState::Attempting {
                ticker: "LTC".into(),
                amount: 22_738,
                at: "2026-08-29T00:00:00Z".into(),
            },
            detail: String::new(),
        };
        write(&d, &rec).unwrap();

        assert_eq!(reconcile_on_start(&d).unwrap(), 1);

        let after = read(&d, "abc123").unwrap().unwrap();
        match after.state {
            FeeState::Indeterminate { amount, .. } => assert_eq!(amount, 22_738),
            other => panic!("expected Indeterminate, got {other:?}"),
        }
        assert!(!after.is_open(), "an indeterminate record must not be re-attempted");

        // Idempotent: a second reconcile converts nothing more.
        assert_eq!(reconcile_on_start(&d).unwrap(), 0);
    }

    #[test]
    fn the_baseline_is_created_once_and_then_reread() {
        let d = tmpdir("baseline");
        let first = read_or_create_baseline(&d).unwrap();
        let again = read_or_create_baseline(&d).unwrap();
        assert_eq!(first, again, "the baseline must not move on restart");
        assert!(first > 1_700_000_000, "a plausible unix time, got {first}");
    }

    /// The marker shares a directory with the records, so it must not read as
    /// one. If `load_all` reported it as corrupt, `reconcile_on_start` would
    /// refuse to collect — permanently, and for a file we wrote ourselves.
    #[test]
    fn the_baseline_marker_is_not_mistaken_for_a_record() {
        let d = tmpdir("baseline-record");
        read_or_create_baseline(&d).unwrap();
        write(&d, &FeeRecord::watching("abc123")).unwrap();

        let (good, bad) = load_all(&d);
        assert_eq!(good.len(), 1, "only the record is a record");
        assert!(bad.is_empty(), "the marker must not look unreadable: {bad:?}");
        assert_eq!(reconcile_on_start(&d).unwrap(), 0);
    }

    /// Re-baselining on a corrupt marker would silently start charging from
    /// "now" — which is safe once and wrong every time after.
    #[test]
    fn a_corrupt_baseline_refuses_rather_than_rebaselining() {
        let d = tmpdir("baseline-corrupt");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(baseline_path(&d), "sometime last tuesday").unwrap();
        let err = read_or_create_baseline(&d).expect_err("must refuse");
        assert!(err.contains("refusing to guess"), "{err}");
    }

    #[test]
    fn bid_ids_cannot_escape_the_directory() {
        let d = tmpdir("escape");
        for bad in ["../evil", "a/b", "a\\b", "", "  ", "a:b"] {
            assert!(record_path(&d, bad).is_err(), "{bad:?} must be refused");
        }
        assert!(record_path(&d, "00000000deadbeef").is_ok());
    }

    #[test]
    fn open_vs_closed_is_explicit() {
        assert!(FeeRecord::watching("x").is_open());
        let paid = FeeRecord {
            bid_id: "x".into(),
            state: FeeState::Paid {
                ticker: "LTC".into(),
                amount: 1,
                txid: "t".into(),
                at: "t".into(),
            },
            detail: String::new(),
        };
        assert!(!paid.is_open());
        assert!(paid.is_settled_forever());
    }
}
