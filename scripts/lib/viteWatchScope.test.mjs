/**
 * Pins what the Vite dev server watches (`vite.config.ts`, "What the dev
 * server watches").
 *
 * 2026-09-29: the operator's `tauri dev` server held 1.5–2.3 GB and 142,351
 * handles, one file watch per file or folder under the repo root, because the
 * watcher's only exclusion was `src-tauri`. Local work trees and caches at the
 * root were being watched file by file. After this filter it held 1,122.
 *
 * The fixture tree below uses made-up folder names on purpose: this file is
 * published, and the root's real contents are checked at run time instead of
 * being written down here.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import viteConfig, { WATCHED_ROOT_DIRS, ignoreOutsideAppSources, watchOnlyAppSources } from "../../vite.config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("watchOnlyAppSources", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vite-watch-"));
  mkdirSync(path.join(root, "src", "features"), { recursive: true });
  mkdirSync(path.join(root, "some-work-tree", "deep"), { recursive: true });
  writeFileSync(path.join(root, "index.html"), "");
  writeFileSync(path.join(root, ".env.local"), "");
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const ignored = watchOnlyAppSources(root);

  it("keeps the root, the files directly in it, and the app's source folders", () => {
    expect(ignored(root)).toBe(false);
    expect(ignored(path.join(root, "index.html"))).toBe(false);
    expect(ignored(path.join(root, ".env.local"))).toBe(false);
    expect(ignored(path.join(root, "src"))).toBe(false);
    expect(ignored(path.join(root, "src", "features", "View.tsx"))).toBe(false);
  });

  it("drops every other folder in the root and everything under it", () => {
    expect(ignored(path.join(root, "some-work-tree"))).toBe(true);
    expect(ignored(path.join(root, "some-work-tree", "deep", "big.bin"))).toBe(true);
    // A name that merely starts like an allowed folder is not that folder.
    expect(ignored(path.join(root, "srcx", "file.ts"))).toBe(true);
  });

  it("matches however chokidar spells the path", () => {
    const slashes = root.replace(/\\/g, "/");
    const otherCase = slashes.replace(/^([A-Za-z]):/, (_, d) => (d === d.toLowerCase() ? d.toUpperCase() : d.toLowerCase()) + ":");
    expect(ignored(`${otherCase}/some-work-tree/deep`)).toBe(true);
    expect(ignored(`${otherCase}/src/features`)).toBe(false);
  });

  it("leaves paths outside the root alone, including a sibling that shares its prefix", () => {
    expect(ignored(path.join(path.dirname(root), "elsewhere", "x"))).toBe(false);
    expect(ignored(`${root}-sibling${path.sep}x`)).toBe(false);
  });

  it("believes chokidar's stats instead of going to the disk", () => {
    const fresh = watchOnlyAppSources(root);
    expect(fresh(path.join(root, "not-on-disk-dir"), { isDirectory: () => true })).toBe(true);
    expect(fresh(path.join(root, "not-on-disk-file"), { isDirectory: () => false })).toBe(false);
    // With no stats and nothing on disk it keeps the path (one watch, not a blind spot).
    expect(fresh(path.join(root, "not-on-disk-either"))).toBe(false);
  });
});

describe("the repo's own dev server", () => {
  it("watches only the allowlisted folders of this checkout's root", () => {
    const watchedDirs = readdirSync(repoRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !ignoreOutsideAppSources(path.join(repoRoot, d.name)))
      .map((d) => d.name)
      .sort();
    expect(watchedDirs).toEqual([...WATCHED_ROOT_DIRS].filter((d) => existsSync(path.join(repoRoot, d))).sort());
  });

  it("keeps every entry HTML's script inside a watched folder", () => {
    for (const html of readdirSync(repoRoot).filter((f) => /^index.*\.html$/.test(f))) {
      const src = /src="\/([^"/]+)\//.exec(readFileSync(path.join(repoRoot, html), "utf8"));
      if (src) expect(WATCHED_ROOT_DIRS.has(src[1]), `${html} loads from /${src[1]}/`).toBe(true);
    }
  });

  it("hands the filter to the dev server's watcher", async () => {
    const config = await viteConfig({ command: "serve", mode: "development" });
    expect(config.server.watch.ignored).toContain(ignoreOutsideAppSources);
    expect(config.server.watch.ignored).toContain("**/src-tauri/**");
  });
});
