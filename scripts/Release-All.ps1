<#
.SYNOPSIS
    Cut a PwndaWallet release AND refresh the Particl fast-start snapshot, in
    one command.

.DESCRIPTION
    The two pipelines are independent by design -- the release builds bundles,
    the snapshot publishes chain data -- but they share a coupling that has no
    other guard: the snapshot's `particld_version` must equal the
    `PARTICLD_VERSION` compiled into the build. When they diverge the client
    refuses the snapshot with `WrongDaemon`, "Fast start" silently disappears
    from the setup wizard, and nothing anywhere reports it. This script exists
    so a release cannot quietly ship with a snapshot its own binary will reject.

    ORDER: snapshot first, then release. Two reasons.

      * The snapshot is the disruptive half -- it stops the swap node and needs
        the wallet unlocked for its in-flight check. Better to hit that in the
        first minute, with the operator watching, than after a 30-minute build.
      * The failure modes are asymmetric. A published snapshot with no release
        is harmless (it is valid for the current pin). A release whose snapshot
        never got refreshed degrades every new user's first run, silently.

    Use the individual scripts if you want a different order:
        scripts\swap\Publish-ParticlSnapshot.ps1
        scripts\release-local.ps1

    PREFLIGHT RUNS FIRST, FOR BOTH. Discovering that `gh` is not authenticated
    after the Linux container has been compiling for 25 minutes is a waste this
    script is specifically shaped to avoid.

.PARAMETER Version
    Release version, e.g. v0.6.0. Passed to release-local.ps1.

.PARAMETER SkipSnapshot
    Cut the release only. Leaves the published snapshot as it is -- which is
    fine when particld has not moved and the snapshot is recent.

.PARAMETER SkipRelease
    Refresh the snapshot only. The ordinary between-releases maintenance run.

.PARAMETER WaitMinutes
    Passed to the snapshot step: how long to wait for the node to reach the tip.

.PARAMETER SkipRepo
    Skip the apt/rpm repository. Linux subscribers will not be offered this
    release until it is regenerated.

.PARAMETER SkipBidCheck
    Passed to the snapshot step. Read that script's help before using it.

.PARAMETER DryRun
    Check everything, change nothing, print both plans.

.EXAMPLE
    .\scripts\Release-All.ps1 -Version v0.6.0 -DryRun
    What both halves would do.

.EXAMPLE
    .\scripts\Release-All.ps1 -Version v0.6.0 -WaitMinutes 60
    The full ship.

.EXAMPLE
    .\scripts\Release-All.ps1 -SkipRelease -WaitMinutes 60
    Just refresh the snapshot (no version needed).
#>
[CmdletBinding()]
param(
  [string]$Version,
  [switch]$SkipSnapshot,
  [switch]$SkipRelease,
  [switch]$SkipWindows,
  [switch]$SkipLinux,
  [switch]$PreRelease,
  [switch]$BumpVersion,
  [string]$Notes,
  [int]$WaitMinutes = 0,
  [switch]$SkipBidCheck,
  # Skip regenerating and publishing the apt/rpm repository during the release
  # half. Forwarded to release-local.ps1.
  [switch]$SkipRepo,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$snapshotScript = Join-Path $RepoRoot "scripts\swap\Publish-ParticlSnapshot.ps1"
$releaseScript = Join-Path $RepoRoot "scripts\release-local.ps1"

function Phase([string]$m) { Write-Host "`n########## $m ##########" -ForegroundColor Magenta }
function Info([string]$m) { Write-Host "[release-all] $m" }
function Die([string]$m) { Write-Host "[release-all] $m" -ForegroundColor Red; exit 1 }

# Windows PowerShell 5.1 wraps a native command's stderr lines in ErrorRecords
# when you redirect with 2>&1, and with $ErrorActionPreference = "Stop" that
# becomes a TERMINATING error even when the exe exited 0. `docker info` on a
# stopped daemon is the case that caught this. So every native call goes
# through here, which drops the preference for the duration and hands back the
# exit code plainly.
function Invoke-Native {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$NativeArgs = @())
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $global:LASTEXITCODE = 0
    $out = & $Exe @NativeArgs 2>&1
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String) }
  } finally { $ErrorActionPreference = $prev }
}


if (-not $SkipRelease -and -not $Version) {
  Die "-Version is required unless -SkipRelease is given"
}

# ─── Shared preflight ────────────────────────────────────────────────────
Phase "preflight (both halves)"

if (-not (Test-Path $snapshotScript)) { Die "missing $snapshotScript" }
if (-not (Test-Path $releaseScript)) { Die "missing $releaseScript" }

# The working tree IS the release. A stray edit is the difference between the
# binary you tested and the one users get, and neither half checks this itself.
$dirty = (Invoke-Native git @("-C", $RepoRoot, "status", "--porcelain")).Text.Trim()
if ($dirty) {
  Write-Host "[release-all] uncommitted changes:" -ForegroundColor Yellow
  $dirty | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
  Write-Host "[release-all] Both halves build from the WORKING TREE, not from HEAD." -ForegroundColor Yellow
  Write-Host "[release-all] Commit (or stash) unless you mean to ship exactly this." -ForegroundColor Yellow
  if (-not $DryRun) {
    $ans = Read-Host "Continue anyway? (type YES)"
    if ($ans -ne "YES") { Die "stopped" }
  }
}

if (-not $SkipRelease) {
  $dockerUp = ((Invoke-Native docker @("info")).Code -eq 0)
  if (-not $dockerUp -and -not $SkipLinux) {
    Die "Docker is not running, and the Linux half needs it. Start Docker Desktop, or pass -SkipLinux."
  }
  Info "docker       $(if ($dockerUp) { 'running' } else { 'not needed (-SkipLinux)' })"

  # Two different TAURI_SIGNING_PRIVATE_KEY lines in .env.local means the LAST
  # one silently wins, which may not be the key tauri.conf.json pins. The
  # release script's own preflight compares the conf against the .pub FILE, so
  # it cannot see this -- it would pass, and every .sig would be unverifiable.
  $envLocal = Join-Path $RepoRoot ".env.local"
  if (Test-Path $envLocal) {
    $keyLines = @(Get-Content $envLocal | Where-Object { $_ -match '^\s*TAURI_SIGNING_PRIVATE_KEY\s*=' })
    if ($keyLines.Count -gt 1) {
      Die @"
.env.local sets TAURI_SIGNING_PRIVATE_KEY $($keyLines.Count) times.

The loader takes the LAST one, which may not be the key tauri.conf.json pins.
release-local.ps1's updater preflight compares the conf against
pwnda-updater.key.pub -- it cannot detect this, so it would pass and every
signature this build produces could still be rejected by every client.

Leave exactly one.
"@
    }
    Info "signing key  one entry in .env.local"
  }
}

if (-not $SkipSnapshot) {
  if ((Invoke-Native gh @("auth", "status")).Code -ne 0) { Die "gh is not authenticated -- run: gh auth login" }
  Info "gh           authenticated"
}

$planParts = @()
if (-not $SkipSnapshot) { $planParts += "snapshot" }
if (-not $SkipRelease) { $planParts += "release $Version" }
Info "plan         $($planParts -join ' + ')"

# ─── 1. Snapshot ─────────────────────────────────────────────────────────
if (-not $SkipSnapshot) {
  Phase "1/2  Particl fast-start snapshot"
  # NOT $args -- that is an automatic variable.
  #
  # HASHTABLE splat, never an array. Under Windows PowerShell 5.1 an ARRAY
  # splat does not carry `-Name value` pairs into a script: the value after a
  # `-Name` token is DROPPED and the NEXT token becomes its value. Measured
  # 2026-09-10 against a probe script:
  #
  #   @("-WaitMinutes", 60, "-DryRun")  ->  WaitMinutes = "-DryRun"
  #                                         (Int32 conversion then fails)
  #   @{ WaitMinutes = 60; DryRun = $true }  ->  binds correctly
  #
  # With no trailing switch to absorb it the string "-WaitMinutes" lands in the
  # first POSITIONAL parameter instead, which is exactly what the operator saw:
  # `[snapshot] no datadir at -WaitMinutes`.
  #
  # A hashtable binds by NAME and cannot be misread. Switches take $true.
  $snapArgs = @{}
  if ($WaitMinutes -gt 0) { $snapArgs.WaitMinutes = $WaitMinutes }
  if ($SkipBidCheck) { $snapArgs.SkipBidCheck = $true }
  if ($DryRun) { $snapArgs.DryRun = $true }
  # A PowerShell script only sets $LASTEXITCODE if it calls `exit`; otherwise the
  # previous native command's code lingers and would read as a failure here.
  $global:LASTEXITCODE = 0
  & $snapshotScript @snapArgs
  if ($LASTEXITCODE -ne 0) { Die "the snapshot step failed -- nothing was released" }
} else {
  Phase "1/2  snapshot SKIPPED"
}

# ─── 2. Release ──────────────────────────────────────────────────────────
if (-not $SkipRelease) {
  Phase "2/2  release $Version"
  # Hashtable, for the reason spelled out in the snapshot block above: an array
  # splat would have handed `-Version` the value `-BumpVersion`.
  $relArgs = @{ Version = $Version }
  if ($SkipWindows) { $relArgs.SkipWindows = $true }
  if ($SkipLinux) { $relArgs.SkipLinux = $true }
  if ($PreRelease) { $relArgs.PreRelease = $true }
  if ($BumpVersion) { $relArgs.BumpVersion = $true }
  if ($SkipRepo) { $relArgs.SkipRepo = $true }
  if ($Notes) { $relArgs.Notes = $Notes }
  if ($DryRun) {
    $shown = ($relArgs.GetEnumerator() | Sort-Object Key | ForEach-Object {
      if ($_.Value -is [bool]) { "-$($_.Key)" } else { "-$($_.Key) $($_.Value)" }
    }) -join ' '
    Info "would run: release-local.ps1 $shown"
  } else {
    $global:LASTEXITCODE = 0
    & $releaseScript @relArgs
    if ($LASTEXITCODE -ne 0) { Die "the release step failed" }
  }
} else {
  Phase "2/2  release SKIPPED"
}

# ─── 3. The coupling neither half checks ─────────────────────────────────
Phase "cross-check: does the shipped build accept the published snapshot?"
#
# The whole reason this script exists. Read the PUBLISHED manifest and compare
# its particld_version against the pin compiled into the build. A mismatch
# means Fast start is dead for every new install, with no error anywhere.
if ($DryRun) {
  Info "dry run -- would compare the published snapshot against PARTICLD_VERSION"
} else {
  $rs = Get-Content (Join-Path $RepoRoot "src-tauri\src\swap_sidecar.rs") -Raw
  if ($rs -notmatch 'PARTICLD_VERSION[^=]*=\s*"([^"]+)"') {
    Write-Host "[release-all] could not read PARTICLD_VERSION -- cross-check SKIPPED" -ForegroundColor Yellow
  } else {
    $pin = $Matches[1]
    try {
      $pub = Invoke-RestMethod -Uri "https://github.com/pwndaCreate/PwndaWallet/releases/download/particl-snapshot/manifest.json" -TimeoutSec 60
      if ($pub.particld_version -ne $pin) {
        Write-Host "[release-all] MISMATCH" -ForegroundColor Red
        Write-Host "  build pins particld : $pin"
        Write-Host "  published snapshot  : $($pub.particld_version)"
        Write-Host ""
        Write-Host "Every install of this release will REFUSE the snapshot (WrongDaemon)"
        Write-Host "and fall back to a ~4.5 hour sync, with no error shown to the user."
        Write-Host "Fix: .\scripts\swap\Publish-ParticlSnapshot.ps1"
        exit 1
      }
      $created = if ($pub.created_at -is [datetime]) { $pub.created_at } else {
        [datetime]::Parse($pub.created_at, [Globalization.CultureInfo]::InvariantCulture,
                          [Globalization.DateTimeStyles]::RoundtripKind)
      }
      $age = [math]::Round(((Get-Date).ToUniversalTime() - $created.ToUniversalTime()).TotalDays, 1)
      Info "particld pin $pin matches the published snapshot"
      Info "snapshot     tip $($pub.tip.height), $age day(s) old"
      if ($age -gt 90) {
        Write-Host "[release-all] that snapshot is over 90 days old; new users will sync the gap." -ForegroundColor Yellow
      }
    } catch {
      Write-Host "[release-all] could not read the published manifest: $_" -ForegroundColor Yellow
      Write-Host "[release-all] Fast start may be unavailable for this release." -ForegroundColor Yellow
    }
  }
}

Phase "done"
