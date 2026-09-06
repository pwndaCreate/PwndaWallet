/**
 * One classifier for "what does this balance string actually mean", shared by
 * the portrait and landscape portfolio headers.
 *
 * # Why this exists
 *
 * Reported 2026-08-29: *"Why does it say 4 not loaded? Which are not loaded?
 * Why does hedera say no account created?"*
 *
 * Three separate faults sat behind that one question.
 *
 * **1. Portrait and landscape disagreed about the same input.** Given a
 * non-numeric balance, `DashboardView` did `parseFloat` → `NaN` → `continue`
 * (counted as *known-empty*, so not missing), while `WalletLandscapeView` did
 * `parseBalanceNumber` → `null` → **pushed to `missingNames`**. Same wallet,
 * same data, different count depending on which way the window was turned.
 *
 * **2. A known-absent account was reported as a load failure.** Hedera returns
 * `"No account (create on network)"` when the mirror node answers successfully
 * and finds no account for the derived key — a Hedera account has to be created
 * and funded by an existing account, so a fresh key genuinely has none. That is
 * a SUCCESSFUL read of a real on-network fact, and calling it "not loaded"
 * tells the user something is broken when nothing is.
 *
 * **3. `"Syncing…"` was in the same bucket as `"—"`.** One is a transient state
 * that resolves itself; the other is a fetch that failed. Lumping them made the
 * count flap while an XMR/ZPH sidecar warmed up.
 *
 * The distinction that matters to the user is **"is something wrong?"**, not
 * "is there a number?". Only `unloaded` answers yes.
 */

/** Balance strings that mean "the chain answered, and there is nothing here". */
const KNOWN_ABSENT: Readonly<Record<string, string>> = {
  "No account (create on network)":
    "no account exists on-network yet — Hedera accounts must be created and funded by an existing account",
};

/** Balance strings that mean "still coming", not "failed". */
const IN_PROGRESS = new Set(["Syncing…", "Syncing...", "Scanning…", "Scanning..."]);

export type BalanceStatus =
  /** A real, parseable amount. `amount > 0` means the chain holds funds. */
  | { kind: "value"; amount: number }
  /** Parsed and zero. Known-empty — not a problem, not missing. */
  | { kind: "empty" }
  /** The chain answered; there is deliberately nothing to show. Not a failure. */
  | { kind: "absent"; reason: string }
  /** Still arriving. Not a failure — do not alarm the user about it. */
  | { kind: "pending" }
  /** No usable answer: the fetch failed, or nothing has been fetched. */
  | { kind: "unloaded" };

export function classifyBalance(
  raw: string | undefined | null
): BalanceStatus {
  if (raw == null) return { kind: "unloaded" };
  const s = raw.trim();
  if (s === "" || s === "—" || s === "-" || s === "Not initialized") {
    return { kind: "unloaded" };
  }
  const absent = KNOWN_ABSENT[s];
  if (absent) return { kind: "absent", reason: absent };
  if (IN_PROGRESS.has(s)) return { kind: "pending" };

  // Validate the SHAPE before parsing. `parseFloat` is not a validator: it
  // returns 0 for "0x10", 12 for "12abc", 100000 for "1e5" and Infinity for
  // "Infinity" — so a string nobody can read would classify as `empty`, i.e.
  // this chain holds nothing. That is the hide-real-funds direction, and it is
  // the same trap `swap-balance-subline.ts` documents for engine amounts.
  // Caught by "treats an unrecognised string as unloaded, never as empty".
  const cleaned = s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { kind: "unloaded" };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { kind: "unloaded" };
  return n === 0 ? { kind: "empty" } : { kind: "value", amount: n };
}

/**
 * Should this chain be reported to the user as "not loaded"?
 *
 * True only for a genuine gap in the total: a balance we could not read at all,
 * or funds we hold but could not price. `empty`, `absent` and `pending` are all
 * states where the number on screen is already the honest one.
 */
export function isMissingFromTotal(
  status: BalanceStatus,
  hasPrice: boolean
): boolean {
  switch (status.kind) {
    case "unloaded":
      return true;
    case "value":
      return status.amount > 0 && !hasPrice;
    case "empty":
    case "absent":
    case "pending":
      return false;
  }
}

/**
 * The header's eyebrow.
 *
 * **Always names chains.** The old rule named them at ≤ 3 and fell back to a
 * bare `"4 not loaded"` above that — which drops the names at exactly the point
 * the user most needs them, and produced the report this module answers. Beyond
 * `maxNames` it names the first few and counts the rest, so the line stays short
 * without ever being uninformative.
 */
export function formatMissingLabel(
  names: readonly string[],
  maxNames = 3
): string {
  if (names.length === 0) return "";
  if (names.length <= maxNames) return `${names.join(", ")} not loaded`;
  const shown = names.slice(0, maxNames).join(", ");
  return `${shown} +${names.length - maxNames} more not loaded`;
}
