import { useEffect, useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import {
  deriveLegacyBtcFromMnemonic,
  getLegacyBtcBalanceSats,
  sweepLegacyBtcToAddress,
} from "../../wallets/btc-wallet";

type SweepState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; balanceSats: number }
  | { kind: "empty" }
  | { kind: "sweeping" }
  | { kind: "swept"; txid: string }
  | { kind: "error"; message: string };

/**
 * BTC-only "Legacy address" panel shown inside WalletDetailsCard. Surfaces
 * the address that pre-2026-05-06 PwndaWallet builds derived from this
 * mnemonic — `m/44'/0'/0'/0/0` encoded as P2WPKH bech32, a non-standard
 * combination — and offers a one-shot sweep to the standard BIP-84
 * address. Self-hides if the legacy address has no balance.
 *
 * Three states the user might see:
 *   1. Legacy address has zero balance (most users, including all
 *      newly-imported-from-Exodus wallets) — quiet "checked" line.
 *   2. Legacy address has funds — alert + Sweep button.
 *   3. After a successful sweep — txid + explorer link.
 *
 * The sweep is a single one-input-many-or-one-output PSBT broadcast via
 * mempool.space / blockstream.info. No multi-step ceremony; the legacy
 * key signs in-process and the user sees the txid immediately.
 */
export function BtcLegacyPanel(props: {
  mnemonic: string;
  standardAddress: string;
  onCopy: (text: string) => void;
}) {
  const { mnemonic, standardAddress, onCopy } = props;
  const [legacyAddress, setLegacyAddress] = useState<string>("");
  const [legacyPrivateKey, setLegacyPrivateKey] = useState<string>("");
  const [state, setState] = useState<SweepState>({ kind: "idle" });

  useEffect(() => {
    const w = deriveLegacyBtcFromMnemonic(mnemonic);
    setLegacyAddress(w.address);
    setLegacyPrivateKey(w.privateKey);
    setState({ kind: "loading" });
    let cancelled = false;
    getLegacyBtcBalanceSats(w.address)
      .then((sats) => {
        if (cancelled) return;
        if (sats > 0) setState({ kind: "ready", balanceSats: sats });
        else setState({ kind: "empty" });
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ kind: "error", message: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [mnemonic]);

  const handleSweep = async () => {
    setState({ kind: "sweeping" });
    try {
      const result = await sweepLegacyBtcToAddress(legacyPrivateKey, standardAddress);
      setState({ kind: "swept", txid: result.hash });
    } catch (e: any) {
      setState({ kind: "error", message: e?.message || String(e) });
    }
  };

  // Quiet — don't take up space when there's nothing to surface and no
  // error. Most users will never see this panel because their seed was
  // either created post-fix (no legacy) or they just imported and have
  // no funds at the legacy derivation.
  if (state.kind === "empty") {
    return (
      <Card style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "8px 4px" }}>
          <ST delay={0} speed={20}>
            Legacy BTC address checked — no funds at the old derivation.
          </ST>
        </div>
      </Card>
    );
  }

  return (
    <Card style={{ marginTop: 10 }}>
      <div className="secret-row">
        <div className="secret-header">
          <span className="label" style={{ color: "var(--accent)" }}>
            <ST delay={0} speed={20}>Legacy BTC Address (pre-2026-05-06)</ST>
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 6 }}>
          Older PwndaWallet builds derived this address from a non-standard
          BIP-44 path. If you funded this address while running an older build,
          sweep it to your standard address now.
        </div>
        {legacyAddress && (
          <div className="secret-value">
            <code>{legacyAddress}</code>
            <button className="btn-icon" onClick={() => onCopy(legacyAddress)}>
              Copy
            </button>
          </div>
        )}
        {state.kind === "loading" && (
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
            Checking balance…
          </div>
        )}
        {state.kind === "ready" && (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: "#ffae42", fontSize: 11, marginBottom: 8 }}>
              Funds detected: {(state.balanceSats / 1e8).toFixed(8)} BTC
            </div>
            <button
              className="btn-icon"
              style={{ background: "var(--accent)", color: "#000" }}
              onClick={handleSweep}
            >
              Sweep to standard address
            </button>
          </div>
        )}
        {state.kind === "sweeping" && (
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
            Building + broadcasting sweep transaction…
          </div>
        )}
        {state.kind === "swept" && (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: "var(--accent)", fontSize: 11, marginBottom: 4 }}>
              Sweep broadcast.
            </div>
            <div className="secret-value">
              <code style={{ fontSize: 10 }}>{state.txid}</code>
              <button className="btn-icon" onClick={() => onCopy(state.txid)}>
                Copy
              </button>
            </div>
            <a
              href={`https://mempool.space/tx/${state.txid}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4, display: "inline-block" }}
            >
              View on mempool.space →
            </a>
          </div>
        )}
        {state.kind === "error" && (
          <div style={{ color: "#ff6b6b", fontSize: 10, marginTop: 6 }}>
            {state.message}
          </div>
        )}
      </div>
    </Card>
  );
}
