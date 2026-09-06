/**
 * src/features/mining/MineSimpleView.tsx
 *
 * The Mine tab's SIMPLE view (canvas frames 3a landscape, same blocks stacked
 * in portrait) — the default, with the console behind `PRO ▸`.
 *
 * # One component, both layouts
 *
 * `compact` switches the arrangement (three columns → one stack) and nothing
 * else: same blocks, same handlers, same data. Per the contributor guide's landscape-first
 * rule this is deliberately NOT two files — the Mine tab is the surface most
 * likely to be edited on one layout and forgotten on the other, since portrait
 * and landscape mining views have historically been separate implementations
 * (see [[surfaces-matrix]]: "Mining · Logic ✅ · P/L markup ❌").
 *
 * # What this view does not own
 *
 * The convert rate and the EARN navigation arrive as props. `features/mining`
 * cannot import `features/swap`, `features/swap-sidecar` or `src/state` —
 * PwndaLite ships this feature as a standalone product. Absent props are the
 * Lite case and degrade to: native XMR hero, no EARN promo.
 */
import { useMemo, useState } from "react";
import type { ChainType } from "../../wallets";
import type { MiningProjection } from "../../types/mining";
import type { useMiner } from "./useMiner";
import { MINING_COINS } from "./miningCoins";
import { coinTileLocked, pickMiningCoin } from "./pickCoin";
import { capabilityFor } from "./minedAssetCapability";
import { estimateEarningsForChain } from "./earnings";
import { algorithmHashUnit, formatHashrateParts } from "./pool-stats/format";
import { CoinIcon } from "../../components/CoinIcon";
import {
  BalanceHero,
  EarnPromoStrip,
  MicroLabel,
  Mark,
  Panel,
  ViewModeChip,
} from "./components/mine-simple";

type MinerApi = ReturnType<typeof useMiner>;

/** `02:14:08` from seconds; `—` when there is no session. */
function fmtUptime(secs: number | null): string {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return "—";
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs % 3600) / 60);
  const ss = Math.floor(secs % 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Targets shown before the "N MORE ▾" expander, per the mock. */
const TARGETS_COLLAPSED = 3;

function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", border: "1px solid var(--border)" }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            style={{
              fontFamily: "var(--font-mono)",
              border: "none",
              borderLeft: "1px solid var(--border)",
              background: active ? "var(--accent-soft)" : "transparent",
              color: active
                ? "var(--accent)"
                : disabled
                  ? "var(--text-dim)"
                  : "var(--text-muted)",
              padding: "3px 10px",
              fontSize: 8,
              letterSpacing: 1,
              textTransform: "uppercase",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}

export interface MineSimpleViewProps {
  miner: MinerApi;
  /** Portrait stacks; landscape uses the three-column arrangement. */
  compact?: boolean;
  /** Spot USD prices by ticker — used for the no-route daily-revenue line. */
  pricesByTicker?: Record<string, number>;
  /**
   * Assets the mined coin can actually be converted into, for the hero's
   * dropdown. Injected from the swap layer's capability registry — mining
   * cannot compute reachability itself and must not guess at it.
   */
  reachableTickers?: readonly string[];
  /**
   * The convert rate + chosen display coin. Supplied by the full app; absent
   * in PwndaLite, where the hero shows native XMR.
   */
  projection?: MiningProjection | null;
  onSelectDisplayCoin?: (ticker: string) => void;
  /** Mined XMR balance. `null` when the wallet has not reported one. */
  minedAmount?: number | null;
  /** Navigate to the EARN surface. Absent ⇒ the promo strip does not render. */
  onOpenEarn?: () => void;
  /** A conversion is already in flight, so the promo becomes a status line. */
  conversionRunning?: boolean;
  /** Re-fetch the order book and re-price the route. */
  onRetryRoute?: () => void;
  /** Switch to the PRO console. */
  onShowPro: () => void;
}

export function MineSimpleView({
  miner,
  compact = false,
  pricesByTicker,
  reachableTickers,
  projection,
  onSelectDisplayCoin,
  minedAmount = null,
  onOpenEarn,
  conversionRunning = false,
  onRetryRoute,
  onShowPro,
}: MineSimpleViewProps) {
  const {
    miningCoin,
    setMiningCoin,
    miningHardware,
    switchHardware,
    isMining,
    miningStarting,
    miningIntensity,
    setMiningIntensity,
    minersReady,
    hashrateSamples,
    startMining,
    stopMining,
    selectedPool,
    selectedPoolId,
    poolPings,
    session,
    displayMinPayout,
    cpuAlgorithm,
    gpuAlgorithm,
    gpus,
    gpuSelection,
    setGpuSelection,
  } = miner;

  const [showAllTargets, setShowAllTargets] = useState(false);

  /**
   * The hero always speaks about MINED XMR, whatever coin is being mined.
   *
   * When the user mines ZEPH or RVN, the XMR-denominated projection would be
   * meaningless, so the effective projection falls back to native. Getting
   * this wrong would show a ZEPH miner an ETH figure derived from an XMR
   * balance they are not accumulating.
   */
  /**
   * The mined coin, which is NOT always XMR.
   *
   * Caught in the sandbox on 2026-08-28: with the GPU lane on Ergo, the hero
   * read `mined — XMR` above a pool paying out in ERG. The projection is
   * defined as "mined-XMR balance × XMR→target rate" (the EARN pipeline only
   * routes XMR), so for any other target it does not apply at all — and
   * showing an ETH figure derived from an XMR balance the user is not
   * accumulating would be inventing a number about their money.
   *
   * So a non-XMR session falls back to speaking natively about the coin it is
   * actually mining, with no projection and no conversion chip.
   */
  const minedSym =
    MINING_COINS.find((c) => c.chain === miningCoin)?.sym ?? "XMR";

  /**
   * What this coin is allowed to claim.
   *
   * Replaces the earlier `isXmrSession` boolean, which collapsed three
   * genuinely different situations into one: XMR can be routed and projected;
   * ZEPH/ZANO have a price but no route yet; RVN/CFX/ERG have neither and
   * should show daily revenue instead. Treating the last two the same way
   * told a ZEPH miner nothing about what their coin is worth.
   */
  const capability = capabilityFor(miningCoin as ChainType);
  const canProject = capability.kind === "route";

  const effectiveProjection: MiningProjection = useMemo(
    () =>
      (canProject ? projection : null) ?? {
        targetTicker: minedSym,
        ratePerXmr: 1,
        xmrPriceUsd: null,
        fromEarnTarget: false,
      },
    [projection, canProject, minedSym],
  );

  // `hashrateSamples` is `{ t, value }[]` — same read as
  // `MineLandscapeView` (`hashrateSamples[n - 1].value`). Taking the object
  // as a number was the first thing tsc caught here.
  const current = hashrateSamples.length
    ? hashrateSamples[hashrateSamples.length - 1].value
    : 0;

  const earnings = useMemo(
    () =>
      current > 0
        ? estimateEarningsForChain(miningCoin as ChainType, current, {})
        : null,
    [miningCoin, current],
  );

  const perPeriod = earnings
    ? { day: earnings.day, week: earnings.week, month: earnings.month }
    : null;

  const targets = showAllTargets
    ? MINING_COINS
    : MINING_COINS.slice(0, TARGETS_COLLAPSED);
  const hiddenTargets = MINING_COINS.length - TARGETS_COLLAPSED;

  /**
   * Latency, derived exactly as `MineLandscapeView` does it.
   *
   * The miner's own per-snapshot ping wins over the pre-mine TCP probe, and
   * the probe only counts when it succeeded — `poolPings[id]` is a
   * `PoolPingResult`, not a number, and a failed probe still carries a
   * `latencyMs` that means nothing.
   */
  const probe = selectedPoolId ? poolPings[selectedPoolId] : undefined;
  const latencyMs =
    session?.pingMs ?? (probe?.ok ? probe.latencyMs : null);

  /**
   * `displayMinPayout` is a FUNCTION `(pool) => string`, not a string — it
   * reads the live per-pool minimum with a static fallback. Rendering the
   * function reference would have printed nothing useful and type-checked
   * only because JSX accepts almost anything in a text slot.
   */
  const payoutLabel = selectedPool ? displayMinPayout(selectedPool) : null;

  /**
   * Spot price of the coin being MINED, for the no-route revenue line.
   *
   * `pricesByTicker` is already injected for the profitability strip, so this
   * needs no new plumbing and no swap import — it is a price, not a route.
   */
  const minedPriceUsd = pricesByTicker?.[minedSym] ?? null;

  /**
   * Scaled hashrate, via the same formatter the PRO console uses.
   *
   * The first cut printed `current.toFixed(2)` with a hardcoded `H/s`, which
   * rendered a GPU session as `115990000.00 H/s` — technically true, unreadable,
   * and wrong about the unit for algorithms whose base unit is not H.
   * `formatHashrateParts` handles both the SI prefix and the per-algorithm
   * base unit, and is what the rest of the tab already agrees with.
   */
  const baseUnit = algorithmHashUnit(
    miningHardware === "cpu" ? cpuAlgorithm : gpuAlgorithm,
  );
  const hashParts = formatHashrateParts(current || null, baseUnit);
  const hashLabel = current > 0 ? `${hashParts.value} ${hashParts.unit}` : null;

  /* ── left column blocks ─────────────────────────────────────────── */

  const targetsCard = (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ marginBottom: 6 }}>
        <MicroLabel>mining target</MicroLabel>
      </div>
      {targets.map((c) => {
        const active = c.chain === miningCoin;
        return (
          <button
            key={c.chain}
            type="button"
            onClick={() => pickMiningCoin(c.chain, miner)}
            // Per-LANE, not per-session: a GPU coin stays selectable while a
            // CPU session runs. `disabled={isMining}` locked every coin and
            // was why ZANO could not be picked while XMR mined.
            disabled={coinTileLocked(c.chain, miner)}
            title={
              coinTileLocked(c.chain, miner)
                ? `Stop the ${c.hardware.toUpperCase()} session before switching target`
                : `Mine ${c.sym} with ${c.algo} on ${c.hardware.toUpperCase()}`
            }
            style={{
              fontFamily: "var(--font-mono)",
              textAlign: "left",
              display: "flex",
              alignItems: "center",
              gap: 10,
              border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
              borderTop: active ? undefined : "1px solid var(--border)",
              background: active ? "var(--accent-soft)" : "var(--surface)",
              padding: "9px 10px",
              marginTop: -1,
              cursor: coinTileLocked(c.chain, miner) ? "not-allowed" : "pointer",
              opacity: coinTileLocked(c.chain, miner) && !active ? 0.5 : 1,
            }}
          >
            <CoinIcon sym={c.sym} size={13} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 10,
                  color: active ? "var(--accent)" : "var(--text)",
                }}
              >
                {c.sym}
              </span>
              <span style={{ display: "block", fontSize: 8, color: "var(--text-dim)" }}>
                {c.algo}
              </span>
            </span>
          </button>
        );
      })}
      {hiddenTargets > 0 && (
        <button
          type="button"
          onClick={() => setShowAllTargets((v) => !v)}
          style={{
            fontFamily: "var(--font-mono)",
            border: "1px solid var(--border)",
            borderTop: "1px solid var(--border)",
            marginTop: -1,
            background: "var(--surface)",
            color: "var(--text-dim)",
            padding: "6px 10px",
            fontSize: 8,
            letterSpacing: 1,
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          {showAllTargets ? "▴ fewer" : `${hiddenTargets} more ▾`}
        </button>
      )}
    </div>
  );

  const hardwareCard = (
    <Panel>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <MicroLabel>hardware</MicroLabel>
        <Segmented
          options={[
            { value: "cpu" as const, label: "CPU" },
            { value: "gpu" as const, label: "GPU" },
          ]}
          value={miningHardware === "gpu" ? "gpu" : "cpu"}
          onChange={(v) => switchHardware(v)}
          disabled={isMining}
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 10,
        }}
      >
        <MicroLabel>load</MicroLabel>
        <Segmented
          // The mock labels these LOW / MED / MAX; the hook's vocabulary is
          // low | medium | high. Labels follow the mock, values follow the
          // hook — inventing a third vocabulary here is how a segmented
          // control ends up setting nothing.
          options={[
            { value: "low" as const, label: "LOW" },
            { value: "medium" as const, label: "MED" },
            { value: "high" as const, label: "MAX" },
          ]}
          value={miningIntensity}
          onChange={(v) => setMiningIntensity(v)}
        />
      </div>
      <div style={{ fontSize: 8, color: "var(--text-dim)", marginTop: 8 }}>
        med keeps your pc usable while mining
      </div>
      {miningHardware === "gpu" && gpus.length >= 2 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginTop: 10,
          }}
        >
          <MicroLabel>device</MicroLabel>
          <Segmented
            // Single-select covers the actual ask: mine on GPU 1 only, GPU 2
            // only, or ALL (both) — the last one is what a 2-GPU rig gets
            // today with no picker at all, so it stays the default (`null`).
            options={[
              { value: "all", label: "ALL" },
              ...gpus.map((_, i) => ({ value: String(i), label: `GPU ${i + 1}` })),
            ]}
            value={gpuSelection == null ? "all" : String(gpuSelection[0])}
            onChange={(v) => setGpuSelection(v === "all" ? null : [Number(v)])}
            disabled={isMining}
          />
        </div>
      )}
    </Panel>
  );

  const poolCard = (
    <Panel>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <MicroLabel>pool</MicroLabel>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 9,
            color: "var(--text-muted)",
          }}
        >
          {latencyMs != null && (
            <>
              <Mark
                tone={
                  latencyMs < 120 ? "accent" : latencyMs < 300 ? "warn" : "danger"
                }
                size={5}
              />
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {latencyMs}ms
              </span>
              <span style={{ color: "var(--text-dim)" }}>·</span>
            </>
          )}
          {selectedPool?.name ?? "—"}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 8,
        }}
      >
        <MicroLabel>payout at</MicroLabel>
        <span style={{ fontSize: 9, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
          {payoutLabel ?? "—"}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 8,
        }}
      >
        <MicroLabel>console</MicroLabel>
        <ViewModeChip mode="simple" onToggle={onShowPro} />
      </div>
    </Panel>
  );

  /* ── right column blocks ────────────────────────────────────────── */

  const hero = (
    <BalanceHero
      projection={effectiveProjection}
      minedTicker={minedSym}
      minedAmount={canProject ? minedAmount : null}
      mining={isMining}
      hashrateLabel={hashLabel}
      perPeriod={perPeriod}
      nextPayout={payoutLabel ? { threshold: payoutLabel, eta: null } : null}
      capabilityNote={canProject ? null : capability.note}
      routeLoading={canProject ? projection?.routeLoading === true : false}
      routeFailureText={canProject ? (projection?.routeFailureText ?? null) : null}
      routeSourceNote={canProject ? (projection?.routeSourceNote ?? null) : null}
      onRetryRoute={onRetryRoute ?? projection?.retryRoute}
      // For a coin with no route, the useful answer to "is this worth
      // running" is revenue, not a balance it cannot convert into.
      dailyUsd={
        !canProject && perPeriod && minedPriceUsd != null
          ? perPeriod.day * minedPriceUsd
          : null
      }
      onSelectDisplayCoin={canProject ? (onSelectDisplayCoin ?? (() => {})) : null}
      reachableTickers={reachableTickers}
      compact={compact}
    />
  );

  const cta = (
    <button
      type="button"
      onClick={() => (isMining ? void stopMining() : void startMining())}
      disabled={!minersReady || miningStarting}
      style={{
        fontFamily: "var(--font-pixel)",
        flex: compact ? undefined : 2.2,
        width: compact ? "100%" : undefined,
        border: "1px solid var(--accent)",
        background: "var(--accent-dim)",
        color: "var(--accent)",
        padding: compact ? "16px 12px" : "26px 12px",
        fontSize: compact ? 11 : 15,
        letterSpacing: 1,
        cursor: !minersReady || miningStarting ? "not-allowed" : "pointer",
        opacity: !minersReady || miningStarting ? 0.55 : 1,
      }}
    >
      {miningStarting
        ? "starting…"
        : isMining
          ? "■ STOP MINING"
          : "► START MINING"}
    </button>
  );

  const sparkCard = (
    <Panel style={{ flex: compact ? undefined : 1.4 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <MicroLabel>hashrate</MicroLabel>
        <span
          style={{
            fontSize: 11,
            color: "var(--accent)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {hashLabel ?? "—"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 26, marginTop: 10 }}>
        {(() => {
          const tail = hashrateSamples.slice(-12).map((h) => h.value);
          const peak = Math.max(1, ...tail);
          // A fixed 12 slots so the row does not reflow as samples arrive;
          // missing ones render as empty space rather than a squeezed chart.
          return Array.from({ length: 12 }, (_, i) => {
            const v = tail[i];
            const h = v == null ? 0 : Math.max(2, (v / peak) * 26);
            return (
              <span
                key={i}
                style={{
                  flex: 1,
                  height: h,
                  background:
                    i === tail.length - 1 ? "var(--accent)" : "var(--accent-dim)",
                  border: v == null ? "none" : "1px solid var(--accent-mid)",
                }}
              />
            );
          });
        })()}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          fontSize: 8,
          color: "var(--text-dim)",
        }}
      >
        <span>uptime {fmtUptime(session?.uptimeSecs ?? null)}</span>
        <span>{isMining ? "stable" : "idle"}</span>
      </div>
    </Panel>
  );

  // The EARN pipeline only routes XMR, so the promo is meaningless on a
  // ZEPH/RVN/CFX/ERG session and is not offered there.
  const promo = !canProject ? null : (
    <EarnPromoStrip
      targetTicker={effectiveProjection.targetTicker}
      onOpenEarn={onOpenEarn}
      conversionRunning={conversionRunning}
      compact={compact}
    />
  );

  /* ── arrangement ────────────────────────────────────────────────── */

  if (compact) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          fontFamily: "var(--font-mono)",
        }}
      >
        {hero}
        {cta}
        {sparkCard}
        {targetsCard}
        {hardwareCard}
        {poolCard}
        {promo}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 12, fontFamily: "var(--font-mono)" }}>
      <div
        style={{
          width: 270,
          flex: "none",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {targetsCard}
        {hardwareCard}
        {poolCard}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {hero}
        <div style={{ display: "flex", gap: 12 }}>
          {cta}
          {sparkCard}
        </div>
        {promo}
      </div>
    </div>
  );
}
