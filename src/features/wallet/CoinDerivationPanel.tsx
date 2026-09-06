import { useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import {
  bruteForceFindCoinPath,
  type BruteForceMatch,
  type ProfilePathCoin,
} from "../onboarding/derivation-detector";
import type { ProfileId } from "../onboarding/derivation-profiles";

type FindState =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "match"; match: BruteForceMatch }
  | { kind: "no-match"; address: string };

/**
 * Derivation panel for the secp256k1 profile coins (XRP / TRX / RVN / DASH).
 * Simpler than the Solana / Cardano panels — those coins have a fixed set of
 * named candidates; these don't, so this is **paste-to-find only**: paste an
 * address from another wallet, brute-force the standard / Exodus-5-hardened /
 * Atomic-3-step forms (account + index 0..5) offline, and switch on a match.
 * Mirrors the find half of `SolanaDerivationPanel`. (2026-06-21, Phase 3 of
 * [[derivation-profiles-plan]].)
 */
export function CoinDerivationPanel(props: {
  coin: ProfilePathCoin;
  /** Display name shown in the heading + copy ("XRP", "TRON", …). */
  coinLabel: string;
  /** Placeholder hint for the paste input ("XRP address (r…)"). */
  addressKind: string;
  mnemonic: string;
  /** The address Pwnda currently shows for this coin. */
  currentAddress: string;
  onChoose: (coin: ProfilePathCoin, path: string) => Promise<void>;
  onCopy: (text: string) => void;
}) {
  const { coin, coinLabel, addressKind, mnemonic, currentAddress, onChoose, onCopy } = props;
  const [findState, setFindState] = useState<FindState>({ kind: "idle" });
  const [findInput, setFindInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleFind = () => {
    const target = findInput.trim();
    if (!target) return;
    setSaved(false);
    setFindState({ kind: "probing" });
    // Derivation is CPU-bound + fast (~1ms/candidate); defer a microtask so
    // the "probing" state paints first.
    Promise.resolve().then(() => {
      const match = bruteForceFindCoinPath(coin, mnemonic, target);
      setFindState(match ? { kind: "match", match } : { kind: "no-match", address: target });
    });
  };

  const handleUse = async (match: BruteForceMatch) => {
    if (match.address === currentAddress) {
      setFindState({ kind: "idle" });
      setFindInput("");
      return;
    }
    setSaving(true);
    try {
      await onChoose(coin, match.path);
      setSaved(true);
      setFindState({ kind: "idle" });
      setFindInput("");
    } catch {
      /* error surfaced via the useVault banner */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card style={{ marginTop: 10 }}>
      <div className="secret-row">
        <div className="secret-header">
          <span className="label" style={{ color: "var(--accent)" }}>
            <ST delay={0} speed={20}>{`Alternative ${coinLabel} derivations`}</ST>
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8, lineHeight: 1.5 }}>
          If you imported a seed from another wallet (Exodus, Atomic, …) and
          don't see your {coinLabel} balance, paste that wallet's address
          below. We'll brute-force the common derivation forms offline and
          switch to the matching one.
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            value={findInput}
            onChange={(e) => setFindInput(e.target.value)}
            placeholder={addressKind}
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
            Probing derivations…
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
            <div style={{ color: "var(--accent)", marginBottom: 6 }}>✓ Match found</div>
            <div style={{ fontSize: 9, color: "var(--text)", marginBottom: 4 }}>
              {findState.match.label}{" "}
              <code style={{ color: "var(--text-dim)" }}>({findState.match.path})</code>
            </div>
            <div style={{ wordBreak: "break-all", color: "var(--text-dim)", fontSize: 9, marginBottom: 8 }}>
              {findState.match.address}
            </div>
            {findState.match.address === currentAddress ? (
              <div style={{ fontSize: 9, color: "var(--text-dim)" }}>
                This is already your current {coinLabel} derivation.
              </div>
            ) : (
              <button
                className="btn-icon"
                onClick={() => handleUse(findState.match)}
                disabled={saving}
                style={{ background: "var(--accent)", color: "#000" }}
              >
                {saving ? "Saving…" : "Use this derivation"}
              </button>
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
            <div style={{ marginBottom: 8 }}>
              The address may belong to a different seed, or its wallet uses a
              form we don't probe. Workaround: send funds to your current{" "}
              {coinLabel} address:
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <code style={{ flex: 1, wordBreak: "break-all", fontSize: 9 }}>{currentAddress}</code>
              <button className="btn-icon" onClick={() => onCopy(currentAddress)}>Copy</button>
            </div>
          </div>
        )}

        {saved && (
          <div style={{ marginTop: 8, fontSize: 10, color: "var(--accent)" }}>
            ✓ {coinLabel} derivation updated — the address + balance above have refreshed.
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Global derivation-profile switch (Phase 3, Part E). One control that
 * re-derives EVERY coin to match a source wallet at once — the wallet-centric
 * counterpart of the per-coin panels. Standard resets to the ecosystem
 * defaults; Exodus / Atomic apply those wallets' schemes, with the unverified
 * secp256k1 paths gated behind an on-chain balance check (so nothing strands).
 * See `useVault.handleApplyProfile` + [[derivation-profiles-plan]].
 */
export function DerivationProfileSwitch(props: {
  onApply: (profile: ProfileId) => Promise<void>;
}) {
  const [applying, setApplying] = useState<ProfileId | null>(null);
  const profiles: Array<{ id: ProfileId; label: string }> = [
    { id: "standard", label: "Standard" },
    { id: "exodus", label: "Exodus" },
    { id: "atomic", label: "Atomic" },
  ];
  return (
    <Card style={{ marginTop: 10 }}>
      <div className="secret-row">
        <div className="secret-header">
          <span className="label" style={{ color: "var(--accent)" }}>
            <ST delay={0} speed={20}>Derivation profile (all coins)</ST>
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8, lineHeight: 1.5 }}>
          Switch every coin's derivation to match a source wallet at once.
          Standard matches MetaMask / Phantom / Ledger / Yoroi. Exodus and
          Atomic re-derive the coins those wallets do differently — the
          unverified paths apply only where an on-chain balance confirms them,
          so nothing strands.
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {profiles.map((p) => (
            <button
              key={p.id}
              className="btn-icon"
              style={{ flex: 1 }}
              disabled={applying !== null}
              onClick={async () => {
                setApplying(p.id);
                try {
                  await props.onApply(p.id);
                } finally {
                  setApplying(null);
                }
              }}
            >
              {applying === p.id ? "…" : p.label}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
