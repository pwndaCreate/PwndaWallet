import { useEffect, useState, type ReactNode } from "react";
import { DitherCanvas } from "../../components/DitherCanvas";

/**
 * Shared "splash" wrapper for the Home and Login screens: black background,
 * scan-line, dithered ASCII logo (full 180px resolution), the `PWNDA` Press
 * Start wordmark with RGB-split shadow, the tagline, and the chain ticker.
 *
 * Layout: this fills the `.app-auth` flex column (ViewRouter adds that class for
 * the splash views), so it sizes to the REAL available height — below the
 * titlebar AND the `.app` header/padding — instead of guessing
 * `calc(100vh - Npx)`, which previously overflowed `.app` and produced a
 * scrollbar (worse under Windows display scaling).
 *
 * When the window is wide (landscape) the brand and the form sit SIDE BY SIDE,
 * so the full-resolution logo fits a short (720px / scaled) window without a
 * scrollbar; when narrow (portrait) they stack vertically.
 */
export function AuthSplash({ children }: { children: ReactNode }) {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 760,
  );
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 760);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const brand = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: "relative",
          marginBottom: 12,
          width: 180,
          height: 180,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <DitherCanvas
          src="/pwnda-ascii-logo.png"
          width={180}
          height={180}
          cell={3}
          color="#f2f2f2"
          dimColor="rgba(242,242,242,0.5)"
          glitchRadius={38}
          blendMode="screen"
          opacity={0.85}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 3,
            mixBlendMode: "multiply",
            background:
              "repeating-linear-gradient(0deg, transparent 0 2px, rgba(0,0,0,.55) 2px 3px)",
          }}
        />
      </div>
      <div style={{ position: "relative", marginBottom: 10, lineHeight: 1 }}>
        <div
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 34,
            letterSpacing: 5,
            color: "#f2f2f2",
            textShadow:
              "2px 0 0 rgba(255,60,60,0.9), -2px 0 0 rgba(0,220,255,0.85), 0 0 10px rgba(242,242,242,0.35), 0 0 22px rgba(242,242,242,0.15)",
          }}
        >
          PWNDA
        </div>
      </div>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "#a0a0a0",
          letterSpacing: 1,
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        Decentralized Wallet Terminal
      </div>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 0.5,
        }}
      >
        XMR · ETH · BTC · SOL · ADA · 12 chains
      </div>
    </div>
  );

  return (
    <div
      style={{
        flex: "1 1 auto",
        minHeight: 0,
        overflow: "auto",
        display: "flex",
        flexDirection: wide ? "row" : "column",
        alignItems: "center",
        justifyContent: "center",
        gap: wide ? 56 : 16,
        padding: wide ? "20px 40px" : "20px 28px",
        background: "#000",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          height: 2,
          background: "rgba(242,242,242,0.05)",
          animation: "scan 6s linear infinite",
          pointerEvents: "none",
        }}
      />
      {brand}
      <div
        style={{
          width: wide ? 420 : "100%",
          maxWidth: 440,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}
