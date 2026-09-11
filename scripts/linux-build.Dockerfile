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
# Pinned to the same base tag build-linux-docker.ps1 uses -- if that moves, move
# it here too, or the release silently builds against a different toolchain than
# the compile preflight.
FROM ivangabriele/tauri:debian-bookworm-20

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends xdg-utils \
 && rm -rf /var/lib/apt/lists/*
