/**
 * Confirm a sweep-back — a **pure presentational** card (contract §2.2).
 *
 * Zero `invoke`. The only state it owns is the phrase the user is typing and a
 * one-second tick for the countdown.
 *
 * # Why this card looks the way it does
 *
 * The destination is shown **in full, unabbreviated, and is not an input.** It
 * came from the vault via Rust and there is no code path — here or in
 * `swap_bridge.rs` — that accepts one from the renderer (§R13). Rendering it in
 * a text field, even a disabled one, would make it look editable and would be
 * the first step towards making it so.
 *
 * The confirmation is the last 6 characters of that destination, typed by the
 * user. There is no dialog plugin in this app; this *is* the confirmation step.
 * It is deliberately a small piece of transcription work — enough that the user
 * has to look at the address they are sending to.
 *
 * The countdown is not decoration: the token expires after 120 s and a stale
 * confirm is refused both here and in Rust.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Card, Btn } from "../../design/primitives";
import {
  confirmPhraseFor,
  formatCountdown,
  isConfirmPhraseValid,
  sweepPlanExpired,
  sweepPlanMsRemaining,
  sweepSummary,
  SWEEP_CONFIRM_LEN,
  type SweepPlan,
} from "./sweepBack";

const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1.6,
};

/**
 * @param plan      from `useSweepBack().prepare(coin)` — read-only
 * @param onConfirm receives the typed phrase; the hook re-validates and Rust
 *                  validates again independently
 * @param onCancel  drops the plan without spending the token
 * @param error     the last failure, from the hook
 */
export function SweepBackConfirmCard({
  plan,
  onConfirm,
  onCancel,
  error = null,
}: {
  plan: SweepPlan;
  onConfirm(phrase: string): void;
  onCancel(): void;
  error?: string | null;
}) {
  const [typed, setTyped] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // A new plan means a new destination — never carry a phrase across.
  useEffect(() => {
    setTyped("");
  }, [plan.token]);

  const expired = sweepPlanExpired(plan, now);
  const ok = isConfirmPhraseValid(plan, typed);
  const want = confirmPhraseFor(plan);

  return (
    <Card title="SWEEP BACK TO YOUR WALLET">
      <div style={{ ...mono, fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
        {sweepSummary(plan)}
      </div>

      <div
        style={{
          ...mono,
          fontSize: 11,
          color: "var(--text)",
          wordBreak: "break-all",
          background: "var(--surface-alt, rgba(255,255,255,0.03))",
          border: "1px solid var(--border-soft)",
          padding: "8px 10px",
          marginBottom: 8,
        }}
      >
        {plan.destination}
      </div>

      <div style={{ ...mono, fontSize: 10.5, color: "var(--text-muted)", marginBottom: 8 }}>
        {/* Stated plainly, because it is the reason the address cannot be
            wrong: it was derived from your own seed, not typed by anything. */}
        This address is derived from your wallet's own seed inside the app. It
        is not typed in and cannot be changed from this screen.
      </div>

      <label
        style={{
          ...mono,
          fontSize: 10.5,
          color: "var(--text-dim)",
          display: "block",
          marginBottom: 4,
        }}
      >
        Type the last {SWEEP_CONFIRM_LEN} characters of that address to confirm
      </label>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        placeholder={"·".repeat(Math.max(1, want.length))}
        disabled={expired}
        style={{
          ...mono,
          width: "100%",
          padding: "8px 10px",
          background: "transparent",
          border: `1px solid ${ok ? "var(--accent-mid)" : "var(--border)"}`,
          color: "var(--text)",
          letterSpacing: 2,
          marginBottom: 8,
        }}
      />

      <div
        style={{
          ...mono,
          fontSize: 10.5,
          color: expired ? "var(--danger)" : "var(--text-muted)",
          marginBottom: 8,
        }}
      >
        {expired
          ? "This confirmation expired. Prepare the sweep again."
          : `Expires in ${formatCountdown(sweepPlanMsRemaining(plan, now))}`}
      </div>

      {error && (
        <div
          style={{
            ...mono,
            fontSize: 11,
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
          disabled={!ok || expired}
          onClick={() => onConfirm(typed.trim())}
        >
          Send it back
        </Btn>
        <Btn variant="ghost" size="md" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </Card>
  );
}
