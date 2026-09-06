# Funded SELL_FOLLOWER drive — operator runbook (Windows PowerShell)

**What this is.** The exact commands to drive the first funded two-box atomic swap
(SELL_FOLLOWER: sell stagenet XMR → receive preprod ADA) against the armed desk,
end to end, over I2P. **Testnet only** — stagenet/preprod, valueless coins, no
mainnet wallet touched.

**Shell.** These are for **Windows PowerShell 5.1** (your Cursor terminal). Notes:
- No `&&` — PS 5.1 doesn't support it; run commands on separate lines.
- Native `.exe`s are launched with the call operator `&`.
- Don't `source` the bash `.sh` env file — a PS-native parse below loads it instead.
- Use `curl.exe` (the bare `curl` is an alias for `Invoke-WebRequest`).

> ## ⚡ There are scripts for all of this now (2026-07-25)
>
> Everything below is automated in [`scripts/swap/`](scripts/swap/README.md). The
> manual commands are kept because they are the reference for *what each stage
> means* — but the scripts are the shorter and safer path, and they check ~35
> preconditions the manual route leaves to memory.
>
> Invoke by **absolute path** — the scripts work from any working directory, but a
> relative path does not (`cd scripts` then `.\scripts\swap\…` looks for
> `scripts\scripts\swap\`, and PowerShell's `CommandNotFoundException` means nothing ran).
>
> ```powershell
> $s = "G:\PwndaWalletDevelopment\scripts\swap"
> & $s\Test-SwapSuite.ps1     # offline: is the client sound?
> & $s\Start-Stack.ps1        # Windows 1 + 2, detached and health-checked
> & $s\Preflight.ps1          # is everything ready? (no funds move)
> & $s\Start-Swap.ps1         # dress rehearsal (stops at accept)
> & $s\Start-Swap.ps1 -Arm    # the funded drive
> ```
>
> Read [`scripts/swap/README.md`](scripts/swap/README.md) first. The rest of this
> file explains the stages the scripts drive.

You need **three PowerShell windows**. Every path below is verified present on this
machine; `$env:USERPROFILE` = `C:\Users\user`.

**Who runs what.** You run these. The desk (server half) is armed and autonomous —
it needs nothing. Paste me each stage's output and I interpret it live and debug
any fault with you. I don't run the drive itself; everything around it, I'm on.

**Credential-safe.** The env-file parse loads `BLOCKFROST_PROJECT_ID` without
printing it. Don't `echo $env:BLOCKFROST_PROJECT_ID`.

---

## What the drive proves, and the flow

`run_swap_choreography` (the same function the UI's `desk_proceed` will call) drives:

```
M2 (accept) → poll /status.lockUtxo (desk prepare_lock) → set_lock_utxo → M3
  → [desk submit_lock: ADA on-chain] → observe A to depth (HARD gate) → lock XMR
  → POST /lock → poll releasedClaimSig (M5) → ingest → claim ADA → SETTLED
```

**Expect first-run integration faults** — the live `prepare_lock`/`submit_lock` and
funded M3 have never executed against a real chain. Nothing strands on a clean
fail-closed; the 3h timelock is the net.

---

## Window 1 — Monero stagenet wallet-rpc (Bob wallet) on :38088

Leave it running. It must then **sync** to the tip before the balance is usable —
watch the log / re-run the balance check until `unlocked_balance` is populated.
(`--%` passes the rest verbatim; `--daemon-ssl disabled` skips the SSL autodetect probe
— the public node is plaintext, so the probe otherwise logs a harmless `SSL handshake
failed ... reconnecting without SSL` before falling back.)

> **`--wallet-dir` is REQUIRED (2026-07-25). `--wallet-file` will kill the drive.**
> An earlier revision of this callout said `--wallet-file` "also works". It does not, on the
> client: our OWN observer polls chain B through the shared engine, and `watch_lock(B)`
> restores a per-swap joint **view-only** wallet on this rpc. On `--wallet-file` the engine
> cannot select the reserve back by name, so the lock guard finds a watch-only wallet open
> and refuses. `Start-Stack.ps1` uses `--wallet-dir` by default; only pass `-WalletFileMode`
> if you know why. **If a drive has already re-pointed the rpc, restart it** — preflight's
> wallet-identity check catches this and FAILs.
>
> The original three-case guard note, still accurate:
> The engine's `lock_xmr` guard opens the funded reserve **by name** before locking; if that
> fails it checks whether the currently-open wallet **can sign** (`is_spendable()`), and only
> refuses when the open wallet is **watch-only** (`desk_engine.py::lock_xmr`). So the three
> cases are: opened-by-name → proceed; open failed but the single open wallet can sign
> (`--wallet-file`) → proceed — and if `XMR_RESERVE_ADDRESS` is set, only after the open
> wallet's address is **proved** to match (refuses on mismatch, `e2e4e6f`); open failed and
> it's watch-only, or its address can't be read → refuse, naming the cause.
> The guard exists because one wallet-rpc serves several wallets and answers as whichever was
> opened LAST — a chain-B watch re-points it at a per-swap view-only joint wallet. **On the
> client's SELL_FOLLOWER path that re-point happens TOO** — our own observer watches chain B
> through the same shared engine, which is what killed a drive on 2026-07-25. That is precisely
> why `--wallet-dir` is required: it is what lets the engine *select* the funded wallet back by
> name after a re-point. (An earlier revision of this callout said `--wallet-file` "also works",
> reasoning that only the desk watches B. It was wrong.)

```powershell
& "G:\PwndaWalletDevelopment\monero-x86_64-w64-mingw32-v0.18.4.6\monero-wallet-rpc.exe" --% --stagenet --wallet-dir G:\PwndaWalletDevelopment\pwnda-testnet-credentials\xmr-stagenet --rpc-bind-ip 127.0.0.1 --rpc-bind-port 38088 --disable-rpc-login --daemon-address stagenet.xmr-tw.org:38081 --daemon-ssl disabled --trusted-daemon --log-level 1
```

With `--wallet-dir` the rpc starts with **no wallet open** — the engine selects `swap-wallet`
(override with `XMR_RESERVE_WALLET` only if the file is renamed). The old single-wallet
`--wallet-file` launch is **no longer safe here**: it cannot re-select the reserve by name, so
once our own chain-B watch re-points the rpc the lock guard finds a watch-only wallet open and
refuses. Use `Start-Stack.ps1`, which passes `--wallet-dir` by default.

Node confirmed live 2026-07-24 (height 2170053, synced). Backup if it drifts:
`--daemon-address node.monerodevs.org:38089`.

**Verify (new window) it's listening + synced + the balance is unlocked** — the drive
locks from `unlocked_balance` (atomic units; 0.1 XMR = 100000000000):

On a `--wallet-dir` rpc, **select the reserve wallet first** (the same call the engine makes,
so it also proves the guard's case 1 will succeed). On `--wallet-file` the wallet is already
open — skip straight to the balance check.

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:38088/json_rpc -Method Post -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":"0","method":"open_wallet","params":{"filename":"swap-wallet","password":""}}'
```

An empty `result` is success. `No wallet dir configured` here just means the rpc is in
`--wallet-file` mode (one wallet already open) — harmless now; proceed to the balance check:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:38088/json_rpc -Method Post -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":"0","method":"get_balance","params":{"account_index":0}}'
```

Want a `result` with `unlocked_balance` ≥ ~100000000000. If the node is unreachable,
change `--daemon-address` to another public stagenet node (e.g.
`node.monerodevs.org:38089`) or run the bundled `monerod.exe --stagenet` and point
at `127.0.0.1:38081`. (Password is empty per the desk; if it rejects the password,
the wallet has one and we'll sort it.)

---

## Window 2 — i2pd dialing the desk `.b32`, local proxy on :8796

Your rung-1 transport; `tunnels.conf` already maps `127.0.0.1:8796 → the desk .b32`.
Leave it running.

```powershell
& "$env:USERPROFILE\.pwnda-i2pd\unpacked\i2pd.exe" --datadir "$env:USERPROFILE\pwnda-i2pd" --conf "$env:USERPROFILE\pwnda-i2pd\i2pd.conf" --tunconf "$env:USERPROFILE\pwnda-i2pd\tunnels.conf"
```

**Verify the tunnel reaches the armed desk** (give it 30–90s to build first; a first
try may print `000` — wait and retry):

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:8796/healthz
```

`200` = the client can reach the desk over I2P. `000` = the tunnel isn't built yet
(wait/retry) or i2pd isn't routing (check its web console at `http://127.0.0.1:7071`).

---

## Window 3 — the drive (paste the whole block into one window)

This is the funds-moving step — **you** run it. It loads the committed env, sets the
arm-gate + CLI vars, then runs the driver. Paste the whole block into one PowerShell
window so the `$env:` vars persist into `cargo test`.

```powershell
Set-Location G:\PwndaWalletDevelopment
# 1. Load the committed bash env into PowerShell (ADA_ENGINE_ENV, BLOCKFROST_PROJECT_ID, XMR_WALLET_RPC, ...):
Get-Content .\pwnda-testnet-credentials\client-testnet.env.sh | ForEach-Object { if ($_ -match '^\s*export\s+([A-Za-z_]\w*)=(.*)$') { $val = $matches[2].Trim().Trim('"').Trim("'"); Set-Item "Env:$($matches[1])" $val } }
# 2. Arm-gate vars the env file does NOT set:
$env:PWNDA_DESK_ARM       = "preprod-stagenet"
$env:PWNDA_ENGINE_PYTHON  = "$env:USERPROFILE\.pwnda-engine-venv\Scripts\python.exe"
$env:PWNDA_ENGINE_DIR     = "G:\PwndaWalletDevelopment\pwnda-engine-handoff\engine"
$env:ADA_ENGINE_STATE_KEY = "2222222222222222222222222222222222222222222222222222222222222222"
# 3. Transport + trade parameters:
$env:DESK_URL              = "http://127.0.0.1:8796"
$env:PWNDA_CLI_PAYOUT_ADDR = "addr_test1vqypankj0jgdkfpervsjrntu0xd7sqzey6h4czdqcecx8mcd7dfn8"
$env:PWNDA_CLI_REFUND_ADDR = (Get-Content .\pwnda-testnet-credentials\xmr-stagenet\swap-wallet.address.txt -Raw).Trim()
$env:PWNDA_CLI_AMOUNT      = "0.1"
# Case-2 identity proof: the reserve wallet's own address is the refund address (same wallet).
# Setting this makes the lock guard PROVE it locks from the reserve, not merely report it (desk e2e4e6f).
$env:XMR_RESERVE_ADDRESS   = $env:PWNDA_CLI_REFUND_ADDR
# 4. The explicit, funds-moving opt-in (unique to this driver):
$env:PWNDA_CONDUCTOR_CLI_DRIVE = "1"
# 5. Drive (debug build — do NOT add --release; the arm gate refuses release builds):
Set-Location G:\PwndaWalletDevelopment\src-tauri
cargo test --features full --lib desk::conductor::cli_entry -- --ignored --nocapture
```

Notes on the vars:
- `PWNDA_DESK_ARM` — any non-empty testnet value; the gate rejects a mainnet
  `ADA_ENGINE_ENV`, which here is `preprod`, so it proceeds.
- `ADA_ENGINE_STATE_KEY` — the engine's local per-swap store key. Any stable 64-char
  value; **reuse the same one across restarts** in a run (restart-safety).
- `PWNDA_CLI_PAYOUT_ADDR` — where you receive the bought ADA. The example is the
  client's own preprod address; substitute any preprod addr you control.
- `PWNDA_CLI_REFUND_ADDR` — where your XMR refunds if the swap aborts; read from the
  Bob wallet's own address file.
- `XMR_RESERVE_ADDRESS` — the reserve wallet's address (identical to the refund address —
  same wallet). Upgrades the lock guard's case 2 from *reported* to *proved* (desk `e2e4e6f`):
  if `open_wallet`-by-name fails, the guard verifies the open wallet's address matches this
  before locking, and refuses on mismatch. On the client's single-wallet 38088 it's
  belt-and-suspenders (only the reserve is ever open), but it's free and it's the posture the
  restart test wants — the desk pinned the same var on its side.

**The test arms first and asserts `crypto_is_production_ready()` BEFORE any funds
move.** An arm fault prints `DESK-ARM-FAULT:` naming the missing piece and the test
fails immediately — nothing has moved.

---

## What each stage looks like — and what to send me

`--nocapture` prints the driver's progress live. Relay each line; I'll confirm it's
on-path or flag it:

| Stage | What you'll see / check |
|---|---|
| Quote+accept | `cli_entry: accepted swap <id>` (desk_role LEADER) |
| Prepare | poll `/status`; `lockUtxo` appears (the desk's `prepare_lock` after your M2) |
| M3 | `set_lock_utxo` → `exchange_refund_sigs` → POST /refund-sigs succeeds |
| ADA lock | **the desk `submit_lock`s ADA on-chain** — the desk calls this txid the instant it fires |
| Observe A | the driver waits on its OWN observer confirming the ADA lock to depth |
| Lock B | your XMR lock txid; POST /lock (chain=B) |
| M5 | poll `/status.releasedClaimSig` → `ingest_claim_presig` |
| Claim | `claim` ADA → your claim txid |
| Settle | driver waits for the desk's SETTLED (cross-checked vs your claim txid) → `Claimed chain A, txid …` |

**Whoever sees the chain-A (ADA) lock first says so, with the txid** — the desk
watches its log and will call `submit_lock`; you relay what the driver prints.

---

## Failure modes (front-loaded, all legible)

| Symptom | Cause / fix |
|---|---|
| `cli_entry: SKIPPED — <VAR> is not set` | that env var is missing — set it, re-run (nothing happened) |
| `DESK-ARM-FAULT: …` + assert fails | bad/incomplete arm config (names the piece); no funds moved |
| `PreparedLockTimeout` after polling `lockUtxo` | the desk never prepared — check the tunnel (healthz 200) and that the desk log shows your accept |
| engine error on lock B / observe B | wallet-rpc on 38088 unreachable or no unlocked balance — re-check Window 1 (the "configured but down" case: fail-closed mid-drive, not a hang) |
| enroll returns 401 | you've used the ~20 enrollments this i2pd session allows — **restart Window 2 (i2pd)** to reset, then re-drive |
| `curl : ... Invoke-WebRequest` error | you used `curl` not `curl.exe` — use `curl.exe` |

Nothing strands on a clean fail-closed. If a swap locks XMR then stalls, the refund
watcher fires at the 3h T1 and reclaims it — leave the process (or a relaunch, which
rehydrates the watcher) running.

---

## Reclaiming an ABANDONED swap (after the desk refunds)

If a swap locked and was then abandoned (Ctrl-C, or the drive exited), our XMR is
recoverable but **only second**: the desk must publish its chain-A refund first, which
leaks `s_a`. Nothing reclaims automatically — the drive process that held the watcher is
gone, and `cli_entry` does not rehydrate. So run it deliberately:

```powershell
# Windows 1 + 3 env as above (no i2pd needed — this never talks to the desk).
$env:PWNDA_CLI_DATA_DIR = "<the SAME data dir the abandoned drive used>"
$env:PWNDA_CLI_RECLAIM  = "<swap_id>:<desk_refund_txid>,<swap_id>:<desk_refund_txid>"

# DRY RUN first — proves the data dir holds these swaps. Moves nothing.
cargo test --lib desk::conductor::cli_reclaim -- --ignored --nocapture

# Then arm the sweep and re-run the same command:
$env:PWNDA_CONDUCTOR_CLI_RECLAIM = "1"
```

The dry run prints `role=… lock_b=… reclaim=…` per swap. `NO RECORD` means the data dir
is wrong — the records live in `<data_dir>\desk-swaps\`. The armed run reports one verdict
per swap by name: `chain B reclaimed …` (done), `already reclaimed`, `nothing to reclaim`
(we led, or never locked), `secret not yet readable` (refund not indexed — retry), or
`does not carry our secret … not the refund` (**this is a refusal, not a failure**: the
engine bound the scalar to the expected adaptor point and it did not match, so that txid
is not the refund. The desk can choose what we examine, never what we conclude).

`PWNDA_CONDUCTOR_CLI_RECLAIM` is deliberately a **different** flag from
`PWNDA_CONDUCTOR_CLI_DRIVE`, so arming a drive can never arm a sweep or vice-versa.

---

## Iterating

Re-drive on any integration fault — ~20 enrollments per i2pd session (each run
enrolls a fresh identity); restart i2pd (Window 2) to reset the cap. Re-running is
safe: idempotent up to the lock, fail-closed after.

---

## After a clean SETTLED

- Record the full txid set: ADA lock (desk), your XMR lock, your ADA claim, the
  desk's XMR sweep — the first funded two-box swap proven on real chains.
- Next: wire the same `run_swap_choreography` to the UI (`desk_proceed` behind a
  click), then BUY_FOLLOWER (its mirror prepare-and-share + empty-`refundPresig`
  direction), never concurrent with a SELL.
```

*Every path, `curl.exe`, the env-file parse, the address read, and both daemon
command lines were validated in a Windows PowerShell 5.1 session before this was
written.*
