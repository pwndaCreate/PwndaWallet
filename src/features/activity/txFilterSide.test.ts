/**
 * SENT / RECEIVED in Activity (operator report 2026-09-30: switching the
 * filters "doesn't actually change anything … it is not all accurate").
 *
 * Two faults behind that report. On the operator's build, duplicate rows
 * gave React duplicate keys, so the list stopped updating while the side panel
 * did (fixed by one row per transaction; `activityDedupe.test.ts`). And each
 * layout filtered with its own `out || pending` / `in`, so a send to yourself
 * and a send that failed on chain appeared under ALL and under neither SENT
 * nor RECEIVED. One rule now serves both layouts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChainTx } from "../../wallets/types";
import { txFilterSide } from "./txFilters";

const row = (direction: ChainTx["direction"], extra: Partial<ChainTx> = {}): ChainTx => ({
  chain: "ethereum",
  hash: "0x01",
  direction,
  amount: "1",
  ...extra,
});

describe("txFilterSide", () => {
  it("sends, sends to yourself, and failed sends are SENT", () => {
    expect(txFilterSide(row("out"))).toBe("sent");
    expect(txFilterSide(row("self"))).toBe("sent");
    expect(txFilterSide(row("failed"))).toBe("sent");
    expect(txFilterSide(row("failed", { meta: { intended: "out" } }))).toBe("sent");
  });

  it("receipts, and an incoming transfer that reverted, are RECEIVED", () => {
    expect(txFilterSide(row("in"))).toBe("received");
    expect(txFilterSide(row("failed", { meta: { intended: "in" } }))).toBe("received");
  });

  it("a mempool row goes the way it was meant to", () => {
    expect(txFilterSide(row("pending", { meta: { netDirection: "in" } }))).toBe("received");
    expect(txFilterSide(row("pending", { meta: { netDirection: "out" } }))).toBe("sent");
    expect(txFilterSide(row("pending"))).toBe("sent");
  });

  it("an SPL transfer whose direction was not read is in neither", () => {
    expect(txFilterSide(row("pending", { height: 300_000_000 }))).toBeNull();
  });

  it("both layouts filter with it", () => {
    for (const view of ["ActivityLandscapeView.tsx", "ActivityViewPortrait.tsx"]) {
      const src = readFileSync(resolve(__dirname, view), "utf8");
      expect(src).toContain('txFilterSide(t) === "sent"');
      expect(src).toContain('txFilterSide(t) === "received"');
      expect(src).not.toMatch(/t\.direction === "out" \|\| t\.direction === "pending"/);
    }
  });
});
