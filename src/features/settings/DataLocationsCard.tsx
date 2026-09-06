import { useEffect, useState } from "react";
import { invoke } from "../../lib/tauri";
import { Card } from "../../components/PrimitivesV2";

interface DataLocations {
  dataDir: string;
  miners: string;
  moneroDaemon: string;
  zephyrDaemon: string;
  xmrWallets: string;
  zphWallets: string;
}

/**
 * "FILES ON DISK" — where the app stores its wallet-RPC daemons, the per-chain
 * wallet + scanned-chain cache (what users call "the blockchain"), and the
 * miner binaries; click any path to open it in the OS file manager.
 *
 * Paths come from the Rust `get_data_locations` command; opening goes through
 * `open_data_location` (a fixed location KEY, never a raw path — the webview
 * can't open arbitrary directories). See wiki/concepts/install-data-locations
 * and [[surfaces-matrix]].
 *
 * NOTE on "the blockchain": XMR/ZPH do NOT download a full blockchain — the
 * wallet-rpc sidecars sync against REMOTE nodes; only the wallet file + its
 * scanned-output cache live under `xmr-wallets` / `zph-wallets`.
 *
 * `DataLocationsList` is the wrapper-agnostic content (used directly inside the
 * landscape `<Panel>`); `DataLocationsCard` wraps it in the portrait `<Card>`.
 */
export function DataLocationsList() {
  const [locs, setLocs] = useState<DataLocations | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    invoke<DataLocations>("get_data_locations")
      .then(setLocs)
      .catch((e) => setErr(typeof e === "string" ? e : String(e)));
  }, []);

  const open = async (which: string) => {
    setBusy(which);
    setErr("");
    try {
      await invoke("open_data_location", { which });
    } catch (e) {
      setErr(
        "Couldn't open folder: " +
          (typeof e === "string" ? e : (e as Error).message)
      );
    } finally {
      setBusy(null);
    }
  };

  const rows: { key: string; label: string; path?: string }[] = [
    { key: "data", label: "App data folder (everything is under here)", path: locs?.dataDir },
    { key: "monero", label: "Monero wallet-RPC daemon", path: locs?.moneroDaemon },
    { key: "zephyr", label: "Zephyr wallet-RPC daemon", path: locs?.zephyrDaemon },
    { key: "xmr-wallets", label: "Monero wallet + chain cache", path: locs?.xmrWallets },
    { key: "zph-wallets", label: "Zephyr wallet + chain cache", path: locs?.zphWallets },
    { key: "miners", label: "Miner binaries", path: locs?.miners },
  ];

  return (
    <>
      {rows.map((r) => (
        <button
          key={r.key}
          onClick={() => open(r.key)}
          disabled={!locs || busy !== null}
          title={r.path ? `Open ${r.path}` : "Open folder"}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 0,
            padding: "8px 10px",
            marginBottom: 6,
            cursor: locs ? "pointer" : "default",
            fontFamily: "var(--font-mono)",
          }}
        >
          <div style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: 0.5, textTransform: "uppercase" }}>
            {r.label} {busy === r.key ? "· opening…" : "↗"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text)", wordBreak: "break-all", marginTop: 2 }}>
            {r.path ?? "…"}
          </div>
        </button>
      ))}
      {err && (
        <div className="miner-error" style={{ marginTop: 8, fontSize: 11 }}>
          {err}
        </div>
      )}
    </>
  );
}

export function DataLocationsCard() {
  return (
    <Card title="FILES ON DISK">
      <DataLocationsList />
    </Card>
  );
}
