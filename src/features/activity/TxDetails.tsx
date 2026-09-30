/**
 * Transaction details — ONE component for both layouts.
 *
 * # Why this exists (operator report, 2026-09-30)
 *
 * "I want to be able to click on transactions whether in or out and see the
 * data on them." Landscape had a detail panel of its own (`DetailPanel`,
 * private to `ActivityLandscapeView`): a truncated hash, no sender or
 * recipient, no USD value, and a "View on explorer" that silently copied the
 * hash for the ~20 chains `explorerTxUrl` had no link for. Portrait had no
 * details at all: a row click jumped straight to a block explorer.
 *
 * Landscape mounts `TxDetails` in its right column; portrait opens it in
 * `TxDetailsSheet` when a row is tapped. Same fields, same rules, same file
 * (landscape-first rule, CLAUDE.md).
 *
 * The rules that are easy to get wrong, and are pinned by `txDetails.test.ts`:
 *  - `confirmations: undefined` means the chain gives no count, NOT zero
 *    (`ChainTx`); a row with a block height and no count is "confirmed".
 *  - A fee is labelled in the coin that paid it: a USDC-on-Arbitrum fee is
 *    ETH (`adapter.gasToken`), a USDT-on-TRON fee is TRX.
 *  - The explorer opens through `openExternal` (the Tauri opener). A plain
 *    `<a href>` does nothing in the webview.
 */
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Btn } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import { getAdapter } from "../../wallets";
import type { ChainTx } from "../../wallets";
import { explorerTxUrl } from "../../wallets/explorers";
import { txDisplayTicker, txFeeTicker, txUsdPrice } from "../../wallets/tx-display";
import type { ZphLiveStats } from "../../wallets/zph-scanner-api";
import { fmtRelative } from "../../utils/format";
import { openExternal } from "../../utils/openExternal";

/** Confirmations at which a counted row reads "confirmed" (display only). */
export const CONFIRMED_AT = 6;

export interface TxDetailsContext {
  /** The wallet's address on this chain, so "you" can be marked. */
  ownAddress?: string;
  pricesByTicker?: Record<string, number>;
  /** Zephyr oracle prices for ZEPHUSD / ZEPHRSV / ZEPHYRS rows. */
  zphStats?: ZphLiveStats | null;
}

export type Tone = "in" | "out" | "failed" | "pending" | "neutral";

export interface TxParty {
  address: string;
  you: boolean;
}

export interface TxDetailsModel {
  chainName: string;
  ticker: string;
  color: string;
  directionLabel: string;
  tone: Tone;
  sign: "+" | "−" | "";
  /** The amount as the adapter gave it, or "—" when it has none. */
  amount: string;
  amountApprox: boolean;
  usd: string | null;
  status: string;
  statusTone: "ok" | "warn" | "bad" | "dim";
  /** A count is known (`confirmations !== undefined`). */
  counted: boolean;
  confirmations: number;
  fee: string | null;
  from: TxParty | null;
  to: TxParty | null;
  time: { absolute: string; relative: string } | null;
  block: string | null;
  method: string | null;
  source: string | null;
  note: string | null;
  hash: string;
  explorerUrl: string | null;
}

function fmtUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd >= 1000) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (usd < 0.01) return "< $0.01";
  return `$${usd.toFixed(2)}`;
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  // Hex addresses (EVM) compare case-insensitively; everything else exactly.
  return /^0x[0-9a-f]+$/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function metaString(tx: ChainTx, key: string): string | undefined {
  const v = tx.meta?.[key];
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Everything the details view shows, derived from one row. Pure: no React,
 * no I/O — the component renders exactly this, and tests read it directly.
 */
export function txDetailsModel(tx: ChainTx, ctx: TxDetailsContext = {}): TxDetailsModel {
  const adapter = getAdapter(tx.chain);
  const adapterTicker = adapter?.ticker ?? tx.chain.toUpperCase();
  const ticker = txDisplayTicker(tx, adapterTicker);
  const intended = metaString(tx, "intended");

  let directionLabel: string;
  let tone: Tone;
  let sign: TxDetailsModel["sign"] = "";
  switch (tx.direction) {
    case "in":
      directionLabel = "▼ received";
      tone = "in";
      sign = "+";
      break;
    case "out":
      directionLabel = "▲ sent";
      tone = "out";
      sign = "−";
      break;
    case "self":
      directionLabel = "⟲ sent to yourself";
      tone = "neutral";
      break;
    case "failed":
      directionLabel =
        intended === "in" ? "✗ failed — incoming" : intended === "out" || intended === "self" ? "✗ failed — sent" : "✗ failed";
      tone = "failed";
      break;
    default:
      // `pending` in a block is an adapter that did not read which way the
      // transfer went (SPL tokens), not a transaction waiting to be mined.
      directionLabel = tx.height ? "◌ transfer — direction not read" : "◌ pending";
      tone = "pending";
  }

  const counted = tx.confirmations !== undefined;
  const confirmations = tx.confirmations ?? 0;
  let status: string;
  let statusTone: TxDetailsModel["statusTone"];
  if (tx.direction === "failed") {
    const why = metaString(tx, "failure");
    status = why && why !== "reverted" ? `failed (${why})` : "failed";
    statusTone = "bad";
  } else if (counted && confirmations === 0) {
    status = "unconfirmed";
    statusTone = "warn";
  } else if (counted && confirmations < CONFIRMED_AT) {
    status = `confirming (${confirmations})`;
    statusTone = "warn";
  } else if (counted || tx.height) {
    // No count but a block: the source lists mined transactions (TRON is read
    // confirmed-only, EVM token transfers and NEAR receipts are indexed).
    status = "confirmed";
    statusTone = "ok";
  } else if (tx.direction === "pending") {
    status = "pending";
    statusTone = "warn";
  } else {
    status = "—";
    statusTone = "dim";
  }

  const hasAmount = tx.amount !== "" && tx.amount !== undefined;
  const price = hasAmount && tx.direction !== "failed" && adapter
    ? txUsdPrice(tx, adapterTicker, ctx.pricesByTicker ?? {}, ctx.zphStats)
    : null;
  const amountNum = parseFloat(tx.amount);
  const usd = price && Number.isFinite(amountNum) ? fmtUsd(amountNum * price) : null;

  // The fee's coin: the gas token on a token leg, else the row's own rule.
  const feeTicker = adapter?.gasToken?.ticker ?? txFeeTicker(tx, adapterTicker);
  const fee = tx.fee ? (feeTicker ? `${tx.fee} ${feeTicker}` : `${tx.fee} (paid by the sender)`) : null;

  const own = ctx.ownAddress;
  const received = tx.direction === "in" || (tx.direction === "failed" && intended === "in");
  const fromAddr = metaString(tx, "from") ?? (received ? tx.counterparty : own);
  const toAddr = metaString(tx, "to") ?? (received ? own : tx.counterparty);
  const party = (a: string | undefined): TxParty | null => (a ? { address: a, you: sameAddress(a, own) } : null);

  const amountApprox = tx.meta?.amountApprox === true;
  let note: string | null = null;
  if (!hasAmount) note = "This chain's history does not say how much moved. The explorer does.";
  else if (amountApprox) note = "The source gives this amount with limited precision.";
  else if (tx.direction === "failed") note = "A failed transaction moves nothing; a fee may still have been paid.";

  return {
    chainName: adapter?.displayName ?? tx.chain,
    ticker,
    color: adapter?.color ?? "var(--text)",
    directionLabel,
    tone,
    sign,
    amount: hasAmount ? tx.amount : "—",
    amountApprox,
    usd,
    status,
    statusTone,
    counted,
    confirmations,
    fee,
    from: party(fromAddr),
    to: party(toAddr),
    time: tx.timestamp
      ? { absolute: new Date(tx.timestamp * 1000).toLocaleString(), relative: fmtRelative(tx.timestamp) }
      : null,
    block: tx.height ? tx.height.toLocaleString("en-US") : null,
    method: metaString(tx, "method") ?? null,
    source: metaString(tx, "source") ?? null,
    note,
    hash: tx.hash,
    explorerUrl: explorerTxUrl(tx.chain, tx.hash),
  };
}

/**
 * Open the row's transaction in the OS browser, through the Tauri opener.
 * Returns false (and opens nothing) when the chain has no explorer link.
 */
export function openTxInExplorer(tx: ChainTx): boolean {
  const url = explorerTxUrl(tx.chain, tx.hash);
  if (!url) return false;
  void openExternal(url);
  return true;
}

/** Copy the full hash. Resolves false when the clipboard refused. */
export async function copyTxHash(tx: ChainTx): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(tx.hash);
    return true;
  } catch {
    return false;
  }
}

const TONE_COLOR: Record<Tone, string> = {
  in: "var(--accent)",
  out: "var(--warn)",
  failed: "var(--danger)",
  pending: "var(--warn)",
  neutral: "var(--text)",
};

const STATUS_COLOR: Record<TxDetailsModel["statusTone"], string> = {
  ok: "var(--accent)",
  warn: "var(--warn)",
  bad: "var(--danger)",
  dim: "var(--text-dim)",
};

const mono: CSSProperties = { fontFamily: "var(--font-mono)" };

function Label({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        ...mono,
        fontSize: 9,
        color: "var(--text-dim)",
        letterSpacing: 1.2,
        textTransform: "uppercase",
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

/** Short value on one line, label left, value right. */
function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
      <Label>{k}</Label>
      <span className="tnum" style={{ ...mono, fontSize: 10, color: color ?? "var(--text)", textAlign: "right", minWidth: 0 }}>
        {v}
      </span>
    </div>
  );
}

/** Long value (address, hash): label above, the whole value wrapped below. */
function LongRow({ k, v, you }: { k: string; v: string; you?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Label>
        {k}
        {you ? <span style={{ color: "var(--accent)", marginLeft: 6, letterSpacing: 0.5 }}>· you</span> : null}
      </Label>
      <span className="tnum" style={{ ...mono, fontSize: 10, color: "var(--text)", wordBreak: "break-all", lineHeight: 1.45 }}>
        {v}
      </span>
    </div>
  );
}

function ConfBar({ value, max }: { value: number; max: number }) {
  const cells = [];
  for (let i = 0; i < max; i++) {
    cells.push(
      <div
        key={i}
        style={{
          flex: 1,
          height: 5,
          background: i < value ? "var(--accent)" : "rgba(255,255,255,0.06)",
          boxShadow: i < value ? "0 0 4px var(--accent)" : "none",
        }}
      />,
    );
  }
  return <div style={{ display: "flex", gap: 2 }}>{cells}</div>;
}

/** "Copy hash", with a moment of "Copied" feedback. Keyed per row by its parent. */
function CopyHashButton({ tx }: { tx: ChainTx }) {
  const [copied, setCopied] = useState(false);
  return (
    <Btn
      variant="ghost"
      full
      size="md"
      onClick={() => {
        void copyTxHash(tx).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "Copied" : "Copy hash"}
    </Btn>
  );
}

export interface TxDetailsViewProps {
  tx: ChainTx;
  model: TxDetailsModel;
  onExplorer: () => void;
}

/** The details, as elements. No hooks: tests call it and walk the tree. */
export function TxDetailsView({ tx, model: m, onExplorer }: TxDetailsViewProps) {
  const toneColor = TONE_COLOR[m.tone];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <CoinIcon sym={m.ticker} size={42} accent={m.color} />
        <div style={{ minWidth: 0 }}>
          <div style={{ ...mono, fontSize: 10, color: toneColor, letterSpacing: 1.5, textTransform: "uppercase" }}>
            {m.directionLabel}
          </div>
          <div
            className="tnum"
            style={{
              ...mono,
              fontSize: 22,
              fontWeight: 600,
              marginTop: 2,
              lineHeight: 1.1,
              color: m.tone === "in" ? "var(--accent)" : m.tone === "failed" ? "var(--danger)" : "var(--white)",
              wordBreak: "break-all",
            }}
          >
            {m.sign}
            {m.amountApprox ? "≈ " : ""}
            {m.amount} <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{m.ticker}</span>
          </div>
          <div className="tnum" style={{ ...mono, fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
            {m.usd ? `${m.usd} · ` : ""}
            {m.time ? m.time.relative : "time unknown"}
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: "var(--border-soft)" }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Row k="status" v={m.status} color={STATUS_COLOR[m.statusTone]} />
        <Row k="chain" v={m.chainName} />
        <Row k="amount" v={`${m.amountApprox ? "≈ " : ""}${m.amount} ${m.ticker}`} />
        {m.usd && <Row k="value" v={m.usd} />}
        <Row k="fee" v={m.fee ?? "—"} />
        <Row k="time" v={m.time ? m.time.absolute : "—"} />
        <Row k="block" v={m.block ?? "—"} />
        <Row k="confirmations" v={m.counted ? m.confirmations.toLocaleString("en-US") : "—"} />
        {m.method && <Row k="method" v={m.method} />}
        {m.from && <LongRow k="from" v={m.from.address} you={m.from.you} />}
        {m.to && <LongRow k="to" v={m.to.address} you={m.to.you} />}
        <LongRow k="hash" v={m.hash} />
        {m.source && <Row k="source" v={m.source} color="var(--text-dim)" />}
      </div>

      {m.counted && (
        <div>
          <ConfBar value={Math.min(m.confirmations, CONFIRMED_AT)} max={CONFIRMED_AT} />
          <div
            className="tnum"
            style={{ ...mono, display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 9, color: "var(--text-dim)" }}
          >
            <span>
              {Math.min(m.confirmations, CONFIRMED_AT)} / {CONFIRMED_AT}
            </span>
            <span style={{ color: m.confirmations >= CONFIRMED_AT ? "var(--accent)" : "var(--warn)" }}>
              {m.confirmations >= CONFIRMED_AT ? "CONFIRMED" : "PENDING"}
            </span>
          </div>
        </div>
      )}

      {m.note && <div style={{ ...mono, fontSize: 9, color: "var(--text-dim)", lineHeight: 1.5 }}>{m.note}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <CopyHashButton key={`${tx.chain}:${tx.hash}`} tx={tx} />
        <Btn
          variant="primary"
          full
          size="md"
          onClick={onExplorer}
          disabled={!m.explorerUrl}
          title={m.explorerUrl ?? "No block explorer link for this chain yet"}
        >
          View on explorer
        </Btn>
      </div>
    </div>
  );
}

export interface TxDetailsProps extends TxDetailsContext {
  tx: ChainTx;
}

/**
 * The details for one row. Landscape mounts this in its right column;
 * portrait inside `TxDetailsSheet`. No hooks of its own, so a test can call
 * it and follow the explorer button to `openExternal`.
 */
export function TxDetails({ tx, ownAddress, pricesByTicker, zphStats }: TxDetailsProps) {
  const model = txDetailsModel(tx, { ownAddress, pricesByTicker, zphStats });
  return (
    <TxDetailsView
      tx={tx}
      model={model}
      onExplorer={() => {
        openTxInExplorer(tx);
      }}
    />
  );
}

/**
 * Portrait: the same details over the list. Closes on the backdrop, the ✕
 * button, or Escape.
 */
export function TxDetailsSheet({ onClose, ...props }: TxDetailsProps & { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 60,
        animation: "fade-in .15s ease",
      }}
    >
      <div
        role="dialog"
        aria-label="Transaction details"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 460,
          maxHeight: "88vh",
          overflowY: "auto",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderBottom: "none",
          padding: 18,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ ...mono, fontSize: 9, color: "var(--text-dim)", letterSpacing: 2, textTransform: "uppercase" }}>
            transaction
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-dim)",
              cursor: "pointer",
              ...mono,
              fontSize: 11,
              padding: "2px 8px",
            }}
          >
            ✕
          </button>
        </div>
        <TxDetails {...props} />
      </div>
    </div>
  );
}
