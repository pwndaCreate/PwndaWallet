/**
 * `useTxHistory`'s scheduling and merge rules (RAM plan 3.6 / 3.7, 2026-09-25).
 * The hook re-fetched ~99 pairs every 60 s on every view and committed each
 * result separately; see txHistorySchedule.ts for the incident. Each rule that
 * replaced that behaviour is pinned here.
 */
import { describe, expect, it } from "vitest";
import type { ChainTx } from "../../wallets/types";
import {
  MAX_BACKOFF_MS,
  isDue,
  mergeHistoryPage,
  pollIntervalMs,
  pollPageOverlaps,
  readPairHistory,
  sameError,
  sameHistory,
} from "./txHistorySchedule";

const tx = (hash: string, timestamp?: number, extra: Partial<ChainTx> = {}): ChainTx => ({
  chain: "bitcoin",
  hash,
  direction: "in",
  amount: "1",
  timestamp,
  ...extra,
});
const MIN = 60_000;

describe("pollIntervalMs", () => {
  const base = { activeMs: MIN, backgroundMs: 15 * MIN };

  it("polls at the active cadence only while history is on screen", () => {
    expect(pollIntervalMs({ ...base, active: true, failures: 0 })).toBe(MIN);
    expect(pollIntervalMs({ ...base, active: false, failures: 0 })).toBe(15 * MIN);
  });

  it("doubles per consecutive failure", () => {
    expect(pollIntervalMs({ ...base, active: true, failures: 1 })).toBe(2 * MIN);
    expect(pollIntervalMs({ ...base, active: true, failures: 3 })).toBe(8 * MIN);
  });

  it("never waits longer than the cap, however many failures", () => {
    expect(pollIntervalMs({ ...base, active: true, failures: 50 })).toBe(32 * MIN);
    expect(pollIntervalMs({ ...base, active: false, failures: 50 })).toBe(MAX_BACKOFF_MS);
  });
});

describe("isDue", () => {
  it("a never-attempted pair is due immediately", () => {
    expect(isDue(1_000, 0, MIN)).toBe(true);
  });
  it("is due exactly once the interval has elapsed", () => {
    expect(isDue(10_000 + MIN - 1, 10_000, MIN)).toBe(false);
    expect(isDue(10_000 + MIN, 10_000, MIN)).toBe(true);
  });
});

describe("pollPageOverlaps", () => {
  const held = [tx("c", 30), tx("b", 20), tx("a", 10)];

  it("a small page that reaches a held row connects - merge it", () => {
    expect(pollPageOverlaps(held, [tx("e", 50), tx("d", 40), tx("c", 30)], 3)).toBe(true);
  });

  it("a FULL small page of only new rows might hide more - fetch the full page", () => {
    // The gap case: more new transactions arrived than the poll page carries.
    expect(pollPageOverlaps(held, [tx("g", 70), tx("f", 60), tx("e", 50)], 3)).toBe(false);
  });

  it("a short page is the whole history, so it always connects", () => {
    expect(pollPageOverlaps(held, [tx("z", 99)], 3)).toBe(true);
  });

  it("nothing held yet means a full page is needed", () => {
    expect(pollPageOverlaps(undefined, [tx("a", 1)], 3)).toBe(false);
    expect(pollPageOverlaps([], [tx("a", 1)], 3)).toBe(false);
  });

  it("an empty page over an empty held list connects: there is nothing for a full page to add (2026-10-01)", () => {
    // Was false: every poll of a chain with no transactions read twice.
    expect(pollPageOverlaps([], [], 3)).toBe(true);
    // Nothing held at all is still not known to be empty.
    expect(pollPageOverlaps(undefined, [], 3)).toBe(false);
  });
});

describe("readPairHistory: the reads one fetch costs", () => {
  /** A reader that counts the page sizes asked for. */
  const reader = (rows: ChainTx[]) => {
    const asked: number[] = [];
    const read = async (n: number) => {
      asked.push(n);
      return rows.slice(0, n);
    };
    return { asked, read };
  };
  const opts = (full: boolean) => ({ full, limit: 50, pollLimit: 10 });

  it("a poll of an empty history reads one small page (was a small page, then a full one)", async () => {
    const r = reader([]);
    expect(await readPairHistory(r.read, [], opts(false))).toEqual([]);
    expect(r.asked).toEqual([10]);
  });

  it("the first fetch, and a refresh, read the full page once", async () => {
    const r = reader([]);
    await readPairHistory(r.read, undefined, opts(true));
    expect(r.asked).toEqual([50]);
  });

  it("first rows on an empty list still fetch the full page; a short page over held rows merges", async () => {
    const first = reader([tx("a", 1)]);
    expect((await readPairHistory(first.read, [], opts(false))).map((t) => t.hash)).toEqual(["a"]);
    expect(first.asked).toEqual([10, 50]);

    const held = [tx("a", 1)];
    const later = reader([tx("b", 2), tx("a", 1)]);
    expect((await readPairHistory(later.read, held, opts(false))).map((t) => t.hash)).toEqual(["b", "a"]);
    expect(later.asked).toEqual([10]);
  });

  it("a full small page of only new rows fetches the full page (no gap)", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => tx(`n${i}`, 100 - i));
    const r = reader(rows);
    expect(await readPairHistory(r.read, [tx("old", 1)], opts(false))).toHaveLength(12);
    expect(r.asked).toEqual([10, 50]);
  });
});

describe("mergeHistoryPage", () => {
  it("adds new rows on top and keeps held rows the page did not return", () => {
    const out = mergeHistoryPage([tx("b", 20), tx("a", 10)], [tx("c", 30), tx("b", 20)], 50);
    expect(out.map((t) => t.hash)).toEqual(["c", "b", "a"]);
  });

  it("a returned row REPLACES the held one - confirmations and status move", () => {
    const out = mergeHistoryPage(
      [tx("a", 10, { confirmations: 1 })],
      [tx("a", 10, { confirmations: 6 })],
      50,
    );
    expect(out).toHaveLength(1);
    expect(out[0].confirmations).toBe(6);
  });

  it("mempool rows (no timestamp) sort to the top", () => {
    const out = mergeHistoryPage([tx("old", 10)], [tx("pending", undefined)], 50);
    expect(out.map((t) => t.hash)).toEqual(["pending", "old"]);
  });

  it("caps the held list", () => {
    const prev = Array.from({ length: 50 }, (_, i) => tx(`p${i}`, 100 - i));
    const out = mergeHistoryPage(prev, [tx("new", 1_000)], 50);
    expect(out).toHaveLength(50);
    expect(out[0].hash).toBe("new");
    expect(out.map((t) => t.hash)).not.toContain("p49");
  });
});

describe("sameHistory / sameError", () => {
  it("an identical re-fetch is not an update", () => {
    expect(sameHistory([tx("a", 1)], [tx("a", 1)])).toBe(true);
  });
  it("any moved field is", () => {
    expect(sameHistory([tx("a", 1, { confirmations: 1 })], [tx("a", 1, { confirmations: 2 })])).toBe(false);
    expect(sameHistory([tx("a", 1)], [tx("a", 1), tx("b", 2)])).toBe(false);
    expect(sameHistory(undefined, [])).toBe(false);
  });
  it("errors compare on their first line only", () => {
    expect(sameError("All endpoints failed.\n  a: 429", "All endpoints failed.\n  b: timeout")).toBe(true);
    expect(sameError("All endpoints failed.", null)).toBe(false);
    expect(sameError(null, undefined)).toBe(true);
  });
});
