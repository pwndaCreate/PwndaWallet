/**
 * src/features/mining/algorithms.ts
 *
 * Algorithm-level facts, one table each, every table keyed EXHAUSTIVELY on the
 * algorithm union.
 *
 * # Why tables and not conditionals
 *
 * Until 2026-09-15 these facts lived as if/else chains spread across
 * `useMiner.ts` and `useCalibration.ts`, and each chain ended in a silent
 * default:
 *
 *   - `switchHardware` mapped the GPU algorithm to a coin with
 *     `kawpow ? ravencoin : octopus ? conflux : "ergo"`, so a GPU Zano session
 *     toggled back into view as ERGO.
 *   - `useCalibration` saved every GPU algorithm that was not Octopus as the
 *     KawPow calibration, so a Zano session overwrote the user's RVN number.
 *   - The GPU snapshot poll guessed `kawpow ? SRBMiner : lolMiner`, so an
 *     Autolykos2/ProgPowZ session with no remembered miner was parsed as
 *     lolMiner JSON.
 *
 * All three type-checked, because a fallthrough `else` cannot be checked for
 * exhaustiveness. A `Record<GpuAlgorithm, …>` can: adding an algorithm to the
 * union is now a compile error in every table below until someone decides
 * what it means there. That is the whole point of this file.
 */
import type { ChainType } from "../../wallets";
import type { CpuAlgorithm, GpuAlgorithm } from "../../types/mining";
import type { BenchAlgorithm } from "./hardware-benchmarks";

export type MiningAlgorithm = CpuAlgorithm | GpuAlgorithm;

/** Human label, used by every surface that names an algorithm. */
export const ALGORITHM_LABEL: Record<MiningAlgorithm, string> = {
  randomx: "RandomX",
  xelishashv3: "XelisHash v3",
  kawpow: "KawPow",
  octopus: "Octopus",
  autolykos: "Autolykos2",
  progpowz: "ProgPowZ",
};

/**
 * Which binary mines each CPU algorithm, and the algorithm string THAT binary
 * expects on its own command line.
 *
 * xmrig stays the RandomX miner (elevated, MSR). XelisHash v3 runs on
 * SRBMiner-MULTI's CPU lane (`--algorithm-cpu xelishashv3 --disable-gpu`),
 * unelevated, in its own process slot — verified live 2026-09-15 against
 * K1Pool and Kryptex (see `wiki/concepts/xelishash.md`). xmrig cannot mine
 * XelisHash at all.
 */
export const CPU_MINER: Record<
  CpuAlgorithm,
  { miner: "xmrig" | "SRBMiner-MULTI"; algorithm: string }
> = {
  randomx: { miner: "xmrig", algorithm: "rx/0" },
  xelishashv3: { miner: "SRBMiner-MULTI", algorithm: "xelishashv3" },
};

/**
 * Which binary mines each GPU algorithm, with per-miner casing (lolMiner wants
 * UPPER, SRBMiner wants lower).
 *
 * `sendsWorker`: pass the worker name as SRBMiner's own `--worker` flag. Only
 * for XELIS stratum, where `mining.authorize` carries the worker as a separate
 * field — SRBMiner 3.6.2 was captured sending
 * `["<--wallet>", "<--worker>", "<--password>"]`. Every other algorithm keeps
 * its existing argv byte-for-byte (worker stays inside the user string).
 */
export const GPU_MINER: Record<
  GpuAlgorithm,
  { miner: "SRBMiner-MULTI" | "lolMiner"; algorithm: string; sendsWorker: boolean }
> = {
  kawpow: { miner: "SRBMiner-MULTI", algorithm: "kawpow", sendsWorker: false },
  // lolMiner disabled for ERG 2026-05-15; SRBMiner is the sole ERG miner.
  autolykos: { miner: "SRBMiner-MULTI", algorithm: "autolykos2", sendsWorker: false },
  octopus: { miner: "lolMiner", algorithm: "OCTOPUS", sendsWorker: false },
  // Zano. WoolyPooly names SRBMiner (AMD) and T-Rex (Nvidia); SRBMiner is the
  // one this wallet ships, and it takes the algorithm as lowercase `progpowz`.
  progpowz: { miner: "SRBMiner-MULTI", algorithm: "progpowz", sendsWorker: false },
  xelishashv3: { miner: "SRBMiner-MULTI", algorithm: "xelishashv3", sendsWorker: true },
};

/**
 * GPU algorithms RETIRED from mining on 2026-09-18 (operator: "remove rvn, cfx,
 * and erg from the mining page ... make sure we aren't bundling the lolminer
 * anymore"). Their table entries above and below are kept as archived code —
 * the union still names them, so persisted state or an old test fixture can
 * never index a table and get `undefined` — but no roster coin mines them, so
 * no surface can select one. Mining ships xmrig + SRBMiner-MULTI only.
 */
export const RETIRED_GPU_ALGORITHMS: ReadonlySet<GpuAlgorithm> = new Set<GpuAlgorithm>([
  "kawpow",
  "octopus",
  "autolykos",
]);

/** Whether the CPU lane for this algorithm also sends `--worker` (XELIS stratum). */
export const CPU_SENDS_WORKER: Record<CpuAlgorithm, boolean> = {
  randomx: false,
  xelishashv3: true,
};

/**
 * The coin each GPU algorithm mines. 1:1 today — every GPU algorithm belongs to
 * exactly one rostered coin — which is what lets the GPU lane restore its coin
 * from `gpuAlgorithm` alone. `miningCoins.test.ts` asserts this agrees with
 * `MINING_COINS`.
 */
export const GPU_ALGORITHM_COIN: Record<GpuAlgorithm, ChainType> = {
  kawpow: "ravencoin",
  octopus: "conflux",
  autolykos: "ergo",
  progpowz: "zano",
  xelishashv3: "xelis",
};

/**
 * The coin a CPU algorithm selects when chosen from an ALGO control. Not 1:1:
 * RandomX mines both XMR and ZEPH, so callers keep the current coin when it
 * already mines that algorithm and use this only as the fallback.
 */
export const CPU_ALGORITHM_DEFAULT_COIN: Record<CpuAlgorithm, ChainType> = {
  randomx: "monero",
  xelishashv3: "xelis",
};

/**
 * The benchmark-table key a live session's hashrate may be saved under, or
 * `null` when there is no table for it yet (the calibration is skipped rather
 * than filed under a different algorithm's key).
 */
export const BENCH_ALGORITHM: Record<MiningAlgorithm, BenchAlgorithm | null> = {
  randomx: "randomx",
  xelishashv3: "xelishashv3",
  kawpow: "kawpow",
  octopus: "octopus",
  autolykos: null,
  progpowz: null,
};
