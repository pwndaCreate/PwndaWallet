export type View =
  | "home"
  | "login"
  | "import"
  | "derivation-picker"
  | "setPassword"
  | "backup"
  | "dashboard"
  | "mining"
  | "miner-setup"
  | "settings"
  | "wallet-details"
  | "monero-nodes"
  | "zephyr-nodes"
  | "zano-nodes"
  | "activity"
  | "swap";

// Re-export mining types from their new home so legacy import sites
// (`import { CpuAlgorithm } from "../../types/view"`) keep working while
// callers migrate to `../../types/mining`. Safe to remove this block once
// every import has been updated — there is no runtime cost (types only).
export type {
  MiningHardware,
  CpuAlgorithm,
  GpuAlgorithm,
  MiningIntensity,
  MinerStatus,
  DownloadProgress,
  HashrateFixPlan,
  MsrLogStatus,
  HugePagesStatus,
  ReadyStatus,
  HashrateFixStatus,
} from "./mining";
export { CHAIN_MINING_PREFIX } from "./mining";
