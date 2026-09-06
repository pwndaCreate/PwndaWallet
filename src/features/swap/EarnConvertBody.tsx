/**
 * src/features/swap/EarnConvertBody.tsx
 *
 * The convert pipeline's UI, rendered once and mounted twice: the landscape
 * EARN rail tab (canvas frame 1d) and the portrait CONVERT segment inside the
 * Swap tab (frame 1e).
 *
 * `variant` picks the arrangement — landscape gets the three-column route and
 * a side-by-side receive/convert row; portrait stacks everything and draws the
 * route vertically. The DATA and the HANDLERS are identical, which is the
 * point: the handoff asks for two renderings of one pipeline.
 *
 * # One honesty deviation from the mock, stated plainly
 *
 * The canvas labels the source node `MINED`. The wallet cannot attribute a
 * Monero balance to mining — XMR received from any source lands in the same
 * wallet, and the sidecar reports one number. Labelling a received balance
 * "mined" would be the sort of confident-but-unfounded claim this codebase
 * treats as a defect, so the node says `available` and the mining state is
 * carried honestly by the header chip (which IS live, from `useMiner`).
 * Everything else follows the frames.
 */
import { useMemo, useState } from "react";
import type { ConvertPipelineState } from "./useConvertPipeline";
import {
  CONVERT_ROUTE_HOP,
  CONVERT_SOURCE,
  CONVERT_QUICK_TARGETS,
  projectConversion,
} from "./useConvertPipeline";
import {
  RouteDiagram,
  ReceivePicker,
  ConversionsList,
  EarnPanel,
  MiningStatusChip,
  type ConversionRow,
  type RouteNode,
  type RouteLeg,
} from "./components/earn-ui";
import { PixelCta, Chip, ChipRow, FootNote, Eyebrow } from "./components/swap-ui";
import { fmtBal, getDropdownTickers } from "./swap-data";
import {
  loadConversions,
  conversionAge,
} from "./convert-history";
import { MarketPreview, useSwapSidecarOptIn } from "../swap-sidecar";

export interface EarnConvertBodyProps {
  variant: "landscape" | "portrait";
  pipeline: ConvertPipelineState;
  /** XMR balance available to convert. Null when not loaded. */
  sourceBalance: number | null;
  pricesByTicker: Record<string, number>;
  /** Live mining state for the header chip. */
  mining: { active: boolean; hardware?: string | null; hashrate?: string | null };
  /** Past conversions, newest first. */
  conversions: readonly ConversionRow[];
  /** Opens the full destination list; omit to hide the "+N more" tile. */
  onMoreTargets?: () => void;
  /** How many more assets that list holds. */
  moreTargetCount?: number;
}

export function EarnConvertBody({
  variant,
  pipeline,
  sourceBalance,
  pricesByTicker,
  mining,
  conversions,
  onMoreTargets,
  moreTargetCount,
}: EarnConvertBodyProps) {
  const landscape = variant === "landscape";

  /**
   * Read here rather than threaded from App: it feeds ONE sentence in the
   * market preview (what opting in would additionally get you), and a prop
   * for that would have to cross two roots and both variants. `null` while
   * the store read is in flight is treated as not-opted-in, which is the
   * safe direction — it offers information rather than assuming access.
   */
  const { optedIn: sidecarOptedIn } = useSwapSidecarOptIn();

  /**
   * "+N more" expands the picker in place rather than opening anything.
   *
   * The mock draws a `+24 MORE ▾` tile; the handoff says it "opens the full
   * NEAR asset list". Expanding inline is that, with one fewer surface to
   * build and no navigation away from a half-configured conversion. The list
   * is `getDropdownTickers` — the registry-derived roster the swap form's own
   * picker uses — so this cannot offer a destination the route gate then
   * refuses (which is exactly what a hand-kept copy did on 2026-08-25).
   */
  const [expanded, setExpanded] = useState(false);

  /**
   * Conversion history.
   *
   * Read here rather than threaded from App: it is a local log with no
   * cross-surface state, and re-reading on each pipeline stage change is
   * cheaper than another prop through two roots. `stage` is the dependency
   * because every write to the log happens on a stage transition.
   */
  const historyRows: ConversionRow[] = useMemo(
    () =>
      loadConversions().map((r) => ({
        id: r.id,
        fromTicker: r.fromTicker,
        toTicker: r.toTicker,
        fromAmount: r.fromAmount,
        toAmount: r.toAmount || r.viaAmount || "—",
        age: conversionAge(r.startedAt),
        status: r.status,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pipeline.stage, pipeline.hop1Unwound],
  );
  const rows = conversions.length > 0 ? conversions : historyRows;

  const allTargets = useMemo(
    () => getDropdownTickers({ router: "intents" }).filter((t) => t !== CONVERT_SOURCE),
    [],
  );
  const shownTargets = expanded
    ? allTargets
    : (CONVERT_QUICK_TARGETS as readonly string[]);
  const hiddenCount = Math.max(0, allTargets.length - CONVERT_QUICK_TARGETS.length);

  const { targetCoin, stage, hop1, hop2InputAmount, hop1Unwound } = pipeline;

  /** LTC as a destination means one hop, not two. */
  const singleHop = targetCoin.toUpperCase() === CONVERT_ROUTE_HOP;

  const projection = useMemo(
    () =>
      projectConversion({
        sourceAmount: sourceBalance ?? 0,
        sourcePriceUsd: pricesByTicker[CONVERT_SOURCE] ?? null,
        targetPriceUsd: pricesByTicker[targetCoin.toUpperCase()] ?? null,
        singleHop,
      }),
    [sourceBalance, pricesByTicker, targetCoin, singleHop],
  );

  const sourceUsd =
    sourceBalance != null && pricesByTicker[CONVERT_SOURCE] != null
      ? sourceBalance * pricesByTicker[CONVERT_SOURCE]
      : null;

  /* ── Route ─────────────────────────────────────────────────── */

  const nodes: RouteNode[] = useMemo(() => {
    const source: RouteNode = {
      ticker: CONVERT_SOURCE,
      // See the header note: "available", not "mined".
      role: "available",
      value: sourceBalance != null ? fmtBal(sourceBalance) : "—",
      emphasis: true,
      badge: mining.active ? "⛏" : undefined,
    };
    const target: RouteNode = {
      ticker: targetCoin,
      role: "to your wallet",
      value:
        projection.targetAmount != null
          ? fmtBal(projection.targetAmount)
          : "—",
      emphasis: true,
    };
    if (singleHop) return [source, target];
    return [
      source,
      {
        ticker: CONVERT_ROUTE_HOP,
        role: "route hop",
        value: "pass-through",
      },
      target,
    ];
  }, [sourceBalance, targetCoin, projection.targetAmount, singleHop, mining.active]);

  const legs: RouteLeg[] = useMemo(() => {
    const p2p: RouteLeg = { label: "p2p · fee ~1%", timing: "30–90 min" };
    const near: RouteLeg = { label: "near · fee ~0.3%", timing: "~4 min" };
    return singleHop ? [p2p] : [p2p, near];
  }, [singleHop]);

  /* ── CTA state ─────────────────────────────────────────────── */

  /**
   * The estimate is shown to everyone; only the ACTION is gated.
   *
   * A user deciding whether to enable a background service, download a
   * runtime and sync a chain should be able to see what the conversion would
   * return first — that is the operator's stated reason for the estimator
   * being opt-in-agnostic. Hiding the number until they commit would make the
   * decision blind; disabling the button after showing it makes the trade
   * legible. So the label SAYS what is missing rather than going silently
   * grey, which is the difference between a gate and a dead control.
   */
  const needsOptIn = sidecarOptedIn !== true;

  const ctaLabel = (() => {
    if (stage === "hop1-running") return "SWAP IN PROGRESS…";
    if (stage === "hop2-ready") return "► CONVERT THE SECOND HOP";
    if (stage === "hop2-running") return "CONFIRM IN THE SWAP TAB";
    // Ordered before the balance check on purpose: without the node this
    // cannot run at any balance, so that is the more useful thing to say.
    // (`stage` is already narrowed past hop2-ready by the returns above.)
    if (needsOptIn) return "ENABLE THE SWAP NODE TO CONVERT";
    if (sourceBalance == null || sourceBalance <= 0)
      return `NO ${CONVERT_SOURCE} TO CONVERT`;
    return "► CONVERT NOW";
  })();

  const ctaDisabled =
    stage === "hop1-running" ||
    stage === "hop2-running" ||
    (needsOptIn && stage !== "hop2-ready") ||
    ((sourceBalance == null || sourceBalance <= 0) && stage !== "hop2-ready");

  const onCta = () => {
    if (stage === "hop2-ready") pipeline.beginHop2();
    else pipeline.beginHop1();
  };

  /* ── Pieces ────────────────────────────────────────────────── */

  const routePanel = (
    <EarnPanel label="route">
      <RouteDiagram
        nodes={nodes}
        legs={legs}
        direction={landscape ? "horizontal" : "vertical"}
      />
    </EarnPanel>
  );

  const receivePanel = (
    <EarnPanel label={landscape ? "receive" : "receive as"}>
      <ReceivePicker
        targets={shownTargets}
        selected={targetCoin}
        onSelect={pipeline.setTargetCoin}
        moreCount={expanded ? 0 : (moreTargetCount ?? hiddenCount)}
        onMore={
          onMoreTargets ??
          (hiddenCount > 0 && !expanded ? () => setExpanded(true) : undefined)
        }
        layout={landscape ? "grid" : "row"}
      />
    </EarnPanel>
  );

  const convertPanel = (
    <EarnPanel label="convert">
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <span
          style={{
            fontSize: landscape ? 22 : 18,
            color: "var(--white)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {sourceBalance != null ? fmtBal(sourceBalance) : "—"} {CONVERT_SOURCE}
        </span>
        <span style={{ color: "var(--text-dim)" }}>→</span>
        <span
          style={{
            fontSize: landscape ? 22 : 18,
            color: "var(--accent)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          ≈{" "}
          {projection.targetAmount != null
            ? fmtBal(projection.targetAmount)
            : "—"}{" "}
          {targetCoin}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          gap: 14,
          marginTop: 4,
          fontSize: 9,
          color: "var(--text-dim)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>{sourceUsd != null ? `$${sourceUsd.toFixed(2)}` : "—"}</span>
        <span>
          {projection.usdAfterFees != null
            ? `$${projection.usdAfterFees.toFixed(2)} after fees`
            : "— after fees"}
        </span>
      </div>

      {/* Hop-1 unwound: a refund is a normal outcome of this protocol, so it
          reports as information, not as an error. */}
      {hop1Unwound && (
        <div
          style={{
            marginTop: 10,
            fontSize: 9,
            color: "var(--text-muted)",
            lineHeight: 1.5,
          }}
        >
          The peer-to-peer hop unwound and your {CONVERT_SOURCE} came back.
          That is a normal outcome — nothing was lost. You can start again.
        </div>
      )}

      {stage === "hop2-ready" && hop2InputAmount && (
        <div
          style={{
            marginTop: 10,
            fontSize: 9,
            color: "var(--accent)",
            lineHeight: 1.5,
          }}
        >
          Hop 1 settled: {hop2InputAmount} {CONVERT_ROUTE_HOP} is in your
          wallet. The second hop is priced when you start it, and you confirm
          that rate.
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <PixelCta label={ctaLabel} disabled={ctaDisabled} onClick={onCta} />
        </div>
        <ChipRow style={{ justifyContent: "flex-start" }}>
          <Chip style={{ fontVariantNumeric: "tabular-nums" }}>
            {singleHop ? "~35 min" : "~45 min"}
          </Chip>
          <Chip>{singleHop ? "1 hop" : "2 hops"}</Chip>
          <Chip tone="accent">you confirm each rate</Chip>
        </ChipRow>
      </div>
    </EarnPanel>
  );

  const conversionsPanel = (
    <EarnPanel
      label="conversions"
      right={
        rows.length > 0 ? (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {rows.length} total
          </span>
        ) : undefined
      }
      bodyStyle={{ paddingTop: 4, paddingBottom: 4 }}
    >
      <ConversionsList rows={conversions} />
    </EarnPanel>
  );

  /* ── Arrangement ───────────────────────────────────────────── */

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        fontFamily: "var(--mono)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Eyebrow>
          earn · mine {CONVERT_SOURCE} receive {targetCoin}
        </Eyebrow>
        <MiningStatusChip
          active={mining.active}
          hardware={mining.hardware}
          hashrate={mining.hashrate}
        />
      </div>

      {/* The public P2P market, before any opt-in.

          EARN routes its first hop through the P2P DEX, so "is there a
          market on XMR right now" is a precondition of the whole pipeline —
          and until now this tab asked the user to set up a conversion
          without ever showing them the market it would run through. Same
          shared block the Swap tab mounts; `compact` in portrait. */}
      <MarketPreview enabled optedIn={sidecarOptedIn === true} compact={!landscape} />

      {routePanel}

      {landscape ? (
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: "0 0 320px", minWidth: 0 }}>{receivePanel}</div>
          <div style={{ flex: 1, minWidth: 0 }}>{convertPanel}</div>
        </div>
      ) : (
        <>
          {receivePanel}
          {convertPanel}
        </>
      )}

      <FootNote>
        two swaps run back to back · you confirm each rate before it fires
      </FootNote>

      {conversionsPanel}
    </div>
  );
}
