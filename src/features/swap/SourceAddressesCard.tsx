/**
 * Self-contained card that lazily reveals the user's derived addresses
 * for every NEAR-Intents-source-capable chain that doesn't have a
 * first-party wallet adapter yet — LTC, DOGE, BCH, SOL, NEAR. (BTC and
 * EVM addresses already render via the existing chain-picker / Dashboard
 * AccountCard.)
 *
 * The card stays sealed until the user clicks "Reveal addresses". On
 * click we prompt for the vault password, unlock a one-shot swap session,
 * query all addresses through the Rust core, then immediately re-lock —
 * the addresses are public data so we cache them in component state.
 *
 * Integrates anywhere a `<Card>` does. The existing DashboardView mounts
 * it below the active-chain card.
 */
import { useState } from "react";
import { Btn, Card } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import { getStore } from "../../store";
import type { EncryptedData } from "../../crypto";
import {
  getNearAddress,
  getSolanaAddress,
  getUtxoAddress,
  lockSwap,
  unlockSwap,
} from "../../api/swap-rust";
import { SWAP_COIN_META } from "./swap-data";

interface DerivedAddresses {
  ltc?: string;
  doge?: string;
  bch?: string;
  sol?: string;
  near?: { accountId: string; publicKey: string };
}

export function SourceAddressesCard() {
  type Stage = "sealed" | "password" | "loading" | "revealed" | "error";
  const [stage, setStage] = useState<Stage>("sealed");
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<DerivedAddresses>({});

  const reveal = async () => {
    if (!password) {
      setPwError("Enter your vault password.");
      return;
    }
    setPwError(null);
    setStage("loading");
    try {
      const store = await getStore();
      const encrypted = await store.get<EncryptedData>("wallet");
      if (!encrypted) throw new Error("No saved vault.");
      const session = await unlockSwap(encrypted, password);

      // Query all addresses in parallel — they're independent.
      const [ltc, doge, bch, sol, near] = await Promise.all([
        getUtxoAddress(session.sessionId, "ltc"),
        getUtxoAddress(session.sessionId, "doge"),
        getUtxoAddress(session.sessionId, "bch"),
        getSolanaAddress(session.sessionId),
        getNearAddress(session.sessionId),
      ]);

      setAddresses({ ltc, doge, bch, sol, near });
      setStage("revealed");
      // Public data — no need to keep the session warm.
      void lockSwap();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/decryption failed|wrong password/i.test(msg)) {
        setPwError("Incorrect password.");
        setStage("password");
      } else {
        setPwError(msg);
        setStage("error");
      }
    }
  };

  return (
    <Card title="EXTRA SOURCE ADDRESSES" style={{ marginTop: 14 }}>
      <div
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          letterSpacing: 0.5,
          marginBottom: 10,
          fontFamily: "var(--font-mono)",
          lineHeight: 1.5,
        }}
      >
        Funding addresses for chains that can act as a NEAR Intents source
        but don't have a first-party wallet view yet. Send funds to one of
        these to use it as a swap source.
      </div>

      {stage === "sealed" && (
        <Btn
          variant="ghost"
          full
          onClick={() => setStage("password")}
          caret={false}
        >
          Reveal addresses
        </Btn>
      )}

      {(stage === "password" || stage === "loading") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            className="field"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void reveal();
            }}
            placeholder="vault password"
            disabled={stage === "loading"}
            autoFocus
            style={{
              fontSize: 12,
              padding: "8px 10px",
              fontFamily: "var(--font-mono)",
            }}
          />
          {pwError && (
            <div style={{ color: "var(--danger)", fontSize: 10 }}>{pwError}</div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              variant="ghost"
              full
              caret={false}
              onClick={() => {
                setStage("sealed");
                setPassword("");
                setPwError(null);
              }}
              disabled={stage === "loading"}
            >
              Cancel
            </Btn>
            <Btn
              variant="accent"
              full
              caret={false}
              onClick={() => void reveal()}
              disabled={stage === "loading"}
            >
              {stage === "loading" ? "Deriving…" : "Unlock"}
            </Btn>
          </div>
        </div>
      )}

      {stage === "revealed" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <AddressRow ticker="LTC" address={addresses.ltc} />
          <AddressRow
            ticker="DOGE"
            address={addresses.doge}
            note="receive-only — source-tx signing in v1.1"
          />
          <AddressRow
            ticker="BCH"
            address={addresses.bch}
            note="receive-only — source-tx signing in v1.1"
          />
          <AddressRow ticker="SOL" address={addresses.sol} />
          <AddressRow
            ticker="NEAR"
            address={addresses.near?.accountId}
            note={SWAP_COIN_META.NEAR.sourcePrerequisiteHint}
          />
        </div>
      )}

      {stage === "error" && (
        <div
          style={{
            padding: "8px 10px",
            background: "rgba(255,59,59,0.08)",
            border: "1px solid rgba(255,59,59,0.4)",
            color: "var(--danger)",
            fontSize: 10,
            lineHeight: 1.4,
          }}
        >
          {pwError ?? "Failed to derive addresses."}
        </div>
      )}
    </Card>
  );
}

function AddressRow({
  ticker,
  address,
  note,
}: {
  ticker: string;
  address?: string;
  note?: string;
}) {
  const [copied, setCopied] = useState(false);
  const meta = SWAP_COIN_META[ticker];
  const explorerUrl = address && meta ? meta.explorerAddressUrl(address) : null;

  if (!address) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          fontSize: 10,
          color: "var(--text-dim)",
        }}
      >
        <CoinIcon sym={ticker} size={18} glow={false} />
        <span style={{ flex: 1 }}>{ticker}</span>
        <span>(unavailable)</span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 10px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <CoinIcon sym={ticker} size={18} glow={false} />
        <span
          style={{
            fontSize: 11,
            color: "var(--text)",
            letterSpacing: 0.5,
            textTransform: "uppercase",
            width: 50,
          }}
        >
          {ticker}
        </span>
        <code
          style={{
            flex: 1,
            color: "var(--text)",
            fontSize: 10,
            wordBreak: "break-all",
            fontFamily: "var(--font-mono)",
          }}
        >
          {address}
        </code>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noreferrer"
            title="Open in explorer"
            style={{
              color: "var(--accent)",
              fontSize: 11,
              textDecoration: "none",
              padding: "0 4px",
            }}
          >
            ↗
          </a>
        )}
        <button
          className="qbtn"
          onClick={() => {
            navigator.clipboard.writeText(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          style={{
            fontSize: 9,
            padding: "3px 8px",
            color: copied ? "var(--accent)" : "var(--text)",
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {note && (
        <div
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            paddingLeft: 26,
            letterSpacing: 0.4,
            lineHeight: 1.4,
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}
