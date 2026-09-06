/**
 * **C4 / C6 — destination-pinned sweep-back.** Move funds from the swap node's
 * wallet back to the user's own wallet.
 *
 * # The security property, stated once
 *
 * **No function in this module accepts a destination address**, and neither
 * does the command it calls. `swap_bridge_prepare_sweep` derives the
 * destination Rust-side from the unlocked vault session; `executeSweep` takes
 * a `token` and a `confirmPhrase` and nothing else. A compromised renderer can
 * therefore ask for a sweep but cannot say where the money goes — that is the
 * whole feature (contract §R13), and adding a `destination` parameter anywhere
 * in this file undoes it.
 *
 * The confirm phrase is the second half: the user reads the destination off the
 * plan card and types its **last 6 characters**. There is no dialog plugin in
 * this app, so this is the mandatory confirmation, not a nicety. Rust checks it
 * independently — {@link isConfirmPhraseValid} is a mirror so a mistyped phrase
 * costs no round trip and burns no token.
 *
 * # Fail-closed clock
 *
 * The token lives {@link SWEEP_TOKEN_TTL_MS} and is single-use. Local expiry
 * checks fail closed: an unparseable `expiresAt` counts as **expired**. A clock
 * we cannot read is not a licence to spend.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  executeSweep,
  prepareSweep,
  type SweepPlan,
} from "../../api/basicswap";

export type { SweepPlan };

/** Rust mints tokens with this TTL (contract §1.6). Mirrored for countdown
 *  display; the authoritative deadline is always `plan.expiresAt`. */
export const SWEEP_TOKEN_TTL_MS = 120_000;

/** How many trailing characters of the destination the user must type. */
export const SWEEP_CONFIRM_LEN = 6;

// =========================================================================
// Pure helpers
// =========================================================================

/**
 * The phrase the user has to type: the last {@link SWEEP_CONFIRM_LEN}
 * characters of the plan's destination.
 *
 * Returns `""` for an empty/absent destination — and {@link isConfirmPhraseValid}
 * refuses `""` unconditionally, so a plan with no destination can never be
 * confirmed by typing nothing. A shorter-than-6 destination yields the whole
 * string rather than a padded one; no real address is that short, but silently
 * accepting a 2-character confirmation would be the wrong way to be wrong.
 */
export function confirmPhraseFor(plan: SweepPlan | null | undefined): string {
  const dest = plan?.destination;
  if (typeof dest !== "string" || dest === "") return "";
  return dest.slice(-SWEEP_CONFIRM_LEN);
}

/**
 * Does what the user typed match?
 *
 * **Exact and case-sensitive.** Addresses are case-significant in base58 and
 * in bech32's uppercase form, and Rust compares exactly; accepting a
 * case-insensitive match here would only produce a confirmation the backend
 * then rejects. Leading/trailing whitespace is trimmed, because that comes from
 * the input field rather than from the user's intent.
 *
 * An empty expected phrase (no destination) is **never** valid.
 */
export function isConfirmPhraseValid(
  plan: SweepPlan | null | undefined,
  typed: string | null | undefined,
): boolean {
  const want = confirmPhraseFor(plan);
  if (want === "") return false;
  if (typeof typed !== "string") return false;
  return typed.trim() === want;
}

/**
 * Has the plan's token expired?
 *
 * **Fails closed**: no plan, a missing `expiresAt`, or one that does not parse
 * all count as expired. A deadline we cannot read is not a deadline we are
 * inside.
 */
export function sweepPlanExpired(
  plan: SweepPlan | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!plan || typeof plan.expiresAt !== "string") return true;
  const at = Date.parse(plan.expiresAt);
  if (!Number.isFinite(at)) return true;
  return nowMs >= at;
}

/** Milliseconds left on the token, clamped at 0. `0` for an unreadable or
 *  absent deadline — same fail-closed rule as {@link sweepPlanExpired}. */
export function sweepPlanMsRemaining(
  plan: SweepPlan | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (!plan || typeof plan.expiresAt !== "string") return 0;
  const at = Date.parse(plan.expiresAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - nowMs);
}

/** `mm:ss` for the countdown. `"0:00"` once expired. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * One sentence describing what the plan will do. Display only.
 *
 * Says "everything" for a sweepall rather than inventing a number — the XMR
 * family sweeps the whole wallet and the amount is not known until the engine
 * builds the transaction.
 */
export function sweepSummary(plan: SweepPlan | null | undefined): string {
  if (!plan) return "";
  const what = plan.sweepall
    ? `everything the swap node holds in ${plan.coin.toUpperCase()}`
    : `${plan.amount ?? "?"} ${plan.coin.toUpperCase()}`;
  return `Send ${what} to your own wallet at ${plan.destination}.`;
}

// =========================================================================
// Hook
// =========================================================================

export interface SweepBackState {
  plan: SweepPlan | null;
  /** Txid of a completed sweep. */
  txid: string | null;
  busy: boolean;
  error: string | null;
  /** Recomputed on a 1 s tick while a plan is held. */
  expired: boolean;
  msRemaining: number;
  prepare(coin: string): Promise<SweepPlan>;
  /** The ONLY way to execute. Takes a phrase, never an address. */
  confirm(phrase: string): Promise<string>;
  cancel(): void;
}

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/**
 * Prepare / confirm / execute one sweep-back.
 *
 * `confirm(phrase)` refuses a wrong phrase and an expired plan **locally, with
 * no IPC** — so a mistyped confirmation cannot burn the single-use token and
 * force the user to start over. Rust re-checks both; these are convenience
 * refusals in front of the real ones.
 *
 * The hook never holds a destination the user could edit: `plan.destination` is
 * read-only display, straight from Rust.
 */
export function useSweepBack(opts: {
  enabled: boolean;
  sessionId: string | null;
}): SweepBackState {
  const { enabled, sessionId } = opts;
  const [plan, setPlan] = useState<SweepPlan | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Tick only while a live plan is held — no timer running behind a closed card.
  useEffect(() => {
    if (!plan) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [plan]);

  const prepare = useCallback(
    async (coin: string): Promise<SweepPlan> => {
      if (!enabled) throw new Error("the swap sidecar is not enabled");
      if (!sessionId) throw new Error("unlock your wallet first");
      setBusy(true);
      setError(null);
      setTxid(null);
      try {
        const p = await prepareSweep({ sessionId, coin });
        if (alive.current) setPlan(p);
        return p;
      } catch (e) {
        if (alive.current) {
          setPlan(null);
          setError(errMsg(e));
        }
        throw e;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [enabled, sessionId],
  );

  const confirm = useCallback(
    async (phrase: string): Promise<string> => {
      const current = plan;
      if (!current) throw new Error("there is no prepared sweep to confirm");
      if (sweepPlanExpired(current)) {
        const msg = "this sweep has expired — prepare it again";
        if (alive.current) setError(msg);
        throw new Error(msg);
      }
      if (!isConfirmPhraseValid(current, phrase)) {
        const msg = `type the last ${SWEEP_CONFIRM_LEN} characters of the destination to confirm`;
        if (alive.current) setError(msg);
        throw new Error(msg);
      }
      setBusy(true);
      setError(null);
      try {
        const id = await executeSweep({
          token: current.token,
          confirmPhrase: phrase.trim(),
        });
        if (alive.current) {
          setTxid(id);
          // The token is spent. Dropping the plan is what stops a second
          // confirm from being offered at all.
          setPlan(null);
        }
        return id;
      } catch (e) {
        if (alive.current) setError(errMsg(e));
        throw e;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [plan],
  );

  const cancel = useCallback(() => {
    setPlan(null);
    setError(null);
  }, []);

  return {
    plan,
    txid,
    busy,
    error,
    expired: plan ? sweepPlanExpired(plan, nowMs) : false,
    msRemaining: sweepPlanMsRemaining(plan, nowMs),
    prepare,
    confirm,
    cancel,
  };
}
