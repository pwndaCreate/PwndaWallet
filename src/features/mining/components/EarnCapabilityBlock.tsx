/**
 * src/features/mining/components/EarnCapabilityBlock.tsx
 *
 * The EARN cross-promo, the display-coin chips and the capability note — the
 * three things a Mine surface may only offer when the mined coin can actually
 * be converted — behind ONE gate, for every Mine surface.
 *
 * # Why the gate lives here and not in each view
 *
 * `EarnPromoStrip` says "turn mined XMR into <target>", and the chips
 * re-denominate a balance through the XMR route. Both are only true for a
 * coin whose capability is `route` (`minedAssetCapability.ts`). The gate used
 * to be copied into each view:
 *
 *   - SIMPLE had it (`canProject`);
 *   - landscape PRO rendered the promo unconditionally until 2026-09-15, so a
 *     Xelis session advertised "turn mined XMR into BTC";
 *   - portrait PRO rendered neither the promo nor the chips at all, although
 *     `onOpenEarn` was wired to it, so an XMR miner on portrait PRO was never
 *     offered EARN (parity audit, 2026-09-16).
 *
 * Views render THIS, never `EarnPromoStrip` or the chips directly;
 * `__tests__/earnPromoCapabilityGate.test.ts` pins both halves.
 *
 * # When there is no route
 *
 * The block says why, in the capability's own words ("XEL has no swap route
 * out of mining — daily revenue shown instead"). The figures that note
 * promises are the surface's job — native coin amounts and daily USD, which
 * `MinedAssetView` provides.
 */
import type { CSSProperties } from "react";
import type { MinedAssetView } from "../minedAssetView";
import { DisplayCoinChips, EarnPromoStrip, Mark, Panel } from "./mine-simple";

export function CapabilityNote({
  note,
  style,
}: {
  note: string;
  style?: CSSProperties;
}) {
  return (
    <Panel pad="8px 12px" style={style}>
      <div
        role="note"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 9,
          lineHeight: 1.5,
          color: "var(--text-dim)",
          letterSpacing: 0.4,
        }}
      >
        <Mark tone="dim" size={5} />
        <span style={{ flex: 1 }}>{note}</span>
      </div>
    </Panel>
  );
}

export function EarnCapabilityBlock({
  asset,
  onSelectDisplayCoin,
  reachableTickers,
  onOpenEarn,
  conversionRunning = false,
  compact = false,
  showChips = true,
  showNote = true,
  style,
}: {
  /** From `useMinedAssetView` — the gate reads `asset.canProject`. */
  asset: MinedAssetView;
  /** Absent ⇒ no chips (nothing to pick with). */
  onSelectDisplayCoin?: (ticker: string) => void;
  reachableTickers?: readonly string[];
  /** Absent ⇒ no promo (PwndaLite has no EARN surface). */
  onOpenEarn?: () => void;
  conversionRunning?: boolean;
  compact?: boolean;
  /** SIMPLE's hero already carries the chips; it passes `false`. */
  showChips?: boolean;
  /** SIMPLE's hero already carries the note; it passes `false`. */
  showNote?: boolean;
  /** Applied to the outermost element, which only exists when something renders. */
  style?: CSSProperties;
}) {
  if (!asset.canProject) {
    return showNote && asset.capabilityNote ? (
      <CapabilityNote note={asset.capabilityNote} style={style} />
    ) : null;
  }

  const chips =
    showChips && onSelectDisplayCoin ? (
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <DisplayCoinChips
          selected={asset.displayTicker}
          onSelect={onSelectDisplayCoin}
          reachableTickers={reachableTickers}
        />
      </div>
    ) : null;

  const promo = onOpenEarn ? (
    <EarnPromoStrip
      targetTicker={asset.displayTicker}
      onOpenEarn={onOpenEarn}
      conversionRunning={conversionRunning}
      compact={compact}
    />
  ) : null;

  // `EarnPromoStrip` itself renders nothing without `onOpenEarn`; checking
  // here too keeps an empty wrapper (and its margins) off the page.
  if (!chips && !promo) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
      {chips}
      {promo}
    </div>
  );
}
