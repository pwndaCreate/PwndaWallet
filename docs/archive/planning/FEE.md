# The PwndaWallet swap fee

This wallet is open source. **You can remove this fee.** We are asking you not
to, and this page is exactly what it costs, when it applies, and what it pays
for. A fee you can read and check is the only kind worth charging.

---

## The short version

**Almost everything is free. One thing is not.**

| what | fee |
|---|---|
| Holding, receiving, sending, the ~20 chains | **free** |
| Mining, the pool, the miner binaries | **free** |
| Mainstream swaps (the Intents route) | **free** |
| Peer-to-peer swaps between two transparent coins (LTC↔BTC, BCH↔BTC …) | **free** |
| The swap engine, the Windows runtime, the UI, the source | **free** |
| **Peer-to-peer swaps with a Monero leg** | **0.5%** |

That last row is the only place money is charged, and it is the one thing this
wallet does that almost nothing else does: a real atomic swap between Monero and
a transparent coin, on your own machine, with no custodian and no account.

---

## Exactly when it applies

A fee is charged **only** when all of these are true:

1. the swap went through the peer-to-peer (BasicSwap) route — not the Intents route;
2. one side of the pair is a **scriptless** coin — Monero, Zephyr or Zano — and the
   other is a transparent coin with a schedule row (LTC, BCH, BTC);
3. **you were the taker** — you placed the bid on someone else's offer. Makers
   (the side that posted the offer) are never charged; and
4. the swap **completed successfully**.

So the eligible pairs today are `XMR↔LTC`, `XMR↔BCH`, `XMR↔BTC`, and the same
three transparent coins against `ZEPH` and `ZANO`. A swap between two scriptless
coins, or between two transparent coins, is free. (Roles and the follower coins
were added 2026-09-04; before that the text here said "one side is Monero" and
the watcher also swept the maker's half of the book.)

**Nothing is charged on a swap that did not complete.** Not failed swaps, not
refunds, not timeouts, not cancellations, not swaps the counterparty recovered.
This is not a refund policy — the fee is simply never taken in the first place,
because collection only happens after a swap reaches its completed state.

---

## What it costs

**0.5% of the transparent leg**, with a small flat minimum on very small trades
so that collecting does not cost more than it collects.

| coin | small trades | larger trades |
|---|---|---|
| **BCH** | 0.5% throughout — the minimum never applies in practice | 0.5% |
| **LTC** | flat 0.01 USD-equivalent up to ~$2 | 0.5% |
| **BTC** | flat 0.60 USD-equivalent up to ~$120 | 0.5% |

The fee is always charged in the **transparent** coin, never in Monero, Zephyr
or Zano. That is structural rather than a preference: the scriptless side of an
atomic swap can only ever be the follower, so every eligible pair has exactly one
transparent leg.

**Two costs, not one.** The fee is sent as an ordinary payment, so you also pay
that transaction's normal network fee. On a $2 LTC swap that is about $0.01 in
fee plus about $0.005 in network cost. Both appear in the pre-trade summary
before you commit to anything.

---

## Where it goes

Published, so you can check the arithmetic on-chain at any time:

*(The BTC and BCH addresses were rotated on 2026-09-02. Nothing had been
collected to the previous ones — the fee has never been enabled.)*

| coin | address |
|---|---|
| LTC | `ltc1q5rm7yppfc7yf7zh0ua9lm4cr6vgd5veppzalkk` |
| BTC | `bc1q34ra2es97g8pdudkg7raqwd8ecen3rww0604l0` |
| BCH | `bitcoincash:qrppd4xmtha3ys5cmpyus0decthtw69v8u4pntv8xc` |

---

## How it works, mechanically

After a swap completes, the wallet sends **one ordinary payment** from your own
swap wallet to the address above. It is not part of the swap transaction and it
touches no part of the atomic-swap protocol.

That matters for a reason worth stating plainly: **the fee cannot interfere with
your swap.** It is computed and sent afterwards, it never gates settlement, and
if it fails for any reason your swap is entirely unaffected. If the wallet is
interrupted mid-payment, the record is marked *indeterminate* and is **never
retried automatically** — we would rather miss a fee than risk charging twice.

There is no running balance and nothing accrues. Each swap is charged once, or
not at all.

---

## You can remove it

An open-source wallet running on your machine can always be modified, and
nothing here pretends otherwise. The only technique that would actually prevent
removal is refusing to settle your swap until you pay — and that would turn a
piece of software into a middleman standing between you and your own funds. We
will not build that.

So the fee stays removable. What we ask instead is that it is small enough not
to be worth the trouble, honest enough to explain in one page, and charged only
where we are actually doing something no one else does.

If you fork this wallet and strip the fee, please do not ship it as
"PwndaWallet" — the name and marks are reserved, in the same way Firefox and
Chrome are, so that people can tell a build we stand behind from one we do not.
That is a trust boundary for the person installing a wallet, not a restriction
on the code.

---

## How the fee is built in, stated plainly

Everything that decides or moves the fee lives in the wallet's **compiled Rust
core**, not in the JavaScript or in the swap engine:

| what | where |
|---|---|
| the rate (0.5%) | `src-tauri/src/sidecar_fees/schedule.rs` — `RATE_BPS` |
| the per-coin floors and fee addresses | the same file — `FEE_COINS` |
| whether it collects at all | `src-tauri/src/sidecar_fees/mod.rs` — `SHIPPED_MODE` |

**A released build has no runtime switch that turns the fee off.** There is no
setting, flag, or environment variable for it — deliberately, because a switch
that appears to disable a fee and does not is worse than no switch at all. To
change or remove it you edit the constants above and rebuild the wallet from
source, which anyone may do; the licence permits it and the recipe is in the
README.

We are telling you this rather than hiding it. Requiring a rebuild is friction,
and we think honest friction is fair — but a wallet that pretended the fee was
optional when it was not would be something else, and we would rather you could
check.

(Development builds do honour a `PWNDA_SIDECAR_FEES` variable, so the mechanism
can be exercised in dry-run mode while working on it. Release builds ignore it
entirely.)

## Status

**The fee is being collected, as of 2026-09-05.** `SHIPPED_MODE` is `Live` in
the build you are running. It is still a source change plus a release either
way — not a setting anyone can flip remotely, and not something that can change
under you between restarts.

Two things landed with it, and both are checkable rather than promised:

* **Settings ▸ SWAP FEE** shows the rate, the rule, the addresses below, and
  every fee this wallet has computed or paid — including the ones that cost
  nothing, and including any payment that was interrupted mid-send (those are
  never retried automatically). A Rust test fails the build if collection is on
  and that screen is missing.
* **MAX on a peer-to-peer swap that sells the transparent leg holds the fee
  back**, so the swap does not spend the money the fee is due from.

The addresses above are compiled into the binary and checksum-verified at build
time; check them against the chain whenever you like.

*Rate 0.5% · schedule and addresses above · questions and disputes: open an
issue with the swap id and we will look.*
