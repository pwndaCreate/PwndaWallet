/**
 * "Speed up" for an unconfirmed BTC transaction (operator request,
 * 2026-10-01) — ONE panel, mounted by the transaction details (`TxDetails`:
 * Activity in both layouts and the wallet's Recent rows) and by the swap
 * details (`SwapDetailsModal`, under a NEAR Intents swap's BTC deposit).
 * Landscape-first rule: neither surface has a copy of its own.
 *
 * It shows nothing until the chain says the transaction can be replaced:
 * unconfirmed, signalling replace-by-fee, built by this app, every input the
 * wallet's (`wallets/btc-rbf.ts`). Then a "Speed up" button; then the current
 * and new fee rate and the new fee in BTC and USD, with one confirm; then the
 * replacement's id. The steps are `lib/btcSpeedUp.ts`.
 */
import type { CSSProperties, ReactNode } from "react";
import { Btn } from "./PrimitivesV2";
import type { WalletInfo } from "../wallets/types";
import { speedUpFigures, useBtcSpeedUp, type SpeedUpDeps, type SpeedUpState } from "../lib/btcSpeedUp";

const mono: CSSProperties = { fontFamily: "var(--font-mono)" };

const box: CSSProperties = {
  ...mono,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  fontSize: 10,
  lineHeight: 1.5,
  color: "var(--text)",
  minWidth: 0,
};

function Label({ children }: { children: ReactNode }) {
  return (
    <span style={{ ...mono, fontSize: 9, color: "var(--text-dim)", letterSpacing: 1.2, textTransform: "uppercase" }}>
      {children}
    </span>
  );
}

function Figure({ k, v, sub }: { k: string; v: string; sub?: string | null }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
      <Label>{k}</Label>
      <span className="tnum" style={{ ...mono, fontSize: 10, textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>
        {v}
        {sub ? <span style={{ color: "var(--text-muted)" }}>{` · ${sub}`}</span> : null}
      </span>
    </div>
  );
}

function Dim({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "warn" | "accent" }) {
  const color = tone === "warn" ? "var(--warn)" : tone === "accent" ? "var(--accent)" : "var(--text-dim)";
  return <div style={{ ...mono, fontSize: 10, color, lineHeight: 1.5, overflowWrap: "anywhere" }}>{children}</div>;
}

export interface SpeedUpPanelViewProps {
  state: SpeedUpState | null;
  onSpeedUp: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRecheck: () => void;
}

/** The panel for one state. No hooks of its own: tests render each state. */
export function SpeedUpPanelView({ state, onSpeedUp, onCancel, onConfirm, onRecheck }: SpeedUpPanelViewProps) {
  if (!state) return null;
  if (state.phase === "unavailable" && state.quiet) return null;

  const frame = (children: ReactNode) => (
    <div data-speed-up={state.phase} style={box}>
      <Label>speed up</Label>
      {children}
    </div>
  );

  switch (state.phase) {
    case "checking":
      return frame(<Dim>Checking whether this transaction can be sped up…</Dim>);
    case "unavailable":
      return frame(<Dim>{state.reason}</Dim>);
    case "error":
      return frame(
        <>
          <Dim tone="warn">Could not check whether it can be sped up: {state.reason}</Dim>
          <div>
            <Btn variant="ghost" size="sm" onClick={onRecheck}>
              Check again
            </Btn>
          </div>
        </>,
      );
    case "ready": {
      const f = speedUpFigures(state.quote, state.usdPrice);
      return frame(
        <>
          <Dim>
            Still unconfirmed, paying {f.currentRate}. A replacement can pay {f.newRate} ({f.newRateSource}).
          </Dim>
          <div>
            <Btn variant="accent" size="sm" onClick={onSpeedUp}>
              Speed up
            </Btn>
          </div>
        </>,
      );
    }
    case "review":
    case "sending": {
      const f = speedUpFigures(state.quote, state.usdPrice);
      const sending = state.phase === "sending";
      return frame(
        <>
          <Figure k="current rate" v={f.currentRate} />
          <Figure k="new rate" v={f.newRate} />
          <Dim>{`New rate: ${f.newRateSource}.`}</Dim>
          <Figure k="new fee" v={f.newFee} sub={f.newFeeUsd} />
          <Figure k="extra fee" v={f.extraFee} sub={f.extraFeeUsd} />
          <Figure k="your change" v={`${f.changeBefore} → ${f.changeAfter}`} />
          <Dim>
            The replacement spends the same coins and pays every recipient exactly the same amount; only
            your change is smaller. Only one of the two can ever confirm.
          </Dim>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" size="sm" full onClick={onCancel} disabled={sending}>
              Cancel
            </Btn>
            <Btn variant="primary" size="sm" full onClick={onConfirm} disabled={sending}>
              {sending ? "Sending…" : "Confirm speed-up"}
            </Btn>
          </div>
        </>,
      );
    }
    case "sent":
      return frame(
        <>
          <Dim tone="accent">Replacement sent, paying {speedUpFigures(state.quote, state.usdPrice).newRate}.</Dim>
          <span className="tnum" style={{ ...mono, fontSize: 10, wordBreak: "break-all" }}>
            {state.newTxid}
          </span>
          <Dim>The original leaves your history; the replacement confirms in its place.</Dim>
        </>,
      );
    case "failed":
      return frame(
        <>
          <Dim tone="warn">Not sent: {state.reason}</Dim>
          <div>
            <Btn variant="ghost" size="sm" onClick={onRecheck}>
              Check again
            </Btn>
          </div>
        </>,
      );
    case "unknown":
      return frame(
        <Dim tone="warn">
          {state.reason}
          {state.newTxid ? ` Check ${state.newTxid} on an explorer before trying again.` : " Check this wallet's recent BTC activity before trying again."}
        </Dim>,
      );
  }
}

export interface SpeedUpPanelProps {
  /** The unconfirmed transaction. */
  txid: string;
  /** The wallet's Bitcoin entry: what signs. Null shows nothing. */
  wallet: WalletInfo | null | undefined;
  /** BTC's price in USD, when the host has it. */
  usdPrice?: number | null;
  /** Test seam. */
  deps?: SpeedUpDeps;
}

export function SpeedUpPanel({ txid, wallet, usdPrice, deps }: SpeedUpPanelProps) {
  const s = useBtcSpeedUp({ txid, wallet, usdPrice, deps });
  return (
    <SpeedUpPanelView
      state={s.state}
      onSpeedUp={s.review}
      onCancel={s.cancel}
      onConfirm={s.confirm}
      onRecheck={s.recheck}
    />
  );
}
