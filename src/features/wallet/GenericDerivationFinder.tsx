import { useState } from "react";
import { ST } from "../../components/Primitives";
import { getAdapter, type ChainType } from "../../wallets";
import {
  candidatePathsFor,
  findPathForAddress,
  findFundedPaths,
  supportsPathSearch,
  type FoundPath,
  type FundedPath,
} from "../onboarding/generic-path-finder";

type FindState =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "match"; hit: FoundPath }
  | { kind: "no-match"; address: string };

type ScanState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "done"; funded: FundedPath[] }
  | { kind: "blind" };

/**
 * Derivation search for any chain whose adapter implements `deriveAtPath`.
 *
 * Both halves of what the bespoke panels offered, without needing one per
 * chain — which is why they only ever covered four:
 *
 *   Scan   probe candidate derivations for a balance. Answers "are my funds
 *          on a different path?" without the user knowing what a path is.
 *   Find   paste an address from another wallet and get the path back. Pure
 *          derivation, no network, so it works offline and instantly.
 *
 * Read-only by design. It reports what it found and shows the address; it
 * does NOT switch the wallet over. Switching re-derives the account and is
 * the kind of thing that should go through the chain's own save path, which
 * only some chains have. Telling the user exactly where their funds are is
 * the part that was missing.
 */
export function GenericDerivationFinder(props: {
  chain: ChainType;
  mnemonic: string;
  onCopy: (text: string) => void;
}) {
  const { chain, mnemonic, onCopy } = props;
  const [find, setFind] = useState<FindState>({ kind: "idle" });
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });
  const [input, setInput] = useState("");

  if (!supportsPathSearch(chain) || !mnemonic) return null;
  const adapter = getAdapter(chain);
  const candidateCount = candidatePathsFor(chain).length;

  const runFind = () => {
    const target = input.trim();
    if (!target) return;
    setFind({ kind: "searching" });
    // Offline + synchronous; defer a tick so the button state paints first.
    Promise.resolve().then(() => {
      const hit = findPathForAddress(chain, mnemonic, target);
      setFind(hit ? { kind: "match", hit } : { kind: "no-match", address: target });
    });
  };

  const runScan = async () => {
    setScan({ kind: "scanning" });
    const funded = await findFundedPaths(chain, mnemonic);
    // null = every probe failed. Distinct from [] = probed fine, nothing
    // funded. Reporting "no funds found" after a failed sweep is how a user
    // gets told an empty derivation is correct.
    setScan(funded === null ? { kind: "blind" } : { kind: "done", funded });
  };

  const rowStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "8px 10px",
    background: "rgba(255,255,255,0.02)",
    border: "1px solid var(--border)",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
  };

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border-soft)" }}>
      <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 8 }}>
        Other wallets derive {adapter.ticker} at different paths. If your balance
        is missing here but visible elsewhere, the seed is fine — the path
        differs.
      </div>

      {/* ── Scan ─────────────────────────────────────────────── */}
      <button
        className="btn-icon"
        onClick={runScan}
        disabled={scan.kind === "scanning"}
        style={{ fontSize: 9.5 }}
      >
        {scan.kind === "scanning"
          ? `Checking ${candidateCount} derivations…`
          : `► Scan ${candidateCount} derivations for a balance`}
      </button>

      {scan.kind === "done" && scan.funded.length === 0 && (
        <div style={{ ...rowStyle, color: "var(--text-dim)" }}>
          Checked {candidateCount} derivations — none hold a {adapter.ticker}{" "}
          balance. Your funds are most likely on a path outside the standard
          account/index range; paste the address below to find it.
        </div>
      )}

      {scan.kind === "blind" && (
        <div style={{ ...rowStyle, color: "var(--text-dim)" }}>
          Couldn't check — every balance lookup failed. This is a connectivity
          problem, not an answer: it does <em>not</em> mean these derivations
          are empty. Retry when you're back online.
        </div>
      )}

      {scan.kind === "done" &&
        scan.funded.map((f) => (
          <div key={f.path} style={{ ...rowStyle, borderColor: "var(--accent)" }}>
            <div style={{ color: "var(--accent)", marginBottom: 3 }}>
              {f.balance} {adapter.ticker} — {f.label}
            </div>
            <div style={{ color: "var(--text-dim)", fontSize: 9, wordBreak: "break-all" }}>
              {f.path}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 9, wordBreak: "break-all", marginTop: 2 }}>
              {f.address}
            </div>
            <button
              className="btn-icon"
              onClick={() => onCopy(f.address)}
              style={{ marginTop: 6, fontSize: 9 }}
            >
              Copy address
            </button>
          </div>
        ))}

      {/* ── Find ─────────────────────────────────────────────── */}
      <div style={{ marginTop: 12 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Paste your ${adapter.ticker} address from another wallet`}
          style={{
            width: "100%",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            padding: "6px 8px",
            background: "rgba(0,0,0,0.3)",
            border: "1px solid var(--border)",
            color: "var(--text)",
          }}
        />
        <button
          className="btn-icon"
          onClick={runFind}
          disabled={find.kind === "searching" || !input.trim()}
          style={{ marginTop: 6, fontSize: 9.5 }}
        >
          {find.kind === "searching" ? "Searching…" : "► Find its derivation"}
        </button>
      </div>

      {find.kind === "match" && (
        <div style={{ ...rowStyle, borderColor: "var(--accent)" }}>
          <div style={{ color: "var(--accent)", marginBottom: 3 }}>
            Found — {find.hit.label}
          </div>
          <div style={{ color: "var(--text-dim)", fontSize: 9, wordBreak: "break-all" }}>
            {find.hit.path}
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 9, marginTop: 4, lineHeight: 1.5 }}>
            That address belongs to this seed. Your funds are safe — this wallet
            is showing a different account from the same phrase.
          </div>
        </div>
      )}

      {find.kind === "no-match" && (
        <div style={{ ...rowStyle, color: "var(--text-dim)" }}>
          No derivation of this seed produces that address, within{" "}
          {candidateCount} candidates. Either it belongs to a different seed, or
          the source wallet uses a scheme this search doesn't cover yet.
        </div>
      )}
    </div>
  );
}
