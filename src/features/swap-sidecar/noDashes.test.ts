/**
 * No em dashes or en dashes in user facing swap copy.
 *
 * A house style rule from 2026-09-07. Rules kept in someone's head come back
 * the next time anyone writes a sentence, so this is a test rather than a note:
 * the swap screens had accumulated dozens of them, and the whole point of
 * removing them is that they stay removed.
 *
 * Scope is deliberately the RENDERED copy, not the comments. Prose in a doc
 * comment is for the next engineer and is not on anybody's screen; this file
 * would be unusable if it flagged that, and an unusable guard gets deleted or
 * skipped. Comment lines are therefore stripped before the check.
 *
 * The stripping is line based and so is approximate: a dash inside a block
 * comment whose line does not itself start with a comment marker would be
 * flagged. That is the safe direction to be wrong in. Rewrite the comment.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Files whose strings reach a user on the swap surfaces. */
const COPY_FILES = [
  "src/features/swap-sidecar/SidecarSwapTracker.tsx",
  "src/features/swap-sidecar/bidStates.ts",
  "src/features/swap-sidecar/swapEta.ts",
];

const DASHES = /[–—]/;

/** Drop whole line comments and doc comment bodies. */
function strippedLines(src: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  let inBlock = false;
  src.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      return;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      return;
    }
    if (line.startsWith("//") || line.startsWith("*")) return;
    out.push({ n: i + 1, text: raw });
  });
  return out;
}

describe("user facing swap copy carries no dashes", () => {
  it.each(COPY_FILES)("%s", (rel) => {
    const src = readFileSync(resolve(process.cwd(), rel), "utf8");
    const bad = strippedLines(src)
      .filter((l) => DASHES.test(l.text))
      .map((l) => `${rel}:${l.n}  ${l.text.trim().slice(0, 100)}`);
    expect(
      bad,
      `em dash or en dash in rendered copy. Rewrite the sentence: a full stop, ` +
        `a colon or the word "to" says the same thing.\n${bad.join("\n")}`,
    ).toEqual([]);
  });
});
