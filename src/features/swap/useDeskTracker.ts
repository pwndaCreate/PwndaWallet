/**
 * Owns the lifetime of in-flight desk swaps.
 *
 * ## Why this lives in the App shell, not in a swap view
 *
 * A desk swap runs 10-60 minutes. `SwapView` is mounted behind
 * `view === "swap"` and `SwapLandscapeView` behind `landscapeTab === "swap"`,
 * so BOTH fully unmount the moment the user looks at their wallet, mining, or
 * activity — which will happen during a swap that long. Polling and history
 * writes therefore live here, in a hook mounted above the view router, and the
 * tracker MODAL is hoisted alongside it. The tracker component itself is a pure
 * view precisely because it gets unmounted and remounted repeatedly.
 *
 * ## What it deliberately does NOT gate on
 *
 * `VITE_DESK_LIVE` gates ACCEPTING a new swap (in `desk-execute`), never
 * resuming one. Gating resume on that flag would strand funds for anyone who
 * flips it off — or upgrades into a build with a different default — while a
 * swap is mid-flight. New swaps are blocked by the flag; in-flight swaps are
 * always tracked and always refundable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deskListActive,
  deskStatus,
  type DeskSwapSummary,
} from "../../api/desk-rust";
import { deskAmountsFor, deskCoinsFor } from "./asset-capabilities";
import { ROUTER_MODES } from "./router-modes";
import { SWAP_COIN_META } from "./swap-data";
import {
  deskStateToHistoryStatus,
  upsertSwapHistoryEntry,
} from "./swap-history-store";

/** How often each non-terminal swap is re-polled. */
const POLL_MS = 15_000;

const TERMINAL = new Set(["SETTLED", "A_REFUNDED", "FAILED", "ABORTED"]);

/**
 * CC-5: `A_REFUNDED` covers two OPPOSITE outcomes, and the desk publishes
 * `swipeTxid` so they can be told apart.
 *
 * - **B2, a cooperative refund.** The leader's refund is an ADAPTOR signature,
 *   so publishing it reveals `s_a` and our chain-B leg can be reclaimed
 *   automatically. Nothing is needed from anyone.
 * - **B3, a leader-only swipe after T2.** An ORDINARY signature that reveals
 *   nothing. Our chain-B coin is stranded until the counterparty volunteers its
 *   key share BY HAND.
 *
 * The desk state is `A_REFUNDED` for both. Calling both "refunded" tells a user
 * their funds are on the way back when in one case they are not — so the label
 * is derived from the field, never from the state alone.
 *
 * This is a CROSS-CHECK and not a verdict: the Rust tier reads the chain and
 * that is what decides. This is the UI's label, chosen from the same evidence.
 */
export type DeskRecoveryKind = "refund" | "swipe" | "unknown";

export function recoveryKind(s: {
  state: string;
  swipeTxid?: string | null;
}): DeskRecoveryKind {
  if (s.state !== "A_REFUNDED") return "unknown";
  return (s.swipeTxid ?? "").trim() ? "swipe" : "refund";
}

/** The user-facing sentence for each. Deliberately not interchangeable. */
export function recoveryLabel(kind: DeskRecoveryKind): string {
  switch (kind) {
    case "refund":
      return "Refunded — the counterparty's refund revealed the secret, so your leg is reclaimable automatically.";
    case "swipe":
      return "Swept by the counterparty after the deadline — this reveals no secret, so recovering your leg needs their key share by hand. Contact the desk.";
    default:
      return "";
  }
}

/**
 * Which chain leg the CLIENT locked.
 *
 * `deskRole` is the DESK's role and the client is always the opposite, so a
 * desk LEADER means the client follows and locks chain B. Getting this backwards
 * labels the counterparty's lock as the user's own send.
 */
function clientLockTxid(
  deskRole: string,
  s: { lockATxid?: string | null; lockBTxid?: string | null }
): string {
  const clientLeadsChainA = deskRole === "FOLLOWER";
  return (clientLeadsChainA ? s.lockATxid : s.lockBTxid) ?? "";
}

function explorerFor(ticker: string, hash: string): string {
  if (!hash) return "";
  const meta = SWAP_COIN_META[ticker.toUpperCase()];
  try {
    return meta?.explorerTxUrl?.(hash) ?? "";
  } catch {
    return "";
  }
}

/** Desk timestamps are unix SECONDS; history sorts by LEXICOGRAPHIC string
 *  compare, so a raw number here would reorder the entire history list. */
function isoFromUnixSeconds(sec: number): string {
  const ms = Number(sec) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return new Date().toISOString();
  return new Date(ms).toISOString();
}

/** Project a summary onto a history row. Carries NO protocol material —
 *  swapHistory is a PLAINTEXT key inside wallet.dat. */
function historyRowFor(s: DeskSwapSummary, destTxHash?: string) {
  const coins = deskCoinsFor(s.pair, s.direction);
  const amounts = deskAmountsFor({
    pair: s.pair,
    direction: s.direction,
    amountA: s.amountA,
    amountB: s.amountB,
  });
  const fromAsset = coins?.coinIn ?? "";
  const toAsset = coins?.coinOut ?? "";
  const sourceTxHash = clientLockTxid(s.deskRole, s);
  const terminal = TERMINAL.has(s.state);
  return {
    // The DESK's swapId, never a fresh uuid: it makes rehydrate idempotent and
    // keeps updates resolving after a relaunch, since nothing persists a
    // uuid -> swapId map and the Rust store holds no TS uuid.
    id: s.swapId,
    fromAsset,
    toAsset,
    fromAmount: amounts?.amountIn ?? "",
    toAmount: amounts?.amountOut ?? "",
    status: deskStateToHistoryStatus(s.state),
    sourceTxHash,
    sourceExplorerUrl: explorerFor(fromAsset, sourceTxHash),
    destTxHash: destTxHash || undefined,
    destExplorerUrl: destTxHash ? explorerFor(toAsset, destTxHash) : undefined,
    provider: `${ROUTER_MODES["pwnda-desk"].label} - atomic`,
    createdAt: isoFromUnixSeconds(s.createdAt),
    completedAt: terminal ? new Date().toISOString() : undefined,
    // actualReceived stays UNDEFINED. No desk DTO carries a settled amount, and
    // synthesizing one from amountA/amountB is the exact anti-pattern the drift
    // tests pin against — it would render a fabricated 0% drift chip.
  };
}

export interface DeskTrackerState {
  /** Non-terminal swaps known to the Rust store. */
  activeSwaps: DeskSwapSummary[];
  /** The swap the tracker modal is showing, if any. */
  trackedSwap: DeskSwapSummary | null;
  trackerOpen: boolean;
  /** Called by the confirm modal when a swap is accepted. */
  adopt: (summary: DeskSwapSummary) => void;
  openTracker: (summary: DeskSwapSummary) => void;
  closeTracker: () => void;
  /** Re-read the active list from Rust. */
  refresh: () => void;
}

export function useDeskTracker(opts: { enabled: boolean }): DeskTrackerState {
  const { enabled } = opts;
  const [activeSwaps, setActiveSwaps] = useState<DeskSwapSummary[]>([]);
  const [trackedSwap, setTrackedSwap] = useState<DeskSwapSummary | null>(null);
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  // Guards one history write per (swapId, state) so a 15s poll that sees no
  // change does not rewrite the store every tick.
  const lastWritten = useRef<Map<string, string>>(new Map());
  /** Ensures a rehydrated swap is announced once per session, not on every poll. */
  const adoptedOnce = useRef(false);

  const writeRow = useCallback(
    async (s: DeskSwapSummary, destTxHash?: string) => {
      const key = `${s.state}|${destTxHash ?? ""}`;
      if (lastWritten.current.get(s.swapId) === key) return;
      lastWritten.current.set(s.swapId, key);
      try {
        await upsertSwapHistoryEntry(historyRowFor(s, destTxHash));
      } catch (e) {
        console.warn("[desk-tracker] history write failed", e);
      }
    },
    []
  );

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Adopt the active list from Rust whenever enabled (or refreshed).
  useEffect(() => {
    if (!enabled) {
      setActiveSwaps([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await deskListActive();
        if (cancelled) return;
        setActiveSwaps(list);
        for (const s of list) void writeRow(s);
        // Surface a rehydrated swap ONCE per session. A swap that was still
        // in flight when the app closed is holding the user's funds in a joint
        // lock with a refund deadline running — finding that out only if they
        // happen to visit the Swap tab is not acceptable. `adoptedOnce` keeps
        // it to a single announcement rather than reopening on every refresh.
        if (list.length > 0 && !adoptedOnce.current) {
          adoptedOnce.current = true;
          setTrackedSwap(list[0]);
          setTrackerOpen(true);
        }
      } catch (e) {
        // Expected on a cold launch if the data dir has not been resolved yet;
        // the Rust rehydrate seeds it, and the next refresh succeeds.
        console.warn("[desk-tracker] deskListActive failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, nonce, writeRow]);

  // Poll each non-terminal swap and mirror progress into history.
  useEffect(() => {
    if (!enabled || activeSwaps.length === 0) return;
    let cancelled = false;

    const tick = async () => {
      for (const s of activeSwaps) {
        if (TERMINAL.has(s.state)) continue;
        try {
          const st = await deskStatus(s.swapId);
          if (cancelled) return;
          // claim/sweep txids exist ONLY on the status view, never on the
          // summary — which is why destTxHash requires this poll.
          const destTxHash =
            s.deskRole === "FOLLOWER" ? st.sweepBTxid : st.claimATxid;
          const advanced: DeskSwapSummary = {
            ...s,
            state: st.state,
            lockATxid: st.lockATxid || s.lockATxid,
            lockBTxid: st.lockBTxid || s.lockBTxid,
          };
          void writeRow(advanced, destTxHash);
          if (st.state !== s.state) {
            setActiveSwaps((prev) =>
              prev
                .map((p) => (p.swapId === s.swapId ? advanced : p))
                .filter((p) => !TERMINAL.has(p.state))
            );
            setTrackedSwap((prev) =>
              prev && prev.swapId === s.swapId ? advanced : prev
            );
          }
        } catch (e) {
          console.warn("[desk-tracker] poll failed", s.swapId, e);
        }
      }
    };

    const handle = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [enabled, activeSwaps, writeRow]);

  const openTracker = useCallback((summary: DeskSwapSummary) => {
    setTrackedSwap(summary);
    setTrackerOpen(true);
  }, []);

  const adopt = useCallback(
    (summary: DeskSwapSummary) => {
      setActiveSwaps((prev) => [
        summary,
        ...prev.filter((p) => p.swapId !== summary.swapId),
      ]);
      void writeRow(summary);
      setTrackedSwap(summary);
      setTrackerOpen(true);
    },
    [writeRow]
  );

  const closeTracker = useCallback(() => setTrackerOpen(false), []);

  return {
    activeSwaps,
    trackedSwap,
    trackerOpen,
    adopt,
    openTracker,
    closeTracker,
    refresh,
  };
}
