/**
 * Turning a flat roster of asset keys into the rows the coin picker draws.
 *
 * # Why the roster is not the list
 *
 * Since 2026-09-09 the NEAR-Intents roster carries one key per (symbol,
 * network) — `USDC-ARB`, `USDT0-POL` — because `AssetCapability` holds a
 * single `chainId` / `walletsByChainKey` / `nearIntentsAsset` and cannot
 * describe eight networks at once. Rendering that roster verbatim would put
 * fifteen stablecoin rows in a dropdown that previously had fourteen entries
 * total, and would ask the user to read `USDC-BSC` and know what it means.
 *
 * The wallet already answered this for its assets rail: *"Each (symbol,
 * network) pair is its own chain … the ASSETS RAIL groups them back into one
 * row per symbol"* (`wallets/types.ts`). The rail renders **USDC · 1 of 8
 * networks ▸**. This module is the same idea for the swap picker, so the two
 * surfaces describe the same money the same way.
 *
 * # Why the network cannot be dropped
 *
 * USDC on Arbitrum and USDC on Base are different tokens on different chains
 * with different contracts. They are worth the same and are not the same
 * thing: a swap quotes, routes and settles against ONE of them, and picking
 * the wrong network is how a user sends funds somewhere they cannot easily
 * retrieve them. So a grouped row is a way to CHOOSE a network, never a way
 * to avoid choosing one — every selection resolves to exactly one leg key.
 */
import { ASSET_CAPABILITIES } from "./asset-capabilities";

/**
 * Symbols that GROUP under another symbol in the picker.
 *
 * `USDT0` is Tether's LayerZero OFT, and it is what Arbitrum's and Polygon's
 * USDT actually migrated to — the wallet's own registry says so: *"Arbitrum's
 * and Polygon's USDT both migrated to it, so these are the same money the old
 * USDT rows held"* (`wallets/types.ts`). 1Click agrees, listing both
 * contracts under the symbol `USDT`.
 *
 * Left ungrouped it became its own row, which reads as a third stablecoin and
 * sets a trap: somebody looking for USDT on Arbitrum opens `USDT`, sees five
 * networks without it, and concludes the wallet cannot do it. So it groups —
 * and the per-network row below still SAYS `USD₮0`, because grouping is for
 * findability and must not hide which token is about to be swapped.
 */
const GROUPS_UNDER: Readonly<Record<string, string>> = {
  USDT0: "USDT",
};

/** The symbol a leg is FILED under in the picker (not what it is called). */
function groupSymbolFor(ticker: string): string {
  const s = ticker.toUpperCase();
  return GROUPS_UNDER[s] ?? s;
}

/** One row in the dropdown. */
export interface PickerRow {
  /** The symbol shown on the row: `BTC`, `USDC`. */
  symbol: string;
  /**
   * The leg keys this row stands for, in roster order.
   *
   * Length 1 for an ordinary coin — the row IS the asset and picking it
   * selects `legs[0]`. Length > 1 for a multi-network symbol, where the row
   * expands and the user picks among {@link networks}.
   */
  legs: string[];
  /** Per-leg display data, index-aligned with {@link legs}. */
  networks: Array<{ key: string; network: string }>;
}

/**
 * Group a roster into picker rows, preserving the roster's own ordering.
 *
 * Order is the caller's business (`getDropdownTickers` already sorts by
 * `assetRank`, stablecoins last); this only groups. A symbol's row appears
 * at the position of its FIRST leg, so the sort is not silently rearranged.
 */
export function pickerRows(roster: readonly string[]): PickerRow[] {
  const bySymbol = new Map<string, PickerRow>();
  const order: string[] = [];

  for (const key of roster) {
    const cap = ASSET_CAPABILITIES[key.toUpperCase()];
    // A key with no registry entry is shown as-is rather than dropped: the
    // roster and the registry are supposed to agree, and quietly hiding a
    // disagreement is what let LTC sit unroutable for three months.
    const trueSymbol = (cap?.ticker ?? key).toUpperCase();
    const symbol = groupSymbolFor(trueSymbol);
    // When a leg files under a different symbol than it trades as, the
    // network row has to say both, or the choice hides which token it is.
    const network =
      trueSymbol === symbol
        ? (cap?.network ?? "")
        : `${cap?.network ?? ""} · ${cap?.ticker ?? trueSymbol}`;

    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, { symbol, legs: [], networks: [] });
      order.push(symbol);
    }
    const row = bySymbol.get(symbol)!;
    row.legs.push(key);
    row.networks.push({ key, network });
  }

  return order.map((s) => bySymbol.get(s)!);
}

/** Does this row need a network choice, or is it one asset? */
export function isGrouped(row: PickerRow): boolean {
  return row.legs.length > 1;
}

/**
 * The network label for a leg key, for the closed button and the amount row.
 *
 * Empty string when the key is not a leg (an ordinary coin like BTC, whose
 * network name would just repeat the symbol). Callers render it as a chip
 * only when non-empty.
 */
export function networkLabelFor(key: string): string {
  const cap = ASSET_CAPABILITIES[key.toUpperCase()];
  if (!cap) return "";
  // An asset whose key IS its symbol is a native coin; "BTC on Bitcoin" is
  // noise. Only the per-leg keys earn a chip.
  if (cap.ticker.toUpperCase() === key.toUpperCase()) return "";
  const trueSymbol = cap.ticker.toUpperCase();
  return trueSymbol === groupSymbolFor(trueSymbol)
    ? cap.network
    : `${cap.network} · ${cap.ticker}`;
}

/** The symbol a key trades as — `USDC-ARB` → `USDC`, `BTC` → `BTC`. */
export function symbolFor(key: string): string {
  const trueSymbol = (
    ASSET_CAPABILITIES[key.toUpperCase()]?.ticker ?? key
  ).toUpperCase();
  return groupSymbolFor(trueSymbol);
}
