# CLIENT - Sidecar Compliance Shape and the UX It Constrains

Self-contained for this repo (it crosses to the build machine without the estate vault).
Compiled 2026-08-15. **Posture, not legal advice.** Items marked GATE are counsel-blocking.

This exists because several UI decisions are NOT free choices - they are the visible half of the
compliance posture. A developer who does not know why "never gate the swap on the fee" matters
will eventually optimise it away.

## 1. What pwnda is, in one line

**A software vendor and a passive interface.** It ships a wallet and an opt-in sidecar that lets
a user reach an open P2P network, and lets the user execute by their own signature against funds
pwnda never holds.

Pwnda is **never**: a counterparty to a swap, a custodian, a coordinator, a discretionary
order-router, or the operator of anything indispensable to settlement.

**Governing rule: revenue meters doors and software - never transmission pwnda performs or
gates.**

## 2. Three tests every feature must pass

1. **Walk-away.** If pwnda's servers vanish tonight, users lose convenience only - never funds,
   never in-flight value, never market access.
   *Build consequence:* the sidecar talks to Particl SMSG directly; no pwnda server sits in the
   swap path; any advisory endpoint must be optional and user-configurable.
2. **Attachment.** Fees attach to software or to access to an INDEPENDENT actor's function -
   never to something pwnda operates or gates. Client-side fee CONSTRUCTION is fine; settlement
   or propagation GATEKEEPING never is.
   *Build consequence:* **the swap must complete identically whether or not a fee is ever paid.**
   No code path may make settlement conditional on collection.
3. **Vacuum.** Affiliated liquidity never dominates the book, never gets routing preference,
   never shares fees, and is always disclosed on the same terms as third parties.
   *Build consequence:* the offer ranking must be a pure function of price/terms. No
   "our maker first" branch, ever.

## 3. Hard UI/UX rules that come from posture, not taste

| rule | why |
|---|---|
| **Never gate a swap on the fee.** | Gating converts a vendor into a coordinator - the shape that sentenced the Samourai founders. |
| **Disclose the fee pre-trade, as a line item.** | A fee with a named deliverable is a licence; a hidden one is an extraction. |
| **Never imply pwnda is the counterparty.** | Copy says "you are swapping with another user on an open network", never "we'll swap that for you". |
| **No taker-feed fictions.** | There is NO endpoint exposing other users' bids or swaps. Never show fill rates, demand, or "N others viewing". |
| **Offer ranking is price-only.** | Vacuum test. |
| **Advisory data must be skippable.** | Any pwnda-hosted hint (price feed, counterparty quality) must degrade to "unavailable", never block. Walk-away test. |
| **Refunds presented as normal outcomes.** | They are timelock behaviour, not failures - and framing them as errors invites support pressure to "fix" them by intervening, which we must never do. |
| **Never market privacy-from-authorities.** | Marketing to illicit users was load-bearing in the Samourai prosecution. Sell software, speed, self-custody. |

## 4. The fee, and why it is shaped that way

Structure (full spec in `CLIENT-PLAN-SIDECAR-FEES.md`):

```
fee = rate x notional(scripted leg)
collect IFF fee >= max(chainMinOutput[coin], k x txCost[coin])
```

- **A separate ordinary payment at settlement**, not an output inside a swap transaction.
  Verified: the receive-direction in-swap fee is impossible anyway (spend-side verifiers enforce
  exactly one output), and an in-swap fee invites the argument that the fee meters transmission.
- **Only on successful swaps** - the money is never taken until a swap completes, so no refund
  machinery exists and no fee ever attaches to a failed transmission.
- **In the scripted leg**, which always exists and is screenable.
- **Flat and agnostic** across pairs, directions, counterparties.
- **Waived below a per-chain floor**, so the RATE stays uniform and only a mechanical chain
  limit moves. Present the waiver as a product promise ("no fee under $X"), not as an accident.

**Language rule (matters more than it looks):** describe the tiers as a **per-use licence fee**
and a **volume-scaled licence tier**. Never as a commission, spread, or share of the trade - in
UI copy, docs, or code comments. The SEC covered-interface condition describes compensation as
"a fixed charge to the user", and the licensing framing is the one that fits.

## 5. Why users pay when the code is open

Fork resistance for a wallet is unusually strong, and the UI should lean on it rather than fight
forks technically:

- **A fork of key-holding software must be trusted with keys.** A fee-stripped fork of a privacy
  wallet has exactly the profile of a wallet drainer. Privacy users are trained to refuse that.
- **Signed, reproducible releases** are the moat. The fork must self-distribute and re-earn trust.
- **What a fork cannot copy:** aggregate counterparty-quality data (which makers actually settle),
  ongoing engineering (a fork freezes while upstream moves and the harness needs re-merging every
  release), the wizard and support, and brand recourse.
- **NEVER** attempt client attestation, obfuscation, licence keys, or settlement gating. All break
  the posture, all are trivially defeated, and gating is the coordinator shape.

**The fee must stay avoidable in principle to stay defensible in practice.**

## 6. UX that defends the rate (same work as the compliance work)

1. **The wizard** - configuring particld plus coin daemons is the single biggest barrier to using
   BasicSwap. Removing it IS the product.
2. **Spread exposure + extreme-offer gating** - the book carries trap offers; the wallet that
   refuses to let a novice take a +14% offer is worth paying for. (Spec in the execution plan.)
3. **Plain-language state tracking** across a 30-90 minute settlement, refunds included.
4. **Honest route comparison** - including that XMR/ZEPH exist only on the sidecar.
5. **Comparative fee display** - our fee next to the spread and chain costs; ours is usually the
   smallest number, so show the whole screen.

Every one of those is simultaneously a reason the default beats a fork AND a named deliverable
that makes the fee a licence rather than a toll.

## 7. Open GATEs (do not enable collection before these)

1. Does a per-swap, separately-paid, user-signed interface fee on a self-settled P2P forum stay
   on the software-vendor side of FIN-2019-G001 (sec 4.5.1 software provider, sec 5.1 forum
   carve-out)? Does charging only on screenable legs change the analysis?
2. State money transmission / BitLicense reach for a pure interface earning per-transaction fees.
3. OFAC expectations for a non-custodial interface whose users transact with anonymous
   counterparties on legs it cannot screen.

**Build the fee behind a flag; ship it dark until these are answered.**

## 8. Two facts worth carrying

- **The Kraken-shaped risk is the RELAY, not the swaps.** Payward was fined for failing to
  GEOLOCATE its own users, not for failing to screen counterparties. The relay is the only
  component that sees user IPs - geo controls belong there.
- **Why no identity layer:** a regulated exchange can list XMR because its compliance runs at the
  account perimeter (KYC). Pwnda is non-custodial with no accounts by design, so chain provenance
  is the only signal available - which is why fees are taken on the screenable leg.
