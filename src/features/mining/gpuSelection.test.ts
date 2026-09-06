import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readGpuSelection, writeGpuSelection } from "./gpuSelection";

/**
 * This suite runs under vitest's `environment: "node"` (see vitest.config.ts —
 * shared by every feature glob, no per-folder override), where `window` does
 * not exist. The module under test already handles that gracefully at
 * runtime (`window.localStorage` inside a `try`, same as `mineViewMode.ts`'s
 * established pattern) — a `ReferenceError` there is caught and the safe
 * default returned. But that means this suite cannot verify PERSISTENCE at
 * all without first giving `window` something real to catch on, so a small
 * self-contained `localStorage` stand-in is installed for just this file.
 */
function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("gpuSelection — persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: makeMemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to null (every GPU) when nothing is stored", () => {
    expect(readGpuSelection(2)).toBeNull();
  });

  it("round-trips a single-GPU selection", () => {
    writeGpuSelection([1]);
    expect(readGpuSelection(2)).toEqual([1]);
  });

  it("round-trips a multi-GPU selection, preserving order", () => {
    writeGpuSelection([1, 0]);
    expect(readGpuSelection(2)).toEqual([1, 0]);
  });

  it("writing null clears storage (reads back as null)", () => {
    writeGpuSelection([0]);
    writeGpuSelection(null);
    expect(readGpuSelection(2)).toBeNull();
  });

  it("writing an empty array is treated the same as writing null", () => {
    writeGpuSelection([0]);
    writeGpuSelection([]);
    expect(readGpuSelection(2)).toBeNull();
  });

  /**
   * The hardware-change case this module's header calls out: a selection
   * naming an index that no longer exists must fall back to "every GPU",
   * never to an out-of-range value the miner would refuse to start on.
   */
  it("drops indices that are out of range for the CURRENT gpu count", () => {
    // The user had explicitly picked the SECOND card (index 1)...
    writeGpuSelection([1]);
    // ...and that card is the one that got removed, so index 1 no longer
    // exists. Every previously-selected index is now invalid.
    expect(readGpuSelection(1)).toBeNull();
  });

  it("keeps the still-valid indices when only SOME are out of range", () => {
    writeGpuSelection([0, 5]);
    expect(readGpuSelection(2)).toEqual([0]);
  });

  it("a hand-corrupted value never selects zero devices", () => {
    window.localStorage.setItem("pwnda.mine.gpuSelection", "{not json");
    expect(readGpuSelection(2)).toBeNull();
    window.localStorage.setItem("pwnda.mine.gpuSelection", '"gpu1"');
    expect(readGpuSelection(2)).toBeNull();
    window.localStorage.setItem("pwnda.mine.gpuSelection", "[-1, 1.5, null]");
    expect(readGpuSelection(2)).toBeNull();
  });
});
