/**
 * Settings mount for `DexCoinCard` (contract C3 / wave 4, UI side).
 *
 * The card was exported from `features/swap-sidecar/index.ts` and mounted
 * **nowhere** — grep for `DexCoinCard` outside its own folder returned zero
 * hits — so per-coin DEX enablement, the whole point of C3, had no reachable
 * entry point. This is its host, landscape first (`SettingsLandscapeView`),
 * portrait inheriting the identical block (`SettingsView`).
 *
 * Split in two on purpose:
 *
 *  - {@link DexCoinsPanel} is **pure**: props in, elements out, no hooks. That
 *    is what lets a test call it directly and walk the returned element tree
 *    without a DOM — there is no jsdom in this project's vitest config, so a
 *    hook-owning component would be untestable and the P1 gate would be an
 *    unverified claim.
 *  - {@link DexCoinsSection} owns `useSwapSidecarOptIn` + `useCoinStatuses` and
 *    renders the panel.
 *
 * **P1 — a user who does not swap sees no change at all.** When the opt-in flag
 * is not `true` this renders `null`: no heading, no empty card, no invoke. That
 * is a stronger statement than "the card says you have not opted in", and it is
 * the reason the gate lives at the mount rather than inside the card.
 */
import { useEffect, useRef, useState } from "react";
import { Btn } from "../../design/primitives";
import { onDexCoinsFocus } from "../swap-sidecar/dexCoinsFocus";
import {
  DexCoinCard,
  useChainSync,
  useCoinStatuses,
  useSidecarBalances,
  useSwapSidecarOptIn,
} from "../swap-sidecar";
import type { CoinEnableStatus, CoinMode } from "../../api/basicswap";
import {
  DEX_COINS_COST_NOTE,
  DEX_COINS_COUNTERPARTY_NOTE,
  DEX_COINS_LIGHT_PRIVACY_NOTE,
  DEX_COINS_SHARED_WALLET_NOTE,
  DEX_COINS_ZERO_MOVE_NOTE,
  dexCoinsSectionVisible,
  dexCoinsSummary,
  lightPrivacyNoteApplies,
  sharedWalletNoteApplies,
  zeroMoveNoteApplies,
} from "./dexCoinsCopy";

const mono = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  lineHeight: 1.6,
} as const;

function Note({ children }: { children: string }) {
  return (
    <div
      style={{
        ...mono,
        color: "var(--text-dim)",
        borderLeft: "2px solid var(--border-soft)",
        paddingLeft: 8,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Pure presentational half — no hooks, safe to call from a test.
 *
 * @param visible result of {@link dexCoinsSectionVisible}; `false` renders
 *        nothing at all (P1)
 * @param statuses from `useCoinStatuses`
 * @param onToggle called with the coin's engine name and the WANTED state
 * @param onSetMode called with the coin's engine name and the WANTED mode
 * @param onRefresh re-reads `swap_sidecar_coin_status`
 * @param syncRows chain progress per ticker, from `useSidecarBalances`
 */
export function DexCoinsPanel({
  visible,
  statuses,
  syncRows = {},
  chainByTicker = {},
  loading,
  error,
  busyCoin,
  onToggle,
  onSetMode,
  onSetShareWallet,
  onRefresh,
  expanded = false,
  onToggleExpanded,
}: {
  visible: boolean;
  /**
   * Collapsed by default (2026-08-22). The section is seven coins × four
   * lines plus five notes — the single largest block of text on Settings,
   * and the one a user touches least once the node is configured. The
   * summary line ("6 of 7 enabled") stays visible; everything else is one
   * click away. Hook-free on purpose: tests call this component as a plain
   * function, so the state lives in `DexCoinsSection`.
   */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  statuses: CoinEnableStatus[];
  loading: boolean;
  error: string | null;
  busyCoin: string | null;
  onToggle: (coin: string, enabled: boolean) => void;
  onSetMode: (coin: string, mode: CoinMode) => void;
  /** C8 — record consent for a lean coin to use the wallet's own keys. */
  onSetShareWallet?: (coin: string, share: boolean) => void;
  onRefresh: () => void;
  syncRows?: Record<string, import("../swap-sidecar").SidecarBalanceRow>;
  chainByTicker?: Record<string, import("../../api/basicswap").ChainSync>;
}) {
  if (!visible) return null;

  const summary = dexCoinsSummary(statuses);

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 6,
        }}
      >
        {/* Deliberately NOT titled "DEX coins": `DexCoinCard` carries that as
            its own <Card> label a few pixels below, and the Playwright pass
            showed the two stacked as a duplicated heading. This row is the
            count plus the refresh control; the card owns the name. */}
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          style={{
            ...mono,
            fontSize: 9.5,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "var(--text-muted)",
            background: "none",
            border: "none",
            padding: 0,
            cursor: onToggleExpanded ? "pointer" : "default",
          }}
        >
          {expanded ? "▾ " : "▸ "}
          DEX coins{summary ? ` · ${summary}` : ""}
        </button>
        {expanded && (
          <Btn variant="ghost" size="sm" disabled={loading} onClick={onRefresh}>
            {loading ? "…" : "Refresh"}
          </Btn>
        )}
      </div>

      {!expanded ? null : (
      <>

      {/* The honest cost, above the toggles rather than under them. */}
      <Note>{DEX_COINS_COST_NOTE}</Note>
      {zeroMoveNoteApplies(statuses) && <Note>{DEX_COINS_ZERO_MOVE_NOTE}</Note>}
      {/* C8. The shared-wallet note is gated on the VERIFIED state, the
          privacy note on mere capability — the first is a claim about the
          user's funds, the second is input to a choice they have not made
          yet. Both above the toggles, for the same reason the cost note is. */}
      {sharedWalletNoteApplies(statuses) && (
        <Note>{DEX_COINS_SHARED_WALLET_NOTE}</Note>
      )}
      {lightPrivacyNoteApplies(statuses) && (
        <Note>{DEX_COINS_LIGHT_PRIVACY_NOTE}</Note>
      )}
      <Note>{DEX_COINS_COUNTERPARTY_NOTE}</Note>

      <DexCoinCard
        statuses={statuses}
        onToggle={onToggle}
        onSetMode={onSetMode}
        onSetShareWallet={onSetShareWallet}
        syncRows={syncRows}
        chainByTicker={chainByTicker}
        busyCoin={busyCoin}
      />

      {error && (
        <div
          style={{
            ...mono,
            color: "var(--danger)",
            wordBreak: "break-word",
            marginTop: 6,
          }}
        >
          {error}
        </div>
      )}
      </>
      )}
    </div>
  );
}

/**
 * Hook-owning wrapper. Mounted by both Settings surfaces.
 *
 * `useCoinStatuses({ enabled })` issues no invoke while `enabled` is false, so
 * the opt-in tri-state is passed through unchanged rather than defaulted.
 */
export function DexCoinsSection() {
  const { optedIn } = useSwapSidecarOptIn();
  const visible = dexCoinsSectionVisible(optedIn);
  const {
    statuses,
    loading,
    error,
    busyCoin,
    refresh,
    setCoin,
    setCoinMode,
    setShareWallet,
  } = useCoinStatuses({ enabled: visible });
  // Chain progress for the rows. Same poll the Swap tab already runs; the
  // hook is a no-op while `enabled` is false, so a user who does not swap
  // still issues nothing.
  const sidecarBalances = useSidecarBalances({ enabled: visible });
  // Sync progress from the daemons directly — reliable during IBD, unlike the
  // balance endpoint. This is what makes the progress bar actually appear.
  const chainSync = useChainSync({ enabled: visible });
  // `useCoinStatuses.setCoin` REJECTS on a backend refusal and sets no error
  // of its own — only `load()` writes the hook's `error`. Swallowing that
  // rejection would make a refused enable look like a click that did nothing,
  // which is the failure mode this section is least able to afford: the user
  // would conclude the coin is on. Caught and surfaced here instead.
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  /**
   * Open and scroll here when the swap-node card's coin tiles are clicked.
   *
   * Those tiles are read-only by design (one writer for the apply cycle -- see
   * `DexCoinTiles`), but they look exactly like toggles and sit where a user
   * reaches to turn a coin on. Reported 2026-09-04: clicking them did nothing
   * and the only pointer to this section was an 8px caption. Now the click
   * lands here, expanded, in view.
   *
   * Subscribed rather than prop-driven so it works identically in the portrait
   * and landscape Settings surfaces without threading a callback through both
   * -- wiring a feature into one surface and not the other is a drift this
   * repo has paid for repeatedly.
   */
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(
    () =>
      onDexCoinsFocus(() => {
        setExpanded(true);
        // After the expand paints, so the scroll targets the real height.
        requestAnimationFrame(() => {
          hostRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }),
    [],
  );

  return (
    <div ref={hostRef}>
    <DexCoinsPanel
      visible={visible}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((v) => !v)}
      statuses={statuses}
      loading={loading}
      error={toggleError ?? error}
      busyCoin={busyCoin}
      syncRows={sidecarBalances.rows}
      chainByTicker={chainSync.byTicker}
      onRefresh={() => {
        sidecarBalances.refresh();
        chainSync.refresh();
        setToggleError(null);
        refresh();
      }}
      onToggle={(coin, enabled) => {
        setToggleError(null);
        void setCoin(coin, enabled).catch((e: unknown) => {
          setToggleError(
            typeof e === "string" ? e : String((e as Error)?.message ?? e),
          );
        });
      }}
      // Same rejection handling as onToggle, and for a sharper reason: R20's
      // refusal ("switch it off, restart, switch it back on") IS the answer the
      // user needs. Swallowing it leaves a Light button that visibly does
      // nothing, with the remedy sitting unread in a rejected promise.
      onSetMode={(coin, mode) => {
        setToggleError(null);
        void setCoinMode(coin, mode).catch((e: unknown) => {
          setToggleError(
            typeof e === "string" ? e : String((e as Error)?.message ?? e),
          );
        });
      }}
      // C8. Same rejection handling: the backend refuses a coin with no light
      // mode, and that refusal is what explains a control doing nothing.
      onSetShareWallet={(coin, share) => {
        setToggleError(null);
        void setShareWallet(coin, share).catch((e: unknown) => {
          setToggleError(
            typeof e === "string" ? e : String((e as Error)?.message ?? e),
          );
        });
      }}
    />
    </div>
  );
}
