import { useEffect, useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import {
  bruteForceFindCardano,
  detectAda,
  type BruteForceMatch,
  type ChainDetectionResult,
} from "../onboarding/derivation-detector";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; result: ChainDetectionResult }
  | { kind: "saving"; result: ChainDetectionResult }
  | { kind: "saved"; result: ChainDetectionResult }
  | { kind: "error"; message: string };

type FindState =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "match"; match: BruteForceMatch }
  | { kind: "no-match"; address: string };

const PROBED_CANDIDATE_COUNT = 67; // 6 accounts × 11 indices + pwnda-legacy

/**
 * Cardano derivation panel. Same two-layer structure as
 * `SolanaDerivationPanel`:
 *
 *   1. The standard candidates (CIP-1852 default + pwnda-legacy
 *      enterprise) with live Koios balance probes — small, useful for
 *      seeds whose source wallet matches the canonical Yoroi / Eternl
 *      output or holds funds at Pwnda's pre-fix legacy address.
 *   2. **Address-paste-and-find** — brute-force across CIP-1852 with
 *      account ∈ 0..5 and address index ∈ 0..10 (66 candidates) plus
 *      the legacy enterprise variant. Recovers from non-zero account /
 *      index flows that some wallets default to.
 *
 * Pwnda's CIP-1852 implementation matches the canonical
 * Yoroi/Eternl/Daedalus/cardano-serialization-lib test vector
 * byte-for-byte (verified in `cardano-cip1852.test.ts`). When a user
 * reports an Exodus / Atomic address that doesn't appear in the brute
 * force, the divergence is most likely the Ledger Cardano BIP-39-seed
 * master-key variant, which is a separate algorithm and out of scope
 * for this round. The no-match branch surfaces an actionable
 * workaround (send-from-other-wallet to current Pwnda address).
 */
export function CardanoDerivationPanel(props: {
  mnemonic: string;
  /** Current `derivationChoice.cardano` from the unlocked vault. */
  currentChoice: string;
  /** Save+re-derive callback when the user picks an alternative. */
  onChooseDerivation: (newCardanoChoice: string) => Promise<void>;
  onCopy: (text: string) => void;
}) {
  const { mnemonic, currentChoice, onChooseDerivation, onCopy } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [findState, setFindState] = useState<FindState>({ kind: "idle" });
  const [findInput, setFindInput] = useState("");
  const [showStandardCandidates, setShowStandardCandidates] = useState(false);

  useEffect(() => {
    let cancelled = false;
    detectAda(mnemonic)
      .then((result) => {
        if (cancelled) return;
        setPhase({ kind: "ready", result });
      })
      .catch((e: Error) => {
        if (!cancelled) setPhase({ kind: "error", message: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [mnemonic]);

  const handleFind = () => {
    const target = findInput.trim();
    if (!target) return;
    setFindState({ kind: "probing" });
    Promise.resolve().then(() => {
      const match = bruteForceFindCardano(mnemonic, target);
      if (match) setFindState({ kind: "match", match });
      else setFindState({ kind: "no-match", address: target });
    });
  };

  const handleUseMatch = async (match: BruteForceMatch) => {
    // Allow re-firing from "saved" too — the user may want to switch
    // again after a previous save.
    if (phase.kind !== "ready" && phase.kind !== "saved") return;
    if (match.id === currentChoice) {
      setFindState({ kind: "idle" });
      setFindInput("");
      return;
    }
    setPhase({ kind: "saving", result: phase.result });
    try {
      await onChooseDerivation(match.id);
      setPhase({ kind: "saved", result: phase.result });
      setFindState({ kind: "idle" });
      setFindInput("");
    } catch (e: any) {
      setPhase({
        kind: "error",
        message: e?.message ?? "Could not save derivation choice.",
      });
    }
  };

  const handlePickStandard = async (id: string) => {
    if (phase.kind !== "ready" && phase.kind !== "saved") return;
    if (id === currentChoice) return;
    setPhase({ kind: "saving", result: phase.result });
    try {
      await onChooseDerivation(id);
      setPhase({ kind: "saved", result: phase.result });
    } catch (e: any) {
      setPhase({
        kind: "error",
        message: e?.message ?? "Could not save derivation choice.",
      });
    }
  };

  if (phase.kind === "loading") {
    return (
      <Card style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "8px 4px" }}>
          Probing Cardano derivation candidates…
        </div>
      </Card>
    );
  }

  if (phase.kind === "error") {
    return (
      <Card style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10, color: "#ff6b6b", padding: "8px 4px" }}>
          Could not load Cardano derivation candidates: {phase.message}
        </div>
      </Card>
    );
  }

  const result = phase.result;
  const currentCandidate =
    result.candidates.find((c) => c.id === currentChoice) ??
    result.candidates[0];
  const currentAddress = currentCandidate?.address ?? "";
  const currentLabel = currentCandidate?.label ?? "current derivation";

  return (
    <Card style={{ marginTop: 10 }}>
      <div className="secret-row">
        <div className="secret-header">
          <span className="label" style={{ color: "var(--accent)" }}>
            <ST delay={0} speed={20}>Alternative Cardano derivations</ST>
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8, lineHeight: 1.5 }}>
          Pwnda's default CIP-1852 derivation matches Yoroi / Eternl /
          Daedalus / cardano-serialization-lib byte-for-byte. If your
          funds are in Pwnda, they'll appear at the address above. If
          you imported a seed from another wallet (Exodus, Atomic, etc.)
          and don't see your balance, paste your other wallet's address
          below to find the matching derivation.
        </div>

        <div
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: "1px dashed var(--border-soft)",
          }}
        >
          <button
            className="btn-icon"
            onClick={() => setShowStandardCandidates((v) => !v)}
            style={{
              fontSize: 9.5,
              color: "var(--text-dim)",
              padding: "2px 0",
            }}
          >
            {showStandardCandidates ? "▾" : "▸"} Standard derivation candidates ({result.candidates.length})
          </button>
        </div>

        {showStandardCandidates &&
          result.candidates.map((c) => {
            const isCurrent = c.id === currentChoice;
            return (
              <div
                key={c.id}
                style={{
                  marginTop: 8,
                  padding: "8px 10px",
                  background: isCurrent
                    ? "rgba(0,255,102,0.06)"
                    : "rgba(255,255,255,0.02)",
                  border: isCurrent
                    ? "1px solid var(--accent)"
                    : "1px solid var(--border)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ flex: 1, color: isCurrent ? "var(--accent)" : "var(--text)" }}>
                    {c.label}
                  </span>
                  {isCurrent && (
                    <span style={{ fontSize: 9, color: "var(--accent)" }}>← current</span>
                  )}
                </div>
                <div style={{ wordBreak: "break-all", color: "var(--text-dim)", fontSize: 9 }}>
                  {c.address}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <span style={{ flex: 1, fontSize: 9, color: "var(--text-dim)" }}>
                    {c.hasActivity ? `${c.balance.toFixed(6)} ADA` : "0 ADA probed"}
                  </span>
                  <button className="btn-icon" onClick={() => onCopy(c.address)}>
                    Copy
                  </button>
                  {!isCurrent && (
                    <button
                      className="btn-icon"
                      onClick={() => handlePickStandard(c.id)}
                      disabled={phase.kind === "saving"}
                    >
                      {phase.kind === "saving" ? "Saving…" : "Use this"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: "1px solid var(--border-soft)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--text)",
              marginBottom: 6,
              fontWeight: 600,
            }}
          >
            Or find a specific address
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8 }}>
            Paste an address from another wallet. We'll brute-force ~{PROBED_CANDIDATE_COUNT} derivation
            variants offline (CIP-1852 with account 0–5, address index 0–10 + legacy)
            and report which matches your seed.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={findInput}
              onChange={(e) => setFindInput(e.target.value)}
              placeholder="addr1q… or addr1v…"
              style={{
                flex: 1,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                padding: "6px 8px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                color: "var(--text)",
              }}
            />
            <button
              className="btn-icon"
              onClick={handleFind}
              disabled={!findInput.trim() || findState.kind === "probing"}
              style={{ minWidth: 52 }}
            >
              {findState.kind === "probing" ? "…" : "Find"}
            </button>
          </div>

          {findState.kind === "probing" && (
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
              Probing {PROBED_CANDIDATE_COUNT} derivations…
            </div>
          )}

          {findState.kind === "match" && (
            <div
              style={{
                marginTop: 8,
                padding: "10px 10px",
                border: "1px solid var(--accent)",
                background: "rgba(0,255,102,0.06)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
              }}
            >
              <div style={{ color: "var(--accent)", marginBottom: 6 }}>
                ✓ Match found
              </div>

              {/* Side-by-side current vs match — Cardano paths are
                  longer than Solana's (`m/1852'/1815'/0'/0/0` for the
                  standard CIP-1852 base address) and the proprietary
                  Exodus + same-key variants live behind the same
                  visually-similar path string but a different
                  algorithm. Rendering both rows next to each other
                  makes the distinction unmissable. */}
              {findState.match.id !== currentChoice && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    columnGap: 8,
                    rowGap: 4,
                    marginBottom: 10,
                    fontSize: 9,
                    lineHeight: 1.4,
                  }}
                >
                  <span style={{ color: "var(--text-dim)" }}>Current:</span>
                  <span style={{ color: "var(--text)" }}>
                    {currentLabel}
                  </span>
                  <span style={{ color: "var(--text-dim)" }}>&nbsp;</span>
                  <span
                    style={{
                      color: "var(--text-dim)",
                      wordBreak: "break-all",
                    }}
                  >
                    {currentAddress}
                  </span>

                  <span style={{ color: "var(--accent)" }}>Match:</span>
                  <span style={{ color: "var(--accent)" }}>
                    {findState.match.label}{" "}
                    <code style={{ color: "var(--text-dim)" }}>
                      ({findState.match.path})
                    </code>
                  </span>
                  <span style={{ color: "var(--text-dim)" }}>&nbsp;</span>
                  <span
                    style={{
                      color: "var(--text)",
                      wordBreak: "break-all",
                    }}
                  >
                    {findState.match.address}
                  </span>
                </div>
              )}

              {findState.match.id === currentChoice ? (
                <div style={{ fontSize: 9, color: "var(--text-dim)" }}>
                  This is already your current Cardano derivation
                  ({findState.match.label} — <code>{findState.match.path}</code>).
                </div>
              ) : (
                <>
                  <div
                    style={{
                      fontSize: 9,
                      color: "var(--text-dim)",
                      marginBottom: 8,
                      lineHeight: 1.5,
                    }}
                  >
                    Same seed, different wallet convention — both
                    addresses are valid Cardano wallets for your seed.
                    Switching here re-derives the on-chain address
                    Pwnda displays + signs from; your seed itself
                    doesn't change.
                  </div>
                  <button
                    className="btn-icon"
                    onClick={() => handleUseMatch(findState.match)}
                    disabled={phase.kind === "saving"}
                    style={{
                      background: "var(--accent)",
                      color: "#000",
                    }}
                  >
                    {phase.kind === "saving" ? "Saving…" : "Use this derivation"}
                  </button>
                </>
              )}
            </div>
          )}

          {findState.kind === "no-match" && (
            <div
              style={{
                marginTop: 8,
                padding: "8px 10px",
                border: "1px solid #ffae42",
                background: "rgba(255,174,66,0.06)",
                fontSize: 10,
                color: "var(--text-dim)",
                lineHeight: 1.5,
              }}
            >
              <div style={{ color: "#ffae42", marginBottom: 6 }}>
                Could not derive this address from your seed.
              </div>
              <div style={{ marginBottom: 6 }}>
                Possible reasons:
                <ul style={{ margin: "4px 0", paddingLeft: 16 }}>
                  <li>The address belongs to a different seed</li>
                  <li>
                    The wallet that produced it uses a custom algorithm — most
                    likely the Ledger Cardano BIP-39-seed variant, which we
                    don't yet probe
                  </li>
                </ul>
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong style={{ color: "var(--text)" }}>Workaround:</strong>{" "}
                log into the other wallet and send funds to your current
                Pwnda address:
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <code style={{ flex: 1, wordBreak: "break-all", fontSize: 9 }}>
                  {currentAddress}
                </code>
                <button className="btn-icon" onClick={() => onCopy(currentAddress)}>
                  Copy
                </button>
              </div>
            </div>
          )}
        </div>

        {phase.kind === "saved" && (
          <div style={{ marginTop: 8, fontSize: 10, color: "var(--accent)" }}>
            ✓ Derivation updated. The Cardano address + balance above
            have refreshed automatically — pick another derivation here
            if you want to keep looking.
          </div>
        )}
      </div>
    </Card>
  );
}
