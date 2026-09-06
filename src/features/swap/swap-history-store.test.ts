/**
 * Locks for the desk additions to the history store (2026-07-19).
 *
 * History is DISPLAY ONLY — a plaintext key inside wallet.dat. The resumable
 * protocol state lives in Rust's encrypted store and is never read back from
 * here to decide a protocol step. These tests pin the projection and the two
 * write-safety properties the desk introduced a need for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for tauri-plugin-store.
const mem = new Map<string, unknown>();
let saveCount = 0;
/** Set to make the NEXT save() reject once, simulating a store write failure. */
let failNextSave = false;
vi.mock("../../store", () => ({
  getStore: async () => ({
    get: async (k: string) => mem.get(k),
    set: async (k: string, v: unknown) => {
      mem.set(k, v);
    },
    save: async () => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("simulated store failure");
      }
      saveCount += 1;
    },
  }),
}));

import {
  appendSwapHistory,
  deskStateToHistoryStatus,
  loadSwapHistory,
  upsertSwapHistoryEntry,
  type SwapHistoryEntry,
} from "./swap-history-store";

function entry(over: Partial<SwapHistoryEntry> = {}): SwapHistoryEntry {
  return {
    id: "swap-1",
    fromAsset: "XMR",
    toAsset: "ADA",
    fromAmount: "0.1",
    toAmount: "27",
    status: "pending",
    sourceTxHash: "",
    sourceExplorerUrl: "",
    createdAt: "2026-07-19T10:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  mem.clear();
  saveCount = 0;
  failNextSave = false;
});

describe("deskStateToHistoryStatus — 8.1 projection", () => {
  it.each([
    ["ACCEPTED", "pending"],
    ["A_LOCKED", "pending"],
    ["B_LOCKED", "pending"],
    ["READY", "pending"],
    ["A_CLAIMED", "pending"],
    ["SETTLED", "success"],
    ["A_REFUNDED", "refunded"],
    ["FAILED", "failed"],
    ["ABORTED", "failed"],
  ])("maps %s -> %s", (state, expected) => {
    expect(deskStateToHistoryStatus(state)).toBe(expected);
  });

  it("maps an UNRECOGNIZED state to pending, never to a terminal status", () => {
    // Mirrors DeskSwapState::Unknown being non-terminal on the Rust side: a
    // desk that adds a state must never make an in-flight swap look finished.
    expect(deskStateToHistoryStatus("SOME_NEW_STATE")).toBe("pending");
    expect(deskStateToHistoryStatus("")).toBe("pending");
  });
});

describe("upsertSwapHistoryEntry", () => {
  it("appends when the id is absent", async () => {
    await upsertSwapHistoryEntry(entry());
    const rows = await loadSwapHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("swap-1");
  });

  it("patches in place without duplicating", async () => {
    await upsertSwapHistoryEntry(entry());
    await upsertSwapHistoryEntry(
      entry({ status: "success", destTxHash: "dest-hash" })
    );
    const rows = await loadSwapHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("success");
    expect(rows[0].destTxHash).toBe("dest-hash");
    // Fields not in the later write survive the merge.
    expect(rows[0].fromAmount).toBe("0.1");
  });

  it("upserts an id it has never seen — the rehydrate case", async () => {
    // The desk can learn about a swap from Rust that has no local row (the app
    // died before the row was written, or the 200-cap evicted it).
    // updateSwapHistoryEntry would silently no-op here.
    await upsertSwapHistoryEntry(entry({ id: "from-rust", status: "pending" }));
    const rows = await loadSwapHistory();
    expect(rows.map((r) => r.id)).toContain("from-rust");
  });
});

describe("write serialization", () => {
  it("does not drop entries when writes overlap", async () => {
    // Every writer is an unlocked read-modify-write against ONE key. Fired
    // concurrently without a queue, the later reads predate the earlier writes
    // and entries vanish. The desk tracker writes for N swaps from a poll loop,
    // so this is a real pattern, not a theoretical one.
    await Promise.all([
      upsertSwapHistoryEntry(entry({ id: "a", createdAt: "2026-07-19T10:00:03.000Z" })),
      upsertSwapHistoryEntry(entry({ id: "b", createdAt: "2026-07-19T10:00:02.000Z" })),
      upsertSwapHistoryEntry(entry({ id: "c", createdAt: "2026-07-19T10:00:01.000Z" })),
      appendSwapHistory(entry({ id: "d", createdAt: "2026-07-19T10:00:00.000Z" })),
    ]);
    const rows = await loadSwapHistory();
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the queue alive after a failing write", async () => {
    // A store write that rejects must surface to ITS caller but must not wedge
    // every subsequent write behind it — the queue chains on settle, not on
    // success. Without that, one transient failure would silently stop the
    // desk tracker from ever recording another status change.
    failNextSave = true;
    await expect(
      upsertSwapHistoryEntry(entry({ id: "doomed" }))
    ).rejects.toThrow(/simulated store failure/);

    await upsertSwapHistoryEntry(entry({ id: "after-failure" }));
    const rows = await loadSwapHistory();
    expect(rows.map((r) => r.id)).toContain("after-failure");
  });
});

describe("desk entry shape rules", () => {
  it("leaves actualReceived undefined so the drift chip stays hidden", async () => {
    // No desk DTO carries a settled amount. Synthesizing one from amountA/amountB
    // is exactly the anti-pattern swap-drift pins against.
    await upsertSwapHistoryEntry(entry({ status: "success" }));
    const rows = await loadSwapHistory();
    expect(rows[0].actualReceived).toBeUndefined();
  });

  it("sorts correctly with an ISO createdAt (history sorts by string compare)", async () => {
    // Desk timestamps are unix SECONDS; writing a raw number here would reorder
    // the ENTIRE history list, since loadSwapHistory compares strings.
    await upsertSwapHistoryEntry(entry({ id: "older", createdAt: "2026-07-19T09:00:00.000Z" }));
    await upsertSwapHistoryEntry(entry({ id: "newer", createdAt: "2026-07-19T11:00:00.000Z" }));
    const rows = await loadSwapHistory();
    expect(rows[0].id).toBe("newer");
  });
});
