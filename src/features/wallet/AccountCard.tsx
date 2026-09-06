import { ST } from "../../components/Primitives";
import { Card, MiniSpark } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import { placeholderSparkFor } from "./spark-fallback";
import type {
  ChainAdapter,
  ChainType,
  NetworkInfo,
  WalletInfo,
} from "../../wallets";

/**
 * Dashboard account card — address row + balance display + optional
 * network info (gas price, fee tier, etc.). The Monero variant
 * supports two address modes: primary `4…` (default; what most
 * explorers show) and per-payment subaddress `8…` (rotated via
 * "New"). The toggle persists for the session.
 *
 * Refresh button calls `onRefresh`; the chain-specific busy spinner
 * lives in the parent `loading` flag (shared with `refreshBalance`).
 *
 * `copiedKey` is the opaque per-target copy-feedback marker
 * documented in BEHAVIORS §2.2 — a button flips to green ✓ for ~1.4s
 * after a successful copy. The keys "xmr-receive" / "address" are
 * specific to this card.
 */
export function AccountCard({
  wallet,
  adapter,
  activeChain,
  balance,
  networkInfo,
  loading,
  onRefresh,
  copiedKey,
  onCopy,
  // Monero-specific receive-address controls
  xmrReceiveAddress,
  xmrShowPrimary,
  setXmrShowPrimary,
  onNewXmrSubaddress,
  // UTXO receive-address rotation (BTC/LTC/DOGE/DASH/BCH/RVN)
  utxoReceiveAddress,
  utxoShowPrimary,
  setUtxoShowPrimary,
  usdPrice,
  priceHistory,
}: {
  wallet: WalletInfo;
  adapter: ChainAdapter;
  activeChain: ChainType;
  balance: string;
  networkInfo: NetworkInfo | null;
  loading: boolean;
  onRefresh: () => void;
  copiedKey: string | null;
  onCopy: (text: string, key?: string) => void;
  xmrReceiveAddress: string | null;
  xmrShowPrimary: boolean;
  setXmrShowPrimary: (v: boolean) => void;
  onNewXmrSubaddress: () => Promise<void>;
  /**
   * A fresh, never-used receive address for UTXO chains — the equivalent of
   * Exodus's "Multiple Addresses". `null` whenever it cannot be established
   * (no account scan yet, or an incomplete one), and the primary is shown
   * instead: handing out a stale address while labelling it fresh is worse
   * than not offering one, because the user publishes it.
   */
  utxoReceiveAddress: string | null;
  utxoShowPrimary: boolean;
  setUtxoShowPrimary: (v: boolean) => void;
  usdPrice?: number;
  /** 24h historical USD price series for the active chain's ticker
   *  (downsampled to ~24 points by `fetchUsdPriceHistory`). Drives
   *  the per-asset sparkline. Optional — when undefined or empty the
   *  sparkline renders a flat-zero baseline rather than the previous
   *  hand-coded `[3,4,3,5,4,5,6,5,7,6,8]` synthetic curve. */
  priceHistory?: number[];
}) {
  // Per-asset spark — show the user's *position value* (balance ×
  // price) over the 24h window when we have real data. For a single
  // chain this is shape-identical to the raw price chart (MiniSpark
  // renormalises by min/max), but framing it as position value makes
  // the chart unambiguously "your ETH" rather than "ETH price chart".
  // Falls back to a flat baseline rather than a fake upward curve.
  const balanceNumeric = (() => {
    if (!balance || balance === "--" || balance === "—" || balance === "Not initialized") {
      return 0;
    }
    const n = parseFloat(balance.replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
  const hasRealHistory = !!priceHistory && priceHistory.length >= 2;
  // Multiply by balance so the spark reflects the user's position
  // value over time. When balance is zero (or unparsable), the spark
  // collapses to a flat baseline — which is the correct visual for
  // "you don't hold this".
  const positionSeries: number[] = hasRealHistory
    ? balanceNumeric > 0
      ? priceHistory!.map((p) => p * balanceNumeric)
      : new Array(priceHistory!.length).fill(0)
    : balanceNumeric > 0
      // History not loaded yet but the user HOLDS this asset — show a
      // per-ticker placeholder curve (dim) instead of a flat line, matching
      // the landscape view so portrait charts never look "broken". Real
      // data replaces it on the next price refresh.
      ? placeholderSparkFor(adapter.ticker.toUpperCase())
      : new Array(11).fill(0);
  // Color the spark green when the position rose over the window,
  // amber when it fell, dim when there's no data. MiniSpark itself is
  // stroke-only, so the color carries the directional cue.
  const positionDirection: "up" | "down" | "flat" = (() => {
    if (!hasRealHistory || balanceNumeric === 0) return "flat";
    const first = positionSeries[0];
    const last = positionSeries[positionSeries.length - 1];
    if (first <= 0 || last <= 0) return "flat";
    return last >= first ? "up" : "down";
  })();
  const sparkColor =
    positionDirection === "up"
      ? "var(--accent)"
      : positionDirection === "down"
        ? "var(--warn, #ffae42)"
        : "var(--text-dim)";
  return (
    <Card
      title="ACCOUNT"
      style={{ marginBottom: 14 }}
      right={
        <button
          className="btn-icon"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh"
        >
          {loading ? "..." : "↻"}
        </button>
      }
    >
      {(() => {
        const showSubaddress =
          activeChain === "monero" && xmrReceiveAddress && !xmrShowPrimary;
        // Same shape as Monero's subaddress above, one chain family over. This
        // ONLY changes what is displayed and copied. `wallet.address` still
        // backs Send's change output, the balance-cache fingerprint and what
        // the swap engine watches -- rotating those too would produce a wallet
        // that shows one address and spends from another.
        const showUtxoRotated =
          !showSubaddress && !!utxoReceiveAddress && !utxoShowPrimary;
        const addr = showSubaddress
          ? xmrReceiveAddress!
          : showUtxoRotated
            ? utxoReceiveAddress!
            : wallet.address;
        const labelKey = showSubaddress
          ? "xmr-receive"
          : showUtxoRotated
            ? "utxo-receive"
            : "address";
        const labelText = showSubaddress || showUtxoRotated ? "RCV" : "ADDR";
        const truncated =
          addr.length > 20 ? `${addr.slice(0, 10)}…${addr.slice(-8)}` : addr;
        return (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 12px",
                background: "#060606",
                border: "1px solid var(--border-soft)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
              }}
            >
              <span style={{ color: "var(--text-dim)", letterSpacing: 1.2 }}>
                {labelText}
              </span>
              <span
                title={addr}
                style={{
                  color: "var(--text)",
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {truncated}
              </span>
              <button
                className="btn-icon btn-small"
                onClick={() => onCopy(addr, labelKey)}
                title="Copy address"
                style={
                  copiedKey === labelKey
                    ? { color: "var(--accent)", borderColor: "var(--accent)" }
                    : undefined
                }
              >
                {copiedKey === labelKey ? "✓" : "⎘"}
              </button>
              <button
                className="btn-icon btn-small"
                onClick={() => onCopy(addr, "qr")}
                title="QR — copies address (modal coming in v2.1)"
              >
                ▦
              </button>
            </div>
            {utxoReceiveAddress && (
              <div
                className="gas-info"
                style={{ display: "flex", gap: 12, marginTop: 4, alignItems: "center" }}
              >
                <span style={{ flex: 1 }}>
                  {showUtxoRotated
                    ? "Fresh receive address — never used. Reusing one address publicly links every deposit you take."
                    : "Primary address (reused). Show a fresh one to keep deposits from being linked on-chain."}
                </span>
                <button
                  className="btn-icon btn-small"
                  onClick={() => setUtxoShowPrimary(showUtxoRotated)}
                  title={
                    showUtxoRotated
                      ? "Show the primary address instead"
                      : "Show a fresh, never-used receive address"
                  }
                >
                  {showUtxoRotated ? "Show primary" : "Fresh address"}
                </button>
              </div>
            )}
            {activeChain === "monero" && xmrReceiveAddress && (
              <div
                className="gas-info"
                style={{ display: "flex", gap: 12, marginTop: 4, alignItems: "center" }}
              >
                <span style={{ flex: 1 }}>
                  {showSubaddress
                    ? "Subaddress (8…) — privacy-preserving per-payment receive."
                    : "Primary (4…). Generate a fresh subaddress (8…) for per-payment privacy."}
                </span>
                {showSubaddress ? (
                  <>
                    <button className="btn-icon btn-small" onClick={onNewXmrSubaddress}>
                      New
                    </button>
                    <button
                      className="btn-icon btn-small"
                      onClick={() => setXmrShowPrimary(true)}
                    >
                      Show primary
                    </button>
                  </>
                ) : (
                  <button
                    className="btn-icon btn-small"
                    onClick={() => setXmrShowPrimary(false)}
                  >
                    Show subaddress
                  </button>
                )}
              </div>
            )}
          </>
        );
      })()}

      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
        <CoinIcon sym={adapter.ticker} size={42} accent={adapter.color} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              letterSpacing: 1.2,
              textTransform: "uppercase",
            }}
          >
            {adapter.displayName}
          </div>
          <div className="hero-num tnum" style={{ fontSize: 26, lineHeight: 1.1, marginTop: 2 }}>
            <ST speed={18} delay={120}>{balance}</ST>
            <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}>
              {adapter.ticker}
            </span>
          </div>
          {usdPrice !== undefined && balance !== "--" && (
            <div className="tnum" style={{
              fontSize: 11, color: "var(--text-muted)", marginTop: 2,
              fontFamily: "var(--font-mono)",
            }}>
              ≈ ${(parseFloat(balance.replace(/,/g, "") || "0") * usdPrice)
                .toLocaleString("en-US", { maximumFractionDigits: 2 })}
            </div>
          )}
        </div>
        {/* Per-asset spark — wired through `priceHistory` (24h USD
            series for the active chain's ticker). Renders position
            value over time (balance × price) so the chart is
            unambiguously about the user's holding, not generic
            market data. Falls back to a flat baseline when no
            history is available or balance is zero. Color carries
            the directional cue (accent up / warn down / dim flat);
            the chain's brand color is kept on the wordmark + icon. */}
        <MiniSpark
          values={positionSeries}
          w={64}
          h={28}
          color={sparkColor}
        />
      </div>

      {networkInfo && (
        <div className="gas-info">
          {networkInfo.label}: {networkInfo.value} {networkInfo.unit}
        </div>
      )}
    </Card>
  );
}
