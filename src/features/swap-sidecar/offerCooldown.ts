/**
 * The "do not bid on this again just yet" list.
 *
 * # Why this exists
 *
 * On 2026-09-05 the operator sent a bid for 0.00999999 XMR → 0.10309278 LTC
 * (bid `000000006a9c85685b…`) and it sat at `Sent` for 56 minutes before the
 * engine closed it: `bid_state_ind: 31`, *"Bid expired before being accepted"*.
 * Nothing was lost — an unaccepted bid commits no funds — but the hour was,
 * and the natural next move (quote again) walks straight back to the same
 * offer, because it is still the best price on the book and the maker is still
 * advertising it while being asleep.
 *
 * A maker that does not answer is not a maker that is *bad*: they may be
 * offline for an hour, or their node may be mid-restart. So this is a
 * **cooldown, not a ban** — the operator's own framing: *"I dont want to ban
 * the address from or offer id that we tried but put it in a temporary do not
 * bid on list that will expire after some time."* Entries carry an expiry and
 * are pruned on every read; nothing here is permanent and nothing is written
 * about a counterparty that outlives the session's usefulness.
 *
 * # What gets cooled down, and why both
 *
 * Two keys per incident: the **offer** and the **maker address**. The offer id
 * alone is not enough — upstream's makers re-post continuously (the offer that
 * expired at 22:11 UTC had a sibling on the book minutes later at the same
 * rate from the same `addr_from`), so cooling only the id would hand the user
 * the same sleeping counterparty under a new number. The maker address alone
 * is too broad in the other direction, and keeping both means a maker who is
 * healthy on one pair is not silently dropped from every other.
 *
 * # Not a secret, and not vault state
 *
 * A list of public offer ids from a public order book. It lives in
 * `localStorage` beside `pwnda-layout` for the same reason mining's
 * `devFeeAck` uses a plaintext store key: it is UX state, and putting it
 * behind a vault decrypt would make the "don't show me that maker again"
 * promise depend on being unlocked.
 */

/** How long an unanswered maker is skipped for. */
export const COOLDOWN_MS = 90 * 60 * 1000;

/**
 * 90 minutes, and the number is derived rather than picked. An offer's own
 * life is one hour (the expiry the engine gave the 2026-09-05 bid), so a
 * shorter cooldown would let the *same* advertisement come back while it is
 * still live. Longer than a few hours would start to look like the ban this
 * deliberately is not.
 */
export const COOLDOWN_REASON_EXPIRED = "did not accept the last bid in time";

/** Where the list lives. */
export const COOLDOWN_STORAGE_KEY = "pwnda-offer-cooldown";

export interface CooldownEntry {
  /** `offer:<id>` or `maker:<addr>`. */
  key: string;
  /** Unix millis. Past this the entry is gone. */
  until: number;
  /** Shown to the user, so they can tell a cooldown from an empty book. */
  reason: string;
  /** What it was about, for the message. */
  label: string;
}

/** The subset of an offer this module needs. */
export interface CooldownTarget {
  offerId: string;
  /** The maker's address (`offer.addr_from`), when the payload carried one. */
  makerAddress?: string | null;
}

export function offerKey(offerId: string): string {
  return `offer:${offerId.trim()}`;
}

export function makerKey(addr: string): string {
  return `maker:${addr.trim()}`;
}

/** Live entries only. Pruning on READ is what makes expiry automatic. */
export function activeCooldowns(
  entries: readonly CooldownEntry[],
  nowMs: number,
): CooldownEntry[] {
  return entries.filter((e) => e.until > nowMs);
}

/**
 * Add a cooldown for both keys of one target, replacing any existing entry.
 *
 * Re-cooling an already-cooled maker EXTENDS them rather than stacking, which
 * is the behaviour a second failed attempt should have.
 */
export function withCooldown(
  entries: readonly CooldownEntry[],
  target: CooldownTarget,
  nowMs: number,
  reason: string,
  ttlMs: number = COOLDOWN_MS,
): CooldownEntry[] {
  const until = nowMs + ttlMs;
  const keys: Array<[string, string]> = [
    [offerKey(target.offerId), `offer ${target.offerId.slice(0, 10)}…`],
  ];
  if (target.makerAddress && target.makerAddress.trim()) {
    keys.push([makerKey(target.makerAddress), `maker ${target.makerAddress.slice(0, 10)}…`]);
  }
  const kept = activeCooldowns(entries, nowMs).filter(
    (e) => !keys.some(([k]) => k === e.key),
  );
  return [...kept, ...keys.map(([key, label]) => ({ key, until, reason, label }))];
}

/** Is this offer currently cooled down? */
export function isCooledDown(
  entries: readonly CooldownEntry[],
  target: CooldownTarget,
  nowMs: number,
): boolean {
  const live = activeCooldowns(entries, nowMs);
  if (live.some((e) => e.key === offerKey(target.offerId))) return true;
  const addr = target.makerAddress?.trim();
  return !!addr && live.some((e) => e.key === makerKey(addr));
}

/**
 * Drop cooled-down offers from a pool.
 *
 * **Never returns an empty pool when the input was non-empty.** A cooldown is
 * a preference, not a safety rule: if every remaining offer is cooled down,
 * the user is better served by the book they have than by "no offers", which
 * they would correctly read as a broken screen. `skipped` says how many were
 * set aside so the caller can explain itself, and `exhausted` marks the case
 * where the filter was abandoned for this reason.
 */
export function applyCooldown<T extends CooldownTarget>(
  offers: readonly T[],
  entries: readonly CooldownEntry[],
  nowMs: number,
): { offers: T[]; skipped: number; exhausted: boolean } {
  const live = activeCooldowns(entries, nowMs);
  if (live.length === 0 || offers.length === 0) {
    return { offers: [...offers], skipped: 0, exhausted: false };
  }
  const kept = offers.filter((o) => !isCooledDown(live, o, nowMs));
  if (kept.length === 0) {
    return { offers: [...offers], skipped: 0, exhausted: true };
  }
  return { offers: kept, skipped: offers.length - kept.length, exhausted: false };
}

// =========================================================================
// Persistence — localStorage, guarded
// =========================================================================

/**
 * Read the list, pruned.
 *
 * Every access is wrapped: `localStorage` throws outright in a private window
 * and in a thumbnail/preview context, and a fee-free UX convenience must never
 * take the Swap tab down with it.
 */
export function loadCooldowns(nowMs: number = Date.now()): CooldownEntry[] {
  try {
    const raw = localStorage.getItem(COOLDOWN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.filter(
      (e): e is CooldownEntry =>
        !!e &&
        typeof e.key === "string" &&
        typeof e.until === "number" &&
        Number.isFinite(e.until),
    );
    return activeCooldowns(entries, nowMs);
  } catch {
    return [];
  }
}

export function saveCooldowns(entries: readonly CooldownEntry[]): void {
  try {
    localStorage.setItem(COOLDOWN_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* a cooldown that cannot be remembered is a cooldown, not an error */
  }
}

/** Record a target and persist, returning the new list. */
export function coolDown(
  target: CooldownTarget,
  reason: string,
  nowMs: number = Date.now(),
): CooldownEntry[] {
  const next = withCooldown(loadCooldowns(nowMs), target, nowMs, reason);
  saveCooldowns(next);
  return next;
}

/** Forget everything — the user's own "try them all again". */
export function clearCooldowns(): void {
  saveCooldowns([]);
}

/** `in 42 min` / `in 1h 05m`, for the note that explains a skip. */
export function cooldownRemaining(entry: CooldownEntry, nowMs: number): string {
  const s = Math.max(0, Math.round((entry.until - nowMs) / 1000));
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
