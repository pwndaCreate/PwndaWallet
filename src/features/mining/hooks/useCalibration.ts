import { useEffect, useRef } from "react";
import { invoke } from "../../../lib/tauri";
import type { CpuAlgorithm, GpuAlgorithm } from "../../../types/mining";
import { BENCH_ALGORITHM } from "../algorithms";
import {
  setCalibratedHashrate,
  type CpuInfo,
  type GpuInfo,
} from "../useDeviceProfile";

/**
 * Custom window event the auto-calibration hook fires after persisting
 * a measured hashrate to localStorage during a live mining session.
 * `DeviceProfilePanel` listens for it and bumps its refreshTick so the
 * DEVICES card picks up the new calibrated value without remount.
 */
export const CALIBRATION_UPDATED_EVENT = "pwnda-calibration-updated";

/** Rolling hashrate sample as stored by `useMiner`'s poll effects. */
type HashrateSample = { t: number; value: number };

/**
 * Auto-calibration from live mining (option 3). Extracted from `useMiner`
 * 2026-06-16 — pure side-effects with no return surface, so the orchestrator
 * just calls this hook and discards the result.
 *
 * After ~60 s of stable mining, persist the live hashrate as the
 * calibrated value for the active device + algo. Side-steps the
 * ~2× hashrate gap between calibrate clicks (un-elevated, no MSR)
 * and real mining (elevated, MSR mod applied) by capturing the
 * *real* rate as a free byproduct of the mining session the user
 * already started. No second UAC prompt — the live miner is already
 * running with the right privileges by the time these effects fire.
 *
 * Stability check: take the last 30 s window (15 samples at 2 s
 * poll), require max-min spread ≤ 5 % of average. Refs guard against
 * re-saving on every poll inside the same mining session — the flag
 * resets when the hardware stops mining.
 *
 * # Which key a measurement is saved under (fixed 2026-09-15)
 *
 * Until 2026-09-15 the CPU effect saved EVERY CPU session as `randomx`, and
 * the GPU effect saved every GPU session that was not Octopus as `kawpow`.
 * With one CPU algorithm and three benchmarked GPU algorithms that was
 * merely fragile; with ZANO (`progpowz`) it was wrong: a Zano session's
 * hashrate overwrote the user's Ravencoin prediction. The key now comes from
 * `algorithms.ts::BENCH_ALGORITHM`, an exhaustive table, and an algorithm
 * with no benchmark table is skipped rather than filed under another's key.
 */
export function useCalibration(args: {
  isMiningCpu: boolean;
  isMiningGpu: boolean;
  cpuHashrateSamples: HashrateSample[];
  gpuHashrateSamples: HashrateSample[];
  /** Algorithm of the CPU lane's session. Stable while it mines: the CPU
   *  coin tiles and the algorithm snap are both locked for a busy lane. */
  cpuAlgorithm: CpuAlgorithm;
  /** Algorithm of the GPU lane's session (same stability argument). */
  gpuAlgorithm: GpuAlgorithm;
}) {
  const {
    isMiningCpu,
    isMiningGpu,
    cpuHashrateSamples,
    gpuHashrateSamples,
    cpuAlgorithm,
    gpuAlgorithm,
  } = args;

  const cpuAutoCalibratedRef = useRef(false);
  useEffect(() => {
    if (!isMiningCpu) {
      cpuAutoCalibratedRef.current = false;
      return;
    }
    if (cpuAutoCalibratedRef.current) return;
    // Need ≥30 samples (60 s of mining) before we even consider it —
    // RandomX dataset init + auto-config + ramp can swing the early
    // numbers, and the user gains nothing by us racing for the
    // earliest possible save.
    if (cpuHashrateSamples.length < 30) return;
    const bench = BENCH_ALGORITHM[cpuAlgorithm];
    if (!bench) {
      cpuAutoCalibratedRef.current = true;
      return;
    }
    const recent = cpuHashrateSamples.slice(-15);
    const values = recent.map((s) => s.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    if (avg <= 0) return;
    if ((max - min) / avg > 0.05) return; // not yet stable
    let cancelled = false;
    invoke<CpuInfo>("get_cpu_info")
      .then((info) => {
        if (cancelled || !info?.name) return;
        setCalibratedHashrate(info.name, bench, avg);
        cpuAutoCalibratedRef.current = true;
        window.dispatchEvent(new CustomEvent(CALIBRATION_UPDATED_EVENT));
      })
      .catch(() => {
        /* CPU detection rarely fails; if it does, just skip. */
      });
    return () => {
      cancelled = true;
    };
  }, [isMiningCpu, cpuHashrateSamples, cpuAlgorithm]);

  const gpuAutoCalibratedRef = useRef(false);
  useEffect(() => {
    if (!isMiningGpu) {
      gpuAutoCalibratedRef.current = false;
      return;
    }
    if (gpuAutoCalibratedRef.current) return;
    if (gpuHashrateSamples.length < 30) return;
    // No benchmark table for this algorithm (Autolykos2, ProgPowZ today):
    // skip, and mark done so it is not re-evaluated every poll. Before
    // 2026-09-15 this branch only excluded Autolykos2 and everything else
    // fell through to `kawpow`.
    const bench = BENCH_ALGORITHM[gpuAlgorithm];
    if (!bench) {
      gpuAutoCalibratedRef.current = true;
      return;
    }
    const recent = gpuHashrateSamples.slice(-15);
    const values = recent.map((s) => s.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    if (avg <= 0) return;
    if ((max - min) / avg > 0.05) return;
    let cancelled = false;
    invoke<GpuInfo[]>("get_gpu_info")
      .then((gpus) => {
        if (cancelled || !gpus || gpus.length === 0) return;
        // Live GPU hashrate is the SUM across every visible card. We
        // can only attribute it cleanly when all GPUs are the same
        // model — divide by count. Mixed-vendor / mixed-model rigs
        // (e.g. an NVIDIA + AMD setup) don't decompose, so we skip
        // the auto-save; the user can still per-card calibrate via
        // the Calibrate buttons. Set the ref either way so we don't
        // keep re-evaluating on every poll.
        const allSameModel = gpus.every((g) => g.name === gpus[0].name);
        if (allSameModel) {
          const perCard = avg / gpus.length;
          setCalibratedHashrate(gpus[0].name, bench, perCard);
          window.dispatchEvent(new CustomEvent(CALIBRATION_UPDATED_EVENT));
        }
        gpuAutoCalibratedRef.current = true;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isMiningGpu, gpuHashrateSamples, gpuAlgorithm]);
}
