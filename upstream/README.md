# upstream/ — pinned BasicSwap reference clones

Local reference copies of the upstream repos the BasicSwap sidecar consumes. **Read-only by
convention: never edit these trees.** Our additions attach on the wallet side of the seam
(`CLIENT-PLAN-SIDECAR-EXECUTION.md` § keep the seam clean); if a patch inside `basicswap/`
ever becomes unavoidable it lives in the future harness repo as a patch series, never here.

The clones are full git repos and are **gitignored** (only this README is tracked). They
re-fetch deterministically from the pin table below on any machine.

## The pin (Phase-0 "pin an upstream release tag" — recorded 2026-08-15)

| repo | tag | commit | tag date | local path |
|---|---|---|---|---|
| github.com/basicswap/basicswap | **v0.18.5** | `3859612035f8c4476b5cadedf36b875d2f2def5b` | 2026-08-28 | `upstream/basicswap/` |
| github.com/basicswap/coincurve | **basicswap_v0.4** | `ff375ce4ac551afc99f359da784ffceeda03203f` | 2026-08-13 | `upstream/coincurve/` |

Notes at pin time: `v0.18.5` == upstream `master` HEAD on 2026-08-29 (moved from `v0.18.4` that day; see `PwndaWalletVault/log.md`). **This bump carries a datadir migration** — `CURRENT_DB_VERSION` 37→38 and `CURRENT_DB_DATA_VERSION` 9→10, unlike the v0.18.4 bump which was a pure binary replacement. Both steps are additive (three indices; four new bid-state rows) and an older engine returns early rather than refusing a newer DB, so the runtime swap stays reversible — verified, not assumed. The coincurve tag is the
exact tag `upstream/basicswap/requirements.txt:7` pins AND the tag
`pwnda-engine-handoff/engine-ltc/requirements.txt` already pins — one fork tag serves both.

## Re-fetch on a new machine

```
git clone https://github.com/basicswap/basicswap upstream/basicswap
git -C upstream/basicswap checkout v0.18.5
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
