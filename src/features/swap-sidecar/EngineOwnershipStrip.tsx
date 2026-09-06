import type { EngineOwnership } from "../../lib/swapSeedFingerprint";

/**
 * "The swap engine running here belongs to a different wallet."
 *
 * # Why this exists
 *
 * Pwnda Grove is a SINGLE sidecar bound to ONE seed — its datadir is stamped
 * with the fingerprint of the swap mnemonic that provisioned it. Switching
 * wallet context does not, and cannot, re-point it: the new wallet has no
 * engine until one is provisioned for it.
 *
 * The wallet already handles this correctly and silently. `engineIsThisWallets`
 * gates the C8 balance override, so a foreign engine can never speak for the
 * wallet on screen. But silence is the whole problem: the user switched wallet,
 * the Swap tab still shows a running node, and nothing says the node is not
 * theirs. They would reasonably read "node: on" as "I can swap from this
 * wallet" — and every balance the engine holds belongs to the OTHER wallet.
 *
 * # Why it takes an `EngineOwnership`, not a boolean
 *
 * `engineBelongsToWallet` folds "no engine at all" and "someone else's engine"
 * into one `false`, which is correct for its own job and useless here: warning
 * a user who has never enabled swaps that their engine belongs to another
 * wallet would be pure noise. Only `"foreign"` renders anything — `"unknown"`
 * (no node / not opted in / pre-binding install) and `"mine"` render null.
 *
 * Shared by BOTH swap surfaces (`SwapView` portrait and `SwapLandscapeView`)
 * per the landscape-first rule in CONTRIBUTING.md — this is exactly the shape that
 * has been shipped portrait-only three times already.
 */
export function EngineOwnershipStrip({
  ownership,
  compact = false,
}: {
  ownership: EngineOwnership;
  /** Tighter type + padding for the narrower portrait column. */
  compact?: boolean;
}) {
  if (ownership !== "foreign") return null;

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: compact ? "8px 10px" : "10px 14px",
        marginBottom: 10,
        background: "rgba(240,160,32,0.07)",
        border: "1px solid rgba(240,160,32,0.35)",
        borderRadius: 3,
        fontFamily: "var(--font-mono, var(--mono))",
        color: "var(--text)",
      }}
    >
      <span
        aria-hidden
        style={{ color: "#f0a020", fontSize: compact ? 11 : 12, lineHeight: 1.3 }}
      >
        ▲
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: compact ? 10 : 11,
            letterSpacing: 0.4,
            color: "#f0a020",
            marginBottom: 2,
          }}
        >
          SWAP ENGINE BELONGS TO A DIFFERENT WALLET
        </div>
        <div
          style={{
            fontSize: compact ? 9 : 10,
            color: "var(--text-dim)",
            lineHeight: 1.45,
          }}
        >
          The Grove node running on this machine was set up by another wallet in
          this vault, and holds that wallet's funds — not this one's. Balances
          it reports are deliberately hidden here. Switch back to that wallet to
          use it, or set up a node for this wallet.
        </div>
      </div>
    </div>
  );
}
