import { useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import type { ChainType, WalletInfo } from "../../wallets";
import { xelisAdapter } from "../../wallets/xelis-wallet";
import { XELIS_SEED_WORD_COUNT } from "../../wallets/xelis-keys";
import { errorText } from "../../lib/errorText";
import { checkXelisSeed, xelisOfflineAddress, xelisWalletInfo } from "./xelisSeed";

/**
 * Shown when Xelis is the active chain and this wallet has no Xelis wallet.
 * Counterpart of `ZanoImportPanel`, mounted by portrait `DashboardView` and by
 * landscape through `LandscapeRoot`'s `xelisCenterSlot`, which
 * `WalletLandscapeView` renders in its no-wallet branch.
 *
 * Two things differ from Zano's panel, both on purpose:
 *
 *  - It says, every time, that a Monero or Zephyr seed passes these checks.
 *    XELIS's English wordlist is Monero's, word for word, and its checksum word
 *    is chosen the same way, so nothing here can tell the coins apart. Words
 *    restored as the wrong coin open a different, empty wallet, not an error.
 *  - It saves BEFORE it shows the wallet or starts it, and starts the wallet
 *    in the directory the saved entry names. Zano's panel used to start its
 *    session without the entry's file, so its first session opened Zano's
 *    legacy filename while the entry named another — and because Zano's
 *    address cross-check then force-recreates, an import could DELETE the
 *    migrated primary's wallet file. Fixed 2026-09-15 in 6c6669b; both panels
 *    now save first and open the file the saved entry names.
 */
export function XelisImportPanel({
  sessionPassword,
  setError,
  setWalletsByChain,
  setXelisSeedLoaded,
  saveXelisSeedToVault,
  startXelisSync,
}: {
  sessionPassword: string | null;
  setError: (msg: string) => void;
  setWalletsByChain: React.Dispatch<
    React.SetStateAction<Partial<Record<ChainType, WalletInfo>>>
  >;
  setXelisSeedLoaded: (seed: string | null) => void;
  /** Resolves the saved entry's wallet directory, or null when nothing was
   *  saved (the vault hook has already reported why). */
  saveXelisSeedToVault: (seed: string) => Promise<string | null>;
  startXelisSync: (seed: string, masterPassword: string, walletFile?: string) => void;
}) {
  const [importValue, setImportValue] = useState("");
  const [generated, setGenerated] = useState(false);
  const [importing, setImporting] = useState(false);

  const trimmed = importValue.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  const verdict = trimmed ? checkXelisSeed(importValue) : null;
  const stillTyping =
    verdict?.status === "invalid" &&
    verdict.problem.kind === "word-count" &&
    wordCount < XELIS_SEED_WORD_COUNT;
  const previewAddress = verdict?.status === "valid" ? xelisOfflineAddress(verdict.seed) : null;

  const handleGenerate = async () => {
    setError("");
    try {
      const fresh = await xelisAdapter.generateOwnSeed!();
      setImportValue(fresh);
      setGenerated(true);
    } catch (e) {
      setError("Couldn't generate a Xelis seed: " + errorText(e));
    }
  };

  const handleSave = async () => {
    setError("");
    const current = checkXelisSeed(importValue);
    if (current.status !== "valid") {
      setError(current.message);
      return;
    }
    if (!sessionPassword) {
      setError("Session password missing. Lock and unlock the wallet, then try again.");
      return;
    }
    setImporting(true);
    try {
      const walletFile = await saveXelisSeedToVault(current.seed);
      if (!walletFile) return;
      setWalletsByChain((prev) => ({ ...prev, xelis: xelisWalletInfo(current.seed) }));
      setXelisSeedLoaded(current.seed);
      setImportValue("");
      setGenerated(false);
      startXelisSync(current.seed, sessionPassword, walletFile);
    } catch (e) {
      setError("Xelis import failed: " + errorText(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card title="XELIS WALLET">
      <p className="no-wallet-msg">
        Xelis uses its own <strong>25-word seed</strong>, separate from this
        wallet's recovery phrase. Generate a new one, or paste the seed of an
        existing Xelis wallet.
      </p>

      <p className="hint" style={{ lineHeight: 1.55, color: "var(--text-muted)" }} data-xelis-coin-warning>
        <strong style={{ color: "var(--warn)" }}>Check the coin:</strong> Xelis,
        Monero and Zephyr seeds are all 25 words from the same wordlist with the
        same checksum, so nothing on this screen can tell them apart. A Monero
        or Zephyr seed pasted here is accepted and opens a{" "}
        <strong>valid but empty</strong> Xelis wallet: no error, no funds, and
        the coins stay where they are. Only import words you know came from a
        Xelis wallet.
      </p>

      <div className="form-group">
        <label>Xelis seed phrase</label>
        <textarea
          placeholder="Paste a 25-word Xelis seed, or generate a new one below…"
          value={importValue}
          onChange={(e) => {
            setImportValue(e.target.value);
            setGenerated(false);
          }}
          rows={4}
          spellCheck={false}
          disabled={importing}
        />
      </div>

      {verdict && (
        <div
          data-xelis-seed-status={stillTyping ? "typing" : verdict.status}
          style={{ fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.5, marginBottom: 10 }}
        >
          {verdict.status === "valid" ? (
            <>
              <div style={{ color: "var(--accent)" }}>✓ Valid Xelis seed.</div>
              {previewAddress ? (
                <>
                  <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
                    Address (check it is the wallet you expect):
                  </div>
                  <div style={{ color: "var(--text)", wordBreak: "break-all", userSelect: "all" }}>
                    {previewAddress}
                  </div>
                </>
              ) : (
                <div style={{ color: "var(--text-dim)" }}>
                  The address is shown once the wallet opens.
                </div>
              )}
            </>
          ) : verdict.status === "unavailable" ? (
            <div style={{ color: "var(--warn)" }}>{verdict.message}</div>
          ) : stillTyping ? (
            <div style={{ color: "var(--text-dim)" }}>
              {wordCount} of {XELIS_SEED_WORD_COUNT} words.
            </div>
          ) : (
            <div style={{ color: "#ff6666" }}>{verdict.message}</div>
          )}
        </div>
      )}

      {generated && trimmed && (
        <p className="hint" style={{ color: "var(--warn)", lineHeight: 1.5 }} data-xelis-new-seed>
          New seed. Write these 25 words down, labelled as a Xelis seed, before
          you save. They are the only way to recover this wallet.
        </p>
      )}

      {!trimmed && (
        <button
          className="btn-secondary"
          style={{ width: "100%", marginBottom: 10 }}
          disabled={importing}
          onClick={() => void handleGenerate()}
        >
          ► Generate new Xelis seed
        </button>
      )}

      <button
        className="btn-primary"
        style={{ width: "100%" }}
        disabled={verdict?.status !== "valid" || importing}
        onClick={() => void handleSave()}
      >
        {importing ? "Saving…" : "► Save Xelis Wallet"}
      </button>
    </Card>
  );
}
