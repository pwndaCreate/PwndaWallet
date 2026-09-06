import { useEffect, useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import {
  detectAll,
  type FullDetectionResult,
  type ChainDetectionResult,
  type DerivationChoice,
  DEFAULT_DERIVATION_CHOICE,
} from "./derivation-detector";

type Phase =
  | { kind: "scanning" }
  | { kind: "ready"; result: FullDetectionResult }
  | { kind: "error"; message: string };

/**
 * Shown after mnemonic-import, before setPassword. Scans BTC / SOL / ADA
 * candidate paths in parallel and lets the user pick which derivation
 * to use per chain. If the standard path matches what the import scan
 * found and there's no ambiguity, the view auto-advances after a brief
 * "All matched" confirmation — the picker is never required, just
 * available.
 *
 * The chosen DerivationChoice flows up via `onConfirm`; useVault
 * persists it on the vault and re-derives the affected chains using
 * the chosen path.
 */
export function DerivationPickerView(props: {
  mnemonic: string;
  onConfirm: (choice: DerivationChoice) => void;
  onBack: () => void;
}) {
  const { mnemonic, onConfirm, onBack } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "scanning" });
  const [choice, setChoice] = useState<DerivationChoice>(DEFAULT_DERIVATION_CHOICE);

  useEffect(() => {
    let cancelled = false;
    detectAll(mnemonic)
      .then((result) => {
        if (cancelled) return;
        setChoice({
          bitcoin: result.bitcoin.recommendedId,
          solana: result.solana.recommendedId,
          cardano: result.cardano.recommendedId,
        });
        setPhase({ kind: "ready", result });
      })
      .catch((e: Error) => {
        if (!cancelled) setPhase({ kind: "error", message: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [mnemonic]);

  if (phase.kind === "scanning") {
    return (
      <div className="import-view">
        <div className="terminal-box">
          <div className="terminal-box-title">SCANNING DERIVATION PATHS</div>
          <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "12px 0" }}>
            <ST delay={0} speed={20}>
              Checking every common BTC, SOL, and ADA derivation path for
              on-chain activity. This takes about 5–10 seconds depending
              on RPC latency.
            </ST>
          </p>
          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
            BTC: BIP-84 / BIP-49 / BIP-44 / pwnda-legacy<br />
            SOL: Phantom / Solana CLI / Sollet<br />
            ADA: CIP-1852 / pwnda-legacy
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="import-view">
        <div className="terminal-box">
          <div className="terminal-box-title">SCAN FAILED</div>
          <p style={{ color: "#ff6b6b", fontSize: 11 }}>{phase.message}</p>
          <p style={{ fontSize: 10, color: "var(--text-dim)" }}>
            Falling back to the standard derivation paths (BIP-84 BTC,
            Phantom SOL, CIP-1852 ADA). You can re-scan from Settings →
            Wallet Details after the wallet is open.
          </p>
          <div className="button-row" style={{ marginTop: 12 }}>
            <button className="btn-secondary" onClick={onBack}>
              ► Back
            </button>
            <button
              className="btn-primary"
              onClick={() => onConfirm(DEFAULT_DERIVATION_CHOICE)}
            >
              ► Continue with defaults
            </button>
          </div>
        </div>
      </div>
    );
  }

  const result = phase.result;
  return (
    <div className="import-view">
      <div className="terminal-box">
        <div className="terminal-box-title">DERIVATION PATHS</div>
        <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "8px 0 14px" }}>
          <ST delay={0} speed={20}>
            We scanned the common derivation paths for the wallet you
            imported from. Pick which path to use for each chain — the
            recommended choice is pre-selected.
          </ST>
        </p>

        <ChainSection
          title="Bitcoin (BTC)"
          result={result.bitcoin}
          chosen={choice.bitcoin}
          onChange={(id) => setChoice({ ...choice, bitcoin: id })}
        />
        <ChainSection
          title="Solana (SOL)"
          result={result.solana}
          chosen={choice.solana}
          onChange={(id) => setChoice({ ...choice, solana: id })}
        />
        <ChainSection
          title="Cardano (ADA)"
          result={result.cardano}
          chosen={choice.cardano}
          onChange={(id) => setChoice({ ...choice, cardano: id })}
        />

        <div className="button-row" style={{ marginTop: 14 }}>
          <button className="btn-secondary" onClick={onBack}>
            ► Back
          </button>
          <button className="btn-primary" onClick={() => onConfirm(choice)}>
            ► Confirm and continue
          </button>
        </div>
      </div>
    </div>
  );
}

function ChainSection(props: {
  title: string;
  result: ChainDetectionResult;
  chosen: string;
  onChange: (id: string) => void;
}) {
  const { title, result, chosen, onChange } = props;
  const anyActivity = result.candidates.some((c) => c.hasActivity);
  return (
    <Card style={{ marginBottom: 10 }}>
      <div style={{ padding: "8px 4px" }}>
        <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>
          {title}
          {anyActivity && (
            <span style={{ fontSize: 10, color: "#ffae42", marginLeft: 8 }}>
              activity detected
            </span>
          )}
        </div>
        {result.candidates.map((c) => (
          <label
            key={c.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              padding: "6px 4px",
              cursor: "pointer",
              borderTop: "1px solid var(--border-soft)",
            }}
          >
            <input
              type="radio"
              name={`chain-${title}`}
              checked={chosen === c.id}
              onChange={() => onChange(c.id)}
              style={{ marginTop: 3, marginRight: 8 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, color: "var(--text)" }}>{c.label}</div>
              <div
                style={{
                  fontSize: 9,
                  color: "var(--text-dim)",
                  fontFamily: "var(--mono)",
                  wordBreak: "break-all",
                  marginTop: 2,
                }}
              >
                {c.address}
              </div>
              <div style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 2 }}>
                {c.origin}
              </div>
              {c.hasActivity && (
                <div style={{ fontSize: 9, color: "#ffae42", marginTop: 2 }}>
                  Balance: {c.balance.toFixed(6)} {result.chain === "bitcoin" ? "BTC" : result.chain === "solana" ? "SOL" : "ADA"}
                </div>
              )}
              {c.id === result.recommendedId && (
                <div style={{ fontSize: 9, color: "var(--accent)", marginTop: 2 }}>
                  ✓ recommended
                </div>
              )}
            </div>
          </label>
        ))}
      </div>
    </Card>
  );
}
