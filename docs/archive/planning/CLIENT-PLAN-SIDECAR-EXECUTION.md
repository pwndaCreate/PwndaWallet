# CLIENT PLAN - BasicSwap Sidecar Execution

Status: DRAFT 2026-08-15, operator-directed, execution-ready. Read
`CLIENT-SIDECAR-INDEX.md` first for the doc map.

## The flow: BasicSwap -> Pwnda Wallet (one direction)

```
   UPSTREAM BASICSWAP  ──consume──▶  PWNDA HARNESS  ──▶  PWNDA WALLET  ──▶  USER
   (pinned release,                  (our additions,      (runtime,
    untouched)                        additive only)       UI, fees)

   additions that attach to OUR side, never upstream's:
     - new coins (ZEPH / AVAX / ADA, high-numbered ids)
     - the fee model
     - the native Windows runtime
     - the non-technical UI/UX
```

**We CONSUME upstream; we do not owe upstream anything.** Contributing anything back (e.g. a
Windows-native fix) is an OPTION the operator may exercise later, never an assumption in this
plan. The tradeoff, stated once so it can be decided rather than drifted into: keeping the
Windows runtime private preserves differentiation but means carrying it forever; upstreaming it
shrinks our maintenance surface but gives away the gap we filled. **Default for now: keep it
ours, and design so that upstreaming later remains POSSIBLE (see "keep the seam clean").**

## Governing principle: wrap, do not rebuild

Pwnda does not build a swap engine. It wraps BasicSwap and adds four things, all on OUR side of
the seam:

| our addition | where it lives | touches upstream? |
|---|---|---|
| Native Windows runtime | packaging + `swap_sidecar.rs` | NO - wraps the process |
| UI / UX | `src/features/swap-sidecar/**` | NO - HTTP client only |
| Fee model | `src/features/sidecar-fees/**` | NO - separate payments |
| New coins | harness fork, ADDITIVE files | yes, minimally |

**Target: zero patched lines in `basicswap/` for the MVP.** Score every decision against "does
this add a line to the patch series?"

### Keep the seam clean

So that upstream merges stay cheap AND upstreaming later stays possible:

- Never edit an upstream file where adding a file would do.
- Keep coin additions as new modules + registry entries, not edits to shared logic.
- If a Windows fix inside `basicswap/` becomes unavoidable, keep it as a SINGLE isolated patch
  with a comment explaining it, so it can be extracted into a PR later if the operator chooses.
- Our runtime wrapper must not assume anything private about `basicswap` internals - it drives
  the process and the documented JSON API only.

## Phase 0 - decisions and the one gating spike

- [ ] **THE GATING SPIKE: native Windows runtime.** Upstream's only documented Windows path is
      WSL2 + Docker (`doc/install.md`) - too heavy for us. Target instead: **embedded CPython +
      the unmodified `basicswap` package + native coin daemons (`particld.exe`, `litecoind.exe`)
      fetched on demand.** The mining side already ships fetched binaries, so the pattern exists.
      - Question to answer: does unmodified `basicswap` run under embedded CPython on native
        Windows with native daemons?
      - Watch for: `pyzmq` (ZMQ from the coin daemons), the BasicSwap **fork of `coincurve`**
        (adaptor signatures - a naive PyPI coincurve BREAKS swaps), `python-gnupg` (release
        verification), path/locking assumptions, and daemon supervision differences.
      - Output: a written spike note - runs / runs-with-N-patches / does-not-run. **Everything
        below depends on this.**
- [ ] **Pin an upstream release tag.** Record it; all weight and coverage numbers derive from it.
- [ ] **Coin-id band.** Renumber fork ids HIGH (operator-approved) - do NOT keep the REU26 fork's
      ZEPH=19/AVAX=20/POL=21 (sequential after upstream DOGE=18 = collision-prone). Pick e.g.
      900+ and record it in the harness README. Rationale: ids are bare ints with no namespace;
      a collision makes our offers cross-parse as another coin on upgraded nodes.
- [ ] **MVP coin set (least weight).** `particl` (MANDATORY - it is the SMSG transport, not
      optional) + `LTC` in **electrum light mode** (no full chain) + `XMR` via
      `monero-wallet-rpc` against a **REMOTE node** (no local monerod). This is the minimum that
      swaps XMR<>LTC. Everything else is a later phase.
- [ ] **Weight budget.** Record the measured install size from the spike. Reference points from
      the estate's install: particld ~2.3 GB; LTC electrum mode avoids a multi-GB chain; a remote
      XMR node avoids ~190 GB.

## Phase 1 - sidecar runs headless (no UI)

Mirror the patterns that already ship. Do not invent new ones.

### 1.1 Opt-in gate
- [ ] `swapSidecarOptedInAt` - plaintext key in `wallet.dat`, copied from
      `src/features/mining/miningOptIn.ts` (same rationale: non-secret UX flag, must be readable
      before vault unlock).
- [ ] Fresh install contract: **nothing downloads, runs, or `invoke`s** until opt-in. The app
      layer gates it exactly as `App.tsx` gates mining.
- [ ] Desktop-only; excluded from Lite by construction.

### 1.2 Wizard
- [ ] One screen modelled on `MiningSetupWizard`: state the download size and that it is
      optional, then fetch -> verify -> configure -> first-run.
- [ ] **Reuse `src-tauri/src/wallet_rpc_common.rs`'s download+sha256 verify path** - it already
      does hash-checked fetches with a manifest (`sha256` field, mismatch aborts).
- [ ] Windows specifics to test: SmartScreen on the fetched daemons, Defender exclusion need,
      whether any step requires elevation (mining needed it; this may not).

### 1.3 `src-tauri/src/swap_sidecar.rs`
- [ ] Spawn / monitor / stop `basicswap-run`, shaped like the XMR/ZPH wallet-rpc sidecar
      managers. Owns: process lifecycle, loopback ports, API credential.
- [ ] **Shutdown ordering (documented upstream quirk, do not get this wrong):** SIGTERM
      `basicswap-run`; if it hangs on a Monero wallet-RPC timeout, terminate the CHAIN DAEMONS
      DIRECTLY and let LevelDB flush (~3 min); kill the parent LAST. **Never kill chain daemons
      first** - chainstate corruption.
- [ ] **Startup quirk:** after long downtime the XMR wallet's `open_wallet` can exceed
      BasicSwap's hard-coded 120s RPC timeout and abort the whole node. Pre-warm the XMR wallet
      standalone before launching.
- [ ] Treat the API credential like key material; never expose the sensitive endpoints
      (`/json/getcoinseed`, `setpassword`, `unlock`, `lock`) to UI code paths.

### 1.4 Config generation
- [ ] Generate `basicswap.json` from our template (so nothing upstream is patched): LTC electrum
      mode, XMR remote node sourced from the wallet's existing node list, Tor per user setting,
      loopback UI/WS ports, coin set.
- [ ] Ports: UI `12700`, WS `11700` by default, `+offset` if occupied. Bind loopback only.

### 1.5 Phase-1 exit test
- [ ] An **XMR<>LTC swap settles end to end against a MAINSTREAM counterparty**, driven only
      through the local JSON API, on a native Windows install. This proves runtime + interop
      before any UI exists.

## Phase 2 - the UI/UX gap (our second contribution)

**The problem.** BasicSwap's own web UI on `127.0.0.1:12700` is an expert tool: raw offers, the
`rate`/`bid_reversed` representation gotcha, manual bid construction, and no protection from the
extreme offers the book carries. Non-technical users cannot safely use it.

### Tier 0 (ship immediately) - advanced escape hatch
- [ ] One button: "Open advanced BasicSwap console" -> `127.0.0.1:12700` (webview or system
      browser), clearly labelled advanced/unsupported. Zero UI work, unblocks power users on day
      one, honest fallback while Tier 1 is built.

### Tier 1 - the familiar swap widget
Users already understand the industry-standard layout. Build that; hide the bookkeeping.

**UI shape**: from-asset, to-asset, amount, quote, one confirm button. Beneath it, automatically:

| user action | what the UI does against the API |
|---|---|
| picks a pair | `POST /json/offers` `{limit, with_extra_info:true}`, filter to pair |
| sees a quote | rank offers by EFFECTIVE rate (handle the rate representation; mirror amounts client-side before display) |
| confirms | `POST /json/bids/new`, then track |
| watches progress | WS on `:11700` (this node's events) or poll `/json/bids/<id>` |
| cancels | abandon via the bid endpoint |

- [ ] **Amount validation before submit** - mirror the server's rules for instant feedback:
      `min_bid_amount <= bid <= amount_from`; exact fill unless `amount_negotiable`; rate
      tolerance 0.01%; partial fills snap DOWN (never display an unsnapped partial).
- [ ] **Protocol minimum check** - both legs must exceed 0.001 of their own coin; the binding leg
      is the more valuable coin. Show the real floor for the chosen pair.

### Tier 1 safety core - spread exposure and extreme-offer gating
The measured book runs +0.2% to +14% over CoinGecko mid, with stale-bait offers beyond that.
This is the anti-trap layer and it is not optional:

- [ ] **Compute implied rate vs the wallet's own price feed** (the same feed the portfolio uses).
- [ ] **Display the spread as a plain sentence** before commit: "This swap is 3.2% worse than
      market." Never bury it, never show only the raw rate.
- [ ] **Three bands, configurable:**
      - green: within ~1% - proceed normally
      - amber: ~1-5% - proceed, spread shown prominently
      - **red: >~5% - BLOCK**, require an explicit typed override (not a checkbox)
- [ ] Frame it mechanically, not as advice: a band against a disclosed reference price.
- [ ] Feed unavailable -> treat as red (cannot verify), never silently green.

### Tier 1 - swap state in plain language
Map `BidStates` to human stages. Suggested mapping:

| stage shown | BidStates |
|---|---|
| Requesting | BID_REQUEST_SENT, BID_SENT, BID_RECEIVING, BID_RECEIVED |
| Accepted | BID_ACCEPTED, BID_REQUEST_ACCEPTED, XMR_SWAP_MSG_SCRIPT_LOCK_TX_SIGS, XMR_SWAP_MSG_SCRIPT_LOCK_SPEND_TX, BID_AACCEPT_DELAY |
| Locking your funds | SWAP_INITIATED, XMR_SWAP_SCRIPT_COIN_LOCKED |
| Waiting for counterparty | SWAP_PARTICIPATING, XMR_SWAP_NOSCRIPT_COIN_LOCKED, XMR_SWAP_HAVE_SCRIPT_COIN_SPEND_TX |
| Finalising | XMR_SWAP_LOCK_RELEASED, XMR_SWAP_SCRIPT_TX_REDEEMED, XMR_SWAP_NOSCRIPT_TX_REDEEMED |
| **Done** | SWAP_COMPLETED |
| **Refunded (normal outcome)** | XMR_SWAP_FAILED_REFUNDED, XMR_SWAP_NOSCRIPT_TX_RECOVERED, XMR_SWAP_SCRIPT_TX_PREREFUND |
| Counterparty recovered | XMR_SWAP_FAILED_SWIPED |
| Cancelled / expired | BID_ABANDONED, BID_EXPIRED, BID_REJECTED, SWAP_TIMEDOUT |
| Needs attention | XMR_SWAP_FAILED, BID_ERROR, BID_AACCEPT_FAIL, BID_STATE_UNKNOWN |
| (internal - do not surface) | BID_STALLED_FOR_TEST, CONNECT_REQ_SENT, SWAP_DELAYING, BID_RECEIVING_ACC |

- [ ] **Refunds are NORMAL, not errors.** Timelocks mean an abandoned swap returns funds. Say so
      up front, and again if it happens.
- [ ] Set expectations at confirm time: 30-90 minutes, and the app can be closed (the sidecar
      keeps running / resumes).

### Tier 1 - cost transparency and routing
- [ ] Show, as separate lines: the spread vs market, the chain costs, and the pwnda fee (see
      `CLIENT-PLAN-SIDECAR-FEES.md`). Ours is usually the smallest number - show the whole
      picture.
- [ ] Add `'basicswap'` to the swap tab router (`auto|swapkit|intents|pwnda-desk` today).
      **XMR and ZEPH must resolve to the sidecar** - Intents carries neither.

### Tier 1 - the honest no-taker-feed constraint
There is NO endpoint exposing other users' bids or swaps (bids are point-to-point encrypted).
The UI can show the resting offer book and the user's own activity - **never** fill rates,
"others are viewing", or implied demand. Do not design UI that implies otherwise.

## Phase 3 - coins (after Phase 2 ships)

Additive files, high-numbered ids, one at a time with its own test drive:
- **AVAX** - port the REU26 EVM interface (`interface/evm.py`, `protocols/xmr_swap_evm.py`).
- **ZEPH** - the ~105-line `ZEPHInterface(XMRInterface)` subclass largely exists; the real
  blocker is Zephyr-side (mainnet fork height), not BasicSwap-side.
- **ADA** - genuinely new as a BasicSwap interface (the desk engine is standalone).

## Upstream sync runbook (every release)

1. Rebase our patch series onto the new tag. **The diff should be coin files + nothing else.**
2. Diff the JSON API surface our Rust client uses - the API is our real contract and a changed
   field is our main break risk.
3. Hand-verify SMSG wire compatibility (there is NO version negotiation): the message schemas
   in `basicswap/messages_npb.py` (proto3 wire format, hand-coded - CORRECTED 2026-08-15 from
   "protobuf schemas": upstream dropped the protobuf package; the wire shape is unchanged but
   the file to diff is messages_npb.py), `MINPROTO_*` floors, and the coin-id enum vs our
   high ids.
4. Run the swap tests, then a live regtest settle.
5. Ship a new pinned artifact; the wallet moves the pin. Never auto-track upstream.
6. Log what changed, so the maintenance cost is visible over time.

## Risk register

| risk | mitigation |
|---|---|
| Native Windows runtime infeasible | Phase 0 spike answers before anything is built; fallback is a bundled container (heavy, last resort) |
| Upstream refactors the JSON API | API diff is step 2 of every sync; our client is thin and centralised |
| Coin-id collision upstream | High-numbered band + enum diff each release |
| coincurve fork replaced by PyPI build | Pin explicitly; assert at startup that adaptor ops work |
| User trapped by an extreme offer | Tier 1 red-band block with typed override |
| Sidecar weight deters install | Opt-in, sized up front, electrum + remote node |
| Wallet-drainer forks | Signed releases; see `CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` |

## Open items for the operator

1. Native-runtime spike result (gates everything).
2. High coin-id band value.
3. Extreme-spread threshold default.
4. Fee rate + whether to enable collection (counsel-gated).
5. Whether to ever upstream the Windows runtime (default: no, keep the seam clean anyway).
