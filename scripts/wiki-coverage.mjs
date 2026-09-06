// =============================================================================
// scripts/wiki-coverage.mjs — Wiki ↔ source-tree coverage gap detector
// =============================================================================
//
// Role: Workstream D of the code-structure-improvement-plan
//       (PwndaWalletVault/wiki/synthesis/code-structure-improvement-plan.md).
//
// The plan adds a *relational layer* to the wiki: every wiki page that
// documents code carries a `source_files:` list in its YAML frontmatter, and
// the [[surfaces-matrix]] maps components → {portrait, landscape, lite}. The
// Obsidian Dataview plugin can query that frontmatter — but Dataview only sees
// the *notes*, never the actual `src/**` tree. So it can answer "which pages
// claim to document X" but NOT "which source files have no page at all."
//
// This script closes that blind spot. It:
//   1. Walks the source tree (src/, src-tauri/src/, src-lite/) collecting
//      every .ts / .tsx / .rs file, normalized to repo-root-relative
//      forward-slash paths.
//   2. Walks PwndaWalletVault/wiki/ collecting every `source_files:` entry
//      referenced by any page's frontmatter (the union across all pages).
//   3. Diffs the two sets to find source files no wiki page references.
//   4. Prints a summary + the gap list grouped by top-level directory.
//
// It is ADVISORY by default (always exit 0) so it can be wired into `prebuild`
// as a non-blocking warning. Pass `--strict` to make it exit 1 when gaps exist
// (useful for a dedicated CI lane that should fail on undocumented code).
//
// No external dependencies — the frontmatter parse, list parse, and directory
// walk are all hand-rolled against node:fs / node:path only, so it runs with a
// bare `node scripts/wiki-coverage.mjs` and never drags devDeps into prebuild.
//
// Usage:
//   node scripts/wiki-coverage.mjs            # advisory, exit 0
//   node scripts/wiki-coverage.mjs --strict   # exit 1 if any gaps
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Repo root is one level up from this script (scripts/ lives at the repo root).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// Source roots to scan for documentable code.
const SOURCE_ROOTS = ["src", "src-tauri/src", "src-lite"];

// File extensions that count as "source" for coverage purposes.
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".rs"]);

// Where the wiki lives.
const WIKI_ROOT = "PwndaWalletVault/wiki";

// Any path containing one of these segments is skipped entirely (build output,
// vendored deps, cargo target dirs). Matched against forward-slash paths.
const EXCLUDED_SEGMENTS = ["node_modules", "target", "target-sandbox", "target-linux", "dist"];

// CLI flags.
const STRICT = process.argv.includes("--strict");

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an absolute path to a repo-root-relative, forward-slash path.
 * e.g. "G:\\PwndaWalletDevelopment\\src\\App.tsx" -> "src/App.tsx"
 */
function toRepoRelative(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

/**
 * True if a forward-slash path contains any excluded segment as a full path
 * component (so "target" matches "src-tauri/target/..." but not a file literally
 * named "targeting.ts").
 */
function isExcluded(relPath) {
  const parts = relPath.split("/");
  return parts.some((part) => EXCLUDED_SEGMENTS.includes(part));
}

// ---------------------------------------------------------------------------
// Directory walk (hand-rolled, recursive, no glob dependency)
// ---------------------------------------------------------------------------

/**
 * Recursively walk `dirAbs`, invoking `onFile(absFilePath)` for every regular
 * file. Directories whose normalized relative path hits an excluded segment are
 * pruned (we never descend into node_modules / target / etc.). Missing roots
 * are silently skipped — not every product variant has every source root.
 */
function walk(dirAbs, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    // Root (or subdir) doesn't exist or isn't readable — skip it.
    return;
  }

  for (const entry of entries) {
    const childAbs = path.join(dirAbs, entry.name);
    const childRel = toRepoRelative(childAbs);

    // Prune excluded directories before descending — cheap and avoids walking
    // huge build trees.
    if (isExcluded(childRel)) continue;

    if (entry.isDirectory()) {
      walk(childAbs, onFile);
    } else if (entry.isFile()) {
      onFile(childAbs);
    }
    // (symlinks and other entry types are intentionally ignored)
  }
}

// ---------------------------------------------------------------------------
// Step 1 — collect source files
// ---------------------------------------------------------------------------

/**
 * Returns a sorted array of repo-root-relative source-file paths across all
 * SOURCE_ROOTS that match SOURCE_EXTENSIONS and aren't excluded.
 */
function collectSourceFiles() {
  const found = new Set();

  for (const root of SOURCE_ROOTS) {
    const rootAbs = path.join(REPO_ROOT, root);
    walk(rootAbs, (absFile) => {
      const ext = path.extname(absFile).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) return;
      const rel = toRepoRelative(absFile);
      if (isExcluded(rel)) return; // defensive; walk already prunes dirs
      found.add(rel);
    });
  }

  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Step 2 — parse wiki frontmatter for source_files references
// ---------------------------------------------------------------------------

/**
 * Extract the YAML frontmatter block from a markdown string.
 *
 * Frontmatter is the text between the first pair of lines that are exactly
 * "---" (the opening delimiter must be the very first line of the file, modulo
 * a possible UTF-8 BOM / leading blank lines). Returns the inner block text, or
 * null if the file has no frontmatter.
 */
function extractFrontmatter(md) {
  // Strip a leading BOM if present, then normalize line endings.
  const text = md.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  // Find the opening '---'. Allow leading blank lines but nothing else before.
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length || lines[start].trim() !== "---") return null;

  // Find the closing '---' after the opening one.
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(start + 1, i).join("\n");
    }
  }
  // Opening delimiter with no closing delimiter — treat as no frontmatter.
  return null;
}

/**
 * Strip surrounding single/double quotes from a scalar, plus trailing inline
 * comments and whitespace. Returns "" for empty / placeholder values.
 */
function cleanScalar(raw) {
  let s = raw.trim();
  if (!s) return "";
  // Drop wrapping quotes.
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Parse the `source_files:` value out of a frontmatter block. Supports two
 * authoring styles seen in the wiki:
 *
 *   (a) inline JSON-array style on the key line:
 *         source_files: [src/a.ts, "src/b.tsx", 'src/c.rs']
 *
 *   (b) YAML block style — the key line is bare, items follow as indented
 *       "  - path" lines until the next non-indented key or dedent:
 *         source_files:
 *           - src/a.ts
 *           - src/b.tsx
 *
 * Returns an array of cleaned path strings (possibly empty). Robust to a
 * missing key (returns []).
 */
function parseSourceFiles(frontmatter) {
  if (!frontmatter) return [];
  const lines = frontmatter.split("\n");

  // Locate the `source_files:` key (top-level, i.e. not indented under another
  // key). We accept any leading indentation of 0 for the key itself.
  let keyIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)source_files\s*:(.*)$/);
    if (m) {
      keyIdx = i;
      // The remainder after the colon, for the inline-array case.
      var keyIndent = m[1].length;
      var inlineRest = m[2];
      break;
    }
  }
  if (keyIdx === -1) return [];

  const results = [];

  // ---- Case (a): inline array on the key line --------------------------------
  const inline = inlineRest.trim();
  if (inline.startsWith("[")) {
    // Collect the bracketed content; it may (rarely) span lines, so keep
    // appending following lines until we balance the closing ']'.
    let buf = inline;
    let i = keyIdx;
    while (!buf.includes("]") && i + 1 < lines.length) {
      i++;
      buf += " " + lines[i].trim();
    }
    const inner = buf.slice(buf.indexOf("[") + 1, buf.lastIndexOf("]"));
    for (const part of inner.split(",")) {
      const v = cleanScalar(part);
      if (v) results.push(v);
    }
    return results;
  }

  // If there's a non-array scalar directly on the key line, take it as a single
  // value (defensive; not the documented style but cheap to support).
  if (inline && !inline.startsWith("#")) {
    const v = cleanScalar(inline.replace(/#.*$/, ""));
    if (v) results.push(v);
    // A scalar on the key line means no block list follows.
    return results;
  }

  // ---- Case (b): YAML block list of "  - path" items ------------------------
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // blank lines within the block are fine
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // A line at or below the key's indentation that isn't a list item ends the
    // block (it's the next frontmatter key).
    const itemMatch = line.match(/^\s*-\s+(.*)$/);
    if (!itemMatch) {
      if (indent <= keyIndent) break;
      // Indented but not a list item — unexpected; stop to stay robust.
      break;
    }
    const v = cleanScalar(itemMatch[1].replace(/#.*$/, ""));
    if (v) results.push(v);
  }

  return results;
}

/**
 * Walk the wiki, parse every .md file's frontmatter, and return the union (as a
 * Set) of all referenced source paths, normalized to forward-slash. Paths in
 * frontmatter are already expected repo-root-relative; we just normalize
 * separators defensively.
 */
function collectReferencedSources() {
  const referenced = new Set();
  const wikiAbs = path.join(REPO_ROOT, ...WIKI_ROOT.split("/"));

  walk(wikiAbs, (absFile) => {
    if (path.extname(absFile).toLowerCase() !== ".md") return;
    let content;
    try {
      content = fs.readFileSync(absFile, "utf8");
    } catch {
      return;
    }
    const fm = extractFrontmatter(content);
    if (!fm) return; // no frontmatter — fine, just contributes nothing
    for (const ref of parseSourceFiles(fm)) {
      referenced.add(ref.split("\\").join("/"));
    }
  });

  return referenced;
}

// ---------------------------------------------------------------------------
// Step 3 / 4 — diff and report
// ---------------------------------------------------------------------------

function main() {
  const sourceFiles = collectSourceFiles();
  const referenced = collectReferencedSources();

  // Coverage gap: source files referenced by no wiki page.
  const gaps = sourceFiles.filter((f) => !referenced.has(f));

  const total = sourceFiles.length;
  const documented = total - gaps.length;

  // ---- Summary line ---------------------------------------------------------
  console.log(
    `wiki-coverage: ${documented} of ${total} source files documented, ${gaps.length} gap${gaps.length === 1 ? "" : "s"}`
  );

  // ---- Gap list grouped by top-level dir, sorted ----------------------------
  if (gaps.length > 0) {
    // Group by the first path segment (the top-level dir, e.g. "src",
    // "src-tauri", "src-lite").
    const groups = new Map();
    for (const gap of gaps) {
      const top = gap.split("/")[0];
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(gap);
    }

    console.log("");
    console.log("Undocumented source files (no wiki page references them):");
    for (const top of [...groups.keys()].sort()) {
      const filesInGroup = groups.get(top).sort();
      console.log("");
      console.log(`  ${top}/  (${filesInGroup.length})`);
      for (const f of filesInGroup) {
        console.log(`    ${f}`);
      }
    }
    console.log("");
  }

  // ---- Exit code ------------------------------------------------------------
  // Advisory by default (exit 0); --strict turns gaps into a failure.
  if (STRICT && gaps.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
