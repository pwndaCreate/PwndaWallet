# CLIENT PLAN - Sidecar Interface Fee (BasicSwap route)

Status: DRAFT 2026-08-14, operator-directed. No code yet. Companion to
`CLIENT-PLAN-BASICSWAP-SIDECAR.md` (the route itself). Verified mechanics behind every claim
here: `PwndaWalletVault/wiki/synthesis/basicswap-backend-reference.md` and the estate page
`PwndaVault/wiki/analyses/basicswap/interface-fee-mechanics.md`.

## Scope

Pwnda's revenue is two lines. The NEAR Intents route bps already exists (the wallet-proxy
injects `appFees + referral` on the 1Click path) and is not covered here. **This document
covers the second line only: a per-swap interface fee on the BasicSwap sidecar route.**

**SCOPE NARROWED 2026-08-16 (operator direction, the "Phantom rule").** Phantom's real
selection rule is *charge where you are indispensable, give away where you are a commodity*.
Applied here that is sharper than Phantom's own, because our indispensability is narrower:

- **CHARGE: swaps with a scriptless leg (XMR or ZEPH).** The sidecar is the only route in the
  wallet - and near-uniquely in any wallet - for these.
- **FREE: everything else.** Mainstream Intents swaps, scripted<>scripted sidecar swaps
  (LTC<>BTC and similar), holding, sending, the ~20 chains, the mining pool, the sidecar itself,
  the Windows runtime, the UI, the source.

Product story: **everything is free except the one thing nobody else does.** Implementation
consequence: the fee engine must check "does this pair have a scriptless leg?" before charging
at all; if not, charge nothing. Mechanism is otherwise unchanged (scripted-leg denomination,
separate payment at settlement, per-chain floor). This also simplifies the schedule - only coins
that pair with XMR/ZEPH matter.

Note the tension recorded on the estate page: the Intents bps is our cleanest legal object and
this direction gives it away, while keeping the counsel-gated line. A pragmatic variant keeps
Intents and treats the privacy swap as the flagship in positioning only. Operator's call.

Market making is NOT a pwnda revenue line. The operator provides liquidity personally under a
separate posture; the wallet gives that liquidity no routing preference, no fee sharing, and
no privileged path, and discloses the affiliation wherever it is reachable through the
interface.

## 1. The mechanism, and why not the alternative

**The fee is an ordinary payment, not part of the swap.** After a swap settles, the wallet
sends a normal payment from the user's own sidecar wallet to a published pwnda fee address,
via the sidecar's existing API: `POST /json/wallets/<coin>/withdraw` with
`{value, address, subfee}`, returning a txid (verified in `js_server.py:66-97`).

Rejected alternative - a fee output stitched into the swap's own transaction:

- On the FUNDING direction it is possible (the counterparty's `verifySCLockTx` finds the lock
  output by script and imposes no output-count limit) but requires patching
  `createSCLockTx` inside the harness fork - fee logic living in forked protocol code, carried
  through every upstream merge.
- On the RECEIVE direction it is **impossible against mainstream nodes**:
  `verifySCLockSpendTx` enforces `ensure(len(tx.vout) == 1)` plus an exact destination match,
  and the transaction is adaptor-signed over its exact bytes. Doing it anyway would confine
  those trades to fork-to-fork.

So: zero protocol contact, symmetric across directions, interop-safe, and no fee logic in the
upstream-merge path. The cost is one extra transaction, which section 4 amortizes away.

## 2. Where the money is

BasicSwap runs its own per-coin wallets under the sidecar datadir - swap funds live there, not
in the Tauri vault's derived keys. That is convenient here: after settlement the received coin
is already sitting in the sidecar wallet the fee is paid from, so the fee payment is one API
call against a balance that exists, with no cross-wallet movement.

(Separate design question for the sidecar plan, not this one: whether to initialize the
sidecar's master seed deterministically from the user's vault so the sidecar wallets are
covered by the existing backup.)

## 3. Which coin the fee is charged in

**Always the scripted (transparent) leg of the pair.** This is structurally guaranteed to
exist - a scriptless coin can only ever be the follower - so every supported pair has exactly
one, and the rule needs no per-pair table:

| pair shape | examples | fee coin |
|---|---|---|
| scriptless <> scripted | XMR or ZEPH against LTC / ADA / AVAX / BTC / BCH / DOGE / DASH / PART / FIRO / NAV / NMC / DCR | the scripted coin |
| scripted <> scripted | LTC<>BTC, LTC<>DOGE, BCH<>BTC (upstream pairs with existing volume) | the coin the user RECEIVES |

The rule is asset-agnostic by construction, so it already covers every coin BasicSwap carries
today and any coin the harness adds later. Two consequences worth keeping: fee receipts land
on chains where screening and banking are operable, and pwnda never accrues revenue in an
asset it cannot screen.

## 3a-FINAL. SCOPE (operator, 2026-08-29) - LTC, BCH, BTC only

**Fee coins: LTC, BCH, BTC. DASH and DOGE are OUT.** Fees apply only to a
scripted<>scriptless swap, and the scriptless leg is XMR (ZEPH is planned, not present).

**BTC IS RE-ENABLED — CONFIRMED BY THE OPERATOR 2026-08-29**, reversing the earlier
"BTC collection DISABLED" direction. The confirmation was the operator supplying a BTC fee
address (rotated 2026-09-02 to `bc1q34ra2es97g8pdudkg7raqwd8ecen3rww0604l0`) alongside LTC and BCH. The two stale
"DISABLED" cells further down are corrected in place below rather than left to contradict this.

The three chosen coins are exactly the three with dedicated upstream XMR-pair regtest files
(`test_ltc_xmr.py`, `test_bch_xmr.py`, `test_btc_xmr.py`). DASH has only partial XMR coverage in
`extended/test_dash.py` and DOGE has none - so this scope is also the fully-testable scope, which
is a strong independent reason to like it.

At `RATE = 0.5%`, `K = 2`, XMR the other leg (min swap = `max(0.001 XMR $0.39, 0.001 coin)`):

| coin | flat | switchover | min legal XMR-pair swap | what actually happens |
|---|---|---|---|---|
| **BCH** | $0.0011 | $0.22 | **$0.39** | switchover is BELOW the protocol minimum -> **pure percentage, the flat never engages** |
| **LTC** | $0.0100 | $2.00 | **$0.39** | flat $0.01 from $0.39-$2.00 (2.6% -> 0.5%), percentage above |
| **BTC** | $0.60 | $120.00 | **$63.03** | flat $0.60 from $63-$120 (0.95% -> 0.5%), percentage above |

**The `MAX_EFFECTIVE_RATE` guard never fires on any of the three** - guard zones are $0.0022 /
$0.02 / $1.20, all far below each pair's protocol minimum. It stays implemented and
DORMANT-PENDING-ZEPH.

**No DASH row is needed** - the open decision is closed by removing DASH from scope.

## 3b. SETTLED PARAMETERS (operator, 2026-08-26)

```
RATE               = 0.005   (0.5%)
K                  = 2
MAX_EFFECTIVE_RATE = 0.50
```

**Structure: B (flat below the switchover) with a 50% guard that degrades to A.** Below the
switchover the flat is charged, EXCEPT where that flat would exceed 50% of the trade, in which
case nothing is charged. `flatFee[coin]` IS the collection floor; switchover =
`flatFee / RATE`; guard fires below `flatFee / MAX_EFFECTIVE_RATE`.

At 0.5% (note: the section-3 table's switchover column was computed at 1% - **these are
doubled**):

| coin | flat | guard below | switchover | net effect |
|---|---|---|---|---|
| BCH | $0.0011 | $0.0022 | $0.22 | pure B - guard never fires (min legal BCH swap $0.2054) |
| LTC | $0.0100 | $0.0200 | $2.00 | pure B - guard never fires (min legal LTC swap $0.044) |
| AVAX | $0.0100 | $0.0200 | $2.00 | guard on ZEPH pairs only ($0.0067-$0.02) |
| DOGE | $0.0020 | $0.0040 | $0.40 | guard on ZEPH pairs only |
| ADA | $0.1795 | $0.3590 | $35.90 | guard on ZEPH pairs only |
| BTC | $0.60 | $1.20 | $120.00 | **ENABLED 2026-08-29** (was DISABLED; superseded by 3a-FINAL) |

**The guard replaces a per-coin A/B table.** It reproduces the operator's rule ("BCH and LTC use
B; anything over 50% uses A") automatically, and unlike a static table it self-corrects per PAIR
and per TRADE - AVAX is fine on XMR pairs (min $0.393) and abusive on ZEPH pairs (min $0.0067),
which only a runtime check can distinguish. Without it, the smallest legal ZEPH-pair swap would
pay 150% (AVAX), 571% (DOGE) or 51,286% (ADA).

Implement as ONE branch with `MAX_EFFECTIVE_RATE` as a named constant - not as a per-coin policy
field.

## 4. PER-SWAP collection - no accumulation (operator direction 2026-08-15)

**No accruing obligation.** The operator rejected a running balance the user owes. Each swap is
charged on its own, or not at all. What remains is a transient RETRY RECORD (one settled swap
whose payment has not yet landed), never a debt that grows across swaps.

**Default: charge at SETTLEMENT, one payment per successful swap.** When a swap reaches a
terminal success state, the wallet issues one `withdraw` for that swap's fee in the pair's
scripted coin. Failed, refunded, aborted and swiped swaps are never charged - not because a
refund fires, but because **the money was never taken**. That is the cheapest possible answer
to "fees must not be paid on failed swaps": do not collect until success exists.

Cost: one small transaction per SUCCESSFUL swap. On LTC and AVAX that is a fraction of a cent
against a fee measured in dollars; on BTC it is material; on ADA it is bounded by min-UTXO
(below). The per-swap cost is the price of the success-condition, and it is the right trade at
these fee levels.

### The fee reserve (a real functional requirement)

In the direction where the user SELLS the scripted coin, they fund the lock with it and hold
the privacy coin at settlement - so a user who swapped their whole balance has nothing left to
pay the fee with. **The wallet must reserve the fee plus network costs when computing maximum
swap size**, exactly as wallets already reserve gas. Few lines, familiar UX pattern, and it
forces the fee to be visible pre-trade, which disclosure wants anyway. (Bundling would dodge
this for free but reintroduces forked code, charges attempts, and leaves two inconsistent
charge timings to explain.)

### Rate basis: the scripted leg is the natural denominator

A flat percentage of the SCRIPTED leg is direction-agnostic by construction - both legs are the
same trade value in different units, so 1% of the scripted leg is 1% of the notional whether
the user is buying or selling it. It also needs NO PRICE FEED: the amount is in the offer.
Charging on "whatever the user sold" would denominate half of revenue in the privacy coin and
require an oracle to compare fees at all.

Pricing note for the operator, not a compliance point: the fee is ADDITIVE to the maker's
spread, which on this book runs +0.2% to +14% over mid
([[../PwndaVault/wiki/analyses/basicswap/orderbook-findings]] - server vault). All-in user cost
is maker spread + our bps + chain fees, which can push the atomic route past both instant
exchangers and our own Intents route, where solver competition compresses the spread. Phantom's
0.85% sits on deep liquidity where the underlying spread is thin; a thin orderbook makes the
same number a larger share of total cost.

### Minimum collectable size (the fixed cost dominates at small trades)

Measured 2026-08-15 (approximate; re-check): XMR ~$0.00014/tx, LTC ~$0.005, ADA ~$0.01-0.05
plus a ~1 ADA min-UTXO, AVAX ~$0.01-0.05, BTC ~$0.20-1+, **ZEPH 0.014 ZEPH ~= $0.005**
(verified from the pool's own `transferFee` config; ZEPH ~$0.32-0.40). SOL is not on this
route - it stays on Intents, where `appFees` are deducted at settlement by the solver and there
is NO collection transaction at all. That contrast matters for planning: the same nominal bps
nets in full on Intents and nets minus one transaction here.

**At small trade sizes the fee PERCENTAGE is irrelevant - the fixed collection transaction
dominates.** On a $1 trade, 1% vs 0.85% differs by 0.15 cents while collection costs ~$0.005 on
LTC. Two hard floors sit underneath: the protocol amount floor means **a $0.10 swap cannot
exist at all** (any XMR pair needs > 0.001 XMR, ~$0.39), and ADA's min-UTXO makes an ADA fee
output below ~1 ADA invalid regardless of mechanism.

**ZEPH note**: its `min_amount` is 0.001 ZEPH, identical in coin terms to XMR, but ZEPH trades
near $0.35 so the protocol floor is ~$0.0004 rather than XMR's ~$0.39 - ZEPH pairs are not
floor-limited. The practical minimum is unchanged, because it is set by the SCRIPTED leg's
collection cost, not the privacy leg.

**Do NOT use a flat minimum fee.** Computed 2026-08-15: a $0.05 fee output is UNSENDABLE on
BTC (below the ~294 sat dust threshold, ~$0.29) and on ADA (below the ~1 ADA min-UTXO, ~$0.50),
and on AVAX gas would take 60% of it. A flat that cleared every chain would have to sit near
BTC's collection economics (~$5), which on a $1 trade is 500%, not 5%. The decisive objection
is posture rather than optics: per-chain flats mean different EFFECTIVE RATES by chain, which
breaks the flat-and-agnostic property; waiving below a threshold keeps the rate uniform and
moves only a mechanical limit.

**The structure to implement:**

```
fee = rate x notional(scripted leg)
collect IFF fee >= collectionFloor[coin]
collectionFloor[coin] = max(chainMinOutput[coin], k x txCost[coin])    // k ~= 10
```

One global `rate`. `chainMinOutput` is dust / min-UTXO / zero. `k` bounds the collection
transaction to <= 10% of what it collects. Derived floors at a 1% rate, and the minimum trade
each implies: LTC $0.05 / ~$5; ZEPH $0.05 / ~$5; AVAX $0.30 / ~$30; ADA $0.50 / ~$50 (min-UTXO
binds); BTC $5.00 / ~$500 (tx cost binds). Below the floor, charge NOTHING - disclosed as free
small swaps.

Two optional refinements to decide deliberately, each trading uniformity for competitiveness:
an upper per-swap CAP, and a DIFFERENT rate on the Intents route (defensible - Intents deducts
at settlement with no collection transaction, so the full bps arrives there).

### Target segment and per-chain policy (operator direction 2026-08-15)

The small-trade case is a specific journey: **mining XMR/ZEPH and swapping out to a scripted
chain at low value, high frequency.** It lands in the direction where the mechanics are already
clean - the miner sells the scriptless coin, so they RECEIVE the scripted coin and the fee comes
out of received funds (**no fee reserve needed**), and the claim tx is single-output so
**bundling is impossible here anyway** - settlement collection is the only mechanism and is
no-fee-on-failure by construction.

**BUNDLING IS REJECTED OUTRIGHT** (no fees against failed swaps). Settlement collection
everywhere; the 4b section is retained only as recorded reasoning.

Per-chain policy to implement:

**CORRECTED 2026-08-19** against live prices (the earlier ADA/AVAX rows used stale price
estimates - ADA is ~$0.18 not ~$0.50, AVAX ~$6.68 not ~$30). k=2, rate 1%:

| fee coin | price | chain floor | tx cost | **collection floor / flat** | **fee starts / switchover** | collection |
|---|---|---|---|---|---|---|
| BCH | $205.38 | dust ~$0.0011 | ~$0.0005 | **$0.0011** | **$0.11** | ENABLED - best fee coin on the board |
| DOGE | $0.0701 | dust ~$0.0007 | ~$0.001 | **$0.0020** | **$0.20** | ENABLED |
| LTC | $43.98 | dust ~$0.0002 | ~$0.005 | **$0.0100** | **$1.00** | ENABLED - the cashout workhorse |
| AVAX | $6.68 | none | ~$0.005 | **$0.0100** | **$1.00** | ENABLED |
| SOL* | $75.29 | rent-exempt ~$0.067 ONE-TIME | ~$0.001 | **$0.067 first, then $0.0020** | **$6.70 -> $0.20** | if added |
| ADA* | $0.1795 | **min-UTXO ~$0.18 EVERY output** | ~$0.03 | **$0.1795** | **$17.95** | if added; min-UTXO binds |
| BTC | $63,030 | dust ~$0.19 | ~$0.30 | $0.60 | $60.00 | **ENABLED 2026-08-29** - operator reversed the earlier disable; switchover $120 at the settled 0.5% rate, not the $60 shown here (that column was computed at 1%) |
| XMR / ZEPH | - | - | - | never a fee coin (scriptless leg) | - | - |

`*` not in the fork today. Notes: **BTC needs no flat either way** - its protocol minimum
($63.03) exceeds its switchover ($60), so every legal BTC swap is already above the percentage
line. **SOL's floor is one-time** (rent exemption on account creation) while **ADA's min-UTXO
applies to every output forever** - which makes SOL a good fee coin and ADA the worst.

The "fee-collection min trade" column is the size at which a FEE STARTS BEING CHARGED, NOT a
limit on what the user may swap. The user's real floor is the protocol `min_amount` (0.001 of
EACH coin, both legs must clear their own, so the binding leg is the more valuable coin):
ZEPH<>LTC ~$0.05, XMR<>LTC ~$0.39, XMR<>BTC ~$100. Swaps below the fee-collection minimum
proceed normally and are simply free.

`k` in one line: **how many times larger the fee must be than the cost of collecting it before
we bill.** k=2 = "bill only when the fee is at least twice the collection cost", so we keep at
least half; k=10 keeps at least 90%.

At k=2 a $2 ZEPH->LTC cashout yields: fee $0.020, collection $0.005, **net $0.015 (75%
margin)**; user all-in ~1.5% including chain costs, before the maker spread. **k=2 serves the
segment down to $1 at a uniform rate, so no flat-fee tier is required** - a flat would only
reach sub-$1 trades, which sit below collection break-even ($0.50).

**ROUTING - CORRECTED 2026-08-15.** An earlier draft here said Intents routes XMR natively and
XMR cashouts belong there. **That is wrong.** A live pull of the catalog through our own proxy
(`GET wallet.pwnda.org/api/intents/tokens`) returns 175 asset rows / 109 symbols with **NO XMR
and NO ZEPH** - DASH and ZEC are the only privacy-adjacent assets present. **The BasicSwap
sidecar is therefore the ONLY route this wallet has for XMR or ZEPH swaps**, which makes it the
privacy-asset rail rather than a niche addition, and raises its build priority accordingly.
(Even the retracted claim carried the estate's T6 caveat that an Intents XMR leg would be
CUSTODIAL solver flow - archetype I, "not a default route" - so it was never the right
destination for a non-custodial product.)

**The fee reserve is still a GENERAL requirement.** Pwnda is not a counterparty; these are
trades between two independent users, so any user can be on either side. The miner-cashout
journey happens to avoid the reserve (they receive the scripted coin), but the opposite
direction - selling the scripted coin - ends holding the privacy coin with nothing to pay from.
Max-swap-size must hold back fee + network costs whenever a fee will be charged.

### Rotating derived fee addresses (option)

Config flag. Instead of one static address per coin, derive per-swap fee addresses from a
published xpub (deterministically from the swap id, so both sides can locate them). Blunts the
on-chain tag - casual and automated clustering of our users and revenue stops working.

Honest limits to state in the docs: publishing the xpub for revenue auditability lets a
determined analyst derive the whole set, so this defeats the casual observer rather than the
motivated one. It also leaves us holding many small UTXOs needing periodic consolidation -
cheap, and **freely batchable, since we hold every key**. This is the one place cross-user
batching IS available (we are the single spender), unlike the user-pushed payment path.

### Why script-enforced conditionality does NOT work here (verified 2026-08-15)

The attractive design - a fee output hashlocked to the same secret the swap reveals, so it pays
out exactly when the swap completes and refunds by timelock otherwise - **cannot be built on
this protocol.** Secret recovery is `recoverEncKey(esig, sig, K)`
(`interface/btc/btc.py:2045`), and its first argument is `al_lock_spend_tx_esig`
(`basicswap.py:12968`) - the ADAPTOR signature, a private protocol artifact exchanged over SMSG
between the two swap parties and **never published on chain**. A third party watching the chain
sees `sig` but not `esig`, so pwnda cannot recover the scalar from public data. The hashlock
would have to be satisfied by the user handing over the secret, which a user avoiding the fee
simply will not do.

Two weaker variants and why they are not worth it:

- **Covenant-style introspection** (make the fee output's spendability depend on WHICH branch
  spent the lock) is not expressible in Bitcoin/Litecoin script.
- **A "pwnda-or-user-after-T" fee output** is cheap to script, but conditionality would be
  POLICY-enforced (our watcher decides whether to sweep), not script-enforced, and it locks the
  user's fee until T with a reclaim transaction needed on failure. More friction than a
  sub-percent fee justifies.
- **On the scriptless side conditionality is impossible outright** - Monero has no scripts, so
  a bundled XMR/ZEPH fee output is unconditional the moment it is broadcast.

## 4b. Optional: bundling the fee into the user's own lock tx

Verified feasible, but NOT the baseline. When the user is FUNDING the scripted leg, the fee
can ride as a second output in their own lock transaction - the pool's amortize-one-skeleton
economics. Mainstream counterparties accept it: `verifySCLockTx` finds the lock output by
script wherever it sits, and the XMR-swap path does not run the inputs check
(`check_a_lock_tx_inputs = False`). Not available in the receive direction (spend-side
verifiers enforce one output).

Per chain: Bitcoin-family = an extra output (~31 vbytes vs ~110-140 standalone); Cardano = an
extra output subject to the ~1+ ADA min-UTXO; EVM = not an output at all, needs EIP-7702 batch
execution (preserves `msg.sender`) or a contract change.

Three reasons it is not the default:

1. It puts fee logic in forked tx-construction code (`createSCLockTx`) - the worst path to
   carry across upstream merges.
2. **It publicly tags every pwnda swap.** An output to a known fee address on a transparent
   chain lets anyone enumerate pwnda-originated swaps (volume, timing, amounts, and the user's
   change via common-input-ownership) and marks the transparent leg of every privacy swap the
   wallet performs. An accrued payment covering N swaps, sent later, breaks that correlation.
3. It only covers the funding direction, so the accrual path must exist regardless.

The saving is ~75% of one fee event's bytes, and accrual has already divided that by N - on
LTC and AVAX that is fractions of a cent. Ship it, if ever, as a per-chain flag for expensive
chains only, with the privacy tradeoff stated in the UI.

## 4c. Scriptless-side collection (XMR / ZEPH) - available, not the default

Verified possible and mechanically the CLEANEST option: `publishBLockTx` sends a wallet-rpc
`transfer` with a `destinations` array, so a fee destination is a one-line addition, and the
counterparty's `findTxB` opens a view-only wallet for the joint address and checks only
outputs paid there - no output-count or shape check, other outputs cryptographically
invisible. Zero interop risk AND zero public trace, unlike the transparent-chain bundling in
4b which tags every swap.

Not the default for two non-technical reasons.

**Unscreenable revenue.** A sanctions program is three actions on a receipt - quarantine,
investigate, and where a sanctioned interest is found block and report. All three need a
sender and a graph. XMR/ZEPH provide neither (ring signatures hide the spent output, stealth
addresses hide the destination), so there is nothing to screen and no way to know which
receipts to block. That matters because OFAC liability is STRICT - it attaches without
knowledge - so exposure exists either way, and what a documented program buys is mitigation
at the penalty stage. On unscreenable receipts there is no program element to document at all.
Two qualifications kept for honesty: screening reads coin provenance, not persons, so it makes
a position defensible rather than safe; and since the fee is paid by our own user, the
direction decides what is visible - a fee taken from just-received coins is a window into the
anonymous counterparty's funds, while a fee taken while funding the leg is the user's own
history.

**Spendable age - a real constraint on the settlement engine.** VERIFIED 2026-08-15 across
BasicSwap, REU26 and Zephyr's own source. The constant is 10 blocks
(`CRYPTONOTE_DEFAULT_TX_SPENDABLE_AGE`), **confirmed for Zephyr too** at its
`cryptonote_config.h:51` (cited in `REU26/zephyr-testnet/ZEPH-SWAP-FRONTIER-PLAN.md:29`), and
REU26 independently pins `MinSpendConfirmations = 10`. It has already caused a real failure on
this estate: the contract-free ADA<>XMR dev run mined only 3 blocks after the XMR lock and the
sweep hit **"No unlocked balance"**, fixed by mining `max(conf,10)+2`.

Settlement-engine requirements, each with a verified precedent:

- **Trigger on UNLOCKED balance, never total.** BasicSwap feeds its UI `balance =
  unlocked_balance` and reports the locked remainder separately (`xmr.py:402-404`); mirror that
  in our fees panel so the user never sees unspendable money as spendable.
- **Schedule retries from `blocks_to_unlock`.** `get_balance` returns it beside
  balance/unlocked (REU26 `wallet_client.go:256-259`) - wait the exact remaining blocks instead
  of blind exponential backoff.
- **Class the failure TEMPORARY.** Upstream does exactly this - insufficient unlocked funds
  raises `TemporaryError("Invalid unlocked_balance")` (`xmr.py:742-751`) - and keep "locked,
  retry" distinct from "actually insufficient".
- **ZEPH SILENT-FAILURE TRAP.** Zephyr's `get_balance` nests per-asset entries under
  `balances[]` with **no top-level `balance`/`unlocked_balance`**, so a Monero-shaped read
  **silent-zeros a funded wallet**. Two implementations hit and fixed this independently (REU26
  `wallet_client.go:229-235`; the BasicSwap ZEPH interface at `interface/zephyr.py:68-82`). For
  the fee engine the failure is silent and total - unlocked reads 0, the threshold never trips,
  collection never happens, nothing errors. **Required test: a Zephyr-shaped `get_balance`
  response must produce a correct unlocked figure, not zero.**
- **Crash-safety against double payment.** The pool ships the transfer FIRST and updates its
  ledger after, and logs *"Super critical error! Payments sent yet failing to update balance in
  redis, double payouts likely to happen"* when it dies in between
  (`ZephyrPool/pool/lib/paymentProcessor.js:279`). Our ledger inherits the hazard: **write an
  in-flight marker BEFORE the withdraw and reconcile against wallet transfer history on
  startup.** The pool's failure path is the model to copy - on RPC error it does not decrement
  the ledger, so the obligation survives to the next interval.

There is no Bitcoin-family, Cardano or EVM equivalent (those spend at one confirmation), so
this binds wherever XMR/ZEPH moves - **including with fees on the scripted leg.**

Recorded as the fallback if the public fee-address tag from 4b/the scripted default proves to
be the larger problem. Charging here is never necessary: the scripted leg is always present
and the user always touches it.

## 5. Lifecycle

1. **Pre-trade**: the swap confirm screen states the fee (flat bps, identical for every pair
   and counterparty) and that it is billed separately on accrual.
2. **Settlement detected**: the sidecar WS event (or a `/json/bids` poll) reports a terminal
   SUCCESS state for a swap the wallet initiated.
3. **Record**: compute fee = bps x notional on the scripted leg; write ONE pending record
   (swap id, pair, notional, fee, coin, timestamp). No running total.
4. **Charge**: issue one withdraw for THAT swap's fee, record the txid, clear the record.
5. **Retry**: a failed withdraw leaves the single record pending and retries with backoff. It
   never touches swap execution, and it never merges with another swap's fee into a balance.

## 6. Hard invariants

- **The fee never gates a swap.** Swaps run, settle, and refund identically whether or not a
  fee is ever paid. No pwnda infrastructure sits in the settlement or message path.
- **Only settled swaps accrue.** Refunded, aborted, swiped and failed swaps accrue nothing.
- **Flat and agnostic.** Same bps for every pair, counterparty, and route; no
  liquidity-side payments; no fee sharing with any maker including the operator's own.
- **Disclosed and inspectable.** The fee schedule and fee addresses live in the open-source
  client; the ledger is visible to the user; fee addresses are published and static per coin
  so revenue is auditable.
- **No enforcement machinery.** A user who forks the client and strips the fee simply does not
  pay. Accept the leakage; do not build gating, because gating is the shape that turns a
  software vendor into a coordinator.

## 7. What to build - SUPERSEDED, see section 7b

> **This section described a TYPESCRIPT module owning the fee, with an accruing
> `accrued[coin]` balance. BOTH ideas were later rejected**: accrual by operator direction
> (2026-08-15), and TS placement because a Rust function *called by* TypeScript is defeated by
> patching the TS call site. It is kept only so the reasoning trail survives - **build section
> 7b, which is what actually shipped.**

Add the feature row to `BOUNDARIES.md` (it needs `src/api/*` for the sidecar client, `src/store`,
and the swap feature's types; nothing else).

## 7b. Fundamental implementation, and the fork question

### The honest constraint

**The fee cannot be made undeletable in an open-source client, and every attempt costs more than
it saves.** Obfuscation, attestation and licence keys all break the open-source claim and are
defeated by one patch; the only mechanism that genuinely works - gating settlement on payment -
is the COORDINATOR shape we must never adopt. Build accordingly: the fee is avoidable by design,
and its protection is economic, legal-by-trademark, and social. Full reasoning in
`CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` and the estate page
`analyses/fee-defensibility-and-fork-resistance`.

What DOES protect it: pricing below the friction of forking; **trademark** (the code is free,
the name is not - a fork may strip the fee but may not ship as "Pwnda Wallet"); signed
reproducible builds; the advisory data service served to installs in good standing (never
settlement); the compounding counterparty-quality moat; and the standing cost of maintaining a
harness fork against two upstreams.

### How the two halves are actually built and stored (verified)

| component | language | how it ships | on-disk form | friction to strip a fee living there |
|---|---|---|---|---|
| **Pwnda Wallet Rust core** | Rust | compiled into the app binary, bundled as an **MSI** (`tauri.conf.json`: `bundle.targets = ["msi"]`) | native executable | **Full Rust + Tauri rebuild per platform, then redistribute an unsigned installer** - XMRig-level |
| Pwnda Wallet frontend | TS/React | Vite -> `dist/`, then **EMBEDDED INTO THE BINARY** at compile time (`frontendDist: ../dist`) | data section of the executable | patch embedded JS in the binary, or rebuild - medium |
| Any external config | JSON | file | plain file | text editor - **none** |
| **BasicSwap sidecar** | **Python** | pinned release, INTERPRETED | **plain `.py` source files on disk** | text editor - **NONE** |

Two conclusions follow directly:

1. **NEVER put fee logic in the BasicSwap sidecar.** It is interpreted Python sitting in plain
   files - a fee there is a one-line edit with no rebuild at all. (It also violates
   keep-upstream-intact.)
2. **Put the decision and the money in RUST.** This is also the repo's own precedent: the
   removed mining dev-fee lived in `src-tauri/src/dev_fee/` - **31 files, ~16.3k lines of
   Rust** - while the frontend held only badges, consent and disclosure components. The
   enforcement was Rust; the display was TS. Do the same here.

### The subtlety that makes Rust placement actually work

Putting a `settle_fee()` function in Rust is not enough if **TypeScript calls it** - a fork then
patches the (easier) TS call site and never invokes it. So:

**The Rust settlement watcher must own the entire path.** Rust already holds the sidecar HTTP
client; it detects settlement, computes the fee, and issues the withdraw *as a consequence of
detecting settlement* - it never waits to be asked by the frontend. The UI only DISPLAYS
(reading a Rust-computed quote and history). Patching the frontend then cannot skip the fee;
only a Rust rebuild can.

This is also simply the right design: the component that watches for settlement should be the
one that acts on it.

### Module layout (REVISED - Rust owns the decision)

```
src-tauri/src/sidecar_fees/          RUST - decision + money
  schedule.rs   rate, per-chain floors + chainMinOutput, k, isFeeEligiblePair(),
                fee-address derivation. Pure, unit-tested.
  engine.rs     pure decision from a settled swap -> {charge | skip, amount, coin}
  settle.rs     the withdraw, retry/backoff, in-flight marker. Only module touching money.
  ledger.rs     per-swap pending records (never a running balance) + history
  mod.rs        THE WATCHER: settlement event -> engine -> settle. Self-driving.

src/features/sidecar-fees/           TS - display only
  useSidecarFees.ts     reads status/history/quote from Rust
  SidecarFeesCard.tsx   settings surface
```

Pre-trade fee display calls a Rust quote function; the UI never computes or decides the fee.

### Honest limits of this (do not oversell it internally)

- **It raises the bar; it is not a wall.** A determined forker rebuilds. XMRig proves both sides
  - the friction is real AND fee-stripped forks exist (and are widely distrusted, which is the
  actual protection).
- **It changes nothing legally.** The fee remains avoidable in principle and still never gates
  settlement - which is exactly what preserves the posture. Rust placement is a commercial
  measure, not a compliance one.
- **Do not let it tempt you toward obfuscation.** Rust is where the money code naturally belongs;
  deliberately hiding or scattering the logic would be a different and bad thing.
- **Signing is a further legitimate layer**: we ship an MSI, and a code-signing certificate
  requires identity verification. A fork must ship unsigned (SmartScreen warnings, alarming for
  a wallet) or obtain a cert in someone's real name - an accountability barrier that costs us
  nothing and restricts no code.

### The decision path (one place, easy to audit)

```
onSwapSettled(swap):
  if !isFeeEligiblePair(swap.pair)        -> no fee   // scriptless leg required
  notional = valueOf(swap.scriptedLeg)
  fee      = rate * notional
  if fee < collectionFloor[feeCoin]       -> no fee   // free small swaps, a stated promise
  record pending(swapId, fee, feeCoin)
  settle(): withdraw -> txid -> clear     // retries; NEVER touches swap state
```

Every branch is inspectable in the open-source tree, which is the point - the schedule is
readable, the addresses are published, and the arithmetic is reproducible by anyone.

### Schedule source

**Hardcoded defaults in the client**, optionally refreshed from the server. Hardcoded keeps the
walk-away test intact (no server, still works, still correct) and keeps the fee auditable in the
source. The optional refresh only allows rate/floor updates without a release; if the fetch
fails, the compiled defaults stand.

### Optics to build IN, not bolt on

- Fee schedule and fee addresses published in-repo; revenue auditable on chain.
- Pre-trade line item next to the spread and chain costs.
- The free tiers stated as promises: "no fee on mainstream swaps", "no fee under $X".
- A short, plain FEE.md in the repo: what it costs, what it pays for, and - stated openly -
  that the licence permits removal and we are asking users not to. **Candour is better optics
  than a failed prevention attempt**, and a prominent honest fee is socially harder to strip
  than a hidden one.

## 8. Tests

- `fee-schedule`: computation matrix per coin; floors respected (LTC dust, ADA min-UTXO,
  AVAX gas); rounding never produces a below-floor payment; unknown coin fails loudly.
- `shouldSettle`: trips at threshold, not before; never settles below the chain floor.
- Ledger: persistence round-trip, version migration, idempotent accrual (one swap id accrues
  once - a replayed WS event must not double-charge).
- **Refund path: a refunded/aborted swap accrues zero.**
- **Failure isolation: a withdraw error leaves the ledger intact and does not touch swap
  state.**
- **Zephyr balance shape: a `balances[]`-nested response yields the correct unlocked figure,
  never 0** (the silent-failure trap above).
- **Crash safety: an in-flight marker present at startup reconciles against wallet transfer
  history and never re-sends a payment that already landed.**
- **Retry scheduling: a locked balance schedules from `blocks_to_unlock`, and a genuinely
  insufficient balance does not retry forever.**
- **Fee reserve: max-swap-size computation holds back fee + network costs, so a user who
  swaps "everything" can still pay at settlement.**
- **Eligibility: a scripted<>scripted pair (e.g. LTC<>BTC) is charged NOTHING, and an
  Intents-route swap never reaches the fee engine at all.**
- **The 50% guard: the smallest legal ZEPH<>AVAX / ZEPH<>DOGE / ZEPH<>ADA swap is charged
  NOTHING; a BCH or LTC swap NEVER hits the guard; the boundary trade (exactly 2 x flat) charges
  the flat at exactly 50%.**
- **Switchover derivation: changing RATE moves every switchover (flatFee / RATE) and leaves every
  flat unchanged.**
- **Minimum collectable size: a trade below the per-chain floor is charged NOTHING (no
  dust-sized withdraw is ever attempted); the floor is derived as
  `max(chainMinOutput, k x txCost)` per coin, and ADA/BTC specifically never produce an output
  below min-UTXO / dust.**
- **Rotating addresses: derivation is deterministic from the swap id and reproducible from the
  published xpub, so every fee receipt is locatable for audit.**

## 9. Open items

- The bps number (operator).
- Fee-address registry per coin, and whether to publish them in-repo (recommended - makes
  revenue auditable and matches the disclosure posture).
- Counsel gate, carried from the sidecar plan's Phase 0: does a per-swap, separately-paid,
  user-signed interface fee on a self-settled P2P forum stay on the software-vendor side of
  FIN-2019-G001, and does charging only on screenable legs change either the classification or
  the knowledge analysis? Build behind a flag; do not enable collection before that answer.
