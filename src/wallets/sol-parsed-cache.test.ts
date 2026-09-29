/**
 * Solana history: parsed-transaction results are cached for FINALIZED
 * signatures (RAM plan 3.6, 2026-09-25).
 *
 * `getTransactionHistory` used to fetch every signature's full parsed
 * transaction on every call: 1 + 50 RPCs per address per minute from the 60 s
 * history poll, each rotating up to 11 endpoints on a 429 - the largest share
 * of the ~660 requests/min measured on an idle Mine tab. The cache is only safe
 * if (a) it never stores a lookup that failed and (b) the net amount is keyed
 * by the address that asked. Both are pinned here.
 */
import { describe, expect, it } from "vitest";
import { createSolParsedCache, summarizeParsedTx } from "./sol-wallet";

const pk = (s: string) => ({ pubkey: { toBase58: () => s } });
const parsed = (keys: string[], pre: number[], post: number[], fee = 5000) => ({
  transaction: { message: { accountKeys: keys.map(pk) } },
  meta: { preBalances: pre, postBalances: post, fee },
});

describe("summarizeParsedTx", () => {
  it("returns null for a missing transaction, so a failed lookup is never cached", () => {
    expect(summarizeParsedTx(null, "me")).toBeNull();
    expect(summarizeParsedTx(undefined, "me")).toBeNull();
  });

  it("nets the balance change of the asking address, not of the first account", () => {
    const tx = parsed(["other", "me"], [1_000, 500], [900, 600]);
    expect(summarizeParsedTx(tx, "me")).toEqual({ net: 100, fee: 5000 });
    expect(summarizeParsedTx(tx, "other")).toEqual({ net: -100, fee: 5000 });
  });

  it("an address the transaction does not touch nets to zero", () => {
    expect(summarizeParsedTx(parsed(["a"], [1], [2]), "me")?.net).toBe(0);
  });
});

describe("createSolParsedCache", () => {
  it("keys by address AND signature - the same tx nets differently per account", () => {
    const c = createSolParsedCache();
    c.set("alice", "sig1", { net: 5 });
    c.set("bob", "sig1", { net: -5 });
    expect(c.get("alice", "sig1")?.net).toBe(5);
    expect(c.get("bob", "sig1")?.net).toBe(-5);
    expect(c.get("carol", "sig1")).toBeUndefined();
  });

  it("is bounded: the oldest entry goes first", () => {
    const c = createSolParsedCache(3);
    for (const s of ["a", "b", "c", "d"]) c.set("me", s, { net: 1 });
    expect(c.size).toBe(3);
    expect(c.get("me", "a")).toBeUndefined();
    expect(c.get("me", "d")).toBeDefined();
  });

  it("re-setting an entry refreshes its age instead of duplicating it", () => {
    const c = createSolParsedCache(2);
    c.set("me", "a", { net: 1 });
    c.set("me", "b", { net: 1 });
    c.set("me", "a", { net: 1 }); // a is now the newest
    c.set("me", "c", { net: 1 }); // evicts b, not a
    expect(c.get("me", "a")).toBeDefined();
    expect(c.get("me", "b")).toBeUndefined();
    expect(c.size).toBe(2);
  });
});
