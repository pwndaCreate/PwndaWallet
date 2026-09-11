/**
 * Swap-surface mount for `SweepBackConfirmCard` (contract C4/C6, UI side).
 *
 * The card was exported from `features/swap-sidecar/index.ts` and mounted
 * **nowhere**, so the sweep-back feature — the way funds get *out* of the swap
 * node — had no reachable entry point at all. This is its host: landscape
 * first (`SwapLandscapeView`), portrait inheriting the same block
 * (`SwapView`), directly under the swap-node balances card, because "here is
 * what the node holds" and "send it back to me" are the same thought.
 *
 * # The security property, and what this file must never do
 *
 * **No destination is ever typed, chosen, or defaulted by the renderer.**
 * `swap_bridge_prepare_sweep` derives it Rust-side from the unlocked vault
 * session; `swap_bridge_execute_sweep` takes a token and a confirm phrase and
 * has no address parameter (contract §R13). The mount's job is to keep that
 * true: it renders the destination as **text**, never as an input — not even a
 * disabled one, because a disabled input is one attribute away from an enabled
 * one. {@link SweepBackPanel} is pure precisely so a test can walk its element
 * tree and assert the absence.
 *
 * # Why the password stage exists
 *
 * `prepare(coin)` needs a live swap session (`swap_unlock`), which is what
 * gives Rust the seed to derive the destination from. The same
 * unlock-then-relock shape `SwapConfirmModal`
 * already use. The session is dropped again as soon as the sweep resolves.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Btn, Card } from "../../design/primitives";
import { SweepBackConfirmCard, useSweepBack, type SweepPlan } from "../swap-sidecar";
import type { SidecarBalanceRow } from "../swap-sidecar";
import type { ChainType } from "../../wallets/types";
import { getStore } from "../../store";
import type { EncryptedData } from "../../crypto";
import { lockSwap, unlockSwap } from "../../api/swap-rust";
import {
  SWEEP_INTRO_NOTE,
  SWEEP_IN_FLIGHT_NOTE,
  SWEEP_UNLOCK_NOTE,
  sweepableCoins,
  type SweepCandidate,
} from "./sweepBackCoins";

const mono = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  lineHeight: 1.6,
} as const;

/** Which of the three stages the section is showing. */
export type SweepStage = "list" | "password" | "plan" | "done";

function Note({ children }: { children: string }) {
  return (
    <div style={{ ...mono, fontSize: 10.5, color: "var(--text-dim)", marginBottom: 8 }}>
      {children}
    </div>
  );
}

/**
 * Pure presentational half — **no hooks**, safe to call directly from a test.
 *
 * The `plan` stage delegates entirely to `SweepBackConfirmCard`, which owns the
 * one legitimate input on this surface (the 6-character confirm phrase). This
 * function must therefore emit **zero** inputs of its own in that stage; the
 * test asserts exactly that, and it is the assertion that goes red the moment
 * someone adds an "or send to…" field.
 */
export function SweepBackPanel({
  visible,
  stage,
  candidates,
  plan,
  busy,
  error,
  txid,
  password,
  onPassword,
  onPick,
  onUnlock,
  onConfirm,
  onCancel,
  onDismiss,
}: {
  visible: boolean;
  stage: SweepStage;
  candidates: SweepCandidate[];
  plan: SweepPlan | null;
  busy: boolean;
  error: string | null;
  txid: string | null;
  password: string;
  onPassword: (v: string) => void;
  onPick: (c: SweepCandidate) => void;
  onUnlock: () => void;
  onConfirm: (phrase: string) => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (!visible) return null;

  // The confirm card brings its own frame and its own copy; wrapping it in a
  // second Card would double the chrome and push the destination below the
  // fold on the portrait surface.
  if (stage === "plan" && plan) {
    return (
      <div style={{ marginTop: 12 }}>
        <SweepBackConfirmCard
          plan={plan}
          onConfirm={onConfirm}
          onCancel={onCancel}
          error={error}
        />
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div style={{ marginTop: 12 }}>
        <Card title="SWEEP SENT">
          <div style={{ ...mono, color: "var(--text-dim)", marginBottom: 6 }}>
            The swap node broadcast the transaction. It will appear in your own
            wallet once the network confirms it.
          </div>
          <div
            style={{
              ...mono,
              color: "var(--text)",
              wordBreak: "break-all",
              marginBottom: 8,
            }}
          >
            {txid ?? "—"}
          </div>
          <Btn variant="ghost" size="sm" onClick={onDismiss}>
            Done
          </Btn>
        </Card>
      </div>
    );
  }

  if (stage === "password") {
    return (
      <div style={{ marginTop: 12 }}>
        <Card title="UNLOCK TO SWEEP">
          <Note>{SWEEP_UNLOCK_NOTE}</Note>
          {/* The ONLY input in this stage, and it is a password — there is no
              field here that could carry an address. */}
          <input
            type="password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            placeholder="vault password"
            autoComplete="off"
            spellCheck={false}
            style={{
              ...mono,
              width: "100%",
              padding: "8px 10px",
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text)",
              marginBottom: 8,
            }}
          />
          {error && (
            <div
              style={{
                ...mono,
                fontSize: 10.5,
                color: "var(--danger)",
                wordBreak: "break-word",
                marginBottom: 8,
              }}
            >
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              variant="accent"
              size="md"
              disabled={busy || password.length === 0}
              onClick={onUnlock}
            >
              {busy ? "Working…" : "Continue"}
            </Btn>
            <Btn variant="ghost" size="md" onClick={onCancel}>
              Cancel
            </Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ── list ───────────────────────────────────────────────────────────
  if (candidates.length === 0) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <Card title="SWEEP BACK">
        <Note>{SWEEP_INTRO_NOTE}</Note>
        <Note>{SWEEP_IN_FLIGHT_NOTE}</Note>
        {candidates.map((c) => (
          <div
            key={c.ticker}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "6px 0",
              borderTop: "1px solid var(--border-soft)",
            }}
          >
            <span style={{ ...mono, color: "var(--text)", letterSpacing: 1 }}>
              {c.ticker}
            </span>
            <span className="tnum" style={{ ...mono, color: "var(--text-dim)" }}>
              {c.balance ?? "—"}
            </span>
            <Btn variant="ghost" size="sm" disabled={busy} onClick={() => onPick(c)}>
              Sweep back
            </Btn>
          </div>
        ))}
        {error && (
          <div
            style={{
              ...mono,
              fontSize: 10.5,
              color: "var(--danger)",
              wordBreak: "break-word",
              marginTop: 8,
            }}
          >
            {error}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Hook-owning wrapper. Mounted by both Swap surfaces.
 *
 * @param optedIn tri-state from `useSwapSidecarOptIn()` — `null` is NOT enabled
 * @param rows    from `useSidecarBalances()`, already polled by the host view
 * @param hasWallet `true` when the vault has a wallet for that chain
 */
export function SweepBackSection({
  optedIn,
  rows,
  hasWallet,
  sharedTickers,
}: {
  optedIn: boolean | null;
  rows: Record<string, SidecarBalanceRow>;
  hasWallet: (chain: ChainType) => boolean;
  /** See `sweepableCoins` — coins whose node wallet is the user's own. */
  sharedTickers?: ReadonlySet<string>;
}) {
  const candidates = sweepableCoins({ optedIn, rows, hasWallet, sharedTickers });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState<SweepCandidate | null>(null);
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const sweep = useSweepBack({ enabled: optedIn === true, sessionId });
  const { prepare, cancel } = sweep;

  // `prepare` closes over `sessionId`, so it cannot be called in the same tick
  // the session is set — the captured value would still be null and the hook
  // would throw "unlock your wallet first". Prepare on the next render instead.
  //
  // The ref is the loop guard, not `sweep.busy`: `useSweepBack` returns a new
  // object every render, so an effect keyed on it re-runs constantly and a
  // state-based guard has a window between "prepare called" and "busy
  // rendered" in which a second prepare can fire — each one mints a fresh
  // single-use token server-side.
  const preparedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || !pending) return;
    if (preparedFor.current === pending.coin) return;
    preparedFor.current = pending.coin;
    void prepare(pending.coin).catch(() => {
      /* surfaced via sweep.error */
    });
  }, [sessionId, pending, prepare]);

  const reset = useCallback(() => {
    preparedFor.current = null;
    setPending(null);
    setPassword("");
    setLocalError(null);
    setSessionId(null);
    cancel();
    // The session exists only to derive one destination. Drop it rather than
    // leaving a signing session warm behind a closed card.
    void lockSwap().catch(() => {
      /* already locked, or no Tauri — nothing to recover */
    });
  }, [cancel]);

  const unlock = useCallback(async () => {
    setUnlocking(true);
    setLocalError(null);
    try {
      const store = await getStore();
      const encrypted = await store.get<EncryptedData>("wallet");
      if (!encrypted) throw new Error("No saved vault.");
      const session = await unlockSwap(encrypted, password);
      setPassword("");
      setSessionId(session.sessionId);
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      setLocalError(
        /decryption failed|wrong password/i.test(msg) ? "Incorrect password." : msg,
      );
    } finally {
      setUnlocking(false);
    }
  }, [password]);

  const stage: SweepStage = sweep.txid
    ? "done"
    : sweep.plan
      ? "plan"
      : pending
        ? "password"
        : "list";

  return (
    <SweepBackPanel
      visible={optedIn === true}
      stage={stage}
      candidates={candidates}
      plan={sweep.plan}
      busy={unlocking || sweep.busy}
      error={localError ?? sweep.error}
      txid={sweep.txid}
      password={password}
      onPassword={setPassword}
      onPick={(c) => {
        setLocalError(null);
        setPending(c);
      }}
      onUnlock={() => void unlock()}
      onConfirm={(phrase) => {
        void sweep.confirm(phrase).then(
          () => {
            // The token is spent and the plan cleared by the hook; drop the
            // signing session too.
            void lockSwap().catch(() => {});
            preparedFor.current = null;
            setPending(null);
            setSessionId(null);
          },
          () => {
            /* surfaced via sweep.error; the plan stays so the user can retry */
          },
        );
      }}
      onCancel={reset}
      onDismiss={reset}
    />
  );
}
