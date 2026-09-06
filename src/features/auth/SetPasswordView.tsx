import { useState } from "react";

/**
 * Vault password setup screen — last step of the create/import flow.
 * Two password fields and a submit button. The submit handler
 * (`onSubmit`) lives in `useVault` and is responsible for probing
 * restore heights, encrypting the vault, kicking off both syncs,
 * and routing the view to the dashboard.
 *
 * Owns local `password` / `confirmPassword` / `savingPassword` state.
 */
export function SetPasswordView({
  onSubmit,
}: {
  onSubmit: (password: string, confirmPassword: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const handleSubmit = async () => {
    if (!password || !confirmPassword) return;
    setSavingPassword(true);
    try {
      await onSubmit(password, confirmPassword);
      // useVault.handleSetPassword clears its own pending seeds + sets view.
      // Local fields cleared here so a back-navigation doesn't leak the
      // previous password into the inputs.
      setPassword("");
      setConfirmPassword("");
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="set-password-view">
      <h2>Secure Your Wallet</h2>
      <p className="password-subtitle">
        Set a password to encrypt and save your wallet. You'll use this
        password to unlock your wallet when you reopen the app.
      </p>
      <div className="terminal-box">
        <div className="terminal-box-title">SET PASSWORD</div>
        <div className="form-group">
          <label>Password (min 4 characters)</label>
          <input
            type="password"
            placeholder="Enter password..."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </div>
        <div className="form-group">
          <label>Confirm Password</label>
          <input
            type="password"
            placeholder="Confirm password..."
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password && confirmPassword) handleSubmit();
            }}
          />
        </div>
        <button
          className="btn-primary"
          onClick={handleSubmit}
          disabled={!password || !confirmPassword || savingPassword}
          style={{ width: "100%" }}
        >
          {savingPassword ? "Encrypting & Saving..." : "► Save & Continue"}
        </button>
      </div>
      <p className="password-note">
        Your seed phrase will be encrypted with AES-256-GCM and stored locally.
        The password is never saved — only you can unlock your wallet.
      </p>
    </div>
  );
}
