import { useEffect, useRef, useState } from "react";
import {
  BLOCKCHAIN_DISPLAY_NAME,
  type IntentsBlockchain,
} from "./near-intents-assets.generated";
import {
  defaultBlockchainFor,
  isMultiChainSymbol,
  pwndaDestinationChainsForSymbol,
  pwndaSourceChainsForSymbol,
} from "./intents-dedup";

/**
 * Compact "On chain: …" sub-selector rendered next to the symbol icon
 * in the swap form. Self-hides when the symbol exists on only one
 * blockchain (BTC, NEAR, etc.); renders the dropdown affordance only
 * when the user has a real choice to make.
 *
 * Source-side: filtered to chains the wallet can sign on.
 * Destination-side: shows every chain NEAR Intents supports.
 *
 * The chosen blockchain bubbles up via `onPick` — the parent owns the
 * form state and drives re-quoting from there.
 */
export function NetworkPill({
  symbol,
  blockchain,
  onPick,
  side,
}: {
  symbol: string;
  blockchain: IntentsBlockchain | null;
  onPick: (blockchain: IntentsBlockchain) => void;
  side: "source" | "destination";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const sourceOnly = side === "source";
  if (!isMultiChainSymbol(symbol, { sourceOnly })) {
    // Not multi-chain → render a static label so the user can still see
    // which chain is in play (no dropdown affordance, click does nothing).
    const default_ = defaultBlockchainFor(symbol, { sourceOnly });
    if (!default_) return null;
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "1px 6px",
          fontSize: 9,
          color: "var(--text-dim)",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid var(--border)",
          letterSpacing: 0.4,
          fontFamily: "var(--font-mono)",
        }}
      >
        on {BLOCKCHAIN_DISPLAY_NAME[default_]}
      </div>
    );
  }

  // Both sides restrict to chains Pwnda surfaces directly (i.e. has an
  // explicit chain adapter for, where the symbol IS that chain's
  // native gas token). For ETH that's only "Ethereum" — Arbitrum /
  // Base / Optimism don't appear in the picker because Pwnda has no
  // separate adapter that would surface a per-L2 balance or receive
  // notification. Per user request 2026-05-07: hide chains the wallet
  // doesn't explicitly support so users don't accidentally route funds
  // somewhere they can't see them in-app.
  const candidates = sourceOnly
    ? pwndaSourceChainsForSymbol(symbol)
    : pwndaDestinationChainsForSymbol(symbol);
  const current =
    blockchain ??
    (candidates[0]?.blockchain as IntentsBlockchain | undefined) ??
    null;

  return (
    <div
      ref={ref}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "1px 6px",
          fontSize: 9,
          color: "var(--accent)",
          background: "rgba(0,255,102,0.06)",
          border: "1px solid var(--accent)",
          letterSpacing: 0.4,
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Pick which chain ${symbol} lives on`}
      >
        on {current ? BLOCKCHAIN_DISPLAY_NAME[current] : "?"} ▾
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            left: 0,
            minWidth: 160,
            background: "var(--bg-2)",
            border: "1px solid var(--border-hi)",
            zIndex: 40,
            display: "flex",
            flexDirection: "column",
            padding: 2,
            boxShadow: "0 6px 18px rgba(0,0,0,0.55)",
          }}
        >
          {candidates.map((a) => {
            const isSelected = a.blockchain === current;
            return (
              <button
                type="button"
                key={a.blockchain}
                onClick={() => {
                  onPick(a.blockchain);
                  setOpen(false);
                }}
                style={{
                  textAlign: "left",
                  padding: "5px 8px",
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  color: isSelected ? "var(--accent)" : "var(--text)",
                  background: isSelected
                    ? "rgba(0,255,102,0.08)"
                    : "transparent",
                  border: "none",
                  borderLeft: isSelected
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  if (isSelected) return;
                  e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                }}
                onMouseLeave={(e) => {
                  if (isSelected) return;
                  e.currentTarget.style.background = "transparent";
                }}
              >
                {BLOCKCHAIN_DISPLAY_NAME[a.blockchain]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
