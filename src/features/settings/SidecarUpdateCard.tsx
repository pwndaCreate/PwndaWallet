import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/tauri";
import { Card } from "../../components/PrimitivesV2";
import {
  WALLET_BINARIES,
  describeWalletBinary,
  installWalletBinary,
  type WalletBinaryId,
  type WalletBinaryStatus,
} from "./walletBinaries";

interface SidecarUpdateStatus {
  enabled: boolean;
  /** Unix seconds; 0 = never checked. */
  lastCheck: number;
  wallets: WalletBinaryStatus[];
}

/**
 * "WALLET BINARIES" — what each privacy wallet runs, and the background
 * updater's switch (`src-tauri/src/sidecar_update.rs`).
 *
 * All four wallet programs ship inside the installer, gzipped, and stay
 * dormant until that wallet is first opened. Each row says whether the program
 * is unpacked, which version the installer carries, and offers Unpack (or
 * Download, for a build that carries none) when it is not unpacked yet. Until 2026-09-16 the card listed Monero and Zephyr
 * only, while the Zano and Xelis wallets told users to "Download it from
 * Settings first" — a control that did not exist.
 *
 * The toggle governs **upstream checks only** (tier 2, Monero). Reconciling
 * against the payload the installer already shipped (tier 1, all four) always
 * runs; the copy says so rather than implying the toggle stops everything.
 *
 * `SidecarUpdateList` is the wrapper-agnostic content (for the landscape
 * `<Panel>`); `SidecarUpdateCard` wraps it in the portrait `<Card>` — same
 * split as [[DataLocationsCard]]. See wiki/concepts/sidecar-bundling.
 */
export function SidecarUpdateList() {
  const [status, setStatus] = useState<SidecarUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<WalletBinaryId | null>(null);
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

  const install = async (id: WalletBinaryId) => {
    setInstalling(id);
    setErr("");
    try {
      await installWalletBinary(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
      await refresh();
    }
  };

  const lastCheck =
    !status || status.lastCheck === 0
      ? "never"
      : new Date(status.lastCheck * 1000).toLocaleString();

  return (
    <>
      <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "0 0 10px", lineHeight: 1.5 }}>
        Monero, Zephyr, Zano and Xelis each run a wallet program. All four ship
        inside the installer, compressed, and are only unpacked the first time
        you open that wallet — so they stay dormant if you never use them.
      </p>
      {!status && !err && (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Reading…</div>
      )}
      {status?.wallets.map((w) => {
        const meta = WALLET_BINARIES[w.id];
        if (!meta) return null;
        return (
          <div
            key={w.id}
            data-wallet-binary={w.id}
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              padding: "8px 10px",
              marginBottom: 6,
              fontFamily: "var(--font-mono)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-dim)",
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                }}
              >
                {meta.label} · {meta.note}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: w.present ? "var(--text)" : "var(--text-dim)",
                  marginTop: 2,
                }}
              >
                {describeWalletBinary(w)}
              </div>
            </div>
            {!w.present && (
              <button
                className="btn-primary"
                style={{ flexShrink: 0, fontSize: 11 }}
                onClick={() => void install(w.id)}
                disabled={installing !== null}
              >
                {installing === w.id ? "Installing…" : w.bundled ? "► Unpack" : "► Download"}
              </button>
            )}
          </div>
        );
      })}

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
        anything is replaced, and never while the wallet is running. Turning
        this off stops the update checks; the programs that came with your
        installer are still used, and a newer installer still replaces them.
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
    <Card title="WALLET BINARIES" style={{ marginTop: 14 }}>
      <SidecarUpdateList />
    </Card>
  );
}
