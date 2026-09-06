# Contributing to PwndaWallet

PwndaWallet is a Tauri (Rust + TypeScript/React) desktop wallet with integrated
mining and atomic swaps. This file is the contributor-facing contract: the rules
below are referenced from source comments and scripts throughout the repo, and
several exist because ignoring them has already cost real incidents.

---

## Getting started

```bash
npm install
npm run tauri:dev          # full app
npm run dev                # browser only, http://localhost:1420
```

Before opening a pull request:

```bash
npm run check-types
npm run test
npm run check-boundaries
cd src-tauri && cargo test --features full --lib
```

The full command reference — running, checking, building, releasing — lives in
`PwndaWalletVault/wiki/synthesis/build-and-release-commands.md`.

---

## The isolated dev sandbox

`npm run tauri:dev:sandbox` (or `npm run dev:sandbox` for browser-only) runs the
app as a **separate Tauri product** on port **1421**, with its own app-data
directory (`com.pwnda.wallet.sandbox-dev`) and its own cargo target dir.

**Why it exists.** Your real dev wallet — actual seed phrase, real settings,
real on-chain history — lives on the `npm run tauri:dev` instance on port 1420.
Anything an automated tool or an experiment does in the sandbox is invisible to
that wallet and cannot corrupt it. Use the sandbox for anything you would not
want to run against a funded wallet.

Configure it via `.env.sandbox.local` (see `.env.sandbox.local.example`).
`VITE_MOCK_STATE` selects a scenario — idle, funded, degraded, mining active,
and others — so UI states can be reproduced offline and deterministically.

---

## Visual verification is required for UI changes

If a change touches anything a user can see — a component, a style, a view, a
token, or a hook whose state is rendered — **load the app and look at it**
before calling the work done, and check the browser console for new errors.

Type-checks and unit tests verify code correctness, not feature correctness.
They will pass while the layout is broken or the panel renders empty. In one
case they passed 1988/1988 while the entire app rendered a black window at
sign-in: a conditional React hook is invisible to `tsc` (hook order is not a
type) and no unit test renders the root component. Only loading the app finds
that class of fault.

---

## Landscape-first

**Landscape is the primary surface; portrait inherits from it.** When building
or extending UI, build the shared/landscape implementation first, then make
portrait use it.

This is a hard rule because the alternative has recurred: an entire swap taker
flow was built portrait-only while the landscape router still listed its tab —
so the tab was selectable, looked wired up, and led to an empty screen. Prefer a
genuinely shared component imported by both roots over two parallel
implementations; if styling cannot serve both, add a `compact` prop rather than
forking the file.

---

## Module boundaries

`BOUNDARIES.md` defines a per-feature import policy, enforced by
`npm run check-boundaries`. Cross-feature imports go through the destination's
`index.ts` only — never reach into another feature's private files.

The contract exists so the mining subsystem can ship as a standalone product
without dragging in the wallet/vault layer. If a boundary blocks you, fix the
import rather than relaxing the rule, and update `BOUNDARIES.md` and
`scripts/check-boundaries.mjs` together — they are one contract in two forms.

The backend equivalent: `cargo build --no-default-features` must succeed.
Wallet/swap/RPC modules are gated behind the `full` Cargo feature.

---

## Bug documentation

**Every bug gets written down — with how you found it — before the fix counts
as done.** Append to `PwndaWalletVault/log.md`:

- **Symptom** — the error *verbatim*, in a code block. The exact string is what
  the next person greps for.
- **Root cause** — the mechanism, at `file:line` where you can. Mark inference
  as inference.
- **How it was detected** — the technique, not "I noticed". This is the section
  people skip and the one worth the most.
- **The fix** — and why that rather than the obvious alternative.
- **Verification** — what you ran and what it printed. "Tests pass" is not
  verification.

Record hypotheses that turned out wrong and what disproved them; omitting them
makes the next person re-run them.

Two failure shapes worth checking for by name, because both recur:

1. **A check that cannot fail for the reason you run it.** Ask: *if the thing I
   am checking were broken, would this check go red?*
2. **A precondition copied from a neighbouring operation** — it is not a
   precondition, it is an assumption about which operation you are running.

---

## The swap engine (Pwnda Grove)

The atomic-swap engine is a **pinned upstream BasicSwap tag plus an append-only
numbered patch series** in `upstream/patches/`, applied by
`scripts/apply-engine-patches.mjs`. It is not a fork; the patches are the diff,
readable in isolation.

**Standing safety rules:**

- Never run `apply-engine-patches.mjs` without an explicit `--target <dir>`.
  A bare invocation used to mean "apply to every runtime found, including the
  live node" — it now refuses, but pass the target anyway.
- Do not write to `.swap-sidecar-work/runtime` or `dev-home` directly. Those are
  the live engine; replace it with `scripts/swap/Swap-EngineRuntime.ps1`, which
  is reversible.
- **Never execute an on-chain fund movement from an automated session** —
  arming a funded swap drive, locking, claiming or reclaiming coins. That is an
  operator action regardless of network, testnet included.

Run `scripts/swap/Test-SidecarSuite.ps1` before claiming the engine is sound.

---

## Documentation

The project keeps a knowledge base in `PwndaWalletVault/`. When you change
source, update the pages that describe it and append a `log.md` entry. The wiki
is the compounding memory of the project — an accurate one is worth more than a
tidy one.

---

## Commits

Write commit messages that explain **why**, not just what. If a change fixes a
defect, say what the defect was and how it was found — a future reader hitting
the same class of bug should be able to recognise it from your message.
