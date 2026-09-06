/**
 * Every test file on disk must be reachable by `vitest.config.ts`'s include
 * globs.
 *
 * ## Why this exists
 *
 * A test under a folder no glob reaches **cannot fail**. `npm run test` reports
 * it as neither passed nor failed; it is simply never loaded, and the suite
 * stays green. Vitest only complains ("No test files found", exit 1) when the
 * file is named explicitly on the command line — which is exactly what an
 * author does while writing it and never again afterwards.
 *
 * This has now happened twice:
 *
 *  - **2026-08-19** — `src/features/settings/` and `src/features/monero/` had
 *    no glob. Both host mount-point tests (the Settings DEX-coins mount, the
 *    swap node's Monero-wallet mount).
 *  - **2026-08-25** — `src/features/send/` had no glob, found while adding the
 *    account-wide-send routing tests.
 *
 * The first was fixed by adding two globs and writing a comment warning about
 * the trap. The comment did not prevent the second, because nothing reads a
 * comment. This test does what the comment was hoping for.
 *
 * It is the contributor guide's first named anti-pattern in its purest form: *a check that
 * cannot fail for the reason you run it.* An unreachable test suite is a whole
 * category of that.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");

/** Every `*.test.ts(x)` under src/, repo-relative, POSIX slashes. */
function findTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findTestFiles(full, out);
    else if (/\.test\.tsx?$/.test(entry)) {
      out.push(relative(ROOT, full).split(sep).join("/"));
    }
  }
  return out;
}

const sep = "\\";

/**
 * Parse the include array straight out of the config SOURCE rather than
 * importing the config. Importing would hand back the resolved value, which is
 * the thing under test — a bug in the globs would be invisible because both
 * sides of the comparison would come from the same place.
 */
function includeGlobs(): string[] {
  const src = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  const from = src.indexOf("include: [");
  const block = src.slice(from, src.indexOf("]", from));
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Minimal glob -> RegExp for the shapes this config uses: `**`, `*`, literals. */
function globToRegExp(glob: string): RegExp {
  // `/**/` is consumed as one unit, including its slashes, so that
  // `a/**/b.ts` matches `a/b.ts` as well as `a/x/y/b.ts`. Splitting on "/"
  // and re-joining loses that and silently demands one directory — which
  // made an earlier version of this file miss every `__tests__/` folder.
  const body = glob
    .replace(/[.+^${}()|[\]]/g, (c) => "\\" + c)
    .split("/**/")
    .map((chunk) => chunk.split("*").join("[^/]*"))
    .join("/(?:[^/]+/)*");
  return new RegExp("^" + body + "$");
}

describe("vitest include globs reach every test file", () => {
  it("matches its own known-good cases", () => {
    // The control. If `globToRegExp` were broken in the permissive direction
    // — matching everything — the real assertion below would pass for the
    // wrong reason and this file would join the category it exists to catch.
    const re = globToRegExp("src/features/send/**/*.test.ts");
    expect(re.test("src/features/send/accountSend.test.ts")).toBe(true);
    expect(re.test("src/features/send/nested/deep.test.ts")).toBe(true);
    expect(re.test("src/features/swap/other.test.ts")).toBe(false);
    // A single `*` must not cross a directory boundary — the shell-glob
    // mistake that made an earlier version of this audit report all-clear.
    expect(globToRegExp("src/*.test.ts").test("src/features/x.test.ts")).toBe(false);
    expect(globToRegExp("src/*.test.ts").test("src/store.test.ts")).toBe(true);
  });

  it("leaves no test file unreachable", () => {
    const globs = includeGlobs().map(globToRegExp);
    expect(globs.length, "parsed no globs — the config shape changed").toBeGreaterThan(5);

    const files = findTestFiles(join(ROOT, "src"));
    expect(files.length, "found no test files — the walk is broken").toBeGreaterThan(20);

    const unreachable = files.filter((f) => !globs.some((g) => g.test(f)));
    expect(
      unreachable,
      "these test files exist but no include glob reaches them, so they can " +
        "never fail — add a glob to vitest.config.ts",
    ).toEqual([]);
  });
});
