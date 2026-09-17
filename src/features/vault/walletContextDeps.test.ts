/**
 * Every `useVault` callback that READS `activeWalletId` must also depend on it.
 *
 * ## Why this is not a style rule
 *
 * `useVault` takes `activeWalletId` — the wallet context the user is on — and
 * hands it to `loadVault`/`saveVault`, which is what makes a write land in the
 * wallet the switcher shows. That threading is the fix for the 2026-08-29
 * report ("I imported a new wallet seed phrase to see my LTC address, however
 * the app still was displaying the main LTC address").
 *
 * But `saveXmrSeedToVault`, `saveZphSeedToVault`, `saveZanoSeedToVault` and the
 * six derivation handlers left `activeWalletId` out of their dependency arrays,
 * and every other dependency they list is stable: `setError` / `setSuccess` are
 * `useCallback(…, [])` in `AppStateContext`, and `sessionPassword` changes only
 * at unlock. So each of those callbacks kept the `activeWalletId` of the render
 * that created it, and after `switchWallet` a seed save or a derivation change
 * wrote into the PREVIOUS context — the same wrong-wallet write the threading
 * exists to prevent, reintroduced by memoization.
 *
 * Found 2026-09-15 while adding the Xelis save helper: its deps were being
 * written, and the three beside it read a value they did not list.
 *
 * Structural, like `lockKeepsSwapWallets.test.ts`: the hook needs a full React
 * tree to run, and what must not come back is the SHAPE.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./useVault.ts", import.meta.url), "utf8");

interface Callback {
  name: string;
  /** Everything before the dependency array. */
  body: string;
  /** The dependency array, `[` to `]`. */
  deps: string;
}

/**
 * Split each `const NAME = useCallback(...)` into body and dependency array.
 * Both closing styles in this file are handled: `\n  );` and `\n  ]);`.
 */
function callbacks(): Callback[] {
  const out: Callback[] = [];
  const re = /const (\w+) = useCallback\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    const ends = [src.indexOf("\n  );", start), src.indexOf("\n  ]);", start)].filter(
      (i) => i > -1,
    );
    if (ends.length === 0) continue;
    const block = src.slice(start, Math.min(...ends));
    const depsStart = block.lastIndexOf("[");
    const depsEnd = block.lastIndexOf("]");
    if (depsStart < 0 || depsEnd < depsStart) continue;
    out.push({
      name: m[1],
      body: block.slice(0, depsStart),
      deps: block.slice(depsStart, depsEnd + 1),
    });
  }
  return out;
}

describe("useVault callbacks keep the wallet context they write to", () => {
  const all = callbacks();

  it("positive control: the callbacks and their dependency arrays were parsed", () => {
    expect(all.length).toBeGreaterThan(8);
    expect(all.map((c) => c.name)).toContain("saveXelisSeedToVault");
    for (const c of all) {
      expect(c.deps.startsWith("["), `${c.name}: deps not parsed`).toBe(true);
      expect(c.deps.endsWith("]"), `${c.name}: deps not parsed`).toBe(true);
    }
  });

  it("control: the save helpers and derivation handlers are among the readers", () => {
    // Without this, a parser that found no readers would make the assertion
    // below pass for the wrong reason.
    const readers = all.filter((c) => c.body.includes("activeWalletId")).map((c) => c.name);
    expect(readers).toEqual(
      expect.arrayContaining([
        "saveXmrSeedToVault",
        "saveZphSeedToVault",
        "saveZanoSeedToVault",
        "saveXelisSeedToVault",
        "handleChangeSolanaDerivation",
        "handleApplyProfile",
      ]),
    );
  });

  it("every callback that reads activeWalletId lists it as a dependency", () => {
    const offenders = all
      .filter((c) => c.body.includes("activeWalletId") && !c.deps.includes("activeWalletId"))
      .map((c) => c.name);
    expect(
      offenders,
      "these callbacks read activeWalletId but do not depend on it, so after a " +
        "wallet switch they write into the context that was open when they were created",
    ).toEqual([]);
  });
});
