/**
 * Send / Receive / Swap for the focused asset. One component for both
 * layouts: landscape (default) renders tall tiles, portrait (`compact`) a
 * single row of inline buttons.
 *
 * Every action takes a `blockedReason`. Non-null disables the action AND says
 * why, under the row: a disabled control with no explanation reads as broken,
 * and a `title` tooltip is not shown on a disabled button in every webview.
 *
 * The reasons come from `wallet-surface.ts` (`sendBlockedReason`,
 * `receiveBlockedReason`, `swapBlockedReason`), so both layouts disable the
 * same actions for the same reasons. Until 2026-09-16 each layout wrote its
 * own gates: portrait let an unsynced Xelis or Zephyr wallet open Send, both
 * layouts copied an empty address on Receive, and both enabled Swap for XEL,
 * which no swap venue carries.
 */
export interface WalletAction {
  onClick: () => void;
  /** Non-null disables the action; the text is shown under the row. */
  blockedReason: string | null;
  /** Tooltip when enabled. */
  title?: string;
}

export function WalletActionRow({
  send,
  receive,
  swap,
  compact = false,
}: {
  send: WalletAction;
  receive: WalletAction;
  swap: WalletAction;
  /** Portrait: one row of inline buttons instead of tall tiles. */
  compact?: boolean;
}) {
  const actions = [
    { key: "send", glyph: "▲", label: "Send", action: send, accent: false },
    { key: "receive", glyph: "▼", label: "Receive", action: receive, accent: false },
    { key: "swap", glyph: "⇄", label: "Swap", action: swap, accent: true },
  ] as const;

  // One line per distinct reason, in action order. Two actions blocked for the
  // same reason would otherwise print it twice.
  const reasons = [...new Set(actions.map((a) => a.action.blockedReason).filter(Boolean))] as string[];

  return (
    <div style={compact ? { margin: "0 0 14px" } : undefined} data-wallet-action-row>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: compact ? 8 : 10,
        }}
      >
        {actions.map(({ key, glyph, label, action, accent }) => {
          const blocked = action.blockedReason != null;
          return (
            <button
              key={key}
              type="button"
              className={`qbtn${accent ? " accent" : ""}`}
              onClick={action.onClick}
              disabled={blocked}
              title={action.blockedReason ?? action.title}
              data-action={key}
              data-blocked={blocked || undefined}
              style={
                compact
                  ? undefined
                  : {
                      padding: "14px 8px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 10,
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                    }
              }
            >
              <span
                style={
                  compact
                    ? { marginRight: 6 }
                    : { fontSize: 18, color: "var(--accent)" }
                }
              >
                {glyph}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      {reasons.length > 0 && (
        <div
          data-action-reasons
          style={{
            marginTop: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            fontFamily: "var(--font-mono)",
            fontSize: compact ? 10 : 9.5,
            color: "var(--text-dim)",
            lineHeight: 1.4,
          }}
        >
          {reasons.map((r) => (
            <span key={r}>{r}</span>
          ))}
        </div>
      )}
    </div>
  );
}
