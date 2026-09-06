/**
 * src/features/swap-sidecar/nodeStrip.ts
 *
 * Pure derivations behind the Settings swap-node card's RUNNING strip.
 *
 * These lived inline in `SidecarStatusCard` until 2026-08-28, when the
 * operator reported two faults in one screenshot — a caught-up node stuck at
 * `PART 99%`, and coin dots that never lit no matter what was configured.
 * Both were derivation bugs with no test surface, so they are extracted here
 * as plain functions the way `spread.ts` and `bidStates.ts` already are.
 *
 * # The class of bug this module exists to prevent
 *
 * `SidecarStatus.coins` holds ENGINE COIN NAMES — lowercase `"bitcoin"`,
 * `"monero"`, `"particl"`, straight from `basicswap.json`'s chainclients keys.
 * It does NOT hold tickers. Every comparison against `"BTC"`/`"XMR"` is
 * therefore false, permanently, and it fails *silently*: the UI renders, the
 * types check, and every dot is simply off forever. Route the names through
 * {@link configuredTickersFrom} and the mistake becomes unavailable.
 */
import type { ChainSync, CoinEnableStatus } from "../../api/basicswap";
import { tickerForCoin } from "./types";

/**
 * What the PART cell should read.
 *
 * # Why block heights decide, and the percentage does not
 *
 * `verifiedPct` is `100 * verificationprogress`, and `verificationprogress`
 * approaches 1.0 asymptotically — a fully-synced daemon reports 0.9999982,
 * not 1. `Math.floor` turns that into **99**, forever, on a node that is
 * genuinely caught up and serving a complete order book. That was the reported
 * fault: the operator could see live offers in the BasicSwap console while
 * this cell insisted the chain was still syncing.
 *
 * `ChainSync`'s own doc-comment states the rule in one line — *"Use WITH
 * blocks — a chain with no blocks reports 100% verified"* — and the original
 * code read the percentage without the blocks. So `blocks >= headers` is the
 * authority here and the percentage is only a progress readout while they
 * disagree.
 *
 * The `Math.min(99, …)` clamp is the same asymptote running the other way:
 * during late IBD a daemon can report 100.0% with blocks still behind. Showing
 * "100%" while not synced would have the cell contradict itself, so 100 means
 * caught up and nothing else.
 */
export function partSyncReading(chain: ChainSync | null | undefined): {
  /** Whole percent for display, or `null` when the chain has not reported. */
  pct: number | null;
  /** The claim the card is allowed to make. */
  synced: boolean;
} {
  if (!chain) return { pct: null, synced: false };
  const synced = chain.headers > 0 && chain.blocks >= chain.headers;
  const pct = synced
    ? 100
    : Math.min(99, Math.max(0, Math.floor(chain.verifiedPct)));
  return { pct, synced };
}

/**
 * Engine coin NAMES → the set of UPPERCASE tickers they mean.
 *
 * Unknown names are dropped rather than guessed: `tickerForCoin` already
 * falls back to the static table and then to "it is already a ticker", so a
 * `null` from it means genuinely unrecognised, and a strip cell that lights up
 * for a coin nobody can identify is worse than one that stays dark.
 */
export function configuredTickersFrom(
  coins: readonly string[] | null | undefined,
): Set<string> {
  return new Set(
    (coins ?? [])
      .map((c) => tickerForCoin(c))
      .filter((t): t is string => !!t)
      .map((t) => t.toUpperCase()),
  );
}

/**
 * The read-only DEX tiles, from the authoritative per-coin status array.
 *
 * Derived from the SAME `CoinEnableStatus[]` the DEX COINS section below the
 * card renders, because on 2026-08-28 the card read a hardcoded five-ticker
 * list against `status.coins` and displayed `DEX COINS · 0 OF 5 ON` directly
 * above a section reading `DEX COINS · 4 OF 7 ENABLED`. Two sources, two
 * answers, and no way for the operator to tell which one was lying.
 *
 * `binaryPresent` filters rather than dims: a coin with no daemon binary can
 * never be configured no matter what the user toggles, so it is not an "off"
 * tile — it is not an option, and offering it as one invites a click that
 * cannot work.
 */
export function dexTilesFrom(
  statuses: readonly CoinEnableStatus[] | null | undefined,
  /** Tickers the strip already reports, so they are not counted twice. */
  exclude: ReadonlySet<string>,
): Array<{ ticker: string; enabled: boolean }> {
  return (statuses ?? [])
    .filter((s) => !exclude.has(s.ticker.toUpperCase()))
    .filter((s) => s.binaryPresent)
    .map((s) => ({
      ticker: s.ticker.toUpperCase(),
      enabled: s.enabled === true,
    }));
}

/**
 * Coins the RUNNING strip reports itself, so the DEX tiles skip them.
 *
 * PART leads the strip because it carries the whole order book; XMR/ZEPH/ZANO
 * get dots. A coin rendered in both places is two counters for one fact.
 *
 * ZANO joined the strip on 2026-09-04 and was NOT added here the same day, so
 * the landscape Settings card showed a hollow `zano` dot in the strip AND a
 * filled ZANO tile directly under it — exactly the double-report this set
 * exists to prevent. Caught in the sandbox pass, not by a test: the strip
 * loop in `SidecarStatusCard.tsx` and this set were two lists for one fact.
 * Now there is one — `STRIP_DOT_TICKERS` is what the card loops over AND
 * what this set is built from — and `nodeStrip.test.ts` pins that the card
 * imports it rather than spelling its own.
 */
export const STRIP_DOT_TICKERS = ["XMR", "ZEPH", "ZANO"] as const;

export const STRIP_TICKERS: ReadonlySet<string> = new Set([
  "PART",
  ...STRIP_DOT_TICKERS,
]);
