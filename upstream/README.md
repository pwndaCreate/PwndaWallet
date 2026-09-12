# upstream/ — pinned BasicSwap reference clones

Local reference copies of the upstream repos the BasicSwap sidecar consumes. **Read-only by
convention: never edit these trees.** Our additions attach on the wallet side of the seam
(`CLIENT-PLAN-SIDECAR-EXECUTION.md` § keep the seam clean); if a patch inside `basicswap/`
ever becomes unavoidable it lives in the future harness repo as a patch series, never here.

The clones are full git repos and are **gitignored** (only this README is tracked). They
re-fetch deterministically from the pin table below on any machine.

## The pin (Phase-0 "pin an upstream release tag" — recorded 2026-08-15)

> ## v0.18.7 + PATCH-34 — DEPLOYED on both platforms (2026-09-12)
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
| github.com/basicswap/basicswap | **v0.18.7** | `079a0d43ed16590eecda2f3d6a3481f847360175` | 2026-09-11 | `upstream/basicswap/` |
| github.com/basicswap/coincurve | **basicswap_v0.4** | `ff375ce4ac551afc99f359da784ffceeda03203f` | 2026-08-13 | `upstream/coincurve/` |

Notes at pin time: moved to `v0.18.7` on 2026-09-12 (from `v0.18.6`, pinned 2026-09-08; see `PwndaWalletVault/log.md`). **No datadir migration** — probe 5b reports `CURRENT_DB_VERSION` and `CURRENT_DB_DATA_VERSION` unchanged, so the runtime swap is a pure binary replacement. **The SMSG wire is byte-identical** and the coin enum is unchanged, so ZANO=16 and ZEPH=19 stay safe. Exactly one patch needed rebasing and it was not superseded: 0007, onto upstream's `refactor: thread db cursor through fundTx and fundSCLockTx` (8699f135), which added a `cursor=None` parameter to `fundSCLockTx`/`fundTx`/`_fundTxElectrum` and reformatted one call site into the shape the patch used to introduce. Pure context drift — checked first, because "stopped applying" and "stopped being necessary" look identical from the failure: v0.18.7 still does not filter which UTXOs may fund a chain-A lock (the unimplemented `# TODO: Manually select only segwit prevouts` is still there), so the patch's premise holds. One PyPI pin moved with it, `websocket-client` 1.9.0 → 1.9.2. The coincurve tag is the
exact tag `upstream/basicswap/requirements.txt:7` pins AND the tag
`pwnda-engine-handoff/engine-ltc/requirements.txt` already pins — one fork tag serves both.

## Re-fetch on a new machine

```
git clone https://github.com/basicswap/basicswap upstream/basicswap
git -C upstream/basicswap checkout v0.18.6
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
