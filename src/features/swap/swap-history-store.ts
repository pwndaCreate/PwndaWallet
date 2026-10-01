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
import { atomicToDecimal } from "../../wallets/decimal-amount";
import { ASSET_CAPABILITIES } from "./asset-capabilities";

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
  /**
   * NEAR Intents only: the deposit address the quote minted (2026-09-29
   * send-safety audit, F5). 1Click's status is looked up BY this address, so
   * without it a row could not be followed once the confirm modal stopped
   * polling — and only the open modal ever polled. With it, pending rows are
   * resumed (`intents-status-resume.ts`).
   */
  depositAddress?: string;
  /**
   * NEAR Intents only: the deposit memo, for a memo deposit (Stellar,
   * 2026-09-30). The Stellar deposit address is shared by every depositor, so
   * the address alone does not name this swap: status is looked up by address
   * AND memo, and a resumed row must carry both.
   */
  depositMemo?: string;
  /** NEAR Intents only: the quote's deposit deadline, ISO8601 (F5). A short
   *  or late deposit is refunded by it, so tracking runs at least that long. */
  depositDeadline?: string;
  /**
   * True when the deposit MAY have gone out but the wallet could not confirm
   * it at the time (F2) — shown as "unknown, check the explorer", never as
   * failed. Cleared when 1Click reports a status for the deposit address.
   */
  outcomeUnknown?: boolean;
  /**
   * Why a row is `failed` when the wallet, not a provider, decided it
   * (2026-10-01): `"deposit-not-on-chain"`, a pending NEAR Intents row
   * whose deposit never reached its chain (`intents-stale-rows.ts`). Shown
   * as "not sent": nothing was swapped and nothing left the wallet.
   */
  failureReason?: "deposit-not-on-chain";
  /**
   * The quote's minimum received, display units of `toAsset` (2026-09-30).
   * Written with the row so the details view can show it after the quote
   * is gone; older rows have none and fall back to 1Click's echo.
   */
  minReceived?: string;
  /**
   * The addresses the quote was bound to (2026-09-30): where the swap pays
   * out (`recipient`, on the `toAsset` chain) and where a refund goes
   * (`refundTo`, on the `fromAsset` chain). Both are this wallet's. Older
   * NEAR Intents rows have neither; the details read them from 1Click's
   * echo of the request.
   */
  recipient?: string;
  refundTo?: string;
  /**
   * BasicSwap peer-to-peer swaps only (operator request, 2026-10-01: "Is it
   * possible to have the p2p swaps also tracked inside the swaps and recent
   * swaps sections?"). The bid's id on the local swap node, 56 hex
   * characters. The row's `id` is derived from it (`p2p-history.ts`,
   * `p2pHistoryId`), so the row written when the bid is placed, the one
   * adopted from the node's in-progress list and the one backfilled from its
   * sent bids are the same row, never three.
   */
  bidId?: string;
  /** P2P only: the offer the bid was placed on. The bid record names the
   *  other user by nothing else. */
  offerId?: string;
  /**
   * P2P only: the last bid state the swap node reported, in whatever form it
   * came: `bid_state_ind` (an int) from a read of the bid itself, upstream's
   * display string ("Scriptless coin locked") from a list row, or the
   * protocol name the tracker uses when a bid has just been placed
   * ("BID_SENT"). `bidStates.ts::classifyBidState` reads all three.
   */
  bidState?: number | string;
  /** P2P only: which coin this node locked, when a read of the bid said
   *  (`swapLegOf`). Four states mean opposite things to the two sides. */
  bidLeg?: "scriptless" | "scripted";
  /**
   * P2P only: the swap's transactions as the swap node reported them, each
   * under the engine's own name ("Chain A Lock", "Chain B Lock Spend", …, or
   * "Initiate Tx"/"Participate Tx" with the chain's ticker on a
   * scripted-to-scripted swap). Which one was "what you sent" and which
   * "what you received" is worked out from these in `p2p-history.ts`.
   */
  bidTxns?: { type: string; txid: string; ticker?: string }[];
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

/** Rows recorded before this date may hold `toAmount` in base units. */
const LEGACY_AMOUNT_CUTOFF_MS = Date.parse("2026-05-19T00:00:00Z");

/**
 * A row as the screens read it (2026-10-01). Rows written before 2026-05-19
 * — older than any code in this repository's history — stored a NEAR
 * Intents quote's `toAmount` in the asset's base units: the operator's
 * three ETH → BTC rows of 2026-05-06 hold "12521" for 0.00012521 BTC, and
 * the swap details read "~12521 BTC". Every later writer stores display
 * units (the 2026-05-28 AVAX → ADA row holds "3.61074"). Read-time only:
 * the stored row is not rewritten.
 */
export function normalizeLegacyAmounts(row: SwapHistoryEntry): SwapHistoryEntry {
  const created = Date.parse(row.createdAt);
  if (!Number.isFinite(created) || created >= LEGACY_AMOUNT_CUTOFF_MS) return row;
  if (!/^\d+$/.test(row.toAmount ?? "")) return row;
  const decimals = ASSET_CAPABILITIES[row.toAsset.toUpperCase()]?.decimals;
  if (!decimals) return row;
  return { ...row, toAmount: atomicToDecimal(BigInt(row.toAmount), decimals) };
}

export async function loadSwapHistory(): Promise<SwapHistoryEntry[]> {
  const store = await getStore();
  const list = ((await store.get<SwapHistoryEntry[]>(STORE_KEY)) ?? []).map(
    normalizeLegacyAmounts,
  );
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
function enqueueWrite(fn: () => Promise<void | false>): Promise<void> {
  // Listeners hear about a write only once it is committed; a write that
  // rejects changes nothing, so it notifies nobody. Nor does one that decided
  // there was nothing to write (`false`, from `modifySwapHistory`): the P2P
  // tracker asks every 15 seconds, and a list re-reading the store on every
  // unchanged answer is work for nothing.
  const next = writeQueue
    .then(fn, fn)
    .then((wrote) => {
      if (wrote !== false) notifySwapHistoryChange();
    });
  // Keep the chain alive even if one write rejects.
  writeQueue = next.catch(() => undefined);
  return next;
}

/**
 * Told after every committed history write (2026-09-30, the operator's
 * report: "I don't know what is happening with the swap now that it
 * disappeared").
 *
 * The lists that show swaps read this store when they mount (and when a
 * confirm modal closes) and never again. The status of a running swap is
 * written later, from a poll: the confirm modal's own (which outlives the
 * modal), the resume pass (`intents-status-resume.ts`), the details modal.
 * Each of those writes reached the store and not the screen, so a list kept
 * saying "pending" about a swap that had finished. A list subscribes here and
 * re-reads.
 */
const historyListeners = new Set<() => void>();

/** Subscribe to committed history writes. Returns the unsubscribe. */
export function onSwapHistoryChange(listener: () => void): () => void {
  historyListeners.add(listener);
  return () => {
    historyListeners.delete(listener);
  };
}

function notifySwapHistoryChange(): void {
  for (const listener of [...historyListeners]) {
    try {
      listener();
    } catch {
      // One listener's failure is its own; the write already succeeded.
    }
  }
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

/**
 * The whole list, read, changed and written back in ONE serialized step
 * (P2P swap history, 2026-10-01). `fn` gets the stored rows and returns the
 * rows to store, or `null` when nothing changes: then nothing is written and
 * no listener is told.
 *
 * For writers whose merge depends on the stored row, which a plain upsert
 * cannot express: a P2P row must never go back from a finished status to
 * "pending" on an answer that was read before the swap ended, and a backfill
 * writes many rows at once (one save of the wallet file, not one per row).
 * The 200-row cap applies to what `fn` returns.
 */
export async function modifySwapHistory(
  fn: (rows: SwapHistoryEntry[]) => SwapHistoryEntry[] | null
): Promise<void> {
  return enqueueWrite(async () => {
    const store = await getStore();
    const existing = (await store.get<SwapHistoryEntry[]>(STORE_KEY)) ?? [];
    const next = fn([...existing]);
    if (!next) return false;
    await store.set(STORE_KEY, next.slice(0, 200));
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
