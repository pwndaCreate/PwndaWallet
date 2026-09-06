/**
 * `assessBidFunding` — can the SWAP NODE actually pay the send leg?
 *
 * Pinned from the 2026-08-22 audit finding: nothing in the quote or submit
 * path read any balance, and the form's BAL / MAX affordances read the
 * WALLET's balance. For a C8/C9-shared coin those are the same wallet; for
 * DOGE/DASH/BCH or a deposit-mode LTC they are unrelated, so a user could
 * review — and, once the write path opened, actually submit — a bid the node
 * has no coin to fund.
 *
 * The load-bearing half of these tests is the NEGATIVE space: absent or
 * unreadable data must read `unknown` and must NOT block. A funding check that
 * refuses whenever the node is slow to answer would strand people, which is
 * the same "advisory degrades, never blocks" rule `spread.ts` follows.
 */
import { describe, it, expect } from "vitest";
import { assessBidFunding } from "./offers";

const rows = (o: Record<string, { balance: string | null; locked?: boolean }>) => o;

describe("assessBidFunding", () => {
  it("passes when the node holds more than the swap needs", () => {
    const v = assessBidFunding({
      sendTicker: "LTC",
      sendAmount: 0.3,
      rows: rows({ LTC: { balance: "3.20000000" } }),
      sendDecimals: 8,
    });
    expect(v.state).toBe("ok");
  });

  it("passes on an exact-balance swap — >= not >", () => {
    const v = assessBidFunding({
      sendTicker: "LTC",
      sendAmount: 3.2,
      rows: rows({ LTC: { balance: "3.20000000" } }),
      sendDecimals: 8,
    });
    expect(v.state).toBe("ok");
  });

  it("reports SHORT with both numbers and an actionable sentence", () => {
    const v = assessBidFunding({
      sendTicker: "DOGE",
      sendAmount: 500,
      rows: rows({ DOGE: { balance: "42" } }),
      sendDecimals: 8,
    });
    expect(v.state).toBe("short");
    if (v.state !== "short") return;
    expect(v.have).toBe(42);
    expect(v.need).toBe(500);
    expect(v.message).toContain("42");
    expect(v.message).toContain("500");
    // Names the way out, not just the problem.
    expect(v.message).toMatch(/deposit|lower the amount/i);
  });

  // ── the negative space: unknown must never block ──────────────────

  it("is UNKNOWN, not short, when the coin is absent from the table", () => {
    const v = assessBidFunding({
      sendTicker: "BCH",
      sendAmount: 1,
      rows: rows({ LTC: { balance: "3.2" } }),
    });
    expect(v.state).toBe("unknown");
  });

  it("is UNKNOWN when the node reported no balance for the coin", () => {
    const v = assessBidFunding({
      sendTicker: "LTC",
      sendAmount: 1,
      rows: rows({ LTC: { balance: null } }),
    });
    expect(v.state).toBe("unknown");
  });

  it("is UNKNOWN when the node's wallet for that coin is locked", () => {
    const v = assessBidFunding({
      sendTicker: "LTC",
      sendAmount: 1,
      rows: rows({ LTC: { balance: "3.2", locked: true } }),
    });
    expect(v.state).toBe("unknown");
    if (v.state !== "unknown") return;
    expect(v.reason).toMatch(/locked/i);
  });

  it("is UNKNOWN when the whole read failed (empty table), never short", () => {
    // A node that did not answer must not read as "you have no money".
    const v = assessBidFunding({ sendTicker: "LTC", sendAmount: 1, rows: rows({}) });
    expect(v.state).toBe("unknown");
  });

  it("is UNKNOWN on an unreadable balance string rather than parsing it as 0", () => {
    const v = assessBidFunding({
      sendTicker: "LTC",
      sendAmount: 1,
      rows: rows({ LTC: { balance: "not-a-number" } }),
    });
    expect(v.state).toBe("unknown");
  });

  it("is UNKNOWN with no amount typed", () => {
    const v = assessBidFunding({
      sendTicker: "LTC",
      sendAmount: 0,
      rows: rows({ LTC: { balance: "3.2" } }),
    });
    expect(v.state).toBe("unknown");
  });

  it("matches the ticker case-insensitively", () => {
    const v = assessBidFunding({
      sendTicker: "ltc",
      sendAmount: 0.3,
      rows: rows({ LTC: { balance: "3.2" } }),
    });
    expect(v.state).toBe("ok");
  });

  it("a zero balance IS short, not unknown — the node really answered", () => {
    const v = assessBidFunding({
      sendTicker: "LTC",
      sendAmount: 0.3,
      rows: rows({ LTC: { balance: "0" } }),
      sendDecimals: 8,
    });
    expect(v.state).toBe("short");
  });
});
