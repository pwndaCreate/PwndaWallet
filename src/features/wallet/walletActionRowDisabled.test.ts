/**
 * A blocked wallet action must LOOK blocked.
 *
 * Incident, 2026-09-16 (sandbox pass after the layout-parity work): with XEL
 * selected, `WalletActionRow` rendered the Swap tile with `disabled` set, and
 * the reason printed under the row — yet the tile was drawn exactly like the
 * live Send and Receive tiles (opacity 1, pointer cursor, accent green).
 * `.qbtn`, the class every tile uses, had no `:disabled` rule at all. The
 * gate was correct and invisible: `wallet-surface.test.ts` and
 * `layout-parity.test.ts` both passed, because neither can see CSS.
 *
 * Found by reading the computed style of each tile in the sandbox
 * (`getComputedStyle(button).cursor` / `.opacity` beside `button.disabled`),
 * after a screenshot showed a "disabled" tile that looked live.
 *
 * These checks read the stylesheet as text, so they pin the rule's presence,
 * not the rendered pixels. The sandbox pass is still the real check.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) =>
  readFileSync(resolve(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const CSS = read("src/design/styles/utilities.css");
const ROW = read("src/features/wallet/WalletActionRow.tsx");

/** The declaration block of the first rule whose selector list contains `selector`. */
function ruleBody(css: string, selector: string): string | null {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^}]*)\}/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (selectors.includes(selector)) return m[2];
  }
  return null;
}

describe("WalletActionRow — a blocked action is visibly blocked", () => {
  it("the tiles are .qbtn buttons disabled by their blocked reason", () => {
    // If the row stops using `.qbtn`, the rule below no longer covers it and
    // this test must be rewritten against whatever styles the tiles instead.
    expect(ROW).toMatch(/className=\{`qbtn\$\{accent \? " accent" : ""\}`\}/);
    expect(ROW).toContain("disabled={blocked}");
  });

  it(".qbtn:disabled dims and refuses the pointer (BEHAVIORS.md disabled rule)", () => {
    const body = ruleBody(CSS, ".qbtn:disabled");
    expect(body, "utilities.css has no `.qbtn:disabled` rule").not.toBeNull();
    expect(body!).toMatch(/opacity:\s*var\(--disabled-opacity/);
    expect(body!).toMatch(/cursor:\s*not-allowed/);
  });

  it("hovering a disabled tile keeps each variant's resting look", () => {
    // Without these, `.qbtn.accent:hover` still fills a disabled Swap tile on
    // hover, which reads as "this will do something".
    for (const sel of [
      ".qbtn:disabled:hover",
      ".qbtn.primary:disabled:hover",
      ".qbtn.accent:disabled:hover",
      ".qbtn.danger:disabled:hover",
    ]) {
      expect(ruleBody(CSS, sel), `missing ${sel}`).not.toBeNull();
    }
    // A disabled primary must keep its white fill; a transparent one would
    // leave its near-black text invisible on the dark background.
    expect(ruleBody(CSS, ".qbtn.primary:disabled:hover")!).toMatch(
      /background:\s*var\(--white\)/,
    );
    expect(ruleBody(CSS, ".qbtn:disabled") ?? "").not.toMatch(/background:/);
  });

  it("control: the parser finds a rule that exists and misses one that does not", () => {
    expect(ruleBody(CSS, ".qbtn.accent")).toMatch(/color:\s*var\(--accent\)/);
    expect(ruleBody(CSS, ".qbtn:no-such-state")).toBeNull();
    // Comments are stripped: a selector named only inside a comment is not a rule.
    expect(ruleBody("/* .x:disabled { opacity: 0 } */ .y { color: red }", ".x:disabled")).toBeNull();
  });
});
