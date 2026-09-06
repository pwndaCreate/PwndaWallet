/**
 * src/features/swap/components/swap-ui.tsx
 *
 * The shared visual vocabulary of the 2026-08-28 swap redesign (canvas
 * `Swap Redesign.dc.html`, frames 1b / 1c / 2a).
 *
 * ONE module, imported by portrait (`SwapView`), landscape
 * (`SwapLandscapeView`) and the shared `SwapForm`, because the contributor guide's
 * Landscape-First rule makes a second copy of any of these a parity bug
 * waiting to happen — the BasicSwap taker flow shipped portrait-only for
 * weeks precisely because its blocks were not in a shared module.
 *
 * Every value here traces to a token in `src/design/tokens.ts` via its CSS
 * variable. Nothing is hardcoded that a token could express; the two
 * exceptions are `#060606` (the input well the mock uses for coin buttons and
 * the flip control — it predates this work and already appears in
 * `styles.css`'s `.field`) and the `rgba(255,255,255,0.04)` network-pill
 * wash, both taken verbatim from the approved frames.
 *
 * Behaviors: these are presentational. The signature motions
 * (`src/design/BEHAVIORS.md`) stay with their owners — `<ST>` scramble on the
 * headings that already carry it, hover-scramble inside `<Btn>`, and the
 * `pulse` keyframe reused here for live dots at the tier the contract calls
 * "structural" (a live indicator must convey liveness; the exact motion may
 * be swapped).
 */
import type { CSSProperties, ReactNode } from "react";
import { CoinIcon } from "../../../components/CoinIcon";

/* ─────────────────────────────────────────────────────────────
 * Shared atoms
 * ───────────────────────────────────────────────────────────── */

/** Section eyebrow: 9px, 2px tracking, uppercase, dim. */
export function Eyebrow({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 9,
        color: "var(--text-dim)",
        letterSpacing: 2,
        textTransform: "uppercase",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * A square status indicator with a glow, at the size the mocks use.
 *
 * Deliberately NOT `<Dot>`: that primitive is a round 6px dot, and the
 * redesign's status marks are squares (`design-system.md` "status dots are
 * 6x6 CSS squares" — the mocks lean on that harder, at 5–11px, with the
 * glow scaled to the size). `pulse` is the same keyframe `<Dot>` uses.
 */
export function StatusSquare({
  color = "var(--accent)",
  size = 6,
  pulse = false,
  style,
}: {
  color?: string;
  size?: number;
  pulse?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: "none",
        background: color,
        boxShadow: `0 0 ${Math.max(4, Math.round(size))}px ${color}`,
        animation: pulse
          ? "pulse var(--motion-pulse-duration, 1400ms) ease-in-out infinite"
          : undefined,
        ...style,
      }}
    />
  );
}

/** A hollow (pending) counterpart to `StatusSquare`. */
export function HollowSquare({
  size = 6,
  style,
}: {
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: "none",
        border: "1px solid var(--border-hi)",
        background: "transparent",
        ...style,
      }}
    />
  );
}

/**
 * Bordered micro-chip — the redesign's replacement for explanatory prose.
 *
 * `tone="accent"` is the single-highlight variant the mocks use for the one
 * chip that carries the strongest claim (`NO KYC`, `REFUND-SAFE`).
 */
export function Chip({
  children,
  tone = "muted",
  title,
  onClick,
  style,
}: {
  children: ReactNode;
  tone?: "muted" | "accent" | "warn" | "danger";
  title?: string;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  const color =
    tone === "accent"
      ? "var(--accent)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "danger"
          ? "var(--danger)"
          : "var(--text-dim)";
  const borderColor =
    tone === "accent"
      ? "var(--accent-mid)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "danger"
          ? "var(--danger)"
          : "var(--border)";
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title}
      style={{
        border: `1px solid ${borderColor}`,
        padding: "3px 8px",
        textTransform: "uppercase",
        fontFamily: "var(--mono)",
        fontSize: 8,
        letterSpacing: 1,
        color,
        background: "transparent",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        cursor: onClick ? "pointer" : undefined,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

/** A row of `Chip`s, centered, as every mock places them under a CTA. */
export function ChipRow({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        flexWrap: "wrap",
        gap: 6,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Hairline · LABEL · hairline separator (mock: "quick pairs", "conversions"). */
export function LabeledDivider({
  label,
  style,
}: {
  label: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 9,
        color: "var(--text-dim)",
        letterSpacing: 1.5,
        textTransform: "uppercase",
        ...style,
      }}
    >
      <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
      <span>{label}</span>
      <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
    </div>
  );
}

/**
 * The primary call to action.
 *
 * `--pixel` is reserved by `design-system.md` for the wordmark and primary
 * CTAs; this is the CTA half of that rule. Disabled state follows the
 * behavior contract's `--disabled-opacity` + `not-allowed`, and deliberately
 * drops the accent framing so a gated CTA cannot read as actionable.
 */
export function PixelCta({
  label,
  onClick,
  disabled = false,
  tone = "accent",
  title,
  style,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "accent" | "danger";
  title?: string;
  style?: CSSProperties;
}) {
  const base = tone === "danger" ? "var(--danger)" : "var(--accent)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: "100%",
        border: `1px solid ${disabled ? "var(--border)" : tone === "danger" ? "var(--danger)" : "var(--accent-mid)"}`,
        background: disabled ? "var(--surface)" : "var(--accent-soft)",
        color: disabled ? "var(--text-dim)" : base,
        padding: 14,
        fontFamily: "var(--pixel)",
        fontSize: 11,
        textAlign: "center",
        letterSpacing: 1,
        lineHeight: 1.5,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? "var(--disabled-opacity, 0.4)" : 1,
        transition:
          "background var(--motion-hover-duration, 120ms) var(--motion-hover-easing, ease)",
        ...style,
      }}
    >
      {label}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Mode tabs (frame 1b)
 * ───────────────────────────────────────────────────────────── */

export interface SwapModeTab {
  /** Stable id the caller switches on. */
  id: string;
  /** Single glyph, 14px in the mock. */
  icon: string;
  label: string;
  title?: string;
}

/**
 * The four-way mode strip: icon over label, active = accent text +
 * `--accent-soft` fill + 2px accent underline.
 *
 * **This component is the fix for F2** (`design-surface-map` §12). The strip
 * existed in FOUR places with two idioms, two of which rendered tabs
 * (`SwapKit`, `Desk`) whose setter silently rejects them — a click that
 * changed nothing, with no feedback. There is now one strip, and its tabs are
 * supplied by one caller-side list derived from the live router options, so a
 * retired router cannot come back as a dead tab.
 */
export function SwapModeTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly SwapModeTab[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        border: "1px solid var(--border)",
        background: "var(--surface)",
      }}
    >
      {tabs.map((t, i) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            title={t.title}
            onClick={() => onSelect(t.id)}
            style={{
              flex: 1,
              padding: "9px 4px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              background: on ? "var(--accent-soft)" : "transparent",
              color: on ? "var(--accent)" : "var(--text-muted)",
              border: "none",
              borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}`,
              borderLeft: i === 0 ? undefined : "1px solid var(--border-soft)",
              cursor: "pointer",
              fontFamily: "var(--mono)",
              transition:
                "all var(--motion-hover-duration, 120ms) var(--motion-hover-easing, ease)",
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>{t.icon}</span>
            <span
              style={{
                fontSize: 9,
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
            >
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Amount cards (frames 1b / 2a)
 * ───────────────────────────────────────────────────────────── */

/** The coin selector button inside an `AmountCard`. */
export function CoinSelectButton({
  ticker,
  onClick,
  disabled,
  title,
}: {
  ticker: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? `Change ${ticker}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "8px 12px",
        background: "#060606",
        border: "1px solid var(--border)",
        fontSize: 12,
        fontFamily: "var(--mono)",
        color: "var(--text)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? "var(--disabled-opacity, 0.4)" : 1,
        flex: "none",
      }}
    >
      <CoinIcon sym={ticker} size={20} />
      <span style={{ color: "var(--text)" }}>{ticker}</span>
      <span style={{ color: "var(--text-dim)", fontSize: 9 }}>▾</span>
    </button>
  );
}

/**
 * One framed amount card — the send or receive half of the form.
 *
 * The two cards are stacked with the flip control between them at
 * `margin: -1px 0`, so their borders overlap into a single hairline rather
 * than doubling. That is why `overlapTop` exists: the receive card pulls
 * itself up by 1px for the same reason.
 */
export function AmountCard({
  label,
  amount,
  onAmountChange,
  amountColor = "var(--white)",
  ticker,
  onPickCoin,
  pickDisabled,
  balanceLabel,
  onMax,
  usdLabel,
  networkLabel,
  readOnly = false,
  placeholder = "0.00",
  overlapTop = false,
  rightOfLabel,
  pickerSlot,
  footerSlot,
}: {
  label: string;
  amount: string;
  onAmountChange?: (v: string) => void;
  amountColor?: string;
  ticker: string;
  onPickCoin?: () => void;
  pickDisabled?: boolean;
  balanceLabel?: string | null;
  onMax?: () => void;
  usdLabel?: string | null;
  networkLabel?: string | null;
  readOnly?: boolean;
  placeholder?: string;
  overlapTop?: boolean;
  rightOfLabel?: ReactNode;
  /**
   * Replaces the built-in `CoinSelectButton`.
   *
   * The swap form passes its existing `CoinPickerButton` here rather than
   * having this card grow a dropdown of its own: that component already owns
   * the routable-asset filtering, the balance column, and the dedup-aware
   * (symbol, blockchain) picking. Re-implementing any of that to match a
   * mock would be inventing a second source of truth for which assets are
   * pickable.
   */
  pickerSlot?: ReactNode;
  /** Extra row under the footer (network sub-selector, minimum hint). */
  footerSlot?: ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        padding: "12px 14px",
        marginTop: overlapTop ? -1 : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 1.5,
          textTransform: "uppercase",
        }}
      >
        <span>{label}</span>
        {rightOfLabel ??
          (balanceLabel ? (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {balanceLabel}
              </span>
              {onMax && (
                <button
                  type="button"
                  onClick={onMax}
                  title="Use the full balance"
                  style={{
                    border: "1px solid var(--border)",
                    padding: "1px 6px",
                    color: "var(--text-muted)",
                    background: "transparent",
                    fontFamily: "var(--mono)",
                    fontSize: 9,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  max
                </button>
              )}
            </span>
          ) : null)}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 8,
        }}
      >
        {readOnly ? (
          <span
            style={{
              flex: 1,
              fontSize: 24,
              color: amountColor,
              fontVariantNumeric: "tabular-nums",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {amount || placeholder}
          </span>
        ) : (
          <input
            value={amount}
            onChange={(e) => onAmountChange?.(e.target.value)}
            placeholder={placeholder}
            inputMode="decimal"
            aria-label={label}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 24,
              color: amountColor,
              fontVariantNumeric: "tabular-nums",
              fontFamily: "var(--mono)",
              background: "transparent",
              border: "none",
              outline: "none",
              padding: 0,
            }}
          />
        )}
        {pickerSlot ?? (
          <CoinSelectButton
            ticker={ticker}
            onClick={onPickCoin}
            disabled={pickDisabled}
          />
        )}
      </div>

      {(usdLabel || networkLabel) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 8,
            fontSize: 10,
          }}
        >
          <span
            style={{
              color: "var(--text-dim)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {usdLabel ?? ""}
          </span>
          {networkLabel && (
            <span
              style={{
                display: "inline-flex",
                padding: "1px 6px",
                fontSize: 9,
                color: "var(--text-dim)",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid var(--border)",
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              {networkLabel}
            </span>
          )}
        </div>
      )}
      {footerSlot}
    </div>
  );
}

/** The ⇅ control that straddles the two amount cards. */
export function FlipButton({
  onClick,
  title = "Swap direction",
}: {
  onClick?: () => void;
  title?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        margin: "-1px 0",
      }}
    >
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        style={{
          width: 38,
          height: 38,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid var(--accent-mid)",
          background: "#060606",
          color: "var(--accent)",
          fontSize: 16,
          position: "relative",
          zIndex: 2,
          cursor: "pointer",
          fontFamily: "var(--mono)",
        }}
      >
        ⇅
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Quote panel (frames 1b / 2a)
 * ───────────────────────────────────────────────────────────── */

export interface QuoteRow {
  label: string;
  value: string;
  /** Renders the value in accent + a live/oracle marker. */
  accent?: boolean;
  /** Marker text next to an accent value: "LIVE" (1b) or "ORACLE" (2a). */
  marker?: string;
  /** Pulse the marker's square. */
  markerPulse?: boolean;
}

/**
 * The quote panel: compact label/value rows, no prose.
 *
 * Replaces the old block that mixed a rate line with two paragraphs of
 * routing explanation. The mocks reduce it to four rows because everything
 * else the paragraphs said is now either a chip or absent by design.
 */
export function QuotePanel({ rows }: { rows: readonly QuoteRow[] }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        padding: "10px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 10,
        fontFamily: "var(--mono)",
      }}
    >
      {rows.map((r) => (
        <div
          key={r.label}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            style={{
              color: "var(--text-dim)",
              letterSpacing: 1,
              textTransform: "uppercase",
              flex: "none",
            }}
          >
            {r.label}
          </span>
          {r.accent ? (
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  color: "var(--accent)",
                  fontVariantNumeric: "tabular-nums",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.value}
              </span>
              {r.marker && (
                <>
                  <StatusSquare size={5} pulse={r.markerPulse} />
                  <span
                    style={{
                      color: "var(--text-dim)",
                      fontSize: 9,
                      letterSpacing: 1,
                      flex: "none",
                    }}
                  >
                    {r.marker}
                  </span>
                </>
              )}
            </span>
          ) : (
            <span
              style={{
                color: "var(--text)",
                fontVariantNumeric: "tabular-nums",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {r.value}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Quick pairs (frame 1b)
 * ───────────────────────────────────────────────────────────── */

export function QuickPairs({
  pairs,
  onPick,
}: {
  pairs: ReadonlyArray<{ from: string; to: string }>;
  onPick: (from: string, to: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {pairs.map((p) => (
        <button
          key={`${p.from}-${p.to}`}
          type="button"
          onClick={() => onPick(p.from, p.to)}
          title={`Swap ${p.from} for ${p.to}`}
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 5,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            padding: "7px 0",
            fontSize: 9,
            color: "var(--text-muted)",
            fontFamily: "var(--mono)",
            cursor: "pointer",
            minWidth: 0,
          }}
        >
          <CoinIcon sym={p.from} size={14} />
          <span style={{ color: "var(--text-dim)" }}>→</span>
          <CoinIcon sym={p.to} size={14} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {p.from}/{p.to}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Receive banner (frames 1c / 1e / 1g)
 * ───────────────────────────────────────────────────────────── */

/** Accent-framed "YOU RECEIVE ≈" row — the P2P and convert hero figure. */
export function ReceiveBanner({
  label = "you receive ≈",
  amount,
  ticker,
  usdLabel,
  amountSize = 22,
}: {
  label?: string;
  amount: string;
  ticker: string;
  usdLabel?: string | null;
  amountSize?: number;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--accent-mid)",
        background: "var(--accent-soft)",
        padding: "12px 16px",
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        fontFamily: "var(--mono)",
      }}
    >
      <span
        style={{
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 1.5,
          textTransform: "uppercase",
          flex: "none",
        }}
      >
        {label}
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: amountSize,
            color: "var(--accent)",
            fontVariantNumeric: "tabular-nums",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {amount} {ticker}
        </span>
        {usdLabel && (
          <span
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              fontVariantNumeric: "tabular-nums",
              flex: "none",
            }}
          >
            {usdLabel}
          </span>
        )}
      </span>
    </div>
  );
}

/** One-line 8px footnote — the only prose the redesign keeps. */
export function FootNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        textAlign: "center",
        fontSize: 8,
        color: "var(--text-dim)",
        letterSpacing: 0.5,
        fontFamily: "var(--mono)",
      }}
    >
      {children}
    </div>
  );
}
