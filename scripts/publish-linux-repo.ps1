<#
.SYNOPSIS
    Publish the apt/rpm repository: assets to a rolling release tag, metadata
    to GitHub Pages.

.DESCRIPTION
    Two destinations, because the packages are ~173 MB each and GitHub rejects
    any file over 100 MB on push:

      release-assets/ -> a rolling release tag (2 GB per asset). Holds the
                         flat apt repository -- Packages, Release, InRelease,
                         Release.gpg -- and BOTH packages. apt reads
                         everything from here.
      pages/          -> the gh-pages branch. A few KB: the rpm repodata
                         (whose package href points back at the assets) and
                         the public key.

    The first attempt at this pushed the packages to gh-pages and was rejected:

        remote: error: File apt/pool/main/PwndaWallet-0.6.0-amd64.deb is
        173.21 MB; this exceeds GitHub's file size limit of 100.00 MB

    Git LFS does not help -- Pages serves the LFS pointer, not the object.

    REFUSES an unsigned tree. An unsigned apt repository needs `[trusted=yes]`
    in the user's sources line, which turns off the only check that makes a
    repository safer than a random download.

.PARAMETER Repo
    The tree from build-linux-repo.ps1. Default: <repo>/.release-repo

.PARAMETER GhRepo
    owner/name of the public repo. Default: pwndaCreate/PwndaWallet

.PARAMETER Tag
    Rolling release tag holding the apt repo. Default: linux-repo

.PARAMETER EnablePages
    Enable GitHub Pages after pushing. Needed once, on the first publish --
    GitHub refuses to enable Pages for a branch that does not exist yet, so it
    cannot be done in advance.

.PARAMETER WhatIf
    Print what would be published and stop.

.EXAMPLE
    .\scripts\publish-linux-repo.ps1 -EnablePages
#>
[CmdletBinding()]
param(
  [string]$Repo,
  [string]$GhRepo = "pwndaCreate/PwndaWallet",
  [string]$Tag = "linux-repo",
  [switch]$EnablePages,
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot/..").Path
if (-not $Repo) { $Repo = Join-Path $RepoRoot ".release-repo" }
$assets = Join-Path $Repo "release-assets"
$pages  = Join-Path $Repo "pages"

# A user-facing refusal is a SENTENCE, not a stack trace. `throw` at script
# scope prints the message, then the positional detail, then the exception
# record -- the same paragraph three times, with the actual advice buried in
# the middle. Die writes it once, in red, and exits non-zero so callers still
# see the failure. Matches Publish-ParticlSnapshot.ps1.
function Die([string]$m) {
  Write-Host ""
  Write-Host $m -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $Repo)) {
  Die "[publish-linux-repo] no repository tree at $Repo. Run build-linux-repo.ps1 first."
}
if (Test-Path (Join-Path $Repo ".unsigned")) {
  Die @"
[publish-linux-repo] REFUSING: the tree at $Repo is UNSIGNED.

Subscribers would need "[trusted=yes]" in their sources line, which disables
signature checking entirely -- and it is exactly the kind of line people paste
without reading.

Mint a key (.\scripts\mint-repo-key.ps1), then rebuild the tree.
"@
}
foreach ($required in @("release-assets/InRelease", "release-assets/Release.gpg",
                        "release-assets/Packages", "pages/rpm/repodata/repomd.xml.asc",
                        "pages/KEY.gpg", "pages/KEY.asc")) {
  if (-not (Test-Path (Join-Path $Repo $required))) {
    Die "[publish-linux-repo] $Repo is missing $required - rebuild it with build-linux-repo.ps1"
  }
}

# Neither gh call may use `2>&1`. Under Windows PowerShell 5.1 that turns a
# native command's stderr into ErrorRecords, and with ErrorActionPreference =
# Stop the script dies on them -- including on the 404 below, which is the
# EXPECTED answer when Pages has never been enabled. Exit codes are the signal.
$savedEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & gh auth status *> $null
  $authOk = ($LASTEXITCODE -eq 0)
  & gh api "repos/$GhRepo/pages" *> $null
  $pagesOn = ($LASTEXITCODE -eq 0)
  & gh release view $Tag --repo $GhRepo *> $null
  $tagExists = ($LASTEXITCODE -eq 0)
} finally { $ErrorActionPreference = $savedEAP }

if (-not $authOk) { Die "[publish-linux-repo] gh is not logged in. Run: gh auth login" }

$assetFiles = @(Get-ChildItem $assets -File)
$assetMB = [math]::Round(($assetFiles | Measure-Object Length -Sum).Sum / 1MB, 0)
$pageMB  = [math]::Round((Get-ChildItem $pages -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 2)
Write-Host "[publish-linux-repo] assets: $($assetFiles.Count) files, $assetMB MB -> $GhRepo @ $Tag"
Write-Host "[publish-linux-repo] pages : $pageMB MB -> gh-pages"

# gh-pages must stay small. If a package ever leaks into the pages tree the
# push fails at the remote with a message about LFS, which reads like a git
# problem rather than a layout one -- so check it here, where the reason is
# still obvious.
$tooBig = Get-ChildItem $pages -Recurse -File | Where-Object { $_.Length -gt 100MB }
if ($tooBig) {
  Die "[publish-linux-repo] $($tooBig[0].Name) is over 100 MB and is in the PAGES tree. " +
        "GitHub rejects that on push. Packages belong in release-assets/."
}

if ($WhatIf) {
  Write-Host "[publish-linux-repo] -WhatIf: nothing published."
  if (-not $tagExists) { Write-Host "  would create release $Tag (prerelease)" }
  if (-not $pagesOn)   { Write-Warning "GitHub Pages is NOT enabled on $GhRepo" }
  exit 0
}

# ── 1. The apt repository + packages, as release assets ──────────────────
#
# A PRERELEASE tag, always. `releases/latest` resolves to the newest
# non-prerelease release, and the updater's endpoint is built on that -- a
# repository tag marked as a normal release would silently become "latest" and
# point every updater client at a release with no latest.json.
if (-not $tagExists) {
  Write-Host "[publish-linux-repo] creating release $Tag..."
  & gh release create $Tag --repo $GhRepo --prerelease `
      --title "Linux package repository" `
      --notes "apt repository and Linux packages. Not a wallet release - see the Releases page for those."
  if ($LASTEXITCODE -ne 0) { throw "gh release create failed for $Tag" }
}

foreach ($f in $assetFiles) {
  Write-Host "  uploading $($f.Name)…"
  & gh release upload $Tag $f.FullName --repo $GhRepo --clobber
  if ($LASTEXITCODE -ne 0) { throw "gh release upload failed for $($f.Name)" }
}

# Remove assets from previous versions. The repository serves the CURRENT
# release, and a stale .deb left here is still listed by nothing but still
# occupies the tag -- worse, a half-updated tag with two versions and one
# Packages file describes a package that is no longer there.
$live = $assetFiles | ForEach-Object { $_.Name }
$savedEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $existing = (& gh release view $Tag --repo $GhRepo --json assets -q '.assets[].name') -split "`n" |
              Where-Object { $_ -and ($_.Trim() -ne "") }
} finally { $ErrorActionPreference = $savedEAP }
foreach ($name in $existing) {
  $n = $name.Trim()
  if ($live -notcontains $n) {
    Write-Host "  removing stale asset $n"
    & gh release delete-asset $Tag $n --repo $GhRepo --yes
  }
}

# ── 2. The rpm metadata + keys, to gh-pages ──────────────────────────────
$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) "pwnda-ghpages-$PID"
if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
New-Item -ItemType Directory -Force $WorkDir | Out-Null

try {
  Push-Location $WorkDir
  & git init -q .
  & git checkout -q --orphan gh-pages
  Copy-Item "$pages/*" . -Recurse -Force
  # GitHub Pages runs Jekyll by default, which SKIPS files and directories
  # beginning with an underscore or a dot and can rewrite what it serves.
  # `.nojekyll` turns that off. Without it the repodata is served with holes
  # that surface only as a client-side checksum mismatch.
  New-Item -ItemType File ".nojekyll" -Force | Out-Null

  & git add -A
  & git -c user.name="user" -c user.email="pwndamining@gmail.com" `
      commit -q -m "linux package repository - $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  if ($LASTEXITCODE -ne 0) { throw "nothing to commit" }

  & git remote add origin "https://github.com/$GhRepo.git"
  Write-Host "[publish-linux-repo] force-pushing gh-pages…"
  & git push -q --force origin gh-pages
  if ($LASTEXITCODE -ne 0) { throw "git push failed" }
} finally {
  Pop-Location
  Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "[publish-linux-repo] published."

# ── 3. Pages, which can only be enabled once the branch exists ───────────
if (-not $pagesOn) {
  if ($EnablePages) {
    Write-Host "[publish-linux-repo] enabling GitHub Pages…"
    $savedEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      # Capture rather than discard: the interesting outcomes are told apart
      # by the MESSAGE, not the exit code. Pushing a `gh-pages` branch makes
      # GitHub enable Pages on its own, so by the time this runs the POST
      # usually returns 409 "already enabled" -- a success wearing a failure's
      # exit code. Swallowing the body (as this did on 2026-09-10) turned that
      # into a warning telling the operator to run a command that would also
      # 409, on a site that was already live.
      $resp = & gh api -X POST "repos/$GhRepo/pages" `
                 -f "source[branch]=gh-pages" -f "source[path]=/" 2>&1 | Out-String
      $ok = ($LASTEXITCODE -eq 0)
      $already = $resp -match "already enabled"
    } finally { $ErrorActionPreference = $savedEAP }
    if ($ok) {
      Write-Host "[publish-linux-repo] Pages enabled; first build takes a minute or two."
      $pagesOn = $true
    } elseif ($already) {
      Write-Host "[publish-linux-repo] Pages was already enabled (GitHub turns it on when gh-pages appears)."
      $pagesOn = $true
    } else {
      Write-Warning "could not enable Pages automatically:"
      Write-Warning ($resp.Trim())
    }
  }
  if (-not $pagesOn) {
    Write-Warning @"
The gh-pages branch is pushed but Pages is not enabled, so the rpm repository
has nothing serving it. The branch had to exist first -- it now does, so:

  gh api -X POST repos/$GhRepo/pages -f "source[branch]=gh-pages" -f "source[path]=/"

apt is unaffected: it reads entirely from the release assets, which are live
already.
"@
  }
}

$owner = $GhRepo.Split('/')[0].ToLower()
$name  = $GhRepo.Split('/')[1]
Write-Host ""
Write-Host "Debian / Ubuntu:"
Write-Host "  curl -fsSL https://$owner.github.io/$name/KEY.gpg | sudo tee /usr/share/keyrings/pwnda.gpg > /dev/null"
Write-Host "  echo `"deb [signed-by=/usr/share/keyrings/pwnda.gpg] https://github.com/$GhRepo/releases/download/$Tag/ ./`" | sudo tee /etc/apt/sources.list.d/pwnda.list"
Write-Host "  sudo apt update && sudo apt install pwnda-wallet"
Write-Host ""
Write-Host "Fedora / RHEL:"
Write-Host "  sudo curl -fsSL -o /etc/yum.repos.d/pwnda.repo https://$owner.github.io/$name/rpm/pwnda.repo"
Write-Host "  sudo dnf install pwnda-wallet"
