# Baked build image for the Linux release.
#
# The base image lacks xdg-utils, which Tauri's AppImage bundler needs
# (/usr/bin/xdg-open, embedded for the `opener` plugin registered in
# lib.rs::run). build-linux-inner.sh installs it when missing -- and that meant
# `apt-get update` plus ~48 packages on EVERY release, ~45s of the Linux half,
# repeated forever to produce an identical result.
#
# Baking it here makes that a one-time cost. The inner script keeps its
# `command -v xdg-open` guard, so it still works against the bare base image if
# this one has not been built; the guard is a fallback now rather than the
# mechanism.
#
# Node 22 (2026-10-06): the base image ships Node 20, and the Sui SDK 2.x
# (`@mysten/sui`, with graphql 17 and @noble/*) requires Node >= 22. The tag in
# build-linux-docker.ps1 (`$BakedImage`) names the Node major, so an image
# baked before this line is not reused.
#
# Pinned to the same base tag build-linux-docker.ps1 uses -- if that moves, move
# it here too, or the release silently builds against a different toolchain than
# the compile preflight.
FROM ivangabriele/tauri:debian-bookworm-20

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends xdg-utils \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y -qq nodejs \
 && node --version | grep -q '^v22\.' \
 && rm -rf /var/lib/apt/lists/*
