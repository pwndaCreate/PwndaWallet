#!/usr/bin/env bash
# One-shot Linux build prerequisites installer.
#
# Targets Ubuntu 22.04+ / Debian 12+. For Fedora / RHEL / Arch, install the
# equivalent packages by hand — the package names differ but the dep set is
# identical.
#
# Inside the canonical Docker image (`ivangabriele/tauri:debian-bookworm-20`),
# everything below except `rustup` is pre-installed. This script exists so a
# fresh VM / bare metal host gets to the same baseline with one command.

set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script targets Debian/Ubuntu (apt). For other distros, see"
  echo "PwndaWalletVault/wiki/synthesis/linux-port-plan.md §2.1."
  exit 1
fi

echo "[setup-linux] installing apt packages…"
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl wget file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  rpm \
  unzip \
  pkg-config

if ! command -v rustc >/dev/null 2>&1; then
  echo "[setup-linux] installing rustup (stable toolchain)…"
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[setup-linux] WARNING: node not installed. Install Node.js 20.x via"
  echo "                       nodesource or nvm before running npm scripts."
fi

echo "[setup-linux] done. Versions:"
echo "  rustc:  $(rustc --version 2>/dev/null || echo 'missing')"
echo "  cargo:  $(cargo --version 2>/dev/null || echo 'missing')"
echo "  node:   $(node --version 2>/dev/null || echo 'missing')"
echo "  npm:    $(npm --version 2>/dev/null || echo 'missing')"
echo ""
echo "Optional for XMRig RandomX hashrate:"
echo "  sudo modprobe msr"
echo "  sudo sysctl -w vm.nr_hugepages=1280"
