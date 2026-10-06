# upstream/ — pinned BasicSwap reference clones

Local reference copies of the upstream repos the BasicSwap sidecar consumes. **Read-only by
convention: never edit these trees.** Our additions attach on the wallet side of the seam
(`CLIENT-PLAN-SIDECAR-EXECUTION.md` § keep the seam clean); if a patch inside `basicswap/`
ever becomes unavoidable it lives in the future harness repo as a patch series, never here.

The clones are full git repos and are **gitignored** (only this README is tracked). They
re-fetch deterministically from the pin table below on any machine.

## The pin (Phase-0 "pin an upstream release tag" — recorded 2026-08-15)

> ## v0.19.0 + p37 — STAGED, not deployed (2026-10-06)
>
> `pwnda-grove 0.19.0+p37`, staged on both platforms from copies of the deployed
> runtimes: `.swap-sidecar-work/bump-v0.19.0/runtime` (Windows) and
> `.swap-sidecar-work/bump-v0.19.0/linux-runtime` (Linux, copied with `cp -a` inside WSL).
> Both `apply-engine-patches --check`: stamp agrees; the two engine trees are identical.
> **The pinned clone was NOT moved** (a release was mid-flight): it still sits at
> v0.18.9, so `check-basicswap-upstream.mjs` on this pin reports a HEAD mismatch until
> `git -C upstream/basicswap checkout v0.19.0` is run as part of the deploy.
> **Datadir migration:** `CURRENT_DB_VERSION` 38 -> 40 on first start. Back up the
> datadir before the first start; rollback is runtime AND datadir together. Wire:
> `XmrSplitMessage` gains field 5, sent only to peers at protocol 7. Full record:
> `PwndaWalletVault/log.md` 2026-10-06.
>
> ## v0.18.9 + p36 — DEPLOYED on both platforms (2026-09-17), superseded by the deploy of the above
>
> `pwnda-grove 0.18.9+p36`. Upstream bumped `__version__` this time, so the stamp names the release again and the
> note below about identifying trees by content applies to the older trees only. Rollback (Windows):
> `.swap-sidecar-work/runtime-backup-0.18.6-20260917-002948`; Linux engine tree: `.swap-sidecar-work/linux-runtime-backup-0.18.6p36-20260917-basicswap`.
> Offline gates green on both trees (`Test-SidecarSuite.ps1` 8/8 on the Windows runtime; eight suites against a copy of the Linux tree). No regtest settle has been run on v0.18.9 yet.
>
> ## v0.18.7 + PATCH-34 — deployed on both platforms (2026-09-12), superseded
>
> Earlier banners on this pin claimed first that v0.18.7 regressed the mercy
> transaction, then that it was untested. Both were wrong and are retracted; the
> runs behind the first had silently used the deployed 0.18.6 tree. See
> `PwndaWalletVault/log.md` 2026-09-12.
>
> **Identify a tree by CONTENT, never by the stamp.** Upstream never bumped
> `__version__`, so every tree here stamps `pwnda-grove 0.18.6+p<n>` regardless of
> which upstream it came from, and `check-basicswap-upstream.mjs` inherits that
> blindness in its per-runtime lines.
>
> | tree | fingerprint |
> |---|---|
> | 0.18.6+p32 (previous, kept as rollback) | `abe564463c5b` |
> | **v0.18.7 + PATCH-34 (deployed, both platforms)** | **`dc766b9fdb4d`** |
>
> | gate | 0.18.6+p32 | **v0.18.7 + p34** |
> |---|---|---|
> | patch series | 32 | **33** |
> | invariant suites, Linux | 13/13 | **13/13** |
> | invariant suites, Windows | 13/13 | **13/13** |
> | ZEPH matrix | 8/8 | **8/8** |
> | ZANO matrix | 5/8 | **8/8** |
>
> Windows and Linux engines are byte-identical across all 173 `.py` files.
>
> **Rollback**, if ever needed — identify it by fingerprint, not by the directory
> name, because every backup here is called `0.18.6`:
>
> ```
> .swap-sidecar-work/runtime-backup-0.18.6-20260912-081557        fp abe564463c5b  (windows)
> .swap-sidecar-work/linux-runtime-backup-0.18.6p32-20260912-081703  (linux)
> ```
>
> **Installing a Linux runtime must be done FROM Linux.** A `cp -r` from MSYS bash
> silently fails to create the symlinks the tree needs — including `bin/python3`,
> the interpreter itself — and leaves a directory that looks complete and has no
> python in it. Use `cp -a` inside the container.
>
> **Running a matrix against a staged tree:**
>
> ```
> -e GROVE_RUNTIME=/io/.swap-sidecar-work/linux-runtime-0187
> -e GROVE_EXPECT=dc766b9fdb4d
> ```
>
> `GROVE_EXPECT` makes the runner refuse to start on the wrong tree. With no
> `GROVE_RUNTIME` it uses the deployed tree, which is the point of a post-deploy
> re-run.

| repo | tag | commit | tag date | local path |
|---|---|---|---|---|
| github.com/basicswap/basicswap | **v0.19.0** | `277b46b0278f1cc76199f7e847988647a1b36e38` | 2026-10-03 | `upstream/basicswap/` |
| github.com/basicswap/coincurve | **basicswap_v0.4** | `ff375ce4ac551afc99f359da784ffceeda03203f` | 2026-08-13 | `upstream/coincurve/` |

Notes at pin time (v0.19.0, 2026-10-06): moved from `v0.18.9` across v0.18.10 and v0.19.0 (64 commits). **Datadir migration:** `CURRENT_DB_VERSION` 38 -> 40 (`CURRENT_DB_DATA_VERSION` stays 10). `upgradeDatabaseFromSchema` adds four nullable columns (`bids.plan_id`, `xmr_swaps.split_parent_msg_id`, `xmr_swaps.accept_prepared_at`, `xmr_split_data.parent_msg_id`) and sets `db_version` 40; `db_upgrades.py` itself did not change. **Wire:** `XmrSplitMessage` gains field 5 `parent_msg_id`; `PROTOCOL_VERSION_ADAPTOR_SIG` 6 -> 7 while `MINPROTO_VERSION_ADAPTOR_SIG` stays 6, and the field is sent only to a peer whose offer/bid says protocol 7 (a 0.18.x decoder raises `KeyError` on an unknown field). `requirements.txt` did not move, so only the basicswap wheel pin changed (`basicswap-0.19.0-py3-none-any.whl`, sha256 `59025211…f6593e`). What upstream changed: Smart Buy (batched bids, preselected lock inputs, batched coin B locks, `bids/plan` + `bids/bulk`), accept persistence and re-send, Nostr and SimpleX v7 networks (`/json/networks`), oracles replacing CoinGecko-only rates (ids now in each coin's chainparams `rate_ids`; `/json/rates` returns `oracle`, not `coingecko`), a `prepare.py` refactor, and Particl 27.2.6 / Firo 0.14.18.1 as prepare.py's download defaults (the bundled Particl stays 27.2.4.0, supplied by `--bindir`). Eleven patches stopped applying under `git apply`; ten were regenerated by a git rebase (0007, 0014, 0016, 0018, 0020, 0021, 0026, 0028, 0037, plus 0008 revised), 0023 and 0038 were cumulative-apply artifacts and apply unchanged. Nothing was superseded or deleted; the series is still 38 files (+p37). Found on the way, and fixed in the regenerated patches: PATCH-18's `BCHInterface.fundSCLockTx` had not accepted the engine's `cursor=` since v0.18.7 (every BCH chain-A lock raised `TypeError`, deployed tree included), the new `publishBLockTxs` had no PATCH-8 guard, ZEPH/ZANO lacked the `rate_ids` the oracles now require, PATCH-26's coin entries used the removed `coingeckoId` shape, and PATCH-20 had been merged into a function upstream rewrote. The `createoffers.py` asset was refreshed to v0.19.0's (the v0.18.9 script reads the old `coingecko` keys).

Notes at pin time (v0.18.9, 2026-09-17): moved from `v0.18.7`. Upstream bumped `__version__` itself this time, so trees stamp `pwnda-grove 0.18.9+p36` and the stamp tracks the release again. **No datadir migration** (`CURRENT_DB_VERSION` 38 / `CURRENT_DB_DATA_VERSION` 10 unchanged; `db.py` changed only type hints). `requirements.txt` did not move, so only the basicswap wheel pin changed. What upstream changed: a swipe-payout sweep (`_sweepSwipePayout`, `TxTypes.SWIPE_SWEEP`, `EventLogTypes.SWIPE_PAYOUT_SWEPT`, `CoinInterface.mercySpendImportsKey`), websocket frame/header limits, a BIP32 master-key validity check, a type-hint refactor, and Particl Core 27.2.4 -> 27.2.5 as prepare.py's download default (the bundled daemon stays 27.2.4.0: `--bindir` supplies it and the engine does not check the version). Five patches stopped applying, all on typing churn (0003, 0018, 0019, 0023, 0024); a sixth (0027) applied but annotated `-> Optional[int]` in a basicswap.py that no longer imports `Optional`, which would have failed at import, caught by pyflakes. All six were regenerated by a git rebase; none is superseded. 0034 is still needed (`prevout_script[2:22]` is still there, and the new sweep uses the same `createMercyTx`). The sweep is chain-A logic keyed on `ci_from`, so ZEPH and ZANO swaps (always the scriptless leg) get it exactly as XMR swaps do; both interfaces inherit the base `mercySpendImportsKey`.

Notes at pin time: moved to `v0.18.7` on 2026-09-12 (from `v0.18.6`, pinned 2026-09-08; see `PwndaWalletVault/log.md`). **No datadir migration** — probe 5b reports `CURRENT_DB_VERSION` and `CURRENT_DB_DATA_VERSION` unchanged, so the runtime swap is a pure binary replacement. **The SMSG wire is byte-identical** and the coin enum is unchanged, so ZANO=16 and ZEPH=19 stay safe. Exactly one patch needed rebasing and it was not superseded: 0007, onto upstream's `refactor: thread db cursor through fundTx and fundSCLockTx` (8699f135), which added a `cursor=None` parameter to `fundSCLockTx`/`fundTx`/`_fundTxElectrum` and reformatted one call site into the shape the patch used to introduce. Pure context drift — checked first, because "stopped applying" and "stopped being necessary" look identical from the failure: v0.18.7 still does not filter which UTXOs may fund a chain-A lock (the unimplemented `# TODO: Manually select only segwit prevouts` is still there), so the patch's premise holds. One PyPI pin moved with it, `websocket-client` 1.9.0 → 1.9.2. The coincurve tag is the
exact tag `upstream/basicswap/requirements.txt:7` pins AND the tag
`pwnda-engine-handoff/engine-ltc/requirements.txt` already pins — one fork tag serves both.

## Re-fetch on a new machine

```
git clone https://github.com/basicswap/basicswap upstream/basicswap
git -C upstream/basicswap checkout v0.19.0
git clone https://github.com/basicswap/coincurve upstream/coincurve
git -C upstream/coincurve checkout basicswap_v0.4
```

Verify: `git -C upstream/basicswap rev-parse HEAD` must print the commit in the table.
Mismatch = the tag moved upstream; STOP and treat it as a supply-chain event, not drift.

## Facts verified against this pin (2026-08-15)

- `pyproject.toml:11` — `requires-python = ">=3.11"` (size the embedded runtime for 3.11).
- `requirements.txt:7` — coincurve from the fork tag zip, sha256-pinned. No wheels exist
  anywhere; Windows build needs MSVC + CMake once, then we vendor the wheel.
- Wire messages: `basicswap/messages_npb.py` — proto3 **wire format, hand-coded** ("npb" =
  non-protobuf; the python protobuf package is gone from requirements). Sync-runbook wire
  checks diff THIS file's schemas.
- JSON API: 37 endpoints in `basicswap/js_server.py` `endpoints` dict (incl. `validateamount`,
  `offerfeeestimate`, `coinprices`, `electrumdiscover`).
- `doc/install.md` § Windows — WSL2 + Docker Desktop only; no native section (the gap we fill).
- `basicswap/bin/prepare.py` — pre-seed levers all present: `--bindir`, `--preparebinonly`,
  `--nocores`, `SKIP_GPG_VALIDATION` env, `--client-auth-password` / `--disable-client-auth`,
  `--usebtcfastsync`, `--trustremotenode`; `SIMPLEX_CHAT_VERSION` default 6.3.5 (SimpleX is a
  fallback transport — MVP disables it; particld/SMSG remains mandatory).

## Moving the pin (per-release sync runbook)

One command runs every check (pin integrity, wire/API/coin-enum/protocol-floor diffs,
argv + literal probes, the sequential patch dry-run) and prints the action list:

```
node scripts/check-basicswap-upstream.mjs
```

The full framework — cadence, per-finding decision rules, the bump procedure, the
re-verify order, and the update-together checklist — is
**`PwndaWalletVault/wiki/synthesis/basicswap-upstream-sync.md`** (canonical; the older
fragment in `CLIENT-PLAN-SIDECAR-EXECUTION.md` § Upstream sync runbook is superseded by
it). When the pin does move: update the table here AND the `PIN_*` constants +
artifact hashes in `scripts/fetch-swap-runtime.mjs`, and log the move in
`PwndaWalletVault/log.md`.

## Reproducing the runtime from these pins

Two tracked artifacts turn the pin table above into a runtime somebody else can rebuild.

**`scripts/fetch-swap-runtime.mjs`** — fetches, sha256-verifies and stages every pinned
input: the CPython 3.12.10 Windows embeddable, the seven PyPI wheels from
`requirements.txt` (upstream's own `--hash=` pins), the coincurve fork source zip, the two
locally built wheels (coincurve fork + basicswap, verified against pinned *artifact*
hashes because neither build is bit-reproducible), and the particl / litecoin / monero
daemons. Emits `swap-runtime.json` with a `treeHash` over the staged set using the
`sha256-of-sorted-sha256-lines-v1` scheme from `pwnda-engine-handoff/ENGINE-TREE.json`.

```
node scripts/fetch-swap-runtime.mjs --check    # HEAD reachability + print pins, no downloads
node scripts/fetch-swap-runtime.mjs            # full fetch + verify + stage
```

It does **not** assemble the runtime image (that needs an external python with pip; the
shipped runtime deliberately has none) — the recipe is written into the manifest's
`assembly` block.

The script is also how the Windows GPG problem is answered. `python-gnupg` resolves `gpg`
from `PATH` only, and Git's MSYS2 `gpg.exe` cannot take Windows paths (U-2), so upstream's
core verification cannot run natively. Instead **we** fetch and hash-verify the coin
binaries against pins that were each cross-checked against the upstream signed
gitian/guix build-assert manifest, and the supervisor passes them to `prepare` with
`--nocores --bindir=...`, so upstream never downloads or verifies anything. Do not
"simplify" this back to `SKIP_GPG_VALIDATION` plus upstream's fetcher — that leaves
binaries arriving over the network with no pin under review.

Note recorded while pinning (2026-08-18): upstream's litecoin `getReleaseUrl` lists the
GitHub release first, but that URL returns **HTTP 404** for `v0.21.5.6`; only the
`download.litecoin.org` fallback serves it. Our table puts the working host first.

**`upstream/patches/`** — the engine patch series (**twelve** patches as of 2026-08-25:
platform fixes 1–2, convergence patches 3–8, the change-allocator fix 9, the stuck-swap
trio 10–12) as a tracked, re-appliable series against `v0.18.5`, so the read-only rule
above survives contact with a tree that needs editing. The per-patch table, rationale,
application commands, the CRLF/filemode gotchas, and the verification suites are in
`upstream/patches/README.md` — that file is the series authority; an earlier revision of
THIS paragraph said "two patches" long after the series had grown, which is exactly the
mirror-drift the sync framework now checks for.
