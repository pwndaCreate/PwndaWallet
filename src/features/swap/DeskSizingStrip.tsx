/**
 * CC-25 — the desk's sizing window, in the app.
 *
 * ## Why this is safety and not decoration
 *
 * Two of the fields it renders are unsafe to leave out, and both have a fault
 * behind them:
 *
 * - **`coin`** (the desk's `sizeCoin`) exists BECAUSE documenting the
 *   denomination failed. Their config said "the follower coin" and their DTO
 *   said "whole units of coin_in" — both true on a SELL and silently different
 *   on a BUY — and the desk's own size gate believed the wrong one (their D23).
 *   A window rendered without its unit invites the reader to assume, which is
 *   the same assumption that broke it.
 * - **`unknown`** names which sizing TERM could not be looked up. Non-empty
 *   means the floor was never COMPUTED, which is a different thing from a floor
 *   that did not bind. Rendering a clean window over an unmeasured one is the
 *   lie, so the caveat is shown and never dropped.
 *
 * ## Where the rule lives
 *
 * Not here. `engine::sizing_for` + `engine::judge_size` in the Rust tier are
 * the single implementation, reached through `deskSizeCheck`. This component
 * asks and renders; it does not compare amounts to bounds. A third copy of the
 * rule (Rust, preflight, and here) is the two-places-holding-one-quantity fault
 * this project keeps paying for.
 */
import { useEffect, useState } from "react";

import { deskSizeCheck, type DeskSizeView } from "../../api/desk-rust";
import { deskDirectionFor, deskPairLabel } from "./asset-capabilities";

/** Colour per verdict. `cannotJudge` is deliberately NOT the error colour: it
 *  is not a refusal, it is the absence of an answer, and painting it red would
 *  tell the user their amount is wrong when what is actually true is that we
 *  cannot say. */
function toneFor(v: DeskSizeView["verdict"]): string {
  switch (v) {
    case "within":
      return "var(--accent)";
    case "belowMin":
    case "aboveMax":
      return "var(--danger, #ff5555)";
    default:
      return "var(--text-dim)";
  }
}

export function DeskSizingStrip({
  fromCoin,
  toCoin,
  amount,
}: {
  fromCoin: string;
  toCoin: string;
  amount: string;
}) {
  const [view, setView] = useState<DeskSizeView | null>(null);
  const [failed, setFailed] = useState<string>("");

  const pair = deskPairLabel(fromCoin, toCoin);
  const direction = deskDirectionFor(fromCoin, toCoin);

  useEffect(() => {
    if (!pair || !direction) {
      setView(null);
      return;
    }
    let cancelled = false;
    // Debounced: the amount changes on every keystroke and this is a desk
    // round trip over i2p.
    const t = setTimeout(() => {
      void deskSizeCheck(pair, direction, amount || "0", fromCoin.toUpperCase())
        .then((v) => {
          if (!cancelled) {
            setView(v);
            setFailed("");
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            // A failed lookup is COULD-NOT-LOOK about us, never a verdict about
            // the amount. Say so rather than rendering nothing, which would be
            // indistinguishable from "no window published".
            setView(null);
            setFailed(String(e));
          }
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pair, direction, amount, fromCoin]);

  if (!pair || !direction) return null;

  const label: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: "var(--text-dim)",
  };

  return (
    <div
      data-testid="desk-sizing-strip"
      style={{
        border: "1px solid var(--border-soft)",
        borderRadius: 4,
        padding: "10px 12px",
        margin: "12px 0 0",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <div style={{ ...label, marginBottom: 6 }}>desk size window</div>

      {failed && (
        <div data-testid="desk-sizing-unreadable" style={{ color: "var(--text-dim)" }}>
          Could not read the desk's window — this is our visibility, not a
          verdict on your amount. {failed}
        </div>
      )}

      {view && (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
            <span className="tnum" data-testid="desk-sizing-window">
              {view.min || "?"} – {view.max || "?"}{" "}
              <span style={{ color: "var(--text-dim)" }}>
                {/* The denomination is never implied. See D23. */}
                {view.coin || "(denomination not published)"}
              </span>
            </span>
            {view.minBasis && (
              <span style={label} data-testid="desk-sizing-basis">
                min: {view.minBasis}
              </span>
            )}
          </div>

          {view.message && (
            <div
              data-testid="desk-sizing-message"
              style={{ color: toneFor(view.verdict), marginTop: 6, lineHeight: 1.5 }}
            >
              {view.message}
            </div>
          )}

          {view.unknown.length > 0 && (
            <div
              data-testid="desk-sizing-unknown"
              style={{ color: "var(--text-dim)", marginTop: 6, lineHeight: 1.5 }}
            >
              <strong>{view.unknown.length} sizing input(s) could not be looked up</strong>,
              so this window was never fully computed:
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {view.unknown.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ ...label, marginTop: 6 }} data-testid="desk-sizing-source">
            from {view.source}
          </div>
        </>
      )}
    </div>
  );
}
