import { useEffect, useMemo, useState } from "react";
import { invoke } from "../../lib/tauri";
import type { ChainType } from "../../wallets";
import { estimateEarningsForChain } from "./earnings";
import {
  CHAIN_MINING_PROFILES,
  lookupHashrate,
  normalizeDeviceName,
  type BenchAlgorithm,
  type ChainMiningProfile,
  type Confidence,
} from "./hardware-benchmarks";

/**
 * Phase 3 — device profile hook. One-shot detection of CPU + GPU(s)
 * via the Rust `get_cpu_info` / `get_gpu_info` commands, plus per-
 * (device, coin) hashrate + earnings predictions.
 *
 * Predicted hashrate prefers calibrated values (saved to
 * localStorage by the Phase-5 benchmark flow) over the static
 * benchmark table; falls back to architecture-class median when the
 * exact device isn't in the table; falls back to `null` when truly
 * unknown — the UI then surfaces the "Calibrate" CTA.
 *
 * Caller plumbs in `pricesByTicker` and a per-chain `liveNetworkHashrate`
 * map (from the existing `useNetworkHashrate` hook). Both feed the
 * earnings estimate so the `$/day` reads match what a live mining
 * session would compute.
 */

export interface CpuInfo {
  name: string;
  threads: number;
  physical_cores: number;
  max_mhz: number;
}

export interface GpuInfo {
  name: string;
  vendor: string;
  vram_bytes: number;
  driver_version: string;
}

export type DeviceKind = "cpu" | "gpu";

export interface DeviceRow {
  /** Stable id used as a localStorage key + React `key`. */
  id: string;
  kind: DeviceKind;
  name: string;
  /** Vendor for GPU rows; "intel" / "amd" for CPU rows. */
  vendor: string;
  /** Threads for CPU rows; VRAM-in-bytes for GPU rows. */
  detail: string;
  /** Per-chain prediction. Only chains the device can run are keyed —
   *  a GPU row will only have `ravencoin` / `conflux`, a CPU row only
   *  `monero` / `zephyr`. */
  predictions: Partial<
    Record<
      ChainType,
      {
        hashrate: number;
        /** Static benchmark-database lookup, populated whenever the
         *  device matches an exact / class-fallback entry. Keeps the
         *  pre-calibration value visible so the UI can render
         *  "measured X (db Y)" comparisons after a calibrate run. */
        dbHashrate?: number;
        perDayCoin: number;
        perDayUsd: number;
        confidence: Confidence;
        reason?: string;
      }
    >
  >;
  /** Best `$/day` profile for this device — used to sort devices in
   *  the UI by profitability. */
  best?: ChainType;
}

export interface DeviceProfile {
  loading: boolean;
  error: string | null;
  cpu: CpuInfo | null;
  gpus: GpuInfo[];
  /** Devices in display order (CPU first, then each GPU). */
  devices: DeviceRow[];
}

/* ──────────────────────────────────────────────────────────────
   localStorage cache for calibrated hashrates. Keyed by
   `bench:<device-name-slug>:<algo>`. We use the WMI-reported
   device name as the slug so the cache survives kit changes
   without false hits.
   ────────────────────────────────────────────────────────────── */

const CALIBRATION_PREFIX = "pwnda-bench:";

function calibrationKey(deviceName: string, algo: BenchAlgorithm): string {
  return `${CALIBRATION_PREFIX}${normalizeDeviceName(deviceName)}:${algo}`;
}

export function getCalibratedHashrate(
  deviceName: string,
  algo: BenchAlgorithm
): number | null {
  try {
    const raw = localStorage.getItem(calibrationKey(deviceName, algo));
    if (!raw) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function setCalibratedHashrate(
  deviceName: string,
  algo: BenchAlgorithm,
  value: number
): void {
  try {
    localStorage.setItem(calibrationKey(deviceName, algo), String(value));
  } catch {
    /* quota / privacy mode — ignore, prediction silently uses static */
  }
}

export function clearCalibratedHashrate(
  deviceName: string,
  algo: BenchAlgorithm
): void {
  try {
    localStorage.removeItem(calibrationKey(deviceName, algo));
  } catch {
    /* ignore */
  }
}

/* ──────────────────────────────────────────────────────────────
   Hook
   ────────────────────────────────────────────────────────────── */

export function useDeviceProfile(args: {
  pricesByTicker: Record<string, number>;
  /** Per-chain partial overrides for the earnings estimator —
   *  typically populated by `useCoinStats` (WhatToMine + per-chain
   *  fallbacks). Any null/undefined field falls back to the
   *  hardcoded `NETWORK_PARAMS_DEFAULT` constant inside the
   *  estimator. */
  liveCoinParams?: Partial<
    Record<
      ChainType,
      {
        networkHashrate?: number | null;
        blockReward?: number | null;
        blockTimeSecs?: number | null;
      }
    >
  >;
  /** Bumped externally to force a re-detect (e.g. after a calibrate
   *  run). The detection itself is cheap (~50 ms PowerShell call) so
   *  re-running on every bench completion is fine. */
  refreshTick?: number;
}): DeviceProfile {
  const { pricesByTicker, liveCoinParams, refreshTick } = args;
  const [cpu, setCpu] = useState<CpuInfo | null>(null);
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      invoke<CpuInfo>("get_cpu_info").catch((e: unknown) => {
        // CPU detection is the more critical of the two — surface
        // its failure on the loading row instead of silently
        // returning empty data.
        throw new Error(
          typeof e === "string" ? e : (e as Error)?.message ?? "CPU detection failed"
        );
      }),
      invoke<GpuInfo[]>("get_gpu_info").catch((e: unknown) => {
        // GPU detection failing means "no GPUs" rather than fatal —
        // some boxes don't have one.
        console.warn("[useDeviceProfile] GPU detect failed", e);
        return [];
      }),
    ])
      .then(([cpuInfo, gpuList]) => {
        if (cancelled) return;
        setCpu(cpuInfo);
        setGpus(gpuList);
        setError(null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message ?? "Hardware detection failed");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // Derive the device rows + per-(device, coin) predictions from
  // current detection + price/live-net inputs. Memoised so a price
  // refresh doesn't re-render every consumer twice.
  const devices = useMemo(() => {
    const out: DeviceRow[] = [];
    if (cpu) {
      out.push(
        buildDeviceRow({
          id: "cpu",
          kind: "cpu",
          name: cpu.name || "Unknown CPU",
          vendor: cpu.name.toLowerCase().includes("amd") ? "amd" : "intel",
          detail: cpu.physical_cores
            ? `${cpu.physical_cores} cores · ${cpu.threads} threads`
            : `${cpu.threads} threads`,
          pricesByTicker,
          liveCoinParams,
        })
      );
    }
    gpus.forEach((g, i) => {
      out.push(
        buildDeviceRow({
          id: `gpu-${i}`,
          kind: "gpu",
          name: g.name,
          vendor: g.vendor,
          detail:
            g.vram_bytes > 0
              ? `${(g.vram_bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
              : g.driver_version
                ? `driver ${g.driver_version}`
                : "—",
          pricesByTicker,
          liveCoinParams,
        })
      );
    });
    return out;
  }, [cpu, gpus, pricesByTicker, liveCoinParams]);

  return { loading, error, cpu, gpus, devices };
}

function buildDeviceRow(args: {
  id: string;
  kind: DeviceKind;
  name: string;
  vendor: string;
  detail: string;
  pricesByTicker: Record<string, number>;
  liveCoinParams?: Partial<
    Record<
      ChainType,
      {
        networkHashrate?: number | null;
        blockReward?: number | null;
        blockTimeSecs?: number | null;
      }
    >
  >;
}): DeviceRow {
  const {
    id,
    kind,
    name,
    vendor,
    detail,
    pricesByTicker,
    liveCoinParams,
  } = args;
  const predictions: DeviceRow["predictions"] = {};
  for (const profile of CHAIN_MINING_PROFILES) {
    if (!profile.hardware.includes(kind)) continue;
    // Always run the DB lookup so we keep the pre-calibration value
    // visible when a calibration overrides the displayed hashrate.
    const dbLookup = lookupHashrate(name, profile.algo, kind);
    const dbHashrate =
      dbLookup.hashrate != null && dbLookup.hashrate > 0
        ? dbLookup.hashrate
        : undefined;
    const calibrated = getCalibratedHashrate(name, profile.algo);
    const lookup = calibrated != null
      ? { hashrate: calibrated, confidence: "calibrated" as Confidence }
      : dbLookup;
    if (lookup.hashrate == null) {
      predictions[profile.chain] = {
        hashrate: 0,
        dbHashrate,
        perDayCoin: 0,
        perDayUsd: 0,
        confidence: "unknown",
      };
      continue;
    }
    const live = liveCoinParams?.[profile.chain];
    const earnings = estimateEarningsForChain(
      profile.chain,
      lookup.hashrate,
      live
        ? {
            networkHashrate: live.networkHashrate ?? undefined,
            blockReward: live.blockReward ?? undefined,
            blockTimeSecs: live.blockTimeSecs ?? undefined,
          }
        : undefined
    );
    if (!earnings) {
      predictions[profile.chain] = {
        hashrate: lookup.hashrate,
        dbHashrate,
        perDayCoin: 0,
        perDayUsd: 0,
        confidence: lookup.confidence,
        reason: lookup.reason,
      };
      continue;
    }
    const price = pricesByTicker[profile.ticker.toUpperCase()] ?? 0;
    predictions[profile.chain] = {
      hashrate: lookup.hashrate,
      dbHashrate,
      perDayCoin: earnings.day,
      perDayUsd: earnings.day * price,
      confidence: lookup.confidence,
      reason: lookup.reason,
    };
  }

  // Pick the best-paying chain for the row's headline.
  let best: ChainType | undefined;
  let bestUsd = -1;
  for (const [chain, p] of Object.entries(predictions) as [
    ChainType,
    DeviceRow["predictions"][ChainType],
  ][]) {
    if (p && p.perDayUsd > bestUsd) {
      bestUsd = p.perDayUsd;
      best = chain;
    }
  }

  return { id, kind, name, vendor, detail, predictions, best };
}

/** Re-export to keep the type accessible from view files without a
 *  separate import line. */
export type { ChainMiningProfile };
