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
import { stablecoinLegLabel } from "../../wallets/stablecoins";

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
 *
 * Since 2026-10-06 (operator request 2026-10-01) it says it as a small NOTE
 * beside the network ("Arbitrum" + "USD₮0"), the way the wallet's rows do,
 * rather than in the network's name ("Arbitrum · USDT0"). On Optimism the
 * note is the whole difference between two USDT rows: the bridged USDT and
 * USD₮0 are different tokens there.
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
  /**
   * Per-leg display data, index-aligned with {@link legs}. `note` is the
   * token's own name when it files under another symbol ("USD₮0"), drawn
   * small beside the network; absent otherwise.
   */
  networks: Array<{ key: string; network: string; note?: string }>;
}

/**
 * The note a leg carries in the picker: the wallet's own (`stablecoinLegLabel`,
 * "USD₮0" with the ₮), else the registry ticker when the leg files under a
 * symbol it does not trade as.
 */
function noteFor(key: string): string | undefined {
  const cap = ASSET_CAPABILITIES[key.toUpperCase()];
  if (!cap) return undefined;
  const trueSymbol = cap.ticker.toUpperCase();
  if (trueSymbol === groupSymbolFor(trueSymbol)) return undefined;
  const wallet = cap.walletsByChainKey ? stablecoinLegLabel(cap.walletsByChainKey) : undefined;
  return wallet?.note ?? cap.ticker;
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
    // network row has to say both, or the choice hides which token it is —
    // the network as the row's name, the token's own name as its note.
    const network = cap?.network ?? "";
    const note = noteFor(key);

    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, { symbol, legs: [], networks: [] });
      order.push(symbol);
    }
    const row = bySymbol.get(symbol)!;
    row.legs.push(key);
    row.networks.push(note ? { key, network, note } : { key, network });
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
 * only when non-empty — a chip is already the small print, so a leg's note
 * rides in it: "Arbitrum · USD₮0" (the wallet's spelling since 2026-10-06; it
 * was the registry's "USDT0").
 */
export function networkLabelFor(key: string): string {
  const cap = ASSET_CAPABILITIES[key.toUpperCase()];
  if (!cap) return "";
  // An asset whose key IS its symbol is a native coin; "BTC on Bitcoin" is
  // noise. Only the per-leg keys earn a chip.
  if (cap.ticker.toUpperCase() === key.toUpperCase()) return "";
  const note = noteFor(key);
  return note ? `${cap.network} · ${note}` : cap.network;
}

/** The symbol a key trades as — `USDC-ARB` → `USDC`, `BTC` → `BTC`. */
export function symbolFor(key: string): string {
  const trueSymbol = (
    ASSET_CAPABILITIES[key.toUpperCase()]?.ticker ?? key
  ).toUpperCase();
  return groupSymbolFor(trueSymbol);
}

/**
 * A key as a sentence names it, where there is no room for a chip:
 * `USDT0-ARB` → "USDT (Arbitrum · USD₮0)", `USDC-ARB` → "USDC (Arbitrum)",
 * `BTC` → "BTC" — the wallet's own spelling of a leg (its `displayName`).
 *
 * 2026-10-06 (operator request 2026-10-01): the minimum hint and the confirm
 * screen printed the registry key, so a USD₮0 leg still read "USDT0-ARB"
 * after the picker stopped calling it that, and Optimism's two USDT legs
 * differed only by a "0" in "USDT-OP" / "USDT0-OP".
 */
export function legDisplayName(key: string): string {
  const network = networkLabelFor(key);
  return network ? `${symbolFor(key)} (${network})` : symbolFor(key);
}
