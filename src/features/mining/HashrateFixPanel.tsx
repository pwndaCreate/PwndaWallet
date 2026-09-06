import { useState } from "react";
import { Panel, Mono } from "../../components/Primitives";
import type { HashrateFixPlan, HashrateFixStatus } from "../../types/mining";

/**
 * Sprint 3 Phase 6 — HashrateFixPanel
 *
 * Renders the live MSR / hashrate diagnostic. Pulls from:
 *   - Phase 3 env scan (HashrateFixPlan) — what's reachable on this system
 *   - Phase 7 log tail (HashrateFixStatus) — what xmrig is reporting at runtime
 *
 * Buttons: "Why is MSR disabled?" modal, "Hard Reset Driver State", "Re-scan".
 *
 * Designed to be dropped into either the portrait MiningView (full-width
 * below the controls) or the landscape MineLandscapeView right column. The
 * `compact` prop tightens spacing for the landscape variant.
 */
export function HashrateFixPanel({
  plan,
  status,
  scanning,
  isMining,
  hardResetting,
  hardResetMessage,
  onRescan,
  onHardReset,
  compact = false,
  hideWhenHealthy = false,
}: {
  plan: HashrateFixPlan | null;
  status: HashrateFixStatus;
  scanning: boolean;
  isMining: boolean;
  hardResetting: boolean;
  hardResetMessage: string | null;
  onRescan: (force: boolean) => Promise<HashrateFixPlan | null>;
  onHardReset: () => Promise<void>;
  compact?: boolean;
  /**
   * When true, return null if the system is healthy. Used by the Mining
   * view to hide the panel from the main scroll surface during the happy
   * path — users who want to inspect environment flags or run Hard Reset
   * can find the same panel in Settings ► Hashrate diagnostics. Without
   * this prop the panel auto-collapses to a tag + descriptive text, which
   * still reflows on every backend `hashrate-fix-status` event during
   * active mining (the "scroll-shake-at-bottom" symptom reported
   * 2026-05-25).
   */
  hideWhenHealthy?: boolean;
}) {
  const [showWhyMsr, setShowWhyMsr] = useState(false);

  if (!plan && !scanning) {
    return null;
  }

  const labelSize = compact ? 8 : 9;
  const valueSize = compact ? 9 : 10;
  const sectionGap = compact ? 8 : 12;
  const rowGap = compact ? 3 : 4;

  if (scanning && !plan) {
    return (
      <Panel label="Hashrate Fix Status" pad={compact ? 10 : 14}>
        <Mono size={valueSize} color="var(--text-dim)">
          Scanning environment...
        </Mono>
      </Panel>
    );
  }

  const p = plan!;
  const msrLive = status.msr ?? null;
  const msrApplied = msrLive?.kind === "Ok";
  const msrFailedAtRuntime = msrLive?.kind === "Failed";

  // Reasons MSR is disabled (in priority order)
  const msrDisabledReason: string | null = (() => {
    if (msrApplied) return null;
    if (!p.blocklistOff) return "Vulnerable Driver Blocklist on";
    if (!p.sacOff) return "Smart App Control on";
    if (msrFailedAtRuntime) {
      const reason = (msrLive as { kind: "Failed"; reason: string }).reason;
      switch (reason) {
        case "not_admin":           return "WinRing0 driver requires admin (error 5)";
        case "service_collision":   return "WinRing0 service collision (error 183) — Hard Reset will fix";
        case "blocklist_hit":       return "Blocked by Vulnerable Driver Blocklist at load";
        case "wrmsr_rejected":      return "WRMSR intercepted by VBS / Credential Guard";
        case "driver_load_failed":  return "Driver load failed (see raw log)";
        case "unknown_failure":     return "Unknown MSR failure (see raw log)";
        default:                    return reason;
      }
    }
    return null;
  })();

  // Active vs disabled rows
  const activeRows: Array<{ label: string; sub?: string }> = [
    { label: "No-yield scheduling" },
  ];
  if (p.seLockMemoryGranted) activeRows.push({ label: "Huge pages (JIT)" });
  if (p.numaNodeCount > 1) activeRows.push({ label: `NUMA awareness (${p.numaNodeCount} nodes)` });
  if (msrApplied) {
    const preset = (msrLive as { kind: "Ok"; preset: string }).preset;
    activeRows.push({ label: `MSR mod active`, sub: preset });
  }

  const disabledRows: Array<{ label: string; reason: string }> = [];
  if (!msrApplied && msrDisabledReason) {
    disabledRows.push({ label: "MSR mod", reason: msrDisabledReason });
  }
  if (!p.seLockMemoryGranted) {
    disabledRows.push({ label: "Huge pages", reason: "SeLockMemoryPrivilege missing" });
  }

  const hasCollisionApps = p.collisionApps.length > 0;
  const hasWinring0Collision = p.winring0Collision !== null && p.winring0Collision !== "";

  // Healthy when nothing actionable is wrong — no disabled
  // optimization rows, no collision warnings, no failed hard-reset
  // message. Collapsed-by-default in this state so first-time miners
  // don't get scared by "Hard Reset Driver State" being the most
  // prominent button below the fold (UXS-20260516-004). When NOT
  // healthy we default expanded so the user sees the actionable
  // remediation buttons immediately.
  const hardResetFailed = hardResetMessage?.startsWith("Hard Reset failed") ?? false;
  const isHealthy =
    disabledRows.length === 0 &&
    !hasCollisionApps &&
    !hasWinring0Collision &&
    !hardResetFailed;
  const [expanded, setExpanded] = useState(!isHealthy);

  // Mining view passes hideWhenHealthy=true so the panel only surfaces
  // inline when there's something actionable. Settings mounts the panel
  // without this prop so it's always discoverable for users who want
  // to inspect MSR / huge-pages / NUMA status on demand.
  if (hideWhenHealthy && isHealthy) {
    return null;
  }

  const summaryTag = isHealthy
    ? msrApplied
      ? "system optimized (MSR active)"
      : "system optimized"
    : disabledRows.length > 0
      ? `${disabledRows.length} item${disabledRows.length === 1 ? "" : "s"} need attention`
      : hardResetFailed
        ? "last hard reset failed"
        : "needs attention";

  return (
    <Panel
      label="Hashrate Fix Status"
      tag={summaryTag}
      pad={compact ? 10 : 14}
      right={
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse hashrate fix details" : "Expand hashrate fix details"}
          style={{
            background: "transparent",
            border: "1px solid var(--border-soft)",
            color: "var(--text-dim)",
            fontFamily: "var(--mono)",
            fontSize: 10,
            padding: "2px 8px",
            cursor: "pointer",
          }}
        >
          {expanded ? "▾ hide" : "▸ details"}
        </button>
      }
    >
      {!expanded && (
        <Mono size={labelSize} color="var(--text-dim)">
          {isHealthy
            ? "All checks passed. Click details to inspect environment flags or run advanced fixes."
            : "Click details to view what needs attention and the remediation buttons."}
        </Mono>
      )}
      {expanded && (
      <div style={{ display: "flex", flexDirection: "column", gap: sectionGap }}>

        {/* Status header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
          <Mono size={labelSize} color="var(--text-dim)" upper spacing={0.8}>Profile</Mono>
          <Mono size={valueSize} color={msrApplied ? "var(--success)" : "var(--text)"}>
            {msrApplied ? "Full (MSR active)" : "Conservative"}
          </Mono>
        </div>

        {/* Active optimizations */}
        {activeRows.length > 0 && (
          <div>
            <Mono size={labelSize} color="var(--text-dim)" upper spacing={0.8}
              style={{ display: "block", marginBottom: 4 }}>
              Active optimizations
            </Mono>
            <div style={{ display: "flex", flexDirection: "column", gap: rowGap }}>
              {activeRows.map((r) => (
                <div key={r.label} style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: valueSize, color: "var(--success)" }}>✓</span>
                  <Mono size={valueSize} color="var(--text)">{r.label}</Mono>
                  {r.sub && <Mono size={labelSize} color="var(--text-dim)">({r.sub})</Mono>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Disabled optimizations */}
        {disabledRows.length > 0 && (
          <div>
            <Mono size={labelSize} color="var(--text-dim)" upper spacing={0.8}
              style={{ display: "block", marginBottom: 4 }}>
              Disabled
            </Mono>
            <div style={{ display: "flex", flexDirection: "column", gap: rowGap }}>
              {disabledRows.map((r) => (
                <div key={r.label} style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: valueSize, color: "var(--danger)" }}>✗</span>
                  <Mono size={valueSize} color="var(--text)">{r.label}</Mono>
                  <Mono size={labelSize} color="var(--text-dim)">({r.reason})</Mono>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Collision check */}
        {(hasCollisionApps || hasWinring0Collision) && (
          <div>
            <Mono size={labelSize} color="var(--warn)" upper spacing={0.8}
              style={{ display: "block", marginBottom: 4 }}>
              ⚠ Collision detected
            </Mono>
            {hasCollisionApps && (
              <Mono size={labelSize} color="var(--text-dim)" style={{ display: "block" }}>
                Running: {p.collisionApps.join(", ")}
              </Mono>
            )}
            {hasWinring0Collision && (
              <Mono size={labelSize} color="var(--text-dim)" style={{ display: "block" }}>
                WinRing0 owned by: {p.winring0Collision}
              </Mono>
            )}
            <Mono size={labelSize} color="var(--text-dim)"
              style={{ display: "block", marginTop: 3 }}>
              PwndaWallet auto-clears the WinRing0 lock at each start — no action needed.
            </Mono>
          </div>
        )}

        {/* Live mining status (only when mining) */}
        {isMining && (status.ready || status.hugePages) && (
          <div>
            <Mono size={labelSize} color="var(--text-dim)" upper spacing={0.8}
              style={{ display: "block", marginBottom: 4 }}>
              Live status
            </Mono>
            {status.ready && (
              <Mono size={valueSize} color="var(--success)" style={{ display: "block" }}>
                READY — {status.ready.threadsActive}/{status.ready.threadsTotal} threads
              </Mono>
            )}
            {status.hugePages && (
              <Mono size={labelSize} color="var(--text-dim)" style={{ display: "block" }}>
                Huge pages: {status.hugePages.allocated}/{status.hugePages.total}
              </Mono>
            )}
          </div>
        )}

        {/* System summary */}
        <div>
          <Mono size={labelSize} color="var(--text-dim)" upper spacing={0.8}
            style={{ display: "block", marginBottom: 4 }}>
            System
          </Mono>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Stat label="Cores" value={`${p.physicalCoreCount}P / ${p.logicalCoreCount}L`} small={compact} />
            <Stat label="SMT" value={p.smtEnabled ? "on" : "off"} small={compact} />
            <Stat label="NUMA" value={`${p.numaNodeCount}`} small={compact} />
            <Stat label="HVCI" value={p.hvciOff ? "off" : "on"} small={compact} />
            <Stat label="SecBoot" value={p.secureBootOff ? "off" : "on"} small={compact} />
          </div>
        </div>

        {/* Hard Reset feedback */}
        {hardResetMessage && (
          <Mono size={labelSize}
            color={hardResetMessage.startsWith("Hard Reset failed") ? "var(--danger)" : "var(--success)"}
            style={{ display: "block" }}>
            {hardResetMessage}
          </Mono>
        )}

        {/* Buttons */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <PanelButton onClick={() => setShowWhyMsr(true)}>
            Why is MSR disabled?
          </PanelButton>
          <PanelButton onClick={() => void onRescan(true)} disabled={scanning || hardResetting}>
            {scanning ? "Scanning..." : "Re-scan"}
          </PanelButton>
          <PanelButton
            onClick={() => {
              const ok = window.confirm(
                "Hard Reset will fix the mining driver state in one UAC prompt:\n" +
                "  • Clear any WinRing0 driver collision\n" +
                "  • Refresh Defender exclusions\n" +
                "  • Grant huge-pages privilege to your user (effective at next logon)\n\n" +
                "Continue?"
              );
              if (ok) void onHardReset();
            }}
            disabled={hardResetting || scanning}
            danger
          >
            {hardResetting ? "Resetting..." : "Hard Reset Driver State"}
          </PanelButton>
        </div>
      </div>
      )}

      {showWhyMsr && (
        <WhyMsrModal plan={p} onClose={() => setShowWhyMsr(false)} />
      )}
    </Panel>
  );
}

function Stat({ label, value, small = false }: { label: string; value: string; small?: boolean }) {
  return (
    <div>
      <Mono size={small ? 7 : 8} color="var(--text-dim)" upper spacing={0.6}
        style={{ display: "block", marginBottom: 1 }}>
        {label}
      </Mono>
      <Mono size={small ? 9 : 10} color="var(--text)">{value}</Mono>
    </div>
  );
}

function PanelButton({
  children, onClick, disabled = false, danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: "var(--mono)",
        fontSize: 9,
        padding: "5px 9px",
        letterSpacing: 0.5,
        background: danger ? "rgba(255,68,68,0.12)" : "transparent",
        border: `1px solid ${danger ? "rgba(255,68,68,0.4)" : "rgba(255,255,255,0.18)"}`,
        color: danger ? "var(--danger)" : "var(--text-dim)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "all .12s",
      }}
    >
      {children}
    </button>
  );
}

function WhyMsrModal({ plan, onClose }: { plan: HashrateFixPlan; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 520, width: "calc(100% - 40px)",
          background: "var(--bg-1)",
          border: "1px solid rgba(255,255,255,0.18)",
          padding: "18px 22px",
          fontFamily: "var(--mono)",
          fontSize: 11, lineHeight: 1.6,
          color: "var(--text)",
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", fontSize: 13, letterSpacing: 0.8 }}>
          Why is MSR disabled?
        </h3>
        <p style={{ margin: "0 0 12px 0" }}>
          MSR (Model-Specific Register) optimization requires loading the WinRing0
          kernel driver, which is on Microsoft's Vulnerable Driver Blocklist. On
          your system:
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", margin: "0 0 12px 0", fontSize: 10 }}>
          <tbody>
            <Row label="Vulnerable Driver Blocklist" value={plan.blocklistOff ? "off" : "on"}
                 highlight={!plan.blocklistOff} note={!plan.blocklistOff ? "(this is the runtime gate)" : ""} />
            <Row label="Smart App Control" value={plan.sacOff ? "off / eval" : "on"}
                 highlight={!plan.sacOff} note={!plan.sacOff ? "(blocks the driver independently)" : ""} />
            <Row label="Memory Integrity (HVCI)" value={plan.hvciOff ? "off" : "on"}
                 note={plan.hvciOff ? "(informational)" : "(force-locks the blocklist toggle on)"} />
            <Row label="Secure Boot" value={plan.secureBootOff ? "off" : "on"}
                 note="(informational)" />
          </tbody>
        </table>
        <p style={{ margin: "0 0 12px 0" }}>
          To enable MSR mod, you would need to disable the Vulnerable Driver
          Blocklist via Windows Security &rarr; App &amp; browser control &rarr;
          Exploit protection settings (the toggle may be greyed out until you
          first turn off Memory Integrity in Device security &rarr; Core isolation
          and reboot).
        </p>
        <p style={{ margin: "0 0 16px 0" }}>
          PwndaWallet does not toggle Windows security features for you. Mining
          works fine without MSR — you'll see roughly a 5–15% (Ryzen) /
          15–30% (Intel) hashrate ceiling vs an MSR-tuned setup.
        </p>
        <button
          type="button"
          onClick={onClose}
          style={{
            fontFamily: "var(--mono)", fontSize: 10,
            padding: "8px 16px", letterSpacing: 0.8,
            background: "rgba(242,242,242,0.9)",
            border: "1px solid rgba(242,242,242,0.9)",
            color: "#0a0a0a",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

function Row({
  label, value, highlight = false, note = "",
}: {
  label: string;
  value: string;
  highlight?: boolean;
  note?: string;
}) {
  return (
    <tr>
      <td style={{ padding: "3px 8px 3px 0", color: "var(--text-dim)" }}>{label}</td>
      <td style={{ padding: "3px 8px", fontWeight: 600, color: highlight ? "var(--danger)" : "var(--text)" }}>
        {value}
      </td>
      <td style={{ padding: "3px 0", fontSize: 9, color: "var(--text-dim)" }}>{note}</td>
    </tr>
  );
}
