import { useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { zanoAdapter } from "../../wallets/zano-wallet";
import {
  validateZanoSeed,
  normalizeZanoSeed,
  readZanoSeedMeta,
  verifyZanoSeedIntegrity,
  zanoAddressFromSeed,
} from "../../wallets/zano-keys";
import type { ChainType, WalletInfo } from "../../wallets";

/**
 * Dashboard panel shown when Zano is the active chain but no wallet is
 * loaded. Structural parallel to `ZphImportPanel`, with two real
 * differences rather than copied-over ones:
 *
 *  - **No restore-height picker.** Zephyr's creation date has to be supplied
 *    externally because the seed doesn't carry it. Zano's DOES — seed word
 *    25 self-encodes the creation week (verified in `zano-keys.ts`), and
 *    `ensureZanoWallet`'s CLI restore already uses it automatically. Adding
 *    a redundant date picker here would be confusing, not thorough.
 *  - **Secured-Seed passphrase field**, which Zephyr has no equivalent of.
 *    Shown conditionally once the pasted seed's word 25 declares it's
 *    needed (`readZanoSeedMeta`), so the user isn't asked for a passphrase
 *    on every ordinary seed. A wrong passphrase cannot be detected here —
 *    see `zano-keys.ts`'s header — so the copy says so plainly rather than
 *    implying the button validates it.
 *
 * `saveZanoSeedToVault` is accepted as a prop for structural parity with
 * `ZphImportPanel`, but Zano has no vault-persistence wiring yet (see the
 * plan's Phase 5 status) — the caller currently passes a no-op. The session
 * this panel starts is real and works for the current app run; it just
 * won't survive a restart until that wiring lands.
 */
export function ZanoImportPanel({
  sessionPassword,
  setError,
  setWalletsByChain,
  setZanoSeedLoaded,
  saveZanoSeedToVault,
  startZanoSync,
}: {
  sessionPassword: string | null;
  setError: (msg: string) => void;
  setWalletsByChain: React.Dispatch<
    React.SetStateAction<Partial<Record<ChainType, WalletInfo>>>
  >;
  setZanoSeedLoaded: (seed: string | null) => void;
  saveZanoSeedToVault: (seed: string, passphrase: string) => Promise<void>;
  startZanoSync: (seed: string, masterPassword: string, passphrase?: string) => void;
}) {
  const [importValue, setImportValue] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [importing, setImporting] = useState(false);

  const normalized = importValue.trim() ? normalizeZanoSeed(importValue) : "";
  let meta: ReturnType<typeof readZanoSeedMeta> | null = null;
  try {
    if (normalized) meta = readZanoSeedMeta(normalized);
  } catch {
    meta = null; // malformed input — handled on submit, not here
  }
  const needsPassphrase = meta?.passwordProtected === true;
  const isAuditable = meta?.auditable === true;

  const handleGenerate = async () => {
    try {
      const fresh = await zanoAdapter.generateOwnSeed!();
      setImportValue(fresh);
      setPassphrase("");
    } catch (e: any) {
      setError("Failed to generate Zano seed: " + (e?.message || String(e)));
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError("");
    try {
      const seed = normalizeZanoSeed(importValue);
      if (!validateZanoSeed(seed)) {
        setError("Invalid Zano seed phrase — check the word count and spelling.");
        return;
      }
      const seedMeta = readZanoSeedMeta(seed);
      if (seedMeta.auditable) {
        setError(
          "This is an auditable Zano seed. Auditable wallets aren't supported yet."
        );
        return;
      }
      if (seedMeta.passwordProtected && !passphrase) {
        setError("This seed is password-protected — enter its Secured Seed passphrase.");
        return;
      }

      /**
       * Verify the seed (and passphrase, when there is one) against word 26
       * BEFORE deriving anything.
       *
       * Added 2026-08-28. Until then this panel derived whatever it was
       * given: a wrong Secured-Seed passphrase decrypts the 24 words to
       * different plaintext and yields a perfectly well-formed `Zx…` address
       * for a wallet nobody controls, and a mistyped seed word does the same.
       * Both were silent. Measured on the pinned vector, `seedpw457` (one
       * digit out) and `Seedpw456` (one case out) each produce a valid
       * 97-character address.
       *
       * The checksum catches ~99.9% of those (1-in-813 false accepts), so it
       * is a strong filter and NOT a proof — which is why the copy still asks
       * the user to confirm the address, and why the sidecar cross-check in
       * `initZanoSession` stays.
       */
      const integrity = verifyZanoSeedIntegrity(seed, passphrase);
      if (!integrity.ok && integrity.kind === "checksum") {
        setError(
          seedMeta.passwordProtected
            ? "That passphrase does not match this seed. Zano mixes the " +
                "passphrase into the seed itself, so a wrong one silently " +
                "unlocks a different, empty wallet — check it and try again."
            : "This seed's checksum does not match. A word is probably " +
                "mistyped or out of order — check it against your backup."
        );
        return;
      }

      if (!sessionPassword) {
        setError("Session password missing — please lock and unlock the wallet.");
        return;
      }

      // Address derived offline immediately (fast, no sidecar needed) so
      // the dashboard has something to show while the sidecar spins up.
      // NOT `zanoAdapter.deriveFromOwnSeed` — that throws by design for
      // password-protected seeds (it has nowhere to collect a passphrase);
      // this panel is exactly the caller `zano-wallet.ts` tells the user to
      // use instead. A WRONG passphrase still produces a valid-looking
      // address here — `initZanoSession` (via startZanoSync below) is what
      // actually cross-checks it against the sidecar-reported address.
      const address = zanoAddressFromSeed(seed, passphrase);
      setWalletsByChain((prev) => ({
        ...prev,
        zano: { chain: "zano", address, mnemonic: seed, privateKey: "" },
      }));
      setZanoSeedLoaded(seed);
      setImportValue("");
      setPassphrase("");

      await saveZanoSeedToVault(seed, passphrase);
      startZanoSync(seed, sessionPassword, passphrase);
    } catch (e: any) {
      console.error("[ZanoImportPanel] import threw:", e);
      setError("Zano import failed: " + (e?.message || String(e)));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card title="ZANO WALLET">
      <p className="no-wallet-msg">
        Zano uses an independent <strong>26-word seed</strong> (its own
        wordlist — not Monero's). Generate a fresh one below, or paste an
        existing seed to import.
      </p>

      {/* Zano-specific disclosure (2026-08-28).
          Deliberately shown on BOTH paths — generate and import — because the
          consequence differs but the mechanism is the same, and a user who
          only ever reads this screen once should read it before they have a
          seed to lose. Kept to two sentences; the mechanism detail lives in
          the wiki, not in the panel. */}
      <p
        className="hint"
        style={{ lineHeight: 1.55, color: "var(--text-muted)" }}
      >
        <strong style={{ color: "var(--warn)" }}>Zano-specific:</strong> if a
        seed has a Secured&nbsp;Seed passphrase, that passphrase is part of the
        wallet itself — not a lock on this app. Restoring the same 26 words
        with a different passphrase opens a{" "}
        <strong>different, empty wallet</strong>, so back up the passphrase
        wherever you back up the words.{" "}
        {needsPassphrase
          ? "This wallet's password does not affect it."
          : "Seeds generated here have no passphrase, so there is nothing extra to keep."}
      </p>

      <div className="form-group">
        <label>Zano seed phrase</label>
        <textarea
          placeholder="Paste a Zano seed phrase, or click Generate below..."
          value={importValue}
          onChange={(e) => setImportValue(e.target.value)}
          rows={4}
          disabled={importing}
        />
      </div>

      {isAuditable && (
        <p className="hint" style={{ color: "#e74c3c" }}>
          This seed is for an auditable wallet, which isn't supported yet.
        </p>
      )}

      {needsPassphrase && !isAuditable && (
        <div className="form-group">
          <label>Secured Seed passphrase</label>
          <input
            type="password"
            placeholder="Required for this seed"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={importing}
          />
          <p className="gas-info" style={{ marginTop: 4 }}>
            This seed is password-protected. A wrong passphrase can't be
            detected automatically — it silently derives a different wallet.
            Double-check it before continuing.
          </p>
        </div>
      )}

      {!importValue.trim() && (
        <button
          className="btn-secondary"
          style={{ width: "100%", marginBottom: 10 }}
          disabled={importing}
          onClick={handleGenerate}
        >
          ► Generate new Zano seed
        </button>
      )}

      <button
        className="btn-primary"
        style={{ width: "100%" }}
        disabled={!importValue.trim() || importing || isAuditable}
        onClick={handleImport}
      >
        {importing ? "Validating..." : "► Save Zano Wallet"}
      </button>
    </Card>
  );
}
