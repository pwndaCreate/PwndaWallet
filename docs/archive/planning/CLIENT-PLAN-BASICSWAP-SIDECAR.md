# CLIENT PLAN - BasicSwap Sidecar: P2P Atomic Backend + Desk Liquidity Jumpstart

Status: DRAFT 2026-08-14, operator-directed. No code yet. The background is IN THIS REPO,
self-contained, split across two pages:
- `PwndaWalletVault/wiki/synthesis/basicswap-backend-reference.md` - strategy/architecture
  (transport, strictness, floors, the evaluation and revenue model).
- `PwndaWalletVault/wiki/synthesis/basicswap-integration-mechanics.md` - build-facing
  mechanics (JSON API surface, offer/bid lifecycle + state enums, auto-accept modes, the
  createoffers.py patterns + its maxrate bug, sidecar ops gotchas, artifact packaging).
Estate-box deep dives: the server vault's basicswap cluster and REU26 RQ2/RQ3.

## Goal (operator, 2026-08-14; REVISED same day)

Adopt BasicSwap as the wallet's atomic P2P swap backend through a VERSIONED HARNESS (a
maintained fork tracking upstream releases), extended to ZEPH / AVAX / ADA / LTC. Users can
both MAKE and TAKE offers. SOL is explicitly out of the atomic tier (stays on NEAR Intents).
Upstream changes are merged into the harness every release for security.

**REVISION 2 (operator, 2026-08-14, after the regulatory research returned): market making
leaves the COMPANY model.** FinCEN's guidance reaches an automated spread-earning maker
regardless of atomic settlement, open venue, or scale, so the spread is not a pwnda revenue
line. The operator absorbs liquidity provision PERSONALLY under a separate posture -
structurally separated from pwnda wallet/server revenue, with separate accounting, no fee
flows across the boundary, no routing preference in the client, and disclosure wherever that
liquidity is reachable through the interface. **Company revenue is two tolls on doors**: the
NEAR Intents route bps (already built) and a BasicSwap sidecar interface fee
(`CLIENT-PLAN-SIDECAR-FEES.md`). The wallet still ships ASSISTED ORDERS as a client-side
software feature (section below). The custom atomic swap desk (I2P RFQ) FINISHES ITS CURRENT
TEST CAMPAIGN, then is ARCHIVED (section below).

## Architecture (three components)

```
[PwndaWallet (Tauri)]                    [pwnda server]
  swap tab router:                         desk (existing quote engine, float, risk caps)
    auto|swapkit|intents|pwnda-desk          |
    + 'basicswap'  <-- NEW                   v
       |                                   headless harness node (maker mode)
       v                                     - posts/reprices offers in BOTH books
  local sidecar: basicswap-run               - auto-accept policy from desk sizing
    (harness build, opt-in install)          - mainstream book: LTC<>XMR
       |                                     - fork book: ZEPH/AVAX/ADA pairs
       v                                          |
  particld (SMSG) + LTC electrum + XMR wallet-rpc (remote node)
       |                                          |
       +---------- same Particl SMSG network -----+
```

- One SMSG network. The harness adds enum ids upstream does not know; partition is PER COIN
  ID (see adding-a-coin): users interop with the mainstream book on upstream coins and see
  the fork book as a superset. Desk offers are ordinary maker offers - users take them like
  any other; users can also make against each other.

## Assisted orders - auto-created bids/asks settled by the server (REVISION 1)

The wallet helps a user place orders that the server's bots will settle, without the server
being a privileged counterparty in the protocol. Both directions, both precedented by
upstream's own `createoffers.py` AMM bot (rate engine + taker):

- **Assisted TAKE** (simple path, Phase 1): the wallet surfaces the book with the server's
  standing maker offers ranked by effective rate; one tap builds the bid; the server's
  auto-accept settles it. Mechanically identical to taking any other maker's offer.
- **Assisted MAKE** (Phase 2): the wallet auto-creates the user's OWN offer priced inside the
  band the server's TAKER bot bids on. The user is the maker of record; the server (or anyone
  faster/better-priced) takes it.
- **Pricing guardrails** (from the estate's orderbook findings - stale quotes get sniped):
  assisted offers use SHORT validity windows (protocol floor 10 min), auto-revoke + repost on
  price moves (offers are immutable), and a hard price-band vs the wallet's price feed so a
  user can never be assisted into a mispriced order. Band, TTL, and repricing cadence are
  user-visible settings with safe defaults.
- **Openness invariant**: assisted orders are ordinary SMSG offers/bids on the open book. Any
  third party can take a user's assisted offer or undercut the server's. The software adds
  convenience and pricing, never exclusivity, and carries no fee.

Server-side counterpart (server repo, not this one): maker service (standing offers from
float, auto-accept bounded by risk caps) + taker service (bids on well-priced user offers),
both driven by the archived desk's quote engine and sizing policy.

## Desk transition - finish, archive, reuse (REVISION 1)

- The desk's F32 campaign RUNS TO COMPLETION first (remaining rungs need nothing from the
  client side) - the settled AVAX/LTC/ADA legs are the reference implementations and the
  learning bank for the harness fork phase.
- Then the desk is ARCHIVED, not deleted: the I2P RFQ transport and custom wire protocol
  retire; the quote engine, sizing/risk caps, float accounting, and engine chain-knowledge
  carry into the server's maker/taker bots. Wiki record required at archive time.
- Client-side consequence: the desk relay/driver/GUI-contract integration FREEZES at campaign
  end; open desk-owed items (e.g. the D116 wire change) get RE-TRIAGED against the archive
  decision before anyone builds them.

## Phase 0 - decision gates (before any code)

- [ ] Pick harness enum ids for ZEPH/AVAX/ADA: HIGH unassigned ints; record them in the
      harness README; re-check against upstream's enum on every merge (collision hazard).
      **NOTE (2026-08-15): the REU26 fork already used `ZEPH = 19`
      (`basicswap-zephyr/basicswap/chainparams.py:38`) - the NEXT SEQUENTIAL id after upstream's
      DOGE = 18, which is exactly the collision-risky choice. If upstream assigns 19, our ZEPH
      offers cross-parse as that coin on upgraded nodes. Decide before porting: renumber high,
      or accept and track upstream's enum every merge.**
- [ ] Harness repo location + license note (upstream MIT; harness stays MIT).
- [ ] Confirm sidecar footprint budget with operator (~9-11 GB: particld ~2.3 GB, LTC
      electrum mode, XMR via remote node, python runtime).
- [ ] Regulatory read - LOAD-BEARING, not a formality (sharpened 2026-08-14 after
      fact-checking an external analysis). The open venue removes the PLATFORM-OPERATOR
      theory (Samourai/Tornado Cash pattern: infrastructure + profit + knowledge), but it
      does NOT by itself exempt the maker: FinCEN's P2P-exchanger doctrine (FIN-2019-G001)
      treats anyone "engaged as a business" in exchanging CVC as a money transmitter
      REGARDLESS of custody or venue, and individuals trading on open platforms they did
      not operate have been penalized and convicted (Powers civil penalty 2019; Tetley and
      Goklu, LocalBitcoins, sec 1960). An automated, spread-earning, float-backed maker
      service fits the "business" triggers (holding out, systematic automation, spread
      revenue). The 2026 SEC covered-interface statement and CFTC Phantom no-action help
      the WALLET-AS-INTERFACE position only - neither touches FinCEN/BSA money
      transmission. Options to evaluate with counsel BEFORE mainnet bots: registered-MSB
      entity for the bot service, jurisdictional structuring, or design changes counsel
      signs off on. Assisted orders tuned to settle mostly against our own bots strengthen
      an "economic reality" argument - the openness invariant helps and does not decide it.

## Phase 1 - vanilla sidecar, zero fork (mainstream book access)

Client-side:
- [ ] Opt-in "P2P swaps" wizard (pure-wallet pattern: nothing downloads or runs until the
      user clicks): fetch PINNED upstream basicswap release + particld, generate configs
      (LTC electrum mode, XMR remote node from the wallet's existing node list).
- [ ] Sidecar lifecycle in Rust (spawn/monitor/stop `basicswap-run`), same shape as the
      XMR/ZPH wallet-rpc sidecars; port + auth handling for the local JSON API.
- [ ] Router entry `'basicswap'` + TAKE flow: browse local book (`/json/offers`), bid,
      track swap states; surface the state machine honestly (30-90 min settles, refund
      states). MAKE flow: post offer form (pair, amount, rate, min_bid_amount) + revoke.
- [ ] Desktop only; excluded from Lite by construction (BOUNDARIES.md note).
- Verification: an LTC<>XMR swap SETTLES against a mainstream counterparty from inside the
  wallet on default settings; a user-made offer is visible on an independent vanilla node.

Liquidity (OPERATOR-PERSONAL, out of company scope per Revision 2):
- Any maker node the operator runs is separate from this plan and from company revenue. The
  client gives it no preference and no fee sharing; it appears in the book like any other
  maker. Its compliance posture is the operator's, tracked outside this repo.
- What the CLIENT still verifies: that a wallet user can take ANY maker's offer end to end,
  and that offers from affiliated liquidity are disclosed as such where surfaced.

## Phase 2 - the harness fork: AVAX + ZEPH, jumpstart on fork assets

Harness repo:
- [ ] Patch series over upstream tag: enum ids + chainparams blocks + capability-set
      membership for the new coins.
- [ ] AVAX: port REU26's proven EVM chain-A (`interface/evm.py`,
      `protocols/xmr_swap_evm.py`, `is_contract_chain()` seam, SwapCreator.sol) into the
      harness; pin the deployed contract addresses per network.
- [ ] ZEPH: **the interface LARGELY EXISTS** (found 2026-08-15) -
      `REU26/work/forks/basicswap-zephyr/basicswap/interface/zephyr.py` is a ~105-line
      `class ZEPHInterface(XMRInterface)` handling the balance-shape difference. Revises the
      earlier "large, known shape" estimate: the BasicSwap-side work is a port of an existing
      subclass, not a new chain-B integration. **The real blocker is Zephyr-side, not
      BasicSwap-side**: the hard-coded mainnet fork height (RQ2's AUDIT_FORK_HEIGHT, "Condition
      B - the real blocker" in `REU26/zephyr-testnet/ZEPH-SWAP-FRONTIER-PLAN.md`), plus the
      absence of a public ZEPH testnet - regtest first, then mainnet-canary sized runs under
      desk OPS discipline.
- [ ] PARALLEL TRACK: upstream PR for the ZEPH interface (merged-PR precedent: the REU26
      BCH fix). If merged, ZEPH leaves the patch series and the mainstream network
      carries ZEPH offers.
- [ ] Swap-test suite per coin (`tests/basicswap/extended/test_<coin>.py` shape) - the
      de-facto gate.

Client-side:
- [ ] Wizard offers the harness build (versioned artifact, hash-pinned) instead of
      vanilla when the user enables ZEPH/AVAX pairs; per-coin enablement toggles.

Liquidity (operator-personal, out of company scope):
- Fork-book pairs need a maker to be usable at launch. Whoever provides it, the client
  treats it as an ordinary maker. OPEN QUESTION for the operator: ZEPH liquidity has no
  other source today - upstreaming the ZEPH interface (above) is the cheap first move,
  but third-party makers may not materialise for a coin this small.
- Verification: a wallet user TAKES a fork-book offer to settlement; a wallet user MAKES a
  fork-book offer another wallet user takes.

## Phase 3 - ADA (when volume justifies)

- [ ] New chain-A interface for eUTXO from REU26's contract-free Cardano PoC (the desk's
      ada-xmr engine is the reference); lock-construction replacement per the BCH
      precedent. Largest genuinely-new item; gate on Phase 2 demand evidence.

## Upstream sync protocol (the "versioned harness" discipline, every release)

1. Rebase the patch series onto the new tag; keep the series MINIMAL.
2. Hand-verify wire compatibility (SMSG has NO version negotiation): protobuf schemas
   unchanged for existing types; `MINPROTO_*` floors; `Coins` enum diff vs our squatted
   ids (collision = renumber ours BEFORE shipping).
3. Run the swap-test suite (all enabled coins) + a live regtest settle.
4. Ship as a new pinned sidecar artifact; wallet updates the pin, never auto-tracks.

## Hard rules carried in

- No wrapper fees anywhere - revenue is the desk's maker spread only.
- No default installs - sidecar is opt-in, wizard-gated, desktop-only.
- Desk maker mode obeys the desk's existing risk caps and float accounting; mainnet
  liquidity gated on the estate's OPS-01 analog for this surface.
- Offered pairs follow the protocol's capability-set matrix (documented once in the
  basicswap-backend reference page).

## Future optimization, recorded not scheduled (2026-08-14)

Batched settlement for the server bots, per the estate analysis (server vault:
analyses/batched-settlement-in-atomic-swaps): chain-B lock funding and post-settlement sweep
consolidation batch cleanly at maker scale (pool-payout economics; batching follows
authorship); EVM multicall with owner-semantics care; chain-A script-lock batching is
protocol-hostile (pre-signed refunds) and is ruled out. Deepest form: the pool payout funding
swap locks directly (REU26 sec 10.1). Not worth protocol risk before the bots have volume;
two verify-before-build items are marked in the analysis.

## Out of scope

SOL atomic swaps (NEAR Intents covers SOL); mobile/Lite; any change to existing message
protobufs or validation for standard pairs (breaks mainstream interop); running the
sidecar on the pool host for USERS (the desk maker node is the server-side component).

## Open questions for the operator

1. Where does the harness repo live (new repo vs SwapDesk subtree), and who cuts artifacts?
2. Archive timing: which F32 rungs constitute "testing finished" for the desk (the full 9, or
   the AVAX abort rungs + clean run), and does the desk float move to the bots at that point?
3. Mainnet timing for the server's maker/taker bots (the OPS-01 analog for this surface).
4. Assisted-make defaults: price band, TTL, repricing cadence.
