# upstream/patches/ — the BasicSwap engine patch series

> **Applying them is not optional bookkeeping, and it is not automatic.** Run
> `node scripts/apply-engine-patches.mjs --check` against any runtime you are
> about to trust. On 2026-08-25 that check found PWNDA-PATCH-9 — written,
> reviewed, committed and documented three days earlier — **absent from the
> running mainnet node**, so the fund-stranding bug it fixes had never
> actually stopped happening. Drop the `--check` to apply, then RESTART the
> node. The applier is idempotent and refuses ambiguous context rather than
> guessing; see its header for why fuzzy patching is banned here.

Nineteen patches, in five groups.

**1–2 are platform fixes.** Both make the pinned engine run natively on Windows; neither
changes swap protocol, wire format, or consensus behaviour, and both are no-ops on POSIX.

**3–8 are the convergence patches** ([[pwnda-basicswap-convergence-plan]] §§ C8–C9). They
make the swap node trade from the wallet the user already has, rather than from a second
one that must be funded: 3–4 do it for electrum-mode ("lean") BTC and LTC by sharing the
account key, 6 completes 3–4 for legacy (P2PKH) wallets by teaching the electrum signer
their sighash, 7 makes that funding path itself protocol-safe and fund-correct, and 5+8
together do it for Monero by letting the engine's *main* wallet live on the host's own
`monero-wallet-rpc` — 5 is the transport (a second wallet-rpc client, disjoint from the
per-swap one), 8 is what makes the engine ACCEPT that wallet's identity and stop assuming
it's the only thing that can move it. Unlike 1–2 these are policy, not portability — they
exist because an embedding host answers "whose wallet is this" differently than a standalone
node does, which is also why none of the six is an upstream-PR candidate.

**10–12 are the stuck-swap and uncounted-funds trio**, all from the 2026-08-23
mainnet incident. 10 stops a completed swap from presenting as a failed one (a
duplicate broadcast of an already-mined redeem was read as fatal); 11 gives an
embedding host a narrow, gated way to restart a bid the engine parked in
`BID_ERROR`, which is otherwise terminal; 12 exposes `importAddress` so a host
can repair address bookkeeping the engine's own 20-address rescan cannot
reach. 10 is an upstream-PR candidate on its own merits.

**9 is a correctness fix in upstream's own change-address allocator**, and unlike 3–8 it is
not embedder policy — it is a bug any BasicSwap user with an electrum-mode BTC/LTC wallet can
hit, so it IS an upstream-PR candidate. `getNewInternalAddress` took `MAX(derivation_index) + 1`
where the neighbouring `getNewAddress` correctly calls `_findReusableAddress`; with an unused
lookahead pool of 20 that put real change at internal index 20, one past BIP-44's standard gap
limit, so a stock restore of the same seed reports zero over on-chain funds.

**13–17 are the CryptoNote-follower patches (ZEPH, ZANO): embedder policy** — upstream
declined ZEPH on chain health (#531) and ZANO needs a Zano-side wallet change first; neither
is a PR candidate. **18 is a PR candidate** (BCH electrum-mode support); **19 is embedder
policy** (Grove's account-key wallet sharing). See
[[grove-expansion-master-plan]] for the design these seven implement, and each patch's own
header for its per-file rationale and gate.

The pinned clone at `upstream/basicswap/` stays **read-only** — see `upstream/README.md`.
This directory is how an edit to it is expressed instead: a tracked, re-appliable series
against the pinned tag, so "what did we change" is a diff and not archaeology inside a
gitignored workspace.

| # | file | fixes / adds | source marker | upstream PR |
|---|---|---|---|---|
| 1 | `0001-guard-sighup-on-windows.patch` | node exits immediately after starting its daemons, on nt | `PWNDA-PATCH-1` | candidate — **operator elected to submit** |
| 2 | `0002-configurable-pid-wait.patch` | spurious "failed to get daemon pid" under multi-daemon startup | `PWNDA-PATCH-2` | candidate — not submitted |
| 3 | `0003-account-key-electrum-wallet.patch` | initialise a lean wallet from a host-supplied **account key**, at the host's **address type** (`p2wpkh` default / `p2pkh`) | `PWNDA-PATCH-3` | no — embedder policy |
| 4 | `0004-account-key-push-endpoint.patch` | transport for 3: an authenticated key-push endpoint (carries the address type) | `PWNDA-PATCH-4` | no — embedder policy |
| 5 | `0005-xmr-split-wallet-rpc-clients.patch` | main Monero wallet can live on the **host's** wallet-rpc | `PWNDA-PATCH-5` | no — embedder policy |
| 6 | `0006-legacy-p2pkh-wallet-signing.patch` | the electrum wallet can **spend** legacy P2PKH inputs | `PWNDA-PATCH-6` | no — embedder policy |
| 7 | `0007-electrum-funding-safety.patch` | chain-A swap-lock funding refuses malleable inputs; change-output and fee-sizing fixes for legacy wallets | `PWNDA-PATCH-7` | no — embedder policy |
| 8 | `0008-xmr-host-wallet-checks.patch` | the engine **accepts** a host-managed Monero main wallet's identity, and refuses to send from a wallet that drifted underneath it | `PWNDA-PATCH-8` | no — embedder policy |
| 9 | `0009-change-address-first-unused.patch` | change address is allocated at the **lowest unused** internal index instead of `MAX+1`, which stranded funds past the standard gap limit | `PWNDA-PATCH-9` | **candidate — upstream bug, not policy** |
| 10 | `0010-redeem-duplicate-broadcast-tolerance.patch` | an already-mined coin-A redeem is recorded as success instead of parking the bid in `BID_ERROR` | `PWNDA-PATCH-10` | **candidate — upstream bug, not policy** |
| 11 | `0011-recover-stalled-bid-endpoint.patch` | a gated `pwndarecover` that re-queues the engine's own next step for a bid stuck in `BID_ERROR` | `PWNDA-PATCH-11` | no — embedder policy |
| 12 | `0012-import-account-address-endpoint.patch` | `pwndaimportaddress` — teach the engine about an address of its own account that its bookkeeping missed | `PWNDA-PATCH-12` | no — host-repair surface |
| 13 | `0013-zephyr-coin-module.patch` | new `interface/zephyr/` coin module (`chainparams`/`core`/`zephyr`, modelled on `wow`/`xmr`, re-ported from REU26's proven #531 interface) — new files only, no shared-file edits | `PWNDA-PATCH-13` | no — upstream declined the coin (chain-health grounds, #531) |
| 14 | `0014-zephyr-registration.patch` | registers `Coins.ZEPH` (id 19) into `chainparams.py`, `basicswap.py` (factory + poll thread), `bin/prepare.py`, `bin/run.py`, `ui/page_settings.py` | `PWNDA-PATCH-14` | no — embedder policy |
| 15 | `0015-zano-coin-module.patch` | new `interface/zano/` coin module (`ZanoInterface`, a JWT wallet-rpc client, `_external_main_wallet`), re-ported from REU26's 1,340-line interface — new files only | `PWNDA-PATCH-15` | no — Zano-side wallet change (`generate_from_keys`) needed first |
| 16 | `0016-zano-registration.patch` | registers `Coins.ZANO` (id 16, upstream's own reserved-but-commented slot) into `chainparams.py`, `basicswap.py` (factory, poll thread, scratch/JWT allowlist copies, `getTotalBalance`'s `getbalance` branch), `bin/prepare.py` — serialised by B-INT against the tree with 14 already applied (both patches edit the same `Coins` enum / `scriptless_coins` / `xmr_based_coins` region; merged, not chosen between) | `PWNDA-PATCH-16` | no — embedder policy |
| 17 | `0017-cn-follower-host-wallet-guards.patch` | wrong-wallet assertion for `ZanoInterface.publishBLockTx`, PATCH-8-shaped (ZEPH needs none — `ZEPHInterface` inherits `XMRInterface`, already covered by patch 8) | `PWNDA-PATCH-17` | no — embedder policy |
| 18 | `0018-bch-electrum-core.patch` | BCH light/electrum mode: `bch.py` overrides (FORKID signer, `fundSCLockTx`, `getDestForAddress`, and the eight electrum branches the feasibility query named), `wallet_manager.py` cashaddr `_deriveAddress` branch, `electrumx.py` server list + `scripthash_from_address` fix, `bin/prepare.py` `--bch-mode` wiring | `PWNDA-PATCH-18` | **candidate — upstream feature, not policy** (§ 6, staged for export) |
| 19 | `0019-bch-account-key-glue.patch` | Grove-only glue: three load-bearing comments in `wallet_manager.py` documenting the branch-order invariant that already routes a pushed BCH account key through 18's cashaddr path with zero functional change needed | `PWNDA-PATCH-19` | no — embedder policy |
| 20 | `0020-cn-follower-registration-completion.patch` | completes the ZEPH/ZANO registration: the half-wired paired sites (`prepare.py` conf branches, `run.py` daemon refusal for host-managed coins, settings-template gates) | `PWNDA-PATCH-20` | no — embedder policy |
| 21 | `0021-bch-electrum-server-selection.patch` | `ElectrumBackend` selects BitcoinCash servers for BCH (was falling through to Bitcoin's), configurable via `electrum_clearnet_servers` | `PWNDA-PATCH-21` | **candidate — upstream feature, not policy** |
| 22 | `0022-ads-scriptless-balance-verification.patch` | the ADS test helpers check the SCRIPTLESS coin's balance — TEST files only, **exempt from the engine level** (the wheel ships no tests) | `PWNDA-PATCH-22` | candidate — test fix |
| 23 | `0023-bch-electrum-live-defects.patch` | BCH's overridden methods gain their electrum branches; swap locks are watched at the P2SH scripthash (fund-affecting, found on mainnet) | `PWNDA-PATCH-23` | **candidate — upstream feature fix** |
| 24 | `0024-bch-walletmanager-scripthash.patch` | `WalletManager` computes a cashaddr scripthash, so a user's own BCH address is watched at all | `PWNDA-PATCH-24` | **candidate — upstream feature fix** |
| 25 | `0025-host-wallet-prepare-and-auth-failfast.patch` | prepare writes but does not initialise a **host-managed** wallet coin (`CoinPrepareModule.host_managed_wallet`: ZEPH, ZANO); `waitForDaemonRPC` stops retrying a credential rejection — the ten-minute `--addcoin=zano` stall (2026-09-04) | `PWNDA-PATCH-25` | no — embedder policy (the fail-fast hunk alone is a candidate) |
| 26 | `0026-cn-console-ui-registration.patch` | ZEPH and ZANO registered across the console UI beside Wownero: settings page + template gates (zano), offers page (ZEPH), and the JS coin registries (`coin-manager`, `cache-manager`, `notification-manager`, `amm-tables`, `bid-page`, `price-manager`, `api-manager`, `config-manager`, `offers-pricechart`). Binary icons ride in `upstream/patches/assets/` and are copied by the applier | `PWNDA-PATCH-26` | no — upstream declined ZEPH; ZANO pending its wallet change — a Jinja comment inside the `coin_data` set-tag broke every console page on first deploy (2026-09-04); `scripts/swap/verify-console-templates.py` compiles all templates and is part of the re-verify list |
| 27 | `0027-settle-redeemed-bid-error.patch` | `pwndaRecoverStalledBid` settles a `BID_ERROR` bid whose chain-A redeem is already confirmed (≥ 1 confirmation via the electrum backend or the node/wallet RPC): `SCRIPT_TX_REDEEMED` → `SWAP_COMPLETED` for the redeeming side, deactivated, `settled: true` in the reply. The 2026-08-23 mainnet bid sat "in progress" for twelve days because PATCH-11 could only re-queue a redeem the chain had already accepted. Called by the supervisor's bid janitor | `PWNDA-PATCH-27` | no — upstream's exit is `manualBidUpdate` (arbitrary state); this takes none |
| 28 | `0028-zephyr-coingecko-id.patch` | `getExchangeName` returns `zephyr-protocol` for ZEPH instead of its chain name `zephyr`, which is a DIFFERENT CoinGecko asset trading at ~4% of ZEPH's price — 67.27 ZEPH read $1.19 in the console against the wallet's $27.08. Same shape as the BCH and FIRO exceptions already in that function. `lookupFiatRates` also feeds the offer book's rate columns and the AMM page | `PWNDA-PATCH-28` | yes, if Zephyr lands upstream — a one-line id correction of a shape already present twice |

Applies to: **basicswap `v0.18.6`** (`ea39faddbcaffd51a34d6bbd72fb9607654227f5`).
Rebased from `v0.17.9` on 2026-08-26 — only **0006** needed a change, and only its
first hunk's context (upstream reshaped the `basicswap_util` import into a
parenthesized multi-import). 1–12 verified by `git apply` AND by
`scripts/apply-engine-patches.mjs`, then by all three invariant suites. 13–19 (added
2026-09-03, Grove expansion Phase B) are verified by `scripts/apply-engine-patches.mjs`
only — 13, 15, and (per PWNDA-PATCH-13's own patch header) any other pure-new-file entry
in this range pad their created files with one trailing empty `+` line to make the JS
applier's file-write path byte-exact, which is NOT `git apply`-safe (git's own parser
would insert a literal blank line into the created file); a `git apply --check` dry run
against 13/15 will therefore report a false mismatch on the file's last line. This is a
known, deliberate divergence from 1–12's dual-verified convention, not a defect — see
0013's own header and `PwndaWalletVault/log.md` (unit B-Z1, 2026-09-03).

Patch 7 depends on 3, 4, and 6 having already been applied — it edits code those patches
introduced or that sits immediately next to it. Apply the series in numeric order.

Patch 9 is independent of 3–8 (it edits a function upstream already ships) but is numbered last
so the series stays append-only.

Patches 13–19 must apply in numeric order: 14 needs 13's new files to exist; 16 needs 15's;
17 edits a file only 15 creates; 16 and 14 both edit `chainparams.py`'s `Coins` enum and its
`scriptless_coins`/`xmr_based_coins` tuples, so 16 is only correct when serialised AFTER 14
(as numbered) — applying 16 alone against a tree that skipped 14 will fail with a context-not-
found refusal, which is the applier doing its job, not a bug in either patch. 18 and 19 are
independent of 13–17 (disjoint files) but 19 depends on 3 and 18 both being present.

---

## 0001 — guard the SIGHUP registration on Windows

`basicswap/bin/run.py`, one hunk, +5/-1.

`signal.SIGHUP` does not exist on Windows. `signal.signal(signal.SIGHUP, signal_handler)`
therefore raises `AttributeError` — and the call site sits inside `runClient()`'s broad
`except Exception` startup path, so the exception is **swallowed**. The node exits
immediately *after* its coin daemons have already been spawned, leaving orphaned
`particld` / `litecoind` / `monerod` processes with no parent to reap them.

The failure mode is what makes this expensive to find rather than the bug itself: there is
no traceback, the daemons are running and healthy, and the observable symptom is only that
the BasicSwap process is gone. Anything that looks for a crash finds nothing.

The fix gates the registration on `os.name != "nt"`. `SIGINT` and `SIGTERM` both exist on
Windows and stay unconditional, so Ctrl-C and terminate handling are unchanged.

**Why a PR candidate:** on every POSIX platform the patched code is byte-equivalent in
behaviour, and on nt it converts a hard startup failure into a working node. There is no
configuration or policy question attached to it — which is exactly why this is the one the
operator elected to submit.

## 0002 — make the per-coin pid wait configurable

`basicswap/basicswap.py`, one hunk, +5/-1.

After starting a coin daemon, `initialiseDaemon()` polls for the daemon's pid file 20 times
at 0.5 s intervals — a hard **10 second** budget — then raises. The pid is read so the
auth cookie is known to belong to the right process, so the wait is load-bearing and cannot
simply be dropped.

On Windows, with three daemons coming up concurrently against an on-access AV scanner and a
cold page cache, the pid file routinely lands later than 10 s. The run aborts with a
"failed to get daemon pid" style error while every daemon is in fact healthy and finishes
starting seconds afterwards. It is a timeout misreported as a failure.

The fix reads the iteration count from `BSX_PID_WAIT_ITERS`, defaulting to the existing
literal `20`. With the variable unset the behaviour is byte-for-byte upstream's. Our
supervisor sets `BSX_PID_WAIT_ITERS=40` (20 s) or higher when several daemons start at once.

**Why an env var and not a bigger constant.** The right budget is a property of the *host* —
disk speed, AV, how many daemons start together — not of the software. Raising the upstream
default would slow the failure path down for everyone who does not have the problem, and
would still be wrong for a slower box. Deliberately not a new upstream default; that is also
why it is the weaker PR candidate of the two.

## 0003 — initialise an electrum-mode wallet from a host-supplied account key

`basicswap/wallet_manager.py` (+44, additive) and `basicswap/basicswap.py` (+29/-2).

In electrum mode the engine **holds the wallet itself**: `WalletManager` derives BIP84
keys, signs, and tracks UTXOs in the engine's own database, with public ElectrumX servers
supplying only chain data. That wallet's identity is decided entirely by the root key
handed to `WalletManager.initialize()` — today always the engine's own
(`getWalletKey(coin_type, 1)`). For a wallet application embedding the engine, that means
two wallets on one recovery phrase, and only what the user *sends to the second one* is
tradeable. The funding hop costs an on-chain fee and splits custody, which is exactly what
`importdescriptors` removes for core-mode coins. Electrum mode has no daemon wallet to
import into, so the equivalent has to happen at the key layer.

`initializeFromAccountKey()` takes the **account node** — `m/84'/<coin>'/0'`, serialised as
the 74-byte `ExtKeyPair` encoding upstream's own `decode()` already reads — and derives the
two chain branches beneath it, instead of taking a master seed and deriving the account
itself. For the same account the keys are byte-identical to `initialize()`'s; this adds a
way in, not a second derivation scheme. `initialize()` is untouched.

`initializeWalletManager()` then prefers a pushed key when present, and otherwise takes
upstream's path unchanged **except** when `BSX_PWNDA_ACCOUNT_KEY_COINS` names the coin. Then
the host has declared it owns those keys, and initialising from the engine's seed would
hand back a *different* wallet while reporting it as the user's — so that case fails closed
and returns `False`, and the caller retries after the push.

Account level rather than master, deliberately: the key exposes one coin's branch and
nothing else on the phrase.

**Revised 2026-08-21 — address types.** The original patch hardwired bech32 P2WPKH, which
silently mis-serves any wallet imported on a legacy derivation (Exodus-style m/44'):
the engine would derive *addresses the user has never seen* and — worse — subscribe to
scripthashes of P2WPKH scripts the funds are not on, reporting zero over real money.
`initializeFromAccountKey()` now takes an `address_type` (`"p2wpkh"` default = the
original behaviour byte-for-byte, or `"p2pkh"`), validated — an unknown type raises
rather than guesses. For `p2pkh` it derives base58check with the coin's version byte
(`PUBKEY_ADDRESS_BYTE`) and hashes the actual `76a914…88ac` locking script for the
electrum scripthash; the rest of the electrum layer needed nothing, because
`scripthash_from_address` was already type-agnostic. A type *change* on re-push triggers
the same foreign-table discard as a key change — the stored rows describe a wallet that
no longer exists. BIP-49 wrapped SegWit is deliberately **not** offered: the signer has
no P2SH redeem path, and accepting the type would strand funds behind an unspendable
wallet.

## 0004 — accept an account key over the authenticated JSON API

`basicswap/js_server.py`, two hunks (+70). Transport for 0003: one account key per lean
coin, held in memory for the life of the process, registered as `pwndasetaccountkey`.

**Why a runtime endpoint rather than an environment variable at spawn** — the obvious
cheaper design, and it does not work. The key cannot exist before the host's vault is
unlocked, and the node must already be running by then: coin daemons sync while the vault
is still locked, and particl's initial sync is the long pole for the whole node (hours).
Deferring the start until unlock would stall it. The engine reaches its wallets lazily and
offers no other way to learn a key after start.

**Memory only.** Never written to the datadir or the database, so a restart loses it. That
is deliberate — the host re-pushes on every start, and 0003 fails closed rather than
silently reverting to engine-derived keys.

The response carries the resulting deposit address so the caller can assert the engine
derived the wallet it believes it pushed. A silent divergence there is the one failure this
mechanism must not have, and the push is the cheapest place to catch it. Pushing while
locked stores the key and reports `initialized: false` rather than erroring, so ordering
between unlock and push does not matter to the caller.

Custody is the engine's existing model — client auth, loopback — plus the supervisor's
denied-endpoint list, so the embedded console's proxy cannot reach it.

## 0005 — split the Monero wallet-rpc clients

`basicswap/interface/xmr/xmr.py`, seven hunks (+109/-8).

The XMR interface multiplexes **one** `monero-wallet-rpc` between the main wallet and each
swap's 2-of-2 b-lock wallet, serialised behind `_mx_wallet`. Sound while the engine owns
that process; unsound the moment anything else does. `monero-wallet-rpc` serves one open
wallet at a time, so an outside client issuing `transfer` during the window a swap wallet
is open would spend from the **swap's** wallet. Upstream ships defensive
wrong-wallet-open checks in `findTxB` and `spendBLockTx` for exactly this reason.

So a host that already runs the user's Monero wallet cannot share this client. It can
share a *dedicated* one, and that is the patch: a second wallet-rpc client selected per
operation by **which wallet file the operation opens** — main wallet to
`mainwalletrpc{host,port,auth}` (the host's process, which only ever holds the user's
wallet open), every per-swap wallet to the existing client (the engine's own process, keys
derived per swap, no overlap with the user's key set). Two processes, disjoint wallet
files, no multiplexing across the boundary. That is what makes it safe rather than merely
convenient, and it preserves the standing rule that two wallet-rpc processes never share
one wallet *file*.

The routing rule is upstream's own structure rather than a new convention: every
main-wallet operation opens `self._wallet_filename` first and every per-swap operation
opens a wallet named for the swap's shared address, so the filename **is** the decision.
All ~40 call sites keep their exact shape; `rpc_wallet` becomes a dispatching method in
place of the attribute it was.

Three consequences are handled explicitly rather than left to luck:

- `openWallet` never issues `open_wallet`/`close_wallet` for a host-managed main wallet —
  it confirms the address and caches it. The confirmation is deliberately not skippable:
  it is what turns a misconfigured port into a loud failure instead of silent operation on
  a stranger's wallet.
- `createWallet` and `changeWalletPassword` refuse on a host-managed main wallet. Neither
  is the engine's to do, and the second would lock the host out of its own wallet.
- `testDaemonRPC` and `getDaemonVersion` touch no wallet and would otherwise inherit
  whichever client the previous operation left selected. They pin to the main client,
  which also makes the health check exercise the connection a user is most likely to have
  broken.

With `mainwalletrpcport` absent, both names bind to the same client and every path is
byte-for-byte upstream's — a no-op for existing deployments and for the WOW interface that
subclasses this one.

The supervisor refuses to write `mainwalletrpc*` into `basicswap.json` unless this marker
is present (`swap_sidecar::apply_host_xmr_wallet_to_config`). Without the patch those keys
are simply unread, and the caller would believe the wallets were shared while the engine
quietly ran its own — with the user's XMR where no swap can reach it.

## 0006 — sign legacy P2PKH inputs in the electrum wallet

`basicswap/interface/btc/btc.py`, two hunks (+58). Completes the revised 0003: with the
engine able to *derive and watch* a P2PKH wallet, receiving works — but
`_signTxWithWalletElectrum` produced only BIP-143 witness signatures, and a witness
signature over a P2PKH prevout is simply invalid. Every spend from a legacy wallet —
withdrawal or swap funding — would die at broadcast. Fail-safe, but fatal to the point
of serving the wallet at all.

`signTxLegacy()` computes the original-sighash digest via upstream's own
`LegacySignatureHash` and grinds for low-R exactly as `signTx` does, so signature shape
matches the rest of the engine's output. The wallet signer then branches **per input**,
on the address reconstructed from the prevout's actual scriptPubKey — not on the
wallet's configured type, because a mixed transaction is legal and each input must get
the sighash its own prevout demands. Bech32 inputs keep the existing witness path
untouched; legacy inputs get scriptSig `<sig> <pubkey>` and an **empty** witness entry,
which keeps the witness array aligned with the input array in mixed transactions.

**Known limitation, deliberate:** fee estimation stays segwit-sized. Legacy inputs are
~2.2× the vbytes, so a legacy-heavy transaction underpays its intended rate — noise at
LTC fee levels, worth revisiting before a Bitcoin legacy wallet leans on this path. The
patch header records this so the limitation cannot be rediscovered as a bug.

## 0007 — chain-A swap-lock funding refuses malleable inputs; fee and change fixes

`basicswap/interface/btc/btc.py` (+94/-28), `basicswap/interface/electrumx.py` (+9/-1),
`basicswap/basicswap.py` (+14/-8).

Built the same day as 6, in response to the operator asking for the legacy-wallet work to
be independently checked for safety against the atomic-swap protocol literature (a
separate research vault at `G:\REU26`, not part of this repository). The audit's central
finding: BasicSwap pre-signs the chain-A lock's refund transaction against the **lock
tx's own predicted, pre-broadcast txid** —

```python
tx_lock.rehash()
tx_lock_id_int = tx_lock.sha256
```

— computed from the *unsigned* funded tx, before either party has broadcast anything. A
segwit input's signature lives in the witness, outside that hash; a legacy P2PKH input's
lives in `scriptSig`, inside it. Signing a legacy input can therefore move the txid the
refund was already bound to. Upstream already fails closed for this
(`sendXmrBidCoinALockTx` raises `"Coin A lock tx txid changed after signing!"` if the
signed txid disagrees with the predicted one) — but only *after* the counterparty has
already exchanged refund signatures, and nothing anywhere filtered which UTXOs are
eligible to fund a lock tx to begin with (the core-RPC `fundTx` even carries upstream's
own unimplemented `# TODO: Manually select only segwit prevouts`).

`fundTx`/`_fundTxElectrum` gain `require_segwit_inputs` (default `False`, so ordinary
withdrawals via `_createRawFundedTransactionElectrum` are byte-for-byte unaffected);
`fundSCLockTx` sets it. A wallet whose adopted balance is entirely legacy now refuses to
fund a swap lock with a clear, early `ValueError` — before any message reaches a
counterparty — instead of silently building a lock tx that fails deep inside the swap
state machine. **This is a refusal, not a workaround**: it does not make swapping from
legacy-only funds possible, because the protocol requirement (a non-malleable lock txid)
is real. It only replaces an unsafe-or-late failure with a clean, immediate, honest one.

The same audit pass, tracing every electrum-mode script-type assumption in
`_fundTxElectrum`, found two more bugs already live for **ordinary sends**, not just
swaps, from the moment `address_type="p2pkh"` shipped in patch 3:

- The change output was built via `decodeAddress()` + `getScriptForPubkeyHash()`, which
  always emits a P2WPKH script regardless of the change address's real encoding. A
  p2pkh wallet's change would land on a script its own address table never derives or
  subscribes to — not lost (the key is known), but invisible to the wallet. Rebuilt on
  `getDestForAddress()`, already correct for every encoding this engine handles.
- Every selected input was priced as a flat 68 vB (P2WPKH-sized) regardless of type. A
  legacy P2PKH input is ~148 vB (no witness discount) — underpriced by more than half.
  Vsize is now computed per UTXO from its own address encoding, matching patch 6's
  actual per-input signing branch.

A fourth fix, unrelated to funding: `scripthash_from_address` (`electrumx.py`) checked
LTC's `script_address` byte but not `script_address2` — the newer P2SH version byte LTC
uses after deprecating the one it shares with Bitcoin. An `M…` address hashed as a bogus
P2WPKH script instead of erroring; not reachable through anything this repo builds today
(no P2SH-P2WPKH support yet), fixed while in the neighbourhood since it is the same
defect class as the change-output bug. A fifth, non-fund-affecting fix suppresses
`_computeElectrumLegacyFundsInfo`'s "legacy funds need consolidating" nudge for a coin
the host explicitly adopted as `p2pkh` — that balance is the wallet working as intended,
not a residue.

Verified with a real `LTCInterface` against a stub electrum backend — not a description
of the fix, the function under test:

```sh
<runtime>/python.exe -s -E scripts/swap/verify-account-key-patches.py
```

Sections 10–11 confirm: ordinary funding still succeeds with a genuinely P2PKH-shaped
change output; swap-lock funding on an all-legacy wallet refuses with the expected
message; a negative control (the same wallet, one genuine segwit UTXO added) succeeds and
draws *only* on that UTXO. Verified to fail as intended: disabling the guard
(`if False and require_segwit_inputs:`) turns exactly the refusal check red and nothing
else.

**What this does not do.** A wallet holding only legacy funds still cannot fund a swap
lock — that is the correct behaviour, not a remaining bug. Making it possible would need
the engine to hold a *second*, always-available segwit identity per coin alongside
whichever one the user is actively using, since it currently keys exactly one account per
coin type. That is future work; see
`PwndaWalletVault/wiki/queries/2026-08-21-multi-derivation-support.md`.

## 0008 — accept a host-managed Monero main wallet, and guard its one transfer

`basicswap/basicswap.py` (+42, two hunks) and `basicswap/interface/xmr/xmr.py` (+20).
Completes 5: pointing the engine's main wallet at the host's process (5) is only half the
job when two upstream checks still assume it is always the engine's own, and — found only
after 5 and this patch's first two fixes shipped and the operator hit a real restart —
one upstream allowlist that never learned the new keys exist at all.

**`setCoinConnectParams` — the allowlist that decides what `XMRInterface.__init__` ever
sees.** It builds `self.coin_clients[coin]` as an explicit, field-by-field copy from the
raw JSON config; "Passthrough settings" a few lines down only knows a fixed list of ~10
upstream key names. `mainwalletrpcport`/`mainwalletrpchost`/`mainwalletrpcauth` are not on
that list, so a byte-perfect `basicswap.json` on disk produced a `coin_clients[Coins.XMR]`
with none of the three keys — `_external_main_wallet` evaluated `False` for the life of the
process regardless of what the config file said. This shipped invisibly in this patch's
first version because every unit test drove `XMRInterface` directly with a hand-built
settings dict, never through `setCoinConnectParams` itself — the allowlist gap could not
have failed any check that never called the allowlisted function. Fixed: a new hunk, gated
on `"mainwalletrpcport" in chain_client_settings` (so it is a true no-op for every install
that has not opted into C9), copies the three keys through in the same
`elif coin in self.xmr_based_coins:` block as the existing `walletrpc*` copies just above
it. See `PwndaWalletVault/log.md`'s 2026-08-21 entry for the full incident — this was found
on the operator's own first live restart, not in any test run.

`checkWalletSeed` compares the live main-wallet address against a persisted KV,
`main_wallet_addr_<coin>`, that on an existing install holds the address of the ENGINE'S
OWN former wallet. Under C9 the addresses differ **by design** — that's the whole point —
so this check would fail, and `restrict_unknown_seed_wallets` defaults **true**, so
`checkCoinsReady` would then refuse every XMR swap with a message about seeds that never
names the real cause. Fixed: when the coin interface's `_external_main_wallet` flag is set
(5's own marker), the check refreshes the KV to the wallet's actual, host-owned address and
passes, rather than comparing against a KV this configuration was never meant to match.

`publishBLockTx` — the single fund-moving call the engine ever makes on the main wallet —
carried no wrong-wallet assertion before `transfer`. Its two siblings, `findTxB` and
`spendBLockTx`, got one in upstream commit `10ee0843` right after `740360dc` introduced the
address-confirm-and-cache fast path this one also depends on; the fund-moving call was
missed. Under upstream's single-process model that gap is nearly unreachable. Under C9 it
is live: patch 5 makes `openWallet()` *confirm* an external main wallet's address rather
than re-open it, while the host independently owns `open_wallet`/`close_wallet` on that
same process — confirm at T, host switches wallets at T+1, `transfer` at T+2 sends from the
wrong one. Fixed with the same assertion shape `findTxB`/`spendBLockTx` already carry,
immediately before the transfer.

All three guarded on the coin interface's `_external_main_wallet` flag (the allowlist fix
on its presence in the raw config, which is what sets that flag in the first place), so
every path is byte-for-byte upstream's when patch 5 is inert (no `mainwalletrpcport`
configured) — a no-op for every install that has not opted into C9.

Also fixed in the same incident, on the pwnda side and not part of this diff: the Rust
writer used to join the wallet-rpc auth into a single `"user:pass"` string;
`callrpc_xmr` (`rpc_xmr.py`) does `auth[0]`/`auth[1]`, which silently character-indexes a
string instead of raising. `apply_host_xmr_wallet_to_config`
(`src-tauri/src/swap_sidecar.rs`) now takes the username and password as two separate
parameters and writes `mainwalletrpcauth` as a real 2-element JSON array.

Verified against the real `BasicSwap.checkWalletSeed` and `setCoinConnectParams` (both
called unbound, against minimal duck-typed stand-ins — constructing a full `BasicSwap`
instance just to reach one method would be its own maintenance burden) and a real
`XMRInterface`:

```sh
<runtime>/python.exe -s -E scripts/swap/verify-xmr-wallet-split.py
```

Sections 6–7 confirm `publishBLockTx` refuses when the open wallet has drifted since
`openWallet()` confirmed it, and does not block when it still matches. Sections 9–10
confirm `checkWalletSeed` accepts a host-managed wallet and self-heals the stale KV, while
an un-shared coin still falls through to upstream's own comparison untouched. Sections
11–12 drive the real `setCoinConnectParams` against a raw, JSON-shaped settings dict and
confirm the three `mainwalletrpc*` keys actually reach `self.coin_clients[coin]` (11), and
that an un-shared config adds none of them at all (12) — the check the original version of
this patch did not have, and the gap that let the allowlist bug through undetected.
Sections 13–14 drive the real `callrpc_xmr` (stubbing only the socket layer beneath it,
`JsonrpcDigest.json_request`) against a real 2-element list auth and, as a same-run
negative control, a colon-joined string — proving the list indexes into the correct
username/password while the string would have silently character-indexed instead.

Verified to fail as intended: forcing the `publishBLockTx` guard's condition to `False`
turns the drift-refusal check red (a `ValueError` from un-guarded garbage-key crypto
instead of the expected `TemporaryError`); forcing `checkWalletSeed`'s new branch
unreachable crashes the suite outright with `AttributeError`, since control then falls
through to a comparison the test's stand-in deliberately does not implement; deleting the
`setCoinConnectParams` pass-through block in a throwaway copy turns exactly sections 11's
three checks red, while 9–10 stay green against that same copy — direct proof the
allowlist fix and the seed-check fix are independent and each new check targets the right
code. (That mutation test itself surfaced a fourth issue — see the "harness itself" note
below.)

---

## Applying the series

Against a fresh checkout of the pinned tag (never against `upstream/basicswap/` itself):

```sh
git clone https://github.com/basicswap/basicswap /path/to/work/basicswap
git -C /path/to/work/basicswap checkout v0.18.6
git -C /path/to/work/basicswap apply /path/to/repo/upstream/patches/0001-guard-sighup-on-windows.patch
git -C /path/to/work/basicswap apply /path/to/repo/upstream/patches/0002-configurable-pid-wait.patch
```

Dry run first — `--check` applies nothing and exits non-zero if the patch would not apply:

```sh
git -C /path/to/work/basicswap apply --check upstream/patches/0001-guard-sighup-on-windows.patch
```

The two patches touch different files, so they are order-independent, and either can be
applied alone.

To apply to an **already-installed** package instead of a source tree, run `git apply` with
the site-packages `basicswap` parent as the working directory — the paths inside the patches
are `basicswap/bin/run.py` and `basicswap/basicswap.py`, relative to the package's parent:

```sh
cd <runtime>/Lib/site-packages
git apply /path/to/repo/upstream/patches/0001-guard-sighup-on-windows.patch
```

To back a patch out, add `-R`.

### Verifying an applied series

Grep for the markers — each patch leaves at least one:

```sh
grep -rn "PWNDA-PATCH" <tree>/basicswap/
```

Hits in `bin/run.py` (1), `basicswap.py` (2, 3, 7, and 8), `wallet_manager.py` (3),
`js_server.py` (4), `interface/xmr/xmr.py` (5 and 8), `interface/btc/btc.py` (6 and 7) and
`interface/electrumx.py` (7) means the series is in. This is the cheap check the supervisor can run
on a runtime image it did not build.

**The cheap check is not sufficient for 3–8.** A marker proves the patch was
applied; it does not prove the patched engine still derives the user's wallet. Upstream can change
the purpose or account level, the address encoding, or renumber the chain branches, and
nothing throws — the engine keeps working while owning a wallet the user does not, and the
first symptom is funds arriving somewhere the wallet cannot see. Run the invariant suite:

```sh
<runtime>/python.exe -s -E scripts/swap/verify-account-key-patches.py
```

It asserts, using the engine's own crypto, that the lean derivation still reproduces the
published BIP-84 vectors (the same constants `src/wallets/derivation-paths.test.ts` pins
from the wallet side), that the account-key path is key-for-key identical to
`initialize()`'s for 50 addresses on both branches, and that `initialize()` itself is
unchanged. It carries negative controls, and it skips section 4 loudly on an unpatched
runtime rather than passing by doing nothing. Exit 1 means do not ship that image.
Sections 8–9 cover the legacy path: the P2PKH vector (`LUWPbpM…`, pinned by the
engine's crypto and independently by bitcoinjs), scripthash agreement with
`scripthash_from_address` for the same address (mutation-proven — hashing the segwit
script instead goes red), the encoding-change table discard, refusal of unknown types,
and a sign+verify round-trip through `LegacySignatureHash` with the derived key.

Verified to fail as intended: swapping the external and internal branches inside
`initializeFromAccountKey` — a mutation that leaves a working wallet, just not the user's —
turns both deposit-address checks red.

Patches 5 and 8 share a suite, for the properties a marker cannot express — *the engine
never opens or closes a wallet on the host's rpc*, and *it never sends from one that has
drifted underneath it*:

```sh
<runtime>/python.exe -s -E scripts/swap/verify-xmr-wallet-split.py
```

It constructs the real `XMRInterface` offline (`make_xmr_rpc_func` only builds a closure),
substitutes recording clients for both, and drives the actual open/create/probe paths, plus
`publishBLockTx`, the unbound `BasicSwap.checkWalletSeed`, `setCoinConnectParams`, and
`callrpc_xmr` for 8 (sections 6–14; see 0008's own section above for what those cover). It
also carries negative controls asserting both patches are inert without
`mainwalletrpcport`. Verified to fail as intended: disabling the host-wallet guard in
`openWallet` — so the engine falls through and opens the host's wallet, the precise unsafe
act — turns five checks red including "NO open_wallet/close_wallet on the host"; disabling
8's transfer guard or its `checkWalletSeed` branch turns sections 6 and 9 red respectively
(the latter as an uncaught `AttributeError`, not a soft failure); deleting
`setCoinConnectParams`'s pass-through block turns exactly section 11 red while 9–10 stay
green against the same copy (see 0008's own section above).

**The harness itself had the exact bug class it exists to catch.** Sections 9–10 (and,
until fixed in the same pass, the new 11–12) reached their subject via a plain
`import basicswap.basicswap as bsw_mod` — an ordinary import resolves against whatever
`basicswap` package is first on `sys.path`, not against `--package`'s directory, so the
script's own `bsw_has_patch8` marker check was reading the RIGHT file while every
assertion after it quietly ran against a DIFFERENT one. Invisible in the common no-flag
case (the ambient install and "the file the marker read" are the same file by
coincidence), and it very nearly hid a real mutation test's result: a throwaway copy with
the fix deleted still reported section 11 as PASS, because the copy was never actually
being tested. Fixed by loading `bsw_mod` (and the new `rpc_xmr_mod`) via
`importlib.util.spec_from_file_location(..., bsw_path)` — the same technique `xmr.py`
already used, just never extended to the other two modules. See
`PwndaWalletVault/log.md`'s 2026-08-21 entry.

Both suites skip loudly on an unpatched engine rather than passing by doing nothing.

---

## Gotchas that cost time here

**Line endings.** The patches are LF, matching the git blob content. On Windows, Git for
Windows ships `core.autocrlf=true` in its *system* config (`C:/Program Files/Git/etc/gitconfig`)
— not local, not global, so `git config --local core.autocrlf` and `--global` both print
nothing while the working tree is still CRLF. `git apply` honours that setting and converts
the patch text on the fly, so an LF patch applies cleanly to a CRLF working tree and writes
CRLF back out. Verified both ways: applied against an LF materialisation of `v0.17.9` and
against a CRLF one byte-identical to the pinned clone's working tree.

Consequence: after applying on Windows, a `cmp` against an LF reference copy will differ at
byte 23 of line 1 and mean nothing. Compare with `diff --strip-trailing-cr`.

**File mode.** `basicswap/bin/run.py` is `100755` in the pinned tree, and patch 0001's index
line says so. On a Windows checkout (`core.filemode=false`) the file materialises as `100644`
and `git apply` prints:

```
warning: basicswap/bin/run.py has type 100644, expected 100755
```

That warning is expected on Windows and harmless — the patch still applies, exit code 0. The
index line is kept truthful to the pinned tree so applying on Linux does not silently drop
the executable bit.

**Do not regenerate these by diffing the pinned clone's working tree.** It is CRLF, so a
naive `diff -u` reports every line of a 17 000-line file as changed and buries the one real
hunk. Materialise the tag with `git archive` (or diff with `--strip-trailing-cr`) first.

---

## Relationship to the wheel

`scripts/fetch-swap-runtime.mjs` stages a `basicswap` wheel built from the **unpatched**
pinned tag. The series is therefore applied either to the source tree before building that
wheel, or to the installed package afterwards — it is not baked into the pinned artifact
hash. The fetch script's manifest repeats this under its `enginePatches` key so a consumer
of the staged inputs cannot miss it.

## When the pin moves

Start with the framework's check script — it dry-runs the whole series **sequentially**
against the candidate tag (independent per-patch `--check` against a pristine tree can
pass a series that does not apply, since later patches edit code earlier ones introduce)
alongside every contract probe, and points at the runbook
(`PwndaWalletVault/wiki/synthesis/basicswap-upstream-sync.md`):

```sh
node scripts/check-basicswap-upstream.mjs
```

If a patch stops applying, upstream touched the same region — read the diff there before
rebasing the patch, because "it stopped applying" and "it stopped being necessary" look
identical from here, and only one of them means deleting the patch.

Then — for 3 and 4, and this is the part a clean `--check` does **not** cover — rebuild the
runtime and run `scripts/swap/verify-account-key-patches.py` against it. A patch can rebase
perfectly onto code whose behaviour moved underneath it. The measured churn says to expect
this: over v0.15.3 → v0.17.9 (551 commits, 17 releases, five months) `basicswap.py` was
touched in 15 of 17 releases while the three functions these patches sit in changed 1, 0
and 4 times. The merge is usually free; the *behaviour* is what needs re-proving, and the
electrum subsystem (`wallet_manager.py`, `wallet_backend.py`, `interface/electrumx.py`, all
first committed 2026-01-28) is upstream's newest and least settled area. See
[[2026-08-20-lean-zero-move-feasibility]] for the full churn table.
