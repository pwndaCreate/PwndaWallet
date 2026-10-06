/**
 * The record of transactions this wallet replaced ("Speed up", operator
 * request 2026-10-01) and the history filter built on it: after a speed-up the
 * original and its replacement spend the same coins, so the original's
 * unconfirmed row must leave the history — but a mined original (the
 * replacement lost the race) is the truth and stays.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  _clearTxReplacementsForTests,
  isUnconfirmedRow,
  latestReplacementOf,
  onTxReplacement,
  recordTxReplacement,
  txReplacementOf,
  withoutReplacedRows,
  type TxReplacement,
} from "./tx-replacements";
import type { ChainTx } from "./types";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);

const row = (hash: string, over: Partial<ChainTx> = {}): ChainTx => ({
  chain: "bitcoin",
  hash,
  direction: "pending",
  amount: "0.1",
  confirmations: 0,
  ...over,
});

beforeEach(() => _clearTxReplacementsForTests());

describe("tx-replacements", () => {
  it("records a replacement, case-insensitively, and tells every listener once", () => {
    const heard: TxReplacement[] = [];
    const off = onTxReplacement((r) => heard.push(r));
    recordTxReplacement({ chain: "bitcoin", replaced: A.toUpperCase(), by: B, at: 5 });
    expect(txReplacementOf("bitcoin", A)).toEqual({ chain: "bitcoin", replaced: A, by: B, at: 5 });
    expect(txReplacementOf("litecoin", A)).toBeUndefined();
    expect(heard).toHaveLength(1);
    off();
    recordTxReplacement({ chain: "bitcoin", replaced: B, by: C });
    expect(heard).toHaveLength(1);
  });

  it("follows a chain of replacements to the one that stands", () => {
    recordTxReplacement({ chain: "bitcoin", replaced: A, by: B });
    recordTxReplacement({ chain: "bitcoin", replaced: B, by: C });
    expect(latestReplacementOf("bitcoin", A)).toBe(C);
    expect(latestReplacementOf("bitcoin", C)).toBe(C);
  });

  it("a transaction cannot replace itself", () => {
    recordTxReplacement({ chain: "bitcoin", replaced: A, by: A });
    expect(txReplacementOf("bitcoin", A)).toBeUndefined();
  });

  it("drops the replaced row while it is unconfirmed; keeps it once mined; same array when nothing goes", () => {
    const untouched = [row(A), row(B)];
    expect(withoutReplacedRows("bitcoin", untouched)).toBe(untouched);
    recordTxReplacement({ chain: "bitcoin", replaced: A, by: B });
    expect(withoutReplacedRows("bitcoin", [row(B), row(A)]).map((t) => t.hash)).toEqual([B]);
    const mined = [row(A, { direction: "out", confirmations: undefined, height: 900_000 })];
    expect(withoutReplacedRows("bitcoin", mined)).toBe(mined);
    // Another chain's row with the same hash is not this replacement's.
    const ltc = [row(A, { chain: "litecoin" })];
    expect(withoutReplacedRows("litecoin", ltc)).toBe(ltc);
  });

  it("isUnconfirmedRow: no block, and either no confirmations or pending", () => {
    expect(isUnconfirmedRow(row(A))).toBe(true);
    expect(isUnconfirmedRow(row(A, { direction: "out", confirmations: 0 }))).toBe(true);
    expect(isUnconfirmedRow(row(A, { direction: "out", confirmations: 2 }))).toBe(false);
    expect(isUnconfirmedRow(row(A, { height: 1 }))).toBe(false);
  });
});
