/**
 * src/features/mining/components/MineRunControls.tsx
 *
 * The run control and the status lines under it, for every Mine surface:
 * SIMPLE (both layouts), landscape PRO and portrait PRO.
 *
 * # Why these are shared
 *
 * Portrait PRO was the only surface that handled a lane that cannot start:
 * its button said "► No XEL payout address" and a line under the hero
 * printed `useMiner`'s `minerError`. Landscape PRO and SIMPLE disabled START
 * only while the miners were missing, so with no payout address the button
 * looked live, `startMining` set "No mining address set for the selected
 * coin.", and nothing on those screens rendered it — a click that did nothing
 * and said nothing (parity audit, 2026-09-16). The same silence hid every
 * other `minerError` (proxy pre-flight, Tor, pool config, spawn failures) on
 * those surfaces.
 *
 * The STATE comes from `runButtonState` (`miningLane.ts`), so every surface
 * agrees on what a click does. Only the look differs, by `variant`.
 */
import type { CSSProperties } from "react";
import { Btn } from "../../../components/PrimitivesV2";
import { ST } from "../../../components/Primitives";
import {
  runButtonState,
  startBlockerHint,
  type StartBlocker,
} from "../miningLane";

export interface MineRunButtonProps {
  /** The displayed lane is mining. */
  mining: boolean;
  starting: boolean;
  blockedBy: StartBlocker;
  /** Ticker of the coin the lane would mine, for the blocked label. */
  coinTicker: string;
  onStart: () => void;
  onStop: () => void;
  /** Open Miner Setup. Absent ⇒ the "Set up miners" state is inert (PwndaLite). */
  onSetup?: () => void;
  /**
   * `hero`  — portrait PRO's full-width primitive button.
   * `pixel` — the pixel-font block button SIMPLE and landscape PRO use.
   */
  variant: "hero" | "pixel";
  /** `pixel` only: `START MINING` vs `START`. */
  labels?: "long" | "short";
  /** `pixel` only: base font size. A blocked label is a sentence, so it renders smaller. */
  fontSize?: number;
  style?: CSSProperties;
}

export function MineRunButton({
  mining,
  starting,
  blockedBy,
  coinTicker,
  onStart,
  onStop,
  onSetup,
  variant,
  labels = "long",
  fontSize = 13,
  style,
}: MineRunButtonProps) {
  const s = runButtonState({
    mining,
    starting,
    blockedBy,
    coinTicker,
    canOpenSetup: !!onSetup,
  });
  const onClick =
    s.action === "start"
      ? onStart
      : s.action === "stop"
        ? onStop
        : s.action === "setup"
          ? onSetup
          : undefined;
  const blocked = s.kind === "blocked-address" || s.kind === "blocked-miners";
  const title =
    s.kind === "blocked-address"
      ? `Mining needs a ${coinTicker} address for the pool to pay. Add a ${coinTicker} wallet (or payout address) first.`
      : s.kind === "blocked-miners"
        ? onSetup
          ? "Open Miner Setup to download the mining software"
          : "Mining software is not installed yet"
        : undefined;

  if (variant === "hero") {
    if (s.kind === "stop") {
      return (
        <Btn variant="danger" full size="lg" onClick={onClick} style={style}>
          Stop mining
        </Btn>
      );
    }
    if (!blocked) {
      return (
        <Btn
          variant="accent"
          full
          size="lg"
          onClick={onClick}
          disabled={s.disabled}
          style={style}
        >
          {s.kind === "starting" ? "Starting..." : "Start mining"}
        </Btn>
      );
    }
    // UXS-20260516-115: a blocked lane renders as a ghost, visually distinct
    // from a live START, and "Set up miners" actually navigates.
    return (
      <Btn
        variant="ghost"
        full
        size="lg"
        onClick={onClick}
        disabled={s.disabled}
        style={style}
        title={title}
      >
        {s.blockedLabel ?? ""}
      </Btn>
    );
  }

  const long = labels === "long";
  const label =
    s.kind === "stop"
      ? long
        ? "■ STOP MINING"
        : "■ STOP"
      : s.kind === "starting"
        ? "starting…"
        : s.kind === "start"
          ? long
            ? "► START MINING"
            : "► START"
          : (s.blockedLabel ?? "").toUpperCase();

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={s.disabled}
      title={title}
      data-run-state={s.kind}
      style={{
        fontFamily: "var(--font-pixel)",
        border: `1px solid ${blocked ? "var(--border)" : "var(--accent)"}`,
        background: blocked ? "transparent" : "var(--accent-dim)",
        color: blocked ? "var(--text-muted)" : "var(--accent)",
        padding: "22px 12px",
        fontSize: blocked ? Math.max(8, Math.round(fontSize * 0.7)) : fontSize,
        letterSpacing: 1,
        lineHeight: 1.6,
        cursor: s.disabled ? "not-allowed" : "pointer",
        // A blocked label IS the message, so it stays legible; only the
        // transient `starting…` state fades.
        opacity: s.kind === "starting" ? 0.55 : 1,
        ...style,
      }}
    >
      {label}
    </button>
  );
}

/**
 * `useMiner`'s error and info lines, plus the hint under a blocked run
 * control. Renders nothing when there is nothing to say.
 */
export function MinerStatusBanner({
  error,
  info,
  blockedBy,
  mining,
  style,
}: {
  /** `useMiner().minerError` — `""` when there is none. */
  error: string;
  /** `useMiner().minerInfo` — auto-clearing, `""` when there is none. */
  info: string;
  blockedBy: StartBlocker;
  /** The displayed lane is mining. A running lane had an address when it started. */
  mining: boolean;
  /** Applied to the wrapper, which only exists when there is something to say. */
  style?: CSSProperties;
}) {
  const hint = mining ? null : startBlockerHint(blockedBy);
  if (!error && !info && !hint) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, ...style }}>
      {error && (
        <div className="miner-error" role="alert" style={{ marginBottom: 0 }}>
          {error}
        </div>
      )}
      {info && (
        <div
          role="status"
          style={{
            padding: "6px 10px",
            border: "1px solid var(--accent)",
            background: "rgba(0,255,102,0.08)",
            color: "var(--accent)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: 0.4,
          }}
        >
          {info}
        </div>
      )}
      {hint && (
        <div className="mine-setup-hint">
          <ST speed={20}>{hint}</ST>
        </div>
      )}
    </div>
  );
}
