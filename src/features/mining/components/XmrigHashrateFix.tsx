/**
 * src/features/mining/components/XmrigHashrateFix.tsx
 *
 * `HashrateFixPanel`, mounted only where it describes the lane on screen.
 *
 * The panel reports xmrig's RandomX environment: MSR mod, huge pages, the
 * WinRing0 driver, Hard Reset. Portrait gated it on `miningHardware === "cpu"`
 * alone — although the comment beside that gate already said the surface was
 * xmrig-only — so a XelisHash CPU session (SRBMiner, unelevated, none of this
 * applies) could be told to fix MSR. Landscape did not mount it at all, even
 * though the panel was written with a `compact` variant for landscape's rail
 * (parity audit, 2026-09-16). One gate, both layouts.
 */
import type { useMiner } from "../useMiner";
import { HashrateFixPanel } from "../HashrateFixPanel";
import { cpuLaneMiner, showsXmrigDiagnostics } from "../miningLane";

type MinerApi = ReturnType<typeof useMiner>;

export type XmrigHashrateFixMiner = Pick<
  MinerApi,
  | "miningHardware"
  | "cpuAlgorithm"
  | "isMiningCpu"
  | "runningCpuMiner"
  | "hashrateFixPlan"
  | "hashrateFixStatus"
  | "scanningEnv"
  | "rescanEnv"
  | "hardResetting"
  | "hardResetMessage"
  | "hardReset"
>;

export function XmrigHashrateFix({
  miner,
  compact = false,
}: {
  miner: XmrigHashrateFixMiner;
  /** Landscape's narrow rail. */
  compact?: boolean;
}) {
  const cpuMiner = cpuLaneMiner({
    cpuAlgorithm: miner.cpuAlgorithm,
    isMiningCpu: miner.isMiningCpu,
    runningCpuMiner: miner.runningCpuMiner,
  });
  if (!showsXmrigDiagnostics({ hardware: miner.miningHardware, cpuMiner })) {
    return null;
  }
  if (!miner.hashrateFixPlan && !miner.scanningEnv) return null;
  return (
    <div style={{ marginTop: compact ? 12 : 14 }}>
      <HashrateFixPanel
        plan={miner.hashrateFixPlan}
        status={miner.hashrateFixStatus}
        scanning={miner.scanningEnv}
        isMining={miner.isMiningCpu}
        hardResetting={miner.hardResetting}
        hardResetMessage={miner.hardResetMessage}
        onRescan={miner.rescanEnv}
        onHardReset={miner.hardReset}
        compact={compact}
        hideWhenHealthy
      />
    </div>
  );
}
