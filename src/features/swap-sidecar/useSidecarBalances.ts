/**
 * The swap node's own wallet balances — read via the allow-listed proxy,
 * normalised into rows the UI can render without knowing upstream's quirks.
 *
 * This is the **C0.1** read surface: what the BasicSwap node holds, shown
 * inside PwndaWallet so the user never has to open the node's own web console
 * to answer "did my funding land?".
 *
 * # Why `/json/wallets` and not `/json/walletbalances`
 *
 * The two endpoints are different shapes and only one of them can back this
 * card (contract §R19, and see `BasicSwapWalletInfo` in `src/api/basicswap.ts`
 * for the full table):
 *
 *   - `/json/wallets` → ticker-keyed **object**, carries `deposit_address`.
 *   - `/json/walletbalances` → **array**, no `deposit_address`, and its
 *     `ticker` is not unique (PART_ANON / PART_BLIND / LTC_MWEB reuse their
 *     parent's ticker, js_server.py:266-274 / :298-306).
 *
 * The sandbox mock used to answer BOTH with the object, so a consumer built on
 * the wrong one looked correct in `dev:sandbox` and produced an empty card in
 * production. {@link balanceRowsFrom} therefore refuses an array **loudly**
 * rather than yielding `{}` — an empty card is the exact failure mode that
 * defect produced, so "no rows" must never be how a shape error presents.
 *
 * # Error isolation
 *
 * Upstream fails per coin: `getWalletsInfo` catches inside the loop and writes
 * `{name, error}` for that ticker only (basicswap.py:15574). A DOGE daemon
 * that is down must not blank the BTC row. So per-coin faults land on
 * `SidecarBalanceRow.error` and every other row survives; only a whole-body
 * `{error}` (which is what C5's `LockedCoinError` produces) reaches the hook's
 * top-level `error`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchWallets,
  isApiError,
  normalizeDepositAddress,
  type BasicSwapWalletInfo,
} from "../../api/basicswap";

/** One coin's line in the balances card. Amounts stay decimal **strings** —
 *  never parsed to a float on the way in (contract §0.3). */
export interface SidecarBalanceRow {
  /** UPPERCASE ticker, e.g. `"BTC"`. */
  ticker: string;
  /** Decimal string, or `null` when this coin did not report one. */
  balance: string | null;
  /** Unconfirmed, decimal string. `null` when not reported. */
  pending: string | null;
  /** `null` when upstream returned a PLACEHOLDER rather than an address —
   *  see {@link normalizeDepositAddress}. A copy/QR affordance must key off
   *  this being non-null, never off the raw field. */
  depositAddress: string | null;
  /** Core-model wallet lock. `true` ⇒ the node cannot sign for this coin. */
  locked: boolean;
  /** This coin's own failure, isolated. Other rows are unaffected. */
  error: string | null;
  /** Chain height the swap node has, or `null` when not reported. */
  blocks: number | null;
  /** Verified-fraction percent, or `null`. **Not** download progress — see
   *  {@link BasicSwapWalletInfo.synced}. Use {@link syncStateOf}. */
  syncedPercent: number | null;
  /** Target height when the coin reports one. */
  knownBlockCount: number | null;
  /** Fetching a chain snapshot rather than syncing block-by-block. */
  bootstrapping: boolean;
  /** `"rpc"` (local daemon) or `"electrum"` (no local chain). */
  connectionType: string | null;
  /**
   * The engine's own `knownWalletSeed()` (`basicswap.py`'s `expected_seed`)
   * — `false` means the engine has not (yet, or ever) confirmed this coin's
   * wallet was derived from the seed/key it expects. For a lean/electrum
   * coin under C8 this is `false` during the warm-up window between "wallet
   * key pushed" and the engine's `WalletManager` confirming it — a coin can
   * show a real, positive BALANCE from pwnda's own adapter while this is
   * still `false`, because the two reads come from different places. `null`
   * when the field was absent (an older engine, or a `{name, error}` row).
   *
   * This is NOT a display concern — `sharedCoinBalance.ts` already reads the
   * raw field for that. It exists on this row because a bid on a coin whose
   * `expected_seed` is `false` is refused by the engine's own
   * `checkCoinsReady` with `"<coin> has an unexpected wallet seed and
   * \"restrict_unknown_seed_wallets\" is enabled."` — a real refusal hit
   * 2026-08-22 with no advance warning anywhere in the UI, because nothing
   * checked this before letting the user reach "Send bid".
   */
  expectedSeed: boolean | null;
}

/**
 * What a coin's chain is actually doing, in terms a user can act on.
 *
 * # Why this is not just `synced >= 100`
 *
 * `synced` is `verificationprogress`, i.e. *of the blocks I have, how many
 * have I verified* — so a daemon that has downloaded **nothing** reports
 * `blocks: 0, synced: "100.00"`. Reading the percent alone would paint a
 * chain that has never connected to a peer as fully synced, which is exactly
 * the state this project hit on 2026-08-20: a particld launched with
 * `-noconnect` sitting at height 0 while nothing in the UI said so.
 *
 * So height is checked FIRST, and `0` is its own state.
 */
export type SyncState =
  | { kind: "no-chain" }
  | { kind: "unknown" }
  | { kind: "not-started" }
  | { kind: "bootstrapping"; blocks: number }
  | { kind: "syncing"; blocks: number; percent: number | null; target: number | null }
  | { kind: "synced"; blocks: number };

/** Percent at or above which a chain counts as caught up. */
const SYNCED_AT = 99.99;

/** Classify one row. Pure; exported for test and for both card surfaces. */
export function syncStateOf(row: SidecarBalanceRow): SyncState {
  // An electrum coin has no local chain, so height questions are meaningless
  // rather than unanswered — a distinct state, not "unknown".
  if (row.connectionType === "electrum") return { kind: "no-chain" };
  if (row.error != null) return { kind: "unknown" };
  if (row.blocks == null) return { kind: "unknown" };
  if (row.blocks === 0) return { kind: "not-started" };
  if (row.bootstrapping) return { kind: "bootstrapping", blocks: row.blocks };
  // A reported target beats the percent: it is the only field that can say
  // "you have 5 of 900000 blocks", which a verification percent cannot.
  if (row.knownBlockCount != null && row.knownBlockCount > row.blocks) {
    return {
      kind: "syncing",
      blocks: row.blocks,
      percent: row.syncedPercent,
      target: row.knownBlockCount,
    };
  }
  if (row.syncedPercent != null && row.syncedPercent < SYNCED_AT) {
    return {
      kind: "syncing",
      blocks: row.blocks,
      percent: row.syncedPercent,
      target: row.knownBlockCount,
    };
  }
  return { kind: "synced", blocks: row.blocks };
}

/** One-line display copy for a {@link SyncState}. Never branch on it. */
export function syncSentence(st: SyncState): string {
  switch (st.kind) {
    case "no-chain":
      return "light mode — no local chain to sync";
    case "unknown":
      return "sync state unavailable";
    case "not-started":
      return "no blocks yet — this chain has not started downloading";
    case "bootstrapping":
      return `fetching a chain snapshot (${st.blocks.toLocaleString()} blocks)`;
    case "syncing": {
      const head = st.target
        ? `${st.blocks.toLocaleString()} of ~${st.target.toLocaleString()} blocks`
        : `${st.blocks.toLocaleString()} blocks`;
      return st.percent != null
        ? `syncing — ${head} (${st.percent.toFixed(2)}% verified)`
        : `syncing — ${head}`;
    }
    case "synced":
      return `synced — ${st.blocks.toLocaleString()} blocks`;
  }
}

/** Thrown by {@link balanceRowsFrom} when the body is not the ticker-keyed
 *  object — most usefully when someone has pointed it at
 *  `/json/walletbalances`. Named so a `catch` can tell a shape fault from a
 *  transport fault. */
export class SidecarBalanceShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarBalanceShapeError";
  }
}

const ZEROISH = /^0(\.0*)?$/;

/** Sync fields for a row that carries none. Spread, so adding a field to
 *  {@link SidecarBalanceRow} cannot leave one of the three exits behind. */
const NO_SYNC = {
  blocks: null,
  syncedPercent: null,
  knownBlockCount: null,
  bootstrapping: false,
  connectionType: null,
} as const;

/** A non-negative integer field, or `null`. Rejects NaN and negatives rather
 *  than passing them to `toLocaleString`, where they would render as real. */
function count(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Upstream sends the percent as a STRING (`"100.00"`). */
function percent(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Upstream writes `"0.0"` for "nothing here"; keep it as-is, it is still a
 *  real reported amount. Only absent/blank becomes `null`. */
function amount(v: unknown): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** True when a pending string carries no value worth rendering. Exported
 *  because the card and any future consumer must agree on it. */
export function isZeroAmount(v: string | null): boolean {
  return v == null || ZEROISH.test(v.trim());
}

/**
 * Raw `/json/wallets` body → rows, keyed by UPPERCASE ticker.
 *
 * Pure, and exported for test. **Throws** {@link SidecarBalanceShapeError} on
 * anything that is not the ticker-keyed object: an array (the
 * `walletbalances` shape), a scalar, `null`. It does not return `{}` for
 * those, because `{}` is indistinguishable from a node with no configured
 * coins and would hide the exact defect §R19 describes.
 *
 * A whole-body `{error}` is NOT this function's job — narrow it with
 * `isApiError` before calling.
 */
export function balanceRowsFrom(raw: unknown): Record<string, SidecarBalanceRow> {
  if (Array.isArray(raw)) {
    throw new SidecarBalanceShapeError(
      "expected the ticker-keyed object from /json/wallets, got an array — " +
        "that is the /json/walletbalances shape, which has no deposit_address " +
        "and does not have unique tickers",
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new SidecarBalanceShapeError(
      `expected the ticker-keyed object from /json/wallets, got ${
        raw === null ? "null" : typeof raw
      }`,
    );
  }

  const out: Record<string, SidecarBalanceRow> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const ticker = key.toUpperCase();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      out[ticker] = {
        ticker,
        balance: null,
        pending: null,
        depositAddress: null,
        locked: false,
        error: "malformed wallet entry",
        expectedSeed: null,
        ...NO_SYNC,
      };
      continue;
    }
    const w = value as BasicSwapWalletInfo;
    // The `{name, error}` shape. Everything else on the row stays null — a
    // balance from a previous poll must not survive next to a fresh error.
    if (typeof w.error === "string" && w.error !== "") {
      out[ticker] = {
        ticker,
        balance: null,
        pending: null,
        depositAddress: null,
        locked: false,
        error: w.error,
        expectedSeed: null,
        // The `{name, error}` shape carries no blockchain info either, and a
        // height from a previous poll must not survive next to a fresh error
        // any more than a balance may.
        ...NO_SYNC,
      };
      continue;
    }
    out[ticker] = {
      ticker,
      balance: amount(w.balance),
      pending: amount(w.unconfirmed),
      depositAddress: normalizeDepositAddress(w.deposit_address),
      locked: w.locked === true,
      error: null,
      blocks: count(w.blocks),
      syncedPercent: percent(w.synced),
      knownBlockCount: count(w.known_block_count),
      bootstrapping: w.bootstrapping === true,
      connectionType:
        typeof w.connection_type === "string" && w.connection_type !== ""
          ? w.connection_type
          : null,
      expectedSeed: typeof w.expected_seed === "boolean" ? w.expected_seed : null,
    };
  }
  return out;
}

/**
 * The supervisor's own refusal when no node is up — verbatim from
 * `swap_sidecar.rs:3746` (`api_context`). Matched as a substring because it
 * arrives wrapped by Tauri's error plumbing.
 */
export const SIDECAR_NOT_RUNNING = "the swap node is not running";

/**
 * Is this error just "there is no node right now"?
 *
 * Exported for test, and deliberately **narrow**: it matches one literal
 * string. A stopped node is an ordinary state, not a fault, so it degrades to
 * a quiet empty card — but every OTHER failure, including a wrong-shape body,
 * must still surface. Broadening this predicate is how a real fault gets
 * swallowed.
 */
export function isNodeNotRunning(message: string): boolean {
  return message.includes(SIDECAR_NOT_RUNNING);
}

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/** Default poll period. Wallet info is not free upstream —
 *  `updateWalletsInfo` fans out RPC calls across every active coin. */
export const BALANCES_POLL_MS = 20_000;
/** Floor, so a caller cannot turn the card into an RPC hammer. */
export const BALANCES_POLL_FLOOR_MS = 15_000;

export interface SidecarBalancesState {
  rows: Record<string, SidecarBalanceRow>;
  loading: boolean;
  /** Transport / whole-body error only. Per-coin faults live on the rows. */
  error: string | null;
  refresh(): void;
}

/**
 * Poll the swap node's wallets.
 *
 * `enabled` **must** be `useSwapSidecarOptIn() === true`. The fresh-install
 * contract is that nothing invokes a `swap_sidecar_*` command before opt-in,
 * and `optedIn === null` (read still in flight) counts as not enabled — pass
 * `optedIn === true`, not `optedIn !== false`.
 *
 * Degrades quietly when the node is down: `SIDECAR_NOT_RUNNING` clears the
 * rows and leaves `error` null, because "not running" is a state the user
 * already controls from the Settings card and does not need reported as a
 * failure on every tick. Everything else is surfaced.
 */
export function useSidecarBalances(opts: {
  enabled: boolean;
  intervalMs?: number;
}): SidecarBalancesState {
  const { enabled } = opts;
  const intervalMs = Math.max(
    BALANCES_POLL_FLOOR_MS,
    opts.intervalMs ?? BALANCES_POLL_MS,
  );

  const [rows, setRows] = useState<Record<string, SidecarBalanceRow>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  /** True while a fetch is outstanding — see `load`. */
  const inFlight = useRef(false);
  // Guards against a slow poll landing after the next one — last write wins
  // would otherwise let a stale body overwrite a fresh one.
  const seq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * One request at a time.
   *
   * The `seq` guard above discards a STALE RESULT; it does not stop a new
   * request being issued while one is still running. Under a slow ElectrumX
   * server that distinction is the whole problem: `/json/wallets` serialises
   * inside the engine on one lock, a single call can hold it for ~25s across
   * its retry-and-reconnect path, and a fixed-interval poll then stacks more
   * waiters onto it every tick. The engine reports that as
   * "Electrum ... timed out waiting for lock", which reads like a network
   * fault and is actually self-inflicted congestion — observed on the
   * operator's node 2026-08-21, starving the balance read for their own
   * shared BTC address.
   *
   * Skipping a tick while one is in flight costs nothing (the next tick is
   * seconds away) and removes this client as a source of the contention.
   */
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const body = await fetchWallets();
      if (!alive.current || mine !== seq.current) return;
      if (isApiError(body)) {
        // Whole-body refusal (C5's LockedCoinError arrives as
        // `{error, locked: true}`). No rows are trustworthy.
        setRows({});
        setError(body.error);
        return;
      }
      setRows(balanceRowsFrom(body));
      setError(null);
    } catch (e) {
      if (!alive.current || mine !== seq.current) return;
      const msg = errMsg(e);
      setRows({});
      setError(isNodeNotRunning(msg) ? null : msg);
    } finally {
      inFlight.current = false;
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Drop whatever the last enabled run left behind, so a revoked opt-in
      // does not leave balances on screen.
      seq.current++;
      setRows({});
      setError(null);
      setLoading(false);
      return;
    }
    let stopped = false;
    const tick = () => {
      if (!stopped) void load();
    };
    tick();
    const id = window.setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [enabled, intervalMs, load]);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  return { rows, loading, error, refresh };
}
