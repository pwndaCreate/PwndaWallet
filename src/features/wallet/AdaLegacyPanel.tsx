import { useEffect, useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import {
  deriveLegacyAdaFromMnemonic,
  getLegacyAdaBalanceLovelace,
} from "../../wallets/ada-wallet";

type State =
  | { kind: "loading" }
  | { kind: "ready"; balanceLovelace: number; legacyAddress: string; legacyPrivateKey: string }
  | { kind: "empty" }
  | { kind: "error"; message: string };

/**
 * ADA-only "Legacy address" panel inside WalletDetailsCard. Surfaces the
 * `addr1v…` enterprise address that pre-2026-05-06 PwndaWallet builds
 * derived from this mnemonic — non-standard, no other wallet matches.
 *
 * Unlike the BTC sweep panel, this is **read-only**: PwndaWallet's ADA
 * tx-construction is still a placeholder (Cardano tx encoding is CBOR-
 * intensive and out of scope for the derivation fix). If the user has
 * funds at the legacy address, the panel surfaces:
 *   1. The legacy address (so they can verify it externally)
 *   2. The legacy private key (so they can import it into AdaLite /
 *      Eternl as a single-key wallet and send manually)
 *   3. A short instruction set
 *
 * Self-hides if the legacy address has zero balance (most users).
 */
export function AdaLegacyPanel(props: {
  mnemonic: string;
  onCopy: (text: string) => void;
}) {
  const { mnemonic, onCopy } = props;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    const w = deriveLegacyAdaFromMnemonic(mnemonic);
    let cancelled = false;
    getLegacyAdaBalanceLovelace(w.address)
      .then((lovelace) => {
        if (cancelled) return;
        if (lovelace > 0) {
          setState({
            kind: "ready",
            balanceLovelace: lovelace,
            legacyAddress: w.address,
            legacyPrivateKey: w.privateKey,
          });
        } else {
          setState({ kind: "empty" });
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ kind: "error", message: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [mnemonic]);

  if (state.kind === "loading") {
    return (
      <Card style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "8px 4px" }}>
          Checking legacy ADA balance…
        </div>
      </Card>
    );
  }

  if (state.kind === "empty") {
    return (
      <Card style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "8px 4px" }}>
          <ST delay={0} speed={20}>
            Legacy ADA address checked — no funds at the old derivation.
          </ST>
        </div>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10, color: "#ff6b6b", padding: "8px 4px" }}>
          Could not check legacy ADA balance: {state.message}
        </div>
      </Card>
    );
  }

  // ready
  return (
    <Card style={{ marginTop: 10 }}>
      <div className="secret-row">
        <div className="secret-header">
          <span className="label" style={{ color: "var(--accent)" }}>
            <ST delay={0} speed={20}>Legacy ADA Address (pre-2026-05-06)</ST>
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 6 }}>
          Older PwndaWallet builds produced a non-standard enterprise
          address. PwndaWallet does not yet support sending ADA from the
          legacy address directly — copy the private key below and import
          it into AdaLite / Eternl as a single-key wallet to move the funds.
        </div>
        <div className="secret-value">
          <code>{state.legacyAddress}</code>
          <button className="btn-icon" onClick={() => onCopy(state.legacyAddress)}>
            Copy
          </button>
        </div>
        <div style={{ marginTop: 8, color: "#ffae42", fontSize: 11 }}>
          Funds detected: {(state.balanceLovelace / 1_000_000).toFixed(6)} ADA
        </div>
        <div style={{ marginTop: 8 }}>
          <div className="secret-header">
            <span className="label" style={{ fontSize: 10 }}>Legacy private key</span>
            <button className="btn-icon" onClick={() => setShowKey(!showKey)}>
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
          {showKey && (
            <div className="secret-value">
              <code style={{ fontSize: 10 }}>{state.legacyPrivateKey}</code>
              <button className="btn-icon" onClick={() => onCopy(state.legacyPrivateKey)}>
                Copy
              </button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
