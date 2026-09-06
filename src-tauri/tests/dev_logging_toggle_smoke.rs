//! Smoke tests for the master `dev_logging_active` toggle.
//!
//! Same Windows-cdylib pattern as the sibling integration tests — this
//! file is self-contained (no `use tauri_eth_wallet_lib::...`) because
//! the lib crate's `crate-type = ["lib", "cdylib", "staticlib"]` makes
//! `cargo test` integration tests that link the lib fail with
//! STATUS_ENTRYPOINT_NOT_FOUND on Windows. See rust-lang/cargo#5754.
//!
//! These tests verify the behavioural CONTRACT of the toggle by
//! replicating its env-var resolution logic in-test. The production
//! implementation lives in `src/dev_fee/logger.rs::dev_logging_active`
//! and `set_dev_logging_active`. If the production logic changes,
//! mirror the change here.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

// Re-implementation of `dev_logging_active`'s env-var resolution.
fn resolve_default(env_value: Option<&str>, default_on: bool) -> bool {
    match env_value {
        Some(v) => {
            let s = v.trim().to_ascii_lowercase();
            match s.as_str() {
                "on" | "true" | "1" | "yes" => true,
                "off" | "false" | "0" | "no" => false,
                _ => default_on,
            }
        }
        None => default_on,
    }
}

#[test]
fn env_var_unset_defaults_to_on() {
    assert!(resolve_default(None, true));
}

#[test]
fn env_var_off_disables() {
    assert!(!resolve_default(Some("off"), true));
    assert!(!resolve_default(Some("OFF"), true));
    assert!(!resolve_default(Some("false"), true));
    assert!(!resolve_default(Some("0"), true));
    assert!(!resolve_default(Some("no"), true));
}

#[test]
fn env_var_on_enables() {
    assert!(resolve_default(Some("on"), false));
    assert!(resolve_default(Some("ON"), false));
    assert!(resolve_default(Some("true"), false));
    assert!(resolve_default(Some("1"), false));
    assert!(resolve_default(Some("yes"), false));
}

#[test]
fn env_var_garbage_falls_through_to_default() {
    // Unrecognised values must NOT silently disable — they fall back to
    // the default (ON in debug, OFF in release).
    assert!(resolve_default(Some("maybe"), true));
    assert!(!resolve_default(Some("maybe"), false));
    assert!(resolve_default(Some(""), true));
}

#[test]
fn env_var_whitespace_tolerated() {
    assert!(!resolve_default(Some("  off  "), true));
    assert!(resolve_default(Some("\toff "), false) == false);
    assert!(resolve_default(Some("on\n"), false));
}

/// Verify the shared-state semantics — once init has consumed the env,
/// subsequent writes must be visible to subsequent reads. This is the
/// `set_dev_logging_active(false) → dev_logging_active() == false` contract.
#[test]
fn shared_atomic_reflects_writes_after_init() {
    static INIT: Once = Once::new();
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    INIT.call_once(|| {
        // Default ON.
        ACTIVE.store(true, Ordering::Relaxed);
    });
    assert!(ACTIVE.load(Ordering::Relaxed));
    // Flip to off, like set_dev_logging_active(false) would.
    ACTIVE.store(false, Ordering::Relaxed);
    assert!(!ACTIVE.load(Ordering::Relaxed));
    // Flip back on.
    ACTIVE.store(true, Ordering::Relaxed);
    assert!(ACTIVE.load(Ordering::Relaxed));
}

/// Verify that consuming the Once before a write means subsequent
/// `init.call_once` invocations don't overwrite the manual store.
/// This is the load-bearing semantic for `set_dev_logging_active` —
/// it calls `ensure_init` first to consume the Once, then stores its
/// value. Future `dev_logging_active` calls hit the same Once (no-op)
/// then read the stored value.
#[test]
fn once_consumed_before_write_preserves_store() {
    static INIT: Once = Once::new();
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    // First read — env default would set true.
    let _consume = || {
        INIT.call_once(|| {
            ACTIVE.store(true, Ordering::Relaxed);
        });
    };
    _consume();
    assert!(ACTIVE.load(Ordering::Relaxed));
    // Manual flip off (simulates set_dev_logging_active).
    ACTIVE.store(false, Ordering::Relaxed);
    assert!(!ACTIVE.load(Ordering::Relaxed));
    // A second consumer of the Once must not re-run the closure.
    _consume();
    assert!(!ACTIVE.load(Ordering::Relaxed), "Once re-ran and clobbered the manual write");
}
