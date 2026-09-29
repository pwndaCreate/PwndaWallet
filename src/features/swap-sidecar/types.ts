/**
 * Shared types + coin-identity helpers for the BasicSwap sidecar feature.
 *
 * This module is the feature's contract surface: the wire types come from
 * `src/api/basicswap.ts` and are re-exported here so feature code has one
 * import to reach for, and the identity helpers (name ↔ ticker ↔ decimals)
 * live here because *every* other module in the feature needs them and none of
 * them owns the mapping.
 *
 * ## The coin-identity problem, stated once
 *
 * Upstream speaks three names for the same coin and mixes them across
 * endpoints:
 *
 * | surface | value |
 * |---|---|
 * | `offers[].coin_from` / `bids[].coin_to` | display name — `"Monero"`, `"Particl Anon"` |
 * | `/json/coins[].ticker` | `"XMR"`, `"PART_ANON"` |
 * | `coin_from` **filter** on a POST body | int id **or** ticker |
 *
 * So a naive `offer.coin_from === "XMR"` never matches, and a naive
 * `prices[offer.coin_from]` never finds a USD price. Normalise through
 * {@link normalizeCoinKey} and resolve with {@link tickerForCoin} — and prefer
 * the live `/json/coins` table over the static fallback whenever it is loaded,
 * because the static table cannot know about a coin added upstream after this
 * file was written.
 *
 * ## Compliance note that constrains this feature's copy
 *
 * pwnda is never the counterparty. Any user-facing string produced anywhere in
 * this feature says the user is swapping with **another user on an open
 * network**. There is also NO endpoint exposing other users' bids or swaps, so
 * nothing here may derive or display fill rates, demand, or "N others viewing"
 * — the data does not exist and inventing it is a posture violation, not a
 * cosmetic one. See `CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` §3.
 */

export type {
  AmountRoundMethod,
  BasicSwapApiError,
  BasicSwapBidDetail,
  BasicSwapBidSummary,
  BasicSwapCoin,
  BasicSwapFeeEstimate,
  BasicSwapOffer,
  BasicSwapWalletBalance,
  BidQuery,
  BidStateHistoryRow,
  OfferQuery,
  OptInRecord,
  SidecarNetwork,
  SidecarPhase,
  SidecarPhaseName,
  SidecarProgress,
  SidecarStatus,
  SwapSidecarStartArgs,
} from "../../api/basicswap";

export {
  isApiError,
  phaseFailureReason,
  phaseName,
  SIDECAR_PROGRESS_EVENT,
} from "../../api/basicswap";

import type { BasicSwapCoin } from "../../api/basicswap";

// =========================================================================
// Coin identity
// =========================================================================

/**
 * Uppercase, punctuation-free key for a coin written any of upstream's ways.
 * `"Particl Anon"`, `"particl_anon"` and `"PART_ANON"` all collapse to
 * `"PARTANON"`.
 */
export function normalizeCoinKey(coin: string | null | undefined): string {
  if (!coin) return "";
  return coin.replace(/[\s_\-.]/g, "").toUpperCase();
}

/**
 * Static display-name → ticker fallback for the coins upstream ships, used
 * only when the live `/json/coins` table has not loaded yet. Deliberately not
 * the authority: a coin added upstream (or one of our own high-id additions —
 * ZEPH is planned) will be absent here and present there.
 */
export const COIN_NAME_TO_TICKER: Readonly<Record<string, string>> = {
  PARTICL: "PART",
  PARTICLANON: "PART_ANON",
  PARTICLBLIND: "PART_BLIND",
  BITCOIN: "BTC",
  LITECOIN: "LTC",
  LITECOINMWEB: "LTC_MWEB",
  DECRED: "DCR",
  NAMECOIN: "NMC",
  MONERO: "XMR",
  WOWNERO: "WOW",
  PIVX: "PIVX",
  DASH: "DASH",
  FIRO: "FIRO",
  NAVCOIN: "NAV",
  BITCOINCASH: "BCH",
  DOGECOIN: "DOGE",
  ZEPHYR: "ZEPH",
  ZANO: "ZANO",
};

/** Most chains are 8dp. The Monero family is not, and the gap is 4 orders. */
export const DEFAULT_COIN_DECIMALS = 8;

/**
 * Per-coin decimal places, keyed by {@link normalizeCoinKey} of either the
 * display name or the ticker. Matches upstream's `chainparams`
 * `decimal_places`; ZEPH follows Monero at 12. ZANO is also 12 — verified
 * against both `chainparams.py`'s `Coins.ZANO` entry (`decimal_places: 12`,
 * REU26) and the live wallet's own `asset_info.decimal_point` (see [[Zano]]
 * in the vault) — not a guess extrapolated from the CryptoNote family.
 */
export const COIN_DECIMALS: Readonly<Record<string, number>> = {
  XMR: 12,
  MONERO: 12,
  WOW: 11,
  WOWNERO: 11,
  ZEPH: 12,
  ZEPHYR: 12,
  ZANO: 12,
};

/**
 * The coin whose ENTIRE swap surface in this wallet is the BasicSwap
 * sidecar — no other in-wallet route exists for it at all. **XMR only.**
 *
 * This is a *narrower* question than "can this coin be the scriptless leg
 * of an `XMR_SWAP` bid" — see {@link SIDECAR_SCRIPTLESS_TICKERS} for that
 * one, which DOES include ZEPH and ZANO as of 2026-09-03. The two lists
 * exist for different questions and must not be conflated: this one is
 * "does the coin have anywhere ELSE to trade in this wallet" (ZEPH has its
 * own dedicated `ZephyrEcosystemSwapCard` swap surface; ZANO has its own
 * wallet panel — neither is "sidecar-only"), the other is "can BasicSwap's
 * `XMR_SWAP` protocol use this coin as the non-scripted leg at all" (now
 * true for all three CryptoNote-family coins Grove ships). See
 * `PwndaWalletVault/wiki/synthesis/grove-expansion-master-plan.md` § 1.
 *
 * History, preserved because the reasoning generalises: this constant was
 * named `["XMR", "ZEPH"]` until 2026-08-22, on the reasoning "the two coins
 * that exist on this route and nowhere else in the wallet" — true for XMR,
 * false for ZEPH, which was exactly backwards from what the name implied.
 * At the time ZEPH had its OWN dedicated swap surface (the Zephyr router
 * tab / `ZephyrEcosystemSwapCard`) AND `WALLET_SIDECAR_COINS`
 * (`swap_sidecar.rs`) — the backend's own list of coins the engine can ever
 * configure — had no Zephyr entry at all, so offering ZEPH here built a
 * quote screen for a book that could never exist, not merely one that was
 * empty. Found 2026-08-22 from the operator asking why ZEPH showed up on
 * the P2P coin picker at all. **What changed 2026-09-03:** the Grove
 * expansion plan's Phase B gave ZEPH and ZANO real BasicSwap chainclient
 * modules (patches 13-17) — the backend half of that 2026-08-22 finding no
 * longer holds — but this constant's OWN name still asks the "sidecar is
 * the only surface" question, which is still true for XMR alone, so it
 * stays `["XMR"]` rather than being widened again.
 */
export const SIDECAR_ONLY_TICKERS: readonly string[] = ["XMR"];

/**
 * Coins that can be the **scriptless** leg of a BasicSwap `XMR_SWAP` bid —
 * mirrors upstream's `scriptless_coins` tuple
 * (`chainparams.py`: `(Coins.XMR, Coins.WOW, Coins.ZEPH, Coins.ZANO)`; WOW
 * has no wallet adapter in this app at all, so it is omitted here rather
 * than listed and then silently unreachable everywhere else).
 *
 * ZEPH and ZANO joined this list 2026-09-03, once Grove's own BasicSwap
 * patches (13-17 — see `grove-expansion-master-plan.md`) gave both coins a
 * real chainclient; before that neither could be a scriptless leg on this
 * route AT ALL (see {@link SIDECAR_ONLY_TICKERS}'s history for the
 * 2026-08-22 finding that first drew this distinction).
 *
 * This list only answers "can the coin be the scriptless leg at all" — it
 * does NOT say every counterparty is legal opposite every scriptless coin.
 * `useSidecarSwap.ts`'s `basicswapLegsFor` narrows further: ZEPH/ZANO
 * ("followers", per the plan's own term) pair only with BTC, LTC and BCH,
 * never DOGE, DASH, XMR or each other — a strictly narrower set than XMR's
 * own counterparty list. See `grove-expansion-master-plan.md` § 1 "Standing
 * decisions": "Followers only: ZEPH/ZANO pair with BTC, LTC, BCH, PART.
 * Never XMR, each other, DOGE, DASH." (This wallet additionally omits PART
 * from the follower counterparty set — see `FOLLOWER_COUNTERPARTY_TICKERS`
 * in `useSidecarSwap.ts` for why.)
 */
export const SIDECAR_SCRIPTLESS_TICKERS: readonly string[] = [
  "XMR",
  "ZEPH",
  "ZANO",
];

/**
 * Resolve a coin (name, ticker, anything upstream printed) to its ticker.
 * Pass the live `/json/coins` table whenever it is loaded — it wins over the
 * static fallback. Returns `null` when nothing resolves, which callers must
 * render as "unknown", never as a guess.
 */
export function tickerForCoin(
  coin: string | null | undefined,
  coins?: readonly BasicSwapCoin[] | null,
): string | null {
  const key = normalizeCoinKey(coin);
  if (!key) return null;
  if (coins) {
    for (const c of coins) {
      if (normalizeCoinKey(c.ticker) === key) return c.ticker;
      if (normalizeCoinKey(c.name) === key) return c.ticker;
    }
  }
  if (COIN_NAME_TO_TICKER[key]) return COIN_NAME_TO_TICKER[key];
  // Already a ticker we have no name for (a newer upstream coin): accept it
  // rather than pretending we don't know it. Names are multi-word; tickers are
  // short and alphanumeric-with-underscore, which is what the normalised key
  // preserves.
  if (key.length <= 12 && /^[A-Z0-9]+$/.test(key)) return key;
  return null;
}

/**
 * Decimal places for a coin. Pass the live `/json/coins` table when loaded —
 * its `decimal_places` is authoritative and this function prefers it.
 *
 * Falling back to 8 for an unknown 12dp coin would make {@link snapDown}-style
 * rounding *lose* four orders of magnitude of the user's amount, so an unknown
 * coin is worth resolving through `/json/coins` rather than defaulting.
 */
export function decimalsForCoin(
  coin: string | null | undefined,
  coins?: readonly BasicSwapCoin[] | null,
): number {
  const key = normalizeCoinKey(coin);
  if (!key) return DEFAULT_COIN_DECIMALS;
  if (coins) {
    for (const c of coins) {
      if (
        normalizeCoinKey(c.ticker) === key ||
        normalizeCoinKey(c.name) === key
      ) {
        if (Number.isFinite(c.decimal_places) && c.decimal_places > 0) {
          return c.decimal_places;
        }
      }
    }
  }
  return COIN_DECIMALS[key] ?? DEFAULT_COIN_DECIMALS;
}

// =========================================================================
// Amount parsing
// =========================================================================

/**
 * Parse one of upstream's decimal amount strings. Returns `null` — never `0`
 * and never `NaN` — for anything unparseable, so a missing amount cannot be
 * mistaken for a zero amount downstream.
 */
export function parseAmount(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = v.trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Format a number back to a coin's own precision without exponent notation.
 * `toFixed` is used deliberately: `String(1e-7)` is `"1e-7"`, which upstream's
 * amount parser rejects.
 */
export function formatAmount(amount: number, decimals: number): string {
  if (!Number.isFinite(amount)) return "0";
  const d = Math.max(0, Math.min(20, Math.trunc(decimals)));
  const s = amount.toFixed(d);
  // Trim trailing zeros but keep at least one decimal digit's worth of shape.
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
