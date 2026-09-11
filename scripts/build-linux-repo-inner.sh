#!/usr/bin/env bash
#
# Generate and sign the apt + rpm repositories. Runs INSIDE the container;
# scripts/build-linux-repo.ps1 is the wrapper that mounts everything.
#
# Why a file rather than an inline here-string: Windows PowerShell 5.1
# word-splits multi-line strings when forwarding them as `docker ... -c`
# arguments, which fragments the bash and fails with "unexpected end of file".
# build-linux-docker.ps1 hit that first; this follows the same shape.
#
# ===========================================================================
# WHERE THE PACKAGES LIVE, AND WHY IT IS NOT A gh-pages BRANCH
# ===========================================================================
#
# The first version of this pushed everything to `gh-pages`. That cannot work:
#
#     remote: error: File apt/pool/main/PwndaWallet-0.6.0-amd64.deb is
#     173.21 MB; this exceeds GitHub's file size limit of 100.00 MB
#     ! [remote rejected] gh-pages -> gh-pages (pre-receive hook declined)
#
# Git LFS does not rescue it either — GitHub Pages serves the LFS POINTER, not
# the object, so apt would download a 130-byte text file. Release assets have
# a 2 GB limit, so that is where the packages have to be.
#
# apt cannot then keep its metadata anywhere else. Measured 2026-09-10: apt
# CONCATENATES the sources.list URL with `Filename:`, it does not honour an
# absolute URL —
#
#     Filename: https://example.invalid/x.deb
#     -> 'file:/flat/https://example.invalid/x.deb'
#
# so the packages must sit under the archive root. Release asset URLs are a
# FLAT namespace (`/releases/download/<tag>/<name>`, no slashes allowed in a
# name), which is exactly apt's flat-repository format: `deb <url> ./`, with
# `Packages` and the .debs side by side. Verified end to end over HTTP with
# `signed-by=` enforced: InRelease accepted, 428 dependencies resolved, the
# 182 MB package downloaded.
#
# dnf cannot use a flat layout — it always fetches `<baseurl>/repodata/...`,
# and an asset name cannot contain a slash. But createrepo_c's
# `--location-prefix` makes the package href ABSOLUTE, and dnf honours it:
# verified with metadata on one port and the .rpm only on another, dnf fetched
# all 173.2 MiB from the second. So rpm splits — a few KB of repodata on
# Pages, the package itself from the same release assets apt uses.
#
# Inputs (env):
#   VERSION       bare version, e.g. 0.6.0
#   ASSET_BASE    URL the release assets are served from (no trailing slash)
#   PAGES_BASE    URL the gh-pages site is served from (no trailing slash)
#   REPO_ORIGIN   Origin/Label field, default PWNDA
# Mounts:
#   /pkgs   this release's .deb + .rpm (read-only)
#   /out    where to write `release-assets/` and `pages/`
#   /key    the armored GPG private key (read-only), if signing
set -euo pipefail

log() { echo "[repo] $*"; }

: "${VERSION:?VERSION is required}"
: "${ASSET_BASE:?ASSET_BASE is required}"
: "${PAGES_BASE:?PAGES_BASE is required}"
REPO_ORIGIN="${REPO_ORIGIN:-PWNDA}"

log "installing repo tooling"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq apt-utils createrepo-c gnupg >/dev/null

DEB=$(find /pkgs -maxdepth 1 -name '*.deb' | head -1)
RPM=$(find /pkgs -maxdepth 1 -name '*.rpm' | head -1)
[ -n "$DEB" ] || { echo "[repo] no .deb in /pkgs" >&2; exit 1; }
[ -n "$RPM" ] || { echo "[repo] no .rpm in /pkgs" >&2; exit 1; }
log "deb: $(basename "$DEB")"
log "rpm: $(basename "$RPM")"

ASSETS=/out/release-assets
PAGES=/out/pages
rm -rf "$ASSETS" "$PAGES"
mkdir -p "$ASSETS" "$PAGES/rpm"

cp "$DEB" "$RPM" "$ASSETS/"

# ── APT: flat repository, entirely in the release assets ─────────────────
cd "$ASSETS"
# `sed` strips the leading `./` apt-ftparchive emits, leaving a bare filename
# — which is what resolves against a flat asset namespace.
#
# NO `--arch amd64`: that option belongs to `generate` mode and silently
# produces an EMPTY index here (measured: 0 bytes with it, 867 without), on
# packages that already declare Architecture: amd64 themselves. A published
# empty index is the worst outcome available, because `apt update` still
# succeeds and only `apt install` reports nothing found.
apt-ftparchive packages . | sed 's#^Filename: \./#Filename: #' > Packages
gzip -9kf Packages

PKG_COUNT=$(grep -c '^Package:' Packages || true)
if [ "$PKG_COUNT" -eq 0 ]; then
  echo "[repo] REFUSING: the apt index is empty." >&2
  echo "[repo] $(ls -1 ./*.deb 2>/dev/null | wc -l) .deb present but not indexed." >&2
  exit 1
fi
log "apt: $PKG_COUNT package(s) indexed (flat)"

apt-ftparchive -o "APT::FTPArchive::Release::Origin=${REPO_ORIGIN}" \
               -o "APT::FTPArchive::Release::Label=${REPO_ORIGIN}" \
               -o "APT::FTPArchive::Release::Suite=stable" \
               -o "APT::FTPArchive::Release::Architectures=amd64" \
               -o "APT::FTPArchive::Release::Description=PWNDA Wallet" \
               release . > Release

# ── RPM: metadata for Pages, package href pointing at the assets ─────────
cp "$RPM" "$PAGES/rpm/"
createrepo_c --quiet --location-prefix "${ASSET_BASE}/" "$PAGES/rpm"
# The package is served from the release assets, not from Pages — it is only
# here so createrepo_c can read it. Removing it is what keeps the gh-pages
# branch under GitHub's 100 MB per-file push limit.
rm -f "$PAGES/rpm/"*.rpm
log "rpm: metadata written, packages point at $ASSET_BASE"

# ── Signing ──────────────────────────────────────────────────────────────
#
# UNSIGNED IS NOT A FALLBACK. An unsigned apt repo needs `[trusted=yes]` in the
# sources line, which turns off the only check that makes a repository safer
# than a random download — and it is exactly the kind of instruction users
# copy without reading. If there is no key the trees are still generated (so
# the layout can be inspected) but marked, and the publisher refuses them.
if [ -f /key/key.asc ]; then
  export GNUPGHOME=/tmp/gnupg
  mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
  gpg --batch --quiet --import /key/key.asc
  FPR=$(gpg --list-secret-keys --with-colons | awk -F: '/^fpr:/ {print $10; exit}')
  log "signing as $FPR"

  # Both forms. Release.gpg is the detached signature older apt wants;
  # InRelease is the inline-signed file modern apt fetches first. Publishing
  # only one leaves some clients doing an extra failed request and some older
  # ones unable to verify at all.
  cd "$ASSETS"
  rm -f Release.gpg InRelease
  gpg --batch --yes --armor --detach-sign -o Release.gpg Release
  gpg --batch --yes --clearsign           -o InRelease   Release

  # dnf's repo_gpgcheck verifies repomd.xml.
  rm -f "$PAGES/rpm/repodata/repomd.xml.asc"
  gpg --batch --yes --armor --detach-sign -o "$PAGES/rpm/repodata/repomd.xml.asc" \
      "$PAGES/rpm/repodata/repomd.xml"

  # The key goes to BOTH places, so neither audience has to visit the other's
  # host to get it: apt users never touch Pages, dnf users never touch the
  # release assets.
  gpg --batch --armor --export "$FPR" > "$PAGES/KEY.asc"
  gpg --batch --export           "$FPR" > "$PAGES/KEY.gpg"
  cp "$PAGES/KEY.asc" "$PAGES/KEY.gpg" "$ASSETS/"
  echo "$FPR" > /out/.fingerprint
  rm -f /out/.unsigned
  log "signed; public key exported to both trees"
else
  log "WARNING: no key at /key/key.asc -- trees generated UNSIGNED"
  : > /out/.unsigned
  rm -f /out/.fingerprint
fi

# ── Convenience files ────────────────────────────────────────────────────
cat > "$PAGES/rpm/pwnda.repo" <<REPO
[pwnda]
name=PWNDA Wallet
baseurl=${PAGES_BASE}/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=${PAGES_BASE}/KEY.asc
REPO

cat > "$PAGES/index.html" <<HTML
<!doctype html><meta charset="utf-8"><title>PWNDA Wallet — Linux packages</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem}
pre{background:#111;color:#eee;padding:1rem;overflow-x:auto;border-radius:6px}code{font-size:.9em}</style>
<h1>PWNDA Wallet — Linux packages</h1>
<p>Add the repository once; updates then arrive through your package manager.</p>
<h2>Debian / Ubuntu</h2>
<pre><code>curl -fsSL ${PAGES_BASE}/KEY.gpg | sudo tee /usr/share/keyrings/pwnda.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/pwnda.gpg] ${ASSET_BASE}/ ./" | sudo tee /etc/apt/sources.list.d/pwnda.list
sudo apt update &amp;&amp; sudo apt install pwnda-wallet</code></pre>
<h2>Fedora / RHEL</h2>
<pre><code>sudo curl -fsSL -o /etc/yum.repos.d/pwnda.repo ${PAGES_BASE}/rpm/pwnda.repo
sudo dnf install pwnda-wallet</code></pre>
<p>Signing key fingerprint: <code>$(cat /out/.fingerprint 2>/dev/null || echo 'UNSIGNED BUILD')</code></p>
HTML

log "done -> $ASSETS (release assets) and $PAGES (gh-pages)"
