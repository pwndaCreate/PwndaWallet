import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 2026-09-15. Lock refused while a swap used a shared wallet, because locking
// closed that wallet under the swap: Zano Main was killed, and the Zephyr
// wallet was closed inside the process the swap node keeps. Lock now leaves the
// wallets to the node and says so on the lock screen. Removing a wallet still
// refuses, because it deletes wallet files.
//
// Structural on purpose: `useVault` is a large hook, and what must not come
// back is the SHAPE (an early return on an in-use answer, a forget on lock).
const src = readFileSync(new URL("./useVault.ts", import.meta.url), "utf8");

/** The callback's CODE, with line comments removed. The first version of this
 *  test searched the raw text and failed on the comment that quotes the old
 *  refusal message, a failure for the wrong reason. */
function callbackBody(name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} moved`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  }, [", start);
  expect(end, `${name} end moved`).toBeGreaterThan(start);
  return src.slice(start, end).replace(/^\s*\/\/.*$/gm, "");
}

describe("Lock keeps a swap's wallets for the swap node", () => {
  const logout = callbackBody("handleLogout");

  it("does not refuse the lock when a swap uses a shared wallet", () => {
    expect(logout).not.toContain("before locking");
    expect(logout).not.toMatch(/HostWalletInUse\([^)]*\)\)\s*\{\s*setError/);
    expect(logout).toContain('keptOpen.push("Monero")');
    expect(logout).toContain("keptOpen.push(name)");
  });

  it("locks the Zephyr and Zano sessions instead of forgetting them", () => {
    expect(logout).toContain("void lockXmrSession();");
    expect(logout).toContain("void lockZanoSession();");
    expect(logout).toContain("void lockZphSession();");
    expect(logout).not.toContain("void forgetZanoSession();");
    expect(logout).not.toContain("void forgetZphSession();");
  });

  it("tells the user the swap continues", () => {
    expect(logout).toContain("so it can finish");
  });
});

describe("Removing a wallet still refuses while a swap uses it", () => {
  it("keeps both removal refusals", () => {
    const refusals = src.split("finish or abandon it before removing").length - 1;
    expect(refusals).toBe(2);
  });
});
