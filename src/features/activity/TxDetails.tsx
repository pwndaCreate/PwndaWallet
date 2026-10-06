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
import { coinMarkFor } from "../../wallets/stablecoins";
import type { ZphLiveStats } from "../../wallets/zph-scanner-api";
import { fmtRelative } from "../../utils/format";
import { openExternal } from "../../utils/openExternal";
import { ModalBackdrop } from "../../components/ModalBackdrop";
import { SpeedUpPanel } from "../../components/SpeedUpPanel";
import { useTxParties, type TxPartiesState } from "../../lib/txParties";
import { secretOf, speedUpCandidate } from "../../lib/btcSpeedUp";
import { useAppStateOptional } from "../../state/AppStateContext";

/** Confirmations at which a counted row reads "confirmed" (display only). */
export const CONFIRMED_AT = 6;

export interface TxDetailsContext {
  /** The wallet's address on this chain, so "you" can be marked. */
  ownAddress?: string;
  /** Every address the wallet holds on this chain (a UTXO account has
   *  change addresses besides the displayed one). All are "you". */
  ownAddresses?: ReadonlyArray<string>;
  pricesByTicker?: Record<string, number>;
  /** Zephyr oracle prices for ZEPHUSD / ZEPHRSV / ZEPHYRS rows. */
  zphStats?: ZphLiveStats | null;
  /** What the chain said when asked for this transaction's parties
   *  (`useTxParties`); absent when nobody asked. */
  parties?: TxPartiesState;
}

export type Tone = "in" | "out" | "failed" | "pending" | "neutral";

export interface TxParty {
  address: string;
  you: boolean;
  /** The wallet's own output on a send that also paid someone else. */
  change?: boolean;
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
  /** Every address the value came from / went to, the wallet's marked. */
  from: TxParty[];
  to: TxParty[];
  /** Why a side is empty: hidden by the protocol, still being read, … */
  fromNote: string | null;
  toNote: string | null;
  /** The row leaves a side (or, for SPL, the direction or amount) unsaid,
   *  so the details should ask the chain (`getTransactionParties`). */
  needsParties: boolean;
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

/** A UTXO row's `meta.inputs` / `meta.outputs`: addresses, "" for none. */
function metaAddresses(tx: ChainTx, key: "inputs" | "outputs"): string[] {
  const v = tx.meta?.[key];
  return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string" && a !== "") : [];
}

function metaString(tx: ChainTx, key: string): string | undefined {
  const v = tx.meta?.[key];
  return typeof v === "string" && v ? v : undefined;
}

/** A row's `meta[key]` as a list of addresses: a string or a string array. */
function metaList(tx: ChainTx, key: "from" | "to"): string[] {
  const v = tx.meta?.[key];
  if (typeof v === "string") return v ? [v] : [];
  return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string" && a !== "") : [];
}

function uniqAddresses(list: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const a of list) if (!out.some((b) => sameAddress(a, b))) out.push(a);
  return out;
}

/** Chains whose protocol hides who sent a transaction: an empty sender is
 *  the answer there, not a failed read. */
const SENDER_HIDDEN_CHAINS: ReadonlySet<string> = new Set(["monero", "zephyr", "zano"]);

/** The wallet's side of a row. A failed or mempool row keeps the way it was
 *  meant to go in `meta.intended` / `meta.netDirection`. */
function sideOf(tx: ChainTx): "in" | "out" | "self" | "unknown" {
  const d = tx.direction;
  if (d === "in" || d === "out" || d === "self") return d;
  const hint = metaString(tx, "intended") ?? metaString(tx, "netDirection");
  if (hint === "in" || hint === "out" || hint === "self") return hint;
  return "unknown";
}

/**
 * The row, with what the chain said filled in where the row could not say:
 * an SPL row's direction and amount, a fee. Never overrides a value the row
 * has.
 */
export function withPartiesFill(tx: ChainTx, parties?: TxPartiesState): ChainTx {
  if (parties?.status !== "done" || !parties.parties) return tx;
  const p = parties.parties;
  // `pending` with a block is an adapter that did not read the direction.
  const unsettled = tx.direction === "pending" && !!tx.height;
  return {
    ...tx,
    direction: unsettled && p.direction ? p.direction : tx.direction,
    amount: tx.amount ? tx.amount : (p.amount ?? tx.amount),
    fee: tx.fee ?? p.fee,
  };
}

export interface TxSides {
  from: TxParty[];
  to: TxParty[];
  fromNote: string | null;
  toNote: string | null;
  needsParties: boolean;
}

/**
 * Who sent the transaction and who received it (2026-09-30, operator
 * request: "which address each transaction was sent and received from").
 *
 *  - Every address the row lists: `meta.from` / `meta.to` (account chains),
 *    `meta.inputs` / `meta.outputs` (UTXO: every input and output, change
 *    included, the wallet's own marked).
 *  - Otherwise derived from the direction: a receipt came from the
 *    counterparty to this wallet; a send went from this wallet to it.
 *  - A side still empty is filled from what the chain said when asked
 *    (`ctx.parties`), and otherwise carries a note saying why it is blank.
 *  - A sender the protocol hides but the transaction names anyway (Zano's
 *    `tx_payer`: `senderHidden` with addresses) is listed, its note saying
 *    the sender attached it itself (2026-10-01).
 */
export function txSides(
  tx: ChainTx,
  ctx: {
    own?: string;
    isOwn: (a: string | undefined) => boolean;
    parties?: TxPartiesState;
    chainName: string;
  },
): TxSides {
  const side = sideOf(tx);
  const listedFrom = uniqAddresses([...metaList(tx, "from"), ...metaAddresses(tx, "inputs")]);
  const listedTo = uniqAddresses([...metaList(tx, "to"), ...metaAddresses(tx, "outputs")]);
  let from = listedFrom;
  let to = listedTo;
  if (!from.length) {
    if (side === "in") from = tx.counterparty ? [tx.counterparty] : [];
    else if (side !== "unknown" && ctx.own) from = [ctx.own];
  }
  if (!to.length) {
    if (side === "in" || side === "self") to = ctx.own ? [ctx.own] : [];
    else if (side === "out" && tx.counterparty) to = [tx.counterparty];
  }

  const hiddenIn = SENDER_HIDDEN_CHAINS.has(tx.chain) && side === "in";
  // A UTXO row with no input/output lists (BlockCypher, older cache) only
  // guessed the wallet's side as the displayed address: ask the chain.
  const utxoGuess =
    !!getAdapter(tx.chain)?.utxoAccounts && (!listedFrom.length || !listedTo.length);
  const needsParties =
    (from.length === 0 && !hiddenIn) || to.length === 0 || side === "unknown" || !tx.amount || utxoGuess;

  const asked = ctx.parties;
  const p = asked?.status === "done" ? asked.parties : null;
  // The chain hides the sender, yet named one: what the sender attached
  // about itself (Zano's `tx_payer`), which nothing checks. Listed, and the
  // side's note says it is a claim (operator request, 2026-10-01). The row
  // leaves it out for that reason, and the details named it as the sender,
  // so the two disagreed about who sent a receipt.
  let claimedSender = false;
  if (p) {
    if (!listedFrom.length && p.from.length) {
      from = uniqAddresses(p.from);
      claimedSender = p.senderHidden === true;
    }
    if (!listedTo.length && p.to.length) to = uniqAddresses(p.to);
  }

  const hidden = hiddenIn || p?.senderHidden === true;
  const noteFor = (what: "sender" | "recipient"): string => {
    if (what === "sender" && hidden) {
      return `Hidden: ${ctx.chainName} does not reveal who sent a transaction.`;
    }
    if (asked?.status === "loading") return `Reading the ${what} from ${ctx.chainName}…`;
    if (asked?.status === "error") return `Could not read the ${what}: ${asked.message}`;
    if (asked?.status === "done" && !asked.parties) {
      return `${ctx.chainName} does not show this transaction yet.`;
    }
    return `This chain's history does not name the ${what}. The explorer shows it.`;
  };
  // On a send that also paid someone else, the wallet's own outputs are change.
  const paidOthers = side === "out" && to.some((a) => !ctx.isOwn(a));
  const mark = (a: string, change: boolean): TxParty => ({
    address: a,
    you: ctx.isOwn(a),
    ...(change ? { change: true } : {}),
  });
  return {
    from: from.map((a) => mark(a, false)),
    to: to.map((a) => mark(a, paidOthers && ctx.isOwn(a))),
    fromNote: from.length
      ? claimedSender
        ? `The sender attached this address itself. ${ctx.chainName} does not check it.`
        : null
      : noteFor("sender"),
    toNote: to.length ? null : noteFor("recipient"),
    needsParties,
  };
}

/**
 * Everything the details view shows, derived from one row. Pure: no React,
 * no I/O — the component renders exactly this, and tests read it directly.
 */
export function txDetailsModel(row: ChainTx, ctx: TxDetailsContext = {}): TxDetailsModel {
  const tx = withPartiesFill(row, ctx.parties);
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
  // A row may also name the wallet's own identity on its chain when that is
  // not the displayed address: a Hedera row's account id (`0.0.x`), while the
  // wallet's address is its public key (2026-10-01). It is "you" too.
  const owned = [own, ...(ctx.ownAddresses ?? []), metaString(tx, "ownAccountId")].filter(
    (a): a is string => !!a,
  );
  const isOwn = (a: string | undefined) => owned.some((o) => sameAddress(a, o));
  const sides = txSides(tx, {
    own,
    isOwn,
    parties: ctx.parties,
    chainName: adapter?.displayName ?? tx.chain,
  });

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
    from: sides.from,
    to: sides.to,
    fromNote: sides.fromNote,
    toNote: sides.toNote,
    needsParties: sides.needsParties,
    time: tx.timestamp
      ? { absolute: new Date(tx.timestamp * 1000).toLocaleString(), relative: fmtRelative(tx.timestamp) }
      : null,
    block: tx.height ? tx.height.toLocaleString("en-US") : null,
    method: metaString(tx, "method") ?? null,
    source:
      metaString(tx, "source") ??
      (ctx.parties?.status === "done" ? ctx.parties.parties?.source : undefined) ??
      null,
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

/** Long value (a hash): label above, the whole value wrapped below. */
function LongRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Label>{k}</Label>
      <span className="tnum" style={{ ...mono, fontSize: 10, color: "var(--text)", wordBreak: "break-all", lineHeight: 1.45 }}>
        {v}
      </span>
    </div>
  );
}

/** Addresses shown per side before "+N more" (a consolidation can have
 *  dozens of inputs; the explorer lists them all). */
const ADDRESS_LIST_MAX = 8;

/** Every address of one side, each on its own line, the wallet's marked. */
function AddressList({ k, parties, note }: { k: string; parties: TxParty[]; note: string | null }) {
  const shown = parties.slice(0, ADDRESS_LIST_MAX);
  const more = parties.length - shown.length;
  return (
    <div data-tx-side={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Label>
        {k}
        {parties.length > 1 ? ` (${parties.length})` : ""}
      </Label>
      {shown.map((p) => (
        <span
          key={p.address}
          className="tnum"
          style={{ ...mono, fontSize: 10, color: "var(--text)", wordBreak: "break-all", lineHeight: 1.45 }}
        >
          {p.address}
          {p.you ? (
            <span style={{ color: "var(--accent)", marginLeft: 6, letterSpacing: 0.5 }}>
              {p.change ? "· you (change)" : "· you"}
            </span>
          ) : null}
        </span>
      ))}
      {more > 0 && (
        <span style={{ ...mono, fontSize: 9, color: "var(--text-dim)" }}>
          +{more} more; the explorer lists them all
        </span>
      )}
      {note && (
        <span style={{ ...mono, fontSize: 9, color: "var(--text-dim)", lineHeight: 1.5 }}>{note}</span>
      )}
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
  /** The "Speed up" panel for an unconfirmed BTC send (2026-10-01), above
   *  the buttons; built by `TxDetails`, absent everywhere else. */
  speedUp?: ReactNode;
}

/** The details, as elements. No hooks: tests call it and walk the tree. */
export function TxDetailsView({ tx, model: m, onExplorer, speedUp }: TxDetailsViewProps) {
  const toneColor = TONE_COLOR[m.tone];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* A USD₮0 row reads "USDT" and keeps the USD₮0 mark (2026-10-06). */}
        <CoinIcon sym={coinMarkFor(tx.chain, m.ticker)} size={42} accent={m.color} />
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
        <AddressList k="from" parties={m.from} note={m.fromNote} />
        <AddressList k="to" parties={m.to} note={m.toNote} />
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

      {speedUp}

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
 * The details for one row, as the row (and `parties`, when given) say. No
 * hooks, so a test can call it and follow the explorer button to
 * `openExternal`.
 */
export function TxDetailsStatic({ tx, speedUp, ...ctx }: TxDetailsProps & { speedUp?: ReactNode }) {
  const model = txDetailsModel(tx, ctx);
  return (
    <TxDetailsView
      tx={tx}
      model={model}
      speedUp={speedUp}
      onExplorer={() => {
        openTxInExplorer(tx);
      }}
    />
  );
}

/**
 * The details for one row. Landscape mounts this in its right column;
 * portrait inside `TxDetailsSheet`. When the row does not name both sides
 * (or, for SPL, which way it went), it asks the chain once, by hash
 * (`useTxParties`, 2026-09-30).
 *
 * An unconfirmed BTC send gets the shared "Speed up" panel (operator request,
 * 2026-10-01; `components/SpeedUpPanel.tsx`), signed with the open wallet's
 * Bitcoin entry. The panel itself reads whether the transaction can be
 * replaced and shows nothing when it cannot.
 */
export function TxDetails(props: TxDetailsProps) {
  const { tx, ownAddress, ownAddresses } = props;
  const need = txDetailsModel(tx, { ownAddress, ownAddresses }).needsParties;
  const parties = useTxParties(tx.chain, tx.hash, ownAddress, need);
  const btcWallet = useAppStateOptional()?.walletsByChain.bitcoin ?? null;
  const speedUp =
    speedUpCandidate(tx) && secretOf(btcWallet) ? (
      <SpeedUpPanel
        key={tx.hash}
        txid={tx.hash}
        wallet={btcWallet}
        usdPrice={props.pricesByTicker?.BTC ?? null}
      />
    ) : null;
  return <TxDetailsStatic {...props} parties={parties} speedUp={speedUp} />;
}

/**
 * The same details over a list. Closes on the backdrop, the ✕ button, or
 * Escape. The backdrop is the shared `ModalBackdrop`, so moving the window
 * never closes it (the swap modals' 2026-09-30 fix).
 *
 * `placement`: "sheet", a bottom sheet over a portrait list (Activity, the
 * wallet's history page); "window", a centred window like the swap details,
 * for landscape's wallet tab, whose columns have no room for a details panel
 * (operator request, 2026-10-01).
 */
export function TxDetailsSheet({
  onClose,
  placement = "sheet",
  ...props
}: TxDetailsProps & { onClose: () => void; placement?: "sheet" | "window" }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const centred = placement === "window";
  return (
    <ModalBackdrop onClick={onClose} align={centred ? "center" : "end"}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Transaction details"
        data-tx-details={placement}
        style={
          centred
            ? {
                width: "min(460px, 92vw)",
                maxHeight: "90vh",
                overflowY: "auto",
                background: "var(--bg-2)",
                border: "1px solid var(--border-hi)",
                padding: 22,
                boxSizing: "border-box",
              }
            : {
                width: "100%",
                maxWidth: 460,
                maxHeight: "88vh",
                overflowY: "auto",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderBottom: "none",
                padding: 18,
                boxSizing: "border-box",
              }
        }
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span
            style={{
              ...mono,
              fontSize: centred ? 11 : 9,
              color: centred ? "var(--accent)" : "var(--text-dim)",
              letterSpacing: 2,
              textTransform: "uppercase",
            }}
          >
            {centred ? "transaction details" : "transaction"}
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
    </ModalBackdrop>
  );
}
