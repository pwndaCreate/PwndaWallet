import { describe, it, expect } from "vitest";
import {
  classifyBalance,
  isMissingFromTotal,
  formatMissingLabel,
} from "./balance-status";

describe("classifyBalance", () => {
  it("reads real amounts, including zero as known-empty", () => {
    expect(classifyBalance("4.0573")).toEqual({ kind: "value", amount: 4.0573 });
    expect(classifyBalance("1,283.46")).toEqual({ kind: "value", amount: 1283.46 });
    expect(classifyBalance("0")).toEqual({ kind: "empty" });
    expect(classifyBalance("0.00000000")).toEqual({ kind: "empty" });
  });

  it("treats a failed or absent fetch as unloaded", () => {
    for (const raw of [undefined, null, "", "   ", "—", "-", "Not initialized"]) {
      expect(classifyBalance(raw).kind).toBe("unloaded");
    }
  });

  /**
   * The question that prompted this module. Hedera's mirror node ANSWERED; it
   * reported that no account exists for the derived key. Accounts on Hedera
   * must be created and funded by an existing account, so a fresh key has none.
   * That is a successful read, and calling it "not loaded" says something is
   * broken when nothing is.
   */
  it("treats Hedera's no-account answer as ABSENT, not as a failure", () => {
    const s = classifyBalance("No account (create on network)");
    expect(s.kind).toBe("absent");
    if (s.kind === "absent") expect(s.reason).toMatch(/created and funded/);
    expect(isMissingFromTotal(s, true)).toBe(false);
    expect(isMissingFromTotal(s, false)).toBe(false);
  });

  it("treats a syncing sidecar as pending, not as a failure", () => {
    for (const raw of ["Syncing…", "Syncing...", "Scanning…"]) {
      const s = classifyBalance(raw);
      expect(s.kind).toBe("pending");
      expect(isMissingFromTotal(s, true)).toBe(false);
    }
  });

  /**
   * An answer nobody can read must NOT become "0". Showing zero for an
   * unparseable reply is how real funds get hidden — the opposite failure to
   * the one this module fixes, and the worse of the two.
   */
  it("treats an unrecognised string as unloaded, never as empty", () => {
    for (const raw of ["error", "n/a", "RPC failed", "0x10"]) {
      expect(classifyBalance(raw).kind).toBe("unloaded");
    }
  });
});

describe("isMissingFromTotal — only real gaps count", () => {
  it("held-but-unpriced is missing; held-and-priced is not", () => {
    const held = classifyBalance("2.5");
    expect(isMissingFromTotal(held, false)).toBe(true);
    expect(isMissingFromTotal(held, true)).toBe(false);
  });

  it("an empty chain is never missing, priced or not", () => {
    const empty = classifyBalance("0");
    expect(isMissingFromTotal(empty, false)).toBe(false);
    expect(isMissingFromTotal(empty, true)).toBe(false);
  });

  it("a failed fetch is missing regardless of price availability", () => {
    const gone = classifyBalance("—");
    expect(isMissingFromTotal(gone, true)).toBe(true);
    expect(isMissingFromTotal(gone, false)).toBe(true);
  });

  /**
   * Portrait and landscape used to disagree on exactly this input: portrait
   * `parseFloat`→NaN→continue (not missing), landscape `parseBalanceNumber`
   * →null→missing. One classifier now answers for both.
   */
  it("gives ONE answer for a non-numeric balance", () => {
    const s = classifyBalance("No account (create on network)");
    expect(isMissingFromTotal(s, true)).toBe(false);
  });
});

describe("formatMissingLabel — always names the chains", () => {
  it("says nothing when nothing is missing", () => {
    expect(formatMissingLabel([])).toBe("");
  });

  it("names them up to the cap", () => {
    expect(formatMissingLabel(["Dogecoin"])).toBe("Dogecoin not loaded");
    expect(formatMissingLabel(["Dogecoin", "Bitcoin Cash", "Dash"])).toBe(
      "Dogecoin, Bitcoin Cash, Dash not loaded"
    );
  });

  /**
   * The reported UX failure: at four the old label collapsed to "4 not loaded"
   * and the user asked "which are not loaded?". It must never stop naming.
   */
  it("still names chains past the cap instead of collapsing to a count", () => {
    const label = formatMissingLabel([
      "Dogecoin",
      "Bitcoin Cash",
      "Dash",
      "Hedera",
    ]);
    expect(label).toBe("Dogecoin, Bitcoin Cash, Dash +1 more not loaded");
    expect(label).toContain("Dogecoin");
    expect(label).not.toBe("4 not loaded");
  });
});
