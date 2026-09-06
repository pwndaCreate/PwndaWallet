import { useCallback, useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import { getAdapter } from "../../wallets";
import type { ChainType } from "../../wallets/types";
import {
  satsToDecimal,
  assessGapHeadroom,
  STANDARD_GAP_LIMIT,
} from "../../wallets/utxo-account";
import {
  planLtcConsolidation,
  consolidateLtcAccount,
} from "../../wallets/ltc-wallet";
import {
  resolveUtxoAccountBalance,
  type UtxoAccountSummary,
} from "../../wallets/utxo-account-balance";
import {
  setUtxoAccountSummary,
  useUtxoAccountSummary,
} from "../../lib/utxoAccountRegistry";

/**
 * Where a UTXO wallet's coins actually are — and whether a seed restore would
 * find them.
 *
 * # Why this card exists
 *
 * The dashboard shows one number and one address. For a UTXO chain that pair
 * is an assumption, not a fact: outputs are spent whole, so change goes to a
 * fresh address on the internal chain, and the wallet's coins end up spread
 * across derivation indices nobody ever sees. On 2026-08-22 the swap engine
 * spent from the shared LTC wallet, change landed at `m/84'/2'/0'/1/20`, and
 * the app displayed `0` — correct for the one address it knew, wrong about
 * the wallet.
 *
 * # The recovery warning is the important half
 *
 * BIP-44 fixes the address gap limit at 20: a restoring wallet walks each
 * chain and gives up after 20 consecutive unused addresses. The engine
 * allocates change at `MAX(index) + 1` rather than the first unused index, so
 * with a lookahead pool of 20 already derived, real funds landed at index 20 —
 * exactly one past where a stock restore stops looking.
 *
 * That means a seed backup can be perfectly valid and still appear empty. This
 * card names the funds at risk and the gap limit needed to reach them, because
 * the moment a user needs that fact is the moment this app is unavailable.
 */
/**
 * Dismissed once, for every UTXO chain — the explanation is generic
 * ("this is ordinary receive/change bookkeeping, not several wallets and
 * not Monero's subaddress privacy feature"), not chain-specific, so seeing
 * it dismissed for one chain should not make it reappear for the next one.
 * `localStorage`, matching the existing `pwnda-layout` precedent for small,
 * purely-cosmetic UI preferences — a Tauri-store round-trip is overkill for
 * a one-time tip.
 */
const EXPLAINER_DISMISSED_KEY = "pwnda-utxo-account-explainer-dismissed";

export function UtxoAccountCard(props: {
  chain: ChainType;
  mnemonic: string;
  address: string;
  onCopy: (text: string) => void;
}) {
  const { chain, mnemonic, address, onCopy } = props;
  const summary = useUtxoAccountSummary(chain);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [explainerDismissed, setExplainerDismissed] = useState(
    () => localStorage.getItem(EXPLAINER_DISMISSED_KEY) === "1",
  );
  const dismissExplainer = useCallback(() => {
    localStorage.setItem(EXPLAINER_DISMISSED_KEY, "1");
    setExplainerDismissed(true);
  }, []);

  const adapter = getAdapter(chain);
  const ticker = adapter.ticker;
  const specs = adapter.utxoAccounts;

  const rescan = useCallback(
    async (allAccounts: boolean) => {
      if (!specs) return;
      setBusy(true);
      setError("");
      try {
        const s = await resolveUtxoAccountBalance(chain, specs, mnemonic, address, {
          force: true,
          allAccounts,
        });
        setUtxoAccountSummary(chain, s);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [chain, specs, mnemonic, address],
  );

  const copyList = useCallback(() => {
    if (!summary) return;
    const lines = summary.entries.map(
      (e) => `${e.path}\t${e.address}\t${satsToDecimal(e.balanceSat)} ${ticker}`,
    );
    onCopy(
      [
        `# ${adapter.displayName} account addresses`,
        `# gap limit needed for a full restore: ${summary.requiredGapLimit}`,
        ...lines,
      ].join("\n"),
    );
  }, [summary, ticker, adapter.displayName, onCopy]);

  if (!specs) return null;

  return (
    <Card style={{ marginTop: 10 }}>
      <div className="secret-row">
        <div className="secret-header">
          <span className="label" style={{ color: "var(--accent)" }}>
            <ST delay={0} speed={20}>{`${adapter.displayName} account addresses`}</ST>
          </span>
        </div>

        <div
          style={{
            fontSize: 10,
            color: "var(--text-dim)",
            marginBottom: 8,
            lineHeight: 1.5,
          }}
        >
          A {ticker} wallet is an <em>account</em>, not one address. Spending an
          output sends the remainder to a fresh <strong style={{ color: "var(--text)" }}>change
          address</strong> under the same seed — so your coins can sit at a path
          you have never seen. This is every address of yours that holds or has
          held funds.
        </div>

        {!summary && (
          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
            Not scanned yet this session.
          </div>
        )}

        {summary && (
          <>
            {/* Scope line — a number without its scope is how the illusion
                started, so the count and completeness are stated, always. */}
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 6 }}>
              {summary.complete ? (
                <>
                  Scanned <strong style={{ color: "var(--text)" }}>{summary.scanned}</strong>{" "}
                  {summary.scanned === 1 ? "address" : "addresses"} across the
                  receive and change chains
                  {summary.deep ? "" : " (cached set)"} —{" "}
                  <strong style={{ color: "var(--accent)" }}>
                    {satsToDecimal(summary.totalSat)} {ticker}
                  </strong>
                </>
              ) : (
                <span style={{ color: "var(--warn, #ffb020)" }}>
                  Scan incomplete ({summary.scanned} probed) — a block explorer
                  is rate-limiting this network, so some addresses could not be
                  checked. The total below is a lower bound, not a balance. Your
                  coins are unaffected; try Rescan in a few minutes.
                </span>
              )}
            </div>

            {/* First-encounter explainer (2026-08-23) — shown once, ever,
                the first time a chain's own account genuinely has funds at
                more than one address. Names and rules out the wrong model
                directly (Monero subaddresses) rather than only asserting the
                right one, because that specific wrong model is what a user
                reaches for on seeing "funds at several addresses" and
                nothing here previously said it wasn't that. */}
            {!explainerDismissed &&
              summary.entries.filter((e) => e.balanceSat > 0).length > 1 && (
                <div
                  style={{
                    marginBottom: 8,
                    padding: "8px 10px",
                    border: "1px solid var(--border)",
                    background: "rgba(255,255,255,0.02)",
                    fontSize: 10,
                    lineHeight: 1.5,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 8,
                    }}
                  >
                    <div style={{ color: "var(--text-dim)" }}>
                      This is <strong style={{ color: "var(--text)" }}>one account</strong>,
                      not several wallets — and it isn't Monero's subaddress
                      privacy feature either. It's the same seed's ordinary
                      receive/change bookkeeping: every {ticker} spend can
                      send its remainder to a fresh address under this same
                      seed, the way every UTXO chain works.
                    </div>
                    <button
                      className="btn-icon"
                      onClick={dismissExplainer}
                      aria-label="Dismiss this explanation"
                      style={{ fontSize: 10, padding: "2px 6px", flexShrink: 0 }}
                    >
                      Got it
                    </button>
                  </div>
                </div>
              )}

            {/* PROACTIVE (2026-08-25). The stranded warning below fires
                once money is already unreachable — which is exactly when the
                user can no longer avoid it. BIP-44 asks for a warning BEFORE
                the gap limit is exceeded and, per a survey of six major
                wallets, nobody implements one. This is that warning; it is
                mutually exclusive with the stranded panel because
                `assessGapHeadroom` reports `stranded` in preference to
                `approaching`. */}
            {(() => {
              const head = assessGapHeadroom({ entries: summary.entries });
              if (head.state !== "approaching") return null;
              return (
                <div
                  style={{
                    marginTop: 8,
                    marginBottom: 8,
                    padding: "8px 10px",
                    border: "1px solid var(--border)",
                    background: "rgba(255,255,255,0.02)",
                    fontSize: 10,
                    lineHeight: 1.5,
                  }}
                >
                  <div style={{ color: "var(--text)", marginBottom: 4 }}>
                    Heads-up: this account is {head.headroom}{" "}
                    {head.headroom === 1 ? "address" : "addresses"} away from the
                    standard restore limit
                  </div>
                  <div style={{ color: "var(--text-dim)" }}>
                    Your coins sit at derivation indexes with a gap of{" "}
                    <strong style={{ color: "var(--text)" }}>{head.widestGap}</strong>{" "}
                    unused {head.chainIndex === 1 ? "change" : "receive"} addresses
                    in it. A wallet restoring this seed gives up after{" "}
                    {STANDARD_GAP_LIMIT} in a row, so nothing is at risk yet — but
                    if a future payment lands further along, that restore would
                    stop short of it. Nothing to do right now; this is the point
                    at which it is still easy to fix.
                  </div>
                </div>
              );
            })()}

            {summary.strandedSat > 0 && (
              <div
                style={{
                  marginTop: 8,
                  marginBottom: 8,
                  padding: "8px 10px",
                  border: "1px solid var(--warn, #ffb020)",
                  background: "rgba(255,176,32,0.08)",
                  fontSize: 10,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ color: "var(--warn, #ffb020)", marginBottom: 4 }}>
                  ⚠ A standard seed restore would not find all of this
                </div>
                <div style={{ color: "var(--text-dim)" }}>
                  <strong style={{ color: "var(--text)" }}>
                    {satsToDecimal(summary.strandedSat)} {ticker}
                  </strong>{" "}
                  sits past the standard gap limit of {STANDARD_GAP_LIMIT}. Restoring
                  this seed into Electrum or a hardware wallet will show a{" "}
                  <em>smaller</em> balance unless you raise the address gap limit to{" "}
                  <strong style={{ color: "var(--text)" }}>
                    {summary.requiredGapLimit}
                  </strong>{" "}
                  or more. The coins are safe and the seed is correct — the
                  scanner simply stops looking too early.
                </div>
              </div>
            )}

            <div style={{ marginTop: 6 }}>
              {summary.entries.length === 0 && (
                <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                  No address in this account has any history yet.
                </div>
              )}
              {/* ONE bounded list, not N separate boxes (2026-08-23). Each
                  address used to get its own full border, which reads as
                  "N separate accounts" on a skim regardless of any caption
                  above it — the exact wrong impression the explainer above
                  exists to correct. A single outer border + thin row
                  dividers + a left accent bar for funded/stranded status
                  keeps the "one account" framing intact while still
                  distinguishing rows at a glance. */}
              {summary.entries.length > 0 && (
                <div style={{ border: "1px solid var(--border)" }}>
                  {summary.entries.map((e, i) => {
                    const funded = e.balanceSat > 0;
                    const stranded = summary.strandedEntries.some(
                      (s) => s.path === e.path,
                    );
                    return (
                      <div
                        key={e.path}
                        style={{
                          padding: "6px 8px",
                          background: stranded
                            ? "rgba(255,176,32,0.08)"
                            : funded
                              ? "rgba(0,255,102,0.06)"
                              : "transparent",
                          borderTop: i === 0 ? "none" : "1px solid var(--border)",
                          borderLeft: stranded
                            ? "2px solid var(--warn, #ffb020)"
                            : funded
                              ? "2px solid var(--accent)"
                              : "2px solid transparent",
                          fontFamily: "var(--font-mono)",
                          fontSize: 9,
                        }}
                      >
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <span style={{ color: "var(--text-dim)" }}>{e.path}</span>
                          <span style={{ flex: 1 }} />
                          <span style={{ color: funded ? "var(--accent)" : "var(--text-dim)" }}>
                            {satsToDecimal(e.balanceSat)} {ticker}
                          </span>
                        </div>
                        <div
                          style={{
                            wordBreak: "break-all",
                            color: "var(--text-dim)",
                            marginTop: 3,
                          }}
                        >
                          {e.address}
                          {e.chainIndex === 1 && (
                            <span style={{ color: "var(--text-dim)" }}> · change</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {error && (
          <div style={{ fontSize: 10, color: "var(--err, #ff5f5f)", marginTop: 8 }}>
            {error}
          </div>
        )}

        {summary && (
          <ConsolidatePanel
            chain={chain}
            address={address}
            ticker={ticker}
            mnemonic={mnemonic}
            summary={summary}
            onDone={() => void rescan(false)}
          />
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button className="btn-icon" onClick={() => void rescan(false)} disabled={busy}>
            {busy ? "Scanning…" : "Rescan"}
          </button>
          {/* Widens to every derivation the adapter knows (e.g. LTC's legacy
              BIP-44 account) — double the requests, so it is opt-in. */}
          <button className="btn-icon" onClick={() => void rescan(true)} disabled={busy}>
            Scan all derivations
          </button>
          {summary && summary.entries.length > 0 && (
            <button className="btn-icon" onClick={copyList}>
              Copy address list
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Bring an account's scattered outputs back to its own displayed address.
 *
 * # Why this is a two-step confirm and not a button
 *
 * It spends. Every surveyed wallet keeps consolidation manual and explicit
 * (see `planLtcConsolidation`'s doc for the survey and the three reasons), so
 * this shows what would move, what it costs, and where it lands BEFORE it can
 * be run — the same shape `LitecoinDerivationPanel`'s "Move balance…" uses.
 *
 * # The in-flight-swap caveat is copy, not a check — deliberately
 *
 * `planLtcConsolidation` accepts a `swapInFlight` flag and refuses on it, but
 * this card has no way to know: it lives in the wallet feature and the swap
 * tracker's state is owned by a hook mounted above the router, three call
 * sites away. `SweepBackSection` — the closest existing analogue, which moves
 * coins off the swap node — answers the identical question with the identical
 * static warning rather than plumbing state across that boundary. This follows
 * that precedent instead of inventing a second one. If a global active-swap
 * store ever lands (the way `utxoAccountRegistry` did for scans), wire it into
 * the `swapInFlight` argument here and the copy becomes a real gate.
 */
function ConsolidatePanel({
  chain,
  address,
  ticker,
  mnemonic,
  summary,
  onDone,
}: {
  chain: ChainType;
  address: string;
  ticker: string;
  mnemonic: string;
  summary: UtxoAccountSummary;
  onDone: () => void;
}) {
  const [stage, setStage] = useState<"idle" | "review" | "sending" | "done">(
    "idle",
  );
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ hash: string; moved: number } | null>(
    null,
  );

  // LTC only for now. BTC has the identical shape and the same allocator
  // history, but it has never been spent from by the engine, so its change
  // chain is still untouched — building and shipping an unexercised
  // fund-moving path is worse than not offering it yet.
  if (chain !== "litecoin") return null;

  const funded = summary.entries.filter((e) => e.balanceSat > 0);
  if (funded.length < 2) return null;

  // Preview only. The executor re-plans against freshly fetched UTXOs and
  // re-prices against the REAL input count, so this is an estimate the user
  // sees, never the numbers that get signed.
  const preview = planLtcConsolidation({
    // The card's own displayed address — the SAME index-0 receive address
    // `consolidateLtcAccount` derives internally. Reading entries[0] instead
    // happened to agree (the walk lists 0/0 first) but would silently label a
    // different destination the moment an account had no 0/0 entry.
    destination: address,
    entries: funded.map((e) => ({
      path: e.path,
      address: e.address,
      chainIndex: e.chainIndex,
      index: e.index,
      balanceSat: e.balanceSat,
    })),
    // A representative LTC rate for the preview; the send resolves its own.
    feePerVB: 5,
  });

  const run = () => {
    setStage("sending");
    setError("");
    void consolidateLtcAccount(mnemonic)
      .then((r) => {
        setResult({ hash: r.hash, moved: r.movedLits });
        setStage("done");
        onDone();
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setStage("review");
      });
  };

  if (stage === "done" && result) {
    return (
      <div style={{ ...BOX, borderColor: "var(--accent)" }}>
        <div style={{ color: "var(--accent)", marginBottom: 4 }}>
          Sent — your coins are on their way to one address
        </div>
        <div style={{ color: "var(--text-dim)", wordBreak: "break-all" }}>
          {satsToDecimal(result.moved)} {ticker}, tx {result.hash}. It will show
          as one balance once it confirms.
        </div>
      </div>
    );
  }

  return (
    <div style={BOX}>
      {stage === "idle" ? (
        <>
          <div style={{ color: "var(--text)", marginBottom: 4 }}>
            Your coins are spread across {funded.length} addresses
          </div>
          <div style={{ color: "var(--text-dim)", marginBottom: 8 }}>
            That is normal, and nothing is wrong. Bringing them together makes
            future sends cheaper and keeps a seed restore well inside the
            standard scan range — at the cost of one network fee now, and of
            publicly linking these addresses as belonging to one wallet.
          </div>
          <button className="btn-icon" onClick={() => setStage("review")}>
            Bring coins together…
          </button>
        </>
      ) : (
        <>
          <div style={{ color: "var(--text)", marginBottom: 6 }}>
            Review — nothing has been sent
          </div>
          <div style={{ color: "var(--text-dim)", marginBottom: 6 }}>
            Moves{" "}
            <strong style={{ color: "var(--text)" }}>
              {satsToDecimal(preview.totalSat)} {ticker}
            </strong>{" "}
            from {preview.sources.length}{" "}
            {preview.sources.length === 1 ? "address" : "addresses"} into your
            main address. The destination is derived from your own seed — it is
            not typed in, and nothing on this screen can change where it goes.
          </div>
          <div style={{ color: "var(--text-dim)", marginBottom: 6 }}>
            Estimated network fee ~{satsToDecimal(preview.feeSat)} {ticker}. The
            real fee is resolved when you confirm.
          </div>
          <div style={{ color: "var(--warn, #ffb020)", marginBottom: 8 }}>
            If a swap is still running, some of these coins may be committed to
            it. Let any in-flight swap finish first.
          </div>
          {preview.blocked && (
            <div style={{ color: "var(--warn, #ffb020)", marginBottom: 8 }}>
              {preview.blocked}
            </div>
          )}
          {error && (
            <div style={{ color: "var(--err, #ff5f5f)", marginBottom: 8 }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn-icon"
              disabled={stage === "sending"}
              onClick={() => setStage("idle")}
            >
              Cancel
            </button>
            <button
              className="btn-icon"
              disabled={stage === "sending" || !!preview.blocked}
              onClick={run}
            >
              {stage === "sending"
                ? "Sending…"
                : `Send — bring ${preview.sources.length} ${
                    preview.sources.length === 1 ? "address" : "addresses"
                  } together`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const BOX: React.CSSProperties = {
  marginTop: 10,
  padding: "8px 10px",
  border: "1px solid var(--border)",
  background: "rgba(255,255,255,0.02)",
  fontSize: 10,
  lineHeight: 1.5,
};
