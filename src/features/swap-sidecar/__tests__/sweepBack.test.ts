/**
 * C4 — the faults these tests exist to catch.
 *
 * **A confirmation that confirms nothing (§R14).** The phrase is the last 6
 * characters of a destination the user is supposed to read off the plan card.
 * The dangerous edge is the degenerate one: a plan with an empty destination
 * makes the expected phrase `""`, and a naive `typed === expected` then
 * auto-confirms on an empty input. That case is pinned first, because it is the
 * one nobody writes a test for.
 *
 * **A deadline that is not read as a deadline.** The token lives 120 s and is
 * single-use. `Date.parse` returns `NaN` for anything it does not understand —
 * a truncated timestamp, a locale format, a mock that put a number there — and
 * `nowMs >= NaN` is `false`, i.e. "not expired". Every expiry helper therefore
 * fails **closed** on an unparseable value, and that is what is asserted.
 */
import { describe, it, expect } from "vitest";
import {
  confirmPhraseFor,
  formatCountdown,
  isConfirmPhraseValid,
  sweepPlanExpired,
  sweepPlanMsRemaining,
  sweepSummary,
  SWEEP_CONFIRM_LEN,
  SWEEP_TOKEN_TTL_MS,
  type SweepPlan,
} from "../sweepBack";

const T0 = Date.UTC(2026, 7, 19, 12, 0, 0);

const plan = (o: Partial<SweepPlan> = {}): SweepPlan => ({
  token: "a".repeat(64),
  coin: "btc",
  destination: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
  amount: "0.25000000",
  sweepall: false,
  expiresAt: new Date(T0 + SWEEP_TOKEN_TTL_MS).toISOString(),
  ...o,
});

describe("confirmPhraseFor", () => {
  it("is the last 6 characters of the destination", () => {
    expect(confirmPhraseFor(plan())).toBe("ygt080");
    expect(SWEEP_CONFIRM_LEN).toBe(6);
  });

  it("returns the whole string when the destination is shorter than 6", () => {
    // No real address is this short. Padding or truncating to 6 would either
    // demand characters that do not exist or accept a shorter confirmation.
    expect(confirmPhraseFor(plan({ destination: "abc" }))).toBe("abc");
  });

  it("returns '' for an absent destination", () => {
    expect(confirmPhraseFor(plan({ destination: "" }))).toBe("");
    expect(confirmPhraseFor(null)).toBe("");
    expect(confirmPhraseFor(undefined)).toBe("");
    expect(confirmPhraseFor({ ...plan(), destination: 7 as unknown as string })).toBe("");
  });
});

describe("isConfirmPhraseValid", () => {
  it("accepts the exact suffix, and tolerates surrounding whitespace", () => {
    expect(isConfirmPhraseValid(plan(), "ygt080")).toBe(true);
    expect(isConfirmPhraseValid(plan(), "  ygt080 ")).toBe(true);
  });

  it("is CASE-SENSITIVE", () => {
    // Base58 and uppercase bech32 are both case-significant, and Rust compares
    // exactly. Accepting a case-insensitive match here only produces a
    // confirmation the backend then rejects.
    expect(isConfirmPhraseValid(plan(), "YGT080")).toBe(false);
    expect(isConfirmPhraseValid(plan(), "Ygt080")).toBe(false);
  });

  it("rejects a near miss in either length", () => {
    expect(isConfirmPhraseValid(plan(), "gt080")).toBe(false);
    expect(isConfirmPhraseValid(plan(), "kygt080")).toBe(false);
    expect(isConfirmPhraseValid(plan(), "")).toBe(false);
  });

  it("can NEVER be satisfied when there is no destination", () => {
    // The degenerate case: expected is "", so `typed === expected` would
    // auto-confirm on an empty box. An unaddressed sweep must be unconfirmable.
    const p = plan({ destination: "" });
    expect(isConfirmPhraseValid(p, "")).toBe(false);
    expect(isConfirmPhraseValid(p, "   ")).toBe(false);
    expect(isConfirmPhraseValid(p, "anything")).toBe(false);
    expect(isConfirmPhraseValid(null, "")).toBe(false);
  });

  it("rejects a non-string input", () => {
    expect(isConfirmPhraseValid(plan(), null)).toBe(false);
    expect(isConfirmPhraseValid(plan(), undefined)).toBe(false);
    expect(isConfirmPhraseValid(plan(), 80 as unknown as string)).toBe(false);
  });
});

describe("expiry fails closed", () => {
  it("is live before the deadline and expired at or after it", () => {
    expect(sweepPlanExpired(plan(), T0)).toBe(false);
    expect(sweepPlanExpired(plan(), T0 + SWEEP_TOKEN_TTL_MS - 1)).toBe(false);
    // The boundary counts as expired — a token that expires "at" T is not
    // usable at T.
    expect(sweepPlanExpired(plan(), T0 + SWEEP_TOKEN_TTL_MS)).toBe(true);
    expect(sweepPlanExpired(plan(), T0 + SWEEP_TOKEN_TTL_MS + 1)).toBe(true);
  });

  it("treats an UNPARSEABLE deadline as expired", () => {
    // `Date.parse` gives NaN, and `now >= NaN` is false — i.e. "still valid".
    // That is the failure this branch exists to prevent.
    for (const bad of ["", "soon", "2026-13-45T99:99:99Z", "not-a-date"]) {
      expect(sweepPlanExpired(plan({ expiresAt: bad }), T0)).toBe(true);
      expect(sweepPlanMsRemaining(plan({ expiresAt: bad }), T0)).toBe(0);
    }
    expect(sweepPlanExpired(plan({ expiresAt: 123 as unknown as string }), T0)).toBe(true);
  });

  it("treats a missing plan as expired", () => {
    expect(sweepPlanExpired(null, T0)).toBe(true);
    expect(sweepPlanExpired(undefined, T0)).toBe(true);
    expect(sweepPlanMsRemaining(null, T0)).toBe(0);
  });

  it("counts down and clamps at zero", () => {
    expect(sweepPlanMsRemaining(plan(), T0)).toBe(SWEEP_TOKEN_TTL_MS);
    expect(sweepPlanMsRemaining(plan(), T0 + 60_000)).toBe(60_000);
    expect(sweepPlanMsRemaining(plan(), T0 + 999_999)).toBe(0);
  });
});

describe("formatCountdown", () => {
  it("renders mm:ss with a padded seconds field", () => {
    expect(formatCountdown(SWEEP_TOKEN_TTL_MS)).toBe("2:00");
    expect(formatCountdown(61_000)).toBe("1:01");
    expect(formatCountdown(9_000)).toBe("0:09");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });
});

describe("sweepSummary", () => {
  it("names the amount for a bitcoin-family sweep", () => {
    expect(sweepSummary(plan())).toMatch(/0\.25000000 BTC/);
    expect(sweepSummary(plan())).toContain(
      "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
    );
  });

  it("says 'everything' for a sweepall rather than inventing a number", () => {
    // The XMR family sweeps the whole wallet and the amount is not known until
    // the engine builds the transaction. Printing `amount` there would show a
    // figure with no source.
    const s = sweepSummary(plan({ coin: "xmr", sweepall: true, amount: null }));
    expect(s).toMatch(/everything the swap node holds in XMR/);
    expect(s).not.toMatch(/null/);
  });

  it("is empty for no plan", () => {
    expect(sweepSummary(null)).toBe("");
  });
});
