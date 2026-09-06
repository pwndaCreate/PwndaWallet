/**
 * C8's authority switch — the network half. Pairs with `sharedCoinBalance.ts`
 * (the pure merge logic); this is what actually goes and asks the engine.
 *
 * # Why this cannot simply call `fetchWallets()` unconditionally
 *
 * `/json/wallets` — the endpoint `fetchWallets()` reads — aggregates every
 * managed coin under ONE server-side timeout and answers `error: Timeout` for
 * ALL of them under IBD load (measured live: 10.0s — see
 * `useChainSync.ts`'s header for the incident this reproduces). The wallet
 * DASHBOARD calls this from `refreshBalance`/`refreshAllBalances`, which run
 * on ordinary navigation for every user — not just ones who opted into C8. A
 * slow or hung engine must never add a multi-second stall to the primary
 * balance refresh for the other 24+ chains that have nothing to do with the
 * swap sidecar.
 *
 * So this function:
 *
 * 1. First makes a CHEAP, LOCAL, no-network check
 *    (`swapSidecarCoinStatus` — disk reads only, see its own Rust-side
 *    comment) for whether any coin is actually verified-shared. For the
 *    overwhelming majority of users (opt-in is off, or on but no coin is
 *    shared) this resolves instantly and the function returns `[]` having
 *    touched the network not at all.
 * 2. Only THEN, and only for that narrow case, calls `fetchWallets()` — raced
 *    against {@link SHARED_BALANCE_TIMEOUT_MS} so a hung engine cannot block
 *    the caller past that bound.
 * 3. Never throws. Every failure mode (opt-in off, sidecar not running, the
 *    timeout, a malformed reply) resolves to `[]` or to entries with
 *    `balance: null` — the caller merges those as an honest "—", per
 *    `applySharedCoinBalances`'s documented invariant, rather than surfacing
 *    an error that would derail the surrounding chain's own balance fetch.
 */
import {
  swapSidecarCoinStatus,
  swapSidecarStatus,
  type BasicSwapWalletInfo,
} from "../../api/basicswap";
import {
  readSharedBalance,
  verifiedSharedTickers,
  type SharedCoinBalance,
} from "./sharedCoinBalance";
import { SHARED_COIN_CHAINS } from "./sharedCoinBalance";

/** How long the engine gets to answer before a shared coin renders "—"
 *  instead of blocking the caller. Short relative to the aggregate's own
 *  measured 10s IBD timeout on purpose: this path exists specifically so a
 *  stuck engine costs the dashboard a bounded, small delay, not the engine's
 *  own worst case. */
export const SHARED_BALANCE_TIMEOUT_MS = 4000;

/** Injectable seam — the transport tests replace. Defaults to the real API. */
export interface SharedBalanceDeps {
  coinStatus: typeof swapSidecarCoinStatus;
  sidecarStatus: typeof swapSidecarStatus;
  fetchWallets: () => Promise<
    Record<string, BasicSwapWalletInfo> | { error: string }
  >;
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  // Bare `setTimeout`, not `window.setTimeout`: this module is tested
  // directly under Node (no DOM), and the global is identical either way.
  return Promise.race([
    p,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
}

/**
 * Resolve this refresh's shared-coin overrides, or `[]` if none apply.
 *
 * Every failure path is swallowed and returns a value (never a rejection) —
 * this function is called from inside an existing balance-refresh flow that
 * has its own error handling for the CHAIN it is fetching, and a shared-coin
 * lookup failure must never surface as that chain's error.
 */
export async function fetchSharedCoinOverrides(
  deps: SharedBalanceDeps = {
    coinStatus: swapSidecarCoinStatus,
    sidecarStatus: swapSidecarStatus,
    fetchWallets: fetchWalletsDefault,
  },
): Promise<SharedCoinBalance[]> {
  let tickers: string[];
  try {
    const [status, statuses] = await Promise.all([
      deps.sidecarStatus(),
      deps.coinStatus(),
    ]);
    // The node must actually be running to ask it anything. A configured but
    // stopped node still reports `adoption === "accountkey"` from the LAST
    // verified push — asking it for a live balance would just be the timeout
    // path for no reason.
    if (!status.running) return [];
    tickers = verifiedSharedTickers(statuses);
  } catch {
    return [];
  }
  if (tickers.length === 0) return [];

  const raced = await raceTimeout(
    deps.fetchWallets().catch(() => ({ error: "unreachable" })),
    SHARED_BALANCE_TIMEOUT_MS,
  );
  const wallets =
    raced === "timeout" || "error" in raced ? null : (raced as Record<string, BasicSwapWalletInfo>);

  return tickers.map((ticker) => ({
    ticker,
    chain: SHARED_COIN_CHAINS[ticker],
    balance: readSharedBalance(wallets, ticker),
  }));
}

async function fetchWalletsDefault(): Promise<
  Record<string, BasicSwapWalletInfo> | { error: string }
> {
  const { fetchWallets, isApiError } = await import("../../api/basicswap");
  const v = await fetchWallets();
  return isApiError(v) ? { error: v.error } : v;
}
