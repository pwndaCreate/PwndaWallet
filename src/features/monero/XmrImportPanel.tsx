import { useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import {
  xmrAdapter,
  detectXmrSeedFormat,
  validateAnyXmrSeed,
  polyseedRestoreHeight,
  setActiveXmrSeed,
} from "../../wallets/xmr-wallet";
import type { ChainType, WalletInfo } from "../../wallets";
import { dateStringToMoneroHeight } from "../../utils/heightFromDate";

/**
 * Dashboard panel shown when Monero is the active chain but no XMR
 * wallet is loaded — i.e. the user restored from a BIP39 phrase (which
 * doesn't carry an XMR seed) or used "Forget Monero" earlier in the
 * session.
 *
 * Two paths:
 *   - **Generate** — produces a fresh 16-word polyseed. The seed
 *     embeds today's birthday, so sync skips the full chain scan.
 *   - **Import** — paste a 16-word polyseed (preferred) or a legacy
 *     25-word Monero seed. Format is detected automatically; the
 *     creation-date input only appears for legacy seeds.
 *
 * Owns local form state. Async flow: validate → derive → cache seed
 * → persist to vault → start sidecar sync. Errors surface via the
 * shared error banner; the in-flight flag toggles the button label
 * and disables inputs.
 */
export function XmrImportPanel({
  sessionPassword,
  setError,
  setWalletsByChain,
  setXmrSeedLoaded,
  saveXmrSeedToVault,
  startXmrSync,
}: {
  sessionPassword: string | null;
  setError: (msg: string) => void;
  setWalletsByChain: React.Dispatch<
    React.SetStateAction<Partial<Record<ChainType, WalletInfo>>>
  >;
  setXmrSeedLoaded: (seed: string | null) => void;
  saveXmrSeedToVault: (seed: string, restoreHeight: number | null) => Promise<void>;
  startXmrSync: (seed: string, masterPassword: string, restoreHeight?: number) => void;
}) {
  const [importValue, setImportValue] = useState("");
  const [importing, setImporting] = useState(false);
  const [importCreationDate, setImportCreationDate] = useState<string>("");

  const detectedFormat = detectXmrSeedFormat(importValue);
  const isLegacy = detectedFormat === "legacy";
  const isPolyseed = detectedFormat === "polyseed";

  const handleGenerate = async () => {
    try {
      const fresh = await xmrAdapter.generateOwnSeed!();
      setImportValue(fresh);
      // Polyseed embeds its own birthday; the legacy-only date input
      // stays hidden because detectXmrSeedFormat(fresh) === "polyseed".
      setImportCreationDate("");
    } catch (e: any) {
      setError(
        "Failed to generate Monero polyseed: " + (e?.message || String(e))
      );
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError("");
    try {
      const seed = importValue.trim().replace(/\s+/g, " ");
      const validation = await validateAnyXmrSeed(seed);
      if (!validation.ok) {
        setError("Invalid Monero seed — " + validation.error);
        return;
      }
      const xmrWallet = await xmrAdapter.deriveFromOwnSeed!(seed);
      setWalletsByChain((prev) => ({ ...prev, monero: xmrWallet }));
      setXmrSeedLoaded(seed);
      setActiveXmrSeed(seed);
      setImportValue("");

      // Choose a restore height per format:
      //  - polyseed: the seed encodes a ~2-week birthday
      //  - legacy:   user-supplied creation date, or null
      //              (null → scan from genesis, honest worst case)
      let xmrRestoreHeight: number | null = null;
      if (validation.format === "polyseed") {
        const h = await polyseedRestoreHeight(seed);
        if (h > 0) xmrRestoreHeight = h;
      } else if (importCreationDate) {
        const h = dateStringToMoneroHeight(importCreationDate);
        if (h > 0) xmrRestoreHeight = h;
      }
      setImportCreationDate("");

      // Persist the XMR seed into the vault using the session password
      // — no second prompt.
      await saveXmrSeedToVault(seed, xmrRestoreHeight);
      if (!sessionPassword) {
        setError("Session password missing — please lock and unlock the wallet.");
        return;
      }
      startXmrSync(seed, sessionPassword, xmrRestoreHeight ?? 0);
    } catch (e: any) {
      console.error("[XmrImportPanel] import threw:", e);
      setError("XMR import failed: " + (e?.message || String(e)));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card title="MONERO WALLET">
      <p className="no-wallet-msg">
        Generate a fresh <strong>16-word polyseed</strong> below, or paste
        an existing seed to import. Polyseed (recommended) carries its own
        creation date and syncs in seconds. Legacy <strong>25-word Monero
        seeds</strong> are also accepted — the format is detected
        automatically.
      </p>

      <div className="form-group">
        <label>
          Monero seed phrase
          {isPolyseed && " — detected: polyseed"}
          {isLegacy && " — detected: 25-word legacy"}
        </label>
        <textarea
          placeholder="Paste 16-word polyseed OR 25-word legacy seed, or click Generate below..."
          value={importValue}
          onChange={(e) => setImportValue(e.target.value)}
          rows={4}
          disabled={importing}
        />
      </div>

      {/* Generate path: hidden while the user is typing/pasting so it
          doesn't fight the textarea for attention. Mirrors ZphImportPanel. */}
      {!importValue.trim() && (
        <button
          className="btn-secondary"
          style={{ width: "100%", marginBottom: 10 }}
          disabled={importing}
          onClick={handleGenerate}
        >
          ► Generate new 16-word polyseed
        </button>
      )}

      {isLegacy && (
        <div className="form-group">
          <label>Wallet creation date (optional — skips full chain scan)</label>
          <input
            type="date"
            value={importCreationDate}
            min="2014-04-18"
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setImportCreationDate(e.target.value)}
            disabled={importing}
          />
          <p className="gas-info" style={{ marginTop: 4 }}>
            Leave blank to scan the full chain from genesis (~6-20 hours). An
            approximate date ~1 week before your first transaction is plenty —
            the scanner biases back 30 days for safety.
          </p>
        </div>
      )}

      <button
        className="btn-primary"
        style={{ width: "100%" }}
        disabled={!importValue.trim() || importing}
        onClick={handleImport}
      >
        {importing ? "Validating..." : "► Save Monero Wallet"}
      </button>
    </Card>
  );
}
