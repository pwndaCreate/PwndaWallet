# Staged rebase for BasicSwap v0.18.6 — NOT SHIPPED

Nothing here is applied by `apply-engine-patches.mjs`. The live series is the
`00NN-*.patch` files one directory up, and it targets the **current pin,
v0.18.5**. These files exist so the rebase work is not lost between the analysis
and the pin move.

## Why a rebased patch cannot be committed on its own

`0007-electrum-funding-safety.rebased.patch` applies to **v0.18.6 only**. Landing
it in `upstream/patches/` while the pin is still 0.18.5 would break every runtime
build immediately. The pin move is therefore one atomic operation:

1. move `PIN_BASICSWAP_TAG` / `PIN_BASICSWAP_COMMIT` and `version: "0.18.5"` in
   `scripts/fetch-swap-runtime.mjs` to v0.18.6,
2. bump **litecoin 0.21.5.6 -> 0.21.5.7** in the same file — v0.18.6's only
   coin-version change (`interface/ltc/core.py`), so it moves *with* the engine
   and not before it,
3. replace `0007-electrum-funding-safety.patch` with the rebased file here,
4. rebuild BOTH runtimes and re-run `apply-engine-patches.mjs --check` on each,
5. re-run the invariant suites on both — under **each runtime's own interpreter**
   (a Windows interpreter cannot load the Linux `.so` extensions; see log.md
   2026-09-06),
6. `scripts/swap/Swap-EngineRuntime.ps1` to deploy, gated on zero in-flight bids.

Follow `PwndaWalletVault/wiki/synthesis/basicswap-upstream-sync.md` — it is the
canonical runbook and carries the full update-together checklist.

## What the 0.18.6 rebase actually costs

Measured 2026-09-06 by applying the whole series to a v0.18.6 worktree with
`git apply --3way`, committing each patch so the index stays clean:

- **24 of 28 apply cleanly.**
- **1 genuine content conflict:** `0007-electrum-funding-safety`.
- 3 report `repository lacks the necessary blob` (0016, 0025, 0026). That is an
  artifact of committing each patch — the 3-way base is no longer pristine — not
  a content conflict. `apply-engine-patches.mjs` does exact-context matching, not
  `git apply`, so the authoritative test is that tool against a real v0.18.6
  runtime.

A first pass reported "24 hunks across 2 patches" and a second reported only one
conflict; both were wrong in opposite directions. The first counted a plain
`git apply --check` (no 3-way). The second counted *conflicts* and scored
outright failures as clean, because a patch that fails leaves no unmerged files.
The numbers above come from checking `git apply`'s exit code AND the unmerged
list.

## The 0007 resolution

Upstream rewrote `_computeElectrumLegacyFundsInfo`: `legacy_addresses` now comes
from `getAllAddresses()` and is priced via `backend.getBalance()`, replacing the
`unspent_by_addr` scan the patch originally hooked.

PWNDA-PATCH-7's intent is orthogonal to that — *a coin adopted at `p2pkh` by
design has no "legacy funds"* — so the guard moves **up**, to an early return
before any address enumeration. That preserves the patch's meaning and also
honours upstream's own comment that "a wallet with none needs no electrum
traffic at all", instead of computing a balance only to discard it.

Verified: applies cleanly to pristine v0.18.6, and the resulting `basicswap.py`
parses. NOT yet exercised against a running engine — that is step 4 above.
