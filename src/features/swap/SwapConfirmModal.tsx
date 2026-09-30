import { useEffect, useMemo, useRef, useState } from "react";
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
import { xrpPayoutBlockReason } from "./xrpPayoutGuard";
import { xrpAccountActivation } from "../../wallets/xrp-wallet";
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
import type { SourceSecret } from "./asset-capabilities";
import type { NormalizedQuote } from "./useSwapQuote";
import { effectiveModeForSource } from "./router-modes";
import { accountSendAvailable, decimalToBaseUnitsBigInt } from "./swap-sources";
import type { IntentsBlockchain } from "./near-intents-assets.generated";
import { getSwapCoinMeta } from "./swap-data";
import { defaultBlockchainFor } from "./intents-dedup";
import {
  IntentsQuoteAlreadyUsedError,
  intentsDepositAttempt,
  recordIntentsDeposit,
} from "./intents-attempts";
import {
  assertDepositWindowOpen,
  assertQuoteBinding,
  depositWindowMinutesLeft,
} from "./intents-quote-binding";
import { isSendOutcomeUnknown } from "../../wallets/send-outcome";
import { withTimeout } from "./broadcast-outcome";

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
 *   review (default)                — or `used`, if this quote already went out
 *     ↓ user clicks "Sign & Send"
 *   password
 *     ↓ user types vault password + confirms
 *   building → signing → broadcasting → pending   (cannot be closed until pending)
 *     ↓ status polling reaches a terminal state
 *   done | error | unknown
 *
 * Status polling continues in the background after the modal closes — the
 * History tab is the source of truth once `done`.
 *
 * 2026-09-29 send-safety audit (F2, F3, F4, F9, F10): the modal signs the
 * quote it was OPENED on, re-checks that quote against the swap on screen
 * and its deposit deadline when the password is submitted (before the vault
 * is unlocked or anything is signed), cannot be closed
 * mid-signature, writes the history row the moment a hash exists, shows an
 * ambiguous broadcast as "unknown — check the explorer" with the hash, and
 * never offers Retry on a NEAR Intents quote: a new attempt is a new quote.
 */
export function SwapConfirmModal({
  open,
  fromAsset,
  toAsset,
  fromAmount,
  fromBlockchain,
  quote,
  sourceAddress,
  sourceSecret,
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
   * The signing secret for a TS-signed source chain (ADA, the UTXO chains'
   * account-wide send, XRP, Tron), or `undefined` for the Rust-signed
   * majority, which sign inside the swap session. The modal forwards it
   * verbatim and never inspects its value; both swap surfaces build it with
   * the same `sourceSecretFor` helper so the "which chain needs which kind of
   * secret" decision lives in one place.
   */
  sourceSecret?: SourceSecret;
  destinationAddress: string;
  onClose: () => void;
}) {
  type Stage =
    | "review"
    | "password"
    | "executing"
    | "done"
    | "mockStop"
    | "error"
    // 2026-09-29 send-safety audit, F2: the deposit may have gone out and
    // its outcome is unknown — "check the explorer", never Retry.
    | "unknown"
    // F2: this quote's deposit address was already used.
    | "used";
  const [stage, setStage] = useState<Stage>("review");
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [exec, setExec] = useState<SwapExecutionStatus>({ phase: "idle" });
  const [mockStop, setMockStop] = useState<MockSwapAttemptedError | null>(null);
  const [safetyError, setSafetyError] = useState<SafetyInvariantError | null>(null);
  const [unknownOutcome, setUnknownOutcome] = useState<{
    message: string;
    hash?: string;
  } | null>(null);
  const [usedInfo, setUsedInfo] = useState<{ hash?: string } | null>(null);
  // The XRP payout guard, as a state machine rather than a nullable string
  // (2026-09-29, F9): while the ledger lookup is in flight Sign is disabled;
  // a lookup that fails or takes too long allows Sign WITH a warning; the
  // guard is asked again right before signing.
  const [xrpCheck, setXrpCheck] = useState<XrpPayoutCheck>({ state: "idle" });
  // Whether a UTXO source will spend its whole account (F10) — for the FROM
  // line. Null until known.
  const [accountWide, setAccountWide] = useState<boolean | null>(null);
  // A tick so the deposit-window line and its gate re-evaluate while open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Guards against a second submit while one is in flight (double Enter).
  const submittingRef = useRef(false);

  // The quote under review, captured when the modal OPENS (F2/F3). Whatever
  // the parent passes afterwards, this modal shows and signs the quote the
  // user opened it on. Captured during render, so there is no frame in which
  // an old snapshot could be signed.
  const snapRef = useRef<{ open: boolean; quote: NormalizedQuote }>({ open: false, quote });
  if (open && !snapRef.current.open) snapRef.current = { open: true, quote };
  if (!open && snapRef.current.open) snapRef.current = { open: false, quote };
  const q = snapRef.current.open ? snapRef.current.quote : quote;

  // Resolve effective metadata for each side. When the user picked a
  // multi-chain symbol via the NetworkPill, `fromBlockchain` carries
  // the chain-specific routing info (asset id, RPC list, evm chain id);
  // otherwise the static SWAP_COIN_META entry is the canonical answer.
  const fromMeta =
    getSwapCoinMeta(fromAsset, fromBlockchain) ??
    SWAP_COIN_META[fromAsset.toUpperCase()];
  // The destination resolved the way the swap form resolves it (its
  // `toBlockchain` is `defaultBlockchainFor(toAsset)`), so the asset id
  // compared with the quote's request is the one the form asked for.
  const toMeta =
    getSwapCoinMeta(toAsset, defaultBlockchainFor(toAsset) ?? undefined) ??
    SWAP_COIN_META[toAsset.toUpperCase()];
  const depositAddr = q.intentsQuote?.depositAddress;
  const depositDeadline = q.intentsQuote?.deadline ?? q.intentsRequest?.deadline;
  const windowLeft =
    q.source === "intents"
      ? depositWindowMinutesLeft({
          deadline: depositDeadline,
          chainKind: fromMeta?.chainKind,
          nowMs,
        })
      : null;
  const windowClosed = q.source === "intents" && (windowLeft === null || windowLeft < 0);

  const sourceExplorer = useMemo(
    () => (exec.sourceTxHash && fromMeta ? fromMeta.explorerTxUrl(exec.sourceTxHash) : null),
    [exec.sourceTxHash, fromMeta]
  );
  const destExplorer = useMemo(
    () => (exec.destTxHash && toMeta ? toMeta.explorerTxUrl(exec.destTxHash) : null),
    [exec.destTxHash, toMeta]
  );

  // Reset state every time the modal opens (a stale "done" should not
  // persist between distinct swaps) — and if this quote's deposit address
  // was already used, open on that fact instead of on a live Sign button.
  useEffect(() => {
    if (!open) return;
    setPassword("");
    setPwError(null);
    setExec({ phase: "idle" });
    setMockStop(null);
    setSafetyError(null);
    setUnknownOutcome(null);
    setNowMs(Date.now());
    const prior = intentsDepositAttempt(snapRef.current.quote.intentsQuote?.depositAddress);
    if (prior) {
      setUsedInfo({ hash: prior.txHash });
      setStage("used");
    } else {
      setUsedInfo(null);
      setStage("review");
    }
  }, [open]);

  // Deposit-window clock (F4): the gate below is evaluated at render, so it
  // needs renders. Only while the user can still press Sign.
  useEffect(() => {
    if (!open || q.source !== "intents") return;
    if (stage !== "review" && stage !== "password") return;
    const t = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [open, q.source, stage]);

  // XRP payout guard (F9). Asked once per opened quote; Sign stays disabled
  // while the answer is pending; an answer that never comes allows Sign with
  // a warning after XRP_GUARD_TIMEOUT_MS.
  useEffect(() => {
    setXrpCheck({ state: "idle" });
    if (!open || toAsset.toUpperCase() !== "XRP" || q.source !== "intents") return;
    let live = true;
    setXrpCheck({ state: "pending" });
    void checkXrpPayout({
      destination: destinationAddress,
      minReceived: q.minReceived,
      lookup: xrpAccountActivation,
      timeoutMs: XRP_GUARD_TIMEOUT_MS,
    }).then((result) => {
      if (live) setXrpCheck(result);
    });
    return () => {
      live = false;
    };
  }, [open, toAsset, q.source, q.minReceived, destinationAddress]);
  const xrpGate = xrpSignGate(xrpCheck);
  const xrpBlock = xrpGate.blockedReason;

  // F10: will this UTXO source spend its whole account? Same question the
  // executor asks, so the FROM line says what will actually happen.
  // Keyed on strings, not on `sourceSecret`: the swap views rebuild that
  // object on every render, and an effect keyed on it would re-derive the
  // account (and flicker the FROM line) each time.
  const utxoSigner = fromMeta?.tsSourceSigner;
  const utxoChainKey = fromMeta?.walletsByChainKey;
  const utxoMnemonic = sourceSecret?.kind === "mnemonic" ? sourceSecret.value : undefined;
  useEffect(() => {
    setAccountWide(null);
    if (!open || utxoSigner !== "utxo-account") return;
    const chainKey = utxoChainKey;
    const mnemonic = utxoMnemonic;
    if (!chainKey || !mnemonic) {
      setAccountWide(false);
      return;
    }
    let live = true;
    void accountSendAvailable({ chainKey, mnemonic, fromAddress: sourceAddress })
      .then((ok) => {
        if (live) setAccountWide(ok);
      })
      .catch(() => {
        if (live) setAccountWide(false);
      });
    return () => {
      live = false;
    };
  }, [open, utxoSigner, utxoChainKey, utxoMnemonic, sourceAddress]);

  // Effective routing mode for this quote — drives the ROUTING row + the
  // dynamic button text. Live + non-mock-detected → green. Anything else
  // → yellow + the explicit "won't broadcast to real chain" copy.
  const modeInfo = useMemo(
    () => effectiveModeForSource(q.source, q.swapKitRoute),
    [q.source, q.swapKitRoute]
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

  // Closing is blocked while a deposit is being signed or broadcast (F2):
  // closing and re-opening used to land on "review" with the same quote and a
  // live Sign button while the first deposit was still in flight.
  const busy = modalIsBusy(stage, exec.phase);
  const requestClose = () => {
    if (!busy) onClose();
  };

  const signBlockedReason =
    xrpBlock ??
    (windowClosed
      ? "This quote's deposit window has closed (or is too close to closing for this chain). Close this window and let the form fetch a new quote."
      : null);

  const submitPassword = async () => {
    if (submittingRef.current) return;
    if (!password) {
      setPwError("Enter your vault password.");
      return;
    }
    submittingRef.current = true;
    setPwError(null);
    setStage("executing");
    setExec({ phase: "building" });

    const id = newSwapId();
    let historyWritten = false;
    // Same blockchain-aware resolution as the render-time lookup —
    // ensures the post-broadcast history entry uses the right
    // explorer URL when the user picked a non-default chain.
    const fromMetaLocal = fromMeta;
    const toMetaLocal = toMeta;
    const createdAt = new Date().toISOString();
    const provider = `${q.routerLabel} · ${q.providerName}`;

    const writeIntentsRow = async (r: {
      sourceTxHash: string;
      depositAddress: string;
      outcomeUnknown?: boolean;
    }) => {
      const entry: SwapHistoryEntry = {
        id,
        fromAsset,
        toAsset,
        fromAmount,
        toAmount: q.expectedReceive,
        status: "pending",
        sourceTxHash: r.sourceTxHash,
        sourceExplorerUrl: r.sourceTxHash
          ? (fromMetaLocal?.explorerTxUrl(r.sourceTxHash) ?? "")
          : "",
        provider,
        createdAt,
        depositAddress: r.depositAddress,
        depositDeadline,
        ...(r.outcomeUnknown ? { outcomeUnknown: true } : {}),
      };
      if (historyWritten) {
        await updateSwapHistoryEntry(id, entry);
      } else {
        await appendSwapHistory(entry);
        historyWritten = true;
      }
    };

    const followIntents = (depositAddress: string) => {
      void pollIntentsToTerminal({
        depositAddress,
        deadline: depositDeadline,
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
          if (historyWritten) {
            await updateSwapHistoryEntry(id, {
              status: histStatus,
              outcomeUnknown: false,
              completedAt: new Date().toISOString(),
              ...(actualReceived
                ? { actualReceived, actualReceivedAt: new Date().toISOString() }
                : {}),
            });
          }
          setExec((prev) => ({
            ...prev,
            phase: "done",
            trackStatus: (typeof terminal.status === "string"
              ? terminal.status.toLowerCase()
              : undefined) as SwapExecutionStatus["trackStatus"],
          }));
          // A status from 1Click settles an "unknown" outcome too: it saw the
          // deposit (or the deadline passed without one).
          setStage("done");
        })
        .catch(() => {
          // Still pending as far as anyone knows. The history row stays
          // "pending" and is resumed on the next session
          // (`intents-status-resume.ts`); nothing here says "failed".
          setExec((prev) =>
            prev.phase === "pending"
              ? { ...prev, error: "Still waiting on NEAR Intents — the swap's status will keep updating in History." }
              : prev,
          );
        });
    };

    try {
      if (q.source === "swapkit") {
        // Pull the encrypted vault directly from the store so we don't have
        // to thread it through props. Same key the rest of the app uses.
        const store = await getStore();
        const encrypted = await store.get<EncryptedData>("wallet");
        if (!encrypted) {
          throw new Error("No saved vault found — create or import a wallet first.");
        }
        const session = await unlockSwap(encrypted, password);
        if (!q.swapKitRoute) {
          throw new Error("SwapKit quote missing route data");
        }
        let result: { sourceTxHash: string };
        try {
          result = await executeSwapKitTrade({
            sessionId: session.sessionId,
            fromAsset,
            route: q.swapKitRoute,
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
          toAmount: q.expectedReceive,
          status: "pending",
          sourceTxHash: result.sourceTxHash,
          sourceExplorerUrl: fromMetaLocal?.explorerTxUrl(result.sourceTxHash) ?? "",
          provider,
          createdAt,
        };
        await appendSwapHistory(entry);
        historyWritten = true;

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
        return;
      }

      // ─── NEAR Intents ────────────────────────────────────────────────
      if (!q.intentsQuote || !depositAddr) {
        throw new Error("NEAR Intents quote missing data");
      }
      if (!fromMeta) {
        throw new Error(`Unknown source asset ${fromAsset}`);
      }
      // Compute the user-intended atomic amount up-front so the
      // safety-invariant layer can sanity-check `quote.amountIn`
      // against it. Same conversion as `useSwapQuote` performs when
      // building the request body — the two MUST agree by construction.
      const userIntendedAtomic = decimalToBaseUnitsBigInt(
        fromAmount,
        fromMeta.decimals
      );
      const destinationAsset = toMeta?.nearIntentsAsset ?? "";

      // Refusals that need no key and sign nothing (F2/F3/F4/F9), run before
      // the vault is unlocked. The executor repeats the first three.
      const prior = intentsDepositAttempt(depositAddr);
      if (prior) {
        setUsedInfo({ hash: prior.txHash });
        setExec({ phase: "idle" });
        setStage("used");
        return;
      }
      assertQuoteBinding(q.intentsRequest, {
        originAsset: fromMeta.nearIntentsAsset,
        destinationAsset,
        amountAtomic: userIntendedAtomic,
        recipient: destinationAddress,
        refundTo: sourceAddress,
      });
      assertDepositWindowOpen({
        deadline: depositDeadline,
        chainKind: fromMeta.chainKind,
        nowMs: Date.now(),
        ticker: fromMeta.ticker,
      });
      if (toAsset.toUpperCase() === "XRP") {
        // Asked again right before signing: the answer on screen may be old,
        // and a lookup that was pending or unknown is worth one more try.
        const recheck = await checkXrpPayout({
          destination: destinationAddress,
          minReceived: q.minReceived,
          lookup: xrpAccountActivation,
          timeoutMs: XRP_GUARD_TIMEOUT_MS,
        });
        setXrpCheck(recheck);
        if (recheck.state === "blocked") throw new Error(recheck.reason);
      }

      // Pull the encrypted vault directly from the store so we don't have
      // to thread it through props. Same key the rest of the app uses.
      const store = await getStore();
      const encrypted = await store.get<EncryptedData>("wallet");
      if (!encrypted) {
        throw new Error("No saved vault found — create or import a wallet first.");
      }
      const session = await unlockSwap(encrypted, password);

      const result = await executeIntentsTrade({
        sessionId: session.sessionId,
        fromAsset,
        intentsQuote: q.intentsQuote,
        sourceAddress,
        userIntendedAtomic,
        fromBlockchain,
        // Set only for the TS-signed sources (ADA, the UTXO chains, XRP,
        // Tron); undefined for every chain that signs via sessionId.
        sourceSecret,
        // F3: what the quote was made for, and what the screen says.
        quoteRequest: q.intentsRequest!,
        quoteEcho: q.intentsEcho,
        destinationAsset,
        destinationAddress,
        // F2: the history row exists the moment there is a hash — before
        // the notify, before anything else that could fail.
        onBroadcast: async ({ sourceTxHash, depositAddress }) => {
          setExec((prev) => ({ ...prev, sourceTxHash }));
          await writeIntentsRow({ sourceTxHash, depositAddress });
        },
        onPhase: (s) => setExec(s),
      });
      followIntents(result.depositAddress);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (isSendOutcomeUnknown(e)) {
        // The deposit may be on the network (F2). Record it, follow the
        // deposit address (1Click's status settles the question), and tell
        // the user to check the hash — no Retry, ever, on this quote.
        if (depositAddr) {
          recordIntentsDeposit(depositAddr, { state: "unknown", txHash: e.hash });
          try {
            await writeIntentsRow({
              sourceTxHash: e.hash ?? "",
              depositAddress: depositAddr,
              outcomeUnknown: true,
            });
          } catch {
            /* the on-screen hash is what matters now */
          }
          followIntents(depositAddr);
        }
        setUnknownOutcome({ message: msg, hash: e.hash });
        setExec((prev) => ({ ...prev, phase: "idle", sourceTxHash: e.hash ?? prev.sourceTxHash }));
        setStage("unknown");
        return;
      }
      if (e instanceof IntentsQuoteAlreadyUsedError) {
        setUsedInfo({ hash: e.attempt.txHash });
        setExec({ phase: "idle" });
        setStage("used");
        return;
      }
      // The Rust keystore returns "decryption failed (wrong password or
      // corrupted vault)" on bad password; that's the only case where we
      // can recover by going back to the password stage — the executor has
      // not run, so the quote is untouched.
      if (/decryption failed|wrong password/i.test(msg)) {
        setPwError("Incorrect password.");
        setStage("password");
        setExec({ phase: "idle" });
        return;
      }
      // Any other failure retires the quote (F2): "try again" is a NEW quote
      // with a new deposit address, fetched by the form once this closes.
      if (q.source === "intents" && depositAddr) {
        recordIntentsDeposit(depositAddr, { state: "retired" });
      }
      // SafetyInvariantError is a wallet-self-detected bug — surface a
      // dedicated red banner with copy-friendly details. NO retry button:
      // the user must close + re-quote (the bug class is in the wallet,
      // not the network, so retrying just re-fires the same invariant).
      if (e instanceof SafetyInvariantError) {
        setSafetyError(e);
        setExec({ phase: "idle" });
        setStage("error");
        if (historyWritten) {
          await updateSwapHistoryEntry(id, { status: "failed" });
        }
        return;
      }
      setExec({ phase: "error", error: msg });
      setStage("error");
      if (historyWritten) {
        await updateSwapHistoryEntry(id, { status: "failed" });
      }
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <Backdrop onClick={busy ? undefined : requestClose}>
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
            onClick={requestClose}
            aria-label="Close"
            disabled={busy}
            title={busy ? "The deposit is being signed and sent — this closes once it is on its way." : undefined}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 16,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.35 : 1,
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
              ~{q.expectedReceive} <span style={{ color: "var(--text-dim)" }}>{toAsset}</span>
            </div>
          </div>
        </div>

        {/* Addresses. An account-wide UTXO deposit (F10) spends from every
            address of the wallet, so "From <one address>" would be untrue. */}
        {accountWide ? (
          <Row
            label="From"
            value={`${fromMeta?.ticker ?? fromAsset} wallet (all addresses) · primary ${truncate(sourceAddress)}`}
            fullValue={sourceAddress}
          />
        ) : (
          <Row label="From" value={truncate(sourceAddress)} fullValue={sourceAddress} />
        )}
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
          <RoutingRow modeInfo={modeInfo} quote={q} />
          <Stat k="min received" v={`${q.minReceived} ${toAsset}`} />
          <Stat k="network fees" v={`${q.totalFeesSource} ${fromAsset}`} />
          {/* Pwnda fee — proxy-injected SwapKit affiliate fee, already
              deducted from `expectedReceive` by SwapKit before the route
              reaches us. Surface it explicitly: hiding it would mean the
              user sees a smaller output than the un-affiliated quote and
              wonders why. NEAR Intents rolls all costs into amountOut so
              affiliateFeeSource is "0" there — row collapses to a "—". */}
          <Stat
            k="Pwnda fee"
            v={formatPwndaFee(q.affiliateFeeSource, fromAmount, fromAsset)}
          />
          <Stat
            k="provider"
            v={`${q.routerLabel} · ${q.providerName}`}
          />
          <Stat k="est. time" v={q.etaPretty} />
          {q.source === "intents" && (
            <Stat k="deposit by" v={formatDepositWindow(depositDeadline, windowLeft)} />
          )}
          {q.warnings.length > 0 && (
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
              {q.warnings.map((w, i) => (
                <div key={i}>! {w}</div>
              ))}
            </div>
          )}
        </div>

        {xrpCheck.state === "blocked" && (
          <div
            data-xrp-payout-block
            style={{
              marginTop: 10,
              padding: "8px 10px",
              background: "rgba(255,80,80,0.08)",
              border: "1px solid rgba(255,80,80,0.45)",
              color: "var(--danger)",
              fontSize: 10,
              lineHeight: 1.5,
            }}
          >
            ✗ {xrpCheck.reason}
          </div>
        )}
        {xrpGate.warning && (
          <div
            data-xrp-payout-warning
            style={{
              marginTop: 10,
              padding: "8px 10px",
              background: "rgba(255,170,0,0.08)",
              border: "1px solid rgba(255,170,0,0.4)",
              color: "var(--warn)",
              fontSize: 10,
              lineHeight: 1.5,
            }}
          >
            ! {xrpGate.warning}
          </div>
        )}

        {/* Stage-specific footer */}
        <div style={{ marginTop: 16 }}>
          {stage === "review" && (
            <ReviewFooter
              onCancel={requestClose}
              onSign={() => setStage("password")}
              isMockMode={isMockMode}
              blockedReason={xrpBlock}
              gateReason={signBlockedReason}
            />
          )}
          {stage === "password" && (
            <PasswordFooter
              password={password}
              setPassword={setPassword}
              error={pwError}
              isMockMode={isMockMode}
              blockedReason={signBlockedReason}
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
              onClose={requestClose}
            />
          )}
          {stage === "unknown" && unknownOutcome && (
            <UnknownOutcomeFooter
              message={unknownOutcome.message}
              hash={unknownOutcome.hash}
              explorerUrl={
                unknownOutcome.hash && fromMeta ? fromMeta.explorerTxUrl(unknownOutcome.hash) : null
              }
              trackStatus={exec.trackStatus}
              onClose={requestClose}
            />
          )}
          {stage === "used" && (
            <UsedQuoteFooter
              hash={usedInfo?.hash}
              explorerUrl={usedInfo?.hash && fromMeta ? fromMeta.explorerTxUrl(usedInfo.hash) : null}
              onClose={requestClose}
            />
          )}
          {stage === "mockStop" && mockStop && (
            <MockStopFooter mockStop={mockStop} onClose={requestClose} />
          )}
          {stage === "error" && safetyError && (
            <SafetyInvariantFooter error={safetyError} onClose={requestClose} />
          )}
          {stage === "error" && !safetyError && (
            <ErrorFooter
              error={exec.error ?? "Unknown error"}
              onClose={requestClose}
              onRetry={
                q.source === "swapkit"
                  ? () => {
                      // SwapKit only (archived router). A NEAR Intents quote
                      // is never retried in place: it is bound to one deposit
                      // address, and a retry means a new quote (F2).
                      setExec({ phase: "idle" });
                      setStage("password");
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>
    </Backdrop>
  );
}

/** How long the XRP payout lookup may take before Sign is allowed with a
 *  warning instead (F9). */
const XRP_GUARD_TIMEOUT_MS = 8_000;

/**
 * The XRP payout guard's states (2026-09-29, F9). `idle` means the swap does
 * not pay out XRP. Only `pending` and `blocked` stop Sign; `unknown` allows it
 * with a warning, because an unreachable ledger is not evidence the account
 * is missing.
 */
export type XrpPayoutCheck =
  | { state: "idle" }
  | { state: "pending" }
  | { state: "ok" }
  | { state: "blocked"; reason: string }
  | { state: "unknown"; warning: string };

/**
 * Ask the XRP Ledger whether this payout can land, with a deadline. Never
 * rejects. Before 2026-09-29 the modal let Sign through while this lookup was
 * still in flight and never asked again, so a click inside the lookup window
 * skipped the guard entirely.
 */
export async function checkXrpPayout(args: {
  destination: string;
  minReceived: string;
  lookup: (address: string) => Promise<{ activated: boolean; reserveBaseXrp: number } | null>;
  timeoutMs: number;
}): Promise<XrpPayoutCheck> {
  let activation: { activated: boolean; reserveBaseXrp: number } | null;
  try {
    activation = await withTimeout(
      args.lookup(args.destination),
      args.timeoutMs,
      "XRP account lookup",
    );
  } catch {
    return {
      state: "unknown",
      warning:
        "Could not reach the XRP Ledger to check that your XRP account is activated. " +
        "If it is not, a payout below the account reserve will be refused.",
    };
  }
  if (!activation) {
    return {
      state: "unknown",
      warning:
        "The XRP Ledger did not say whether your XRP account is activated. If it is " +
        "not, a payout below the account reserve will be refused.",
    };
  }
  const reason = xrpPayoutBlockReason({
    activation,
    minReceived: args.minReceived,
    destination: args.destination,
  });
  return reason ? { state: "blocked", reason } : { state: "ok" };
}

/** What the XRP guard does to the Sign button (F9). Pure, for tests. */
export function xrpSignGate(c: XrpPayoutCheck): {
  blockedReason: string | null;
  warning: string | null;
} {
  switch (c.state) {
    case "pending":
      return {
        blockedReason: "Checking that your XRP account can receive this payout…",
        warning: null,
      };
    case "blocked":
      return { blockedReason: c.reason, warning: null };
    case "unknown":
      return { blockedReason: null, warning: c.warning };
    default:
      return { blockedReason: null, warning: null };
  }
}

/**
 * True while the modal must not close: from the password submit until the
 * deposit has a hash (F2). Closing then used to leave the signature running
 * behind a modal that re-opened on "review" with the same quote.
 */
export function modalIsBusy(stage: string, phase: SwapExecutionStatus["phase"]): boolean {
  return (
    stage === "executing" &&
    (phase === "building" || phase === "signing" || phase === "broadcasting")
  );
}

/** "14:32 (in 23 min)" — or why the window is shut (F4). */
function formatDepositWindow(deadline: string | undefined, minutesLeft: number | null): string {
  if (!deadline || minutesLeft === null) return "unknown — get a new quote";
  const at = new Date(Date.parse(deadline)).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (minutesLeft < 0) return `${at} — too close; get a new quote`;
  return `${at} (${Math.floor(minutesLeft)} min to sign)`;
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
  blockedReason,
  gateReason,
}: {
  onCancel: () => void;
  onSign: () => void;
  isMockMode: boolean;
  /** Set when the swap must not be signed as quoted (the XRP payout guard). */
  blockedReason?: string | null;
  /** Every reason Sign is disabled — the XRP guard, a closed deposit window
   *  (F4). Shown under the buttons unless the XRP box above already says it. */
  gateReason?: string | null;
}) {
  // Mock mode flips the button copy so the user can't accidentally
  // forget which upstream they're signing against. The button still
  // does the same thing — the text is the protection.
  const label = isMockMode
    ? "Sign & Send (mock — won't broadcast to real chain)"
    : "Sign & Send";
  const reason = gateReason ?? blockedReason ?? null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" full onClick={onCancel}>Cancel</Btn>
        <Btn
          variant={isMockMode ? "ghost" : "accent"}
          full
          caret={false}
          onClick={onSign}
          disabled={!!reason}
          title={reason ?? undefined}
        >
          {label}
        </Btn>
      </div>
      {reason && reason !== blockedReason && (
        <div data-sign-gate style={{ color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
          {reason}
        </div>
      )}
      {reason && reason === blockedReason && /^Checking/.test(reason) && (
        <div data-sign-gate style={{ color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
          {reason}
        </div>
      )}
    </div>
  );
}

function PasswordFooter({
  password,
  setPassword,
  error,
  isMockMode,
  blockedReason,
  onCancel,
  onSubmit,
}: {
  password: string;
  setPassword: (v: string) => void;
  error: string | null;
  isMockMode: boolean;
  /** Why Unlock & Sign is disabled right now (F4/F9), if it is. */
  blockedReason?: string | null;
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
          if (e.key === "Enter" && !blockedReason) onSubmit();
        }}
        placeholder="enter vault password"
        style={{ fontSize: 13, padding: "10px 12px" }}
      />
      {error && (
        <div style={{ color: "var(--danger)", fontSize: 10 }}>{error}</div>
      )}
      {blockedReason && (
        <div data-sign-gate style={{ color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
          {blockedReason}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" full onClick={onCancel}>Back</Btn>
        <Btn
          variant={isMockMode ? "ghost" : "accent"}
          full
          caret={false}
          onClick={onSubmit}
          disabled={!!blockedReason}
          title={blockedReason ?? undefined}
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
  // "Signing", not "Signing in Rust core": ADA, the UTXO account-wide sends
  // (F10), XRP and Tron sign in TypeScript.
  const steps: Array<{ key: SwapExecutionStatus["phase"]; label: string }> = [
    { key: "building", label: "Building transaction" },
    { key: "signing", label: "Signing" },
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
  // Without `onRetry` (every NEAR Intents quote since 2026-09-29, F2) the way
  // to try again is a NEW quote, so the copy must not say "Retry". An error
  // shown here was decided before anything went out — ambiguous broadcasts
  // have their own "unknown" screen.
  const guidance = !onRetry
    ? isRateLimit
      ? "Nothing was sent: every RPC rate-limited the request. Wait ~30 s, close this window, and the form will fetch a fresh quote to try again."
      : "Nothing was sent. Close this window — the form fetches a fresh quote, and a new attempt uses that one."
    : isRateLimit
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
  const copy = safetyFooterCopy(error.invariant);
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
          ⚠ {copy.headline}
        </div>
        <div style={{ marginBottom: 6 }}>
          {copy.lead}
          {copy.strong && <strong> {copy.strong}</strong>}
          {copy.tail ? ` ${copy.tail}` : ""}
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
 * The words on the safety-check screen, by invariant (2026-09-29 send-safety
 * audit, F8/F9). One sentence used to cover every invariant — "Safety check
 * failed before broadcasting … No funds have moved. Please screenshot this
 * and report it." — and two cases made it false:
 *
 *  - VERIFIED_HASH_MISMATCH fires AFTER the broadcast. "No funds have moved"
 *    is exactly the wrong thing to tell someone whose deposit may be on chain.
 *    (The executor now reports it as an unknown outcome; this copy is the
 *    backstop if it ever reaches this screen again.)
 *  - TX_NOT_FUNDABLE is not a wallet bug: the amount plus the fee is more
 *    than the address holds — what pressing MAX on a native coin did. Asking
 *    the user to report it as a bug sent them nowhere useful.
 */
export function safetyFooterCopy(invariant: string): {
  headline: string;
  lead: string;
  strong: string | null;
  tail: string | null;
} {
  if (invariant === "VERIFIED_HASH_MISMATCH") {
    return {
      headline: "Safety check failed after broadcasting",
      lead: "The network reported a different transaction hash than the one the wallet signed.",
      strong: "The deposit may have been sent.",
      tail: "Check the transaction on a block explorer before doing anything else, and screenshot this.",
    };
  }
  if (invariant === "TX_NOT_FUNDABLE") {
    return {
      headline: "Not enough balance for this swap and its network fee",
      lead: "The amount plus the network fee is more than the sending address holds.",
      strong: "Nothing was sent.",
      tail: "Lower the amount (MAX leaves room for the fee) and let the form fetch a new quote.",
    };
  }
  return {
    headline: "Safety check failed before broadcasting",
    lead: "The wallet detected an inconsistency in the transaction it built.",
    strong: "No funds have moved.",
    tail: "Please screenshot this and report it.",
  };
}

/**
 * The deposit MAY have gone out (2026-09-29 send-safety audit, F2). Shown
 * instead of "Broadcast failed. Retry" — a retry on this quote would sign a
 * second deposit to the same address. The hash is the one thing that settles
 * it, so it leads; the swap is also being followed by its deposit address.
 */
function UnknownOutcomeFooter({
  message,
  hash,
  explorerUrl,
  trackStatus,
  onClose,
}: {
  message: string;
  hash?: string;
  explorerUrl: string | null;
  trackStatus?: string;
  onClose: () => void;
}) {
  return (
    <div data-swap-outcome="unknown" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          padding: "12px 14px",
          background: "rgba(255,170,0,0.08)",
          border: "1.5px solid rgba(255,170,0,0.5)",
          color: "var(--warn)",
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 12 }}>
          Not confirmed — this deposit may have been sent
        </div>
        <div style={{ color: "var(--text)" }}>
          Check the transaction below on a block explorer (or in History) before
          swapping again. This quote will not be used a second time; the swap is
          being followed by its deposit address and History will update.
        </div>
        {hash ? (
          <div style={{ marginTop: 8, fontSize: 10, wordBreak: "break-all" }}>
            tx:{" "}
            {explorerUrl ? (
              <a href={explorerUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {hash}
              </a>
            ) : (
              <span className="tnum" style={{ color: "var(--text)" }}>{hash}</span>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 8, fontSize: 10, color: "var(--text)" }}>
            No transaction id came back. Check this wallet's recent activity on the
            source chain before swapping again.
          </div>
        )}
        {trackStatus && (
          <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-dim)" }}>
            NEAR Intents: <span style={{ color: "var(--text)" }}>{trackStatus}</span>
          </div>
        )}
        <details style={{ marginTop: 8, fontSize: 10, color: "var(--text-dim)" }}>
          <summary style={{ cursor: "pointer" }}>What the network said</summary>
          <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", wordBreak: "break-all", whiteSpace: "pre-wrap" }}>
            {message}
          </div>
        </details>
      </div>
      <Btn variant="ghost" full caret={false} onClick={onClose}>
        Close
      </Btn>
    </div>
  );
}

/**
 * This quote was already used (F2) — opened again after a close, or a second
 * submit. Nothing new is signed; a new swap needs a new quote.
 */
function UsedQuoteFooter({
  hash,
  explorerUrl,
  onClose,
}: {
  hash?: string;
  explorerUrl: string | null;
  onClose: () => void;
}) {
  return (
    <div data-swap-outcome="used" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          padding: "10px 12px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        This quote has already been used{hash ? " for the deposit below" : ""}. Nothing
        new was signed. Close this window — the form fetches a fresh quote for a new swap.
        {hash && (
          <div style={{ marginTop: 6, fontSize: 10, wordBreak: "break-all" }}>
            {explorerUrl ? (
              <a href={explorerUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {hash}
              </a>
            ) : (
              <span className="tnum">{hash}</span>
            )}
          </div>
        )}
      </div>
      <Btn variant="ghost" full caret={false} onClick={onClose}>
        Close
      </Btn>
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
