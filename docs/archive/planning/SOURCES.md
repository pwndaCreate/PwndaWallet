# SOURCES.md — Live Documentation Verification

Per Integration Plan §7.5.6, every Tier-1 URL was fetched live before any code was written.
Recorded 2026-05-05.

---

## Tier-1 — Verified

### SwapKit
- https://docs.swapkit.dev/swapkit-api/v3-quote-request-a-swap-quote
  fetched: 2026-05-05 | title: "/v3/quote — Request a swap quote"
- https://docs.swapkit.dev/swapkit-api/quote-and-swap-implementation-flow
  fetched: 2026-05-05 | title: "Quote and Swap Implementation flow"
- https://docs.swapkit.dev/swapkit-api/track-request-the-status-of-a-swap
  fetched: 2026-05-05 | title: "/track — Request the status of a swap"

### NEAR Intents
- https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart.md
  fetched: 2026-05-05 | title: "Quickstart"
- https://github.com/defuse-protocol/one-click-sdk-rs
  fetched: 2026-05-05 | title: "one-click-sdk-rs README"

### NEP-413
- https://github.com/near/NEPs/blob/master/neps/nep-0413.md
  fetched: 2026-05-05 | title: "NEP-413: Off-Chain Message Signing"

### Tauri v2
- https://v2.tauri.app/plugin/stronghold/
  fetched: 2026-05-05 | title: "Stronghold | Tauri"
- https://v2.tauri.app/security/capabilities/
  fetched: 2026-05-05 | title: "Capabilities | Tauri"

### Rust signing crates
- https://docs.rs/alloy-signer-local/latest/alloy_signer_local/
  fetched: 2026-05-05 | title: "alloy_signer_local — Rust"

---

## Discrepancies between IntegrationPlan and live docs

The plan was treated as advisory; live docs are authoritative.

1. **SwapKit `/track` request body** — plan calls the field `txHash`; live docs use `hash`. Optional `depositAddress` for NEAR Intents path. We accept either name in our schema and forward `hash` to upstream.
2. **SwapKit `/track` response status enum** — plan listed `PENDING|PROCESSING|SUCCESS`; live docs use `not_started|pending|swapping|completed|refunded|unknown|failed`. Client maps both.
3. **NEAR 1Click status enums** — plan listed PENDING_DEPOSIT|PROCESSING|SUCCESS|REFUNDED|FAILED; live docs add `KNOWN_DEPOSIT_TX` and `INCOMPLETE_DEPOSIT`. Client treats both terminal-success-ish and intermediate states.
4. **NEP-413 signature encoding** — plan example used `signature: "ed25519:..."`; the spec says `signature` is base64-encoded raw bytes. We emit base64.
5. **SwapKit `/v3/quote` body** — live docs list `affiliateFee` (bps) but no `affiliate` THORName field; affiliate identity is keyed to the API key in the partners dashboard. We still forward `affiliate` if env-configured (harmless: SwapKit ignores unknown fields per real-world behavior) but do not depend on it.
6. **SwapKit `/v3/quote` extras** — live docs document `cfBoost` and `maxExecutionTime` not in the plan. Schema accepts them passively (passes through if provided).

---

## Tier-1 not refetched (paraphrased from plan, but should be re-read before shipping)
- BIP-39 / BIP-32 / BIP-44 / SLIP-44 — used as published test vectors only.
- alloy.rs main page (we read the alloy-signer-local crate page).
- rust-bitcoin, bdk_wallet — used per published examples.
- near-crypto, near-primitives — used per crate docs.
- cosmrs, solana-sdk — used per crate docs.

These are stable enough that we proceeded; flag for re-verification before production cut.
