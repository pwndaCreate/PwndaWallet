import { useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { zphAdapter } from "../../wallets/zph-wallet";
import { validateZephyrSeed } from "../../wallets/zph-keys";
import { raceBestNode as raceBestZphNode } from "../../wallets/zph-nodes";
import { fetchCurrentDaemonHeight as fetchCurrentZphDaemonHeight } from "../../wallets/zph-rpc";
import type { ChainType, WalletInfo } from "../../wallets";
import { dateStringToZephyrHeight } from "../../utils/heightFromDate";

/**
 * Dashboard panel shown when Zephyr is the active chain but no ZPH
 * wallet is loaded. Mirrors `XmrImportPanel` structurally — Zephyr
 * uses a 25-word Electrum-style seed (no polyseed support), so the
 * format detection / dual-mode UI from XmrImportPanel collapses to a
 * single textarea + creation-date picker.
 *
 * Generate path: clicking "Generate new 25-word Zephyr seed" populates
 * the textarea so the user can review the seed before persisting it.
 *
 * Owns local form state. Async flow: validate → derive → cache seed
 * → race best node for the current tip (when no creation date is
 * provided) → persist to vault → start sidecar sync.
 */
export function ZphImportPanel({
  sessionPassword,
  setError,
  setWalletsByChain,
  setZphSeedLoaded,
  saveZphSeedToVault,
  startZphSync,
}: {
  sessionPassword: string | null;
  setError: (msg: string) => void;
  setWalletsByChain: React.Dispatch<
    React.SetStateAction<Partial<Record<ChainType, WalletInfo>>>
  >;
  setZphSeedLoaded: (seed: string | null) => void;
  saveZphSeedToVault: (seed: string, restoreHeight: number | null) => Promise<void>;
  startZphSync: (seed: string, masterPassword: string, restoreHeight?: number) => void;
}) {
  const [importValue, setImportValue] = useState("");
  const [importing, setImporting] = useState(false);
  const [importCreationDate, setImportCreationDate] = useState<string>("");

  const handleGenerate = async () => {
    try {
      const fresh = await zphAdapter.generateOwnSeed!();
      setImportValue(fresh);
    } catch (e: any) {
      setError(
        "Failed to generate Zephyr seed: " + (e?.message || String(e))
      );
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError("");
    try {
      const seed = importValue.trim().replace(/\s+/g, " ").toLowerCase();
      const validation = await validateZephyrSeed(seed);
      if (!validation.ok) {
        setError("Invalid Zephyr seed — " + validation.error);
        return;
      }
      const zphWallet = await zphAdapter.deriveFromOwnSeed!(seed);
      setWalletsByChain((prev) => ({ ...prev, zephyr: zphWallet }));
      setZphSeedLoaded(seed);
      setImportValue("");

      // Pick a restore height:
      //   - user-supplied creation date → convert
      //   - empty field + a reachable node → use the tip
      //     (treats it as a fresh wallet, no historical scan)
      //   - otherwise 0 (scan from genesis)
      let zphRestoreHeight: number | null = null;
      if (importCreationDate) {
        const h = dateStringToZephyrHeight(importCreationDate);
        if (h > 0) zphRestoreHeight = h;
      } else {
        try {
          const nodeUrl = await raceBestZphNode().catch(() => null);
          if (nodeUrl) {
            const h = await fetchCurrentZphDaemonHeight(nodeUrl);
            if (h > 0) zphRestoreHeight = h;
          }
        } catch {
          /* non-fatal — falls to scan-from-genesis */
        }
      }
      setImportCreationDate("");

      await saveZphSeedToVault(seed, zphRestoreHeight);
      if (!sessionPassword) {
        setError("Session password missing — please lock and unlock the wallet.");
        return;
      }
      startZphSync(seed, sessionPassword, zphRestoreHeight ?? 0);
    } catch (e: any) {
      console.error("[ZphImportPanel] import threw:", e);
      setError("Zephyr import failed: " + (e?.message || String(e)));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card title="ZEPHYR WALLET">
      <p className="no-wallet-msg">
        Zephyr uses a <strong>25-word seed</strong> (Monero-format,
        Electrum-style). Generate a fresh one below, or paste an existing seed
        to import. Zephyr doesn't support polyseed.
      </p>

      <div className="form-group">
        <label>25-word Zephyr seed</label>
        <textarea
          placeholder="Paste a 25-word Zephyr seed, or click Generate below..."
          value={importValue}
          onChange={(e) => setImportValue(e.target.value)}
          rows={4}
          disabled={importing}
        />
      </div>

      {/* Generate path: hidden while the user is typing/pasting. */}
      {!importValue.trim() && (
        <button
          className="btn-secondary"
          style={{ width: "100%", marginBottom: 10 }}
          disabled={importing}
          onClick={handleGenerate}
        >
          ► Generate new 25-word Zephyr seed
        </button>
      )}

      <div className="form-group">
        <label>Wallet creation date (optional — skips full chain scan)</label>
        <input
          type="date"
          value={importCreationDate}
          min="2023-06-02"
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => setImportCreationDate(e.target.value)}
          disabled={importing}
        />
        <p className="gas-info" style={{ marginTop: 4 }}>
          Leave blank to scan from genesis. For a freshly generated seed,
          leave blank and today's tip is used automatically.
        </p>
      </div>

      <button
        className="btn-primary"
        style={{ width: "100%" }}
        disabled={!importValue.trim() || importing}
        onClick={handleImport}
      >
        {importing ? "Validating..." : "► Save Zephyr Wallet"}
      </button>
    </Card>
  );
}
