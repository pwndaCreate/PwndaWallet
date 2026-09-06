import { useState } from "react";

/**
 * Backup screen shown after `handleCreate` stages fresh seeds. Renders
 * three terminal boxes (BIP39 + Monero polyseed + Zephyr 25-word) with
 * copy buttons, plus a confirmation checkbox the user must tick before
 * advancing to the password setup screen.
 *
 * Pending seeds are read from `useVault` (props). The Zephyr box is
 * only rendered when a Zephyr seed is staged — old vaults imported via
 * mnemonic won't have one and that block stays hidden.
 */
export function BackupView({
  pendingBip39,
  pendingXmrSeed,
  pendingZphSeed,
  onContinue,
  onCopy,
}: {
  pendingBip39: string;
  pendingXmrSeed: string;
  pendingZphSeed: string;
  onContinue: () => void;
  onCopy: (text: string) => void;
}) {
  const [backupChecked, setBackupChecked] = useState(false);

  return (
    <div className="backup-view">
      <h2>Back Up Your Wallet</h2>
      <p className="password-subtitle">
        Your wallet uses <strong>two separate seed phrases</strong>. You must
        back up BOTH. Losing either phrase means permanent loss of those funds.
      </p>

      <div className="terminal-box">
        <div className="terminal-box-title">BIP39 PHRASE — ALL OTHER CHAINS</div>
        <p className="backup-hint">
          12 words · Covers ETH, BTC, SOL, ADA, XRP, TRX, HBAR, ALGO, DOGE,
          RVN, CFX and EVM networks
        </p>
        <div className="seed-grid">
          {pendingBip39.split(" ").map((word, i) => (
            <span key={i} className="seed-word">
              <span className="seed-num">{i + 1}.</span> {word}
            </span>
          ))}
        </div>
        <button
          className="btn-icon btn-small"
          onClick={() => onCopy(pendingBip39)}
        >
          Copy phrase
        </button>
      </div>

      <div className="terminal-box" style={{ marginTop: "16px" }}>
        <div className="terminal-box-title">MONERO POLYSEED — XMR ONLY</div>
        <p className="backup-hint">
          {pendingXmrSeed.split(/\s+/).filter(Boolean).length} words · Polyseed
          format · Carries creation date so re-imports skip the full chain scan
          · Compatible with Feather, Cake, Monero GUI/CLI, Monerujo, Stack
          Wallet
        </p>
        <div className="seed-grid">
          {pendingXmrSeed.split(" ").map((word, i) => (
            <span key={i} className="seed-word">
              <span className="seed-num">{i + 1}.</span> {word}
            </span>
          ))}
        </div>
        <button
          className="btn-icon btn-small"
          onClick={() => onCopy(pendingXmrSeed)}
        >
          Copy phrase
        </button>
      </div>

      {pendingZphSeed && (
        <div className="terminal-box" style={{ marginTop: "16px" }}>
          <div className="terminal-box-title">ZEPHYR SEED — ZEPH ONLY</div>
          <p className="backup-hint">
            {pendingZphSeed.split(/\s+/).filter(Boolean).length} words · 25-word
            Electrum-style · Zephyr doesn't support polyseed · Compatible with
            zephyr-wallet, zephyr-gui, and any Monero-lineage wallet that
            accepts 25-word seeds for Zephyr.
          </p>
          <div className="seed-grid">
            {pendingZphSeed.split(" ").map((word, i) => (
              <span key={`zph-${i}`} className="seed-word">
                <span className="seed-num">{i + 1}.</span> {word}
              </span>
            ))}
          </div>
          <button
            className="btn-icon btn-small"
            onClick={() => onCopy(pendingZphSeed)}
          >
            Copy phrase
          </button>
        </div>
      )}

      <label
        className="backup-confirm-label"
        style={{
          marginTop: "20px",
          display: "flex",
          alignItems: "flex-start",
          gap: "10px",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={backupChecked}
          onChange={(e) => setBackupChecked(e.target.checked)}
          style={{ marginTop: "3px", flexShrink: 0 }}
        />
        <span>
          I have securely backed up all phrases. I understand that losing them
          means losing access to my funds permanently.
        </span>
      </label>

      <button
        className="btn-primary"
        style={{ width: "100%", marginTop: "16px" }}
        disabled={!backupChecked}
        onClick={onContinue}
      >
        ► Continue — Set Password
      </button>
    </div>
  );
}
