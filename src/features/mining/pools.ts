import type { ChainType } from "../../wallets";
import type { CpuAlgorithm, GpuAlgorithm } from "../../types/mining";

/**
 * Mining pool registry.
 *
 * Each entry binds (coin, pool) to a stratum endpoint plus the username/password
 * conventions that pool expects. The Mining UI shows entries whose `coin`
 * matches the selected coin and whose `algorithm` matches the selected
 * hardware (CPU=randomx / GPU=kawpow|octopus). The user's wallet address for
 * the coin is substituted at launch time.
 *
 * Source data scraped 2026-04-25 — see
 * `PwndaWalletVault/wiki/concepts/mining-pool-commands.md` for citations.
 */

export type PoolId = string;
export type Algorithm = CpuAlgorithm | GpuAlgorithm;

/**
 * How the username field is built.
 *
 * - `address`            → just the wallet address
 * - `address.worker`     → `<address>.<worker>`   (most external pools)
 * - `prefix:addr.worker` → `<PREFIX>:<address>.<worker>`   (pwnda-pool style)
 */
export type UserFormat = "address" | "address.worker" | "prefix:addr.worker";

/**
 * What goes in the password field.
 *
 * - `worker`  → the worker name (HeroMiners style)
 * - `x`       → literal "x" (most pools accept anything)
 * - `coin`    → the coin ticker lower-cased (e.g. "xmr"/"rvn"/"cfx" — pwnda-pool style)
 */
export type PassFormat = "worker" | "x" | "coin";

export interface PoolDef {
  id: PoolId;
  /** Pool brand name shown in the dropdown */
  name: string;
  coin: ChainType;
  algorithm: Algorithm;
  /**
   * Full stratum URL ready for `-o` / `--pool`. SSL ports use `stratum+ssl://`,
   * plain TCP uses `stratum+tcp://` (or no scheme for xmrig — both work).
   */
  endpoint: string;
  /** True when `endpoint` is a TLS port. Drives xmrig `--tls` + SRBMiner `--tls-sni`. */
  ssl: boolean;
  userFormat: UserFormat;
  passFormat: PassFormat;
  /** Display string for min payout. */
  minPayout: string;
}

// `PWNDA_POOL` entries (stratum+ssl://*.pwnda.org:20871) were removed
// 2026-05-14 — the user dropped the in-house pwnda.org pool from the
// mineable list. Public pools (HashVault / HeroMiners / Ntminerpool /
// WoolyPooly / 2Miners / K1Pool) now own the default-selection slot for
// each coin via the natural `ALL_POOLS` ordering below. The
// `prefix:addr.worker` user-format and `coin` pass-format conventions
// that PWNDA_POOL exercised are still supported by `buildCredentials`
// for any future in-house pool re-add — no schema removed.

const MONERO_POOLS: PoolDef[] = [
  {
    id: "hashvault-monero",
    name: "HashVault.pro",
    coin: "monero",
    algorithm: "randomx",
    endpoint: "stratum+ssl://pool.hashvault.pro:443",
    ssl: true,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "0.001 XMR",
  },
  {
    id: "herominers-monero",
    name: "HeroMiners",
    coin: "monero",
    algorithm: "randomx",
    endpoint: "de.monero.herominers.com:1111",
    ssl: false,
    userFormat: "address",
    passFormat: "worker",
    minPayout: "0.01 XMR",
  },
  {
    // Ntminer's XMR pool oddly uses `miner.ntminer.vip` (not `xmr.ntminer.vip`).
    // SSL on 10788, plain TCP on 10799 — we ship SSL for consistency with the
    // existing zephyr ntminer entry. Verified 2026-04-28 from ntminerpool.com.
    id: "ntminerpool-monero",
    name: "Ntminerpool",
    coin: "monero",
    algorithm: "randomx",
    endpoint: "stratum+ssl://miner.ntminer.vip:10788",
    ssl: true,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "0.01 XMR",
  },
];

const ZEPHYR_POOLS: PoolDef[] = [
  {
    id: "hashvault-zephyr",
    name: "HashVault.pro",
    coin: "zephyr",
    algorithm: "randomx",
    endpoint: "stratum+ssl://pool.zephyr.hashvault.pro:443",
    ssl: true,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "0.01 ZEPH",
  },
  {
    // HeroMiners runs a Zephyr pool at zephyr.herominers.com — same
    // /api/stats schema as the other HeroMiners pools, so the existing
    // `HerominersPool` parser works as-is. Adds a 2nd live-share entry
    // for ZEPH so the panel isn't a one-pool list.
    id: "herominers-zephyr",
    name: "HeroMiners",
    coin: "zephyr",
    algorithm: "randomx",
    endpoint: "stratum+tcp://de.zephyr.herominers.com:1133",
    ssl: false,
    userFormat: "address",
    passFormat: "worker",
    minPayout: "0.1 ZEPH",
  },
  {
    id: "ntminerpool-zephyr",
    name: "Ntminerpool",
    coin: "zephyr",
    algorithm: "randomx",
    endpoint: "stratum+ssl://zeph.ntminer.vip:5688",
    ssl: true,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "0.1 ZEPH",
  },
  {
    // PwndaWallet's own Zephyr pool (added 2026-06-28). Pure ZEPH RandomX
    // (rx/0), no special addressing: `-u <ZEPH address> -p <worker>`, TLS
    // required. The wildcard host also answers on stratum.pwnda.org /
    // pool.pwnda.org; mine.pwnda.org is the canonical entry. No live-stats
    // adapter yet, so `PoolStatsPanel` hides for this pool (`getStatsAdapter`
    // → null); mining + the connectivity probe work normally. The Rust
    // backend connects to `stratum+ssl://*.pwnda.org:17706` generically (TLS
    // + SNI).
    //
    // PORT MIGRATION 2026-07-07: the stratum port moved 20871 → 17706. The
    // old port is fully closed (verified: TCP connect to *.pwnda.org:20871
    // times out on all four hostnames). 17706 verified live end-to-end —
    // TLS 1.3 handshake with a valid Let's Encrypt cert (CN=pwnda.org) and a
    // `login` for algo rx/0 returns `status:"OK"` plus a real job.
    //
    // `minPayout: "—"` (unknown) → the ascending-min-payout dropdown
    // sort (useMiner `availablePools`) lists it LAST among ZEPH pools, and it
    // is NOT the default (HashVault, lowest payout, keeps that slot). Supply a
    // real min payout to sort it in, or move this entry first to make it the
    // house default.
    id: "pwnda-zephyr",
    name: "Pwnda Pool",
    coin: "zephyr",
    algorithm: "randomx",
    endpoint: "stratum+ssl://mine.pwnda.org:17706",
    ssl: true,
    userFormat: "address",
    passFormat: "worker",
    minPayout: "—",
  },
];

const CONFLUX_POOLS: PoolDef[] = [
  {
    id: "herominers-conflux",
    name: "HeroMiners",
    coin: "conflux",
    algorithm: "octopus",
    endpoint: "stratum+tcp://de.conflux.herominers.com:1170",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "1 CFX",
  },
  {
    // Nanopool's CFX per-account default in their settings UI is
    // **100 CFX** (verified against the live dashboard 2026-05-12 — the
    // settings page pre-populates the minpayout input with 100 for new
    // accounts that haven't customised). Their marketing page advertises
    // "1 CFX minimum payout" which is the absolute floor (lowest the
    // pool will accept), not what new accounts get out of the box.
    //
    // The pool_payout fetcher pulls the user's actual configured
    // `minpayout` from `/v1/cfx/usersettings/<addr>` and overrides this
    // value once the user has submitted at least one valid share
    // (Nanopool's "no signup" model: account exists only after first
    // share). Until then, this static fallback matches what the user
    // sees in the Nanopool settings UI.
    id: "nanopool-conflux",
    name: "Nanopool",
    coin: "conflux",
    algorithm: "octopus",
    endpoint: "stratum+tcp://cfx-eu1.nanopool.org:10500",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "100 CFX",
  },
  {
    // Nanopool TLS endpoint — port 10543, confirmed from cfx.nanopool.org
    // 2026-05-12. Use this on networks that block plain stratum or when
    // the user wants encrypted upstream. Same per-account default as
    // the plain endpoint — Nanopool's threshold is account-wide, not
    // per-endpoint.
    id: "nanopool-conflux-ssl",
    name: "Nanopool (SSL)",
    coin: "conflux",
    algorithm: "octopus",
    endpoint: "stratum+ssl://cfx-eu1.nanopool.org:10543",
    ssl: true,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "100 CFX",
  },
  {
    // Nanopool US-East regional, plain. Some users in the Americas see
    // 80 – 120 ms lower stratum ping vs `cfx-eu1`.
    id: "nanopool-conflux-us",
    name: "Nanopool (US)",
    coin: "conflux",
    algorithm: "octopus",
    endpoint: "stratum+tcp://cfx-us-east1.nanopool.org:10500",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "100 CFX",
  },
  {
    id: "woolypooly-conflux",
    name: "WoolyPooly",
    coin: "conflux",
    algorithm: "octopus",
    endpoint: "stratum+tcp://pool.woolypooly.com:3094",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "1 CFX",
  },
  {
    // ntminer CFX: SSL on 25050, TCP on 26060. Note CFX pools generally
    // use lolMiner (Octopus algorithm) — proxy mode does not support
    // lolMiner so this pool is direct-connect only.
    // Verified 2026-04-28 from ntminerpool.com.
    id: "ntminerpool-conflux",
    name: "Ntminerpool",
    coin: "conflux",
    algorithm: "octopus",
    endpoint: "stratum+ssl://cfx.ntminer.vip:25050",
    ssl: true,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "100 CFX",
  },
  {
    // ntminer plain TCP for diagnostics. If the SSL endpoint succeeds
    // on TCP probe but a session still won't auth, swap to this to
    // rule out a corporate firewall doing TLS inspection.
    id: "ntminerpool-conflux-tcp",
    name: "Ntminerpool (TCP)",
    coin: "conflux",
    algorithm: "octopus",
    endpoint: "stratum+tcp://cfx.ntminer.vip:26060",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "100 CFX",
  },
];

/**
 * Ergo (ERG) pools. Autolykos v2 GPU mining via lolMiner (re-used from the
 * RVN/CFX path — no new binary download). Stratum dialect = StratumV1
 * (Ethereum-style mining.subscribe / mining.authorize / mining.submit), so
 * `dev_fee/protocol.rs::for_algo("autolykos")` correctly routes through the
 * existing dev-fee proxy machinery with zero new Rust code.
 *
 * Pool sources (verified upstream 2026-05-14):
 *   - 2Miners EU/US/Asia: erg.2miners.com:8888 / us-erg.2miners.com:8888 /
 *     asia-erg.2miners.com:8888 (SSL on +10000). Min payout 0.1 ERG.
 *   - HeroMiners EU: ergo.herominers.com:1140 (matches existing
 *     HerominersJson payout-stats parser via /api/stats). Min payout 0.1 ERG.
 *   - K1Pool EU: eu.erg.k1pool.com:3746. Min payout 2 ERG.
 *   - WoolyPooly EU: pool.woolypooly.com:3100 (confirmed via WoolyPooly
 *     "How to connect" screenshot 2026-05-14, all regions share port 3100).
 *
 * See `wiki/entities/Ergo.md` and `wiki/synthesis/ergo-integration-plan.md`.
 */
// Pool list rev 2026-05-15: dropped 2Miners (EU/US) and K1Pool, added
// Nanopool EU+US. Final set is HeroMiners + WoolyPooly + Nanopool per
// user direction. Ports verified upstream:
//   - HeroMiners ERG: `ergo.herominers.com:1140` (TCP) — cryptonote-
//     style /api/stats compatible.
//   - WoolyPooly ERG: `pool.woolypooly.com:3100` (TCP, PPLNS) —
//     confirmed via "How to connect" UI screenshot 2026-05-14.
//   - Nanopool ERG EU: `ergo-eu1.nanopool.org:11111` (TCP) — confirmed
//     via help.nanopool.org ERG pool docs + NBMiner reference command.
//   - Nanopool ERG US: `ergo-us-east1.nanopool.org:11111` follows the
//     same regional naming convention as CFX (cfx-us-east1.nanopool.org).
const ERGO_POOLS: PoolDef[] = [
  {
    id: "herominers-ergo",
    name: "HeroMiners",
    coin: "ergo",
    algorithm: "autolykos",
    // 2026-05-18 — port 1140 returns TCP RST (verified via PowerShell
    // Test-NetConnection sweep from this dev box, all of 1100/1102/.../1190
    // closed except 1180). HeroMiners' ERG mining endpoint is
    // de.ergo.herominers.com:1180 — confirmed by direct stratum subscribe
    // returning `{"id":1,"error":null,"result":[null,"198a",6]}`. Old
    // entry caused `pool_connect_timeout` events in every ERG session
    // through 2026-05-17 night. See PwndaWalletVault/log.md 2026-05-18
    // entry for the port-sweep evidence.
    endpoint: "stratum+tcp://de.ergo.herominers.com:1180",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "0.1 ERG",
  },
  {
    id: "woolypooly-ergo",
    name: "WoolyPooly",
    coin: "ergo",
    algorithm: "autolykos",
    endpoint: "stratum+tcp://pool.woolypooly.com:3100",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "0.5 ERG",
  },
  {
    // Nanopool EU. Per-account default is **0.1 ERG** floor (lowest
    // accepted); `pool_payout.rs::nanopool-ergo-eu` overrides this
    // with the user's configured `minpayout` value once they've
    // submitted at least one share (Nanopool's "no signup" model).
    id: "nanopool-ergo-eu",
    name: "Nanopool",
    coin: "ergo",
    algorithm: "autolykos",
    endpoint: "stratum+tcp://ergo-eu1.nanopool.org:11111",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "0.1 ERG",
  },
  {
    // Nanopool US-East regional. Same per-account default as the EU
    // endpoint — Nanopool's threshold is account-wide, not per-region.
    id: "nanopool-ergo-us",
    name: "Nanopool (US)",
    coin: "ergo",
    algorithm: "autolykos",
    endpoint: "stratum+tcp://ergo-us-east1.nanopool.org:11111",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "0.1 ERG",
  },
];

const RAVENCOIN_POOLS: PoolDef[] = [
  {
    id: "herominers-ravencoin",
    name: "HeroMiners",
    coin: "ravencoin",
    algorithm: "kawpow",
    endpoint: "stratum+tcp://de.ravencoin.herominers.com:1140",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "5 RVN",
  },
  {
    id: "woolypooly-ravencoin",
    name: "WoolyPooly",
    coin: "ravencoin",
    algorithm: "kawpow",
    // 2026-05-18 — corrected from `stratum+ssl://pool.woolypooly.com:16060` to
    // `stratum+tcp://pool.woolypooly.com:55555` after session
    // `dev-fee-20260518T080839Z-gpu.jsonl` showed 18 `pool_connect_timeout`
    // events against the old endpoint. PowerShell `Test-NetConnection` against
    // 16060/55557/3334/3335/4444 all returned False; only 55556 and 55555
    // were open. The pool's own "How to connect" UI (verified via screenshot
    // 2026-05-18) lists `pool.woolypooly.com:55555` as the canonical Raven
    // endpoint with SSL OFF by default — so the corrected entry uses plain
    // TCP. Both 55555 and 55556 respond to `mining.subscribe params:[]`
    // with valid V1 result envelopes (`result:[<session-id>,<extranonce>]`);
    // 55555 is the published port per the UI.
    endpoint: "stratum+tcp://pool.woolypooly.com:55555",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "5 RVN",
  },
  {
    // ntminer RVN: SSL on 21010, TCP on 22020. KawPow algorithm goes through
    // SRBMiner-MULTI which does support `--proxy`, so this pool is
    // proxy-mode-compatible.
    // Verified 2026-04-28 from ntminerpool.com.
    id: "ntminerpool-ravencoin",
    name: "Ntminerpool",
    coin: "ravencoin",
    algorithm: "kawpow",
    endpoint: "stratum+ssl://rvn.ntminer.vip:21010",
    ssl: true,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "10 RVN",
  },
];

/**
 * Zano — ProgPowZ on GPU, mined with SRBMiner-MULTI.
 *
 * Added 2026-08-28 when ZANO became a wallet asset. Endpoints read from the
 * pools' own pages the same day, not inferred:
 *
 *   - HeroMiners publishes `<region>.zano.herominers.com:1110` across 15
 *     regions (de/fr/es/fi/ru/ca/us/us2/us3/br/hk/kr/sg/tr/au); `de` is used
 *     for EU to match the ERG entry's convention. Minimum payout, verbatim
 *     from the page: "Minimum Payout: 0.2 ZANO". Pool fee 0.9%.
 *   - WoolyPooly publishes a single `pool.woolypooly.com:3146` for every
 *     region, minimum payout 0.25 ZANO, and names SRBMiner (AMD) and T-Rex
 *     (Nvidia) as the supported miners.
 *
 * Ports are NOT stratum-probe verified from this box the way the ERG ports
 * were after the 2026-05-18 incident — they are the operators' published
 * values. If a ZANO session reports `pool_connect_timeout`, run the same
 * port sweep that entry describes before assuming a client bug.
 */
const ZANO_POOLS: PoolDef[] = [
  {
    id: "herominers-zano",
    name: "HeroMiners",
    coin: "zano",
    algorithm: "progpowz",
    endpoint: "stratum+tcp://de.zano.herominers.com:1110",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "0.2 ZANO",
  },
  {
    id: "woolypooly-zano",
    name: "WoolyPooly",
    coin: "zano",
    algorithm: "progpowz",
    endpoint: "stratum+tcp://pool.woolypooly.com:3146",
    ssl: false,
    userFormat: "address.worker",
    passFormat: "x",
    minPayout: "0.25 ZANO",
  },
  {
    // PwndaWallet's own Zano pool, added 2026-08-29 alongside the house-default
    // policy in `HOUSE_DEFAULT_POOL` below. Same wildcard-cert host family as
    // `pwnda-zephyr` (*.pwnda.org, TLS + SNI on 17706); SRBMiner-MULTI's
    // `progpow_zano` algorithm name is what THAT binary calls it on its own
    // command line, but our internal id stays `progpowz` — the same id every
    // other Zano pool entry uses and the one `MINER_ALGO_ARGS.progpowz` in
    // `useMiner.ts` already maps to `{ miner: "SRBMiner-MULTI", algorithm:
    // "progpowz" }`. Renaming the internal id to match one vendor's flag
    // spelling would desync it from that map for zero benefit.
    //
    // Live-verified 2026-08-29: TLS 1.3 handshake to zano.pwnda.org:17706
    // (cert CN=pwnda.org, same wildcard as mine.pwnda.org) succeeds, and a
    // stratum `login` for algo `progpowz` returns a JSON-RPC response (an
    // "Invalid address used for login" error against a placeholder address —
    // i.e. the pool parsed and rejected the login for the right reason, not a
    // connection or protocol failure). No live-stats adapter, so
    // `PoolStatsPanel` hides for this pool exactly as it does for
    // `pwnda-zephyr`; mining + the connectivity probe work normally.
    id: "pwnda-zano",
    name: "Pwnda Pool",
    coin: "zano",
    algorithm: "progpowz",
    endpoint: "stratum+ssl://zano.pwnda.org:17706",
    ssl: true,
    userFormat: "address",
    passFormat: "worker",
    minPayout: "—",
  },
];

/**
 * House-preferred pool per coin, overriding the payout-sort / registry-order
 * default in {@link getDefaultPoolId}.
 *
 * Every OTHER default rule in this file is a proxy for "cheapest for the
 * user" — ascending min payout, or first-registered when payout is unknown.
 * That proxy is wrong for pwnda's own pools: `pwnda-zephyr` / `pwnda-zano`
 * report `minPayout: "—"` (no live-stats adapter, so no number to sort by,
 * not a comment on the pool being expensive), which sank BOTH to the bottom
 * of their coin's pool list. Simple mode — which shows exactly one dropdown
 * pre-filled with whatever `getDefaultPoolId` / `availablePools[0]` resolves
 * to — was therefore defaulting new users to HeroMiners on their first ZEPH
 * or ZANO session. Reported 2026-08-29.
 *
 * This is a POLICY override, not a fabricated payout number: it does not
 * touch `minPayout`, so the ascending-payout sort other pools rely on for
 * their own ordering stays honest. Add a coin here only when there is a
 * verified, live `stratum+ssl://*.pwnda.org:17706` endpoint for it — see the
 * live-verification note on each pwnda-* entry above.
 */
export const HOUSE_DEFAULT_POOL: Partial<Record<ChainType, PoolId>> = {
  zephyr: "pwnda-zephyr",
  zano: "pwnda-zano",
};

export const ALL_POOLS: PoolDef[] = [
  ...MONERO_POOLS,
  ...ZEPHYR_POOLS,
  ...CONFLUX_POOLS,
  ...RAVENCOIN_POOLS,
  ...ERGO_POOLS,
  ...ZANO_POOLS,
];

export function getPoolsForCoin(coin: ChainType, algorithm: Algorithm): PoolDef[] {
  return ALL_POOLS.filter((p) => p.coin === coin && p.algorithm === algorithm);
}

export function getPoolById(id: PoolId): PoolDef | undefined {
  return ALL_POOLS.find((p) => p.id === id);
}

/**
 * The default pool selection for a (coin, algorithm) pair — used both when
 * the user switches coin/hardware (`useMiner`'s `availablePools` effect) and
 * as the start-time fallback if nothing was explicitly selected. Both call
 * sites must agree, or the dropdown can show one pool while the miner starts
 * on another — see the `lastSelectedPoolByLaneRef` comment in `useMiner.ts`
 * for the landscape bug that exact disagreement caused once already.
 *
 * `HOUSE_DEFAULT_POOL` wins when the coin has one AND it is actually in this
 * lane's pool list (defensive — a coin/algorithm pairing with no matching
 * house entry must not return a dangling id). Otherwise: after PWNDA_POOL was
 * removed 2026-05-14 the default for each coin is the first public pool in
 * `ALL_POOLS` (HashVault for XMR, HeroMiners for RVN/CFX/ERG).
 */
/**
 * The house pool for this lane, if `HOUSE_DEFAULT_POOL` names one AND it is
 * actually registered for this (coin, algorithm) pair. `undefined` — never a
 * fallback to registry order — so callers that need to slot something ELSE
 * (like accumulated usage) between "no house policy" and "first registered
 * pool" can do so. See {@link resolveDefaultPool}.
 */
function houseDefaultPoolId(
  coin: ChainType,
  algorithm: Algorithm
): PoolId | undefined {
  const house = HOUSE_DEFAULT_POOL[coin];
  if (!house) return undefined;
  return getPoolsForCoin(coin, algorithm).some((p) => p.id === house)
    ? house
    : undefined;
}

export function getDefaultPoolId(
  coin: ChainType,
  algorithm: Algorithm
): PoolId | undefined {
  return (
    houseDefaultPoolId(coin, algorithm) ??
    getPoolsForCoin(coin, algorithm)[0]?.id
  );
}

/**
 * `useMiner`'s pool-selection priority chain, extracted so the order is a
 * named, unit-testable fact rather than four lines inline in a `useEffect`.
 *
 * **Corrected 2026-08-29.** The first version put `mostUsed` (persisted
 * click-frequency from `poolPrefs`, recorded on every successful start) AHEAD
 * of `houseDefault`. That shipped a house-default policy that could never
 * actually be seen by anyone who had ALREADY mined the coin — which is every
 * real installed wallet, not the fresh ones the fix was tested against. The
 * operator's own report after the first attempt: *"I still see hero miners as
 * default for pool for zano"* — on a wallet with real prior ZANO history, so
 * `mostUsed` was winning every time, exactly as this order predicts.
 *
 * `liveLanePool` and `remembered` stay ahead of `houseDefault` on purpose —
 * both are THIS-SESSION signals (an actually-running miner, or a pick the
 * user just made) and must never be silently overridden by a policy default.
 * `mostUsed` is stale history that predates any given policy change, so it
 * now sits BEHIND the house default: a coin with no house entry still uses
 * accumulated usage as its best signal, but ZEPH/ZANO's default is the house
 * pool until the user makes a fresh, in-session choice otherwise.
 */
export function resolveDefaultPool(opts: {
  coin: ChainType;
  algorithm: Algorithm;
  /** The pool a live session for this lane is actually running, if any. */
  liveLanePool: PoolId | null;
  /** The user's last explicit pick for this lane, THIS app session. */
  remembered: PoolId | null;
  /** Persisted most-used pool for this lane, from `poolPrefs`. */
  mostUsed: PoolId | null;
}): PoolId | null {
  return (
    opts.liveLanePool ??
    opts.remembered ??
    houseDefaultPoolId(opts.coin, opts.algorithm) ??
    opts.mostUsed ??
    getPoolsForCoin(opts.coin, opts.algorithm)[0]?.id ??
    null
  );
}

/** Render the host:port form of an endpoint for status displays. */
export function poolHostPort(endpoint: string): string {
  return endpoint.replace(/^stratum\+(ssl|tcp):\/\//, "");
}

/**
 * Parse the leading numeric value out of a pool's `minPayout` display
 * string (e.g. `"0.001 XMR"` → `0.001`, `"5 RVN"` → `5`). Returns
 * `null` for placeholder values like `"—"` so the sort can sink them
 * to the bottom of the list. Does not normalize across coins —
 * within a single (coin, algorithm) bucket every entry is already in
 * the same denomination.
 */
export function parseMinPayoutValue(label: string): number | null {
  if (!label) return null;
  const m = label.trim().match(/^([0-9]*\.?[0-9]+)/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Decorate a pool's display label with its connectivity-probe status.
 * Used by both portrait and landscape pool dropdowns so the markers
 * stay consistent.
 *
 * - `probe = undefined` — not tested yet, no badge.
 * - `probe = null` — probe in flight, "…" prefix.
 * - `probe.ok` — green ✓ with latency, plus `→ L2`/`→ L3` annotation
 *   when the success was reached via escalation rather than at L1.
 * - `probe.ok = false` — red ✗ with stage-specific reason.
 */
export function decoratePoolLabel(
  pool: PoolDef,
  probe:
    | { ok: boolean; latencyMs: number; stage: string; note?: string | null }
    | null
    | undefined,
): string {
  const baseName = `${pool.name} — ${poolHostPort(pool.endpoint)}`;
  if (probe === undefined) return baseName;
  if (probe === null) return `… ${baseName}`;
  if (probe.ok) {
    // 2026-05-23 — note is populated when probe recovered via escalation.
    // Surface a subtle "→ L2" / "→ L3" so the user can distinguish a
    // clean L1 pass from a transient flake that needed retry.
    const tier = probe.note?.includes("L3")
      ? " → L3"
      : probe.note?.includes("L2")
        ? " → L2"
        : "";
    return `✓ ${probe.latencyMs}ms${tier} · ${baseName}`;
  }
  const reason =
    probe.stage === "tcp" ? "blocked" :
    probe.stage === "tls" ? "tls fail" :
    probe.stage === "dns" ? "dns fail" :
    probe.stage === "config" ? "config gap" :
    probe.stage === "stratum" ? "no reply" :
    probe.stage === "authorize" ? "auth fail" :
    probe.stage === "notify-wait" ? "no jobs" :
    "unreachable";
  return `✗ ${reason} · ${baseName}`;
}

/**
 * Build the username + password to send to the pool, given the pool config,
 * the user's wallet address, the worker name, and the coin's mining-prefix
 * (the `prefix:addr.worker` format is reserved for any future in-house
 * pool re-add; PWNDA_POOL was removed 2026-05-14 but the formatter stays).
 */
export function buildCredentials(opts: {
  pool: PoolDef;
  address: string;
  worker: string;
  coinPrefix: string;
}): { user: string; pass: string } {
  const worker = opts.worker.trim() || "worker1";
  let user: string;
  switch (opts.pool.userFormat) {
    case "address":
      user = opts.address;
      break;
    case "address.worker":
      user = `${opts.address}.${worker}`;
      break;
    case "prefix:addr.worker":
      user = `${opts.coinPrefix}:${opts.address}.${worker}`;
      break;
  }

  let pass: string;
  switch (opts.pool.passFormat) {
    case "worker":
      pass = worker;
      break;
    case "x":
      pass = "x";
      break;
    case "coin":
      pass = opts.coinPrefix.toLowerCase();
      break;
  }

  return { user, pass };
}
