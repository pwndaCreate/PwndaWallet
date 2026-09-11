/**
 * The Particl chain choice on the setup wizard: which mode is selected, and
 * what the sentence under it says.
 *
 * Both rules are here because both were WRONG on a screen that type-checked
 * clean and passed 2,317 other tests. Adding the full-node radio turned a
 * two-way choice into a three-way one, and the two-way assumptions survived:
 *
 *   1. `chainMode` defaults to `snapshot`, decided before the probe answers.
 *      With nothing published that radio is not rendered, so the group showed
 *      NOTHING selected.
 *   2. The footnote read "Both end at the same node, and neither can trade
 *      PART itself" — true of snapshot-vs-sync, false the moment a third
 *      option exists, and flatly wrong on the no-snapshot screen where the
 *      only two options visible are the two that do NOT share a node.
 *
 * How they were found: a sandbox pass with `VITE_MOCK_SNAPSHOT=none`
 * (2026-09-10). The snapshot-available case had been verified first and looked
 * correct, because there the stale default happens to be valid — the defect
 * lived entirely in the branch that was not looked at. The general shape is
 * the one CLAUDE.md names: a check that cannot fail for the reason you run it.
 */
import { describe, it, expect } from "vitest";
import {
  reconcileChainMode,
  chainModeNote,
  type ChainMode,
} from "../SidecarSetupWizard";

const ALL: ChainMode[] = ["snapshot", "sync", "archive"];

describe("reconcileChainMode", () => {
  it("keeps every choice when a snapshot is on offer", () => {
    // Nothing to reconcile: all three radios render, so any mode is selectable.
    for (const mode of ALL) {
      expect(reconcileChainMode(mode, true)).toBe(mode);
    }
  });

  it("falls back to sync when the snapshot the default names is not there", () => {
    // The defect: `snapshot` selected, no snapshot radio rendered, so the
    // group draws empty.
    expect(reconcileChainMode("snapshot", false)).toBe("sync");
  });

  it("never overrides a choice the user already made", () => {
    // The probe resolves asynchronously, so it can land AFTER a click. A
    // fallback that ran unconditionally would silently undo it — and `archive`
    // is the one mode that cannot be re-chosen later without a re-sync.
    expect(reconcileChainMode("archive", false)).toBe("archive");
    expect(reconcileChainMode("sync", false)).toBe("sync");
  });

  it("always names an option that is actually rendered", () => {
    // The invariant behind all of the above, stated once: whatever comes out
    // must be a mode with a radio on screen. Only `snapshot` is conditional.
    for (const mode of ALL) {
      expect(reconcileChainMode(mode, false)).not.toBe("snapshot");
    }
  });
});

describe("chainModeNote", () => {
  it("gives every mode its own sentence", () => {
    const notes = ALL.map(chainModeNote);
    expect(new Set(notes).size).toBe(3);
    for (const n of notes) expect(n.length).toBeGreaterThan(0);
  });

  it("tells every mode whether it can trade PART", () => {
    // The one consequence that cannot be undone later, so it belongs on all
    // three branches rather than only the one that introduces it.
    for (const mode of ALL) {
      expect(chainModeNote(mode)).toMatch(/PART/);
    }
  });

  it("only mentions the fast start on the mode that IS the fast start", () => {
    // The regression this file exists for, stated as the one rule that is
    // actually mechanically checkable.
    //
    // `sync` and `archive` render on BOTH screens — including the one where
    // nothing is published and no fast-start radio exists — so neither may
    // refer to one, under either of its names. `snapshot` renders only when a
    // snapshot is real, so it may say both.
    //
    // Two earlier drafts tried to state this more generally, as "the copy must
    // never count the options" (banning both/neither/either). That is the
    // right INTENT and the wrong TEST: the archive note legitimately says
    // "both transaction indexes", meaning txindex and spentindex, not options.
    // A keyword ban cannot tell those apart, and one carrying an allow-list of
    // innocent "both"s would go red on harmless edits until someone deleted
    // it. Left as prose in `chainModeNote`'s own doc comment instead.
    for (const mode of ["sync", "archive"] as const) {
      expect(chainModeNote(mode)).not.toMatch(/fast start/i);
      expect(chainModeNote(mode)).not.toMatch(/snapshot/i);
    }
    expect(chainModeNote("snapshot")).toMatch(/fast start/i);
  });

  it("names its subjects when it compares two modes", () => {
    // The snapshot note is the only one that compares, and it may: it renders
    // only on the screen where all three radios are up. What it may not do is
    // lean on how many options happen to be there — "Both end at the same
    // node" was true of a two-way choice and became false the moment a third
    // radio landed. So if it says "neither", the two things must be named in
    // the same sentence.
    const snap = chainModeNote("snapshot");
    if (/\b(both|neither|either)\b/i.test(snap)) {
      expect(snap).toMatch(/fast start and sync/i);
    }
  });
});
