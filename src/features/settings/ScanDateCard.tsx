import { useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import {
  dateStringToMoneroHeight,
  dateStringToZephyrHeight,
} from "../../utils/heightFromDate";
import { rescanXmrFromHeight } from "../../wallets/xmr-wallet";
import { rescanZphFromHeight } from "../../wallets/zph-wallet";

type Phase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; height: number }
  | { kind: "error"; message: string };

/**
 * Change the block a privacy-chain wallet scans from, after import.
 *
 * ## Why this needs to exist
 *
 * Monero and Zephyr scan the chain from a "restore height" chosen at import,
 * usually from a date the user types in. Anything that arrived BEFORE that
 * block is never seen. The wallet then reports a zero balance, fully synced,
 * with no error — because from its point of view there genuinely is nothing
 * there.
 *
 * That's indistinguishable from an empty wallet, and picking a date too late
 * is easy: people reach for "when I made the wallet" rather than "before my
 * first deposit", or mistype a year. Until this card existed the only remedy
 * was to remove the wallet and re-import it with a different date, which is a
 * frightening thing to ask of someone who already thinks their funds are gone.
 *
 * Diagnosed 2026-08-13 from a live wallet: synced to the chain tip (height ==
 * tip), zero transfers, and an address the user confirmed was theirs.
 *
 * ## Why it's safe
 *
 * Rescanning deletes the local scan CACHE and rebuilds it. Every key is
 * re-derived from the seed, which is never touched. An earlier date costs
 * scanning time and nothing else — 0 is always correct, just slowest. That
 * asymmetry is why the guidance below says to go earlier than you think.
 */
export function ScanDateCard(props: {
  xmrSeed: string | null;
  zphSeed: string | null;
  sessionPassword: string | null;
  /** Persist the new height so the next unlock uses it too. */
  saveXmrSeedToVault: (seed: string, restoreHeight: number | null) => Promise<void>;
  saveZphSeedToVault: (seed: string, restoreHeight: number | null) => Promise<void>;
  /** Current heights from the vault, when known. */
  xmrRestoreHeight?: number | null;
  zphRestoreHeight?: number | null;
}) {
  const {
    xmrSeed,
    zphSeed,
    sessionPassword,
    saveXmrSeedToVault,
    saveZphSeedToVault,
    xmrRestoreHeight,
    zphRestoreHeight,
  } = props;

  if (!xmrSeed && !zphSeed) return null;

  return (
    <Card title="SCAN START DATE">
      <div
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          lineHeight: 1.6,
          marginBottom: 10,
        }}
      >
        Monero and Zephyr only scan the chain from the date you chose at import.
        Coins that arrived <em>before</em> that date won't appear, and the wallet
        will still say it's fully synced — there's no error to notice.
        <br />
        <span style={{ color: "var(--accent)" }}>
          Seeing a zero balance you don't expect? Set a date before your first
          deposit and rescan.
        </span>{" "}
        An earlier date only costs scanning time; your seed is never touched.
      </div>

      {xmrSeed && (
        <ChainScanRow
          label="Monero"
          ticker="XMR"
          currentHeight={xmrRestoreHeight ?? null}
          dateToHeight={dateStringToMoneroHeight}
          disabled={!sessionPassword}
          onRescan={async (height) => {
            await saveXmrSeedToVault(xmrSeed, height);
            await rescanXmrFromHeight(xmrSeed, sessionPassword!, height);
          }}
        />
      )}

      {zphSeed && (
        <ChainScanRow
          label="Zephyr"
          ticker="ZEPH"
          currentHeight={zphRestoreHeight ?? null}
          dateToHeight={dateStringToZephyrHeight}
          disabled={!sessionPassword}
          onRescan={async (height) => {
            await saveZphSeedToVault(zphSeed, height);
            await rescanZphFromHeight(zphSeed, sessionPassword!, height);
          }}
        />
      )}

      {!sessionPassword && (
        <div style={{ fontSize: 9.5, color: "var(--text-dim)", marginTop: 8 }}>
          Unlock the wallet to change a scan date — rescanning re-encrypts the
          wallet file with your vault password.
        </div>
      )}
    </Card>
  );
}

function ChainScanRow(props: {
  label: string;
  ticker: string;
  currentHeight: number | null;
  dateToHeight: (dateStr: string) => number;
  disabled: boolean;
  onRescan: (height: number) => Promise<void>;
}) {
  const { label, ticker, currentHeight, dateToHeight, disabled, onRescan } = props;
  const [date, setDate] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const preview = date ? dateToHeight(date) : null;
  // Going LATER skips blocks the wallet currently covers, which can hide funds
  // it can already see. Going earlier can only reveal more.
  const movingLater =
    preview != null && currentHeight != null && preview > currentHeight;

  const run = async () => {
    if (preview == null) return;
    const warning = movingLater
      ? `That date is LATER than the current scan start (block ${currentHeight}). ` +
        `Anything received between the two will stop showing. Continue?`
      : `Rescan ${label} from block ${preview}? This rebuilds the local scan ` +
        `cache and can take several minutes. Your seed is not affected.`;
    if (!window.confirm(warning)) return;
    setPhase({ kind: "working" });
    try {
      await onRescan(preview);
      setPhase({ kind: "done", height: preview });
    } catch (e: unknown) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div
      style={{
        marginTop: 10,
        padding: "8px 10px",
        border: "1px solid var(--border)",
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
        <span style={{ color: "var(--text)" }}>{label}</span>
        <span className="tnum" style={{ color: "var(--text-dim)" }}>
          {currentHeight != null ? `from block ${currentHeight}` : "from genesis"}
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
        <input
          type="date"
          value={date}
          disabled={disabled || phase.kind === "working"}
          onChange={(e) => setDate(e.target.value)}
          style={{
            flex: 1,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            padding: "5px 7px",
            background: "rgba(0,0,0,0.3)",
            border: "1px solid var(--border)",
            color: "var(--text)",
          }}
        />
        <button
          className="btn-icon"
          onClick={run}
          disabled={disabled || !date || phase.kind === "working"}
          style={{ fontSize: 9.5, whiteSpace: "nowrap" }}
        >
          {phase.kind === "working" ? "Rescanning…" : `► Rescan ${ticker}`}
        </button>
      </div>

      {preview != null && phase.kind !== "working" && (
        <div
          className="tnum"
          style={{
            fontSize: 9,
            marginTop: 5,
            color: movingLater ? "var(--danger)" : "var(--text-dim)",
          }}
        >
          {movingLater
            ? `⚠ block ${preview} is LATER than the current start — funds received before it would stop showing`
            : `→ block ${preview}`}
        </div>
      )}

      {phase.kind === "working" && (
        <div style={{ fontSize: 9, marginTop: 5, color: "var(--text-dim)" }}>
          Rebuilding the scan cache from the new date. This can take several
          minutes; leave the app open.
        </div>
      )}

      {phase.kind === "done" && (
        <div style={{ fontSize: 9, marginTop: 5, color: "var(--accent)" }}>
          ✓ Rescanning from block {phase.height}. The balance updates as it
          catches up.
        </div>
      )}

      {phase.kind === "error" && (
        <div style={{ fontSize: 9, marginTop: 5, color: "var(--danger)" }}>
          {phase.message}
        </div>
      )}
    </div>
  );
}
