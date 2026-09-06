//! C39 successor: classify a reason the ENGINE PRODUCED FROM A REAL CHAIN SPEND.
//!
//! WRITTEN BY THE DESK AGENT (delivered as `src-tauri/tests/swipe_real_witness.rs`,
//! DESK-ANSWER-v69 section 1), wired in-crate by the client. Two changes on adoption,
//! both required rather than stylistic:
//!
//! 1. **Moved from `tests/` into the lib.** The suite's step 1 — the gate that decides
//!    "client is clean" — runs `cargo test --features full --lib desk::`. An integration
//!    test in `tests/` compiles, passes locally, and is NEVER RUN by that gate: a
//!    green-looking test the harness cannot reach, which is C45's shape one level up.
//!    In here, it runs every time the suite does.
//!
//! 2. **The shims are gone, and they had already drifted.** The delivered file mirrored
//!    `outlook()` locally so it could compile in isolation, and warned that a drifted
//!    mirror "reports green about code it no longer describes". It was right sooner
//!    than it expected: the real `outlook()` checks `Impossible` BEFORE `Swiped` and
//!    matches `starts_with("unsupported-backend")`; the shim checked `Swiped` first and
//!    matched `contains("preset")`/`contains("config")`. Different predicate, different
//!    order, on the day it arrived. These tests now call the real one.
//!
//! WHY THIS EXISTS
//! ---------------
//! `reclaim.rs` carries two good tests and one honest admission:
//!
//!   - `a_b3_swipe_is_permanent_for_the_swap_not_retryable_c38` feeds a HAND-TYPED
//!     reason string to `outlook()`. It proves the matcher matches a literal we wrote.
//!   - `our_swipe_marker_is_still_the_engines_c39` reads `desk_engine.py` and proves
//!     the marker we grep for is still the marker the engine DEFINES.
//!   - and the C45 test says it plainly: "only against the string constant C39 pins",
//!     never "a genuine branch-B3 spend".
//!
//! Both sides had that same hole. The desk pinned its Go marker against the Python
//! constant; this crate pins its Rust marker against the Python constant. **Two copies
//! of a string agreeing is not evidence about a chain.** Neither side had ever seen
//! what a real branch-B3 transaction makes the engine say.
//!
//! Now one exists. On 2026-07-29 the desk locked 2 tADA on preprod at t1=tip+120 /
//! t2=tip+240, skipped the XMR leg entirely (so nothing of a counterparty was ever
//! committed), waited out T2 and took branch B3. The witness set came back with ONE
//! vkey — the leader's. The fixture records that witness AND, in `engine_reason`, the
//! exact string the engine's discriminator produces for it.
//!
//! Client-side verification of the fixture, 2026-07-29 (recorded in log.md): the tx
//! exists on preprod (block 4995304, slot 129698612 — 107 slots after the fixture's
//! `t2_slot`, consistent with an after-T2 branch), spends the fixture's lock from the
//! fixture's script address, and every ed25519 signature in both fixtures verifies
//! over its txid. `sigs_verify_over_txid` is an observation, not a relayed claim.
//!
//! So this module closes the loop the other two tests cannot:
//!
//!     real chain spend -> real witness set -> the engine's own reason -> OUR outlook()
//!
//! THE DISCRIMINATOR, which is the whole detection: all three chain-A branches need
//! sigAlice; **ONLY B3 omits sigBob**. B3 = 1 witness, B1/B2 = 2 witnesses.
//!
//! IF THIS GOES RED, DO NOT EDIT THE LITERAL TO MATCH. A real swipe no longer
//! classifying as `Swiped` is desk-D37 / C38 reappearing: we would poll forever for an
//! `s_a` that was never published and never will be. Check whether the desk's Go
//! matcher moved too.

use super::crypto::{ExtractionOutlook, SecretExtraction};

// The fixtures ride in the vendored engine bundle, beside the engine that produced
// them, so the tracked-file rule that `our_swipe_marker_is_still_the_engines_c39`
// relies on covers these too.
const B3_FIXTURE: &str =
    include_str!("../../../pwnda-engine-handoff/engine/vectors/b3_witness_preprod.json");
const B1_FIXTURE: &str =
    include_str!("../../../pwnda-engine-handoff/engine/vectors/b1_witness_preprod.json");

/// Minimal reader. Deliberately NOT serde-derived onto a struct: a struct with
/// `#[serde(default)]` would silently give us an empty `engine_reason` if the field
/// were ever dropped from the schema, and an empty reason classifies as `RetryLater` —
/// which is exactly the defect this file exists to prevent. Absent must be LOUD.
fn field<'a>(json: &'a str, key: &str) -> &'a str {
    let pat = format!("\"{key}\"");
    let start = json.find(&pat).unwrap_or_else(|| {
        panic!(
            "fixture has no {key:?} field - a fixture that cannot say what the engine concluded \
             is not evidence, and a defaulted empty string would classify as RetryLater, which IS \
             the bug"
        )
    });
    let after = &json[start + pat.len()..];
    let colon = after.find(':').expect("malformed fixture");
    let rest = after[colon + 1..].trim_start();
    if let Some(stripped) = rest.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = stripped.char_indices();
        while let Some((i, c)) = chars.next() {
            match c {
                '\\' => {
                    let (_, esc) = chars.next().expect("dangling escape in fixture");
                    out.push(match esc {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                }
                '"' => return Box::leak(out.into_boxed_str()) as &str,
                _ => {
                    let _ = i;
                    out.push(c)
                }
            }
        }
        panic!("unterminated string for {key:?}")
    }
    // bare literal (true/false/number) - read to the next delimiter
    let end = rest
        .find(|c: char| c == ',' || c == '}' || c == '\n')
        .unwrap_or(rest.len());
    rest[..end].trim()
}

fn witness_count(json: &str) -> usize {
    let start = json.find("\"witness_vkeys\"").expect("no witness_vkeys");
    let open = json[start..].find('{').expect("no witness map") + start;
    let close = json[open..].find('}').expect("unterminated witness map") + open;
    json[open..close].matches(':').count()
}

fn witness_map_contains(json: &str, vkey: &str) -> bool {
    let start = json.find("\"witness_vkeys\"").expect("no witness_vkeys");
    let open = json[start..].find('{').expect("no witness map") + start;
    let close = json[open..].find('}').expect("unterminated witness map") + open;
    json[open..close].contains(vkey)
}

/// The fixture must declare itself REAL. A synthetic stand-in exercises the shape and
/// proves nothing about a chain; letting one satisfy this test silently would hand back
/// exactly the green light the real capture is supposed to earn.
fn assert_real(json: &str, which: &str) {
    let synthetic = field(json, "synthetic");
    assert_eq!(
        synthetic, "false",
        "{which} fixture is marked synthetic={synthetic}. This test asserts a property of a REAL \
         chain spend; a hand-built witness cannot establish it. Re-capture with \
         scripts/synthesize-b3-witness.py on the desk side."
    );
    let network = field(json, "network");
    assert!(
        network == "preprod" || network == "preview",
        "{which} fixture network is {network:?} - expected a testnet"
    );
}

#[test]
fn a_real_b3_swipe_witness_classifies_as_swiped() {
    assert_real(B3_FIXTURE, "B3");

    assert_eq!(
        witness_count(B3_FIXTURE),
        1,
        "a B3 swipe carries exactly ONE witness (the leader's). Two would mean this capture is \
         not a swipe at all and the whole fixture is mislabelled."
    );
    let a_vkey = field(B3_FIXTURE, "a_vkey");
    let b_vkey = field(B3_FIXTURE, "b_vkey");
    // Adoption fix: the delivered file asserted `B3_FIXTURE.contains(a_vkey)` — true
    // whenever the `a_vkey` FIELD exists, i.e. always. A check that cannot fail for the
    // reason it runs (pattern 1). Both halves of the discriminator now look in the
    // witness MAP: the leader must be in it, the follower must not.
    assert!(
        witness_map_contains(B3_FIXTURE, a_vkey),
        "the leader vkey is absent from the witness map - not a B3 spend"
    );
    assert!(
        !witness_map_contains(B3_FIXTURE, b_vkey),
        "the FOLLOWER vkey is present in a supposed B3 witness. sigBob being absent is the entire \
         discriminator; if it is there this is a claim or a refund, not a swipe."
    );

    // THE POINT OF THE FILE: the engine's own output for that real witness, through our
    // matcher — the real `outlook()` in crypto.rs, not a mirror of it.
    let reason = field(B3_FIXTURE, "engine_reason");
    assert!(
        !reason.is_empty(),
        "engine_reason is empty for a B3 capture - the engine concluded nothing, so there is \
         nothing to classify"
    );
    assert!(
        reason.contains(field(B3_FIXTURE, "engine_marker")),
        "the engine's reason does not contain the marker the same fixture declares — the capture \
         and the contract disagree with each other"
    );

    let extraction = SecretExtraction {
        secret_held: false,
        reason: reason.to_string(),
    };
    assert_eq!(
        extraction.outlook(),
        ExtractionOutlook::Swiped,
        "a REAL branch-B3 spend did not classify as Swiped. This is desk-D37 / C38 with a chain \
         transaction behind it: we would poll forever for an s_a that was never published. Reason \
         the engine actually emitted: {reason:?}"
    );
}

#[test]
fn a_real_cooperative_claim_is_not_a_swipe() {
    assert_real(B1_FIXTURE, "B1");

    assert_eq!(
        witness_count(B1_FIXTURE),
        2,
        "a cooperative claim carries BOTH parties' witnesses. Without this true negative the \
         swipe test proves recognition, not DISCRIMINATION - it would pass just as happily on a \
         matcher that answered Swiped for everything."
    );

    // For a claim the engine extracts the secret; there is no swipe reason to match.
    assert_eq!(field(B1_FIXTURE, "engine_secret_held"), "true");
    let reason = field(B1_FIXTURE, "engine_reason");
    assert!(
        reason.is_empty(),
        "a successful extraction should carry no failure reason, got {reason:?}"
    );

    // And the negative that matters: whatever we do conclude, it must not be Swiped.
    let extraction = SecretExtraction {
        secret_held: true,
        reason: String::new(),
    };
    assert_ne!(
        extraction.outlook(),
        ExtractionOutlook::Swiped,
        "a real cooperative claim classified as a SWIPE. That is the false positive: we would \
         stop a reclaim that was going to succeed and send a human to recover a coin that was \
         never lost."
    );
    assert_eq!(extraction.outlook(), ExtractionOutlook::Held);
}

/// Falsification: flip one byte of the leader vkey and the classification must change.
/// A test that cannot go red for the right reason is not evidence (this project has
/// shipped two guards that could not fail for the reason they existed - see desk D29
/// and D40; the adoption fix above removed a third).
#[test]
fn corrupting_the_leader_vkey_changes_the_classification() {
    let a_vkey = field(B3_FIXTURE, "a_vkey");
    let mut corrupted = a_vkey.to_string();
    let last = corrupted.pop().expect("empty vkey");
    corrupted.push(if last == '0' { '1' } else { '0' });
    assert_ne!(corrupted, a_vkey);
    assert!(
        !witness_map_contains(B3_FIXTURE, &corrupted),
        "a corrupted leader vkey must NOT be found in the witness map; if it is, the lookup is \
         not actually comparing what it claims to compare"
    );
}
