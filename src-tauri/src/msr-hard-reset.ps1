#
# PwndaWallet — MSR Hard Reset
#
# Single elevated batch invoked by msr_hard_reset() Tauri command via
# `Start-Process powershell -Verb RunAs -Wait`. One UAC consent runs the
# entire driver+exclusion+privilege chain.
#
# Steps (all best-effort, never aborts the script on a partial failure):
#   1. Clear any WinRing0 service collision
#   2. Refresh Windows Defender exclusions for runtime files
#   3. Grant SeLockMemoryPrivilege to the current user via secedit
#

param(
    [Parameter(Mandatory=$true)] [string] $MinersDir,
    [Parameter(Mandatory=$false)] [string] $UserName = $env:USERNAME
)

$ErrorActionPreference = 'Continue'
Write-Host "PwndaWallet Hard Reset starting (MinersDir=$MinersDir, User=$UserName)"

# ─── Step 1: Clear WinRing0 service collision ─────────────────────────────
Write-Host "[1/3] Clearing WinRing0_1_2_0 service registration..."
& sc.exe stop WinRing0_1_2_0 2>$null | Out-Null
& sc.exe delete WinRing0_1_2_0 2>$null | Out-Null

# ─── Step 2: Refresh Defender exclusions ──────────────────────────────────
Write-Host "[2/3] Refreshing Windows Defender exclusions..."
$paths = @(
    $MinersDir,
    (Join-Path $MinersDir 'WinRing0x64.sys'),
    (Join-Path $MinersDir 'xmrig.log'),
    (Join-Path $MinersDir 'xmrig.log.err'),
    (Join-Path $MinersDir 'xmrig.log.prev')
)
foreach ($p in $paths) {
    try { Remove-MpPreference -ExclusionPath $p -ErrorAction SilentlyContinue } catch {}
    try { Add-MpPreference    -ExclusionPath $p -ErrorAction SilentlyContinue } catch {}
}
$processes = @(
    (Join-Path $MinersDir 'xmrig.exe')
)
foreach ($p in $processes) {
    try { Remove-MpPreference -ExclusionProcess $p -ErrorAction SilentlyContinue } catch {}
    try { Add-MpPreference    -ExclusionProcess $p -ErrorAction SilentlyContinue } catch {}
}

# ─── Step 3: Grant SeLockMemoryPrivilege via secedit ──────────────────────
# Required for --huge-pages-jit (and full --huge-pages) to allocate large
# memory pages without falling back. Granted at the user level so the
# normal-token Tauri app and the elevated xmrig.exe both inherit it.
# Takes effect at next logon.
Write-Host "[3/3] Granting SeLockMemoryPrivilege to $UserName..."

$tmpInf = Join-Path $env:TEMP 'pwnda_selock.inf'
$tmpDb  = Join-Path $env:TEMP 'pwnda_selock.sdb'
try { Remove-Item $tmpInf -Force -ErrorAction SilentlyContinue } catch {}
try { Remove-Item $tmpDb  -Force -ErrorAction SilentlyContinue } catch {}

& secedit.exe /export /cfg "$tmpInf" /quiet 2>$null

if (Test-Path $tmpInf) {
    $content = Get-Content -Path $tmpInf -Encoding Unicode
    $patched = $false
    $newContent = foreach ($line in $content) {
        if ($line -match '^SeLockMemoryPrivilege\s*=\s*(.*)$') {
            $patched = $true
            $existing = $matches[1].Trim()
            if (-not $existing) {
                "SeLockMemoryPrivilege = $UserName"
            } elseif ($existing -notmatch [regex]::Escape($UserName)) {
                "SeLockMemoryPrivilege = $existing,$UserName"
            } else {
                $line
            }
        } else {
            $line
        }
    }
    if (-not $patched) {
        # No SeLockMemoryPrivilege line existed; insert one under [Privilege Rights]
        $newContent = & {
            foreach ($line in $newContent) {
                $line
                if ($line -match '^\[Privilege Rights\]\s*$') {
                    "SeLockMemoryPrivilege = $UserName"
                }
            }
        }
    }
    Set-Content -Path $tmpInf -Value $newContent -Encoding Unicode
    & secedit.exe /configure /db "$tmpDb" /cfg "$tmpInf" /quiet 2>$null
    try { Remove-Item $tmpInf -Force -ErrorAction SilentlyContinue } catch {}
    try { Remove-Item $tmpDb  -Force -ErrorAction SilentlyContinue } catch {}
    Write-Host "    Privilege granted (effective at next logon)"
} else {
    Write-Warning "secedit /export produced no output — SeLockMemoryPrivilege grant skipped"
}

Write-Host "PwndaWallet Hard Reset complete."
exit 0
