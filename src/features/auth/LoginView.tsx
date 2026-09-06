import { useState } from "react";
import { Glow } from "../../components/Primitives";
import { Btn, Card } from "../../components/PrimitivesV2";
import { BtnPrimary, BtnGhost } from "../../components/Buttons";
import { AuthSplash } from "./AuthSplash";

/**
 * Unlock screen for users with a saved vault. Two actions: enter the
 * password and unlock, or open the danger-zone confirmation to wipe
 * the saved vault and start fresh.
 *
 * Owns its own `loginPassword`, `unlocking`, and `showRemoveConfirm`
 * state. `onUnlock` and `onRemoveWallet` are vault actions.
 */
export function LoginView({
  onUnlock,
  onRemoveWallet,
}: {
  onUnlock: (password: string) => Promise<void>;
  onRemoveWallet: () => Promise<void>;
}) {
  const [loginPassword, setLoginPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  const handleUnlockClick = async () => {
    if (!loginPassword) return;
    setUnlocking(true);
    try {
      await onUnlock(loginPassword);
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <AuthSplash>
      <Card title="SYSTEM" style={{ width: "100%", marginBottom: 14 }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--text-dim)",
            display: "block",
            marginBottom: 8,
          }}
        >
          Last login: {new Date().toLocaleString()} on tty1
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text)",
            display: "block",
            marginBottom: 10,
          }}
        >
          <Glow>Welcome to PWNDA — Wallet Terminal v2.0.1</Glow>
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--text)",
            display: "block",
            marginBottom: 3,
          }}
        >
          <Glow>→ Vault encrypted. AES-256-GCM.</Glow>
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "#a0a0a0",
            display: "block",
            marginBottom: 3,
          }}
        >
          → Keys sealed on device.
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "#a0a0a0",
            display: "block",
          }}
        >
          → Awaiting passphrase…
        </div>
      </Card>
      <Card title="UNLOCK" style={{ width: "100%", marginBottom: 12 }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--text-dim)",
            marginBottom: 6,
            display: "block",
          }}
        >
          $ decrypt --vault pwnda.vault
        </div>
        <input
          type="password"
          placeholder="Enter password..."
          value={loginPassword}
          onChange={(e) => setLoginPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && loginPassword) handleUnlockClick();
          }}
          autoFocus
          style={{ marginBottom: 10 }}
        />
        <BtnPrimary
          onClick={handleUnlockClick}
          disabled={!loginPassword || unlocking}
          full
        >
          {unlocking ? "Decrypting vault..." : "Unlock Wallet"}
        </BtnPrimary>
      </Card>
      <div
        style={{
          width: "100%",
          borderTop: "1px solid var(--border)",
          margin: "8px 0",
          opacity: 0.4,
        }}
      />
      {!showRemoveConfirm ? (
        <Btn
          variant="danger"
          size="sm"
          caret={false}
          onClick={() => setShowRemoveConfirm(true)}
        >
          Remove Saved Wallet & Start Fresh
        </Btn>
      ) : (
        <div
          style={{
            width: "100%",
            padding: "12px 14px",
            border: "1px solid var(--danger)",
            background: "rgba(255,68,68,0.08)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--danger)",
              marginBottom: 10,
            }}
          >
            This will permanently delete your saved wallet. Make sure you have
            your seed phrase backed up!
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <BtnGhost onClick={() => setShowRemoveConfirm(false)}>Cancel</BtnGhost>
            <Btn variant="danger" full onClick={onRemoveWallet}>
              Remove Wallet
            </Btn>
          </div>
        </div>
      )}
    </AuthSplash>
  );
}
