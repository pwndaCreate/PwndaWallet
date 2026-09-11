<#
.SYNOPSIS
    Build and sign the PWNDA apt + rpm repositories from this release's
    packages.

.DESCRIPTION
    The in-app updater installs .deb/.rpm with `dpkg -i` / `rpm -U`, which do
    not resolve dependencies. A real repository does: `apt upgrade` pulls in
    whatever a new version needs, works with unattended-upgrades, and asks for
    root through the same prompt every other system update uses. It is the
    native Linux answer, and it is what the dependency-drift guard
    (check-linux-deps.mjs) points at as the escape hatch when a release
    genuinely needs a new library.

    Writes TWO trees, because the 173 MB packages decide where everything can
    live:

      release-assets/  the apt repository (flat) AND both packages. Goes to a
                       rolling GitHub release tag, which allows 2 GB per file.
      pages/           the rpm metadata and the public key -- a few KB. Goes to
                       gh-pages, which rejects any file over 100 MB on push.

    apt concatenates its sources.list URL with `Filename:` instead of honouring
    an absolute one, so its packages must sit under the archive root; release
    asset URLs are a flat namespace, which is exactly apt's flat-repository
    format. dnf always fetches `<baseurl>/repodata/...` and cannot be flat, but
    createrepo_c's `--location-prefix` makes the package href absolute, so its
    metadata can live on Pages while the package comes from the same assets.

    Runs in Docker, so no Linux tooling is needed on the host.

    The repository serves the CURRENT release only. Older versions stay on
    their own GitHub release pages; keeping them here would mean re-uploading
    every past package on every publish.

    This does not publish. `publish-linux-repo.ps1` does that.

.PARAMETER Version
    Release to add, e.g. v0.6.0. Its .deb and .rpm must already be built.

.PARAMETER Repo
    Where the repository tree lives. Default: <repo>/.release-repo

.PARAMETER Key
    Armored GPG private key from mint-repo-key.ps1.
    Default: $HOME/pwnda-repo-key.asc

.PARAMETER GhRepo
    owner/name of the public repo. Decides both published URLs.
    Default: pwndaCreate/PwndaWallet

.PARAMETER Tag
    Rolling release tag that holds the apt repository and both packages.
    Default: linux-repo

.PARAMETER AllowUnsigned
    Generate the tree without a key. For inspecting the layout only --
    publish-linux-repo.ps1 refuses an unsigned tree.

.EXAMPLE
    .\scripts\build-linux-repo.ps1 -Version v0.6.0
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Version,
  [string]$Repo,
  [string]$Key,
  [string]$GhRepo = "pwndaCreate/PwndaWallet",
  [string]$Tag = "linux-repo",
  [switch]$AllowUnsigned
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot/..").Path
$Image = "ivangabriele/tauri:debian-bookworm-20"
if (-not $Repo) { $Repo = Join-Path $RepoRoot ".release-repo" }
if (-not $Key)  { $Key  = Join-Path $HOME "pwnda-repo-key.asc" }

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

if ($Version -notmatch '^v\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$') {
  Die "Version must look like v1.2.3 - got '$Version'"
}
$bare = $Version -replace '^v', ''

# ── Find this release's packages ─────────────────────────────────────────
#
# The staged `publish/` dir first: those are the renamed artifacts that were
# actually uploaded, so a repo built from them serves byte-identical files to
# what the download page offers. Fall back to the raw bundle dirs when the
# repo is being built outside a release run.
$publish = Join-Path $RepoRoot "src-tauri/target/release/bundle/publish"
$linuxBundle = Join-Path $RepoRoot "src-tauri/target-linux/release/bundle"
$candidates = @()
if (Test-Path $publish) { $candidates += Get-ChildItem "$publish/*" -Include *.deb, *.rpm -ErrorAction SilentlyContinue }
if (-not $candidates) {
  $candidates += Get-ChildItem "$linuxBundle/deb/*.deb" -ErrorAction SilentlyContinue
  $candidates += Get-ChildItem "$linuxBundle/rpm/*.rpm" -ErrorAction SilentlyContinue
}
$pkgs = @($candidates | Where-Object { $_.Name -match [regex]::Escape($bare) })
$deb = @($pkgs | Where-Object { $_.Extension -eq ".deb" })
$rpm = @($pkgs | Where-Object { $_.Extension -eq ".rpm" })

if ($deb.Count -ne 1 -or $rpm.Count -ne 1) {
  Die @"
[build-linux-repo] need exactly one .deb and one .rpm for $bare; found $($deb.Count) and $($rpm.Count).

Looked in:
  $publish
  $linuxBundle/{deb,rpm}

Build them first (.\scripts\build-linux-docker.ps1), or check that the version
in the filenames matches $bare.
"@
}
Write-Host "[build-linux-repo] deb: $($deb[0].Name)"
Write-Host "[build-linux-repo] rpm: $($rpm[0].Name)"

# Stage the two packages alone. The container copies everything it finds in
# /pkgs, and the bundle dirs are never cleaned -- mounting one directly would
# quietly publish every stale version sitting in it.
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "pwnda-repo-pkgs-$bare"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item $deb[0].FullName $stage
Copy-Item $rpm[0].FullName $stage

# ── Key ──────────────────────────────────────────────────────────────────
$keyStage = Join-Path ([System.IO.Path]::GetTempPath()) "pwnda-repo-key-$PID"
$keyArgs = @()
if (Test-Path $Key) {
  if (Test-Path $keyStage) { Remove-Item -Recurse -Force $keyStage }
  New-Item -ItemType Directory -Force $keyStage | Out-Null
  Copy-Item $Key (Join-Path $keyStage "key.asc")
  $keyArgs = @("-v", "$(($keyStage -replace '\\','/')):/key:ro")
} elseif (-not $AllowUnsigned) {
  Die @"
[build-linux-repo] no repository signing key at $Key

An unsigned apt repository requires "[trusted=yes]" in the user's sources
line, which switches off the only check that makes a repository safer than a
random download. That is not a default worth having.

Mint one:  .\scripts\mint-repo-key.ps1
Or pass -AllowUnsigned to inspect the tree layout without publishing it.
"@
} else {
  Write-Warning "no key at $Key - generating an UNSIGNED tree (-AllowUnsigned)"
}

New-Item -ItemType Directory -Force $Repo | Out-Null

# The two public URLs, derived from $GhRepo so they cannot drift apart.
#
# apt reads EVERYTHING from the release assets: it concatenates its
# sources.list URL with `Filename:` rather than honouring an absolute one, so
# the packages have to sit under the archive root, and only release assets can
# hold a 173 MB file (gh-pages is capped at 100 MB per file on push).
#
# dnf cannot use a flat namespace -- it always fetches `<baseurl>/repodata/...`
# and an asset name cannot contain a slash -- so its few KB of metadata go to
# Pages, with the package href pointed back at the assets.
$owner = $GhRepo.Split('/')[0]
$name  = $GhRepo.Split('/')[1]
$assetBase = "https://github.com/$GhRepo/releases/download/$Tag"
$pagesBase = "https://$($owner.ToLower()).github.io/$name"

$inner = Join-Path $RepoRoot "scripts/build-linux-repo-inner.sh"
$dockerArgs = @(
  "run", "--rm",
  "-v", "$(($stage -replace '\\','/')):/pkgs:ro",
  "-v", "$(($Repo  -replace '\\','/')):/out",
  "-v", "$(($inner -replace '\\','/')):/build.sh:ro",
  "-e", "VERSION=$bare",
  "-e", "ASSET_BASE=$assetBase",
  "-e", "PAGES_BASE=$pagesBase"
) + $keyArgs + @($Image, "bash", "/build.sh")

Write-Host "[build-linux-repo] generating repository in Docker..."
# `apt-get` inside the container writes an unavoidable debconf notice to
# stderr. Under Windows PowerShell 5.1, a native command's stderr becomes an
# ErrorRecord the moment a CALLER pipes this script's output — which, with
# ErrorActionPreference = Stop, aborts a run that was succeeding. The exit code
# is the only trustworthy signal for a native process, so take that and put the
# preference back.
$savedEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try { & docker @dockerArgs; $code = $LASTEXITCODE }
finally { $ErrorActionPreference = $savedEAP }

Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
if (Test-Path $keyStage) { Remove-Item -Recurse -Force $keyStage -ErrorAction SilentlyContinue }
if ($code -ne 0) { throw "[build-linux-repo] repository generation failed" }

$unsigned = Test-Path (Join-Path $Repo ".unsigned")
Write-Host ""
Write-Host ("[build-linux-repo] release assets : " + (Join-Path $Repo 'release-assets') + "  (apt repo + both packages)")
Write-Host ("[build-linux-repo] pages tree     : " + (Join-Path $Repo 'pages') + "  (rpm metadata + keys)")
if ($unsigned) {
  Write-Warning "UNSIGNED - inspect only; publish-linux-repo.ps1 will refuse it."
} else {
  $fpr = (Get-Content (Join-Path $Repo ".fingerprint") -Raw).Trim()
  Write-Host "[build-linux-repo] signed by $fpr"
  Write-Host "[build-linux-repo] next: .\scripts\publish-linux-repo.ps1"
}
