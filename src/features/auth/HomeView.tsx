import { useState } from "react";
import { Glow } from "../../components/Primitives";
import { Btn } from "../../components/PrimitivesV2";
import { TermBox } from "../../components/TermBox";
import { BtnPrimary } from "../../components/Buttons";
import { AuthSplash } from "./AuthSplash";

/**
 * First-launch screen. Two actions: Create a new wallet (kicks off the
 * full BIP39 + XMR + ZPH seed generation in `useVault.handleCreate`) or
 * Import an existing wallet (just navigates to `view = "import"`).
 *
 * Owns its own `creating` flag — handleCreate is async, and we toggle
 * the button label / disabled state locally rather than threading a
 * shared loading flag through App.tsx.
 */
export function HomeView({
  onCreate,
  onImport,
}: {
  onCreate: () => Promise<void>;
  onImport: () => void;
}) {
  const [creating, setCreating] = useState(false);

  const handleCreateClick = async () => {
    setCreating(true);
    try {
      await onCreate();
    } finally {
      setCreating(false);
    }
  };

  return (
    <AuthSplash>
      <TermBox label="SYSTEM" style={{ width: "100%", marginBottom: 14 }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--text-dim)",
            display: "block",
            marginBottom: 8,
          }}
        >
          pwnda:~$ wallet --init
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text)",
            display: "block",
            marginBottom: 10,
            textShadow:
              "0 0 5px rgba(242,242,242,0.4), 0 0 10px rgba(242,242,242,0.2)",
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
          <Glow>→ Non-custodial. Multi-chain. Mining ready.</Glow>
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
          → Keys sealed on device. AES-256-GCM.
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "#a0a0a0",
            display: "block",
          }}
        >
          → No account. No cloud. No tracking.
        </div>
      </TermBox>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
        <BtnPrimary onClick={handleCreateClick} full disabled={creating}>
          {creating ? "Creating..." : "Create New Wallet"}
        </BtnPrimary>
        <Btn variant="ghost" onClick={onImport} full>
          Import Existing Wallet
        </Btn>
      </div>
    </AuthSplash>
  );
}
