/**
 * The record of BTC transactions this app built (operator request,
 * 2026-10-01): the gate in front of "Speed up", because the swap engine can
 * spend the same keys and one of its transactions must never be replaced.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, unknown>();
let storeFails = false;
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: async (file: string) => {
      if (storeFails) throw new Error("no store here");
      return {
        get: async (k: string) => memory.get(`${file}|${k}`) ?? null,
        set: async (k: string, v: unknown) => {
          memory.set(`${file}|${k}`, v);
        },
        save: async () => {},
      };
    },
  },
}));

import {
  _ownBtcTxWritesForTests,
  _resetOwnBtcTxsForTests,
  isOwnBtcTx,
  rememberOwnBtcTx,
} from "./btc-own-txs";

const A = "aa".repeat(32);
const B = "bb".repeat(32);

beforeEach(() => {
  memory.clear();
  storeFails = false;
  _resetOwnBtcTxsForTests();
});

describe("btc-own-txs", () => {
  it("knows a transaction the moment it is recorded, in any case", async () => {
    expect(await isOwnBtcTx(A)).toBe(false);
    rememberOwnBtcTx(A.toUpperCase());
    expect(await isOwnBtcTx(A)).toBe(true);
    expect(await isOwnBtcTx(B)).toBe(false);
  });

  it("survives a restart through the store", async () => {
    rememberOwnBtcTx(A);
    await _ownBtcTxWritesForTests();
    _resetOwnBtcTxsForTests(); // a new session: memory gone, the store kept
    expect(await isOwnBtcTx(A)).toBe(true);
  });

  it("a store that cannot be opened fails closed: only this session's sends count", async () => {
    storeFails = true;
    rememberOwnBtcTx(A);
    await _ownBtcTxWritesForTests();
    expect(await isOwnBtcTx(A)).toBe(true);
    _resetOwnBtcTxsForTests();
    storeFails = true;
    expect(await isOwnBtcTx(A)).toBe(false);
  });

  it("ignores anything that is not a txid, and drops entries older than a month", async () => {
    rememberOwnBtcTx("not-a-txid");
    expect(await isOwnBtcTx("not-a-txid")).toBe(false);
    const now = Date.now();
    memory.set("btc-own-txs.json|txids", [
      { txid: A, at: now - 40 * 24 * 60 * 60_000 },
      { txid: B, at: now - 60_000 },
    ]);
    rememberOwnBtcTx("cc".repeat(32), now);
    await _ownBtcTxWritesForTests();
    const stored = memory.get("btc-own-txs.json|txids") as Array<{ txid: string }>;
    expect(stored.map((e) => e.txid).sort()).toEqual([B, "cc".repeat(32)].sort());
  });
});
