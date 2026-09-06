#!/usr/bin/env bash
# Build the Linux variants (.deb / AppImage / .rpm) of PwndaWallet from a Linux
# or macOS host via Docker. Bash twin of scripts/build-linux-docker.ps1 — same
# image, same volumes, same inner script, so both hosts produce byte-comparable
# artifacts.
#
# Usage:
#   bash scripts/build-linux-docker.sh
#
# Prerequisites:
#   - Docker running (`docker info` succeeds)
#   - .env.local at repo root with TAURI_SIGNING_PRIVATE_KEY[_PASSWORD] for
#     signed AppImages (optional during dev; required for releases)
#
# WHY DOCKER, ON A LINUX MACHINE?
#   Because glibc is forward-compatible but not backward-compatible. A binary
#   linked against the host's glibc refuses to start on any distro with an
#   older one. Arch currently ships glibc 2.44; Ubuntu 22.04 has 2.35 and
#   Debian 12 has 2.36. Building natively on a rolling-release distro produces
#   an executable that only runs on equally-new systems — and AppImage does NOT
#   paper over this, since it bundles libraries but not libc itself.
#
#   The pinned Debian 12 image below is therefore the floor we ship against:
#   artifacts run on Debian 12+, Ubuntu 22.10+, Fedora 38+, and Arch. Build on
#   the OLDEST glibc you intend to support, never the newest.
#
#   Native `cargo build` on this machine is still the right tool for fast
#   iteration and debugging — just not for artifacts you hand to users.
#
# Performance:
#   - First run is a cold compile (~25 min). Subsequent runs reuse the named
#     volumes and complete in ~6 min.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="ivangabriele/tauri:debian-bookworm-20"

if ! docker info >/dev/null 2>&1; then
  echo "[build-linux-docker] Docker is not running or not reachable." >&2
  echo "                     Start it and retry (on Arch: sudo systemctl start docker)." >&2
  exit 1
fi

# Forward signing key env if present. Mirrors the .ps1: the password var is
# forwarded even when empty, because our keypair was generated with `--ci` (no
# password) and an unset var makes `tauri build` fall back to an interactive
# `Password:` prompt that hangs a headless container forever.
SIGNING_ARGS=()
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -f "$REPO_ROOT/.env.local" ]; then
  # shellcheck disable=SC1091
  set -a; . "$REPO_ROOT/.env.local"; set +a
fi
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  SIGNING_ARGS+=(-e "TAURI_SIGNING_PRIVATE_KEY=${TAURI_SIGNING_PRIVATE_KEY}")
  SIGNING_ARGS+=(-e "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}")
else
  echo "[build-linux-docker] no TAURI_SIGNING_PRIVATE_KEY — building UNSIGNED (fine for local testing)"
fi

echo "[build-linux-docker] image: $IMAGE"
echo "[build-linux-docker] repo:  $REPO_ROOT"

# --user keeps artifacts owned by the invoking user. The .ps1 omits this
# because Docker Desktop's mount layer already remaps ownership; on a native
# Linux host, omitting it leaves root-owned files scattered through the repo.
docker run --rm -t \
  --user "$(id -u):$(id -g)" \
  -v "${REPO_ROOT}:/io" \
  -v "pwnda-cargo-registry:/usr/local/cargo/registry" \
  -v "pwnda-cargo-git:/usr/local/cargo/git" \
  -v "pwnda-linux-node-modules:/io/node_modules" \
  -w /io \
  "${SIGNING_ARGS[@]}" \
  "$IMAGE" \
  bash /io/scripts/build-linux-inner.sh

echo "[build-linux-docker] done. Artifacts in src-tauri/target-linux/release/bundle/"
