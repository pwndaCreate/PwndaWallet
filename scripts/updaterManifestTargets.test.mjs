/**
 * The updater manifest must serve every format, and must keep serving the old
 * endpoint.
 *
 * ## What this pins
 *
 * A Tauri client looks itself up in the manifest by `{os}-{arch}`, so an
 * AppImage, a `.deb` and a `.rpm` install all read the SAME `linux-x86_64`
 * key. One key holds one URL. That is why `latest.json` alone can never serve
 * three Linux formats, and why serving the wrong one is worse than serving
 * none: the plugin hands the bytes to `install_deb`, which rejects them as
 * `InvalidUpdaterFormat` — after a ~180 MB download.
 *
 * The way out is `{{bundle_type}}` in the endpoint URL. The bundler stamps
 * `__TAURI_BUNDLE_TYPE` into each artifact, so a deb install asks for
 * `latest-deb.json`. Three things have to stay true for that to work, and each
 * is a test below:
 *
 * 1. `tauri.conf.json` uses the templated endpoint. Without it every client
 *    reads `latest.json` and Linux packages are unserved.
 * 2. The generator emits a manifest per bundle type, each with exactly one
 *    platform entry — an extra entry is a chance to install the wrong format.
 * 3. `latest.json` still exists and still serves NSIS + AppImage. Clients
 *    built before the templated endpoint have the old URL compiled in; if that
 *    file changes shape or stops being written, they stop updating, silently
 *    and permanently.
 *
 * (3) is the one worth guarding hardest: it cannot be caught by testing a new
 * build, because a new build never asks for that URL.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel).replace(/^﻿/, ""));

const GENERATOR = "scripts/make-updater-manifest.mjs";

describe("updater endpoint", () => {
  it("is templated on bundle_type", () => {
    const conf = readJson("src-tauri/tauri.conf.json");
    const endpoints = conf.plugins?.updater?.endpoints ?? [];
    expect(endpoints.length).toBeGreaterThan(0);
    expect(
      endpoints.some((e) => e.includes("{{bundle_type}}")),
      `no endpoint in tauri.conf.json uses {{bundle_type}}, so every Linux ` +
        `format would read the same manifest key and .deb/.rpm users would be ` +
        `offered an AppImage they cannot install.`
    ).toBe(true);
  });

  it("does not point a single manifest at all Linux formats", () => {
    // The failure mode the templating exists to prevent: a bare `latest.json`
    // endpoint alongside the templated one would be a fallback that serves
    // AppImage bytes to a deb install.
    const conf = readJson("src-tauri/tauri.conf.json");
    const endpoints = conf.plugins?.updater?.endpoints ?? [];
    const bare = endpoints.filter((e) => /\/latest\.json$/.test(e));
    expect(
      bare,
      `tauri.conf.json lists a bare latest.json endpoint. For a .deb or .rpm ` +
        `client that is a fallback to the WRONG artifact: it downloads the ` +
        `AppImage in full and then fails its format check. Publish ` +
        `latest.json for old clients, but do not ask for it from new ones.`
    ).toEqual([]);
  });
});

describe("manifest generator", () => {
  it("covers every format the release builds", () => {
    const src = read(GENERATOR);
    for (const type of ["nsis", "appimage", "deb", "rpm"]) {
      expect(
        src.includes(`bundleType: "${type}"`),
        `${GENERATOR} has no rule for ${type}, so no latest-${type}.json is ` +
          `written and those installs get a 404 — which the client reports to ` +
          `the user as "up to date".`
      ).toBe(true);
    }
  });

  it("still writes latest.json for clients built before the templated endpoint", () => {
    const src = read(GENERATOR);
    expect(
      src.includes("LEGACY_MANIFEST_TYPES"),
      `${GENERATOR} no longer pins what latest.json serves. Clients released ` +
        `before 2026-09-10 have that URL compiled in and cannot be changed; ` +
        `if it stops being written they never update again.`
    ).toBe(true);
    // NSIS and AppImage are what that endpoint has always served, so they are
    // what it must keep serving.
    const legacy = /LEGACY_MANIFEST_TYPES\s*=\s*\{([^}]*)\}/.exec(src);
    expect(legacy, "could not read LEGACY_MANIFEST_TYPES").not.toBeNull();
    expect(legacy[1]).toMatch(/"windows-x86_64"\s*:\s*"nsis"/);
    expect(legacy[1]).toMatch(/"linux-x86_64"\s*:\s*"appimage"/);
  });

  it("gives each per-type manifest exactly one platform entry", () => {
    // Written as a single-key object literal at the call site. Two entries
    // would mean a client could resolve a platform key that is not its own.
    const src = read(GENERATOR);
    expect(
      src.includes("writeManifest(path, { [hit.platform]: entryFor(hit) })"),
      `${GENERATOR} no longer writes per-type manifests as a single entry.`
    ).toBe(true);
  });
});
