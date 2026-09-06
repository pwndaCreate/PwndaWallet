/**
 * src/features/swap-sidecar/SwapNodeCardParts.tsx
 *
 * The two states of the Settings swap-node card (canvas frame 1h): the
 * pre-opt-in rail, and the running strip.
 *
 * Split out of `SidecarStatusCard` rather than inlined so the pieces stay
 * readable next to that file's ~600 lines of poll/start/stop machinery, and so
 * both are testable as pure views — everything here takes props and renders.
 *
 * # What the redesign removed, and the one thing it did not
 *
 * The OFF state used to be a paragraph explaining that nothing is downloaded
 * until you turn it on. That claim is now the `NOTHING RUNS UNTIL YOU CLICK`
 * chip plus a three-step rail that shows what turning it on will DO — which
 * says the same thing in a form you can check at a glance.
 *
 * # The sweep-back control that is NOT here, and why (2026-08-28)
 *
 * An earlier draft of this card carried a `SWEEP BACK` button and a footer
 * reading "node funds ≠ wallet funds". Both were wrong for Pwnda Grove.
 *
 * Grove runs the engine against the WALLET'S OWN accounts: BTC, LTC and XMR
 * swap straight from balances the user already holds, which is why the setup
 * wizard says "there is nothing to deposit and nothing to sweep back". In that
 * configuration a permanent sweep-back button is a control with nothing to
 * act on, and the footer asserted a custody split that does not exist.
 *
 * Sweep-back is not deleted from the product, because it is not universally
 * meaningless: a user can turn sharing OFF per coin ("fund the node by
 * deposit instead"), and a node can hold a stranded balance from an earlier
 * configuration. That case is already served by `SweepBackSection` on the
 * Swap tab, which computes `sweepableCoins()` and renders NOTHING when the
 * list is empty — the correct shape, and one this card must not duplicate
 * with a second funds-moving entry point.
 *
 * So this card only *reports*: when the node holds a sweepable balance it
 * says so and points at where to act; otherwise it states that swaps use the
 * user's own wallet. The footer is derived, never asserted.
 */
import { requestDexCoinsFocus } from "./dexCoinsFocus";
import type { ReactNode } from "react";
import { CoinIcon } from "../../components/CoinIcon";
import {
  Chip,
  ChipRow,
  PixelCta,
  StatusSquare,
  HollowSquare,
} from "../swap/components/swap-ui";

/* ─────────────────────────────────────────────────────────────
 * OFF — the three-step rail
 * ───────────────────────────────────────────────────────────── */

export interface SetupStep {
  icon: string;
  label: string;
  /** done → filled, current → accent outline, pending → dim. */
  state: "done" | "current" | "pending";
}

/**
 * Derive the rail from the node's own status rather than a counter.
 *
 * `runtimeInstalled` and `configured` are facts the backend reports, so the
 * rail cannot drift from reality the way a UI-side step index would.
 */
export function deriveSetupSteps(args: {
  runtimeInstalled: boolean;
  configured: boolean;
  running: boolean;
}): SetupStep[] {
  const { runtimeInstalled, configured, running } = args;
  return [
    {
      icon: "▼",
      label: "download",
      state: runtimeInstalled ? "done" : "current",
    },
    {
      icon: "↺",
      label: "sync",
      state: !runtimeInstalled ? "pending" : configured ? "done" : "current",
    },
    {
      icon: "●",
      label: "ready",
      state: running ? "done" : configured ? "current" : "pending",
    },
  ];
}

export function SetupRail({ steps }: { steps: readonly SetupStep[] }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 4,
        fontFamily: "var(--mono)",
      }}
    >
      {steps.map((s, i) => (
        <div
          key={s.label}
          style={{ display: "contents" }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              flex: "none",
            }}
          >
            <div
              style={{
                width: 42,
                height: 42,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: `1px solid ${
                  s.state === "pending" ? "var(--border)" : "var(--accent-mid)"
                }`,
                background:
                  s.state === "current" ? "var(--accent-soft)" : "transparent",
                color:
                  s.state === "pending" ? "var(--text-dim)" : "var(--accent)",
                fontSize: 15,
              }}
            >
              {s.icon}
            </div>
            <span
              style={{
                fontSize: 8,
                letterSpacing: 1,
                textTransform: "uppercase",
                color:
                  s.state === "pending" ? "var(--text-dim)" : "var(--text-muted)",
              }}
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <span
              style={{
                flex: 1,
                height: 1,
                marginBottom: 16,
                background:
                  "repeating-linear-gradient(90deg, var(--border-hi) 0 4px, transparent 4px 8px)",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function SwapNodeOffState({
  steps,
  onEnable,
  busy,
}: {
  steps: readonly SetupStep[];
  onEnable?: () => void;
  busy?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SetupRail steps={steps} />
      <PixelCta
        label={busy ? "WORKING…" : "► ENABLE SWAP NODE"}
        disabled={busy || !onEnable}
        onClick={onEnable}
      />
      <ChipRow>
        <Chip>keys from your vault phrase</Chip>
        <Chip>nothing runs until you click</Chip>
      </ChipRow>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * RUNNING — the status strip
 * ───────────────────────────────────────────────────────────── */

export interface NodeStatusCell {
  label: string;
  /** Rendered after the label; omit for a dot-only cell. */
  value?: string;
  tone?: "ok" | "warn" | "idle";
  title?: string;
}

/** `PART 100%` · `XMR ●` · `ZEPH ●` · `ZANO ●` · `214 OFFERS` */
export function NodeStatusStrip({ cells }: { cells: readonly NodeStatusCell[] }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {cells.map((c) => (
        <div
          key={c.label}
          title={c.title}
          style={{
            flex: "1 1 0",
            // 78, not 92: the strip gained its fourth cell (ZANO) on
            // 2026-09-04 and at 92 the portrait card (~365px inside the
            // gutters) wrapped it onto a lonely second row. `PART 100%`, the
            // widest label, needs ~70px at this size, so 78 keeps four cells
            // on one line in portrait and still wraps gracefully narrower.
            minWidth: 78,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            padding: "8px 10px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            fontFamily: "var(--mono)",
            fontSize: 9,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: "var(--text-muted)",
          }}
        >
          <span>{c.label}</span>
          {c.value != null && (
            <span
              className="tnum"
              style={{
                color:
                  c.tone === "warn"
                    ? "var(--warn)"
                    : c.tone === "idle"
                      ? "var(--text-dim)"
                      : "var(--accent)",
              }}
            >
              {c.value}
            </span>
          )}
          {c.value == null &&
            (c.tone === "idle" ? (
              <HollowSquare size={6} />
            ) : (
              <StatusSquare
                size={6}
                color={c.tone === "warn" ? "var(--warn)" : "var(--accent)"}
                pulse={c.tone === "ok"}
              />
            ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The DEX-coin tiles.
 *
 * **Read-only on purpose.** Frame 1h draws them as toggles, but the coin set
 * already has an editor directly below this card (`DexCoinsSection`), and that
 * path owns the whole apply cycle — `swap_sidecar_set_coin`, the
 * pending-coins reconcile, and the restart it sometimes needs. A second
 * writer here would be two controls for one piece of node state, which is the
 * shape that produced the 2026-08-20 "prop threaded to the panel but not the
 * section" defect. These tiles say WHICH coins are on; the card below is where
 * you change them, and the caption says so.
 */
export function DexCoinTiles({
  coins,
}: {
  coins: ReadonlyArray<{ ticker: string; enabled: boolean }>;
}) {
  // Clicking a tile does NOT toggle the coin -- see this component's doc for
  // why there is exactly one writer. It jumps to that writer instead, which is
  // what a user reaching for a tile is actually trying to do.
  const goToEditor = () => requestDexCoinsFocus();
  // The tiles are derived from `useCoinStatuses`, which is empty until its
  // first read returns. Rendering the header against an empty list produces
  // "dex coins · 0 of 0 on" — a count that reads as a finding when it is
  // really "not loaded yet". Absent beats zero, the same rule the offers cell
  // in this card already follows.
  if (coins.length === 0) return null;
  return (
    <div>
      <div
        style={{
          fontSize: 8,
          color: "var(--text-dim)",
          letterSpacing: 1.5,
          textTransform: "uppercase",
          marginBottom: 6,
          fontFamily: "var(--mono)",
        }}
      >
        {/* No count here, deliberately.

            This read "n of m on" until 2026-08-28 and sat directly above the
            DEX COINS section's own "n of m enabled" — two counters over two
            different coin sets (this one excludes PART/XMR/ZEPH, which the
            strip above already reports, and coins with no daemon binary).
            Even once both were correct, the operator still had to work out
            why the card said 4 of 4 and the section said 6 of 7. So the card
            answers WHICH coins are on — the tiles carry that, filled or
            hollow — and the section keeps the count. One number, one owner. */}
        dex coins
        <button
          type="button"
          onClick={goToEditor}
          style={{
            marginLeft: 6,
            background: "none",
            border: "none",
            padding: 0,
            font: "inherit",
            letterSpacing: 0,
            textTransform: "none",
            color: "var(--accent)",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          change coins
        </button>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {coins.map((c) => (
          <button
            key={c.ticker}
            type="button"
            onClick={goToEditor}
            title={`${c.ticker} is ${c.enabled ? "enabled" : "off"} - open the DEX COINS editor to change it`}
            style={{
              flex: 1,
              minWidth: 0,
              cursor: "pointer",
              font: "inherit",
              textAlign: "center",
              border: `1px solid ${c.enabled ? "var(--accent-mid)" : "var(--border)"}`,
              background: c.enabled ? "var(--accent-soft)" : "var(--surface)",
              padding: "9px 0",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 5,
              fontFamily: "var(--mono)",
              fontSize: 8,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: c.enabled ? "var(--accent)" : "var(--text-dim)",
              opacity: c.enabled ? 1 : 0.65,
            }}
          >
            <CoinIcon sym={c.ticker} size={16} glow={false} />
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {c.ticker}
              {c.enabled ? <StatusSquare size={5} /> : <HollowSquare size={5} />}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function SwapNodeRunningState({
  statusCells,
  coins,
  balanceLabel,
  onOpenP2P,
  onStop,
  busy,
  footer,
}: {
  statusCells: readonly NodeStatusCell[];
  coins: ReadonlyArray<{ ticker: string; enabled: boolean }>;
  balanceLabel: string;
  onOpenP2P?: () => void;
  onStop?: () => void;
  busy?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <NodeStatusStrip cells={statusCells} />
      <DexCoinTiles coins={coins} />

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
          fontFamily: "var(--mono)",
          fontSize: 9,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: "var(--text-dim)",
        }}
      >
        <span>node balance</span>
        <span className="tnum" style={{ color: "var(--text)", fontSize: 10 }}>
          {balanceLabel}
        </span>
      </div>

      <div
        style={{
          fontSize: 8,
          color: "var(--text-dim)",
          fontFamily: "var(--mono)",
          lineHeight: 1.5,
        }}
      >
        {footer ?? "swaps run from your own wallet · the node holds nothing to sweep"}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={onOpenP2P}
          disabled={!onOpenP2P}
          style={{
            flex: 1.4,
            border: "1px solid var(--accent-mid)",
            background: "var(--accent-soft)",
            color: "var(--accent)",
            padding: "9px 0",
            fontFamily: "var(--mono)",
            fontSize: 9,
            letterSpacing: 1,
            textTransform: "uppercase",
            cursor: onOpenP2P ? "pointer" : "not-allowed",
            opacity: onOpenP2P ? 1 : "var(--disabled-opacity, 0.4)",
          }}
        >
          ► open p2p swap
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={busy || !onStop}
          style={{
            flex: 0.7,
            border: "1px solid var(--danger)",
            background: "transparent",
            color: "var(--danger)",
            padding: "9px 0",
            fontFamily: "var(--mono)",
            fontSize: 9,
            letterSpacing: 1,
            textTransform: "uppercase",
            cursor: busy || !onStop ? "not-allowed" : "pointer",
            opacity: busy || !onStop ? "var(--disabled-opacity, 0.4)" : 1,
          }}
        >
          {busy ? "…" : "stop"}
        </button>
      </div>
    </div>
  );
}

/** "running · 14d" — uptime rendered coarsely, since precision is noise here. */
export function formatUptime(startedAtMs: number | null, now = Date.now()): string {
  if (!startedAtMs) return "running";
  const secs = Math.max(0, Math.floor((now - startedAtMs) / 1000));
  if (secs < 60) return "running · just started";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `running · ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `running · ${hours}h`;
  return `running · ${Math.floor(hours / 24)}d`;
}
