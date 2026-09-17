/**
 * The decisions both wallet layouts make, made once.
 *
 * # Why this file exists
 *
 * Portrait (`DashboardView`) and landscape (`WalletLandscapeView`) are separate
 * component trees. Every rule below used to be written twice, and on
 * 2026-09-16 a portrait-vs-landscape parity audit found each pair had drifted:
 *
 *  - Send: landscape disabled it for an unsynced Monero, Zephyr or Xelis
 *    wallet; portrait gated Monero only, so an unsynced Xelis or Zephyr wallet
 *    could open Send in portrait.
 *  - History: portrait shows one dedicated card for Monero, Zano and Xelis;
 *    landscape showed that card AND the generic "Recent" list for Zano and
 *    Xelis, so their history appeared twice.
 *  - Asset list: landscape listed not-yet-imported independent-seed chains
 *    from the adapter flag; portrait kept a hand list of always-shown tickers,
 *    the list that left Zano unreachable on 2026-08-28.
 *  - Zero balance: landscape said "$0.00", portrait said "—" (which elsewhere
 *    means "unknown").
 *
 * A rule that lives here cannot differ between the layouts, because there is
 * only one of it. `layout-parity.test.ts` asserts both views call these.
 */
import { ALL_CHAINS, getAdapter } from "../../wallets";
import type { ChainType, WalletInfo } from "../../wallets";
import { ZPH_UI_TICKER, type ZphAssetType } from "../../wallets/zph-rpc";
// Through swap's public barrel, not `../swap/asset-capabilities`: that file is
// private to the swap folder (BOUNDARIES.md), the same rule `activity` follows.
import { ASSET_CAPABILITIES } from "../swap";

/* ── Amounts ─────────────────────────────────────────────────────────── */

/** A balance string as a number, or null when it is not one. */
export function parseBalanceNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * USD value of a balance, or null when either side is unknown.
 *
 * `0` is a real answer: a balance the chain reported as zero, at a known
 * price. Null means we cannot say. The two render differently
 * ({@link formatAssetUsd}); collapsing them is the portrait bug this replaced.
 */
export function assetUsdValue(
  raw: string | undefined | null,
  price: number | null | undefined,
): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  const n = parseBalanceNumber(raw);
  if (n == null) return null;
  return n * price;
}

/** `price` for a ticker from the app's uppercase price map, or null. */
export function priceFor(
  ticker: string,
  pricesByTicker: Record<string, number>,
): number | null {
  const p = pricesByTicker[ticker.toUpperCase()];
  return p != null && Number.isFinite(p) ? p : null;
}

/** "—" for an unknown value; dollars otherwise, cents below $1000. */
export function formatAssetUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd >= 1000) {
    return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * A unit price. Same as {@link formatAssetUsd} from $1 up; below that, four
 * significant figures, because a $0.0031 coin rounded to cents reads "$0.00" —
 * a price of zero, which is a claim, not a rounding.
 */
export function formatAssetPrice(price: number | null | undefined): string {
  if (price == null || !Number.isFinite(price)) return "—";
  if (price >= 1 || price <= 0) return formatAssetUsd(price);
  const decimals = Math.min(10, Math.max(2, 3 - Math.floor(Math.log10(price))));
  let s = price.toFixed(decimals).replace(/0+$/, "");
  const dot = s.indexOf(".");
  if (s.length - dot - 1 < 2) s = s.padEnd(dot + 3, "0");
  return `$${s}`;
}

/**
 * A balance for display: "—" when unknown, trailing zeros trimmed otherwise.
 * A string that is not a number (Hedera's "No account (create on network)")
 * is shown as it is — it is a statement from the chain, not a failed read.
 */
export function formatAssetBalance(raw: string | undefined | null): string {
  if (!raw || raw === "--" || raw === "—") return "—";
  const n = parseBalanceNumber(raw);
  if (n == null) return raw;
  if (n === 0) return "0";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/* ── Which chains the asset list shows ───────────────────────────────── */

/**
 * Independent-seed chains (XMR / ZEPH / ZANO / XEL) with no wallet yet.
 *
 * These are the only entry point to their import panels, which gate on
 * `activeChain === <chain>`: a chain that is not listed can never become
 * active, so its panel is unreachable. Keyed on the adapter's
 * `usesIndependentSeed` rather than on chain names, so a chain added later is
 * listed the moment its adapter says so.
 *
 * Presentation only. Never counted in a total, a sparkline or the vault's
 * wallet count — the wallet does not exist.
 */
export function importableChains(
  walletsByChain: Partial<Record<ChainType, WalletInfo>>,
): ChainType[] {
  return (ALL_CHAINS as readonly ChainType[]).filter(
    (c) => !!getAdapter(c).usesIndependentSeed && !walletsByChain[c],
  );
}

/**
 * A held chain the collapsed portrait list must never hide.
 *
 * Replaces portrait's hand-kept `CANONICAL_DEFAULTS` ticker set. The chains
 * that list existed to keep reachable are exactly the independent-seed ones,
 * and the adapter already says which those are. Landscape never collapses, so
 * it shows every held chain regardless.
 */
export function isAlwaysListed(chain: ChainType): boolean {
  return !!getAdapter(chain).usesIndependentSeed;
}

/* ── History ─────────────────────────────────────────────────────────── */

/**
 * Where a chain's transaction history comes from, and so which block shows it.
 *
 * Monero, Zano and Xelis read history from their own wallet session and have
 * a dedicated card for it; everything else uses the generic per-address feed.
 * Landscape rendered the generic "Recent" list for Zano and Xelis as well as
 * their card, so the same transfers appeared twice (audit, 2026-09-16).
 *
 * `Record<…>` over the three names, so a fourth session-backed chain has to be
 * added here to get a card at all.
 */
export type HistorySurface = "monero" | "zano" | "xelis" | "generic";

const SESSION_HISTORY_CHAINS: Readonly<Record<Exclude<HistorySurface, "generic">, true>> = {
  monero: true,
  zano: true,
  xelis: true,
};

export function historySurfaceFor(chain: ChainType): HistorySurface {
  return Object.prototype.hasOwnProperty.call(SESSION_HISTORY_CHAINS, chain)
    ? (chain as Exclude<HistorySurface, "generic">)
    : "generic";
}

/** True when the chain's history is shown by its own card, not the generic list. */
export function hasDedicatedHistoryCard(chain: ChainType): boolean {
  return historySurfaceFor(chain) !== "generic";
}

/* ── Send / Receive / Swap ───────────────────────────────────────────── */

/**
 * Chains whose Send stays disabled until their own wallet session is ready:
 * every send goes through that chain's sidecar, and a send built before the
 * scan finishes spends from a balance the wallet has not finished reading.
 *
 * Zano joined on 2026-09-16. Its session has no height-based sync
 * (`useZanoSession.ts`: `syncState` is binary, `ready` once an authenticated
 * call succeeds), so its entry means "the wallet is open", and the reason
 * says so. Before, neither layout gated it, and Send on a Zano wallet whose
 * sidecar was still starting went straight to an RPC that was not there.
 */
export type SendSyncGatedChain = "monero" | "zephyr" | "zano" | "xelis";

const SEND_GATED: Readonly<Record<SendSyncGatedChain, "synced" | "open">> = {
  monero: "synced",
  zephyr: "synced",
  zano: "open",
  xelis: "synced",
};

function isSendSyncGated(chain: ChainType): chain is SendSyncGatedChain {
  return Object.prototype.hasOwnProperty.call(SEND_GATED, chain);
}

/**
 * Why Send is disabled for `chain`, or null when it is not.
 *
 * `ready` is a `Record` over every gated chain, so a caller that forgets one
 * is a type error rather than a layout that lets it through — which is how
 * portrait came to gate Monero alone.
 */
export function sendBlockedReason(
  chain: ChainType,
  ready: Record<SendSyncGatedChain, boolean>,
): string | null {
  if (!isSendSyncGated(chain)) return null;
  if (ready[chain]) return null;
  const name = getAdapter(chain).displayName;
  return SEND_GATED[chain] === "open"
    ? `Send unlocks once the ${name} wallet is open.`
    : `Send unlocks once the ${name} wallet has finished syncing.`;
}

/**
 * Why Receive is disabled, or null. A wallet can exist before its address is
 * known (Xelis when this build cannot derive it offline); copying "" does
 * nothing and looks as if it worked.
 */
export function receiveBlockedReason(address: string | null | undefined): string | null {
  return address ? null : "Receive unlocks once the wallet opens and reports its address.";
}

/**
 * Whether any swap venue can take this ticker.
 *
 * `ASSET_CAPABILITIES` is the swap feature's single registry of tradable
 * assets: the NEAR/SwapKit rosters filter through it, the desk derives from
 * it, and the P2P node's counterparty list documents that a ticker must be
 * added there first (`useSidecarSwap.ts`). A ticker with no entry has no
 * route anywhere, so the Swap tab could only open on a dead form.
 *
 * Matched on each entry's `ticker`, not its key: stablecoin legs are keyed
 * per network (`USDC-ARB`) while the wallet row says `USDC`.
 */
export function hasSwapVenue(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return Object.values(ASSET_CAPABILITIES).some((c) => c.ticker.toUpperCase() === t);
}

/**
 * The wallet chain a registry entry's asset lives on, or null.
 *
 * `walletsByChainKey` names where the entry's ADDRESS is stored, which is not
 * always the chain: every EVM native (ETH, AVAX, POL, BNB, FLR, MON) stores
 * its address under `"ethereum"`. So the key is trusted as the chain only when
 * that wallet's own coin is this ticker. Otherwise the asset belongs to the one
 * wallet chain whose coin is this ticker, and to none when two share it.
 */
function homeChainOf(ticker: string, walletKey: ChainType | undefined): ChainType | null {
  const t = ticker.toUpperCase();
  if (walletKey && getAdapter(walletKey).ticker.toUpperCase() === t) return walletKey;
  const owners = (ALL_CHAINS as readonly ChainType[]).filter(
    (c) => getAdapter(c).ticker.toUpperCase() === t,
  );
  return owners.length === 1 ? owners[0] : null;
}

let swapKeyByChain: Map<ChainType, string> | null = null;

/**
 * The swap registry key for THIS wallet chain's asset, or null when no entry
 * is that asset.
 *
 * The Swap tab is seeded with this key, and it is what decides whether Swap is
 * offered at all. Until 2026-09-16 both were done by ticker:
 *  - a USDC leg seeded the Swap tab with "USDC", which is no registry key (the
 *    legs are `USDC-ARB`, `USDC-ETH`, …), so the form opened on nothing;
 *  - Arbitrum, Base and Optimism ETH (ticker "ETH") passed the venue check on
 *    mainnet ETH's entry and seeded mainnet ETH, a different asset on a
 *    different network. The registry has no L2 ETH entry, so these now say so.
 */
export function swapAssetKeyFor(
  chain: ChainType,
  /** Landscape's focused Zephyr sub-asset row (ZSD / ZRS / ZYS), if any. */
  zephyrAsset?: ZphAssetType | null,
): string | null {
  // A focused Zephyr sub-asset is its own registry entry (ZEPHUSD, …). Send
  // already followed the focused row; Swap seeded ZEPH regardless.
  if (chain === "zephyr" && zephyrAsset && zephyrAsset !== "ZPH") {
    const key = ZPH_UI_TICKER[zephyrAsset];
    return Object.prototype.hasOwnProperty.call(ASSET_CAPABILITIES, key) ? key : null;
  }
  if (!swapKeyByChain) {
    const map = new Map<ChainType, string>();
    for (const [key, cap] of Object.entries(ASSET_CAPABILITIES)) {
      const home = homeChainOf(cap.ticker, cap.walletsByChainKey);
      if (!home) continue;
      const prev = map.get(home);
      // Prefer the entry keyed by the bare ticker (`ETH`) over any alias.
      if (!prev || key.toUpperCase() === cap.ticker.toUpperCase()) map.set(home, key);
    }
    swapKeyByChain = map;
  }
  return swapKeyByChain.get(chain) ?? null;
}

/** Why Swap is disabled for `chain`'s asset, or null. */
export function swapBlockedReason(
  chain: ChainType,
  canOpenSwap: boolean,
  zephyrAsset?: ZphAssetType | null,
): string | null {
  if (!canOpenSwap) return "Swap is not available from this screen.";
  if (swapAssetKeyFor(chain, zephyrAsset)) return null;
  const adapter = getAdapter(chain);
  const displayName = adapter.displayName;
  const ticker =
    chain === "zephyr" && zephyrAsset ? ZPH_UI_TICKER[zephyrAsset] : adapter.ticker;
  // A ticker some venue carries on ANOTHER network (L2 ETH): name the network,
  // or "No swap route carries ETH" would read as false.
  return hasSwapVenue(ticker)
    ? `No swap route carries ${ticker.toUpperCase()} on ${displayName} yet.`
    : `No swap route carries ${ticker.toUpperCase()} yet.`;
}

/**
 * The address the wallet is currently SHOWING for receipt, which is the one
 * Receive must copy.
 *
 * Monero shows a subaddress when the user picked one; UTXO chains show a
 * fresh, never-used address unless the user asked for the primary. Portrait's
 * Receive copied `wallet.address` regardless, so it handed out the reused
 * primary while the card beside it displayed the fresh one (audit,
 * 2026-09-16). Landscape already copied the displayed address.
 */
export function displayedReceiveAddress(args: {
  chain: ChainType;
  walletAddress: string;
  xmrReceiveAddress: string | null | undefined;
  /** Monero: true = show the primary `4…` address. */
  xmrShowPrimary: boolean;
  utxoReceiveAddress: string | null | undefined;
  /** UTXO: true = show the primary (index 0) address. */
  utxoShowPrimary: boolean;
}): string {
  const { chain, walletAddress } = args;
  if (chain === "monero") {
    return !args.xmrShowPrimary && args.xmrReceiveAddress
      ? args.xmrReceiveAddress
      : walletAddress;
  }
  return !args.utxoShowPrimary && args.utxoReceiveAddress
    ? args.utxoReceiveAddress
    : walletAddress;
}
