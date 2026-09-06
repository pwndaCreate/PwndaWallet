# CLIENT PLAN - BasicSwap Sidecar Kickoff (build order + the pin)

Status: DRAFT 2026-08-15. This doc OPERATIONALIZES `CLIENT-PLAN-SIDECAR-EXECUTION.md` into
concrete build stages now that the upstream reference is pinned locally. The execution plan
stays the reference for lifecycle detail, UI spec, and the risk register; read it first.
Doc map: `CLIENT-SIDECAR-INDEX.md`.

## What exists as of today

- **The pin is DONE** (Phase-0 item 2): basicswap **v0.17.9** (`9266677e`, == master HEAD
  2026-08-15) and coincurve fork **basicswap_v0.3** (`2bf23f1`) cloned read-only under
  `upstream/` — pin table, verified-at-pin facts, and the re-fetch + pin-move runbook live in
  `upstream/README.md`. Notable verifications: Python floor is now **>= 3.11**; wire messages
  are `messages_npb.py` (proto3 wire format, hand-coded - the protobuf package is GONE);
  `/json/validateamount` and `/json/offerfeeestimate` exist at this pin (Tier-1 UI can use
  them); prepare.py has every pre-seed lever the wizard needs; the coincurve tag upstream pins
  is the SAME tag `pwnda-engine-handoff/engine-ltc` already builds under WSL.
- Plans, mechanics, compliance posture: the CLIENT-SIDECAR doc set + the two vault synthesis
  pages. **No wallet code exists yet.**

## Stage map (A gates C's runtime; B and C start now)

```
A. Native Windows runtime spike   ── the gate; answers runs / runs-with-N-patches / no
B. Rust lifecycle module          ── swap_sidecar.rs; develop against a WSL-run node
C. UI (Tier 0 then Tier 1)        ── HTTP/WS client only; runtime-agnostic by design
D. Packaging + ship gates         ── wizard, weight, signing, pins; after A+B+C converge
```

B and C only ever see loopback HTTP/WS - so they are **decoupled from the spike** and can be
built and demoed against a basicswap node running under WSL (the proven
`ltc-venv-setup.sh`-era recipe) while A is answered. If A lands "runs", nothing in B/C
changes; if A lands "does not run", B/C still ship against the container fallback.

## Stage A - the native Windows runtime spike (THE GATE)

Question (from the execution plan): does unmodified basicswap v0.17.9 run under embedded
CPython on native Windows with native daemons? Answer it in five steps, cheapest first:

- [ ] **A1 - coincurve fork wheel, built once.** Build `basicswap_v0.3` for CPython 3.11
      win_amd64 (MSVC + CMake at build time; NO wheels exist anywhere). Operator choice:
      install VS Build Tools locally (~7 GB; the box historically lacks `cl.exe` - that is
      why the desk venv went to WSL) **or a GitHub Actions `windows-latest` job (recommended:
      reproducible, and the harness needs a wheel factory for every future pin anyway)**.
      Verify the artifact with `pwnda-engine-handoff/tools/verify-coincurve.py` (asserts the 6
      load-bearing adaptor/DLEAG symbols; "51" is the fork's total extra-export count, not the
      gate) from a plain Windows venv before it goes anywhere near the runtime.
- [ ] **A2 - embedded runtime.** python.org **embeddable** 3.11 amd64 zip (~11 MB): enable
      site-packages via the `python311._pth` file, then install from a local **wheelhouse**
      (`--no-index --find-links`) = A1's wheel + the rest of `requirements.txt` (all
      wheel-available or pure python at this pin) + the basicswap package itself from
      `upstream/basicswap` at the tag. No compiler and no network on the user path.
- [ ] **A3 - daemons.** particld via `basicswap-prepare` fetch for the SPIKE (accept
      `SKIP_GPG_VALIDATION=1` + its sha256 manifest for now; the PRODUCTION path is pre-seeded
      binaries through our own `wallet_rpc_common`-style verified fetch handed to prepare with
      `--nocores --bindir`, which also sidesteps shipping gnupg). LTC in **electrum mode** (no
      daemon at all). XMR: `monero-wallet-rpc` FROM THE WALLET'S OWN SIDECAR INVENTORY against
      a remote node from the wallet's node list (`--trustremotenode` semantics per prepare).
- [ ] **A4 - run it.** `basicswap-prepare` (particl + LTC-electrum + XMR-remote,
      `--client-auth-password`, default ports 12700/11700) then `basicswap-run`. **Success =**
      node starts; SMSG peers connect; `/json/coins` and `/json/offers` serve; the LIVE book
      populates; clean stop honours the shutdown ladder (parent first, chain daemons direct
      only if hung, never SIGKILL daemons first). **The spike executes NO swap** - it holds no
      funds; the funded XMR<>LTC settle stays the Phase-1 exit test under the operator-armed
      boundary.
- [ ] **A5 - watch-list while it runs** (log each hit): pyzmq under embedded python; path /
      long-path / file-locking assumptions; subprocess console windows (needs
      CREATE_NO_WINDOW everywhere upstream spawns); sqlite WAL on NTFS; firewall prompt on
      particld's listen port; SmartScreen/Defender on fetched daemons; the 120 s `open_wallet`
      startup trap after downtime.
- [ ] **A6 - the spike note** (goes in this repo, indexed): **runs / runs-with-N-patches /
      does-not-run**, measured install size vs the ~9-11 GB budget, and the patch list if any
      - each patch doubles as an upstream-PR candidate per the keep-the-seam-clean rule.
      Everything downstream re-plans off this note.

## Stage B - `src-tauri/src/swap_sidecar.rs` (start now, against a WSL node)

Mirror the shapes that already ship; invent nothing new (survey: `desk/sidecar.rs` for a
python child, `xmr_rpc.rs` for a port-owning daemon that must survive a crashed parent).

- [ ] Config generation: `basicswap.json` from OUR template (zero upstream patches) - coins,
      LTC electrum, XMR remote node from the wallet's node list, loopback binds, ports with
      `--portoffset` fallback probing (**new capability - no dynamic port allocation exists in
      the codebase today**), per-install `--client-auth-password` generated and stored like
      the xmr_rpc credsfile; the credential never reaches UI code, and the sensitive
      endpoints (`getcoinseed`, `setpassword`, `unlock`, `lock`) are never proxied.
- [ ] Spawn/monitor: hidden-window spawn (`platform::apply_hidden_spawn`), health =
      authenticated `/json/coins` poll, pidfile + 4-tier stale-instance recovery copied from
      `xmr_rpc.rs:719-801`, XMR wallet pre-warm before launch after long downtime.
- [ ] Stop: the documented ladder as a STATE MACHINE, and **do not block window close** -
      `lib.rs`'s `ExitRequested` hook currently `block_on`s ~100 ms miner stops; a BasicSwap
      teardown can take minutes (LevelDB flush). Detach the teardown (progress surfaced via
      event) or hold the window with visible progress - decide in review, never a silent hang.
- [ ] Opt-in gate `swapSidecarOptedInAt` (plaintext wallet.dat key, `miningOptIn.ts` pattern);
      nothing downloads/spawns/invokes before it. `#[cfg(feature = "full")]` on everything;
      `cargo check --no-default-features` stays green (lite never links it).
- [ ] Invoke surface (thin): `swap_sidecar_status | start | stop | opt_in | config_summary`.
      The UI talks to basicswap's OWN JSON API via a fetch-through command or direct loopback
      fetch - decide against the existing proxy taxonomy in review.
- [ ] Dev harness: a `PWNDA_SWAP_SIDECAR_URL` override so B and C run against the WSL node
      today and the native runtime later with zero code change.

## Stage C - UI (Tier 0 immediately after B exposes start/stop)

Per `CLIENT-PLAN-SIDECAR-EXECUTION.md` Phase 2 (the spec lives there; build order here):

- [ ] **C1 Tier 0** - router entry `'basicswap'` in the swap tab enum
      (`auto|swapkit|intents|pwnda-desk` today; XMR + ZEPH resolve HERE) + the "Open advanced
      BasicSwap console" escape hatch to `127.0.0.1:12700`. An afternoon of work; unblocks
      power users while Tier 1 is built.
- [ ] **C2 Tier 1 widget** - from/to/amount/quote/confirm over `/json/offers` (effective-rate
      ranking incl. the rate-representation gotcha), `/json/validateamount` +
      `/json/offerfeeestimate` for pre-submit feedback (both exist at this pin), bid via
      `/json/bids/new`, live tracking over WS `:11700`, the BidStates -> plain-language table
      (drafted in the execution plan), refunds framed as NORMAL outcomes.
- [ ] **C3 the safety core** - three-band spread gate vs the wallet's own price feed (green
      <~1% / amber 1-5% / red >~5% BLOCKS behind a typed override; feed-unavailable = red);
      cost lines shown separately (spread / chain fees / pwnda fee - fee module itself stays
      OFF pending counsel per `CLIENT-PLAN-SIDECAR-FEES.md`); no taker-feed fictions ever.
- [ ] New feature folder `src/features/swap-sidecar/` + `BOUNDARIES.md` row + wiki pages +
      surfaces-matrix entries per repo conventions; desktop-only, excluded from Lite.

## Stage D - packaging + ship gates (after A's verdict)

- [ ] Wizard (MiningSetupWizard shape): state sizes up front; fetch runtime zip + wheelhouse +
      daemons through the `wallet_rpc_common` sha256-manifest path; SmartScreen/Defender/
      elevation findings from A5 folded in.
- [ ] Pinned-artifact discipline: the wallet moves the pin, never auto-tracks (runbook in
      `upstream/README.md`); pin moves logged in the vault.
- [ ] Weight measured vs the ~9-11 GB budget; licence/attribution notices (MIT) in the about
      surface; Phase-1 exit = the operator-armed funded XMR<>LTC settle against a mainstream
      counterparty, API-only, native Windows.
- [ ] ZEPH / AVAX / ADA stay Phase 3 (execution plan) - nothing here changes the coin ladder.

## Order of work, concretely

1. **Session 1 (next):** A1 wheel-factory decision + build; A2 runtime skeleton boots a REPL
   from the embeddable zip with the wheelhouse installed.
2. **Session 2:** A3+A4 first `basicswap-run` attempt on native Windows; A5 log; A6 note
   drafted even if the verdict is partial.
3. **Parallel any time:** B against a WSL node; C1 the moment B has start/stop; C2/C3 build
   against the same node.
4. **After A6:** D re-planned off the verdict; operator decisions that remain open (coin-id
   band, spread default, fee rate/counsel, upstreaming posture) get taken as they land -
   none of them block A/B/C1.

## Boundaries respected throughout

Funded drives (anything locking XMR / claiming / reclaiming on-chain, testnet or mainnet)
remain operator-armed - the spike and all client dev run no-funds by construction. The
compliance/UX hard rules in `CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` bind every stage above.
