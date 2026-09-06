import { useEffect, useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import {
  detectLtc,
  type ChainDetectionResult,
} from "../onboarding/derivation-detector";
import { sweepLegacyLtcToModern } from "../../wallets/ltc-wallet";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; result: ChainDetectionResult }
  | { kind: "saving"; result: ChainDetectionResult }
  | { kind: "saved"; result: ChainDetectionResult }
  | { kind: "error"; message: string };

/** The legacy→modern migration send, layered over the derivation choice. */
type MigrateState =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "sweeping" }
  | { kind: "swept"; txid: string; destination: string; sweptLits: number }
  | { kind: "error"; message: string };

/**
 * Litecoin derivation panel. Unlike the Solana/Algorand panels, LTC has
 * exactly TWO meaningful derivations, so there's no brute-force "paste an
 * address" layer — both candidates are probed and shown side by side with
 * live balances:
 *
 *   1. BIP-84 native SegWit (`ltc1q…`, P2WPKH) — Pwnda's default, matches
 *      Electrum / Trezor / Ledger Live.
 *   2. BIP-44 legacy (`L…`, P2PKH) — what Exodus and Atomic derive.
 *
 * The most common real-world cause of "I imported my seed and my Litecoin
 * is missing" is an Exodus user landing on the `ltc1q…` default while their
 * coins sit at the `L…` address. Showing both balances makes that obvious;
 * "Use this" switches the vault's `derivationChoice.litecoin` so the
 * dashboard address + the signer both move to the legacy path. Spending from
 * the `L…` address works because ltc-wallet's send path falls back to a P2PKH
 * (`nonWitnessUtxo`) build when the legacy address is the funded one.
 *
 * Switching is non-destructive — the seed is unchanged, both addresses remain
 * valid for the same seed, and the user can switch back at any time.
 */
export function LitecoinDerivationPanel(props: {
  mnemonic: string;
  /** Current `derivationChoice.litecoin` from the unlocked vault. */
  currentChoice: string;
  /** Save+re-derive callback when the user picks the other path. */
  onChooseDerivation: (newLitecoinChoice: string) => Promise<void>;
  onCopy: (text: string) => void;
}) {
  const { mnemonic, currentChoice, onChooseDerivation, onCopy } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [migrate, setMigrate] = useState<MigrateState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    detectLtc(mnemonic)
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

  const handlePick = async (id: string) => {
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
          Probing Litecoin derivation candidates…
        </div>
      </Card>
    );
  }

  if (phase.kind === "error") {
    return (
      <Card style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10, color: "#ff6b6b", padding: "8px 4px" }}>
          Could not load Litecoin derivation candidates: {phase.message}
        </div>
      </Card>
    );
  }

  const result = phase.result;
  const saving = phase.kind === "saving";

  // The migration offer: shown when the LEGACY candidate is the funded one.
  // One send, destination DERIVED from this same seed (never typed — the
  // fund-moving rule every sweep in this codebase follows), then the
  // derivation choice flips to modern so the dashboard address, the signer
  // and the balance all follow the funds. The payoff beyond fees: the swap
  // node's shared wallet supports native-SegWit only, so after this send LTC
  // can use your own wallet in the DEX exactly like BTC does.
  const legacyCandidate = result.candidates.find((c) => c.id !== "bip84");
  const modernCandidate = result.candidates.find((c) => c.id === "bip84");
  const offerMigrate =
    legacyCandidate?.hasActivity === true &&
    modernCandidate != null &&
    migrate.kind !== "swept";

  const runMigrate = async () => {
    setMigrate({ kind: "sweeping" });
    try {
      const r = await sweepLegacyLtcToModern(mnemonic);
      setMigrate({
        kind: "swept",
        txid: r.hash,
        destination: r.destination,
        sweptLits: r.sweptLits,
      });
      // Follow the funds: make the modern path the active derivation so the
      // dashboard address + signer move with them. Failure here is NOT a
      // failed migration — the coins are already at the modern address of
      // this same seed — so it degrades to the "Use this" button above.
      if (currentChoice !== "bip84") {
        try {
          await onChooseDerivation("bip84");
        } catch {
          /* surfaced by the choice UI; the sweep itself succeeded */
        }
      }
    } catch (e: any) {
      setMigrate({ kind: "error", message: e?.message ?? String(e) });
    }
  };

  return (
    <Card style={{ marginTop: 10 }}>
      <div className="secret-row">
        <div className="secret-header">
          <span className="label" style={{ color: "var(--accent)" }}>
            <ST delay={0} speed={20}>Litecoin address derivation</ST>
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8, lineHeight: 1.5 }}>
          Pwnda defaults to the modern native-SegWit <code>ltc1q…</code> path
          (Electrum / Trezor / Ledger). <strong style={{ color: "var(--text)" }}>Exodus
          and Atomic</strong> instead use the older legacy <code>L…</code> path —
          so an imported Exodus seed shows zero here even though the coins are
          on-chain. Both addresses below belong to <em>this same seed</em>; pick
          the one holding your funds.
        </div>

        {result.candidates.map((c) => {
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
                <span
                  style={{
                    flex: 1,
                    fontSize: 9,
                    color: c.probeFailed
                      ? "var(--warn, #ffb000)"
                      : c.hasActivity
                        ? "var(--accent)"
                        : "var(--text-dim)",
                  }}
                >
                  {c.probeFailed
                    ? "Could not check — try again"
                    : c.hasActivity
                      ? `${c.balance.toFixed(8)} LTC`
                      : "0 LTC probed"}
                </span>
                <button className="btn-icon" onClick={() => onCopy(c.address)}>
                  Copy
                </button>
                {!isCurrent && (
                  <button
                    className="btn-icon"
                    onClick={() => handlePick(c.id)}
                    disabled={saving}
                  >
                    {saving ? "Saving…" : "Use this"}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {phase.kind === "saved" && (
          <div style={{ marginTop: 8, fontSize: 10, color: "var(--accent)" }}>
            ✓ Derivation updated. The Litecoin address + balance above have
            refreshed automatically — switch back any time.
          </div>
        )}

        {offerMigrate && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              border: "1px solid var(--border)",
              background: "rgba(255,255,255,0.02)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
            }}
          >
            <div style={{ color: "var(--text)", marginBottom: 4 }}>
              Move to the modern address
            </div>
            <div style={{ color: "var(--text-dim)", lineHeight: 1.5, marginBottom: 6 }}>
              One send moves your whole legacy balance to this seed&apos;s own
              modern address ({modernCandidate.address.slice(0, 10)}…), and the
              wallet switches to it automatically. Modern addresses cost less
              to spend from — and the swap node can then use your LTC wallet
              directly, like it does for BTC. Network fee: well under a cent.
            </div>
            {migrate.kind === "idle" && (
              <button className="btn-icon" onClick={() => setMigrate({ kind: "confirm" })}>
                Move balance…
              </button>
            )}
            {migrate.kind === "confirm" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "var(--text-dim)" }}>
                  Send {legacyCandidate.balance.toFixed(8)} LTC (minus fee) to
                  your own modern address?
                </span>
                <button className="btn-icon" onClick={runMigrate}>
                  Confirm
                </button>
                <button
                  className="btn-icon"
                  onClick={() => setMigrate({ kind: "idle" })}
                >
                  Cancel
                </button>
              </div>
            )}
            {migrate.kind === "sweeping" && (
              <div style={{ color: "var(--text-dim)" }}>Broadcasting…</div>
            )}
            {migrate.kind === "error" && (
              <div style={{ color: "#ff6b6b", wordBreak: "break-word" }}>
                {migrate.message}
              </div>
            )}
          </div>
        )}

        {migrate.kind === "swept" && (
          <div style={{ marginTop: 8, fontSize: 10, color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
            ✓ Moved {(migrate.sweptLits / 1e8).toFixed(8)} LTC to{" "}
            {migrate.destination.slice(0, 14)}… — it will show as your balance
            once the network confirms.
            <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: "var(--text-dim)", wordBreak: "break-all" }}>
                txid {migrate.txid}
              </span>
              <button className="btn-icon" onClick={() => onCopy(migrate.txid)}>
                Copy
              </button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
