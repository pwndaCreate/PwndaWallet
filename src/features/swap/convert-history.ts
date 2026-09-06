/**
 * src/features/swap/convert-history.ts
 *
 * The CONVERSIONS list behind the EARN tab and the portrait CONVERT mode
 * (canvas frames 1d / 1e).
 *
 * A conversion is a two-hop pipeline run, which is not the same object as
 * either hop. Hop 1 is a peer-to-peer bid tracked by `useSidecarSwap`; hop 2
 * is an ordinary NEAR Intents swap that lands in `swap-history-store` like any
 * other. Neither store knows the two are related, so the relationship is what
 * this file persists — nothing else.
 *
 * # Status, kept to what is actually observable
 *
 * - `running`    — hop 1 is in flight, or has settled and hop 2 has not been
 *                  started yet.
 * - `done`       — hop 2 was submitted. The pipeline's job ends there; the
 *                  NEAR leg's own settlement is tracked in Activity, and the
 *                  UI says so rather than this store claiming an outcome it
 *                  cannot see.
 * - `unwound`    — hop 1 refunded / cancelled / was recovered by the
 *                  counterparty. A normal outcome of that protocol, not an
 *                  error, and deliberately not called "failed".
 *
 * Storage is `localStorage`, matching `swap-history-store`'s custody model:
 * this is a convenience log of the user's own activity, holds no secrets, and
 * losing it costs a list — never funds.
 */

const KEY = "pwnda.convert.history";
const MAX_ENTRIES = 50;

export interface ConversionRecord {
  /** Hop 1's bid id — stable, and the only id the pipeline ever holds. */
  id: string;
  fromTicker: string;
  /** The route hop (LTC today), kept so a future route change stays readable. */
  viaTicker: string;
  toTicker: string;
  fromAmount: string;
  /** Hop 1's output; the input to hop 2. Empty until hop 1 settles. */
  viaAmount: string;
  /** Projected target amount at the time hop 2 was started. */
  toAmount: string;
  startedAt: number;
  status: "running" | "done" | "unwound";
}

function read(): ConversionRecord[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ConversionRecord[]) : [];
  } catch {
    return [];
  }
}

function write(rows: ConversionRecord[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage disabled — the pipeline still works, the log just does not persist */
  }
}

export function loadConversions(): ConversionRecord[] {
  return read().sort((a, b) => b.startedAt - a.startedAt);
}

/** Record a pipeline run at the moment hop 1 is adopted. Idempotent by id. */
export function recordConversionStarted(rec: ConversionRecord): void {
  const rows = read();
  if (rows.some((r) => r.id === rec.id)) return;
  write([rec, ...rows]);
}

/** Patch an existing run; a no-op when the id is unknown. */
export function updateConversion(
  id: string,
  patch: Partial<Omit<ConversionRecord, "id">>,
): void {
  const rows = read();
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return;
  rows[i] = { ...rows[i], ...patch };
  write(rows);
}

/** "3d ago" / "9h ago" / "just now" — the age column in the mocks. */
export function conversionAge(startedAt: number, now = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}
