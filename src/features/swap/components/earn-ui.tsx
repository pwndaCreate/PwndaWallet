/**
 * src/features/swap/components/earn-ui.tsx
 *
 * The "mine X, receive Y" vocabulary: route diagram, target picker, convert
 * card, conversions list (canvas frames 1d landscape / 1e portrait / 1g).
 *
 * Shared by the landscape EARN tab and the portrait CONVERT segment, for the
 * same reason everything else in this folder is shared — the handoff asks for
 * two renderings of one pipeline, and two copies of a route diagram would be
 * two things to keep in step.
 *
 * The route diagram is the one component here that changes shape by surface:
 * landscape draws it horizontally (three nodes, animated dashed connectors),
 * portrait draws it vertically (three rows, short connector stubs). That is a
 * genuine layout difference the mocks both show, so it is a `direction` prop
 * on one component rather than two components.
 */
import type { CSSProperties, ReactNode } from "react";
import { CoinIcon } from "../../../components/CoinIcon";
import { StatusSquare } from "./swap-ui";

/* ─────────────────────────────────────────────────────────────
 * Route diagram
 * ───────────────────────────────────────────────────────────── */

export interface RouteNode {
  ticker: string;
  /** Small caption under the ticker: MINED / ROUTE HOP / TO YOUR WALLET. */
  role: string;
  /** The figure this node carries; `pass-through` for the hop. */
  value: string;
  /** Accent-frame this node (the source and, in the mock, the target). */
  emphasis?: boolean;
  /** Tiny glyph in the corner — ⛏ on the mined node. */
  badge?: string;
}

export interface RouteLeg {
  /** "P2P · FEE ~1%" */
  label: string;
  /** "30–90 MIN" */
  timing: string;
}

/**
 * The pipeline, drawn.
 *
 * `legs.length` must be `nodes.length - 1`. When the target IS the route hop
 * (a user converting to LTC), the caller passes two nodes and one leg and the
 * NEAR hop simply is not drawn — the handoff's "render 2 nodes and skip the
 * NEAR hop".
 */
export function RouteDiagram({
  nodes,
  legs,
  direction = "horizontal",
}: {
  nodes: readonly RouteNode[];
  legs: readonly RouteLeg[];
  direction?: "horizontal" | "vertical";
}) {
  const vertical = direction === "vertical";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        alignItems: vertical ? "stretch" : "center",
        gap: 0,
        fontFamily: "var(--mono)",
      }}
    >
      {nodes.map((n, i) => (
        <div
          key={n.ticker + i}
          style={{
            display: "contents",
          }}
        >
          <RouteNodeCard node={n} vertical={vertical} />
          {i < legs.length && (
            <RouteConnector leg={legs[i]} vertical={vertical} />
          )}
        </div>
      ))}
    </div>
  );
}

function RouteNodeCard({
  node,
  vertical,
}: {
  node: RouteNode;
  vertical: boolean;
}) {
  return (
    <div
      style={{
        flex: vertical ? undefined : 1,
        minWidth: 0,
        border: `1px solid ${node.emphasis ? "var(--accent-mid)" : "var(--border)"}`,
        background: node.emphasis ? "var(--accent-soft)" : "var(--surface)",
        padding: vertical ? "10px 12px" : "12px 14px",
        position: "relative",
        display: vertical ? "flex" : "block",
        alignItems: vertical ? "center" : undefined,
        gap: vertical ? 10 : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: vertical ? "none" : undefined,
        }}
      >
        <CoinIcon sym={node.ticker} size={vertical ? 16 : 20} />
        <span style={{ fontSize: vertical ? 11 : 13, color: "var(--text)" }}>
          {node.ticker}
        </span>
        {vertical && (
          <span
            style={{
              fontSize: 8,
              color: "var(--text-dim)",
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            {node.role}
          </span>
        )}
      </div>

      {!vertical && (
        <div
          style={{
            fontSize: 8,
            color: "var(--text-dim)",
            letterSpacing: 1,
            textTransform: "uppercase",
            marginTop: 8,
          }}
        >
          {node.role}
        </div>
      )}

      <div
        style={{
          marginLeft: vertical ? "auto" : 0,
          marginTop: vertical ? 0 : 2,
          fontSize: vertical ? 11 : 15,
          color: node.emphasis ? "var(--accent)" : "var(--text)",
          fontVariantNumeric: "tabular-nums",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {node.value}
      </div>

      {node.badge && !vertical && (
        <span
          style={{
            position: "absolute",
            top: 10,
            right: 12,
            fontSize: 11,
            color: node.emphasis ? "var(--accent)" : "var(--text-dim)",
          }}
        >
          {node.badge}
        </span>
      )}
    </div>
  );
}

/**
 * The animated dashed connector between two nodes.
 *
 * `dashm` is a keyframe the canvas defines and this app does not, so the
 * animation is declared inline against a background-position shift — the same
 * technique `.syncbar` already uses for the XMR sync stripe, which keeps this
 * inside the existing motion vocabulary rather than adding a keyframe for one
 * component. Motion here is DECORATIVE by the behavior contract's tiering:
 * dropping it costs nothing but liveliness.
 */
function RouteConnector({
  leg,
  vertical,
}: {
  leg: RouteLeg;
  vertical: boolean;
}) {
  if (vertical) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 0 6px 18px",
        }}
      >
        <span
          style={{
            width: 1,
            height: 16,
            background:
              "repeating-linear-gradient(180deg, var(--accent-mid) 0 3px, transparent 3px 6px)",
            flex: "none",
          }}
        />
        <span
          style={{
            fontSize: 8,
            color: "var(--text-dim)",
            letterSpacing: 0.8,
            textTransform: "uppercase",
          }}
        >
          {leg.label} · {leg.timing}
        </span>
      </div>
    );
  }
  return (
    <div
      style={{
        flex: 0.8,
        minWidth: 60,
        padding: "0 10px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 8,
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {leg.label}
      </div>
      <div
        style={{
          height: 2,
          background:
            "repeating-linear-gradient(90deg, var(--accent-mid) 0 6px, transparent 6px 12px)",
          backgroundSize: "24px 2px",
          animation: "syncbar var(--motion-syncbar-duration, 1200ms) linear infinite",
        }}
      />
      <div
        style={{
          fontSize: 8,
          color: "var(--text-dim)",
          letterSpacing: 0.8,
          marginTop: 6,
        }}
      >
        {leg.timing}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Target picker
 * ───────────────────────────────────────────────────────────── */

/**
 * "RECEIVE" / "RECEIVE AS" — the coin the pipeline ends in.
 *
 * `layout="grid"` is the landscape 2x2 (frame 1d); `layout="row"` is the
 * portrait chip row (frame 1e). `onMore` opens the full asset list; when the
 * caller has no list to open, it must pass `undefined` and the tile is not
 * rendered at all — a "+24 MORE" tile that opens nothing is exactly the dead
 * control this redesign is removing elsewhere.
 */
export function ReceivePicker({
  targets,
  selected,
  onSelect,
  moreCount,
  onMore,
  layout = "grid",
}: {
  targets: readonly string[];
  selected: string;
  onSelect: (ticker: string) => void;
  moreCount?: number;
  onMore?: () => void;
  layout?: "grid" | "row";
}) {
  const grid = layout === "grid";
  return (
    <div
      style={{
        display: grid ? "grid" : "flex",
        gridTemplateColumns: grid ? "1fr 1fr" : undefined,
        gap: 8,
        flexWrap: grid ? undefined : "wrap",
      }}
    >
      {targets.map((t) => {
        const on = t === selected;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onSelect(t)}
            title={`Receive ${t}`}
            style={{
              display: "flex",
              flexDirection: grid ? "column" : "row",
              alignItems: "center",
              justifyContent: "center",
              gap: grid ? 6 : 6,
              padding: grid ? "14px 0" : "6px 10px",
              border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
              background: on ? "var(--accent-soft)" : "var(--surface)",
              color: on ? "var(--accent)" : "var(--text-muted)",
              cursor: "pointer",
              fontFamily: "var(--mono)",
              fontSize: grid ? 9 : 10,
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            <CoinIcon sym={t} size={grid ? 18 : 14} />
            <span>{t}</span>
          </button>
        );
      })}
      {onMore && moreCount != null && moreCount > 0 && (
        <button
          type="button"
          onClick={onMore}
          title="Choose from every routable asset"
          style={{
            display: "flex",
            flexDirection: grid ? "column" : "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            padding: grid ? "14px 0" : "6px 10px",
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontFamily: "var(--mono)",
            fontSize: grid ? 9 : 10,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          <span style={{ fontSize: grid ? 14 : 11, lineHeight: 1 }}>+</span>
          <span>
            {moreCount} more ▾
          </span>
        </button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Conversions history
 * ───────────────────────────────────────────────────────────── */

export interface ConversionRow {
  id: string;
  fromTicker: string;
  toTicker: string;
  fromAmount: string;
  toAmount: string;
  /** Pre-formatted "3d ago". */
  age: string;
  status: "done" | "running" | "unwound";
}

export function ConversionsList({
  rows,
  emptyLabel = "no conversions yet",
  style,
}: {
  rows: readonly ConversionRow[];
  emptyLabel?: string;
  style?: CSSProperties;
}) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--text-dim)",
          padding: "10px 0",
          ...style,
        }}
      >
        {emptyLabel}
      </div>
    );
  }
  return (
    <div style={{ fontFamily: "var(--mono)", ...style }}>
      {rows.map((r) => (
        <div
          key={r.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "9px 0",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 10,
          }}
        >
          <CoinIcon sym={r.fromTicker} size={14} />
          <span style={{ color: "var(--text-dim)" }}>→</span>
          <CoinIcon sym={r.toTicker} size={14} />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              color: "var(--text)",
              fontVariantNumeric: "tabular-nums",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {r.fromAmount} {r.fromTicker}{" "}
            <span style={{ color: "var(--text-dim)" }}>→</span>{" "}
            <span style={{ color: "var(--accent)" }}>
              {r.toAmount} {r.toTicker}
            </span>
          </span>
          <span
            style={{
              fontSize: 9,
              color: "var(--text-dim)",
              flex: "none",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {r.age}
          </span>
          {r.status === "running" ? (
            <StatusSquare size={7} color="var(--warn)" pulse />
          ) : r.status === "unwound" ? (
            <StatusSquare size={7} color="var(--text-dim)" />
          ) : (
            <StatusSquare size={7} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Section frame
 * ───────────────────────────────────────────────────────────── */

/** A titled panel in the EARN/CONVERT language: 9px tracked label + border. */
export function EarnPanel({
  label,
  right,
  children,
  style,
  bodyStyle,
}: {
  label: string;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        fontFamily: "var(--mono)",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "9px 14px",
          borderBottom: "1px solid var(--border-soft)",
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 1.5,
          textTransform: "uppercase",
        }}
      >
        <span>{label}</span>
        {right}
      </div>
      <div style={{ padding: 14, ...bodyStyle }}>{children}</div>
    </div>
  );
}

/** The live-mining status chip both surfaces put in their header. */
export function MiningStatusChip({
  active,
  hardware,
  hashrate,
}: {
  active: boolean;
  hardware?: string | null;
  hashrate?: string | null;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "var(--mono)",
        fontSize: 9,
        letterSpacing: 1,
        textTransform: "uppercase",
        color: active ? "var(--accent)" : "var(--text-dim)",
      }}
    >
      <StatusSquare
        size={6}
        color={active ? "var(--accent)" : "var(--text-dim)"}
        pulse={active}
      />
      {active
        ? `mining${hardware ? ` · ${hardware}` : ""}${hashrate ? ` · ${hashrate}` : ""}`
        : "not mining"}
    </span>
  );
}
