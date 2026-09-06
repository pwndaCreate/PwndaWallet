//! Process-wide Tauri-event emit meter (dev diagnostics).
//!
//! Counts every `app.emit(<event>, …)` the backend performs, keyed by the
//! event name, so a native-memory leak hunt can see *which* event stream is
//! flooding the WebView2 IPC layer without instrumenting each call site by
//! hand at read time.
//!
//! ## Why this exists
//!
//! The 2026-05-29 PwndaLite native leak (WebView2 renderer → ~14 GB) was an
//! un-consumed `dev-fee-log` Tauri-event firehose: high-frequency
//! `app.emit`s with no frontend listener accumulate in the renderer's native
//! IPC layer, invisible to `performance.memory` (which only sees the V8 JS
//! heap). The listener-gate fix (`dev_fee/logger.rs`) closed that one — but
//! the 2026-05-30 session showed the WebView2 process still climbing
//! 740 MB → 5.5 GB while the dev-fee gate sat at `emitted = 0`. That proves a
//! *second*, distinct emit firehose. Rather than guess which `app.emit` it
//! is, this meter counts them all by name; the `mem_watch` sampler writes the
//! top emitters into each `mem-native-*.jsonl` line, so the next long session
//! names the culprit automatically.
//!
//! ## Usage
//!
//! Call [`bump`] immediately before (or after) any `app.emit(name, …)`:
//!
//! ```ignore
//! crate::emit_meter::bump("dev-fee-log");
//! let _ = app.emit("dev-fee-log", &record);
//! ```
//!
//! [`top_summary`] returns a compact `"name=count, …"` string (highest first)
//! for embedding in the memory sample. Zero cost in principle but cheap in
//! practice — a single `Mutex<HashMap>` updated at emit cadence, which for a
//! firehose is the same order as the emit itself.
//!
//! Dev-diagnostic only; nothing here changes shipped behavior. It does NOT
//! gate or suppress any emit — it only counts. (Suppression is the
//! per-subsystem listener gate's job.)

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

/// event-name → cumulative emit count since process start.
fn counts() -> &'static Mutex<HashMap<&'static str, u64>> {
    static COUNTS: OnceLock<Mutex<HashMap<&'static str, u64>>> = OnceLock::new();
    COUNTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record one emit of `event`. Lock poisoning is treated as fail-open (a
/// dropped count is never worth interrupting an emit). `event` is a
/// `&'static str` so the map key is allocation-free.
#[inline]
pub fn bump(event: &'static str) {
    if let Ok(mut g) = counts().lock() {
        *g.entry(event).or_insert(0) += 1;
    }
}

/// Total emits across all event names since process start.
pub fn total() -> u64 {
    counts().lock().map(|g| g.values().sum()).unwrap_or(0)
}

/// Compact `"name=count, name=count, …"` of the top `n` event names by count,
/// highest first. Embedded in `mem-native-*.jsonl` so a leak hunt can read
/// which stream dominates without a separate tool. Empty string when nothing
/// has emitted yet.
pub fn top_summary(n: usize) -> String {
    let g = match counts().lock() {
        Ok(g) => g,
        Err(_) => return String::new(),
    };
    let mut pairs: Vec<(&'static str, u64)> = g.iter().map(|(k, v)| (*k, *v)).collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1));
    pairs
        .into_iter()
        .take(n)
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bump_and_summary_order_by_count() {
        // Note: counts are process-global; this test only checks relative
        // ordering of the names it bumps, not absolute totals.
        for _ in 0..5 {
            bump("emit-meter-test-a");
        }
        for _ in 0..2 {
            bump("emit-meter-test-b");
        }
        let s = top_summary(20);
        let ia = s.find("emit-meter-test-a=5");
        let ib = s.find("emit-meter-test-b=2");
        assert!(ia.is_some(), "summary missing a: {s}");
        assert!(ib.is_some(), "summary missing b: {s}");
        assert!(ia.unwrap() < ib.unwrap(), "a(5) should sort before b(2): {s}");
        assert!(total() >= 7);
    }
}
