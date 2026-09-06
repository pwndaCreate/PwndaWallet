/**
 * Generic key/value row primitive. Used by mining earnings, swap quote
 * card, wallet metadata rail, settings tiles. Extracted from inlined
 * copies in MineLandscapeView, SwapLandscapeView, WalletLandscapeView
 * per ease-of-use-improvement-plan T3.1.
 */

export function KvRow({
  k,
  v,
  tnum = true,
  accent,
  upper = true,
}: {
  k: string;
  v: string;
  tnum?: boolean;
  accent?: boolean;
  upper?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <span
        style={{
          color: "var(--text-dim)",
          letterSpacing: upper ? 1 : 0.5,
          textTransform: upper ? "uppercase" : "none",
          fontFamily: "var(--font-mono)",
        }}
      >
        {k}
      </span>
      <span
        className={tnum ? "tnum" : ""}
        style={{
          color: accent ? "var(--accent)" : "var(--text)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {v}
      </span>
    </div>
  );
}
