/**
 * Every signed artifact the build produces must actually reach the release.
 *
 * ## The failures this pins
 *
 * Twice now a release has looked complete while quietly dropping something the
 * build had already made, and both times the gap was a missing glob in
 * `release-local.ps1`:
 *
 * 1. **2026-09-04** — the script globbed only `target/`, so every `.deb`,
 *    `.rpm` and `.AppImage` was built by the Docker Linux job and never
 *    uploaded. The release was Windows-only and did not look it.
 * 2. **2026-09-06 → 2026-09-10** — the packages were globbed, but their
 *    SIGNATURES were not. `createUpdaterArtifacts: true` makes tauri-bundler
 *    sign every Linux bundle, not just the AppImage: v0.6.0's build wrote
 *    `PwndaWallet_0.6.0_amd64.deb.sig` and `…x86_64.rpm.sig` at 21:51 and
 *    neither was ever staged.
 *
 * The second one is why `.deb`/`.rpm` looked like formats Tauri "cannot"
 * self-update. It can: `tauri-plugin-updater` 2.10.1 implements `install_deb`
 * and `install_rpm`. The signature they need was being left on the build
 * machine, and the absence was invisible because the release still carried
 * both packages.
 *
 * Same shape both times: an artifact produced by the build, absent from the
 * release, and nothing downstream saying what it expected to find.
 *
 * ## Why a source-text test
 *
 * `release-local.ps1` is PowerShell and needs Docker, a signing key and ~30
 * minutes, so it cannot be executed here. What CAN be checked cheaply is the
 * part that actually broke — the staging list and the rename table, which are
 * plain data in the script. Same trade `updateBannerParity.test.ts` makes, for
 * the same reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");

const SCRIPT = "scripts/release-local.ps1";

/**
 * Formats the bundler signs when `createUpdaterArtifacts` is on, written as the
 * extension that appears in the staging globs.
 *
 * `.msi` is deliberately absent: `bundle.targets` is `["nsis"]` as of
 * 2026-09-06, and the script documents at length why the msi glob must not
 * come back.
 */
const SIGNED_FORMATS = [".exe", ".deb", ".rpm", ".AppImage"];

/**
 * Rename cases are matched on the bare extension NAME, not the whole pattern,
 * because they are not uniformly shaped: the Windows case carries the
 * bundler's `-setup` infix while the Linux ones do not. Searching for
 * `exe\.sig$` finds the case whatever precedes it, and still cannot match the
 * bare-extension case `-setup\.exe$` — which is the distinction these tests
 * turn on.
 */
const bare = (ext) => ext.slice(1);

describe("release artifact staging", () => {
  it("stages a .sig alongside every signed format", () => {
    const src = read(SCRIPT);
    const block = /\$patterns\s*=\s*@\(([\s\S]*?)\n\)/.exec(src);
    expect(block, `could not find the $patterns array in ${SCRIPT}`).not.toBeNull();
    const patterns = block[1];

    for (const ext of SIGNED_FORMATS) {
      expect(
        patterns.includes(`*${ext}"`),
        `${SCRIPT} no longer stages *${ext} at all`
      ).toBe(true);
      expect(
        patterns.includes(`*${ext}.sig"`),
        `${SCRIPT} stages *${ext} but not *${ext}.sig. The bundler signs this ` +
          `format; an artifact uploaded without its signature can never be an ` +
          `updater target, because make-updater-manifest.mjs verifies a ` +
          `signature before listing a platform and every client rejects an ` +
          `entry without one. This is the 2026-09-10 defect.`
      ).toBe(true);
    }
  });

  it("has a rename mapping for every .sig it stages", () => {
    const src = read(SCRIPT);
    // A `.sig` that is staged but falls through the rename switch is copied
    // under its BUILD name, which then no longer matches the artifact it
    // signs — and make-updater-manifest.mjs pairs them by name.
    for (const ext of SIGNED_FORMATS) {
      expect(
        src.includes(`${bare(ext)}\\.sig$'`),
        `${SCRIPT} stages *${ext}.sig but the rename switch has no case for ` +
          `it, so it would publish under its build name and stop pointing at ` +
          `the artifact it signs.`
      ).toBe(true);
    }
  });

  it("keeps each .sig case ahead of its bare-extension case", () => {
    // Both patterns are `$`-anchored, so order is not load-bearing today. A
    // later edit that drops an anchor would make `'\.deb$'` swallow
    // `foo.deb.sig` and mis-stage it silently; asserting the order means that
    // edit has to argue with a test.
    const src = read(SCRIPT);
    for (const ext of SIGNED_FORMATS) {
      const sigAt = src.indexOf(`${bare(ext)}\\.sig$'`);
      const bareAt = src.indexOf(`${bare(ext)}$'`);
      if (sigAt === -1 || bareAt === -1) continue; // covered above
      expect(
        sigAt < bareAt,
        `the ${ext} rename case comes before its .sig case in ${SCRIPT}`
      ).toBe(true);
    }
  });
});
