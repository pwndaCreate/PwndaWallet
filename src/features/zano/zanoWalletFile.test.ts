/**
 * A Zano session must open the wallet file its vault entry names
 * (incident 2026-09-15).
 *
 * `ZanoImportPanel` and `useZanoSession`'s `retry` called `startZanoSync`
 * without the entry's `sidecarFile`. Zano is the one chain where that is not a
 * type error but a silent wrong answer: Rust resolves an absent name to
 * `ZANO_WALLET_FILE_NAME` ("pwnda.zan", `zano_rpc.rs::get_wallet_file`), which
 * is the migrated PRIMARY wallet's file. `ensure_wallet_file` then leaves an
 * existing file alone (`if wallet_file.exists() { return Ok(false) }`), so the
 * session opens whatever wallet already lives there — and `initZanoSession`'s
 * address cross-check "self-heals" the disagreement by deleting that file and
 * restoring the pasted seed into it.
 *
 * Source assertions, in the style of `zanoLandscapeImport.test.ts`: these call
 * sites live in a React hook and component, and this suite runs in node with no
 * renderer. Comments are stripped before matching — `lockKeepsSwapWallets.test.ts`
 * learned that when a prose mention of the old behaviour satisfied a regex that
 * the code itself did not.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Source with comments removed, so prose can never satisfy an assertion. */
function code(...parts: string[]): string {
  return readFileSync(resolve(__dirname, ...parts), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Line comments, but not the "//" inside a URL or a quoted string.
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const hook = code("useZanoSession.ts");
const panel = code("ZanoImportPanel.tsx");
const vault = code("..", "vault", "useVault.ts");

/** The `length` characters following `marker`, or "" when it is absent. */
function blockAfter(src: string, marker: string, length: number): string {
  const at = src.indexOf(marker);
  return at === -1 ? "" : src.slice(at, at + length);
}

describe("a Zano session opens the file its vault entry names", () => {
  it("positive control: every call site these assertions read still exists", () => {
    // Without this, a rename would turn each assertion below into a vacuous
    // pass against an empty string — the anti-pattern this repo names first.
    expect(hook).toContain("const start = useCallback(");
    expect(hook).toContain("const retry = useCallback(");
    expect(panel).toContain("const handleImport");
    expect(vault).toContain("const saveZanoSeedToVault = useCallback(");
  });

  it("start remembers the file it was given", () => {
    expect(blockAfter(hook, "const start = useCallback(", 800)).toContain(
      "walletFileRef.current = walletFile;"
    );
  });

  it("retry reopens that same file instead of falling back", () => {
    const retry = blockAfter(hook, "const retry = useCallback(", 300);
    expect(retry).toContain("walletFileRef.current");
    // The three-argument form IS the defect: Rust reads it as "pwnda.zan".
    expect(retry).not.toMatch(
      /start\(\s*seedLoaded,\s*sessionPassword,\s*seedPassphrase \?\? ""\s*\)/
    );
  });

  it("the import panel starts the session with the saved entry's file", () => {
    const body = blockAfter(panel, "const handleImport", 4000);
    expect(body).toMatch(/const walletFile = await saveZanoSeedToVault\(/);
    expect(body).toMatch(/startZanoSync\([^)]*walletFile\s*\)/);
    expect(body).not.toMatch(
      /startZanoSync\(\s*seed,\s*sessionPassword,\s*passphrase\s*\)/
    );
  });

  it("the import panel does not start a session it could not save", () => {
    const body = blockAfter(panel, "const handleImport", 4000);
    const saveAt = body.indexOf("await saveZanoSeedToVault(");
    const startAt = body.indexOf("startZanoSync(");
    expect(saveAt).toBeGreaterThan(-1);
    // Save first: the entry written there is the only thing that knows which
    // file to open, so starting before it is starting without an answer.
    expect(startAt).toBeGreaterThan(saveAt);
    expect(body.slice(saveAt, startAt)).toMatch(/if \(!walletFile\) return;/);
  });

  it("the vault hands back that entry's own sidecar file", () => {
    const fn = blockAfter(vault, "const saveZanoSeedToVault = useCallback(", 2600);
    expect(fn).toContain("Promise<string | null>");
    // Resolved from the entry the write produced, not derived here:
    // `sidecarFileForEntry` returns the STORED name, so a vault upgraded in
    // place still resolves to `pwnda.zan` and no existing user rescans.
    expect(fn).toMatch(/memberOfKind\(contextForWallet\(/);
    expect(fn).toContain("sidecarFileForEntry(");
  });
});
