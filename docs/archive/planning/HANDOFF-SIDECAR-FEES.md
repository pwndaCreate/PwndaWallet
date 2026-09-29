# HANDOFF - Implement the sidecar fee system (atomic-swap DEX route)

To: the client-side agent. From: the desk agent. Date 2026-08-19.

You have ONLY this repo. The desk agent holds the BasicSwap source, REU26, and the estate vault -
so **every fact you need has been inlined below or into the referenced in-repo docs.** Where a
number or behaviour is cited to a BasicSwap file you cannot open, treat it as verified ground
truth and build to it; if something contradicts it in practice, RAISE it rather than
re-deriving.

---

## 0) READ FIRST, in this order

| # | doc | why |
|---|---|---|
| 1 | `CLIENT-SIDECAR-INDEX.md` | the map + "facts that bite" |
| 2 | `CLIENT-PLAN-SIDECAR-FEES.md` | **the spec you are implementing** |
| 3 | `PwndaWalletVault/wiki/synthesis/fee-enforcement-and-fork-resistance.md` | WHERE the code goes and why |
| 4 | `CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` | the UI rules that are NOT optional |
| 5 | `PwndaWalletVault/wiki/synthesis/basicswap-integration-mechanics.md` | the JSON API, BidStates, ops gotchas |
| 6 | `CLIENT-PLAN-SIDECAR-EXECUTION.md` | the surrounding sidecar build (fees are a component of it) |

**Do not start until the sidecar exists.** The fee system consumes settlement events from the
sidecar; Phase 1 of the execution plan (sidecar runs headless, an XMR<>LTC swap settles through
the JSON API) is a hard prerequisite.

---

## 1) WHAT YOU ARE BUILDING, in one paragraph

When a swap **on the BasicSwap sidecar route** settles successfully **and the pair has a
scriptless leg** - which today means **XMR only** (`SIDECAR_ONLY_TICKERS = ["XMR"]`; ZEPH was
removed from this surface 2026-08-22 and is PLANNED, not abandoned) - the wallet sends one
ordinary payment from the user's own sidecar
wallet to a pwnda fee address, denominated in the pair's **scripted** leg. It is charged per
swap, never accrued, never on failures, and it **never gates the swap**. Everything else -
mainstream Intents swaps, scripted<>scripted sidecar swaps, sends, holding - is free.

---

## 2) THE DECISION PATH (SETTLED 2026-08-26 - parameters below are final)

```
RATE              = 0.005      // 0.5%
K                 = 2          // floor = k x cost-of-billing
MAX_EFFECTIVE_RATE = 0.50      // the guard - never charge more than 50% of a trade

on settlement detected (terminal SUCCESS, sidecar route only):
    if pair has no scriptless leg          -> NO FEE      // XMR or ZEPH leg required
    feeCoin  = the pair's SCRIPTED leg
    notional = value of the scripted leg
    fee      = RATE * notional

    if fee < flatFee[feeCoin]:                            // below the switchover
        if flatFee[feeCoin] / notional > MAX_EFFECTIVE_RATE:
            -> NO FEE                                     // guard: structure A behaviour
        else:
            fee = flatFee[feeCoin]                        // structure B behaviour

    write pending record (swapId, fee, feeCoin)
    withdraw(feeCoin, fee, feeAddress) -> record txid -> clear record
    on failure: retry with backoff; NEVER touch swap state
```

`flatFee[coin] = max(chainMinOutput[coin], K * txCost[coin])` - identical to the collection
floor. The switchover trade size is `flatFee / RATE`; the guard fires below
`flatFee / MAX_EFFECTIVE_RATE` (= `2 * flatFee` at 50%). **Derive both; never hardcode them.**

### Why one guard replaces a per-coin A/B table

The operator's rule was "BCH and LTC use B, anything whose worst effective rate exceeds 50% uses
A". **The runtime guard produces exactly that outcome without a table**, and self-corrects per
PAIR and per TRADE, which a per-coin table cannot:

| coin | flat | guard fires below | switchover | where the guard actually fires |
|---|---|---|---|---|
| BCH | $0.0011 | $0.0022 | $0.22 | **never** - below the smallest legal BCH swap ($0.2054). Pure B |
| LTC | $0.0100 | $0.0200 | $2.00 | **never** - below the smallest legal LTC swap ($0.044). Pure B |
| AVAX | $0.0100 | $0.0200 | $2.00 | ZEPH pairs only, $0.0067-$0.02 (XMR pairs never - their min is $0.393) |
| DOGE | $0.0020 | $0.0040 | $0.40 | ZEPH pairs only, $0.0003-$0.004 |
| ADA | $0.1795 | $0.3590 | $35.90 | ZEPH pairs only, $0.0003-$0.359 |

BCH and LTC come out pure-B automatically because their guard zones sit BELOW the protocol
minimum for any pair they can be in. The abusive cases (AVAX 150%, DOGE 571%, ADA 51,286% at the
smallest legal ZEPH-pair swap) are exactly what the guard removes.

Worked example, ZEPH<>AVAX - the worst case before the guard:

| trade | fee | effective | note |
|---|---|---|---|
| $0.0067 (smallest legal) | $0 | 0% | guard - was 150% |
| $0.019 | $0 | 0% | guard |
| $0.020 | $0.0100 | 50.0% | guard boundary |
| $0.050 | $0.0100 | 20.0% | flat |
| $1.00 | $0.0100 | 1.0% | flat |
| $2.00 | $0.0100 | 0.5% | switchover - A and B meet |
| $10.00 | $0.0500 | 0.5% | percentage |

**Implementation note**: this is ONE branch, not a per-coin policy field. Do not build an A/B
table; build the guard. `MAX_EFFECTIVE_RATE` is a single named constant so the policy is legible
and testable.

**STATUS 2026-08-29: the guard is DORMANT-PENDING-ZEPH, not dead.** With XMR the only scriptless
leg, every live counterparty's guard zone (<= $0.02) sits far below every XMR pair's ~$0.39
protocol floor, so it cannot fire today. It becomes live the moment ZEPH lands - and ZEPH's
~$0.00035 floor is precisely what made unguarded flats reach 150% / 571% / 51,286%. Implement it,
label it dormant, and test it against a SYNTHETIC low-value pair so the branch is covered without
a test that passes vacuously against a real pair.

**BOTH ASSUMPTIONS ARE NOW TESTABLE OFFLINE - see `DESK-ANSWER-v106`.** They moved from P3 to a
new P0.5 regtest phase:

1. **Role coverage of `SWAP_COMPLETED` - ANSWERED, AND NOW EMPIRICALLY CONFIRMED ON THIS BOX.**
   `test_xmr.py::Test::test_01_part_xmr` was RUN 2026-08-29 and **PASSED in 3m54s** - so both
   roles reaching `SWAP_COMPLETED` is not just an assertion we read, it is behaviour observed
   here. Cycle time ~4 minutes makes this viable as a permanent regression guard.
   Original evidence:
   `tests/basicswap/test_xmr.py`'s happy path asserts `SWAP_COMPLETED` on BOTH
   `swap_clients[0]` (offerer) and `swap_clients[1]` (bidder, `sent=True`). Upstream requires the
   exact property the fee depends on, in its own CI. **Closed - no mainnet observation needed.**
   Known nuance: `test_03b_follower_recover_a_lock_tx_with_mercy` asserts a TUPLE
   `(XMR_SWAP_NOSCRIPT_TX_REDEEMED, SWAP_COMPLETED)`, so in the mercy-recovery scenario the bid
   may rest at the redeemed state and we will NOT charge. Under-collection on a recovery outcome
   is the correct direction to fail; record it as accepted, not as a bug to chase.
2. **Which leg is the notional - test it in the regtest harness.** Not covered upstream, but a
   completed regtest swap has known, deliberately-unequal leg amounts, so a swapped field cannot
   pass by coincidence. Assert per role x per direction.

**Running the harness needs three env vars and no build - VERIFIED WORKING 2026-08-29** (every
binary already on the estate box; `pytest` had to be pip-installed into
`/home/user/coinswaps/venv`, which was the only missing piece):

```
cd /home/user/coinswaps/basicswap && source /home/user/coinswaps/venv/bin/activate
export PYTHONPATH=$(pwd) \
       PARTICL_BINDIR=/home/user/coinswaps/bin/particl \
       XMR_BINDIR=/home/user/coinswaps/bin/monero \
       BITCOIN_BINDIR=/home/user/coinswaps/bin/bitcoin
pytest -x -q "tests/basicswap/test_xmr.py::Test::test_01_part_xmr"     # PASSED, 234s
```

**Isolation from the live desk campaign was verified before running and confirmed after:** no
port overlap (desk LTC regtest 19443 vs harness 35792; desk monerod regtest 29181 vs harness
29798/21792; desk runs no particl), the harness's teardown only terminates processes it spawned
itself (`cls.processes`, no `pkill`), and after the run both desk daemons were still up with
16- and 19-day uptimes and no stray test daemons remained. **Safe to run alongside the campaign.**

**P3 is therefore demoted from gate to confirmation**: it verifies that mainnet state sequences
match what regtest produced, rather than discovering unknowns with money at stake.

## 3) WHERE THE CODE GOES - this is not a style preference

**Decision and money in RUST. Display only in TS. Never in the Python sidecar.**

Verified build reality: the Rust core compiles into the app binary bundled as an MSI, and the
frontend is **embedded into that binary** at compile time (`tauri.conf.json`:
`frontendDist: ../dist`, `bundle.targets: ["msi"]`). The BasicSwap sidecar by contrast is
**interpreted Python in plain `.py` files** - a fee there is a text edit with no build step.

Repo precedent: the removed mining dev-fee was `src-tauri/src/dev_fee/` - 31 files, ~16.3k lines
of Rust - with only badges/consent/disclosure in TS.

**Critical subtlety**: a Rust `settle_fee()` *called by* TypeScript is defeated by patching the TS
call site. **The Rust settlement watcher must own the whole path** - detect settlement, compute,
withdraw, self-driving, never waiting to be asked by the frontend.

```
src-tauri/src/sidecar_fees/          RUST - decision + money
  schedule.rs   rate, per-chain floors + chainMinOutput, k, isFeeEligiblePair(),
                fee-address derivation. PURE, unit-tested.
  engine.rs     pure decision from a settled swap -> {charge|skip, amount, coin}
  settle.rs     the withdraw + retry/backoff + in-flight marker. ONLY module touching money.
  ledger.rs     per-swap pending records (NEVER a running balance) + payment history
  mod.rs        THE WATCHER, self-driving: settlement -> engine -> settle

src/features/sidecar-fees/           TS - display only
  useSidecarFees.ts    reads status/history/quote from Rust
  SidecarFeesCard.tsx  settings surface
```

Pre-trade fee display calls a Rust quote function. **The UI never computes or decides the fee.**

Natural cohesion is fine (the fee engine and the Tier-1 spread gate genuinely share the
notional-vs-market computation). **Do not manufacture coupling beyond that** - artificial
entanglement is a dark pattern and a competent forker defeats it anyway.

---

## 4) VERIFIED FACTS YOU CANNOT CHECK YOURSELF

**The collection API.** `POST /json/wallets/<coin>/withdraw` with `{value, address, subfee}`
returns a txid. It is **SINGLE-DESTINATION** and exposes **no input selection** - so you cannot
piggyback a fee onto another payment, and you cannot force a single-input spend.

**Why the fee is a separate payment and not an output inside the swap.** Every spend-side
verifier enforces `len(tx.vout) == 1` plus an exact destination match, and those transactions are
adaptor-signed over their exact bytes. A fee output in the receive direction is therefore
*impossible* against mainstream counterparties, not merely awkward.

**Why there is no "refund the fee if the swap fails" mechanism.** A fee output hashlocked to the
swap's own secret cannot be built: secret recovery needs the ADAPTOR signature, which is
exchanged privately between the two parties and never published on chain. "No fee on failures" is
achieved purely by *when* we collect - after success.

**Protocol minimums (the USER's floor, not ours).** `min_amount` is **0.001 of every coin**,
both legs must clear their own, so the binding leg is the more valuable coin:
ZEPH<>LTC ~$0.05, XMR<>LTC ~$0.39, XMR<>BTC ~$63. This is enforced by BasicSwap, not by us -
never present it as our limit.

**Spendable age (bites any XMR/ZEPH payment path).** CryptoNote locks outputs 10 blocks
(~20 min). Trigger on **UNLOCKED balance, never total**; schedule retries from `blocks_to_unlock`
returned by `get_balance` rather than blind backoff; class the failure TEMPORARY (upstream itself
raises `TemporaryError` for this); surface unlocked as balance and locked as pending in any UI.
No Bitcoin-family/Cardano/EVM equivalent.

**ZEPH silent-failure trap.** Zephyr's `get_balance` nests per-asset entries under `balances[]`
with **no top-level `balance`/`unlocked_balance`** - a Monero-shaped read **silently returns zero
on a funded wallet**. Two independent implementations hit this. For a fee engine the failure is
silent and total. **Required test.**

**Double-payment hazard (production precedent).** The pool's payment processor issues the
transfer FIRST and updates its ledger after; a crash between logs *"Super critical error!
Payments sent yet failing to update balance in redis, double payouts likely to happen"*. Our
ledger inherits it: **write an in-flight marker BEFORE the withdraw and reconcile against wallet
transfer history on startup.** Copy the pool's failure path - on RPC error it does NOT clear the
record, so the obligation survives to retry.

**Settlement detection - CORRECTED 2026-08-29 (this handoff was WRONG).** Terminal success is
**`SWAP_COMPLETED` AND NOTHING ELSE.** The earlier text here said "and the XMR-swap redeemed
states" - that is wrong and would have charged mid-flight and up to three times per swap.
Verified in upstream: `XMR_SWAP_SCRIPT_TX_REDEEMED` and `XMR_SWAP_NOSCRIPT_TX_REDEEMED` are
EARLIER BRANCHES OF THE SAME `elif` CHAIN that later sets `SWAP_COMPLETED`
(`basicswap.py::checkXmrBidState`): script-redeemed -> noscript-redeemed -> (coin-B lock spend
seen) -> `SWAP_COMPLETED`. They are progress steps by construction.

`SWAP_COMPLETED` IS reached on the XMR path (three sites: `checkXmrBidState`,
`process_XMR_SWAP_A_LOCK_tx_spend`, `redeemXmrBidCoinBLockTx`), so the narrow rule does collect.
**But role coverage is NOT proven** - `process_XMR_SWAP_A_LOCK_tx_spend` sets it under
`if not was_received`, a role branch. See the P3 exit criteria below.

Not chargeable: everything else, including `XMR_SWAP_FAILED_REFUNDED`, `..._SWIPED`,
`..._RECOVERED`, `BID_ABANDONED`, `BID_EXPIRED`, `SWAP_TIMEDOUT`, and the v0.18.5 `*_MERCY`
states. Enforce with an exhaustiveness test over every state, not a comment.

**SCOPE FINAL 2026-08-29: fee coins are LTC, BCH, BTC only** (DASH and DOGE dropped; this
RE-ENABLES BTC, reversing the earlier disable - confirm). These are exactly the three with
dedicated upstream XMR-pair regtest files, so the scope is also the testable scope. At 0.5%:
BCH is pure percentage (its $0.22 switchover sits below the $0.39 protocol minimum, so the flat
never engages); LTC charges the $0.01 flat from $0.39-$2.00 then percentage; BTC charges the
$0.60 flat from $63-$120 then percentage. The guard never fires on any of the three.

**Per-chain schedule** - see the corrected table in `CLIENT-PLAN-SIDECAR-FEES.md` (BCH is the
cheapest fee coin; SOL's floor is one-time rent exemption; **ADA's min-UTXO applies to every
output forever**, making it the worst; BTC's protocol minimum exceeds its switchover so it needs
no flat).

---

## 5) DECISIONS ALREADY MADE - do not re-litigate

1. **Per swap, at settlement.** No accrual, no running balance, no obligation the user owes.
2. **Separate payment**, never an output inside a swap transaction.
3. **Denominated in the scripted leg** (always exists; screenable).
4. **Only pairs with a scriptless leg are charged.** Everything else is free - that is the
   product story, not an oversight.
5. **BTC collection disabled** by operator direction.
6. **Never gate a swap on the fee.** Swaps must run identically whether or not a fee is ever
   paid. This is a compliance boundary, not a preference - gating converts a software vendor into
   a coordinator.
7. **No enforcement machinery.** No attestation, no obfuscation, no licence keys. A fork that
   strips the fee simply does not pay; that is accepted.
8. **Fee reserve is required** in the direction where the user SELLS the scripted coin (they end
   up holding the privacy coin with nothing to pay from). Max-swap-size must hold back
   fee + network costs, exactly as wallets reserve gas.

---

## 6) BUILD ORDER

1. `schedule.rs` + `engine.rs` as PURE Rust with unit tests. No I/O. Get the decision table green
   first - it is the whole system's correctness.
2. `ledger.rs` with the in-flight marker and startup reconciliation.
3. `settle.rs` - the withdraw, retry/backoff, `blocks_to_unlock`-aware scheduling.
4. `mod.rs` - wire the self-driving watcher to the sidecar's settlement events.
5. TS: `useSidecarFees` + `SidecarFeesCard` (read-only surfaces).
6. Pre-trade quote display in the swap confirm, next to the spread and chain costs.
7. `FEE.md` at repo root (see section 8).

Add a `sidecar-fees` row to `BOUNDARIES.md`.

**Ship it behind a flag, dark, until the counsel gate clears (section 7).**

---

## 7) TESTS (each maps to a way this breaks)

- Decision matrix per coin: eligibility, floors respected, rounding never yields a below-floor
  payment, unknown coin fails loudly.
- **A scripted<>scripted pair (LTC<>BTC) is charged NOTHING**; an Intents swap never reaches the
  engine.
- **A refunded/aborted/swiped swap accrues nothing.**
- **Idempotency**: a replayed settlement event for one swap id charges once.
- **Crash safety**: an in-flight marker present at startup reconciles against transfer history
  and never re-sends a landed payment.
- **ZEPH balance shape**: a `balances[]`-nested response yields the correct unlocked figure,
  never 0.
- **Retry scheduling**: a locked balance schedules from `blocks_to_unlock`; a genuinely
  insufficient balance does not retry forever.
- **Failure isolation**: a withdraw error leaves swap state untouched.
- **Fee reserve**: max-swap-size holds back fee + network costs so a user who swaps "everything"
  can still pay.

---

## 8) OPEN - RAISE, DO NOT DECIDE

1. ~~STRUCTURE~~ **SETTLED 2026-08-26**: flat-below-switchover (B) with the
   `MAX_EFFECTIVE_RATE = 50%` guard that degrades to waive (A) where B would be abusive. See
   section 2. No longer an open question.
2. ~~The rate~~ **SETTLED 2026-08-26: `RATE = 0.5%`.** Note the per-chain table's switchover
   column in `CLIENT-PLAN-SIDECAR-FEES.md` was computed at 1% - **at 0.5% every switchover
   DOUBLES** (LTC $1.00 -> $2.00, ADA $17.95 -> $35.90). The flat/floor column is
   rate-independent. Derive switchovers from `flatFee / RATE`; never copy them.
3. **Rotating derived fee addresses** - option, not yet chosen. Design `schedule.rs` so the
   address source is pluggable (static per coin OR xpub-derived per swap).
4. **Counsel gate.** Do NOT enable collection anywhere until the operator confirms the legal
   review has cleared. Build behind a flag.
5. Anything touching how BasicSwap actually behaves that is not inlined above - raise it. You
   cannot see that source; the desk can.

---

## 9) STANDING INVARIANTS

- The swap ALWAYS completes regardless of fee outcome. No code path may condition settlement.
- Only settled swaps are charged.
- Flat and agnostic: same rate across pairs, directions and counterparties. No liquidity-side
  payments, no fee sharing with any maker.
- Disclosed and inspectable: the schedule and fee addresses live in the open-source tree; the
  ledger is visible to the user.
- Never present the fee as a commission, spread, or share of the trade - in UI copy, docs, or
  code comments. It is a **per-use licence fee** (and, above the threshold, a volume-scaled
  licence tier). This wording is deliberate and load-bearing.
- Commit everything to this repo the same session; the operator pushes.
