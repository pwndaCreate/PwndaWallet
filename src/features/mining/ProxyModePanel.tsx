import { useEffect, useState } from "react";
import type { ProxyApi } from "./useProxyPool";

/**
 * Braille-character spinner animation. Tiny inline component that cycles
 * through the standard 10-frame `dots` pattern at 80 ms per frame —
 * matches the terminal aesthetic of the rest of the UI without a CSS
 * keyframes setup. Mounting/unmounting starts/stops the timer cleanly.
 */
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function BrailleSpinner({ color = "var(--accent, #00cc66)" }: { color?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % BRAILLE_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      style={{
        display: "inline-block",
        minWidth: "1ch",
        color,
        fontFamily: "var(--mono)",
      }}
      aria-hidden="true"
    >
      {BRAILLE_FRAMES[i]}
    </span>
  );
}

/**
 * UI for SOCKS5 Proxy Mode (see `useProxyPool` + `socks5-proxy-mode.md`).
 * Renders a toggle, the one-time risk-acceptance modal, the live status
 * line, and a manual proxy-pick dropdown for users who want to override
 * the auto-selected top-of-rank entry.
 *
 * Designed to inline cleanly under the Pool dropdown in both portrait
 * (MiningView) and landscape (MineLandscapeView). The disabled state for
 * `gpuOctopusBlock` reflects the lolMiner-has-no-proxy-flag gap; clean
 * messaging keeps the user oriented.
 */
export function ProxyModePanel({
  proxy,
  disabled,
  gpuOctopusBlock,
  compact,
}: {
  proxy: ProxyApi;
  /** Hard-disable the toggle entirely (e.g. mining is in progress). */
  disabled?: boolean;
  /** True when the current selection is GPU + Octopus → lolMiner.
   *  Surfaces a hint that proxy mode won't work for this combo. */
  gpuOctopusBlock?: boolean;
  /** Portrait variant has tighter typography. */
  compact?: boolean;
}) {
  const {
    proxyMode,
    setProxyMode,
    torMode,
    setTorMode,
    acceptedRisk,
    acceptRisk,
    proxyState,
    refreshing,
    refreshError,
    selectedProxy,
    pinnedProxy,
    setPinnedProxy,
    failedProxies,
    refresh,
    target,
  } = proxy;

  const [showWarning, setShowWarning] = useState(false);

  const baseFontSize = compact ? 9 : 10;
  const padding = compact ? 8 : 10;

  const onToggle = () => {
    if (disabled) return;
    if (!proxyMode) {
      // Going from OFF → ON. Show one-time warning if not yet accepted.
      if (!acceptedRisk) {
        setShowWarning(true);
        return;
      }
      setProxyMode(true);
    } else {
      setProxyMode(false);
    }
  };

  const onToggleTor = () => {
    if (disabled) return;
    // No risk modal — Tor is the privacy-positive transport (the public-proxy
    // warning is about untrusted third-party operators, which Tor isn't).
    setTorMode(!torMode);
  };

  const accept = () => {
    acceptRisk();
    setProxyMode(true);
    setShowWarning(false);
  };

  const working = proxyState?.validated.filter((p) => p.ok) ?? [];
  const visibleWorking = working.filter((p) => !failedProxies.has(p.hostPort));

  return (
    <div
      style={{
        marginTop: 6,
        border: "1px solid rgba(255,255,255,0.18)",
        background: "rgba(255,255,255,0.03)",
        padding,
        fontFamily: "var(--mono)",
        fontSize: baseFontSize,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--text)",
            letterSpacing: 0.6,
          }}
        >
          <span style={{ color: "var(--warn, #ffb547)" }}>⚠</span>
          PROXY MODE
          {proxyMode && (
            <span style={{ marginLeft: 4, color: "var(--accent, #00cc66)" }}>
              · ACTIVE
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          style={{
            fontFamily: "var(--mono)",
            fontSize: baseFontSize,
            letterSpacing: 1,
            textTransform: "uppercase",
            background: proxyMode ? "rgba(0,204,102,0.15)" : "transparent",
            border: "1px solid rgba(255,255,255,0.18)",
            color: proxyMode ? "var(--accent, #00cc66)" : "var(--text-dim)",
            padding: "3px 10px",
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          {proxyMode ? "ON" : "OFF"}
        </button>
      </div>

      {proxyMode && (
        <>
          {gpuOctopusBlock && (
            <div
              style={{
                marginTop: 8,
                fontSize: compact ? 9 : 10,
                color: "var(--danger, #ff6b6b)",
              }}
            >
              Octopus (CFX) uses lolMiner, which has no SOCKS5 support. Switch
              to a different coin/algo or use CPU mining over proxy.
            </div>
          )}

          <div
            style={{
              marginTop: 8,
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "var(--text-dim)", display: "inline-flex", alignItems: "center", gap: 6 }}>
              {refreshing ? (
                <>
                  <BrailleSpinner />
                  <span>
                    Validating proxies
                    {proxyState && proxyState.candidatesValidated > 0
                      ? ` (last batch: ${proxyState.workingCount}/${proxyState.candidatesValidated})`
                      : "…"}
                  </span>
                </>
              ) : !proxyState ? (
                "Awaiting first refresh"
              ) : (
                `Working: ${visibleWorking.length}/${proxyState.candidatesValidated} tested`
              )}
            </span>
            <button
              type="button"
              onClick={() => refresh(true)}
              disabled={refreshing || !target}
              style={{
                marginLeft: "auto",
                fontFamily: "var(--mono)",
                fontSize: baseFontSize,
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "var(--text)",
                padding: "3px 10px",
                cursor: refreshing ? "wait" : "pointer",
              }}
            >
              {refreshing ? "…" : "Refresh"}
            </button>
          </div>

          {selectedProxy && (
            <>
              <div style={{ marginTop: 6, color: "var(--text)" }}>
                Active: <code>{selectedProxy.hostPort}</code>{" "}
                <span style={{ color: "var(--text-dim)" }}>
                  ({selectedProxy.latencyMs}ms)
                </span>
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: compact ? 8 : 9,
                  color: "var(--text-dim)",
                  fontStyle: "italic",
                }}
              >
                Reliable proxies hit ~3% dev fee target; flaky ones cause
                repeated reconnects and reduced crediting.
              </div>
            </>
          )}

          {!selectedProxy && proxyState && !refreshing && (
            <div
              style={{
                marginTop: 6,
                color: "var(--danger, #ff6b6b)",
              }}
            >
              No working proxies for this pool. Click Refresh to retry, or
              switch to a different pool.
            </div>
          )}

          {refreshError && (
            <div
              style={{
                marginTop: 6,
                color: "var(--danger, #ff6b6b)",
              }}
            >
              {refreshError}
            </div>
          )}

          {visibleWorking.length > 1 && (
            <div style={{ marginTop: 8 }}>
              <label
                style={{
                  display: "block",
                  fontSize: compact ? 8 : 9,
                  color: "var(--text-dim)",
                  marginBottom: 3,
                  letterSpacing: 0.6,
                }}
              >
                PIN PROXY (advanced)
              </label>
              <select
                value={pinnedProxy ?? ""}
                onChange={(e) => setPinnedProxy(e.target.value || null)}
                style={{
                  width: "100%",
                  fontFamily: "var(--mono)",
                  fontSize: baseFontSize,
                  background: "var(--bg-2)",
                  color: "var(--text)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  padding: "4px 8px",
                }}
              >
                <option value="">Auto (top-of-rank)</option>
                {visibleWorking.map((p) => (
                  <option key={p.hostPort} value={p.hostPort}>
                    {p.hostPort} — {p.latencyMs}ms
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
      )}

      {/* ── Maximum privacy (Tor) — opt-in transport ───────────────── */}
      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid rgba(255,255,255,0.12)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--text)",
            letterSpacing: 0.6,
          }}
        >
          <span aria-hidden="true">🧅</span>
          MAX PRIVACY (TOR)
          {torMode && (
            <span style={{ marginLeft: 4, color: "var(--accent, #00cc66)" }}>
              · ACTIVE
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onToggleTor}
          disabled={disabled}
          style={{
            fontFamily: "var(--mono)",
            fontSize: baseFontSize,
            letterSpacing: 1,
            textTransform: "uppercase",
            background: torMode ? "rgba(0,204,102,0.15)" : "transparent",
            border: "1px solid rgba(255,255,255,0.18)",
            color: torMode ? "var(--accent, #00cc66)" : "var(--text-dim)",
            padding: "3px 10px",
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          {torMode ? "ON" : "OFF"}
        </button>
      </div>

      {torMode && (
        <>
          {gpuOctopusBlock && (
            <div
              style={{
                marginTop: 8,
                fontSize: compact ? 9 : 10,
                color: "var(--danger, #ff6b6b)",
              }}
            >
              Octopus (CFX) uses lolMiner, which has no SOCKS5 support — Tor
              can't carry it. Use CPU mining or a different coin/algo.
            </div>
          )}
          <div style={{ marginTop: 6, color: "var(--text)" }}>
            Routing through Tor (auto-detects <code>:9050</code> /{" "}
            <code>:9150</code>)
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: compact ? 8 : 9,
              color: "var(--text-dim)",
              fontStyle: "italic",
              lineHeight: 1.5,
            }}
          >
            Anonymous to the pool; a <code>.onion</code> pool is also MITM-proof
            (no cert-pin needed). <strong>Requires Tor running</strong> — open
            Tor Browser (port 9150) or start a tor service (9050) before mining;
            a bundled Tor is coming. Adds ~1–2% stale shares (fine for RandomX).
          </div>
        </>
      )}

      {showWarning && (
        <div
          className="modal-overlay"
          onClick={() => setShowWarning(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 460,
              padding: 18,
              background: "var(--bg, #0a0a0a)",
              border: "1px solid var(--warn, #ffb547)",
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text)",
              lineHeight: 1.55,
            }}
          >
            <h3
              style={{
                margin: 0,
                marginBottom: 10,
                fontSize: 13,
                letterSpacing: 1,
                color: "var(--warn, #ffb547)",
              }}
            >
              ⚠ Proxy Mode — read this first
            </h3>
            <p style={{ margin: "0 0 8px" }}>
              Proxy Mode routes mining traffic through a free public SOCKS5
              proxy operated by an unknown third party.
            </p>
            <ul style={{ margin: "0 0 8px 16px", padding: 0 }}>
              <li>The proxy operator can see your wallet address.</li>
              <li>
                On non-TLS pools they can MITM the stratum connection and
                redirect shares to their wallet.
              </li>
              <li>
                Many free proxies are short-lived; expect occasional
                disconnects.
              </li>
              <li>
                Some pools blocklist proxy IPs — your shares may not credit.
              </li>
              <li>
                <strong>Reliability:</strong> when the SOCKS5 proxy is flaky,
                the miner retries the pool connection on its own (it dials the
                pool through the proxy directly). If mining keeps dropping,
                the proxy is the likely cause — try a different one (pin a
                specific one below).
              </li>
            </ul>
            <p style={{ margin: "0 0 14px", color: "var(--text-dim)" }}>
              This mode is intended only for users behind aggressive firewalls
              with no other option. If your firewall allows TLS-on-443 to any
              public host, prefer a pool with a 443 endpoint instead.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={accept}
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  background: "var(--warn, #ffb547)",
                  color: "#0a0a0a",
                  border: "none",
                  padding: "6px 14px",
                  cursor: "pointer",
                }}
              >
                I understand, enable
              </button>
              <button
                type="button"
                onClick={() => setShowWarning(false)}
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  background: "transparent",
                  color: "var(--text)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  padding: "6px 14px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
