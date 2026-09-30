/**
 * Everything the wallet knows about one swap, opened from any list that shows
 * swaps: RECENT SWAPS in the landscape Swap tab, the HISTORY list in the
 * portrait one, and the SWAPS filter in both Activity layouts. ONE component,
 * mounted by all four (landscape-first rule; `landscapeRouterParity.test.ts`
 * pins the mounts).
 *
 * # Why (the operator's report, 2026-09-30)
 *
 *   "Can you make it so I can click on the recent swaps and have the swap
 *    screen re-appear, so I can read what is happening?"
 *   "I want to be able to click on current and past swaps and see the data
 *    on them."
 *
 * Their LTC -> USDC-POL swap sat in history as "pending" with nothing else to
 * read, while 1Click said PENDING_DEPOSIT and the deposit already had a
 * confirmation on the Litecoin chain. Every fact needed to tell them what was
 * going on was stored (the hash, the deposit address, the deadline); no screen
 * showed it once the confirm modal was gone.
 *
 * # What it does while open
 *
 * For a NEAR Intents row (one with a deposit address) it asks 1Click now and
 * every `DETAILS_POLL_MS` until the swap is terminal, and writes what that
 * changes back to the history row (`watchIntentsSwap`), so the lists update
 * too. It stops when the modal closes. Other rows show what they have, with a
 * note that live status is not available for their route.
 *
 * The backdrop closes it only on a real click on the backdrop itself (see
 * `Backdrop` in `modal-parts.tsx`): moving the window does not.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Backdrop, Stat } from "./modal-parts";
import { Btn } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import { TxHashField } from "./TxHashField";
import { useTxParties, type TxPartiesState } from "../../lib/txParties";
import { useUtxoAccountSummaries } from "../../lib/utxoAccountRegistry";
import type { ChainType } from "../../wallets";
import {
  loadSwapHistory,
  onSwapHistoryChange,
  type SwapHistoryEntry,
} from "./swap-history-store";
import { formatActualReceived } from "./swap-actual-received";
import {
  DETAILS_POLL_MS,
  depositMemoOf,
  destinationExplorerUrl,
  formatSwapTime,
  isLiveTrackable,
  minReceivedOf,
  swapAddressExplorerUrl,
  swapLegChain,
  swapNetworkName,
  swapRouteOf,
  swapStatusView,
  watchIntentsSwap,
  type IntentsLiveDetails,
  type SwapStatusTone,
} from "./swap-details";

/** Background of a swap row under the pointer. */
const SWAP_ROW_HOVER_BG = "rgba(255,255,255,0.05)";

/**
 * Style every clickable swap row adds to its own. The focus ring is drawn
 * inside the row (`outline-offset: -2px`): the lists scroll, and a ring
 * outside the row is clipped by them.
 */
export const SWAP_ROW_OPEN_STYLE: CSSProperties = {
  cursor: "pointer",
  outlineOffset: -2,
  transition: "background .12s ease",
};

/**
 * The props that make a swap-history row open its details: a click, or Enter
 * or Space while it has focus; announced as a button; lit on hover. One helper
 * for the four lists, so they cannot drift apart. `baseBackground` is what the
 * row returns to when the pointer leaves.
 *
 * A control inside the row (a hash that opens the explorer) must stop its own
 * click from reaching the row.
 */
export function swapRowOpenProps(open: () => void, baseBackground = "transparent") {
  return {
    role: "button" as const,
    tabIndex: 0,
    title: "Show this swap's details",
    onClick: () => open(),
    onKeyDown: (e: {
      key: string;
      target: unknown;
      currentTarget: unknown;
      preventDefault: () => void;
    }) => {
      // Keys typed into something inside the row are not for the row.
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); // Space would otherwise scroll the list
        open();
      }
    },
    onMouseEnter: (e: { currentTarget: { style: { background: string } } }) => {
      e.currentTarget.style.background = SWAP_ROW_HOVER_BG;
    },
    onMouseLeave: (e: { currentTarget: { style: { background: string } } }) => {
      e.currentTarget.style.background = baseBackground;
    },
  };
}

const TONE_COLOR: Record<SwapStatusTone, string> = {
  ok: "var(--accent)",
  warn: "var(--warn)",
  bad: "var(--danger)",
};

const SMALL_CAPS: CSSProperties = {
  fontSize: 9,
  color: "var(--text-dim)",
  letterSpacing: 1,
  textTransform: "uppercase",
};

interface LiveState {
  details: IntentsLiveDetails;
  checkedAt: number;
}

export function SwapDetailsModal({
  entry,
  onClose,
  onHistoryChanged,
}: {
  /** The row to show; null renders nothing (closed). */
  entry: SwapHistoryEntry | null;
  onClose: () => void;
  /** Called after any committed write to swap history while this is open
   *  (this modal's own, or another poller's), so a host whose list does not
   *  follow the store itself can re-read it. */
  onHistoryChanged?: () => void;
}) {
  const [row, setRow] = useState<SwapHistoryEntry | null>(entry);
  const [live, setLive] = useState<LiveState | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const id = entry?.id ?? null;
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const changedRef = useRef(onHistoryChanged);
  changedRef.current = onHistoryChanged;

  // The host re-read its list: take its copy.
  useEffect(() => {
    setRow(entry);
  }, [entry]);

  // Another swap (or none): forget what 1Click said about the last one.
  useEffect(() => {
    setLive(null);
    setLiveError(null);
  }, [id]);

  // Ask 1Click while open, write back what changes, stop on close.
  useEffect(() => {
    const start = entryRef.current;
    if (!start || !isLiveTrackable(start)) return;
    return watchIntentsSwap({
      row: start,
      toExplorer: (hash) => destinationExplorerUrl(start.toAsset, hash),
      onLive: (details, checkedAt) => {
        setLive({ details, checkedAt });
        setLiveError(null);
      },
      onError: (message) => setLiveError(message),
      onPatched: (patch) =>
        setRow((r) => (r && r.id === start.id ? { ...r, ...patch } : r)),
    });
  }, [id]);

  // Any writer's commit: re-read this row, and tell the host.
  useEffect(() => {
    if (!id) return;
    let open = true;
    const off = onSwapHistoryChange(() => {
      changedRef.current?.();
      void loadSwapHistory()
        .then((rows) => {
          const found = rows.find((r) => r.id === id);
          if (open && found) setRow(found);
        })
        .catch(() => {
          /* keep what is on screen */
        });
    });
    return () => {
      open = false;
      off();
    };
  }, [id]);

  // `row` lags `entry` by one render when the host switches swaps.
  const current = row && entry && row.id === entry.id ? row : entry;

  // Addresses (2026-09-30, operator request: "which address each
  // transaction was sent and received from"). The payout and refund
  // addresses are on rows written since then; older NEAR Intents rows get
  // them from 1Click's echo of the request. Each leg's actual sender and
  // recipient are read from its chain by hash, once, while this is open.
  // Hooks: before the early return below.
  const echo = live?.details ?? null;
  const fromChain = current ? swapLegChain(current.fromAsset) : null;
  const toChain = current ? swapLegChain(current.toAsset) : null;
  const refundTo = current?.refundTo ?? echo?.refundTo ?? null;
  const recipient = current?.recipient ?? echo?.recipient ?? null;
  const sourceParties = useTxParties(
    fromChain,
    current?.sourceTxHash || null,
    refundTo ?? undefined,
    !!current?.sourceTxHash,
  );
  const payoutHash =
    current?.status === "refunded"
      ? null
      : current?.destTxHash ?? echo?.destinationTxHashes[0] ?? null;
  const payoutParties = useTxParties(toChain, payoutHash, recipient ?? undefined, !!payoutHash);
  const utxoSummaries = useUtxoAccountSummaries();

  const shown = current;
  if (!shown) return null;

  /** This wallet's addresses on a leg's chain: the quote's own address
   *  there, and every address a UTXO account scan found. */
  const ownOn = (chain: ChainType | null, known: string | null) => {
    const list = [
      ...(known ? [known] : []),
      ...(chain ? (utxoSummaries[chain]?.entries ?? []).map((e) => e.address) : []),
    ];
    return (a: string) => list.some((o) => sameAddress(a, o));
  };

  const route = swapRouteOf(shown);
  const trackable = isLiveTrackable(shown);
  const details = live?.details ?? null;
  const view = swapStatusView(shown, details?.status ?? null);
  const toneColor = TONE_COLOR[view.tone];
  const settled = view.key === "completed";
  const finished = settled || view.key === "refunded" || view.key === "failed";

  const actual = formatActualReceived(shown.actualReceived, shown.toAsset);
  const minReceived =
    minReceivedOf(shown) ??
    formatActualReceived(details?.minAmountOutAtomic ?? undefined, shown.toAsset);
  const memo = depositMemoOf(shown);
  const created = formatSwapTime(shown.createdAt);
  const completed = formatSwapTime(shown.completedAt);
  const deadline = formatSwapTime(shown.depositDeadline);
  // Worth saying only while the swap can still be decided by it.
  const deadlinePassed =
    !finished && !!shown.depositDeadline && Date.parse(shown.depositDeadline) < Date.now();

  // The source hash is the wallet's own record. When the wallet has none (an
  // unknown outcome with no hash), 1Click's registered deposit is shown for
  // reading, without a link: which chain's explorer it belongs to is not
  // recorded on the row.
  const reportedDeposit =
    !shown.sourceTxHash && details?.originTxHashes[0] ? details.originTxHashes[0] : null;
  const destHash =
    shown.destTxHash ??
    (view.key !== "refunded" ? details?.destinationTxHashes[0] ?? null : null);
  const destUrl = destHash
    ? shown.destTxHash && shown.destExplorerUrl
      ? shown.destExplorerUrl
      : destinationExplorerUrl(shown.toAsset, destHash)
    : null;

  return (
    <Backdrop onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Swap details"
        data-swap-details={shown.id}
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "90vh",
          overflow: "auto",
          background: "var(--bg-2)",
          border: "1px solid var(--border-hi)",
          padding: 22,
          fontFamily: "var(--font-mono)",
          color: "var(--text)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: "var(--accent)",
            }}
          >
            swap details
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>

        {/* From → to. The received side shows the delivered amount once it
            is known, the quote until then. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            marginBottom: 10,
          }}
        >
          <CoinIcon sym={shown.fromAsset} size={26} glow={false} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={SMALL_CAPS}>you sent</div>
            <div className="tnum" style={{ fontSize: 16, marginTop: 2, overflowWrap: "anywhere" }}>
              {shown.fromAmount} <span style={{ color: "var(--text-dim)" }}>{shown.fromAsset}</span>
            </div>
          </div>
          <span style={{ color: "var(--text-dim)", fontSize: 14 }}>→</span>
          <CoinIcon sym={shown.toAsset} size={26} glow={false} />
          <div style={{ flex: 1, minWidth: 0, textAlign: "right" }}>
            <div style={SMALL_CAPS}>
              {settled && actual ? "you received" : finished ? "quoted" : "you receive"}
            </div>
            <div
              className="tnum"
              style={{ fontSize: 16, marginTop: 2, color: "var(--accent)", overflowWrap: "anywhere" }}
            >
              {settled && actual ? actual : `~${shown.toAmount}`}{" "}
              <span style={{ color: "var(--text-dim)" }}>{shown.toAsset}</span>
            </div>
          </div>
        </div>

        {/* Status, in plain words, then what NEAR Intents said and when. */}
        <div
          data-swap-status={view.key}
          style={{
            padding: "10px 12px",
            background: "var(--surface)",
            border: `1px solid ${toneColor}`,
            marginBottom: 10,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: toneColor,
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            {view.label}
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.5, marginTop: 6, color: "var(--text)" }}>
            {view.detail}
          </div>
          {trackable ? (
            <div
              data-live-status
              style={{ fontSize: 10, marginTop: 8, color: "var(--text-dim)", lineHeight: 1.5 }}
            >
              {details?.status ? (
                <>
                  NEAR Intents: <span style={{ color: "var(--text)" }}>{details.status}</span>
                  {" · checked "}
                  {new Date(live!.checkedAt).toLocaleTimeString()}
                  {finished
                    ? ""
                    : ` · refreshes every ${Math.round(DETAILS_POLL_MS / 1000)} s while this is open`}
                </>
              ) : (
                !liveError && "Asking NEAR Intents…"
              )}
              {liveError && (
                <div style={{ color: "var(--warn)", marginTop: details?.status ? 4 : 0, overflowWrap: "anywhere" }}>
                  NEAR Intents did not answer; trying again every {Math.round(DETAILS_POLL_MS / 1000)} s. ({liveError})
                </div>
              )}
            </div>
          ) : (
            <div
              data-live-status="unavailable"
              style={{ fontSize: 10, marginTop: 8, color: "var(--text-dim)" }}
            >
              Live status not available for this route.
            </div>
          )}
        </div>

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 5,
            fontSize: 11,
          }}
        >
          <Stat k="quoted" v={`~${shown.toAmount} ${shown.toAsset}`} />
          {minReceived && <Stat k="min received" v={`${minReceived} ${shown.toAsset}`} />}
          {actual && <Stat k="received" v={`${actual} ${shown.toAsset}`} />}
          {!actual && details?.amountOutFormatted && view.key === "completed" && (
            <Stat k="received (NEAR Intents)" v={`${details.amountOutFormatted} ${shown.toAsset}`} />
          )}
          {view.key === "refunded" && details?.refundedAmountFormatted && (
            <Stat k="refunded" v={`${details.refundedAmountFormatted} ${shown.fromAsset}`} />
          )}
          {shown.provider && <Stat k="provider" v={shown.provider} />}
          {created && <Stat k="created" v={created} />}
          {completed && <Stat k="completed" v={completed} />}
          {deadline && (
            <Stat k="deposit deadline" v={deadlinePassed ? `${deadline} (passed)` : deadline} />
          )}
        </div>

        {view.key === "refunded" && route === "intents" && (
          <div
            data-refund
            style={{
              marginTop: 10,
              padding: "8px 10px",
              background: "rgba(255,170,0,0.08)",
              border: "1px solid rgba(255,170,0,0.4)",
              color: "var(--warn)",
              fontSize: 10,
              lineHeight: 1.5,
            }}
          >
            Refunded to your {shown.fromAsset} address, the quote's refund address.
            {details?.refundedAmountFormatted
              ? ` NEAR Intents reports ${details.refundedAmountFormatted} ${shown.fromAsset} refunded.`
              : ""}{" "}
            It arrives as an ordinary incoming {shown.fromAsset} transaction in Activity.
          </div>
        )}

        {shown.depositAddress && (
          <TxHashField
            label="deposit address"
            value={shown.depositAddress}
            hint={`The one-time ${shown.fromAsset} address this swap's quote gave. NEAR Intents finds the swap by it.`}
          />
        )}
        {memo && (
          <TxHashField
            label="deposit memo"
            value={memo}
            hint="Sent with the deposit; the deposit is credited by it."
          />
        )}

        {shown.sourceTxHash ? (
          <>
            <TxHashField
              label="source tx"
              value={shown.sourceTxHash}
              explorerUrl={shown.sourceExplorerUrl}
            />
            <LegParties
              state={sourceParties}
              network={swapNetworkName(shown.fromAsset)}
              isOwn={ownOn(fromChain, refundTo)}
              depositAddress={shown.depositAddress ?? null}
            />
          </>
        ) : reportedDeposit ? (
          <TxHashField
            label="deposit tx (reported by NEAR Intents)"
            value={reportedDeposit}
            hint="The wallet did not get a hash back for this deposit; this is the one NEAR Intents registered."
          />
        ) : (
          <EmptyHash
            label="source tx"
            text={
              shown.outcomeUnknown
                ? `No transaction id came back. Check this wallet's recent ${shown.fromAsset} activity before swapping again.`
                : "None recorded."
            }
          />
        )}

        {destHash ? (
          <>
            <TxHashField label="destination tx" value={destHash} explorerUrl={destUrl} />
            <LegParties
              state={payoutParties}
              network={swapNetworkName(shown.toAsset)}
              isOwn={ownOn(toChain, recipient)}
              depositAddress={null}
            />
          </>
        ) : (
          <EmptyHash
            label="destination tx"
            text={
              view.key === "refunded"
                ? "None: the swap was refunded, so nothing was paid out."
                : finished
                  ? "None recorded."
                  : "Appears here once the swap pays out."
            }
          />
        )}

        {recipient && (
          <TxHashField
            label={`payout address · yours on ${swapNetworkName(shown.toAsset)}`}
            value={recipient}
            explorerUrl={swapAddressExplorerUrl(shown.toAsset, recipient)}
            hint={`Where this swap pays out the ${shown.toAsset}.`}
          />
        )}
        {refundTo && (
          <TxHashField
            label={`refund address · yours on ${swapNetworkName(shown.fromAsset)}`}
            value={refundTo}
            explorerUrl={swapAddressExplorerUrl(shown.fromAsset, refundTo)}
            hint={`Where the ${shown.fromAsset} goes back if the swap cannot complete.`}
          />
        )}

        <div style={{ marginTop: 16 }}>
          <Btn variant="ghost" full onClick={onClose}>
            Close
          </Btn>
        </div>
      </div>
    </Backdrop>
  );
}

function sameAddress(a: string, b: string): boolean {
  // Hex addresses (EVM) compare case-insensitively; everything else exactly.
  return /^0x[0-9a-f]+$/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Who sent one leg and who received it, as its chain says, under that
 * leg's hash (2026-09-30). The wallet's own addresses are marked; on the
 * deposit leg, the deposit address is named, and the wallet's own output
 * beside it is change.
 */
function LegParties({
  state,
  network,
  isOwn,
  depositAddress,
}: {
  state: TxPartiesState;
  network: string;
  isOwn: (a: string) => boolean;
  depositAddress: string | null;
}) {
  if (state.status === "idle") return null;
  const box: CSSProperties = {
    padding: "6px 12px 8px",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderTop: "none",
    fontSize: 10,
    lineHeight: 1.5,
  };
  if (state.status !== "done" || !state.parties) {
    const text =
      state.status === "loading"
        ? `Reading who sent it and who received it from ${network}…`
        : state.status === "error"
          ? `Could not read who sent it and who received it: ${state.message}`
          : `${network} does not show this transaction yet.`;
    return (
      <div data-leg-parties style={{ ...box, color: "var(--text-dim)" }}>
        {text}
      </div>
    );
  }
  const p = state.parties;
  const paidOthers = p.to.some((a) => !isOwn(a));
  const tag = (a: string, side: "from" | "to"): string | null => {
    if (depositAddress && sameAddress(a, depositAddress)) return "NEAR Intents deposit";
    if (!isOwn(a)) return null;
    return side === "to" && paidOthers && depositAddress ? "you (change)" : "you";
  };
  const line = (side: "from" | "to", list: string[], empty: string) => (
    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
      <span style={{ ...SMALL_CAPS, width: 34, flexShrink: 0, paddingTop: 1 }}>{side}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        {list.length === 0 ? (
          <span style={{ color: "var(--text-dim)" }}>{empty}</span>
        ) : (
          list.map((a) => {
            const t = tag(a, side);
            return (
              <span key={a} className="tnum" style={{ wordBreak: "break-all", color: "var(--text)" }}>
                {a}
                {t ? <span style={{ color: "var(--accent)", marginLeft: 6 }}>{`· ${t}`}</span> : null}
              </span>
            );
          })
        )}
      </span>
    </div>
  );
  return (
    <div data-leg-parties style={box}>
      {line("from", p.from, p.senderHidden ? `Hidden: ${network} does not reveal senders.` : "Not given.")}
      {line("to", p.to, "Not given.")}
    </div>
  );
}

function EmptyHash({ label, text }: { label: string; text: string }) {
  return (
    <div
      style={{
        padding: "8px 12px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        marginTop: 6,
        fontSize: 11,
      }}
    >
      <div style={SMALL_CAPS}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-dim)", lineHeight: 1.5 }}>
        {text}
      </div>
    </div>
  );
}
