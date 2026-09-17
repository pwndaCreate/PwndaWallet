/**
 * Monero and Zephyr sessions must open — and rebuild — the wallet file their
 * vault entry names (incident 2026-09-16). The XMR/ZPH twin of
 * `src/features/zano/zanoWalletFile.test.ts`. It lives here and covers both
 * chains because the two hooks, panels and call sites are one defect.
 *
 * An absent filename is not an error for these chains: `initXmrSession` /
 * `initZphSession` default it to the PRIMARY wallet's legacy file
 * (`pwnda-active` / `pwnda-zph-active`), and their address-mismatch self-heal
 * deletes the file they opened. Four paths left the name out:
 *  - the hooks' own `retry`, and with it the automatic retry after a sync error;
 *  - portrait's Retry closures in `ViewRouter`, which re-derived the arguments;
 *  - both dashboard import panels;
 *  - `ScanDateCard`'s rescan, whose helpers defaulted to the legacy name and
 *    delete the file FIRST.
 *
 * The naming half (`mergeFlatIntoV3` gave a second context's new wallet Main's
 * file name) is pinned behaviourally in `src/vault-schema.test.ts`.
 *
 * Source assertions with comments stripped, plus positive controls, as in
 * `zanoWalletFile.test.ts`: these sites are React hooks and components, and
 * this suite runs in node with no renderer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..");

/** Comments removed, so prose can never satisfy an assertion. */
function stripComments(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Line comments, but not the "//" inside a URL or a quoted string.
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const code = (path: string) => stripComments(readFileSync(join(ROOT, path), "utf8"));

/** From `from` up to (not including) the next `to`, or "" if either is absent. */
function blockBetween(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a === -1) return "";
  const b = src.indexOf(to, a + from.length);
  return b === -1 ? "" : src.slice(a, b);
}

/**
 * Every call `name(...)` in `src`, as its top-level argument list. Brackets of
 * all three kinds nest; strings are not parsed, which is enough for these call
 * sites (none has a bracket inside a quoted argument).
 */
function calls(src: string, name: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const args: string[] = [];
    let depth = 0;
    let arg = "";
    for (let i = m.index + m[0].length; i < src.length; i++) {
      const c = src[i];
      if ("([{".includes(c)) {
        depth++;
      } else if (")]}".includes(c)) {
        if (depth === 0) {
          if (arg.trim()) args.push(arg.trim());
          break;
        }
        depth--;
      } else if (c === "," && depth === 0) {
        args.push(arg.trim());
        arg = "";
        continue;
      }
      arg += c;
    }
    out.push(args);
  }
  return out;
}

/** Every non-test .ts/.tsx file under `dir`. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the call-argument parser (control)", () => {
  it("splits top-level arguments and keeps nested ones whole", () => {
    // If this were wrong in the permissive direction, the sweep below could
    // pass for the wrong reason.
    expect(calls("f(a, g(b, c), { d: [e, f] }, h ?? 0)", "f")).toEqual([
      ["a", "g(b, c)", "{ d: [e, f] }", "h ?? 0"],
    ]);
    expect(calls("x.f(a,\n  b,\n)", "f")).toEqual([["a", "b"]]);
    expect(calls("restart(a)", "start")).toEqual([]);
  });
});

describe("every Monero/Zephyr session start names its wallet file", () => {
  // The one site allowed to omit it: creating a brand-new vault. Its entries
  // are written a moment earlier by a merge with no existing vault, which
  // gives them the legacy names — exactly what an absent name resolves to.
  // Any other omission is this defect.
  const CREATE_PATH_SEEDS = new Set(["pendingXmrSeed", "pendingZphSeed"]);

  const found: Array<{ file: string; fn: string; args: string[] }> = [];
  for (const full of sourceFiles(join(ROOT, "src"))) {
    const src = stripComments(readFileSync(full, "utf8"));
    for (const fn of ["startXmrSync", "startZphSync"]) {
      for (const args of calls(src, fn)) {
        found.push({ file: relative(ROOT, full).split("\\").join("/"), fn, args });
      }
    }
  }

  it("positive control: the sweep finds the known call sites", () => {
    // unlock, addWallet and switchWallet (two each), both import panels, and
    // the create path's two.
    expect(found.length).toBeGreaterThanOrEqual(10);
    expect(found.some((c) => c.file.endsWith("XmrImportPanel.tsx"))).toBe(true);
    expect(found.some((c) => c.file.endsWith("ZphImportPanel.tsx"))).toBe(true);
    expect(found.filter((c) => CREATE_PATH_SEEDS.has(c.args[0]))).toHaveLength(2);
  });

  it("every other call passes a fourth argument, the wallet file", () => {
    const missing = found
      .filter((c) => !CREATE_PATH_SEEDS.has(c.args[0]))
      .filter((c) => c.args.length < 4)
      .map((c) => `${c.file}: ${c.fn}(${c.args.join(", ")})`);
    expect(missing).toEqual([]);
  });
});

describe("retry reopens the same file at the same height", () => {
  for (const [label, path] of [
    ["Monero", "src/features/monero/useXmrSession.ts"],
    ["Zephyr", "src/features/zephyr/useZphSession.ts"],
  ] as const) {
    const hook = code(path);
    const start = blockBetween(hook, "const start = useCallback(", "const retry = useCallback(");
    const retry = blockBetween(hook, "const retry = useCallback(", "const checkBinaryStatus");
    const reset = blockBetween(hook, "const resetState = useCallback(", "}, []);");

    it(`${label}: positive control`, () => {
      expect(start).not.toBe("");
      expect(retry).not.toBe("");
      expect(reset).not.toBe("");
      // The automatic retry is why this bites without a click.
      expect(hook).toMatch(/errorAutoRetryRef[\s\S]*\bretry\(\)/);
    });

    it(`${label}: start remembers the file and the height`, () => {
      expect(start).toContain("startArgsRef.current = { restoreHeight, walletFilename };");
    });

    it(`${label}: retry replays both, never the two-argument form`, () => {
      expect(calls(retry, "start")).toEqual([
        ["seedLoaded", "sessionPassword", "args.restoreHeight", "args.walletFilename"],
      ]);
    });

    it(`${label}: a session that ended leaves nothing to replay`, () => {
      expect(reset).toContain("startArgsRef.current = null;");
    });
  }
});

describe("portrait Retry is the hooks' retry", () => {
  const router = code("src/ViewRouter.tsx");
  const xmr = blockBetween(router, "xmrSession={{", "}}");
  const zph = blockBetween(router, "zphSession={{", "}}");

  it("positive control", () => {
    expect(xmr).toContain("syncState: xmrSyncState");
    expect(zph).toContain("syncState: zphSyncState");
  });

  it("hands DashboardView the hooks' own retry", () => {
    expect(xmr).toMatch(/onRetry: retryXmrSync,/);
    expect(zph).toMatch(/onRetry: retryZphSync,/);
  });

  it("never re-derives a session start from the loaded seed", () => {
    expect(calls(router, "startXmrSync")).toEqual([]);
    expect(calls(router, "startZphSync")).toEqual([]);
  });
});

describe("the import panels save first and open the file the entry names", () => {
  for (const [label, path, save, startFn] of [
    ["Monero", "src/features/monero/XmrImportPanel.tsx", "saveXmrSeedToVault", "startXmrSync"],
    ["Zephyr", "src/features/zephyr/ZphImportPanel.tsx", "saveZphSeedToVault", "startZphSync"],
  ] as const) {
    const body = blockBetween(code(path), "const handleImport", "return (");

    it(`${label}: positive control`, () => {
      expect(body).toContain(`${startFn}(`);
    });

    it(`${label}: the session opens the saved entry's file`, () => {
      expect(body).toMatch(new RegExp(`const walletFile = await ${save}\\(`));
      const starts = calls(body, startFn);
      expect(starts).toHaveLength(1);
      expect(starts[0][3]).toBe("walletFile");
    });

    it(`${label}: nothing starts before the save, or after a failed one`, () => {
      const saveAt = body.indexOf(`await ${save}(`);
      const startAt = body.indexOf(`${startFn}(`);
      expect(saveAt).toBeGreaterThan(-1);
      expect(startAt).toBeGreaterThan(saveAt);
      expect(body.slice(saveAt, startAt)).toMatch(/if \(!walletFile\) return;/);
    });
  }
});

describe("the flat save helpers hand back the saved entry's file", () => {
  const vault = code("src/features/vault/useVault.ts");

  for (const [fn, kind] of [
    ["saveXmrSeedToVault", "xmr"],
    ["saveZphSeedToVault", "zph"],
  ] as const) {
    const block = blockBetween(vault, `const ${fn} = useCallback(`, "const save");

    it(`${fn}: positive control`, () => {
      expect(block).toContain("await saveVault(");
    });

    it(`${fn}: resolves the entry the write produced`, () => {
      expect(block).toContain("Promise<string | null>");
      const reads = calls(block, "savedSidecarFile");
      expect(reads).toHaveLength(1);
      expect(reads[0][2]).toBe(`"${kind}"`);
      // Read AFTER the write, or it describes the vault before the import.
      expect(block.indexOf("savedSidecarFile(")).toBeGreaterThan(block.indexOf("await saveVault("));
    });
  }

  it("savedSidecarFile returns the name the entry stores", () => {
    const helper = blockBetween(vault, "function savedSidecarFile(", "\n}\n");
    expect(helper).toMatch(/memberOfKind\(contextForWallet\(/);
    // `sidecarFileForEntry` returns the STORED name, so the migrated primary
    // still resolves to its legacy file and nobody's wallet moves.
    expect(helper).toContain("sidecarFileForEntry(");
  });
});

describe("a rescan rebuilds the wallet the card is about", () => {
  const card = code("src/features/settings/ScanDateCard.tsx");

  it("positive control", () => {
    expect(calls(card, "rescanXmrFromHeight")).toHaveLength(1);
    expect(calls(card, "rescanZphFromHeight")).toHaveLength(1);
  });

  it("passes the saved entry's file to both rescans", () => {
    for (const fn of ["rescanXmrFromHeight", "rescanZphFromHeight"]) {
      const [args] = calls(card, fn);
      expect(args).toHaveLength(4);
      expect(args[3]).toBe("file");
    }
    expect(card).toMatch(/const file = await saveXmrSeedToVault\(/);
    expect(card).toMatch(/const file = await saveZphSeedToVault\(/);
  });

  it("the rescan helpers have no default file to fall back to", () => {
    for (const [path, fn] of [
      ["src/wallets/xmr-wallet.ts", "rescanXmrFromHeight"],
      ["src/wallets/zph-wallet.ts", "rescanZphFromHeight"],
    ] as const) {
      const sig = blockBetween(code(path), `export async function ${fn}(`, "): Promise<void>");
      expect(sig).toContain("walletFilename: string"); // control
      expect(sig).not.toMatch(/walletFilename: string\s*=/);
    }
  });
});
