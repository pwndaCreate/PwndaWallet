import { useEffect, useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import {
  bruteForceFindSolana,
  detectSol,
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

const PROBED_CANDIDATE_COUNT = 49; // 36 phantom variants + 6 cli + 1 sollet + 6 cli buffer

/**
 * Solana derivation panel. Two layers:
 *
 *   1. The standard candidate list (Phantom / CLI / Sollet) with live
 *      balance probes — kept from the original implementation, useful
 *      when the user's source wallet matches one of those three.
 *   2. **Address-paste-and-find** — the user types in an address from
 *      another wallet and we brute-force ~49 SOL derivation variants
 *      offline (≤100ms total). When the source wallet uses a
 *      proprietary path (Exodus, Atomic, etc.) and we can't enumerate
 *      it in advance, the find probe is the only way to recover. If a
 *      match is found, we offer to switch the user's primary derivation
 *      to that path.
 *
 * The panel never alarms users with "no funds detected" framing — most
 * fresh-seed users will have empty balances, which is expected. The
 * copy reframes around "did you import a seed?" instead.
 */
export function SolanaDerivationPanel(props: {
  mnemonic: string;
  /** Current `derivationChoice.solana` from the unlocked vault. */
  currentChoice: string;
  /** Save+re-derive callback when the user picks an alternative. */
  onChooseDerivation: (newSolanaChoice: string) => Promise<void>;
  onCopy: (text: string) => void;
}) {
  const { mnemonic, currentChoice, onChooseDerivation, onCopy } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [findState, setFindState] = useState<FindState>({ kind: "idle" });
  const [findInput, setFindInput] = useState("");
  const [showStandardCandidates, setShowStandardCandidates] = useState(false);

  useEffect(() => {
    let cancelled = false;
    detectSol(mnemonic)
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
    // Run synchronously — derivation is CPU-bound and fast (~1ms per
    // candidate). yieldMicrotask gives the spinner a paint chance.
    Promise.resolve().then(() => {
      const match = bruteForceFindSolana(mnemonic, target);
      if (match) setFindState({ kind: "match", match });
      else setFindState({ kind: "no-match", address: target });
    });
  };

  const handleUseMatch = async (match: BruteForceMatch) => {
    // Allow re-firing from "saved" too — the user may want to switch
    // again after a previous save. Only skip while we're mid-flight or
    // before the initial probe finishes.
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
          Probing Solana derivation candidates…
        </div>
      </Card>
    );
  }

  if (phase.kind === "error") {
    return (
      <Card style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10, color: "#ff6b6b", padding: "8px 4px" }}>
          Could not load Solana derivation candidates: {phase.message}
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
            <ST delay={0} speed={20}>Alternative Solana derivations</ST>
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8, lineHeight: 1.5 }}>
          Pwnda's default Solana derivation matches Phantom / Solflare /
          Trezor / Ledger Live. If your funds are in Pwnda, they'll
          appear at the address above. If you imported a seed from
          another wallet (Exodus, Atomic, Phantom, etc.) and don't see
          your balance, paste your other wallet's address below to find
          the matching derivation.
        </div>

        {/* Standard candidates — collapsed by default to keep the panel
            quiet on fresh-seed wallets. The find input is the primary
            interaction here. */}
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
                    {c.hasActivity ? `${c.balance.toFixed(6)} SOL` : "0 SOL probed"}
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

        {/* Address-paste-and-find — the primary recovery interaction
            for users whose source wallet uses a non-enumerable path. */}
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
            variants offline and report which (if any) matches your seed.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={findInput}
              onChange={(e) => setFindInput(e.target.value)}
              placeholder="Solana address (base58)"
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

              {/* Side-by-side current vs match — the paths often look
                  visually almost identical (`m/44'/501'/0'/0'` vs
                  `m/44'/501'/0'/0/0` — one trailing-tick difference),
                  but produce unrelated addresses because the underlying
                  derivation algorithm is different too (SLIP-10 ed25519
                  vs secp256k1 BIP-32 + ed25519 reuse). Showing both
                  rows next to each other makes the distinction
                  unmissable. */}
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
                  This is already your current Solana derivation
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
                    Same seed, different wallet convention — these two
                    addresses are <em>both</em> valid Solana wallets for
                    your seed. Switching here re-derives the on-chain
                    address Pwnda displays + signs from; your seed
                    itself doesn't change.
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
                  <li>The wallet that produced it uses a custom algorithm we don't probe</li>
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
            ✓ Derivation updated. The Solana address + balance above
            have refreshed automatically — pick another derivation here
            if you want to keep looking.
          </div>
        )}
      </div>
    </Card>
  );
}
