/**
 * A3 (Option A): the "this chain predates pruning" line on the swap-node card.
 *
 * Exists because the branch cannot be reached any other way before it ships.
 * `SidecarStatusCard` holds `useState`/`useEffect`, so it cannot be invoked
 * directly the way `DexParticlCard` is in `syncState.test.ts`; and the
 * opted-in card is unreachable in the browser-only sandbox, where the setup
 * wizard's Tauri event listener has no mock and throws
 * `Cannot read properties of undefined (reading 'unregisterListener')`
 * (`SidecarSetupWizard.tsx:86`) before the flow can complete. Verified by hand
 * on 2026-09-09; the wizard's own footprint copy WAS confirmed live in that
 * pass ("about 1.5 GB downloaded and stored"), which is what makes the missing
 * half worth pinning here.
 */
import { describe, it, expect } from "vitest";
import { ParticlFootprintNote } from "../SidecarStatusCard";

/** Flatten a returned element tree into its text, the way syncState.test does. */
function textOf(node: unknown): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { props?: { children?: unknown } };
  return el.props ? textOf(el.props.children) : "";
}

describe("ParticlFootprintNote", () => {
  it("says nothing on a pruned or fresh node", () => {
    // The common case by far, and the one where a stray line would be noise on
    // every healthy install.
    expect(ParticlFootprintNote({ unpruned: false })).toBeNull();
  });

  it("explains the footprint on a chain that predates pruning", () => {
    const out = ParticlFootprintNote({ unpruned: true });
    expect(out).not.toBeNull();
    const text = textOf(out);
    // Both numbers, because the point is the COMPARISON: the wizard quotes
    // ~1.5 GB for the node and this install shows ~2.9 GB, and the line exists
    // to reconcile those two facts rather than to report one of them.
    expect(text).toMatch(/2\.9 GB/);
    expect(text).toMatch(/1\.3 GB/);
    // And it must say the remedy is a fresh sync, not imply the card can fix
    // it: particl-core cannot drop the indexes from an existing chain, so an
    // actionable-sounding sentence here would be a promise nothing can keep.
    expect(text).toMatch(/fresh Particl sync/);
  });

  it("is not phrased as a fault", () => {
    // Nothing is broken and no swap behaves differently; alarm words here
    // would send users hunting for a problem that does not exist. This mirrors
    // the reasoning behind DexParticlCard's amber-not-red `not-started` dot.
    const text = textOf(ParticlFootprintNote({ unpruned: true })).toLowerCase();
    for (const alarm of ["error", "warning", "failed", "problem", "broken"]) {
      expect(text).not.toContain(alarm);
    }
  });
});
