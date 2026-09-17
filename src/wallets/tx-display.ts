/**
 * What a history row (or a Send modal) says it moves, and what that is worth.
 *
 * # Why this exists (2026-09-15)
 *
 * Zephyr holds four assets at one address, and `zph-wallet.ts` already copies
 * each transfer's `asset_type` into `ChainTx.meta`. Every renderer ignored it
 * and printed `getAdapter(tx.chain).ticker`, so a 25 ZEPHUSD receipt read
 * "+25 ZEPH", and the landscape Activity tab valued it at ZEPH's price.
 *
 * The renderers (portrait Activity, landscape Activity and its table, the
 * per-chain `ChainTxCard`, the landscape wallet "Recent" list) and both Send
 * modal mounts now ask here. No `getAdapter` import, so this stays cheap to
 * import and to test: callers pass the adapter ticker they already hold.
 */
import type { ChainTx, ChainType } from "./types";
import { ZPH_UI_TICKER, type ZphAssetType } from "./zph-rpc";
import { zphAssetPrice, type ZphLiveStats } from "./zph-scanner-api";

function isZphAsset(a: unknown): a is ZphAssetType {
  return a === "ZPH" || a === "ZSD" || a === "ZRS" || a === "ZYS";
}

/** The Zephyr asset a row moved, when it is a Zephyr row that says which. */
export function zphTxAsset(tx: ChainTx): ZphAssetType | null {
  if (tx.chain !== "zephyr") return null;
  const a = tx.meta?.asset_type;
  return isZphAsset(a) ? a : null;
}

/** The ticker to print beside a row's amount (and to draw its icon with). */
export function txDisplayTicker(tx: ChainTx, adapterTicker: string): string {
  const asset = zphTxAsset(tx);
  return asset ? ZPH_UI_TICKER[asset] : adapterTicker;
}

/**
 * USD per unit of a row's amount, or `null` when there is no honest number.
 *
 * ZEPHUSD / ZEPHRSV / ZEPHYRS rows are priced from the protocol oracle when
 * `zphStats` is supplied, and otherwise have NO price. They are never priced
 * from `pricesByTicker[adapterTicker]`, which for a Zephyr row is ZEPH's.
 */
export function txUsdPrice(
  tx: ChainTx,
  adapterTicker: string,
  pricesByTicker: Record<string, number>,
  zphStats?: ZphLiveStats | null,
): number | null {
  const asset = zphTxAsset(tx);
  if (asset && asset !== "ZPH") {
    const p = zphAssetPrice(zphStats ?? null, asset);
    return p != null && p > 0 ? p : null;
  }
  const p = pricesByTicker[adapterTicker.toUpperCase()];
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * The ticker a row's FEE is charged in, or `null` when the row cannot say.
 *
 * Zephyr charges a transfer's fee in the asset it sends (see the
 * `zph-wallet.ts` header). An outgoing row's `asset_type` is that asset, so its
 * fee takes the same ticker. An incoming row's fee was the sender's, in the
 * sender's source asset, which for a conversion is not the asset received
 * (wallet2.cpp:2799, 2915 at v2.3.0); it gets no ticker rather than a guess.
 * Every other chain keeps its adapter ticker.
 */
export function txFeeTicker(tx: ChainTx, adapterTicker: string): string | null {
  if (tx.chain !== "zephyr") return adapterTicker;
  if (tx.direction === "in") return null;
  const asset = zphTxAsset(tx);
  return asset ? ZPH_UI_TICKER[asset] : null;
}

/**
 * The ticker a Send modal prints for `assetType` on `chain`.
 *
 * Only Zephyr has a per-send asset today (ZSD/ZRS/ZYS reuse the ZEPH adapter).
 * An unrecognised Zephyr selector is printed verbatim rather than as "ZEPH":
 * the adapter refuses to send it, and the label must not claim otherwise.
 */
export function sendAssetTicker(
  chain: ChainType,
  adapterTicker: string,
  assetType: string | undefined,
): string {
  if (chain !== "zephyr" || assetType === undefined) return adapterTicker;
  return isZphAsset(assetType) ? ZPH_UI_TICKER[assetType] : assetType;
}

/**
 * Oracle USD price of a Zephyr ecosystem asset being sent, or undefined for
 * ZEPH itself (priced from `pricesByTicker` by the caller), other chains, or
 * missing stats.
 */
export function sendAssetUsdPrice(
  chain: ChainType,
  assetType: string | undefined,
  zphStats: ZphLiveStats | null | undefined,
): number | undefined {
  if (chain !== "zephyr" || !isZphAsset(assetType) || assetType === "ZPH") return undefined;
  const p = zphAssetPrice(zphStats ?? null, assetType);
  return p != null && p > 0 ? p : undefined;
}
