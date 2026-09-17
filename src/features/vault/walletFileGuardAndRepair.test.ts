/**
 * The two protections added to `useVault` on 2026-09-16, as wired:
 *
 *  - The flat import saves refuse to REPLACE a different seed the open context
 *    already holds (`flatSeedRefusal`), and they ask before anything is
 *    written. Without it, an import panel shown for a context that already had
 *    that coin swapped the entry's seed — the only stored copy — while keeping
 *    its file, and the next session deleted the old wallet's file.
 *  - Unlock and wallet switch repair entries that share a wallet file
 *    (`repairSharedSidecarFiles`) before any session opens one. A vault written
 *    before the naming fix of the same day can hold such a pair.
 *
 * The helpers are tested behaviourally in `src/vault-schema.test.ts`. This file
 * pins the wiring, as source assertions with comments stripped and positive
 * controls — the hook needs a renderer this node suite does not have. Same
 * style as `src/features/monero/moneroZephyrWalletFile.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const vault = readFileSync(resolve(__dirname, "useVault.ts"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  // Line comments, but not the "//" inside a URL or a quoted string.
  .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** From `from` up to (not including) the next `to`, or "" if either is absent. */
function blockBetween(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a === -1) return "";
  const b = src.indexOf(to, a + from.length);
  return b === -1 ? "" : src.slice(a, b);
}

describe("the flat import saves refuse to replace a different seed", () => {
  for (const [fn, kind, coin] of [
    ["saveXmrSeedToVault", "xmr", "Monero"],
    ["saveZphSeedToVault", "zph", "Zephyr"],
    ["saveZanoSeedToVault", "zano", "Zano"],
  ] as const) {
    const block = blockBetween(vault, `const ${fn} = useCallback(`, "const save");

    it(`${fn}: positive control`, () => {
      expect(block).toContain("await loadVault(");
      expect(block).toContain("await saveVault(");
    });

    it(`${fn}: asks about its own kind, after reading and before writing`, () => {
      const guardAt = block.indexOf(`flatSeedRefusal(payload, "${kind}"`);
      expect(guardAt).toBeGreaterThan(block.indexOf("await loadVault("));
      expect(guardAt).toBeLessThan(block.indexOf("await saveVault("));
    });

    it(`${fn}: a refusal writes nothing, says why, and hands back no file`, () => {
      const branch = blockBetween(block, "if (refusal) {", "}");
      expect(branch).toContain(`setError(replaceRefusedMessage("${coin}", refusal));`);
      expect(branch).toContain("return null;");
    });
  }

  it("Zano's guard compares the passphrase as well", () => {
    expect(vault).toContain(
      'flatSeedRefusal(payload, "zano", zanoSeed, zanoSeedPassphrase)',
    );
  });

  it("the refusal points somewhere a second wallet CAN be added", () => {
    const message = blockBetween(vault, "function replaceRefusedMessage(", "\n}\n");
    expect(message).toContain("Add wallet in Settings ▸ Wallets");
  });
});

describe("unlock and wallet switch repair shared wallet files first", () => {
  const unlock = blockBetween(vault, "const handleUnlock = useCallback(", "const handleRemoveWallet");
  const sw = blockBetween(vault, "const switchWallet = useCallback(", "\n  return {\n");

  it("positive control", () => {
    expect(unlock).toContain("startXmrSync(");
    expect(unlock).toContain("startZphSync(");
    expect(sw).toContain("startXmrSync(");
    expect(sw).toContain("startZphSync(");
  });

  it("unlock repairs the vault it loaded before resolving any entry or session", () => {
    const loadAt = unlock.indexOf("await loadVaultV3(");
    const repairAt = unlock.indexOf("repairSharedSidecarFiles(loaded)");
    expect(loadAt).toBeGreaterThan(-1);
    expect(repairAt).toBeGreaterThan(loadAt);
    for (const later of ["contextForWallet(", "startXmrSync(", "startZphSync(", "startZanoSync("]) {
      expect(repairAt).toBeLessThan(unlock.indexOf(later));
    }
    // Nothing in unlock reads the vault around the repair.
    expect(unlock.match(/await loadVaultV3\(/g)).toHaveLength(1);
  });

  it("unlock saves the repair in a try of its own, so a failed write is not 'Incorrect password'", () => {
    expect(unlock).toMatch(/try \{\s*await saveVaultV3\(v3, loginPassword\);\s*\} catch/);
  });

  it("unlock tells the user what it repaired", () => {
    expect(unlock).toContain("setSuccess(describeRepairs(repairs));");
  });

  it("wallet switch repairs before it saves or opens anything", () => {
    const repairAt = sw.indexOf("repairSharedSidecarFiles(await loadVaultV3(");
    expect(repairAt).toBeGreaterThan(-1);
    expect(repairAt).toBeLessThan(sw.indexOf("await saveVaultV3("));
    expect(repairAt).toBeLessThan(sw.indexOf("startXmrSync("));
    expect(sw.match(/await loadVaultV3\(/g)).toHaveLength(1);
  });

  it("wallet switch reports the repair in the one notice it leaves on screen", () => {
    // The first version set the repair notice early and then overwrote it with
    // "Switched to …" — the sandbox run showed the repair and no notice.
    expect(sw.match(/setSuccess\(/g)).toHaveLength(1);
    const last = sw.slice(sw.lastIndexOf("setSuccess("));
    expect(last).toContain("Switched to");
    expect(last).toContain("describeRepairs(repairs)");
  });

  it("unlock sets no later notice that would hide the repair's", () => {
    expect(unlock.match(/setSuccess\(/g)).toHaveLength(1);
  });
});
