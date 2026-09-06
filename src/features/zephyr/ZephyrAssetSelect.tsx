/**
 * src/features/zephyr/ZephyrAssetSelect.tsx
 *
 * A real dropdown for the four Zephyr protocol assets.
 *
 * # What it replaces
 *
 * The Swap tab's Zephyr card rendered a `CoinSelectButton` with a `▾` glyph
 * whose handler was `setFromAsset(cycle(fromAsset, toAsset))` — it looked like
 * a dropdown and behaved like a next-button, stepping to the following asset
 * and lighting up the corresponding tile in the balance strip above. Reported
 * twice: *"the asset selector looks like a drop down but when I click it the
 * top sub-headers light up and switch between assets like a toggle button"*,
 * and again after the topology work landed without the UI.
 *
 * A caret that does not open anything is a false affordance: the user is told
 * a list exists and then has to click three times to reach the third item,
 * with no way to see what the options are.
 *
 * # Why it shows the route, not just the name
 *
 * Zephyr conversion is not all-to-all — `zephyrRoutes.ts` has the topology.
 * Some pairs are one transaction; ZPH→ZYS is two; ZRS→ZYS is three. A picker
 * that lists four names with no further information invites a user to select a
 * pair that costs three signed transactions without saying so, and the modal's
 * old hard-coded copy covered only some of those pairs (ZSD→ZRS had none, so
 * it simply looked direct).
 *
 * Each option therefore carries its leg count relative to the other side, and
 * multi-leg picks stay SELECTABLE — they are legitimate, just longer. Refusing
 * them would strand ZRS holders from yield entirely.
 */
import { useMemo } from "react";
import {
  ZPH_ASSETS,
  ZPH_UI_TICKER,
  type ZphAssetType,
} from "../../wallets/zph-rpc";
import { routeFor } from "./zephyrRoutes";

const mono = { fontFamily: "var(--font-mono)" } as const;

export function ZephyrAssetSelect({
  value,
  onChange,
  /** The asset on the other side, used to annotate each option's route. */
  counterpart,
  /**
   * Which side this selector drives. Routes are directional in wording (mint
   * vs redeem) even though leg COUNT is symmetric, so the annotation is
   * computed from the correct end.
   */
  side,
  balanceFor,
  disabled = false,
}: {
  value: ZphAssetType;
  onChange: (a: ZphAssetType) => void;
  counterpart: ZphAssetType;
  side: "from" | "to";
  balanceFor?: (a: ZphAssetType) => string;
  disabled?: boolean;
}) {
  const options = useMemo(
    () =>
      ZPH_ASSETS.map((asset) => {
        // Same asset on both sides is not a conversion; it stays listed so the
        // select can display the current value, but it is not selectable.
        const isCounterpart = asset === counterpart;
        const route =
          side === "from"
            ? routeFor(asset, counterpart)
            : routeFor(counterpart, asset);
        const legs = route?.legs.length ?? 0;
        return { asset, isCounterpart, legs };
      }),
    [counterpart, side],
  );

  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ZphAssetType)}
      aria-label={side === "from" ? "Asset to send" : "Asset to receive"}
      style={{
        ...mono,
        border: "1px solid var(--border-hi)",
        background: "var(--surface)",
        color: "var(--text)",
        padding: "6px 8px",
        fontSize: 11,
        letterSpacing: 0.5,
        cursor: disabled ? "not-allowed" : "pointer",
        minWidth: 132,
      }}
    >
      {options.map(({ asset, isCounterpart, legs }) => (
        <option
          key={asset}
          value={asset}
          disabled={isCounterpart}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {ZPH_UI_TICKER[asset]}
          {balanceFor ? ` · ${balanceFor(asset)}` : ""}
          {isCounterpart
            ? " (other side)"
            : legs > 1
              ? ` · ${legs} tx`
              : ""}
        </option>
      ))}
    </select>
  );
}
