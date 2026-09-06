import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/tauri";
import { Card } from "../../components/PrimitivesV2";

interface SidecarUpdateStatus {
  enabled: boolean;
  /** Unix seconds; 0 = never checked. */
  lastCheck: number;
  moneroInstalled: string | null;
  zephyrInstalled: string | null;
  moneroBundled: string | null;
  zephyrBundled: string | null;
}

/**
 * "WALLET-RPC UPDATES" — visibility into, and a kill switch for, the
 * background sidecar updater (`src-tauri/src/sidecar_update.rs`).
 *
 * The updater is deliberately quiet, which is exactly why it needs a surface:
 * it replaces executables on disk, so the user should be able to see what
 * version they're on and turn the networked half off.
 *
 * The toggle governs **upstream checks only** (tier 2, Monero). Reconciling
 * against the payload the installer already shipped (tier 1) always runs —
 * it's finishing an update the user chose by upgrading the wallet, and
 * disabling it would just strand them on a superseded binary. The copy below
 * says so rather than implying the toggle stops everything.
 *
 * Zephyr pins its release at compile time (no signed hash file upstream to
 * verify against), so its sidecar only moves when the wallet does. Shown
 * explicitly so "why does Zephyr never update?" is answered in place.
 *
 * `SidecarUpdateList` is the wrapper-agnostic content (for the landscape
 * `<Panel>`); `SidecarUpdateCard` wraps it in the portrait `<Card>` — same
 * split as [[DataLocationsCard]]. See wiki/concepts/sidecar-bundling.
 */
export function SidecarUpdateList() {
  const [status, setStatus] = useState<SidecarUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<SidecarUpdateStatus>("sidecar_update_status"));
    } catch (e) {
      setErr(typeof e === "string" ? e : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (enabled: boolean) => {
    setErr("");
    // Optimistic: the command only writes a small prefs file, and a stale
    // checkbox is worse than a rare revert.
    setStatus((s) => (s ? { ...s, enabled } : s));
    try {
      await invoke("sidecar_update_set_enabled", { enabled });
    } catch (e) {
      setErr(typeof e === "string" ? e : String(e));
      await refresh();
    }
  };

  const checkNow = async () => {
    setBusy(true);
    setErr("");
    try {
      await invoke("sidecar_update_check_now");
    } catch (e) {
      setErr(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const rows: { label: string; installed: string | null; bundled: string | null; note: string }[] =
    [
      {
        label: "Monero wallet-RPC",
        installed: status?.moneroInstalled ?? null,
        bundled: status?.moneroBundled ?? null,
        note: "checked against upstream daily",
      },
      {
        label: "Zephyr wallet-RPC",
        installed: status?.zephyrInstalled ?? null,
        bundled: status?.zephyrBundled ?? null,
        note: "pinned to the wallet release",
      },
    ];

  const lastCheck =
    !status || status.lastCheck === 0
      ? "never"
      : new Date(status.lastCheck * 1000).toLocaleString();

  return (
    <>
      <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "0 0 10px", lineHeight: 1.5 }}>
        The Monero and Zephyr sections each need a wallet-RPC helper. It ships
        inside the installer, compressed, and is only unpacked the first time
        you open that chain — so it stays dormant if you never use it.
      </p>
      {rows.map((r) => (
        <div
          key={r.label}
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            padding: "8px 10px",
            marginBottom: 6,
            fontFamily: "var(--font-mono)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              letterSpacing: 0.5,
              textTransform: "uppercase",
            }}
          >
            {r.label} · {r.note}
          </div>
          <div style={{ fontSize: 11, color: "var(--text)", marginTop: 2 }}>
            {r.installed ? (
              <>
                in use: {r.installed}
                {r.bundled && r.bundled !== r.installed && (
                  <span style={{ color: "var(--text-dim)" }}> · shipped: {r.bundled}</span>
                )}
              </>
            ) : (
              <span style={{ color: "var(--text-dim)" }}>
                not unpacked yet{r.bundled ? ` · shipped: ${r.bundled}` : ""}
              </span>
            )}
          </div>
        </div>
      ))}

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          marginTop: 10,
          cursor: status ? "pointer" : "default",
        }}
      >
        <input
          type="checkbox"
          checked={status?.enabled ?? true}
          disabled={!status}
          onChange={(e) => void toggle(e.target.checked)}
        />
        Check for newer Monero releases automatically
      </label>
      <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "6px 0 0", lineHeight: 1.5 }}>
        Downloads are verified against Monero&rsquo;s signed hash list before
        anything is replaced, and never while the helper is running. Turning
        this off stops the update checks; the helper that came with your
        installer is still used.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <button className="btn-primary" onClick={() => void checkNow()} disabled={busy}>
          {busy ? "Checking…" : "► Check now"}
        </button>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          last checked: {lastCheck}
        </span>
      </div>

      {err && (
        <div className="miner-error" style={{ marginTop: 8, fontSize: 11 }}>
          {err}
        </div>
      )}
    </>
  );
}

export function SidecarUpdateCard() {
  return (
    <Card title="WALLET-RPC UPDATES" style={{ marginTop: 14 }}>
      <SidecarUpdateList />
    </Card>
  );
}
