import { useEffect, useMemo, useState } from "react";
import { Backdrop, Row, Stat, truncate } from "./modal-parts";
import { Btn } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import { getStore } from "../../store";
import type { EncryptedData } from "../../crypto";
import { unlockSwap } from "../../api/swap-rust";
import {
  appendSwapHistory,
  newSwapId,
  updateSwapHistoryEntry,
  type SwapHistoryEntry,
} from "./swap-history-store";
import {
  extractActualReceivedFromIntents,
  extractActualReceivedFromSwapKit,
} from "./swap-actual-received";
import { SWAP_COIN_META } from "./swap-data";
import {
  MockSwapAttemptedError,
  SafetyInvariantError,
  executeIntentsTrade,
  executeSwapKitTrade,
  intentsStatusToHistory,
  pollIntentsToTerminal,
  pollSwapKitToTerminal,
  trackToHistoryStatus,
  type SwapExecutionStatus,
} from "./swap-execute";
import type { NormalizedQuote } from "./useSwapQuote";
import { effectiveModeForSource } from "./router-modes";
import { decimalToBaseUnitsBigInt } from "./swap-sources";
import type { IntentsBlockchain } from "./near-intents-assets.generated";
import { getSwapCoinMeta } from "./swap-data";

/**
 * Confirm modal for a SwapKit-routable swap. Renders the locked-in quote,
 * the source/destination addresses, fees, and ETA. The user enters their
 * vault password to authorize signing — the password is sent to the Rust
 * core via `swap_unlock`, which decrypts the vault and returns a
 * short-lived session token. For every chain except ADA the mnemonic
 * stays in the Rust core. ADA is the exception: it has no Rust signer, so
 * its deposit tx is signed in TS via `cardano-tx.ts` using the mnemonic
 * the parent threads in as `sourceMnemonic` (the same value already held
 * in `walletsByChain.cardano` for ADA Send).
 *
 * Lifecycle:
 *   review (default)
 *     ↓ user clicks "Sign & Send"
 *   password
 *     ↓ user types vault password + confirms
 *   building → signing → broadcasting → pending
 *     ↓ status polling reaches a terminal state
 *   done | error
 *
 * Status polling continues in the background after the modal closes — the
 * History tab is the source of truth once `done`.
 */
export function SwapConfirmModal({
  open,
  fromAsset,
  toAsset,
  fromAmount,
  fromBlockchain,
  quote,
  sourceAddress,
  sourceMnemonic,
  destinationAddress,
  onClose,
}: {
  open: boolean;
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
  /**
   * Source-side blockchain choice when the user picked a multi-chain
   * symbol (USDC on Base vs USDC on Arbitrum, ETH on Optimism vs ETH L1).
   * Plumbed through to executeIntentsTrade so it picks the right RPC list
   * + EVM chain id. Omit for single-chain symbols (BTC, NEAR).
   */
  fromBlockchain?: IntentsBlockchain;
  quote: NormalizedQuote;
  sourceAddress: string;
  /**
   * The vault's BIP-39 mnemonic — passed ONLY when `fromAsset` is ADA.
   * Cardano is the one source signed in TS (see `executeIntentsTrade`),
   * so the modal forwards this as `cardanoMnemonic`. The parent reads it
   * from `walletsByChain.cardano.mnemonic` (the same place ADA Send does);
   * it's `undefined` for every other source.
   */
  sourceMnemonic?: string;
  destinationAddress: string;
  onClose: () => void;
}) {
  type Stage =
    | "review"
    | "password"
    | "executing"
    | "done"
    | "mockStop"
    | "error";
  const [stage, setStage] = useState<Stage>("review");
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [exec, setExec] = useState<SwapExecutionStatus>({ phase: "idle" });
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [mockStop, setMockStop] = useState<MockSwapAttemptedError | null>(null);
  const [safetyError, setSafetyError] = useState<SafetyInvariantError | null>(null);

  // Reset state every time the modal opens (a stale "done" should not
  // persist between distinct swaps).
  useEffect(() => {
    if (!open) return;
    setStage("review");
    setPassword("");
    setPwError(null);
    setExec({ phase: "idle" });
    setHistoryId(null);
    setMockStop(null);
    setSafetyError(null);
  }, [open]);

  // Resolve effective metadata for each side. When the user picked a
  // multi-chain symbol via the NetworkPill, `fromBlockchain` carries
  // the chain-specific routing info (asset id, RPC list, evm chain id);
  // otherwise the static SWAP_COIN_META entry is the canonical answer.
  const fromMeta =
    getSwapCoinMeta(fromAsset, fromBlockchain) ??
    SWAP_COIN_META[fromAsset.toUpperCase()];
  const toMeta = SWAP_COIN_META[toAsset.toUpperCase()];
  const sourceExplorer = useMemo(
    () => (exec.sourceTxHash && fromMeta ? fromMeta.explorerTxUrl(exec.sourceTxHash) : null),
    [exec.sourceTxHash, fromMeta]
  );
  const destExplorer = useMemo(
    () => (exec.destTxHash && toMeta ? toMeta.explorerTxUrl(exec.destTxHash) : null),
    [exec.destTxHash, toMeta]
  );

  // Effective routing mode for this quote — drives the ROUTING row + the
  // dynamic button text. Live + non-mock-detected → green. Anything else
  // → yellow + the explicit "won't broadcast to real chain" copy.
  const modeInfo = useMemo(
    () => effectiveModeForSource(quote.source, quote.swapKitRoute),
    [quote.source, quote.swapKitRoute]
  );
  const isMockMode = !modeInfo.isLive;

  // Surface a one-shot console warning for misconfigured environments
  // (mock UUID came back even though VITE_SWAPKIT_LIVE=true). The user
  // also gets the visual signal — log is for their grep / their build CI.
  useEffect(() => {
    if (modeInfo.mockDetected) {
      console.warn(
        "[swap] SwapKit response carries the mock-server UUID — UI is forced to mock mode regardless of VITE_SWAPKIT_LIVE."
      );
    }
  }, [modeInfo.mockDetected]);

  if (!open) return null;

  const submitPassword = async () => {
    if (!password) {
      setPwError("Enter your vault password.");
      return;
    }
    setPwError(null);
    setStage("executing");
    setExec({ phase: "building" });

    try {
      // Pull the encrypted vault directly from the store so we don't have
      // to thread it through props. Same key the rest of the app uses.
      const store = await getStore();
      const encrypted = await store.get<EncryptedData>("wallet");
      if (!encrypted) {
        throw new Error("No saved vault found — create or import a wallet first.");
      }
      const session = await unlockSwap(encrypted, password);

      const id = newSwapId();
      setHistoryId(id);

      // Same blockchain-aware resolution as the render-time lookup —
      // ensures the post-broadcast history entry uses the right
      // explorer URL when the user picked a non-default chain.
      const fromMetaLocal =
        getSwapCoinMeta(fromAsset, fromBlockchain) ??
        SWAP_COIN_META[fromAsset.toUpperCase()];
      const toMetaLocal = SWAP_COIN_META[toAsset.toUpperCase()];

      if (quote.source === "swapkit") {
        if (!quote.swapKitRoute) {
          throw new Error("SwapKit quote missing route data");
        }
        let result: { sourceTxHash: string };
        try {
          result = await executeSwapKitTrade({
            sessionId: session.sessionId,
            fromAsset,
            route: quote.swapKitRoute,
            sourceAddress,
            destinationAddress,
            onPhase: (s) => setExec(s),
          });
        } catch (e) {
          if (e instanceof MockSwapAttemptedError) {
            // Hard-stop fired between sign and broadcast. Sign step
            // succeeded — surface the signed payload + destination so
            // the user can verify the signing path is sound, and
            // cleanly stop without persisting a failed history entry.
            setMockStop(e);
            setExec({ phase: "idle" });
            setStage("mockStop");
            return;
          }
          throw e;
        }

        // Persist a `pending` entry as soon as we have a source tx hash.
        const entry: SwapHistoryEntry = {
          id,
          fromAsset,
          toAsset,
          fromAmount,
          toAmount: quote.expectedReceive,
          status: "pending",
          sourceTxHash: result.sourceTxHash,
          sourceExplorerUrl: fromMetaLocal?.explorerTxUrl(result.sourceTxHash) ?? "",
          provider: `${quote.routerLabel} · ${quote.providerName}`,
          createdAt: new Date().toISOString(),
        };
        await appendSwapHistory(entry);

        // Background poll — SwapKit /track. Modal stays open showing live
        // status. If the user closes the modal we still keep polling so
        // the history entry converges to its terminal state.
        const chainId = fromMetaLocal?.evmChainId
          ? String(fromMetaLocal.evmChainId)
          : undefined;
        void pollSwapKitToTerminal({
          hash: result.sourceTxHash,
          chainId,
          onUpdate: (resp) => {
            setExec((prev) => ({
              ...prev,
              trackStatus: resp.status,
              rawTrack: resp,
              destTxHash:
                prev.destTxHash ??
                extractDestTxHash(resp) ??
                undefined,
            }));
          },
        })
          .then(async (terminal) => {
            const histStatus = trackToHistoryStatus(terminal.status);
            const dest = extractDestTxHash(terminal);
            const destUrl =
              dest && toMetaLocal ? toMetaLocal.explorerTxUrl(dest) : undefined;
            // Drift capture (2026-05-26, #22). SwapKit's /track response
            // shape varies by provider — `extractActualReceivedFromSwapKit`
            // hunts the common locations and returns undefined when none
            // are present. The History UI tolerates undefined by hiding
            // the drift chip; this isn't a SwapKit-blocker.
            const actualReceived =
              histStatus === "success"
                ? extractActualReceivedFromSwapKit(terminal)
                : undefined;
            await updateSwapHistoryEntry(id, {
              status: histStatus,
              destTxHash: dest ?? undefined,
              destExplorerUrl: destUrl,
              completedAt: new Date().toISOString(),
              ...(actualReceived
                ? { actualReceived, actualReceivedAt: new Date().toISOString() }
                : {}),
            });
            setExec((prev) => ({
              ...prev,
              phase: "done",
              destTxHash: dest ?? prev.destTxHash,
              trackStatus: terminal.status,
              rawTrack: terminal,
            }));
            setStage("done");
          })
          .catch(async (e) => {
            await updateSwapHistoryEntry(id, { status: "pending" });
            setExec((prev) => ({
              ...prev,
              phase: "error",
              error: String((e as Error)?.message ?? e),
            }));
          });
      } else {
        // NEAR Intents path — execute the source-chain deposit then poll
        // the 1Click status endpoint.
        if (!quote.intentsQuote) {
          throw new Error("NEAR Intents quote missing data");
        }
        // Compute the user-intended atomic amount up-front so the
        // safety-invariant layer can sanity-check `quote.amountIn`
        // against it. Same conversion as `useSwapQuote` performs when
        // building the request body — the two MUST agree by construction.
        if (!fromMeta) {
          throw new Error(`Unknown source asset ${fromAsset}`);
        }
        const userIntendedAtomic = decimalToBaseUnitsBigInt(
          fromAmount,
          fromMeta.decimals
        );
        const result = await executeIntentsTrade({
          sessionId: session.sessionId,
          fromAsset,
          intentsQuote: quote.intentsQuote,
          sourceAddress,
          userIntendedAtomic,
          fromBlockchain,
          // Only ADA uses this — TS-signed source (no Rust signer). It's
          // `undefined` for every other chain, which signs via sessionId.
          cardanoMnemonic: sourceMnemonic,
          onPhase: (s) => setExec(s),
        });

        const entry: SwapHistoryEntry = {
          id,
          fromAsset,
          toAsset,
          fromAmount,
          toAmount: quote.expectedReceive,
          status: "pending",
          sourceTxHash: result.sourceTxHash,
          sourceExplorerUrl: fromMetaLocal?.explorerTxUrl(result.sourceTxHash) ?? "",
          provider: `${quote.routerLabel} · ${quote.providerName}`,
          createdAt: new Date().toISOString(),
        };
        await appendSwapHistory(entry);

        void pollIntentsToTerminal({
          depositAddress: result.depositAddress,
          onUpdate: (resp) => {
            setExec((prev) => ({
              ...prev,
              // Reuse `trackStatus` for the status badge — the modal's
              // ExecutingFooter renders it as-is.
              trackStatus: (typeof resp.status === "string"
                ? resp.status.toLowerCase()
                : undefined) as SwapExecutionStatus["trackStatus"],
              rawTrack: undefined,
            }));
          },
        })
          .then(async (terminal) => {
            const histStatus = intentsStatusToHistory(
              typeof terminal.status === "string" ? terminal.status : undefined
            );
            // Drift capture (2026-05-26, #22). NEAR Intents reliably
            // exposes the executed amount in `swap.amountOut` at SUCCESS
            // time — that's the actual delivered atomic amount the user
            // received. Only persist when terminal is success so we don't
            // store a partial / refunded amount as the "actual".
            const actualReceived =
              histStatus === "success"
                ? extractActualReceivedFromIntents(terminal)
                : undefined;
            await updateSwapHistoryEntry(id, {
              status: histStatus,
              completedAt: new Date().toISOString(),
              ...(actualReceived
                ? { actualReceived, actualReceivedAt: new Date().toISOString() }
                : {}),
            });
            setExec((prev) => ({
              ...prev,
              phase: "done",
              trackStatus: (typeof terminal.status === "string"
                ? terminal.status.toLowerCase()
                : undefined) as SwapExecutionStatus["trackStatus"],
            }));
            setStage("done");
          })
          .catch(async () => {
            await updateSwapHistoryEntry(id, { status: "pending" });
            setExec((prev) => ({ ...prev, phase: "error", error: "Status poll failed" }));
          });
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // SafetyInvariantError is a wallet-self-detected bug — surface a
      // dedicated red banner with copy-friendly details. NO retry button:
      // the user must close + re-quote (the bug class is in the wallet,
      // not the network, so retrying just re-fires the same invariant).
      if (e instanceof SafetyInvariantError) {
        setSafetyError(e);
        setExec({ phase: "idle" });
        setStage("error");
        if (historyId) {
          await updateSwapHistoryEntry(historyId, { status: "failed" });
        }
        return;
      }
      // The Rust keystore returns "decryption failed (wrong password or
      // corrupted vault)" on bad password; that's the only case where we
      // can recover by going back to the password stage.
      if (/decryption failed|wrong password/i.test(msg)) {
        setPwError("Incorrect password.");
        setStage("password");
        setExec({ phase: "idle" });
      } else {
        setExec({ phase: "error", error: msg });
        setStage("error");
        if (historyId) {
          await updateSwapHistoryEntry(historyId, { status: "failed" });
        }
      }
    }
  };

  return (
    <Backdrop onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "90vh",
          overflow: "auto",
          background: "var(--bg-2)",
          border: "1px solid var(--border-hi)",
          padding: 22,
          fontFamily: "var(--font-mono)",
          color: "var(--text)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: "var(--accent)",
            }}
          >
            confirm swap
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>

        {/* From → To with amounts + provider tag */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            marginBottom: 10,
          }}
        >
          <CoinIcon sym={fromAsset} size={26} glow={false} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: 1, textTransform: "uppercase" }}>you send</div>
            <div className="tnum" style={{ fontSize: 16, marginTop: 2 }}>
              {fromAmount} <span style={{ color: "var(--text-dim)" }}>{fromAsset}</span>
            </div>
          </div>
          <span style={{ color: "var(--text-dim)", fontSize: 14 }}>→</span>
          <CoinIcon sym={toAsset} size={26} glow={false} />
          <div style={{ flex: 1, minWidth: 0, textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: 1, textTransform: "uppercase" }}>you receive</div>
            <div className="tnum" style={{ fontSize: 16, marginTop: 2, color: "var(--accent)" }}>
              ~{quote.expectedReceive} <span style={{ color: "var(--text-dim)" }}>{toAsset}</span>
            </div>
          </div>
        </div>

        {/* Addresses */}
        <Row label="From" value={truncate(sourceAddress)} fullValue={sourceAddress} />
        <Row label="To" value={truncate(destinationAddress)} fullValue={destinationAddress} />

        {/* Fees + ETA */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            padding: 12,
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 5,
            fontSize: 11,
          }}
        >
          <RoutingRow modeInfo={modeInfo} quote={quote} />
          <Stat k="min received" v={`${quote.minReceived} ${toAsset}`} />
          <Stat k="network fees" v={`${quote.totalFeesSource} ${fromAsset}`} />
          {/* Pwnda fee — proxy-injected SwapKit affiliate fee, already
              deducted from `expectedReceive` by SwapKit before the route
              reaches us. Surface it explicitly: hiding it would mean the
              user sees a smaller output than the un-affiliated quote and
              wonders why. NEAR Intents rolls all costs into amountOut so
              affiliateFeeSource is "0" there — row collapses to a "—". */}
          <Stat
            k="Pwnda fee"
            v={formatPwndaFee(quote.affiliateFeeSource, fromAmount, fromAsset)}
          />
          <Stat
            k="provider"
            v={`${quote.routerLabel} · ${quote.providerName}`}
          />
          <Stat k="est. time" v={quote.etaPretty} />
          {quote.warnings.length > 0 && (
            <div
              style={{
                marginTop: 6,
                padding: "8px 10px",
                background: "rgba(255,170,0,0.08)",
                border: "1px solid rgba(255,170,0,0.4)",
                color: "var(--warn)",
                fontSize: 10,
                lineHeight: 1.5,
              }}
            >
              {quote.warnings.map((w, i) => (
                <div key={i}>! {w}</div>
              ))}
            </div>
          )}
        </div>

        {/* Stage-specific footer */}
        <div style={{ marginTop: 16 }}>
          {stage === "review" && (
            <ReviewFooter
              onCancel={onClose}
              onSign={() => setStage("password")}
              isMockMode={isMockMode}
            />
          )}
          {stage === "password" && (
            <PasswordFooter
              password={password}
              setPassword={setPassword}
              error={pwError}
              isMockMode={isMockMode}
              onCancel={() => {
                setStage("review");
                setPassword("");
                setPwError(null);
              }}
              onSubmit={submitPassword}
            />
          )}
          {stage === "executing" && (
            <ExecutingFooter exec={exec} sourceExplorer={sourceExplorer} />
          )}
          {stage === "done" && (
            <DoneFooter
              exec={exec}
              sourceExplorer={sourceExplorer}
              destExplorer={destExplorer}
              onClose={onClose}
            />
          )}
          {stage === "mockStop" && mockStop && (
            <MockStopFooter mockStop={mockStop} onClose={onClose} />
          )}
          {stage === "error" && safetyError && (
            <SafetyInvariantFooter error={safetyError} onClose={onClose} />
          )}
          {stage === "error" && !safetyError && (
            <ErrorFooter
              error={exec.error ?? "Unknown error"}
              onClose={onClose}
              onRetry={() => {
                // Clear error state and re-enter the password stage so
                // the user can retry without re-typing addresses or
                // re-quoting. submitPassword will re-derive nonce/gas
                // and re-broadcast — fees may have moved, but the
                // route is still valid.
                setExec({ phase: "idle" });
                setHistoryId(null);
                setStage("password");
              }}
            />
          )}
        </div>
      </div>
    </Backdrop>
  );
}

/* ─── helpers ───────────────────────────────────────────────── */

function RoutingRow({
  modeInfo,
  quote,
}: {
  modeInfo: ReturnType<typeof effectiveModeForSource>;
  quote: NormalizedQuote;
}) {
  const isLive = modeInfo.isLive;
  const dot = isLive ? "🟢" : "🟡";
  const tone = isLive ? "var(--accent)" : "var(--warn)";
  const trail = isLive ? "live" : "mock";
  const mockNote = modeInfo.mockDetected ? " · mock UUID detected" : "";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        padding: "4px 0",
        borderBottom: "1px solid var(--border-soft)",
        paddingBottom: 8,
        marginBottom: 4,
      }}
    >
      <span
        style={{
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
          fontSize: 9,
        }}
      >
        routing
      </span>
      <span
        style={{
          color: tone,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          textAlign: "right",
        }}
      >
        {quote.routerLabel} · {trail} {dot}
        {mockNote && (
          <span
            style={{
              display: "block",
              fontSize: 9,
              color: "var(--text-dim)",
              marginTop: 2,
            }}
          >
            {mockNote.replace(" · ", "")}
          </span>
        )}
        {!isLive && (
          <span
            style={{
              display: "block",
              fontSize: 9,
              color: "var(--text-dim)",
              marginTop: 2,
            }}
          >
            (no real swap will execute)
          </span>
        )}
      </span>
    </div>
  );
}

function ReviewFooter({
  onCancel,
  onSign,
  isMockMode,
}: {
  onCancel: () => void;
  onSign: () => void;
  isMockMode: boolean;
}) {
  // Mock mode flips the button copy so the user can't accidentally
  // forget which upstream they're signing against. The button still
  // does the same thing — the text is the protection.
  const label = isMockMode
    ? "Sign & Send (mock — won't broadcast to real chain)"
    : "Sign & Send";
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <Btn variant="ghost" full onClick={onCancel}>Cancel</Btn>
      <Btn
        variant={isMockMode ? "ghost" : "accent"}
        full
        caret={false}
        onClick={onSign}
      >
        {label}
      </Btn>
    </div>
  );
}

function PasswordFooter({
  password,
  setPassword,
  error,
  isMockMode,
  onCancel,
  onSubmit,
}: {
  password: string;
  setPassword: (v: string) => void;
  error: string | null;
  isMockMode: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        Vault password
      </div>
      <input
        className="field"
        type="password"
        value={password}
        autoFocus
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        placeholder="enter vault password"
        style={{ fontSize: 13, padding: "10px 12px" }}
      />
      {error && (
        <div style={{ color: "var(--danger)", fontSize: 10 }}>{error}</div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" full onClick={onCancel}>Back</Btn>
        <Btn
          variant={isMockMode ? "ghost" : "accent"}
          full
          caret={false}
          onClick={onSubmit}
        >
          {isMockMode
            ? "Unlock & Sign (mock — won't broadcast)"
            : "Unlock & Sign"}
        </Btn>
      </div>
    </div>
  );
}

function ExecutingFooter({
  exec,
  sourceExplorer,
}: {
  exec: SwapExecutionStatus;
  sourceExplorer: string | null;
}) {
  const steps: Array<{ key: SwapExecutionStatus["phase"]; label: string }> = [
    { key: "building", label: "Building transaction" },
    { key: "signing", label: "Signing in Rust core" },
    { key: "broadcasting", label: "Broadcasting to chain" },
    { key: "pending", label: "Waiting for swap to finalize" },
  ];
  const currentIdx = steps.findIndex((s) => s.key === exec.phase);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        Status
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {steps.map((s, i) => {
          const done = currentIdx > i || exec.phase === "done";
          const active = currentIdx === i && exec.phase !== "done";
          return (
            <div
              key={s.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                color: active
                  ? "var(--accent)"
                  : done
                    ? "var(--text)"
                    : "var(--text-dim)",
              }}
            >
              <span style={{ width: 12 }}>
                {done ? "●" : active ? "◌" : "○"}
              </span>
              <span>{s.label}</span>
              {active && (
                <span
                  style={{
                    color: "var(--accent)",
                    fontSize: 9,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    marginLeft: "auto",
                  }}
                >
                  …
                </span>
              )}
            </div>
          );
        })}
      </div>
      {exec.sourceTxHash && (
        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
          source tx:{" "}
          {sourceExplorer ? (
            <a
              href={sourceExplorer}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              {truncate(exec.sourceTxHash)}
            </a>
          ) : (
            <span className="tnum">{truncate(exec.sourceTxHash)}</span>
          )}
        </div>
      )}
      {exec.trackStatus && (
        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
          tracker:{" "}
          <span style={{ color: "var(--text)" }}>{exec.trackStatus}</span>
        </div>
      )}
    </div>
  );
}

function DoneFooter({
  exec,
  sourceExplorer,
  destExplorer,
  onClose,
}: {
  exec: SwapExecutionStatus;
  sourceExplorer: string | null;
  destExplorer: string | null;
  onClose: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          fontSize: 12,
          color:
            exec.trackStatus === "completed"
              ? "var(--accent)"
              : exec.trackStatus === "refunded"
                ? "var(--warn)"
                : exec.trackStatus === "failed"
                  ? "var(--danger)"
                  : "var(--text)",
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        {exec.trackStatus ?? "done"}
      </div>
      {sourceExplorer && (
        <a href={sourceExplorer} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontSize: 11 }}>
          View source tx ↗
        </a>
      )}
      {destExplorer && (
        <a href={destExplorer} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontSize: 11 }}>
          View destination tx ↗
        </a>
      )}
      <Btn variant="ghost" full onClick={onClose}>Close</Btn>
    </div>
  );
}

function ErrorFooter({
  error,
  onClose,
  onRetry,
}: {
  error: string;
  onClose: () => void;
  onRetry?: () => void;
}) {
  // Lift the broadcast/verification audit trail to its own block so
  // it's readable. The Rust `swap_evm_broadcast_verified` command
  // returns a multi-line message: a headline, followed by indented
  // per-URL `<url> (<stage>): <reason>` lines.
  const lines = error.split(/\r?\n/);
  const headline = lines[0] ?? error;
  const trail = lines
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // Recognise a few common headline patterns and prepend an actionable
  // sentence — the Rust audit trail is informative but not always
  // immediately actionable.
  const isBroadcastFail = /broadcast|All \d+ EVM RPCs failed/i.test(headline);
  const isRateLimit = /\b429\b|Too Many Requests|RATE_LIMIT/i.test(error);
  const guidance = isRateLimit
    ? "Broadcast failed: rate-limited by every RPC in the fallback list. Wait ~30 s and retry."
    : isBroadcastFail
      ? "Broadcast failed. Retry — the wallet will try every RPC in the fallback list again, or set VITE_ETH_RPC_URL in .env.local to a paid endpoint."
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          padding: "10px 12px",
          background: "rgba(255,59,59,0.08)",
          border: "1px solid rgba(255,59,59,0.4)",
          color: "var(--danger)",
          fontSize: 11,
          lineHeight: 1.4,
        }}
      >
        {guidance && (
          <div style={{ fontWeight: 500, marginBottom: 6 }}>{guidance}</div>
        )}
        <div>{headline}</div>
        {trail.length > 0 && (
          <details
            style={{ marginTop: 8, fontSize: 10, color: "var(--text-dim)" }}
          >
            <summary style={{ cursor: "pointer" }}>
              Per-URL audit trail ({trail.length})
            </summary>
            <div style={{ marginTop: 6, fontFamily: "var(--font-mono)" }}>
              {trail.map((l, i) => (
                <div key={i} style={{ wordBreak: "break-all", marginBottom: 2 }}>
                  {l}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" full caret={false} onClick={onClose}>
          Close
        </Btn>
        {onRetry && (
          <Btn variant="accent" full caret={false} onClick={onRetry}>
            Retry
          </Btn>
        )}
      </div>
    </div>
  );
}

/**
 * Safety-invariant violation view. Shown when the build / sign / broadcast
 * pipeline self-detected a bug and refused to proceed. Distinct from
 * `ErrorFooter` in three ways:
 *   1. Strong red "safety check failed" framing — this is wallet code
 *      catching its own bug, not a transient network issue.
 *   2. NO retry button. Retrying re-enters the same code path that fired
 *      the invariant. The user must close + re-quote.
 *   3. Copy Details button puts a structured incident record on the
 *      clipboard so the user can paste into a bug report.
 */
function SafetyInvariantFooter({
  error,
  onClose,
}: {
  error: SafetyInvariantError;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(error.toCopyText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          padding: "12px 14px",
          background: "rgba(255,59,59,0.10)",
          border: "1.5px solid rgba(255,59,59,0.55)",
          color: "var(--danger)",
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 12 }}>
          ⚠ Safety check failed before broadcasting
        </div>
        <div style={{ marginBottom: 6 }}>
          The wallet detected an inconsistency in the transaction it built.
          <strong> No funds have moved.</strong> Please screenshot this and
          report it.
        </div>
        <div
          style={{
            marginTop: 8,
            padding: "8px 10px",
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,59,59,0.3)",
            color: "var(--text)",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {error.message}
        </div>
        <details style={{ marginTop: 8, fontSize: 10, color: "var(--text-dim)" }}>
          <summary style={{ cursor: "pointer" }}>
            Diagnostic context ({Object.keys(error.context).length} fields)
          </summary>
          <div style={{ marginTop: 6, fontFamily: "var(--font-mono)" }}>
            {Object.entries(error.context).map(([k, v]) => (
              <div key={k} style={{ wordBreak: "break-all", marginBottom: 2 }}>
                <span style={{ color: "var(--text-dim)" }}>{k}:</span> {v}
              </div>
            ))}
            <div style={{ marginTop: 4, color: "var(--text-dim)" }}>
              invariant: {error.invariant}
            </div>
          </div>
        </details>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" full caret={false} onClick={onClose}>
          Close
        </Btn>
        <Btn variant="accent" full caret={false} onClick={handleCopy}>
          {copied ? "Copied ✓" : "Copy Details"}
        </Btn>
      </div>
    </div>
  );
}

/**
 * Mock-mode stop view. Shown when `executeSwapKitTrade` threw the typed
 * [`MockSwapAttemptedError`] guard. The sign step succeeded — only the
 * broadcast was blocked. Tone is informational (yellow/text), not
 * red/danger.
 */
function MockStopFooter({
  mockStop,
  onClose,
}: {
  mockStop: MockSwapAttemptedError;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const reasonLabel =
    mockStop.reason === "MOCK_UUID_DETECTED"
      ? "mock SwapKit UUID detected"
      : "VITE_SWAPKIT_LIVE=false";

  const onCopy = () => {
    void navigator.clipboard.writeText(mockStop.signedTxHex).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Headline — info tone, not red. */}
      <div
        style={{
          padding: "10px 12px",
          background: "rgba(255,170,0,0.08)",
          border: "1px solid rgba(255,170,0,0.4)",
          color: "var(--warn)",
          fontSize: 11,
          lineHeight: 1.5,
          fontFamily: "var(--font-mono)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ fontSize: 14 }}>✓</span>
          <span>Sign step OK — broadcast skipped (mock mode)</span>
        </div>
        <div
          style={{
            color: "var(--text-dim)",
            marginTop: 4,
            fontSize: 10,
          }}
        >
          Reason: {reasonLabel}. The transaction would have been valid if
          upstream were live.
        </div>
      </div>

      {/* Destination address — warning badge so the user can audit
          where the tx WOULD have been sent. */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          padding: "8px 12px",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{
              color: "var(--text-dim)",
              letterSpacing: 1,
              textTransform: "uppercase",
              fontSize: 9,
            }}
          >
            mock destination
          </span>
          <span
            style={{
              fontSize: 8,
              color: "var(--warn)",
              border: "1px solid rgba(255,170,0,0.5)",
              padding: "1px 5px",
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            ⚠ would NOT be sent
          </span>
        </div>
        <code
          style={{
            color: "var(--text)",
            wordBreak: "break-all",
            fontFamily: "var(--font-mono)",
          }}
        >
          {mockStop.destinationAddress || "(not surfaced by mock)"}
        </code>
      </div>

      {/* Signed-tx hex — copyable so the user can decode & verify the
          sign path produced a structurally sound payload. */}
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 4,
            fontSize: 9,
            color: "var(--text-dim)",
            letterSpacing: 1,
            textTransform: "uppercase",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span>signed tx ({mockStop.chainKind})</span>
          <button
            className="qbtn"
            onClick={onCopy}
            style={{
              fontSize: 9,
              padding: "3px 8px",
              color: copied ? "var(--accent)" : "var(--text)",
            }}
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <textarea
          readOnly
          value={mockStop.signedTxHex}
          rows={5}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            width: "100%",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            padding: "8px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            resize: "vertical",
            lineHeight: 1.4,
            wordBreak: "break-all",
            boxSizing: "border-box",
          }}
        />
      </div>

      <Btn variant="ghost" full onClick={onClose}>
        Close
      </Btn>
    </div>
  );
}

/**
 * Format the "Pwnda fee" row for the confirm modal.
 *
 * Inputs:
 *   - `affiliateSource`: the route's affiliate fee in source-asset units,
 *     as returned by SwapKit (`route.fees.affiliate`). "0" for NEAR
 *     Intents (which rolls all costs into amountOut).
 *   - `sellAmount`: the user-typed YOU SEND amount, in source-asset
 *     units, as a decimal string.
 *   - `asset`: the source asset ticker (for display).
 *
 * Output: a single-line string. Three branches:
 *   - zero affiliate fee → "—" (collapses the row visually)
 *   - non-zero + valid sellAmount → "<amount> <ASSET> · <pct>%"
 *   - non-zero but sellAmount is malformed → "<amount> <ASSET>" (% omitted
 *     rather than rendering "NaN%" — defensive)
 *
 * Exported (instead of file-local) so unit tests pin the format string
 * shape without rendering React.
 */
export function formatPwndaFee(
  affiliateSource: string,
  sellAmount: string,
  asset: string
): string {
  const fee = Number(affiliateSource);
  if (!Number.isFinite(fee) || fee <= 0) return "—";
  const sold = Number(sellAmount);
  const feeFmt = `${affiliateSource} ${asset}`;
  if (!Number.isFinite(sold) || sold <= 0) return feeFmt;
  const pct = (fee / sold) * 100;
  // 2 decimal places when ≥ 0.01%, 4 when smaller. Trim trailing zeros.
  const pctStr =
    pct >= 0.01
      ? pct.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
      : pct.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `${feeFmt} · ${pctStr}%`;
}

/** Pull a destination-chain tx hash out of a `/track` response without
 *  hard-coding the SwapKit response shape too tightly. The live response
 *  varies between providers — we look for the first `legs[*].txHash` that
 *  isn't the source hash. */
function extractDestTxHash(resp: { legs?: unknown[]; [k: string]: unknown }): string | null {
  const legs = Array.isArray(resp.legs) ? (resp.legs as Array<Record<string, unknown>>) : [];
  for (const leg of legs.slice().reverse()) {
    const h = (leg.txHash ?? leg.hash ?? leg.outboundTxHash) as unknown;
    if (typeof h === "string" && h.length > 4) return h;
  }
  // Some providers expose a top-level finalTxHash.
  const top = (resp as Record<string, unknown>).finalTxHash;
  if (typeof top === "string" && top.length > 4) return top;
  return null;
}
