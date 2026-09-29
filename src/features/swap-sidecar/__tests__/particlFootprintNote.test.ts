/**
 * The swap-node card does NOT talk about the Particl chain's disk layout.
 *
 * History: A3 (Option A, 2026-09-09) added `ParticlFootprintNote` — "This
 * node's Particl chain predates pruning and keeps about 2.9 GB. New setups use
 * about 1.3 GB. Reclaiming the difference needs a fresh Particl sync, so
 * nothing changes on its own." — on installs whose chain was synced with
 * txindex/spentindex. On 2026-09-26 the operator removed it: it described
 * something the user cannot act on (particl-core cannot drop the indexes in
 * place, and nothing re-syncs on its own) and read as a problem to worry
 * about. The backend still reports `particlUnpruned`; only the copy is gone.
 *
 * Source-reading on purpose: the card holds `useState`/`useEffect` and is
 * unreachable in the browser-only sandbox (see the smoke-test notes in
 * CLAUDE.md), so the render path cannot be driven here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CARD = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "SidecarStatusCard.tsx"),
  "utf8",
);
/** The card's code with comments stripped, so the history note above the type does not count. */
const code = CARD.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("swap-node card — Particl footprint copy (removed 2026-09-26)", () => {
  it("renders no footprint note", () => {
    expect(code).not.toMatch(/ParticlFootprintNote/);
  });

  it("carries none of the removed copy", () => {
    for (const phrase of ["predates pruning", "fresh Particl sync", "2.9 GB", "Reclaiming the difference"]) {
      expect(code).not.toContain(phrase);
    }
  });
});
