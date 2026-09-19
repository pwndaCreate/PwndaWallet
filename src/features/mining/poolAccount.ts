/**
 * src/features/mining/poolAccount.ts
 *
 * What the Mine tab says about the user's ACCOUNT at the pool they mine to:
 * unpaid balance, paid total, the payout threshold and how close they are to
 * it, each in coin and USD — or, when there is no number, why not.
 *
 * # Why this exists (2026-09-18)
 *
 * Operator report: "I see all the revenue estimate stuff but I cannot easily
 * find ... my current balance ... for any given pool that I am mining to."
 * The pool readers existed (`usePoolStats` → `fetch_pool_stats`) but only the
 * PRO console's `PoolStatsPanel` rendered them; SIMPLE's balance hero showed
 * the WALLET's XMR balance labelled "mined", and `—` for every other coin.
 * One view model, used by every Mine surface, so the surfaces cannot disagree
 * about what a pool owes.
 *
 * # Thresholds: the pool's minimum vs the account's own setting
 *
 * Some pools let a miner lower (or raise) their payout level on the pool's
 * website, and the advertised minimum is then NOT what that account is paid
 * at. Checked live, account by account, in the 2026-09-18 pool audit:
 *
 *   - `"account"` — the API reports the account's own level:
 *       HeroMiners (`stats.minPayoutLevel`, present once changed; absent means
 *       the pool minimum, which `get_miner_payout_level` confirmed), HashVault
 *       (`revenue.payoutThreshold`), Nanopool (`/usersettings/<addr>`).
 *   - `"pool-fixed"` — the pool offers no per-account level, so its minimum
 *       IS every account's level: pwnda (`get_miner_payout_level` not routed,
 *       and the site has no setting).
 *   - `"pool"` — custom levels exist but the API does not say which one an
 *       account has: WoolyPooly (a ZANO account paid ~0.50 against 0.25),
 *       K1Pool (`payoutThreshold` stays 3 while accounts are paid ~0.23 — it
 *       was wrongly treated as the account's level until this audit), NTMiner,
 *       Kryptex. The view says so.
 */
import type { ChainType } from "../../wallets";
import type { MinerStats, PoolStatsAdapter } from "./pool-stats";
import { atomicToNumber } from "./pool-stats/format";
import { parseMinPayoutValue, type PoolDef } from "./pools";

export type PoolAccountStatus =
  /** No reader for this pool's API (Kryptex, most NTMiner ports, …). */
  | "unsupported"
  /** No payout address for the coin, so there is no account to read. */
  | "no-address"
  /** The privacy gate: the address has not been sent to this pool yet. */
  | "needs-optin"
  | "loading"
  | "error"
  | "ok";

export interface PoolAccountView {
  status: PoolAccountStatus;
  poolName: string;
  ticker: string;
  /** Owed and payable at the next payout run. */
  unpaid: number | null;
  /** Credited but not yet confirmed (not every pool reports this). */
  immature: number | null;
  /** Lifetime paid out to the address (not every pool reports this). */
  paid: number | null;
  /** The payout level in coin units, or `null` when unknown. */
  threshold: number | null;
  /** Whose threshold it is — see the file header. */
  thresholdSource: ThresholdSource | null;
  /** `unpaid / threshold`, clamped to 0..1; `null` without both. */
  progress: number | null;
  unpaidUsd: number | null;
  paidUsd: number | null;
  /** H/s the pool currently credits to the address. */
  hashrate: number | null;
  /** Unix seconds of the last successful read. */
  fetchedAt: number | null;
  error: string | null;
  /** One line explaining an empty or partial account, or the threshold caveat. */
  note: string | null;
  /** The pool's own stats page, with the address filled in where the page supports it. */
  statsPageUrl: string | null;
}

export type ThresholdSource = "account" | "pool-fixed" | "pool";

/**
 * Pools whose API reports the ACCOUNT's own payout level (see header).
 * Nanopool's comes through `fetch_pool_min_payout` (what `displayMinPayout`
 * returns); HeroMiners' and HashVault's through the account stats.
 */
const ACCOUNT_LEVEL_THRESHOLD: readonly RegExp[] = [/^hashvault-/, /^herominers-/, /^nanopool-/];
/** Pools with no per-account level at all: the minimum applies to everyone. */
const FIXED_LEVEL_THRESHOLD: readonly RegExp[] = [/^pwnda-/];

export function poolReportsAccountThreshold(poolId: string): boolean {
  return ACCOUNT_LEVEL_THRESHOLD.some((re) => re.test(poolId));
}

export function thresholdSourceFor(poolId: string): ThresholdSource {
  if (poolReportsAccountThreshold(poolId)) return "account";
  if (FIXED_LEVEL_THRESHOLD.some((re) => re.test(poolId))) return "pool-fixed";
  return "pool";
}

function usd(amount: number | null, price: number | null): number | null {
  return amount != null && price != null ? amount * price : null;
}

export interface PoolAccountInput {
  coin: ChainType;
  ticker: string;
  pool: PoolDef | null;
  /** `displayMinPayout(pool)` — the live threshold with the static fallback. */
  minPayoutLabel: string | null;
  address: string | null;
  statsAdapter: PoolStatsAdapter | null;
  optedIn: boolean;
  stats: MinerStats | null;
  loading: boolean;
  error: string | null;
  priceUsd: number | null;
}

export function poolAccountView(i: PoolAccountInput): PoolAccountView {
  const poolName = i.pool?.name ?? "pool";
  const labelThreshold = i.minPayoutLabel ? parseMinPayoutValue(i.minPayoutLabel) : null;
  // pwnda.org's MY STATS page reads `?address=` (the site's own link shape),
  // and the pool already has this address from stratum, so it reveals nothing
  // new to that server.
  const statsPageUrl = i.pool?.statsPageUrl
    ? i.address
      ? `${i.pool.statsPageUrl}?address=${encodeURIComponent(i.address)}`
      : i.pool.statsPageUrl
    : null;

  const base: PoolAccountView = {
    status: "ok",
    poolName,
    ticker: i.ticker,
    unpaid: null,
    immature: null,
    paid: null,
    threshold: labelThreshold,
    thresholdSource: labelThreshold != null && i.pool ? thresholdSourceFor(i.pool.id) : null,
    progress: null,
    unpaidUsd: null,
    paidUsd: null,
    hashrate: null,
    fetchedAt: null,
    error: null,
    note: null,
    statsPageUrl,
  };

  if (!i.pool) return { ...base, status: "unsupported", note: "no pool selected" };
  if (!i.statsAdapter) {
    return {
      ...base,
      status: "unsupported",
      note: `this app can't read your balance at ${poolName} yet — check the pool's site`,
    };
  }
  if (!i.address) {
    return { ...base, status: "no-address", note: `no ${i.ticker} address in this wallet yet` };
  }
  if (!i.optedIn) {
    return {
      ...base,
      status: "needs-optin",
      note: `checking asks ${poolName} about your address — it already has it once you mine there`,
    };
  }
  if (!i.stats) {
    return i.error
      ? { ...base, status: "error", error: i.error, note: "couldn't reach the pool — retrying" }
      : { ...base, status: "loading" };
  }

  const s = i.stats;
  const unpaid = atomicToNumber(s.pendingBalance, i.coin);
  const immature = atomicToNumber(s.immatureBalance, i.coin);
  const paid = atomicToNumber(s.totalPaid, i.coin);
  // A threshold in the stats response beats the label only when the pool
  // reports the ACCOUNT's own level. pwnda XEL's stats carry the pool-wide
  // figure and K1Pool's is not the account's (see header), so those use the
  // label, which is the live pool-wide minimum.
  const statsThreshold =
    poolReportsAccountThreshold(i.pool.id) ? atomicToNumber(s.payoutThreshold, i.coin) : null;
  const threshold = statsThreshold ?? labelThreshold;
  const thresholdSource: PoolAccountView["thresholdSource"] =
    threshold == null ? null : thresholdSourceFor(i.pool.id);
  const progress =
    unpaid != null && threshold != null && threshold > 0 ? Math.min(1, Math.max(0, unpaid / threshold)) : null;

  let note: string | null = null;
  const nothingYet = (unpaid ?? 0) === 0 && (immature ?? 0) === 0 && (paid ?? 0) === 0;
  if (nothingYet && i.pool.id.startsWith("pwnda-")) {
    note = "nothing credited yet — pwnda pools pay PPLNS, so your share lands when the pool finds a block";
  } else if (nothingYet) {
    note = "nothing credited yet at this pool";
  } else if (thresholdSource === "pool") {
    note = "pool minimum shown — a lower payout level set on the pool's site is not in its API";
  }

  return {
    ...base,
    status: "ok",
    unpaid,
    immature,
    paid,
    threshold,
    thresholdSource,
    progress,
    unpaidUsd: usd(unpaid, i.priceUsd),
    paidUsd: usd(paid, i.priceUsd),
    hashrate: Number.isFinite(s.hashrate) ? s.hashrate : null,
    fetchedAt: s.fetchedAt || null,
    error: i.error,
    note,
  };
}
