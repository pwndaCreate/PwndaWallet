/**
 * Persistent swap history. Backed by `tauri-plugin-store` (the same file
 * that holds `wallet.dat` — distinct keys), so completed cross-chain swaps
 * survive a relaunch.
 *
 * Each entry captures source/destination assets, signed/broadcast tx
 * hashes, terminal status, and explorer URLs. The History tab reads this
 * via `loadSwapHistory()` and renders newest first.
 */
import { getStore } from "../../store";

const STORE_KEY = "swapHistory";

export type SwapHistoryStatus = "pending" | "success" | "refunded" | "failed";

export interface SwapHistoryEntry {
  /** UUID — generated client-side at the moment we kick off the broadcast. */
  id: string;
  /** Source asset ticker, e.g. "ETH". */
  fromAsset: string;
  /** Destination asset ticker, e.g. "BTC". */
  toAsset: string;
  /** Decimal-string amount sent in source units (e.g. "0.005"). */
  fromAmount: string;
  /** Decimal-string expected receive at quote-time. The destination tx may
   *  finalize at a slightly different amount within slippage tolerance. */
  toAmount: string;
  /**
   * Decimal-string actual delivered amount in destination units, captured at
   * terminal SUCCESS time by the polling layer. Populated for NEAR Intents
   * (1Click status response includes the executed `amountOut`). Best-effort
   * for SwapKit — depends on whether the destination-leg amount surfaces in
   * the /track response (see `extractActualReceivedFromSwapKit`).
   *
   * Optional and undefined for:
   *   - Historical entries created before 2026-05-26 (no migration; the
   *     History UI tolerates missing values by hiding the drift indicator).
   *   - In-flight entries that haven't reached terminal status yet.
   *   - SwapKit entries where the /track response shape didn't expose a
   *     destination-leg amount.
   *
   * When set, `(actualReceived - toAmount) / toAmount` is the quote→settle
   * drift; the History UI surfaces this with a tone (neutral / yellow /
   * red) per the thresholds in `formatDriftPercent`.
   */
  actualReceived?: string;
  /** ISO8601 of when `actualReceived` was confirmed. Distinct from
   *  `completedAt`, which is when the terminal status was first observed
   *  (the two are usually equal but might differ if the actual amount
   *  shows up on a follow-up status poll after the SUCCESS flip). */
  actualReceivedAt?: string;
  /** Most recent status — updates from `pending` → terminal as the
   *  cross-chain swap progresses. */
  status: SwapHistoryStatus;
  /** Source-chain tx hash (the user's signed broadcast). Always populated. */
  sourceTxHash: string;
  /** Destination-chain tx hash, when known. Populated by status polling. */
  destTxHash?: string;
  /** Pre-built explorer URL for the source tx. */
  sourceExplorerUrl: string;
  /** Pre-built explorer URL for the destination tx, when known. */
  destExplorerUrl?: string;
  /** Provider tag from the SwapKit route (e.g. "THORChain", "Chainflip"). */
  provider?: string;
  /** ISO8601 of when we kicked off the broadcast. */
  createdAt: string;
  /** ISO8601 of when we observed a terminal status. */
  completedAt?: string;
}

// ─── Drift helpers ────────────────────────────────────────────────────

/**
 * Compute the quote→settle drift as a signed fraction of the quoted
 * amount. Returns `null` when either side is missing or unparseable
 * (the History UI hides the drift indicator entirely in that case).
 *
 * A negative number means the user received LESS than quoted (the
 * common direction — slippage + bridge fees normally drag the actual
 * amount under the indicative quote). A positive number is unusual and
 * generally means an upside surprise from solver competition.
 */
export function computeDriftFraction(
  expected: string | undefined,
  actual: string | undefined
): number | null {
  if (!expected || !actual) return null;
  const e = Number(expected);
  const a = Number(actual);
  if (!Number.isFinite(e) || !Number.isFinite(a) || e <= 0) return null;
  return (a - e) / e;
}

/**
 * Tone bucket for a drift fraction. Used by the History UI to pick the
 * color of the drift chip — neutral (≤2% absolute), warn (2-5%), bad
 * (>5%). Returns `null` when there's no drift to show (no actual
 * amount captured yet). Tone is signed-agnostic: a +6% upside is just
 * as "anomalous" as a −6% loss from a calibration perspective, though
 * the user cares about the sign for their bottom line.
 */
export function driftTone(fraction: number | null): "neutral" | "warn" | "bad" | null {
  if (fraction == null) return null;
  const abs = Math.abs(fraction);
  if (abs <= 0.02) return "neutral";
  if (abs <= 0.05) return "warn";
  return "bad";
}

/**
 * Format a drift fraction for display. Returns the empty string when
 * `null`. Always includes a sign + `%` suffix and one decimal place
 * (e.g. `+0.3%`, `-4.5%`). The History UI uses this for the drift
 * chip text; the tone color comes from `driftTone`.
 */
export function formatDriftPercent(fraction: number | null): string {
  if (fraction == null) return "";
  const pct = fraction * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export async function loadSwapHistory(): Promise<SwapHistoryEntry[]> {
  const store = await getStore();
  const list = (await store.get<SwapHistoryEntry[]>(STORE_KEY)) ?? [];
  // Sort newest first. Defensive copy — never mutate the array we got back.
  return [...list].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
}

export async function appendSwapHistory(entry: SwapHistoryEntry): Promise<void> {
  return enqueueWrite(async () => {
    const store = await getStore();
    const existing = (await store.get<SwapHistoryEntry[]>(STORE_KEY)) ?? [];
    // Cap at 200 entries to avoid the store growing unboundedly.
    const next = [entry, ...existing.filter((e) => e.id !== entry.id)].slice(0, 200);
    await store.set(STORE_KEY, next);
    await store.save();
  });
}

export async function updateSwapHistoryEntry(
  id: string,
  patch: Partial<SwapHistoryEntry>
): Promise<void> {
  return enqueueWrite(async () => {
    const store = await getStore();
    const existing = (await store.get<SwapHistoryEntry[]>(STORE_KEY)) ?? [];
    const next = existing.map((e) => (e.id === id ? { ...e, ...patch } : e));
    await store.set(STORE_KEY, next);
    await store.save();
  });
}
/**
 * Project an 8.1 desk swap state onto the four-value history status union.
 *
 * The union is deliberately NOT widened: `SwapHistoryEntry` is constructed as a
 * bare object literal by several test fixtures, and history is DISPLAY ONLY -
 * the resumable protocol state lives in Rust's encrypted `desk-swaps/*.enc` and
 * is never read back to decide a protocol step.
 *
 * The projection is lossy and that is accepted: A_CLAIMED-but-not-SETTLED
 * collapses to 'pending', and ABORTED joins FAILED. An unrecognized state maps
 * to 'pending', mirroring `DeskSwapState::Unknown` being non-terminal on the
 * Rust side - a desk that adds a state must never make an in-flight swap look
 * finished.
 */
export function deskStateToHistoryStatus(state: string): SwapHistoryStatus {
  switch (state) {
    case "SETTLED":
      return "success";
    case "A_REFUNDED":
      return "refunded";
    case "FAILED":
    case "ABORTED":
      return "failed";
    case "ACCEPTED":
    case "A_LOCKED":
    case "B_LOCKED":
    case "READY":
    case "A_CLAIMED":
      return "pending";
    default:
      return "pending";
  }
}

/**
 * Serializes every write to the history key.
 *
 * All three writers are unlocked read-modify-write cycles against ONE store
 * key. Until now only the confirm modal wrote, one swap at a time. The desk
 * tracker writes for N concurrent swaps from a poll loop, and two overlapping
 * read-modify-writes drop an entry outright - the second one's read predates
 * the first one's write.
 */
let writeQueue: Promise<void> = Promise.resolve();
function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(fn, fn);
  // Keep the chain alive even if one write rejects.
  writeQueue = next.catch(() => undefined);
  return next;
}

/**
 * Append-if-absent / patch-if-present, in ONE read-modify-write.
 *
 * `updateSwapHistoryEntry` SILENTLY NO-OPS on an unknown id, so an entry that
 * was evicted by the 200-cap - or never appended because the app died between
 * accepting a swap and writing its row - would absorb every later status write
 * with no error and no row. The desk rehydrates from Rust, so it can legitimately
 * learn about a swap it has no local row for; it must upsert, not update.
 */
export async function upsertSwapHistoryEntry(
  entry: SwapHistoryEntry
): Promise<void> {
  return enqueueWrite(async () => {
    const store = await getStore();
    const existing = (await store.get<SwapHistoryEntry[]>(STORE_KEY)) ?? [];
    const prior = existing.find((e) => e.id === entry.id);
    const merged = prior ? { ...prior, ...entry } : entry;
    const next = [merged, ...existing.filter((e) => e.id !== entry.id)].slice(0, 200);
    await store.set(STORE_KEY, next);
    await store.save();
  });
}


/** Best-effort UUID without bringing in a dep. Good enough for keying rows. */
export function newSwapId(): string {
  // crypto.randomUUID is available in Tauri webviews (modern Chromium).
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random suffix. Collisions are uninteresting here.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
