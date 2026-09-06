import { useState } from "react";
import {
  ALL_CHAINS,
  getAdapter,
  type ChainType,
} from "../../wallets";

/**
 * Import existing wallet — two tabs (mnemonic phrase / private key).
 *
 * Mnemonic mode: user pastes a 12-word BIP39 phrase. `onImport`
 * derives all non-XMR chains and routes to setPassword.
 *
 * Private-key mode: user picks a chain and pastes its raw key.
 * Skips XMR (use the dashboard XMR import panel for that).
 *
 * Owns local `importType` and `importValue` state. Active chain
 * comes from `AppStateContext` via App.tsx — it's used both for the
 * dropdown selection and as input to the import handler.
 */
export function ImportView({
  activeChain,
  setActiveChain,
  onImport,
  onBack,
}: {
  activeChain: ChainType;
  setActiveChain: (c: ChainType) => void;
  onImport: (
    importType: "mnemonic" | "privateKey",
    importValue: string,
    activeChain: ChainType,
  ) => Promise<void> | void;
  onBack: () => void;
}) {
  const [importType, setImportType] = useState<"mnemonic" | "privateKey">("mnemonic");
  const [importValue, setImportValue] = useState("");
  const [importing, setImporting] = useState(false);
  const adapter = getAdapter(activeChain);

  const handleSubmit = async () => {
    if (importing) return;
    setImporting(true);
    try {
      await onImport(importType, importValue, activeChain);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="import-view">
      <div className="terminal-box">
        <div className="terminal-box-title">IMPORT WALLET</div>

        {importType === "privateKey" && (
          <div className="chain-dropdown-wrapper">
            <label className="dropdown-label">Select Chain</label>
            <select
              className="chain-dropdown"
              value={activeChain}
              onChange={(e) => setActiveChain(e.target.value as ChainType)}
              style={
                {
                  "--chain-color": adapter.color,
                } as React.CSSProperties
              }
            >
              {ALL_CHAINS.map((chain) => {
                const a = getAdapter(chain);
                return (
                  <option key={chain} value={chain}>
                    {a.displayName} ({a.ticker})
                  </option>
                );
              })}
            </select>
          </div>
        )}

        <div className="tab-row">
          <button
            className={importType === "mnemonic" ? "tab active" : "tab"}
            onClick={() => setImportType("mnemonic")}
          >
            Mnemonic Phrase
          </button>
          <button
            className={importType === "privateKey" ? "tab active" : "tab"}
            onClick={() => setImportType("privateKey")}
          >
            Private Key
          </button>
        </div>
        <textarea
          placeholder={
            importType === "mnemonic"
              ? "Enter your 12-word BIP39 phrase (covers all chains except Monero)..."
              : `Enter your ${adapter.displayName} private key...`
          }
          value={importValue}
          onChange={(e) => setImportValue(e.target.value)}
          rows={4}
          disabled={importing}
        />
        {importType === "privateKey" && (
          <>
            <p className="import-note">
              Private key imports only work for the selected chain. Use a
              mnemonic phrase to import all chains at once.
            </p>
            <p className="import-note" style={{ color: "var(--warn)" }}>
              ⚠ Imported here (before a vault exists) this key is{" "}
              <strong>session-only</strong> — it is <strong>not saved</strong> and
              is lost on restart. To keep it, first create or restore a wallet,
              then add the key from Settings ▸ Wallets (it persists there).
            </p>
          </>
        )}
        {importing && importType === "mnemonic" && (
          <p
            className="import-note"
            style={{ color: "var(--accent)" }}
          >
            Scanning derivation paths for BTC, SOL, and ADA — ~5–10s
            depending on RPC latency. We'll auto-select the recommended
            path for each chain; you can switch any of them later from
            the wallet's per-chain card.
          </p>
        )}
        <div className="button-row">
          <button
            className="btn-secondary"
            onClick={onBack}
            disabled={importing}
          >
            ► Back
          </button>
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={!importValue.trim() || importing}
          >
            {importing
              ? importType === "mnemonic"
                ? "Scanning…"
                : "Importing…"
              : "► Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
