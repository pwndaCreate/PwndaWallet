<#
.SYNOPSIS
  Removes the machine-level traces PwndaWallet's mining stack leaves behind.

.DESCRIPTION
  Ported from the MSI's WiX custom actions (src-tauri/wix/defender-fragment.wxs)
  on 2026-09-06, when Windows consolidated onto a single NSIS installer. Without
  this, an .exe uninstall left behind:

    * the elevated `PwndaXmrig` scheduled task,
    * the `WinRing0_1_2_0` kernel driver service — a KNOWN-VULNERABLE driver
      that must not outlive the app that registered it,
    * Windows Defender exclusions covering the miners, and
    * xmrig / lolMiner / SRBMiner / wallet-rpc binaries under AppData.

  Two things are deliberately different from the MSI version, and both are
  improvements rather than ports:

  1. PER-USER, NOT ALL USERS. The MSI ran in machine context and could not
     resolve the interactive user's AppData, so it enumerated `C:\Users\*` and
     deleted from every profile on the box. The NSIS uninstaller runs AS the
     user, so it cleans that user's own directory and touches nobody else's.

  2. EXCLUSIONS ARE MATCHED BY DIRECTORY, NOT BY NAME. The MSI removed
     `-ExclusionProcess 'xmrig.exe'` — a bare filename. But the runtime adds
     exclusions by FULL PATH (miners.rs:678 formats `Add-MpPreference
     -ExclusionProcess '<miners_dir>\<exe>'`), so the MSI's removal list never
     matched what was actually added: it only cleared bare-name entries that an
     older install-time action had added, and left every runtime-added
     exclusion in place. Enumerating the current exclusions and removing those
     that point inside our directories cannot drift that way.

  The parent `com.pwnda.wallet` directory is preserved on purpose — it holds
  the vault, settings, and the Monero/Zephyr wallets. Only the binary
  subdirectories go.

  Nothing here is allowed to fail the uninstall. Every step is best-effort.

.NOTES
  Invoked by src-tauri/nsis/hooks.nsh (NSIS_HOOK_PREUNINSTALL), which runs it
  only on a genuine uninstall — never when the uninstaller is being run as part
  of an update ($UpdateMode). Deleting the scheduled task on every update would
  push the user back through the first-mining-start UAC prompt each time, which
  is the same reasoning as the MSI's `NOT UPGRADINGPRODUCTCODE` guard.
#>
[CmdletBinding()]
param(
  [string]$InstallDir,
  # Set when this script has re-launched itself elevated. Not for callers.
  [switch]$Elevated,
  # Report what would be done and stop before touching anything or asking for
  # elevation. Exists so the decision can be TESTED -- the elevation branch
  # opens a UAC dialog, which no automated check can drive -- and so support
  # can answer "why did uninstalling ask me for administrator?" without
  # uninstalling. Prints DECISION/WOULD-REMOVE lines and exits 0.
  [switch]$DryRun
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$TASK_NAME = 'PwndaXmrig'
$SERVICE_NAME = 'WinRing0_1_2_0'
$BUNDLE_ID = 'com.pwnda.wallet'
$RUNTIME_SUBDIRS = @('miners', 'monero', 'zephyr')

# Get-MpPreference does NOT fail for a non-administrator. It succeeds and puts
# this sentinel in the exclusion arrays instead of the real entries:
#
#     PS> (Get-MpPreference).ExclusionPath
#     N/A: Must be an administrator to view exclusions
#
# Measured on 2026-09-06, and it invalidated the first version of this script:
# unelevated, the exclusion scan found one "entry", failed to match it as ours,
# and concluded there was nothing to clean. A machine whose task and service
# were already gone would have kept its Defender exclusions forever, silently.
# Anything matching this must be treated as "unknown", never as "none".
$MP_DENIED = 'Must be an administrator'

$appData = Join-Path $env:APPDATA $BUNDLE_ID

# ── Did this user ever actually run the mining stack? ───────────────────────
# Captured BEFORE the delete below, because the presence of these directories
# is the most reliable UNELEVATED evidence that Defender exclusions were added
# — and the delete would erase that evidence. (The first version checked after
# deleting, so this signal was always false.)
$ranMining = $false
foreach ($sub in $RUNTIME_SUBDIRS) {
  if (Test-Path -LiteralPath (Join-Path $appData $sub)) { $ranMining = $true }
}

# ── Part 1 — the user's own files. No elevation required. ───────────────────
# Idempotent, and done before the elevation check so a user who declines the
# UAC prompt still gets their AppData cleaned.
foreach ($sub in $RUNTIME_SUBDIRS) {
  $p = Join-Path $appData $sub
  if (Test-Path -LiteralPath $p) {
    if ($DryRun) { Write-Output "WOULD-REMOVE dir  $p" }
    else { Remove-Item -LiteralPath $p -Recurse -Force }
  }
}

# ── What still needs administrator rights? ──────────────────────────────────
# Asked BEFORE elevating, so a user who never mined is never shown a UAC
# prompt on uninstall. `schtasks /query` and `sc query` both succeed for
# non-administrators — verified 2026-09-06: present -> exit 0, absent -> exit 1
# and 1060 respectively, from an unelevated shell.
function Test-TaskPresent {
  & schtasks.exe /query /tn $TASK_NAME 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}
function Test-ServicePresent {
  & sc.exe query $SERVICE_NAME 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Get-OurExclusions {
  # Entries pointing inside our install dir or our AppData dir, plus the
  # legacy bare-name forms older installers added. Returns $null when Defender
  # refused to show them (see $MP_DENIED) — $null means "cannot tell", which
  # the caller must not read as "none".
  $pref = Get-MpPreference
  if (-not $pref) { return $null }

  $rawPaths = @($pref.ExclusionPath)
  $rawProcs = @($pref.ExclusionProcess)
  foreach ($e in ($rawPaths + $rawProcs)) {
    if ($e -and $e -like "*$MP_DENIED*") { return $null }
  }

  $roots = @($appData)
  if ($InstallDir) { $roots += $InstallDir }
  $legacyNames = @('xmrig.exe', 'lolMiner.exe', 'SRBMiner-MULTI.exe', 'rigel.exe',
                   'monero-wallet-rpc.exe', 'zephyr-wallet-rpc.exe')

  $out = @{ Paths = @(); Processes = @() }
  foreach ($p in $rawPaths) {
    if (-not $p) { continue }
    if ($p -like "*\$BUNDLE_ID\*" -or $p -like "*\$BUNDLE_ID") { $out.Paths += $p; continue }
    foreach ($r in $roots) { if ($p -like "$r*") { $out.Paths += $p; break } }
  }
  foreach ($p in $rawProcs) {
    if (-not $p) { continue }
    # Full-path entries — what the runtime actually adds …
    if ($p -like "*\$BUNDLE_ID\*") { $out.Processes += $p; continue }
    # … and the bare names an older MSI added at install time.
    if ($legacyNames -contains $p) { $out.Processes += $p; continue }
    foreach ($r in $roots) { if ($p -like "$r*") { $out.Processes += $p; break } }
  }
  $out.Paths = @($out.Paths | Select-Object -Unique)
  $out.Processes = @($out.Processes | Select-Object -Unique)
  return $out
}

if (-not $Elevated) {
  # `$null` from Get-OurExclusions means Defender would not tell us, which is
  # the normal unelevated case. Fall back to $ranMining: if the miner binaries
  # were on disk, exclusions for them almost certainly are too.
  $found = Get-OurExclusions
  $exclusionsMaybe = if ($null -eq $found) {
    $ranMining
  } else {
    ($found.Paths.Count -gt 0) -or ($found.Processes.Count -gt 0)
  }

  $taskPresent = Test-TaskPresent
  $svcPresent = Test-ServicePresent
  $needsAdmin = $taskPresent -or $svcPresent -or $exclusionsMaybe

  if ($DryRun) {
    Write-Output "DECISION task=$taskPresent service=$svcPresent ranMining=$ranMining exclusionsReadable=$($null -ne $found) exclusionsMaybe=$exclusionsMaybe -> needsAdmin=$needsAdmin"
    if ($taskPresent) { Write-Output "WOULD-REMOVE task    $TASK_NAME" }
    if ($svcPresent)  { Write-Output "WOULD-REMOVE service $SERVICE_NAME" }
    if ($exclusionsMaybe) { Write-Output "WOULD-REMOVE Defender exclusions under $appData" }
    exit 0
  }

  if (-not $needsAdmin) {
    # The common case for anyone who never turned mining on: no UAC prompt.
    exit 0
  }

  $isAdmin = ([Security.Principal.WindowsPrincipal] `
              [Security.Principal.WindowsIdentity]::GetCurrent()
             ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Elevated')
    if ($InstallDir) { $argv += @('-InstallDir', $InstallDir) }
    try {
      Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs `
        -WindowStyle Hidden -Wait -ArgumentList $argv -ErrorAction Stop
    } catch {
      # The user declined the UAC prompt. That is their call: the uninstall
      # continues, and the task/service/exclusions stay. Saying so beats
      # failing the uninstall over it.
      Write-Output "PwndaWallet: administrator rights were declined; the mining scheduled task, the WinRing0 driver service and any Defender exclusions were left in place."
    }
    exit 0
  }
  # Already elevated (e.g. an admin running the uninstaller): fall through.
}

# ── Part 2 — elevated. ──────────────────────────────────────────────────────
# Reached either by the re-launch above or by an already-elevated uninstaller.
# NOTE: no `needsAdmin` re-check here. The parent process already decided, and
# re-deciding would get it wrong: Part 1 has by now deleted the directories
# that $ranMining was derived from, so the elevated pass would conclude there
# was nothing to do and skip the exclusion removal it was launched for.

# The scheduled task that runs xmrig with highest privileges.
& schtasks.exe /delete /tn $TASK_NAME /f 2>&1 | Out-Null

# The WinRing0 MSR driver. This is the one that matters most: leaving a
# known-vulnerable kernel driver registered after the app is gone is a real
# local-privilege-escalation surface, not untidiness.
& sc.exe stop $SERVICE_NAME 2>&1 | Out-Null
& sc.exe delete $SERVICE_NAME 2>&1 | Out-Null

# Defender exclusions, now genuinely readable.
$found = Get-OurExclusions
if ($null -ne $found) {
  foreach ($p in $found.Paths) { Remove-MpPreference -ExclusionPath $p }
  foreach ($p in $found.Processes) { Remove-MpPreference -ExclusionProcess $p }
}

# The legacy wildcard forms the pre-2026-07-07 MSI added across all profiles.
# Enumeration cannot see these as "ours" reliably, so they are named.
foreach ($sub in $RUNTIME_SUBDIRS) {
  Remove-MpPreference -ExclusionPath "C:\Users\*\AppData\Roaming\$BUNDLE_ID\$sub"
}

exit 0
