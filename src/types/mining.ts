import type { ChainType } from "../wallets";

export type MiningHardware = "cpu" | "gpu";
export type CpuAlgorithm = "randomx";
export type GpuAlgorithm = "kawpow" | "octopus" | "autolykos" | "progpowz";
/**
 * CPU intensity (xmrig thread/priority control, see
 * `src/features/mining/utils/devicePower.ts::cpuThreadArgsForIntensity`).
 * `low` → 2 fixed threads + BelowNormal OS priority; `medium` → xmrig's
 * own `--cpu-max-threads-hint=50` cache/topology-aware autoconfig +
 * reduced priority; `high` → no thread cap, default priority (auto/all
 * threads). See `wiki/concepts/mining-process-management.md`.
 */
export type MiningIntensity = "low" | "medium" | "high";
/**
 * GPU intensity for SRBMiner-MULTI (`--gpu-intensity`). `auto` omits
 * the flag entirely so SRBMiner self-tunes; the three explicit tiers
 * map to numeric intensities in `useMiner.ts::gpuIntensityValue`. Only
 * meaningful on the SRBMiner branch (KawPow / Autolykos2); lolMiner
 * has no equivalent flag, so the value is silently dropped for Octopus.
 * See `wiki/concepts/srbminer-flags.md` §"--gpu-intensity".
 */
export type GpuIntensity = "auto" | "low" | "medium" | "high";

export interface MinerStatus {
  name: string;
  exists: boolean;
  path: string;
}

export interface DownloadProgress {
  miner: string;
  stage: string;
  percent: number;
  message: string;
}

// Sprint 2 — MSR environment scan result. Mirrors HashrateFixPlan in miners.rs.
export interface HashrateFixPlan {
  blocklistOff: boolean;
  sacOff: boolean;
  hvciOff: boolean;
  secureBootOff: boolean;
  seLockMemoryGranted: boolean;
  winring0Collision: string | null;
  collisionApps: string[];
  numaNodeCount: number;
  smtEnabled: boolean;
  physicalCoreCount: number;
  logicalCoreCount: number;
  scannedAt: number;
}

// Sprint 2 — Live xmrig.log parse status emitted by the Rust tail task.
export type MsrLogStatus =
  | { kind: "Ok"; preset: string }
  | { kind: "Failed"; reason: string; raw: string };

export interface HugePagesStatus {
  allocated: number;
  total: number;
}

export interface ReadyStatus {
  threadsActive: number;
  threadsTotal: number;
}

export interface HashrateFixStatus {
  msr?: MsrLogStatus | null;
  hugePages?: HugePagesStatus | null;
  ready?: ReadyStatus | null;
  rawLine?: string | null;
}

export const CHAIN_MINING_PREFIX: Record<ChainType, string> = {
  ethereum: "ETH",
  avalanche: "AVAX",
  "usdt-avax": "USDT",
  "usdt-eth": "USDT",
  "usdt-op": "USDT",
  "usdt-bsc": "USDT",
  "usdc-eth": "USDC",
  "usdc-arb": "USDC",
  "usdc-base": "USDC",
  "usdc-op": "USDC",
  "usdc-pol": "USDC",
  "usdc-avax": "USDC",
  "usdc-bsc": "USDC",
  "usdt0-arb": "USDT0",
  "usdt0-pol": "USDT0",
  "usdc-sol": "USDC",
  "usdt-sol": "USDT",
  "usdt-tron": "USDT",
  polygon: "POL",
  flare: "FLR",
  bitcoin: "BTC",
  solana: "SOL",
  xrp: "XRP",
  tron: "TRX",
  cardano: "ADA",
  monero: "XMR",
  zephyr: "ZEPH",
  dogecoin: "DOGE",
  ravencoin: "RVN",
  conflux: "CFX",
  hedera: "HBAR",
  algorand: "ALGO",
  litecoin: "LTC",
  "bitcoin-cash": "BCH",
  // 2026-05-08 multi-chain expansion: L2 + BSC + new chains.
  arbitrum: "ETH",
  base: "ETH",
  optimism: "ETH",
  bsc: "BNB",
  monad: "MON",
  dash: "DASH",
  stellar: "XLM",
  sui: "SUI",
  ergo: "ERG",
  near: "NEAR",
  aptos: "APT",
  zano: "ZANO",
};

/**
 * What mining needs to know about the convert route, and nothing more.
 *
 * # Why this is one number instead of an import
 *
 * The Mine tab's SIMPLE view shows the mined balance in a coin the user
 * chooses ("≈ 0.01893 ETH"), plus per-day/week/month in that same coin. That
 * requires the XMR→target rate the EARN pipeline would actually get — which is
 * swap-layer knowledge, sitting behind `useConvertPipeline`, `usd-prices` and
 * the P2P/NEAR fee model.
 *
 * `src/features/mining/**` is BANNED from importing `features/swap`,
 * `features/swap-sidecar` and `src/state` (see BOUNDARIES.md and
 * `scripts/check-boundaries.mjs`), because PwndaLite ships mining as a
 * standalone product and must not link the swap engine. So the rate is
 * INJECTED as a plain number, the same way `pricesByTicker` and
 * `addressFor(coin)` already are — mining multiplies, and stays ignorant of
 * routes, hops and fees.
 *
 * The type lives in `src/types/mining.ts` because that is one of the few paths
 * mining is allowed to import from, and the producer (`features/swap`) can
 * import it freely.
 *
 * In PwndaLite this is simply absent: the hero falls back to native XMR and
 * the EARN cross-promo does not render. That is not a degraded state — Lite
 * has no swap surface to promote.
 */
export interface MiningProjection {
  /** UPPERCASE ticker the user chose to be shown in, e.g. `"ETH"`. */
  targetTicker: string;
  /**
   * Target units per 1 XMR, **after** the convert pipeline's estimated fees.
   *
   * `null` means "not known yet" (prices still loading, or no price for the
   * target) and every consumer must render `—` rather than 0 — a zero here
   * would read as "your mining is worth nothing", which is a claim about the
   * user's money that nobody measured.
   */
  ratePerXmr: number | null;
  /** USD price of one XMR, for the `$61.42` sub-row. `null` when unknown. */
  xmrPriceUsd: number | null;
  /**
   * True when {@link targetTicker} came from the EARN pipeline's saved target
   * rather than a Mine-tab-local choice. Lets the cross-promo say "when you're
   * ready" about a coin the user already picked, instead of one this view
   * invented.
   */
  fromEarnTarget: boolean;
  /**
   * The route the rate came from, when there is one.
   *
   * Deliberately `unknown` here rather than the estimator's own type: this
   * file is in mining's allow-list, and importing `features/swap`'s types
   * would put a swap type in mining's import graph even as a type-only edge.
   * Mining renders the NUMBER; the provenance strings are produced on the swap
   * side and passed as plain text where a surface needs them.
   */
  route?: unknown;
  /** Why there is no rate, when there is none. Rendered, never swallowed. */
  routeFailure?: string | null;
  /**
   * That reason as a sentence for the user.
   *
   * The hero MUST render this when there is no number. A bare `—` with no
   * explanation is what produced "sol asset wont come up ... Why is that?" —
   * the wallet knew the answer and kept it.
   */
  routeFailureText?: string | null;
  /** True while the order book / quote is still being fetched. */
  routeLoading?: boolean;
  /** Re-read the book and re-price. Backs the hero's RETRY control. */
  retryRoute?: () => void;
  /** `"live-node"` or `"public-snapshot"` — which book priced it. */
  routeSource?: string;
  /**
   * A sentence naming the book, when it is not the user's own node.
   *
   * Rendered beside the number. The estimator may fall back to the public
   * snapshot when a live read fails — that is the operator's instruction — but
   * a third party's book must never be shown as though it were the node's.
   */
  routeSourceNote?: string | null;
}
