/**
 * The Activity header's per-chain history status, shared by both layouts
 * (operator report, 2026-09-30 — see `historyStatus.ts` for what it replaced).
 *
 * Reads, in order: what is still loading; chains whose history this wallet
 * cannot read yet (neutral — not an error); then failures grouped by reason,
 * each naming its chains by display name. Every failed chain's full error
 * string is in the group's tooltip. Long groups collapse behind "show".
 */
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { HistoryStatusSummary } from "./historyStatus";

/** Names shown per group before it collapses to "+N more". */
const INLINE_NAMES = 3;

function names(list: string[], expanded: boolean): string {
  if (expanded || list.length <= INLINE_NAMES) return list.join(", ");
  return `${list.slice(0, INLINE_NAMES).join(", ")} +${list.length - INLINE_NAMES} more`;
}

export function HistoryStatusLine({
  summary,
  failureTone = "var(--warn)",
  style,
}: {
  summary: HistoryStatusSummary;
  /** Landscape shows failures in --warn; portrait keeps its T1.3 dim tone. */
  failureTone?: string;
  style?: CSSProperties;
}) {
  const [expanded, setExpanded] = useState(false);
  const { loading, unavailable, failures } = summary;
  if (loading.length === 0 && unavailable.length === 0 && failures.length === 0) return null;
  const collapsible =
    loading.length > INLINE_NAMES ||
    unavailable.length > INLINE_NAMES ||
    failures.some((f) => f.chains.length > INLINE_NAMES);
  const sep = <span style={{ color: "var(--text-dim)" }}> · </span>;
  const parts: ReactNode[] = [];
  if (loading.length > 0) {
    parts.push(
      <span key="loading" title={loading.join(", ")}>
        loading {names(loading, expanded)}
      </span>,
    );
  }
  if (unavailable.length > 0) {
    parts.push(
      <span
        key="unavailable"
        title={unavailable.map((n) => `history not available for ${n} yet`).join("\n")}
      >
        history not available yet: {names(unavailable, expanded)}
      </span>,
    );
  }
  for (const f of failures) {
    parts.push(
      <span
        key={f.kind}
        style={{ color: failureTone }}
        title={f.chains.map((c) => `${c.name}: ${c.message.split("\n", 1)[0]}`).join("\n")}
      >
        {f.label}: {names(f.chains.map((c) => c.name), expanded)}
      </span>,
    );
  }
  return (
    <span
      data-testid="history-status-line"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        color: "var(--text-dim)",
        lineHeight: 1.6,
        ...style,
      }}
    >
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && sep}
          {p}
        </span>
      ))}
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            marginLeft: 6,
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            padding: "0 6px",
          }}
        >
          {expanded ? "hide" : "show"}
        </button>
      )}
    </span>
  );
}
