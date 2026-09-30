/**
 * What a NEAR Intents quote is bound to, and how long its deposit window is
 * (2026-09-29 send-safety audit, F3 and F4).
 *
 * # F3: a quote belongs to ONE request
 *
 * 1Click's deposit address is minted for the exact request that asked for it:
 * this origin asset, this amount, this recipient, this refund address. The
 * wallet used to keep only `resp.quote` and forget the request, so nothing
 * could tell an ETH quote from a BNB one. During the form's 500 ms debounce
 * the previous quote stayed on screen with `loading` false, so switching
 * ETH → BNB with the same "0.5" and clicking at once would have deposited
 * 0.5 BNB on BNB Smart Chain to the ETH swap's deposit address (EVM addresses
 * look the same on every chain; 1Click watches only Ethereum for that one).
 *
 * The quote now carries the request that produced it, and both the confirm
 * modal and `executeIntentsTrade` compare it with what is about to be signed.
 *
 * # F4: the deposit has to land before the deadline
 *
 * 1Click documents the response `deadline` as the "time when the deposit
 * address becomes inactive and funds may be lost". The request deadline was a
 * flat 10 minutes for every origin chain, the background refresh pauses while
 * the confirm modal is open, and nothing read the deadline again — while BTC's
 * own time estimate was 812 s and its deposit fee a fixed 5 sat/vB. The window
 * is now sized per origin chain, and a quote with too little of it left is
 * refused before signing.
 *
 * # The deposit mode (2026-09-30, XLM as a source)
 *
 * A Stellar quote is requested with `depositMode: "MEMO"`, and its deposit
 * is told apart from every other Stellar deposit by the memo 1Click returns
 * (`intents-deposit-memo.ts`). The mode is part of what a quote is bound to:
 * a Stellar deposit signed against a quote that was not made in MEMO mode, or
 * a non-Stellar deposit against one that was, is refused like any other
 * mismatch. The memo itself is checked where it is attached
 * (`depositMemoToAttach`), against the quote the executor was handed.
 *
 * This module is types and pure functions only, so the hook, the modal and the
 * executor can share it without loading the registry.
 */
import type { SwapChainKind } from "./asset-capabilities";
import type { IntentsDepositMode } from "../../lib/proxy-types";
import { intentsDepositModeFor } from "./intents-deposit-memo";

/** The fields of a 1Click quote request that decide where money goes. */
export interface IntentsQuoteRequestEcho {
  originAsset: string;
  destinationAsset: string;
  /** Atomic units of the origin asset, as a decimal string. */
  amount: string;
  recipient: string;
  refundTo: string;
  /** ISO 8601, as sent. */
  deadline?: string;
  /** `"MEMO"` when the request asked for a memo deposit (Stellar); absent
   *  otherwise, which 1Click reads as SIMPLE (2026-09-30). */
  depositMode?: IntentsDepositMode;
}

/**
 * The form state a quote must still match when it is signed. Everything the
 * user can change that the request depends on.
 */
export interface IntentsQuoteExpectation {
  /** `nearIntentsAsset` of the asset the executor will actually send. */
  originAsset: string | null | undefined;
  /** `nearIntentsAsset` of the asset the confirm screen says arrives. */
  destinationAsset: string | null | undefined;
  /** The user's amount, converted with the SOURCE asset's decimals. */
  amountAtomic: bigint;
  /** Where the confirm screen says the output goes. */
  recipient: string;
  /** The wallet address the deposit is sent from (refunds return here). */
  refundTo: string;
}

/**
 * Thrown when a quote no longer matches the form. Not a wallet bug — the form
 * moved on (or the quote was fetched for other inputs) — so an ordinary
 * refusal, decided before anything is signed.
 */
export class IntentsQuoteMismatchError extends Error {
  readonly name = "IntentsQuoteMismatchError";
  readonly mismatches: string[];
  constructor(mismatches: string[]) {
    super(
      `This quote was made for a different swap than the one on screen ` +
        `(${mismatches.join("; ")}). Nothing was signed. Close this window and ` +
        `let the form fetch a quote for what it shows now.`,
    );
    this.mismatches = mismatches;
    Object.setPrototypeOf(this, IntentsQuoteMismatchError.prototype);
  }
}

/**
 * Address equality across the formats a quote carries. 0x-hex (EVM, Sui) is
 * compared case-insensitively — checksum casing is display only — and a
 * `bitcoincash:` prefix is optional on either side. Everything else (base58,
 * bech32, NEAR account ids, TRON, XRP) must match exactly.
 */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => {
    const t = s.trim();
    if (/^0x[0-9a-fA-F]+$/.test(t)) return t.toLowerCase();
    // CashAddr is lowercase by construction; only the optional prefix
    // differs between writers. A bare string is compared as written — never
    // case-folded, because base58 addresses are case-sensitive.
    if (/^bitcoincash:/i.test(t)) return t.slice("bitcoincash:".length).toLowerCase();
    return t;
  };
  return norm(a) === norm(b);
}

function atomicEquals(sent: string, expected: bigint): boolean {
  if (!/^\d+$/.test(sent.trim())) return false;
  try {
    return BigInt(sent.trim()) === expected;
  } catch {
    return false;
  }
}

/** Every way `sent` differs from `expected`, in words; empty when bound. */
export function quoteBindingMismatches(
  sent: IntentsQuoteRequestEcho,
  expected: IntentsQuoteExpectation,
): string[] {
  const out: string[] = [];
  if (!expected.originAsset || sent.originAsset !== expected.originAsset) {
    out.push(`quoted from ${sent.originAsset}, sending ${expected.originAsset ?? "(no asset id)"}`);
  }
  if (!expected.destinationAsset || sent.destinationAsset !== expected.destinationAsset) {
    out.push(
      `quoted into ${sent.destinationAsset}, confirming ${expected.destinationAsset ?? "(no asset id)"}`,
    );
  }
  if (!atomicEquals(sent.amount, expected.amountAtomic)) {
    out.push(`quoted amount ${sent.amount}, form amount ${expected.amountAtomic}`);
  }
  if (!sameAddress(sent.recipient, expected.recipient)) {
    out.push(`quoted recipient ${sent.recipient}, confirming ${expected.recipient}`);
  }
  if (!sameAddress(sent.refundTo, expected.refundTo)) {
    out.push(`quoted refund address ${sent.refundTo}, sending from ${expected.refundTo}`);
  }
  // The deposit mode the ORIGIN needs (2026-09-30): MEMO for a Stellar asset,
  // SIMPLE for everything else. Derived from the asset about to be sent, so
  // no caller can forget to state it.
  const needs = intentsDepositModeFor(expected.originAsset) ?? "SIMPLE";
  const quotedIn = sent.depositMode ?? "SIMPLE";
  if (quotedIn !== needs) {
    out.push(`quoted in ${quotedIn} deposit mode, and this deposit needs ${needs}`);
  }
  return out;
}

/** Throws `IntentsQuoteMismatchError` unless `sent` matches `expected`. */
export function assertQuoteBinding(
  sent: IntentsQuoteRequestEcho | null | undefined,
  expected: IntentsQuoteExpectation,
): void {
  if (!sent) {
    throw new IntentsQuoteMismatchError([
      "the quote does not say which request it answers",
    ]);
  }
  const m = quoteBindingMismatches(sent, expected);
  if (m.length > 0) throw new IntentsQuoteMismatchError(m);
}

/**
 * Differences between the request we SENT and the one 1Click says it
 * answered (`quoteRequest` in the response). Only fields present in the echo
 * are compared: the relay may drop it, and an absent echo is not evidence.
 */
export function echoMismatches(
  sent: IntentsQuoteRequestEcho,
  echo: Partial<IntentsQuoteRequestEcho> | null | undefined,
): string[] {
  if (!echo) return [];
  const out: string[] = [];
  if (echo.originAsset !== undefined && echo.originAsset !== sent.originAsset) {
    out.push(`originAsset ${echo.originAsset} ≠ sent ${sent.originAsset}`);
  }
  if (echo.destinationAsset !== undefined && echo.destinationAsset !== sent.destinationAsset) {
    out.push(`destinationAsset ${echo.destinationAsset} ≠ sent ${sent.destinationAsset}`);
  }
  if (echo.amount !== undefined && String(echo.amount).trim() !== sent.amount.trim()) {
    out.push(`amount ${echo.amount} ≠ sent ${sent.amount}`);
  }
  if (echo.recipient !== undefined && !sameAddress(echo.recipient, sent.recipient)) {
    out.push(`recipient ${echo.recipient} ≠ sent ${sent.recipient}`);
  }
  if (echo.refundTo !== undefined && !sameAddress(echo.refundTo, sent.refundTo)) {
    out.push(`refundTo ${echo.refundTo} ≠ sent ${sent.refundTo}`);
  }
  // 2026-09-30: an echo that names a mode must name the one we sent (absent
  // means SIMPLE on both sides — 1Click's default).
  if (echo.depositMode != null && echo.depositMode !== (sent.depositMode ?? "SIMPLE")) {
    out.push(`depositMode ${echo.depositMode} ≠ sent ${sent.depositMode ?? "SIMPLE"}`);
  }
  return out;
}

/**
 * Does a 1Click status response describe THIS memo deposit (2026-09-30)?
 *
 * A Stellar deposit address is shared, so its status is only meaningful for
 * the memo it was asked with. If the relay ever drops `depositMemo` from the
 * status query, 1Click is left with an address that many swaps share; a
 * status about another swap must not settle this one's history row.
 *
 * The echo read here is `quoteResponse.quote` — where the 1Click SDK's
 * `GetExecutionStatusResponse` type carries the quote a status is for. That
 * placement is taken from the SDK type, not from a live Stellar status
 * response (none has been captured yet), so the check only refuses a response
 * that echoes a DIFFERENT address or memo. One that echoes nothing is
 * accepted: an absent echo is not evidence, the same rule as `echoMismatches`.
 * Deposits without a memo are not checked at all, so no other chain's
 * polling changes.
 */
export function statusDescribesDeposit(
  resp: unknown,
  deposit: { depositAddress: string; depositMemo?: string | null },
): boolean {
  const memo = deposit.depositMemo;
  if (memo === undefined || memo === null || memo === "") return true;
  const quote = (resp as { quoteResponse?: { quote?: unknown } } | null)?.quoteResponse?.quote;
  if (!quote || typeof quote !== "object") return true;
  const q = quote as { depositAddress?: unknown; depositMemo?: unknown };
  if (
    typeof q.depositAddress === "string" &&
    !sameAddress(q.depositAddress, deposit.depositAddress)
  ) {
    return false;
  }
  if (q.depositMemo === undefined) return true;
  return q.depositMemo !== null && String(q.depositMemo) === memo;
}

// ───────────────────────────────────────────────────────────────────────────
// F4: deposit windows
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per origin chain: how long a quote's deadline is set for (`requestMinutes`)
 * and how much of it must still be left when the deposit is signed
 * (`landingMinutes`) — the time the deposit needs to confirm and be seen.
 *
 * 1Click's own guidance for the request deadline: "It must exceed the time
 * required for the deposit transaction to be mined. For example, Bitcoin may
 * require around one hour depending on the fees paid." The numbers below are
 * that guidance plus block times, not measurements; widen a row if a chain is
 * observed landing later. The difference between the two is how long a quote
 * can sit on the confirm screen before it is refused.
 */
export const INTENTS_DEPOSIT_WINDOWS: Record<
  "slowUtxo" | "utxo" | "cardano" | "account",
  { requestMinutes: number; landingMinutes: number }
> = {
  // BTC: 10-minute blocks; an hour is 1Click's own example for a deposit.
  slowUtxo: { requestMinutes: 120, landingMinutes: 60 },
  // LTC / DOGE / BCH / DASH: faster blocks, still confirmation-counted.
  utxo: { requestMinutes: 60, landingMinutes: 30 },
  // Cardano: ~20 s blocks, but the Koios submit path adds a hop.
  cardano: { requestMinutes: 45, landingMinutes: 15 },
  // Account chains (EVM, Solana, NEAR, XRP, Tron, Stellar, Sui): seconds to a
  // minute. A Stellar submit that goes unanswered is settled by hash within
  // its 180 s timebound plus a minute (`session-send.ts`), inside this margin.
  account: { requestMinutes: 30, landingMinutes: 10 },
};

export function depositWindowFor(
  chainKind: SwapChainKind | string | null | undefined,
): { requestMinutes: number; landingMinutes: number } {
  switch (chainKind) {
    case "BTC":
      return INTENTS_DEPOSIT_WINDOWS.slowUtxo;
    case "LTC":
    case "DOGE":
    case "BCH":
    case "DASH":
      return INTENTS_DEPOSIT_WINDOWS.utxo;
    case "CARDANO":
      return INTENTS_DEPOSIT_WINDOWS.cardano;
    default:
      return INTENTS_DEPOSIT_WINDOWS.account;
  }
}

/**
 * Thrown when a quote's deposit window is closed or too close to closing for
 * the origin chain. An ordinary refusal, before anything is signed.
 */
export class IntentsQuoteExpiredError extends Error {
  readonly name = "IntentsQuoteExpiredError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, IntentsQuoteExpiredError.prototype);
  }
}

/**
 * Minutes left before a deposit signed now would have too little time to
 * land. Negative when it already has. `null` when the deadline is missing or
 * unreadable — which callers must treat as closed.
 */
export function depositWindowMinutesLeft(args: {
  deadline: string | null | undefined;
  chainKind: SwapChainKind | string | null | undefined;
  nowMs: number;
}): number | null {
  if (!args.deadline) return null;
  const end = Date.parse(args.deadline);
  if (!Number.isFinite(end)) return null;
  const { landingMinutes } = depositWindowFor(args.chainKind);
  return (end - args.nowMs) / 60_000 - landingMinutes;
}

/**
 * Refuse to sign a deposit that could land after the quote's deadline.
 * Fails closed on a missing or unreadable deadline: a quote whose window
 * cannot be read is not one to send money into.
 */
export function assertDepositWindowOpen(args: {
  deadline: string | null | undefined;
  chainKind: SwapChainKind | string | null | undefined;
  nowMs: number;
  ticker: string;
}): void {
  const left = depositWindowMinutesLeft(args);
  const { landingMinutes } = depositWindowFor(args.chainKind);
  if (left === null) {
    throw new IntentsQuoteExpiredError(
      `This quote has no readable deposit deadline, so there is no way to know ` +
        `a ${args.ticker} deposit would land in time. Nothing was signed. Close ` +
        `this window and let the form fetch a new quote.`,
    );
  }
  if (left < 0) {
    const at = new Date(Date.parse(args.deadline!)).toLocaleTimeString();
    throw new IntentsQuoteExpiredError(
      `This quote's deposit window closes at ${at}, and a ${args.ticker} ` +
        `deposit needs about ${landingMinutes} minutes to land. Nothing was ` +
        `signed. Close this window and let the form fetch a new quote.`,
    );
  }
}
