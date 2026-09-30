/**
 * The consolidate and legacy-sweep panels say "may have been sent" for an
 * unknown outcome (2026-09-29 send-safety audit, found by the docs pass).
 *
 * The UTXO send fix made a lost broadcast throw `SendOutcomeUnknownError`
 * with the txid. These three panels caught every error the same way: the LTC
 * consolidation went back to "Review — nothing has been sent" with Send
 * enabled, and both legacy sweeps showed it as a plain failure. Source
 * assertions, like `layout-parity.test.ts`: the panels need a full wallet to
 * render.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

describe("an unknown outcome is never 'nothing has been sent'", () => {
  it.each([
    ["UtxoAccountCard.tsx (consolidate)", "UtxoAccountCard.tsx"],
    ["BtcLegacyPanel.tsx (legacy BTC sweep)", "BtcLegacyPanel.tsx"],
    ["LitecoinDerivationPanel.tsx (legacy LTC move)", "LitecoinDerivationPanel.tsx"],
  ])("%s checks for it before its plain-error branch", (_label, file) => {
    const src = read(file);
    const check = src.indexOf("isSendOutcomeUnknown(e)");
    expect(check, "no isSendOutcomeUnknown(e) check").toBeGreaterThan(-1);
    // The plain-error handling that follows the check in the same catch.
    const plain = src.slice(check).search(/set(?:State|Migrate|Error)\(\s*(?:\{\s*kind: "error"|e instanceof Error)/);
    expect(plain, "no plain-error branch after the check").toBeGreaterThan(-1);
    expect(src).toContain("may have been sent");
  });

  it("the consolidation does not return to Review (with Send enabled) on it", () => {
    const src = read("UtxoAccountCard.tsx");
    const branch = /if \(isSendOutcomeUnknown\(e\)\) \{([\s\S]*?)return;/.exec(src);
    expect(branch).not.toBeNull();
    expect(branch![1]).toContain('setStage("unknown")');
    expect(branch![1]).not.toContain('setStage("review")');
  });
});
