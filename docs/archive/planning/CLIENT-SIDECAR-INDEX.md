# CLIENT - BasicSwap Sidecar: document map and reading order

Everything client-side development needs for the BasicSwap sidecar, all inside this repo (it
crosses to the Windows build machine without the estate vault). Compiled 2026-08-15.

## The direction, in four lines

1. The shipped wallet has **two swap routes**: NEAR Intents (live) and the **BasicSwap opt-in
   sidecar** (to build). The custom I2P desk finishes its test campaign and is then retired -
   it does not ship.
2. **The sidecar is the ONLY route for XMR and ZEPH** (verified: NEAR Intents carries neither).
   It is the privacy-asset rail, not a niche addition.
3. **Flow is one-directional: BasicSwap -> Pwnda Wallet.** We consume a pinned upstream release
   and attach our own additions (new coins, fee model, Windows runtime, UI). Contributing
   anything upstream is an option, never an assumption.
4. **Two things upstream has not built are ours to build**: a native lightweight Windows runtime
   (their only path is WSL2+Docker) and a non-technical UI/UX.

## Fee system — current state (2026-09-01)

**Built, reviewed, ships DISABLED.** `src-tauri/src/sidecar_fees/` (~1.8k lines Rust). The
counsel gate is the only thing between here and collection.

```
0.5% of the SCRIPTED leg, charged once per SUCCESSFUL swap, paid as a separate ordinary
payment from the user's own sidecar wallet. Only on swaps with an XMR leg. Never gates a swap.
```

| | |
|---|---|
| Parameters | `RATE_BPS 50`, `K 2`, `MAX_EFFECTIVE_RATE 50%` (dormant), structure B + guard |
| Fee coins | **LTC, BCH, BTC** (DASH/DOGE out; BTC in) |
| Scriptless leg | **XMR only** — ZEPH planned, absent since 2026-08-22 |
| Kill switch | `SHIPPED_MODE` compiled in; **a release build has no runtime fee switch** |
| Chargeable state | `SWAP_COMPLETED` (8) and nothing else |
| Default route | **LTC** — BCH is not the default despite cheaper chain fees (no light-wallet mode, thin book); BTC cannot serve payout-sized cashouts (~$63 floor) |

**Owed before go-live:** wire `reserve_for_sale()` into MAX (sell direction only — plan in
`PwndaWalletVault/wiki/synthesis/fee-reserve-and-swap-minimums.md`), run the Rust suite on the
build machine, clear the counsel gate.

**Fee docs, in reading order:** `FEE.md` (the user-facing disclosure) ->
`HANDOFF-SIDECAR-FEES.md` (parameters + verified facts) -> `CLIENT-PLAN-SIDECAR-FEES.md` (the
full spec; **sections marked SUPERSEDED are kept for the reasoning trail only**) ->
`PwndaWalletVault/wiki/synthesis/fee-enforcement-and-fork-resistance.md` (why the code sits where
it does) -> `fee-reserve-and-swap-minimums.md` (what is still to build). Reviews:
`DESK-ANSWER-v105/106/107`.

## Read in this order

| # | document | what it answers |
|---|---|---|
| 1 | **this file** | the map |
| 1b | **`HANDOFF-SIDECAR-FEES.md`** | **the implementation handoff for the fee system** - decision path, where the code goes, verified facts you cannot check yourself, settled decisions, build order, tests, and the OPEN items to raise |
| 2 | `CLIENT-PLAN-SIDECAR-EXECUTION.md` | **the build walkthrough** - phases, the gating Windows spike, sidecar lifecycle, the UI/UX plan incl. spread gating and state mapping, sync runbook, risk register |
| 2b | `CLIENT-PLAN-SIDECAR-KICKOFF.md` | **the build order** - operationalized stages (spike protocol, Rust module scaffold, UI order), session sequencing, and the PIN record pointer (`upstream/README.md` - v0.17.9 + coincurve basicswap_v0.3 cloned locally 2026-08-15) |
| 2c | `PwndaWalletVault/wiki/synthesis/basicswap-sidecar-ultracode-plan.md` | **the agent-executable full plan (ultracode)** - phases P0-P6 with per-phase workflow fan-outs, exact test commands, falsifiable gates, the testing charter (what agents may run vs operator-armed), and the statically-found native-Windows defects at the pin (run.py SIGHUP blocker first) |
| 3 | `CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` | **why certain UI choices are not optional** - the posture, the hard rules, fee framing language, fork resistance |
| 4 | `CLIENT-PLAN-SIDECAR-FEES.md` | the fee spec - mechanism, per-chain floors, reserve, tests |
| 5 | `PwndaWalletVault/wiki/synthesis/basicswap-integration-mechanics.md` | **build-facing mechanics** - JSON API surface, offer/bid lifecycle, BidStates, auto-accept, ops gotchas, packaging deps |
| 6 | `PwndaWalletVault/wiki/synthesis/basicswap-backend-reference.md` | background - SMSG transport, protocol strictness, adding a coin, fork interop, amount floors |
| 7 | `CLIENT-PLAN-BASICSWAP-SIDECAR.md` | the older strategy plan (phases, coin ladder). Superseded on execution detail by #2 |

## Facts that bite, collected

Pulled from the docs above so they are not discovered the hard way:

- **`particld` is mandatory.** It is the SMSG transport, not an optional coin. No particld, no
  order book.
- **The `coincurve` fork is load-bearing.** BasicSwap pins its OWN fork for adaptor signatures; a
  naive `pip install coincurve` produces a build whose swaps break.
- **Shutdown order matters.** SIGTERM `basicswap-run`; if it hangs on a Monero RPC timeout,
  terminate chain daemons DIRECTLY and let LevelDB flush; kill the parent last. Never kill chain
  daemons first.
- **Startup after long downtime** can exceed BasicSwap's hard-coded 120s RPC timeout on
  `open_wallet` and abort the node - pre-warm the XMR wallet.
- **SMSG has no version negotiation.** Every upstream merge needs hand-verified wire
  compatibility. Wire messages are proto3 WIRE FORMAT but HAND-CODED in
  `basicswap/messages_npb.py` (the python protobuf package is gone upstream) - that file's
  schemas are what the sync runbook diffs (verified at pin v0.17.9, 2026-08-15).
- **Coin ids are bare ints with no namespace** - use a high band; a collision makes our offers
  cross-parse as another coin.
- **Protocol minimum is 0.001 of EVERY coin**, both legs; the binding leg is the more valuable
  coin (XMR<>LTC ~$0.39; XMR<>BTC ~$63).
- **There is no taker feed.** No endpoint exposes other users' bids or swaps. Never design UI
  implying otherwise.
- **The book carries trap offers** (+0.2% to +14% over mid, plus stale bait). The spread gate is
  a safety feature, not a nicety.
- **XMR/ZEPH spendable age is 10 blocks** - any payment path from them must trigger on UNLOCKED
  balance and retry, never total.
- **Zephyr's `get_balance` nests under `balances[]`** with no top-level fields - a Monero-shaped
  read silently returns zero on a funded wallet.

## Status and open items

No wallet code yet. The upstream reference IS pinned locally as of 2026-08-15 (basicswap
v0.17.9 + coincurve basicswap_v0.3 under `upstream/`, read-only, gitignored; pin table and
verified-at-pin facts in `upstream/README.md`; a same-day upstream re-verification is filed at
`PwndaWalletVault/wiki/queries/2026-08-15-basicswap-windows-feasibility-upstream-check.md` -
NOTE the Python floor is now >= 3.11). Build order lives in `CLIENT-PLAN-SIDECAR-KICKOFF.md`.
Blocking decisions, in order:

1. **The native Windows runtime spike** (gates everything else; concrete protocol now in the
   kickoff doc, Stage A).
2. The high coin-id band value.
3. The extreme-spread gate default.
4. The fee rate, and the counsel gate before collection is enabled.
5. Whether to ever upstream the Windows runtime (default: no).
