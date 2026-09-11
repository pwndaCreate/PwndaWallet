<#
.SYNOPSIS
    Mint the GPG key that signs the PWNDA apt/rpm repositories. Run ONCE.

.DESCRIPTION
    An apt repository is trusted because its `Release` file is signed and the
    user installed the matching public key. That key is a DISTRIBUTION
    CREDENTIAL: whoever holds it can put a package on every machine that added
    the repo, with no further check. It is the same class of secret as
    TAURI_SIGNING_PRIVATE_KEY, and it is minted the same way -- deliberately,
    by the operator, once, outside the repo.

    Writes:
      <out>/pwnda-repo-key.asc      PRIVATE. Never commit, never upload.
      <out>/pwnda-repo-key.pub.asc  public, armored   -> published as KEY.asc
      <out>/pwnda-repo-key.gpg      public, dearmored -> published as KEY.gpg
                                    (what `signed-by=` in sources.list wants)

    Default <out> is $HOME, matching where the snapshot signing key lives.

    Refuses to overwrite an existing key. Rotating one is not a re-run: every
    machine that added the repo trusts the OLD key, and replacing it without a
    transition breaks `apt update` for all of them.

.PARAMETER Out
    Directory to write the keys into. Default: $HOME.

.PARAMETER Name
    UID on the key. Default: "PWNDA Wallet Repository".

.PARAMETER Email
    UID email. Default: pwndamining@gmail.com.

.EXAMPLE
    .\scripts\mint-repo-key.ps1
#>
[CmdletBinding()]
param(
  [string]$Out = $HOME,
  [string]$Name = "PWNDA Wallet Repository",
  [string]$Email = "pwndamining@gmail.com"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot/..").Path
$Image = "ivangabriele/tauri:debian-bookworm-20"

$priv = Join-Path $Out "pwnda-repo-key.asc"
$pubA = Join-Path $Out "pwnda-repo-key.pub.asc"
$pubD = Join-Path $Out "pwnda-repo-key.gpg"

# Refuse rather than overwrite. A repo key that changes silently is worse than
# no repo: every subscriber's `apt update` starts failing with a signature
# error they cannot diagnose.
foreach ($f in @($priv, $pubA, $pubD)) {
  if (Test-Path $f) {
    Write-Error @"
$f already exists.

Refusing to overwrite. If this key is live, minting another one breaks
"apt update" on every machine that added the repository -- they trust the key
they installed, and nothing tells them to change.

To genuinely rotate: publish the new public key alongside the old one, sign
one release with BOTH, give subscribers time to pick up the new key, and only
then retire the old. Move these files aside by hand once you have decided that
is what you are doing.
"@
    exit 1
  }
}

# GPG runs in the container, not on the host: no dependency on Gpg4win being
# installed or on which gpg happens to be first in PATH, and the generated key
# never touches a host keyring where it could be picked up by accident.
#
# --batch with a parameter file rather than --quick-gen-key: the latter cannot
# set expiry and usage in one shot across gpg versions, and this is the one
# command in the ceremony that must behave identically wherever it runs.
$inner = @'
set -euo pipefail
export GNUPGHOME=/tmp/gnupg
mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"

cat > /tmp/params <<PARAMS
Key-Type: RSA
Key-Length: 4096
Key-Usage: sign
Name-Real: ${KEY_NAME}
Name-Email: ${KEY_EMAIL}
Expire-Date: 0
%no-protection
%commit
PARAMS

gpg --batch --gen-key /tmp/params 2>/dev/null
FPR=$(gpg --list-secret-keys --with-colons | awk -F: '/^fpr:/ {print $10; exit}')
gpg --batch --armor --export-secret-keys "$FPR" > /out/pwnda-repo-key.asc
gpg --batch --armor --export            "$FPR" > /out/pwnda-repo-key.pub.asc
gpg --batch --export                    "$FPR" > /out/pwnda-repo-key.gpg
echo "FINGERPRINT=$FPR"
'@
# LF only: bash in the container chokes on CRLF (`$'\r': command not found`).
$inner = $inner -replace "`r`n", "`n"
$innerPath = Join-Path ([System.IO.Path]::GetTempPath()) "pwnda-mint-repo-key.sh"
[System.IO.File]::WriteAllText($innerPath, $inner, (New-Object System.Text.UTF8Encoding $false))

Write-Host "[mint-repo-key] generating a 4096-bit RSA signing key in Docker..."
$outUnix = ($Out -replace '\\', '/')
$innerUnix = ($innerPath -replace '\\', '/')

# `2>&1` is REQUIRED here -- the fingerprint is parsed out of the output -- and
# under Windows PowerShell 5.1 that turns gpg's chatter ("gpg: checking the
# trustdb", written to stderr on every run) into ErrorRecords. With
# ErrorActionPreference = Stop those abort the script.
#
# Observed 2026-09-10: the key WAS generated and all three files written, then
# the script died on the trustdb line before reporting the fingerprint or
# tightening the private key's ACL -- leaving a valid key that looked like a
# failed run, and which the overwrite guard then refused to regenerate.
#
# The exit code is the only trustworthy signal for a native process. Take it,
# and put the preference back in a `finally` so a real failure later still
# stops.
$savedEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $log = docker run --rm `
    -v "${outUnix}:/out" `
    -v "${innerUnix}:/mint.sh:ro" `
    -e "KEY_NAME=$Name" `
    -e "KEY_EMAIL=$Email" `
    $Image bash /mint.sh 2>&1
  $code = $LASTEXITCODE
} finally { $ErrorActionPreference = $savedEAP }
if ($code -ne 0) {
  $log | ForEach-Object { Write-Host $_ }
  throw "[mint-repo-key] key generation failed"
}
Remove-Item $innerPath -Force -ErrorAction SilentlyContinue

# `$log` is a mix of strings and ErrorRecords (see above), so coerce before
# matching rather than assuming Select-String sees text.
$fprLine = ($log | ForEach-Object { "$_" } | Select-String -Pattern '^FINGERPRINT=(.+)$' | Select-Object -First 1)
$fpr = if ($fprLine) { $fprLine.Matches.Groups[1].Value.Trim() } else { $null }

foreach ($f in @($priv, $pubA, $pubD)) {
  if (-not (Test-Path $f)) { throw "[mint-repo-key] expected $f and it is not there" }
}
if (-not $fpr) {
  Write-Warning "[mint-repo-key] the key files were written but the fingerprint could not be read from the log."
  Write-Warning "Read it with:  gpg --show-keys `"$pubA`""
  $fpr = "(unread - see above)"
}

# The private half must not be readable by anyone else. Docker writes it as
# root with a default umask, so the file lands world-readable; this replaces
# the inherited ACL outright rather than adding to it, because an inherited
# "Users: Read" is exactly what needs to go.
$acl = Get-Acl $priv
$acl.SetAccessRuleProtection($true, $false)   # break inheritance, copy nothing
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  $env:USERNAME, "FullControl", "Allow")))
Set-Acl $priv $acl

Write-Host ""
Write-Host "[mint-repo-key] done. fingerprint $fpr"
Write-Host ""
Write-Host "  PRIVATE  $priv"
Write-Host "           Back it up offline. Never commit it, never upload it,"
Write-Host "           never paste it into a chat or an issue."
Write-Host "  public   $pubA  (published as KEY.asc)"
Write-Host "           $pubD  (published as KEY.gpg -- what signed-by= wants)"
Write-Host ""
Write-Host "Next: .\scripts\build-linux-repo.ps1 -Version v0.6.0"
