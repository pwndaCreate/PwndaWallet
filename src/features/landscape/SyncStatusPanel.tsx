import { Panel, Mono } from "../../components/Primitives";
import { Btn } from "../../components/PrimitivesV2";
import { supportsDefenderExclusion } from "../../platform/os";

/* ══════ Types ═════════════════════════════════════════════════ */
type SyncState = "idle" | "starting" | "syncing" | "synced" | "error" | "connection-lost";

export interface SyncPanelProps {
  chain: "monero" | "zephyr";
  label: string;                       // e.g. "Monero Sync" / "Zephyr Sync"
  accentColor: string;                 // progress-bar fill
  syncState: SyncState;
  syncPercent: number;
  walletHeight: number;
  daemonHeight: number;
  blocksPerSec: number | null;
  etaSeconds: number | null;
  syncError: string;
  defenderExcluded: boolean | null;
  onRetry: () => void;
  onManageNodes: () => void;
  onAddDefenderExclusion: () => void;
}

/* ══════ Format helpers ═══════════════════════════════════════ */
function fmtEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "estimating…";
  if (seconds < 1) return "almost done";
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.round(seconds / 60);
    return `~${m} min`;
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds - h * 3600) / 60);
    return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
  }
  const d = Math.floor(seconds / 86_400);
  const h = Math.round((seconds - d * 86_400) / 3600);
  return h > 0 ? `~${d}d ${h}h` : `~${d}d`;
}

function fmtRate(bps: number | null): string {
  if (bps == null) return "—";
  if (bps === 0) return "stalled";
  if (bps < 1) return `${bps.toFixed(2)} blk/s`;
  if (bps < 10) return `${bps.toFixed(1)} blk/s`;
  return `${Math.round(bps)} blk/s`;
}

/* ══════ SyncStatusPanel ═══════════════════════════════════════
   Landscape-view sync console for Monero or Zephyr. Renders progress,
   rolling rate + ETA, and the actions the user actually needs when sync
   isn't healthy (retry / swap node / add Defender exclusion).

   Portrait has its own sync cards inside the main dashboard; this panel
   is the landscape equivalent, kept small so it fits beside the balance
   + address panels without taking over the whole center column.
*/
export function SyncStatusPanel(props: SyncPanelProps) {
  const {
    chain, label, accentColor,
    syncState, syncPercent, walletHeight, daemonHeight,
    blocksPerSec, etaSeconds, syncError, defenderExcluded,
    onRetry, onManageNodes, onAddDefenderExclusion,
  } = props;

  // A Defender false-positive error is a common Windows reason the sidecar
  // can't start. When that's the cause we expose the one-click exclusion
  // button; otherwise the generic retry is enough.
  const defenderIssue =
    syncError.includes("Defender") ||
    syncError.includes("virus") ||
    syncError.includes("os error 225");

  const stateColor =
    syncState === "synced" ? "var(--accent)" :
    syncState === "error" ? "var(--danger)" :
    syncState === "connection-lost" ? "var(--warn)" :
    syncState === "starting" ? "var(--text-muted)" :
    "var(--text-dim)";

  const stateLabel = (() => {
    switch (syncState) {
      case "synced":          return "SYNCED";
      case "syncing":         return "SYNCING";
      case "starting":        return "STARTING";
      case "error":           return "ERROR";
      case "connection-lost": return "CONNECTION LOST";
      case "idle":            return "IDLE";
    }
  })();

  const remaining = Math.max(0, daemonHeight - walletHeight);

  return (
    <Panel
      label={label}
      tag={` · ${chain.toUpperCase()}`}
      right={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, background: stateColor, flexShrink: 0 }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 9,
            color: stateColor, letterSpacing: 1 }}>
            {stateLabel}
          </span>
        </span>
      }
      style={{ flexShrink: 0 }}
      pad={12}
    >
      {/* Starting — no progress yet */}
      {syncState === "starting" && (
        <Mono size={10} color="var(--text-dim)">
          Starting {chain === "monero" ? "monero-wallet-rpc" : "zephyr-wallet-rpc"} sidecar
          and connecting to a remote node…
        </Mono>
      )}

      {/* Syncing — progress + ETA */}
      {(syncState === "syncing" || syncState === "connection-lost") && (
        <>
          <div style={{
            width: "100%", height: 8, background: "#151515",
            border: "1px solid rgba(255,255,255,0.08)",
            overflow: "hidden", marginBottom: 10,
          }}>
            <div style={{
              width: `${syncPercent.toFixed(2)}%`, height: "100%",
              background: syncState === "connection-lost" ? "var(--warn)" : accentColor,
              transition: "width .5s ease",
            }} />
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            columnGap: 14, rowGap: 4,
          }}>
            <StatRow label="Progress" value={`${syncPercent.toFixed(2)}%`} />
            <StatRow label="ETA" value={fmtEta(etaSeconds)} />
            <StatRow
              label="Block"
              value={`${walletHeight.toLocaleString()} / ${daemonHeight.toLocaleString()}`}
            />
            <StatRow label="Rate" value={fmtRate(blocksPerSec)} />
            <StatRow label="Remaining" value={remaining.toLocaleString()} />
            <StatRow label="State" value={syncState} />
          </div>

          {syncState === "connection-lost" && (
            <Mono size={9} color="var(--warn)" style={{ display: "block", marginTop: 8 }}>
              Lost connection to the {chain} node. Progress is frozen until the
              node responds — try swapping nodes.
            </Mono>
          )}
        </>
      )}

      {/* Synced */}
      {syncState === "synced" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 6, height: 6, background: "var(--accent)" }} />
          <Mono size={10} color="var(--text)">
            Fully synced · block {walletHeight.toLocaleString()}
          </Mono>
        </div>
      )}

      {/* Error */}
      {syncState === "error" && (
        <>
          <Mono size={10} color="var(--danger)" style={{ display: "block" }}>
            {syncError || "Sync failed."}
          </Mono>
          {supportsDefenderExclusion() && defenderIssue && defenderExcluded !== true && (
            <Mono size={9} color="var(--warn)" style={{ display: "block", marginTop: 6 }}>
              Windows Defender flagged the wallet-rpc binary (false positive on all
              Monero-lineage binaries). Add an exclusion and retry.
            </Mono>
          )}
        </>
      )}

      {/* Action row — always available so users can manually kick sync */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {(syncState === "error" || syncState === "connection-lost") && (
          <Btn variant="primary" onClick={onRetry}>
            Retry Sync
          </Btn>
        )}
        <Btn variant="ghost" onClick={onManageNodes}>
          Manage Nodes
        </Btn>
        {supportsDefenderExclusion() && syncState === "error" && defenderIssue && defenderExcluded !== true && (
          <Btn variant="primary" onClick={onAddDefenderExclusion}>
            Add Defender Exclusion
          </Btn>
        )}
      </div>
    </Panel>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <Mono size={9} color="var(--text-dim)" upper spacing={0.8}>{label}</Mono>
      <Mono size={9} color="var(--text)" style={{ fontVariantNumeric: "tabular-nums" }}>
        {value}
      </Mono>
    </div>
  );
}
