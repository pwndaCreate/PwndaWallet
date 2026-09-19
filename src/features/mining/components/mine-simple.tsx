/**
 * src/features/mining/components/mine-simple.tsx
 *
 * The SIMPLE Mine view's building blocks (canvas frame 3a).
 *
 * # The idea the mock is expressing
 *
 * "The balance you want is the hero; console hidden behind PRO." The old Mine
 * tab opened on instruments — hashrate chart, share counters, pool diff — which
 * answer "is my rig tuned" and never answer "is this worth leaving on". So the
 * hero is now the mined balance expressed in a coin the user actually wants,
 * and the console moves behind `PRO ▸`.
 *
 * # The honesty problem this file is mostly about
 *
 * That hero number is a **projection**, not a balance. The user has mined XMR;
 * showing "≈ 0.01893 ETH" is a claim about what it would convert to, through a
 * two-hop route, at today's prices, minus fees nobody has paid yet. Three rules
 * follow, and they are why several of these components look more defensive than
 * a mockup implies:
 *
 *   1. The `PROJECTED · NOT CONVERTED YET` chip is not optional decoration —
 *      the handoff calls it mandatory, and it renders whenever the displayed
 *      ticker is not the mined coin itself.
 *   2. An unknown rate renders `—`, never `0`. A zero here reads as "your
 *      mining is worth nothing", which is a statement about the user's money
 *      that nobody measured.
 *   3. Showing XMR in XMR is not a projection at all, so the chip and the `≈`
 *      both disappear and the number is the plain mined balance.
 *
 * # Boundary note
 *
 * Everything here is inside `src/features/mining/**`, which may not import
 * `features/swap`, `features/swap-sidecar` or `src/state` — PwndaLite ships
 * this feature standalone. The convert rate arrives as a plain
 * {@link MiningProjection} prop and the EARN promo as an `onOpenEarn`
 * callback; when the full app does not supply them (i.e. in Lite) the promo
 * simply does not render and the hero falls back to native XMR.
 */
import type { ReactNode } from "react";
import type { MiningProjection } from "../../../types/mining";
import type { PoolAccountView } from "../poolAccount";
import { CoinIcon } from "../../../components/CoinIcon";
import { SelectMenu } from "../../../design/primitives/SelectMenu";

const mono = { fontFamily: "var(--font-mono)" } as const;

/** The mined coin. Everything in this view is a projection FROM this. */
export const MINED_TICKER = "XMR";

/**
 * The quick chips beside the hero. Everything else lives in the dropdown.
 *
 * XMR is the mined coin (a valuation of itself, no conversion); ETH/BTC/SOL
 * are the operator-chosen headline targets. USD moved OUT of the quick set
 * and into the dropdown on 2026-08-28 — it is a unit of account rather than
 * a swap target, and giving it equal billing with three routable coins
 * implied you could convert into it.
 */
export const DISPLAY_COIN_CHOICES = ["XMR", "ETH", "BTC", "SOL"] as const;

/** Always offered in the dropdown, whatever the route roster contains. */
export const ALWAYS_AVAILABLE_DISPLAY_COINS = ["XMR", "USD"] as const;

/* ══════════════════════════════════════════════════════════════════════
   Shared atoms
   ══════════════════════════════════════════════════════════════════════ */

export function MicroLabel({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        ...mono,
        fontSize: 8,
        color: "var(--text-dim)",
        letterSpacing: 1.5,
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

/**
 * A 6px square status mark with the design system's glow.
 *
 * Square, not round: `design-system.md` states status marks are CSS squares,
 * and `<Dot>` is the round primitive. `pulse` is the same keyframe `<Dot>`
 * uses, so a live mark here breathes at the same rate as everywhere else.
 */
export function Mark({
  tone = "accent",
  size = 6,
  pulse = false,
}: {
  tone?: "accent" | "warn" | "danger" | "dim";
  size?: number;
  pulse?: boolean;
}) {
  const color =
    tone === "warn"
      ? "var(--warn)"
      : tone === "danger"
        ? "var(--danger)"
        : tone === "dim"
          ? "var(--text-dim)"
          : "var(--accent)";
  return (
    <span
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: `0 0 ${Math.max(4, size)}px ${color}`,
        animation: pulse ? "pulse 1.2s ease-in-out infinite" : undefined,
        flex: "none",
        display: "inline-block",
      }}
    />
  );
}

export function Panel({
  children,
  pad = 12,
  style,
}: {
  children: ReactNode;
  pad?: number | string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        padding: pad,
        ...mono,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Balance hero — the whole point of SIMPLE
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Format a projected amount at a sensible precision for its magnitude.
 *
 * Fixed decimals do not work across this range: the same view shows ~0.019 ETH
 * and ~0.42 XMR and could show ~61 USD or ~0.0000023 BTC. Too few digits and a
 * small holding reads as `0.00`, which is the "your mining is worth nothing"
 * failure again; too many and the hero is unreadable.
 */
export function formatProjected(n: number | null, ticker: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (ticker === "USD") {
    return n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : abs >= 0.0001 ? 6 : 8;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function DisplayCoinChips({
  selected,
  onSelect,
  reachableTickers,
}: {
  selected: string;
  onSelect: (ticker: string) => void;
  /**
   * Every asset this mining can actually end up as.
   *
   * Injected, and deliberately not "all wallet assets": the hero's number is
   * the output of XMR → LTC/BCH over Grove → target over NEAR Intents, so an
   * asset with no NEAR destination leg can be held by the wallet and still be
   * unreachable from mining. Offering it would produce a pick that can only
   * ever answer "no route" — the same defect the swap picker had on
   * 2026-08-25, when it listed LTC while the route gate refused it.
   *
   * The caller derives this from the capability registry
   * (`getDropdownTickers({ router: "intents" })`), which is the same source
   * the EARN tab's target list uses, so the two cannot offer different sets.
   */
  reachableTickers?: readonly string[];
}) {
  return (
    <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {DISPLAY_COIN_CHOICES.map((t) => {
        const active = t === selected;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onSelect(t)}
            aria-pressed={active}
            style={{
              ...mono,
              border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
              background: active ? "var(--accent-soft)" : "transparent",
              color: active ? "var(--accent)" : "var(--text-dim)",
              padding: "3px 8px",
              fontSize: 8,
              letterSpacing: 1,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <CoinIcon sym={t} size={11} />
            {t}
          </button>
        );
      })}
      {(() => {
        // The dropdown carries everything the chips do not. Rendered only
        // when it would contain something — an empty menu is a control that
        // cannot do anything.
        const quick = new Set<string>(DISPLAY_COIN_CHOICES);
        const rest = [
          ...new Set([
            ...ALWAYS_AVAILABLE_DISPLAY_COINS,
            ...(reachableTickers ?? []),
          ]),
        ]
          .map((t) => t.toUpperCase())
          .filter((t) => !quick.has(t))
          .sort();
        if (rest.length === 0) return null;
        // The current selection must appear even when it came from elsewhere
        // (the EARN target, or a value persisted before the roster changed),
        // or the trigger would show a coin the menu does not list.
        const values =
          rest.includes(selected) || quick.has(selected)
            ? rest
            : [selected, ...rest];
        const inDropdown = !quick.has(selected);
        return (
          <SelectMenu
            ariaLabel="Show balance as another asset"
            align="right"
            minWidth={92}
            placeholder="MORE"
            value={inDropdown ? selected : ""}
            onChange={(t) => t && onSelect(t)}
            items={values.map((t) => ({
              value: t,
              label: t,
              // USD is a valuation rather than a swap target — see
              // `useMiningProjection`. Saying so here stops it reading as
              // just another coin you could convert into.
              hint: t === "USD" ? "value" : undefined,
              glyph: t === "USD" ? undefined : <CoinIcon sym={t} size={12} />,
            }))}
          />
        );
      })()}
    </span>
  );
}

/**
 * {@link formatProjected} without trailing zeros: `0.5`, `0.00878`, `0` —
 * for balances and thresholds, where "0.50000 ERG" and "0.00000000 ERG" read
 * as precision the number does not have.
 */
export function formatAmount(n: number | null, ticker: string): string {
  const s = formatProjected(n, ticker);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * `$27.85`, `$0.013`, `<$0.01`, or `—`. Mining balances are often fractions of
 * a cent; `$0.00` reads as "worth nothing", which is the wrong message.
 */
export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (Math.abs(n) >= 1) return `$${formatProjected(n, "USD")}`;
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(3)}`;
  return "<$0.01";
}

/**
 * The user's account at the selected pool, inside the balance hero: unpaid,
 * paid, the payout level and a bar toward it. When there is no number, it
 * shows the reason and the action that fixes it. Shared by SIMPLE (both
 * layouts) and landscape PRO; `poolAccount.ts` makes the decisions.
 */
export function PoolAccountStrip({
  account,
  onOptIn,
  onRefresh,
  onOpenStats,
}: {
  account: PoolAccountView;
  onOptIn?: () => void;
  onRefresh?: () => void;
  onOpenStats?: (url: string) => void;
}) {
  const a = account;
  const amt = (v: number | null) =>
    v == null ? "—" : `${formatAmount(v, a.ticker)} ${a.ticker}`;
  const linkBtn = {
    ...mono,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-muted)",
    padding: "2px 8px",
    fontSize: 8,
    letterSpacing: 1,
    textTransform: "uppercase" as const,
    cursor: "pointer",
  };
  const cells: { label: string; value: string; usd: number | null }[] = [
    { label: "unpaid", value: amt(a.unpaid), usd: a.unpaidUsd },
    ...(a.immature != null && a.immature > 0
      ? [{ label: "confirming", value: amt(a.immature), usd: null }]
      : []),
    { label: "paid", value: amt(a.paid), usd: a.paidUsd },
    {
      label: a.thresholdSource === "account" ? "your payout at" : "pays at",
      // "pool" = custom levels exist but the API is silent: the note says so.
      value: amt(a.threshold),
      usd: null,
    },
  ];
  return (
    <div
      data-testid="pool-account"
      style={{
        marginTop: 14,
        border: "1px solid var(--border-soft)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <MicroLabel>at {a.poolName}</MicroLabel>
        <span style={{ flex: 1 }} />
        {a.status === "ok" && onRefresh && (
          <button type="button" style={linkBtn} onClick={onRefresh} title="Read the pool again">
            refresh
          </button>
        )}
        {a.statsPageUrl && onOpenStats && (
          <button
            type="button"
            style={linkBtn}
            onClick={() => onOpenStats(a.statsPageUrl as string)}
            title="Open the pool's own stats page in your browser"
          >
            my stats ↗
          </button>
        )}
      </div>

      {a.status === "ok" ? (
        <>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 10 }}>
            {cells.map((c) => (
              <div key={c.label} style={{ flex: 1, minWidth: 90 }}>
                <MicroLabel>{c.label}</MicroLabel>
                <div
                  style={{
                    marginTop: 3,
                    color: c.label === "unpaid" ? "var(--accent)" : "var(--text)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {c.value}
                </div>
                {c.usd != null && (
                  <div style={{ fontSize: 8, color: "var(--text-dim)", marginTop: 2 }}>
                    {formatUsd(c.usd)}
                  </div>
                )}
              </div>
            ))}
          </div>
          {a.progress != null && (
            <div
              title={`${Math.round(a.progress * 100)}% of the payout level`}
              style={{ height: 3, background: "var(--border-soft)", position: "relative" }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: `${a.progress > 0 ? Math.max(2, a.progress * 100) : 0}%`,
                  background: "var(--accent)",
                }}
              />
            </div>
          )}
        </>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 9,
            color: a.status === "error" ? "var(--warn)" : "var(--text-dim)",
            flexWrap: "wrap",
          }}
        >
          <Mark
            tone={a.status === "error" ? "warn" : "dim"}
            size={5}
            pulse={a.status === "loading"}
          />
          <span style={{ flex: 1, minWidth: 160 }}>
            {a.status === "loading" ? `reading your balance at ${a.poolName}…` : a.note}
          </span>
          {a.status === "needs-optin" && onOptIn && (
            <button type="button" style={{ ...linkBtn, color: "var(--accent)" }} onClick={onOptIn}>
              check balance
            </button>
          )}
          {a.threshold != null && (
            <span style={{ color: "var(--text-dim)" }}>pays at {amt(a.threshold)}</span>
          )}
        </div>
      )}

      {a.status === "ok" && a.note && (
        <div style={{ fontSize: 8, color: "var(--text-dim)", lineHeight: 1.5 }}>{a.note}</div>
      )}
    </div>
  );
}

export function BalanceHero({
  projection,
  minedTicker = MINED_TICKER,
  minedAmount,
  mining,
  hashrateLabel,
  perPeriod,
  nextPayout,
  onSelectDisplayCoin,
  reachableTickers,
  capabilityNote = null,
  dailyUsd = null,
  routeLoading = false,
  routeFailureText = null,
  routeSourceNote = null,
  onRetryRoute,
  compact = false,
  heroLabel = null,
  walletAmount = null,
  priceUsd = null,
  poolAccount = null,
  onPoolOptIn,
  onPoolRefresh,
  onOpenPoolStats,
}: {
  projection: MiningProjection;
  /**
   * The coin actually being mined. Usually XMR, but a ZEPH/RVN/ERG session
   * says so rather than borrowing XMR's name — see `MineSimpleView`'s
   * `isXmrSession`.
   */
  minedTicker?: string;
  /** Mined balance in {@link minedTicker}. `null` when none is reported. */
  minedAmount: number | null;
  mining: boolean;
  hashrateLabel: string | null;
  /** Coin-unit earnings estimates, already in the MINED coin (XMR). */
  perPeriod: { day: number; week: number; month: number } | null;
  nextPayout: { threshold: string; eta: string | null } | null;
  /**
   * `null` disables the picker entirely — a non-XMR session has no convert
   * route to re-denominate into, so offering the chips would be offering a
   * control that cannot do anything.
   */
  onSelectDisplayCoin: ((ticker: string) => void) | null;
  /** Assets reachable from mining — see `DisplayCoinChips`. */
  reachableTickers?: readonly string[];
  /**
   * Why this coin has no projected balance, when it has none.
   *
   * Rendered in place of the SHOWN-AS chips. A coin the wallet cannot route
   * out of must say so — leaving the row blank reads as a loading state, and
   * showing chips that cannot change anything is a dead control.
   */
  capabilityNote?: string | null;
  /**
   * Estimated USD revenue per day, for coins with no route. The useful answer
   * to "is this worth running" when there is nothing to convert into.
   */
  dailyUsd?: number | null;
  /** True while the book / quote is in flight — shows a working line, not a dash. */
  routeLoading?: boolean;
  /** Why there is no number. Rendered whenever there is none. */
  routeFailureText?: string | null;
  /** Names the book when it was not the user's own node. */
  routeSourceNote?: string | null;
  onRetryRoute?: () => void;
  compact?: boolean;
  /**
   * What the big number IS: `wallet` for a routed coin (the convertible
   * balance), `unpaid at pwnda pool` for the rest. Without it the hero read
   * as "your mined balance" whatever it held (2026-09-18).
   */
  heroLabel?: string | null;
  /** The mined coin's balance in this wallet, for the "in wallet" line. */
  walletAmount?: number | null;
  /** USD per mined coin. Falls back to the projection's XMR price. */
  priceUsd?: number | null;
  /** The account at the selected pool; see `poolAccount.ts`. */
  poolAccount?: PoolAccountView | null;
  onPoolOptIn?: () => void;
  onPoolRefresh?: () => void;
  onOpenPoolStats?: (url: string) => void;
}) {
  const { targetTicker, ratePerXmr, xmrPriceUsd } = projection;
  const isNative = targetTicker === minedTicker;
  const converted =
    minedAmount != null && ratePerXmr != null ? minedAmount * ratePerXmr : null;

  const unitUsd = priceUsd ?? xmrPriceUsd;
  // A projected hero is always the routed coin's WALLET balance, so without
  // an explicit wallet amount that balance is the native figure to show.
  walletAmount = walletAmount ?? (!isNative ? minedAmount : null);
  const walletUsd =
    walletAmount != null && unitUsd != null ? walletAmount * unitUsd : null;
  const heroUsd =
    minedAmount != null && unitUsd != null ? minedAmount * unitUsd : null;

  const periodIn = (v: number | undefined) =>
    v != null && ratePerXmr != null ? v * ratePerXmr : null;

  return (
    <Panel pad={compact ? "14px 14px 12px" : "18px 20px 16px"}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <MicroLabel>
          {heroLabel ?? "balance"}
          {capabilityNote ? "" : " · shown as"}
        </MicroLabel>
        {capabilityNote && (
          <span style={{ fontSize: 8, color: "var(--text-dim)", letterSpacing: 0.5 }}>
            {capabilityNote}
          </span>
        )}
        {onSelectDisplayCoin && (
          <DisplayCoinChips
            selected={targetTicker}
            onSelect={onSelectDisplayCoin}
            reachableTickers={reachableTickers}
          />
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: compact ? 10 : 14,
          marginTop: 14,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-pixel)",
            fontSize: compact ? 22 : 34,
            color: "var(--accent)",
            textShadow: "0 0 22px rgba(0,255,102,0.3)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {/* No `≈` on the native case: showing XMR in XMR is the balance
              itself, and an approximation sign there would imply a conversion
              that is not happening. */}
          {isNative ? "" : "≈ "}
          {/* `—` in Press Start 2P is a full-width solid bar and reads as a
              progress element rather than "unknown", so the pixel hero uses a
              plain hyphen. Every other surface keeps the em dash. */}
          {(() => {
            const v = isNative
              ? formatAmount(minedAmount, targetTicker)
              : formatProjected(converted, targetTicker);
            return v === "—" ? "-" : v;
          })()}
        </span>
        <span
          style={{
            fontFamily: "var(--font-pixel)",
            fontSize: compact ? 11 : 15,
            color: "var(--accent)",
          }}
        >
          {targetTicker}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 9,
            color: mining ? "var(--accent)" : "var(--text-dim)",
          }}
        >
          <Mark tone={mining ? "accent" : "dim"} pulse={mining} />
          {mining
            ? `MINING${hashrateLabel ? ` · ${hashrateLabel}` : ""}`
            : "IDLE"}
        </span>
      </div>

      {/* Why there is no number, when there is none.

          A bare `-` is what produced "sol asset wont come up ... Why is
          that?" — the estimate had failed, the reason was known, and the
          hero printed a dash. The engine's own sentence is preferred (it
          names the maker minimum or protocol floor that refused, with the
          numbers in it); the generic one is the fallback. */}
      {/* Which book priced this, when it was not the user's own node. */}
      {routeSourceNote && (
        <div
          style={{
            marginTop: 6,
            fontSize: 8,
            color: "var(--text-dim)",
            letterSpacing: 0.5,
          }}
        >
          {routeSourceNote}
        </div>
      )}

      {converted == null && !isNative && (routeLoading || routeFailureText) && (
        <div
          style={{
            marginTop: 8,
            fontSize: 9,
            lineHeight: 1.5,
            color: routeLoading ? "var(--text-dim)" : "var(--warn)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {routeLoading ? (
            <>
              <Mark tone="dim" size={5} pulse />
              pricing the route from the order book…
            </>
          ) : (
            <>
              <Mark tone="warn" size={5} />
              <span style={{ flex: 1 }}>{routeFailureText}</span>
              {onRetryRoute && (
                <button
                  type="button"
                  onClick={onRetryRoute}
                  style={{
                    ...mono,
                    border: "1px solid rgba(255,170,0,0.4)",
                    background: "transparent",
                    color: "var(--warn)",
                    padding: "2px 8px",
                    fontSize: 8,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  retry
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 12,
          fontSize: 10,
          color: "var(--text-dim)",
          flexWrap: "wrap",
        }}
      >
        {/* The hero's own USD value, then the wallet line. Until 2026-09-18
            this row read "mined <wallet XMR>": the wallet cannot tell mined
            coins from received ones, and every other coin printed "—". */}
        {heroUsd != null && (
          <>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatUsd(heroUsd)}</span>
            <span style={{ color: "rgba(255,255,255,0.15)" }}>|</span>
          </>
        )}
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          in wallet {formatAmount(walletAmount, minedTicker)} {minedTicker}
          {walletUsd != null ? ` · ${formatUsd(walletUsd)}` : ""}
        </span>
        {unitUsd != null && (
          <>
            <span style={{ color: "rgba(255,255,255,0.15)" }}>|</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              1 {minedTicker} = {formatUsd(unitUsd)}
            </span>
          </>
        )}
        {dailyUsd != null && (
          <>
            <span style={{ color: "rgba(255,255,255,0.15)" }}>|</span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--accent)" }}>
              ≈ ${dailyUsd.toFixed(2)}/day
            </span>
          </>
        )}
        {!isNative && (
          <>
            <span style={{ color: "rgba(255,255,255,0.15)" }}>|</span>
            {/* Mandatory per the handoff. Absent on the native case because
                nothing is being projected there. */}
            <span
              style={{
                border: "1px solid var(--border)",
                padding: "1px 7px",
                fontSize: 8,
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
            >
              projected · not converted yet
            </span>
          </>
        )}
      </div>

      {poolAccount && (
        <PoolAccountStrip
          account={poolAccount}
          onOptIn={onPoolOptIn}
          onRefresh={onPoolRefresh}
          onOpenStats={onOpenPoolStats}
        />
      )}

      <div
        style={{
          display: "flex",
          gap: 14,
          marginTop: 16,
          borderTop: "1px solid var(--border-soft)",
          paddingTop: 12,
          flexWrap: "wrap",
        }}
      >
        {(
          [
            ["per day", periodIn(perPeriod?.day)],
            ["per week", periodIn(perPeriod?.week)],
            ["per month", periodIn(perPeriod?.month)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} style={{ flex: 1, minWidth: 96 }}>
            <MicroLabel>{label}</MicroLabel>
            <div
              style={{
                fontSize: 11,
                color: "var(--text)",
                marginTop: 4,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {value == null
                ? "—"
                : `${isNative ? "" : "≈ "}${formatProjected(value, targetTicker)} ${targetTicker}`}
            </div>
          </div>
        ))}
        <div style={{ flex: 1, minWidth: 96 }}>
          <MicroLabel>next payout</MicroLabel>
          <div
            style={{
              fontSize: 11,
              color: "var(--text)",
              marginTop: 4,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {nextPayout
              ? `${nextPayout.threshold}${nextPayout.eta ? ` · ${nextPayout.eta}` : ""}`
              : "—"}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   EARN cross-promo
   ══════════════════════════════════════════════════════════════════════ */

/**
 * "turn mined XMR into ETH when you're ready".
 *
 * Renders only when the host app supplies `onOpenEarn` — PwndaLite has no EARN
 * surface, so in Lite this is absent rather than a dead button. That is the
 * no-dead-controls rule and the module boundary agreeing with each other.
 *
 * Hidden while a conversion is already running: the strip's whole message is
 * "you could start one", which is noise when one is in flight. The host passes
 * `conversionRunning` because only it can see the pipeline.
 */
export function EarnPromoStrip({
  targetTicker,
  onOpenEarn,
  conversionRunning = false,
  compact = false,
}: {
  targetTicker: string;
  onOpenEarn?: () => void;
  conversionRunning?: boolean;
  compact?: boolean;
}) {
  if (!onOpenEarn) return null;

  if (conversionRunning) {
    return (
      <Panel pad="10px 12px">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 9,
            color: "var(--accent)",
          }}
        >
          <Mark pulse />
          <span style={{ flex: 1 }}>
            a conversion is running · watch it in earn
          </span>
          <button
            type="button"
            onClick={onOpenEarn}
            style={{
              ...mono,
              border: "1px solid var(--accent)",
              background: "var(--accent-soft)",
              color: "var(--accent)",
              padding: "4px 12px",
              fontSize: 8,
              letterSpacing: 1,
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            ► open earn
          </button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel pad={compact ? "10px 12px" : "14px 16px"}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ color: "var(--accent)", fontSize: 12 }}>◎</span>
        <CoinIcon sym={MINED_TICKER} size={12} />
        <span
          aria-hidden
          style={{
            width: 40,
            borderTop: "1px dashed var(--accent-mid)",
            opacity: 0.7,
          }}
        />
        <CoinIcon sym={targetTicker} size={12} />
        <span style={{ flex: 1, fontSize: 10, color: "var(--text-muted)" }}>
          turn mined {MINED_TICKER} into{" "}
          <span style={{ color: "var(--accent)" }}>{targetTicker}</span> when
          you&apos;re ready
        </span>
        <button
          type="button"
          onClick={onOpenEarn}
          style={{
            ...mono,
            border: "1px solid var(--accent)",
            background: "var(--accent-soft)",
            color: "var(--accent)",
            padding: "7px 16px",
            fontSize: 9,
            letterSpacing: 1,
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          ► open earn
        </button>
      </div>
    </Panel>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   PRO / SIMPLE toggle
   ══════════════════════════════════════════════════════════════════════ */

export function ViewModeChip({
  mode,
  onToggle,
}: {
  mode: "simple" | "pro";
  onToggle: () => void;
}) {
  const toPro = mode === "simple";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={
        toPro
          ? "Show the full mining console"
          : "Back to the simple view"
      }
      style={{
        ...mono,
        border: `1px solid ${toPro ? "var(--border)" : "var(--accent)"}`,
        background: toPro ? "transparent" : "var(--accent-soft)",
        color: toPro ? "var(--text-dim)" : "var(--accent)",
        padding: "4px 10px",
        fontSize: 8,
        letterSpacing: 1,
        textTransform: "uppercase",
        cursor: "pointer",
      }}
    >
      {toPro ? "PRO ▸" : "◂ SIMPLE"}
    </button>
  );
}
