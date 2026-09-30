/**
 * Deposit memos for NEAR Intents deposits (2026-09-30, XLM as a swap source).
 *
 * # Why this exists
 *
 * For most origin chains 1Click mints a deposit address per quote ("SIMPLE"
 * mode): whatever lands there is that swap's deposit. Stellar is the
 * exception ("MEMO" mode). Its deposit address is SHARED by every Stellar
 * depositor — `GDJ4JZXZ…QBJK` on the lead's live 100 XLM quote of 2026-09-30
 * — and 1Click tells one swap's deposit from another's only by the memo it
 * mints with the quote (`"188711688"` on that quote). A payment to the shared
 * address without that memo is nobody's deposit.
 *
 * So an XLM-source swap needs, end to end:
 *   - the quote requested with `depositMode: "MEMO"`. Without it 1Click
 *     answers HTTP 400 "Incorrect depositMode for originAsset from stellar
 *     chain" (checked by the lead, 2026-09-30);
 *   - the quote's `depositMemo` attached to the payment as MEMO_TEXT;
 *   - the memo on the deposit notify and on every status query;
 *   - one-attempt bookkeeping keyed by address AND memo — keyed by the
 *     shared address alone, the first XLM swap would block every later one
 *     (`intents-attempts.ts`).
 *
 * Why MEMO_TEXT and not MEMO_ID, although the memo is numeric: of 114 recent
 * payments into the shared address, 91 carried a text memo and 23 an ID memo,
 * and in 8 of the 10 cases where one memo arrived as BOTH types, the ID
 * payment came first and a text payment with the same memo followed 25-35 s
 * later. That reads (inference, from the ledger alone) as an ID memo not being
 * credited and its sender retrying as text.
 *
 * Pure rules only, so the quote hook, the confirm modal and the executor
 * share one copy without loading the asset registry.
 */
import { HOT_OMNI_CHAIN_TO_KEY } from "./near-intents-assets.generated";
import { lookupByAssetId } from "./intents-dedup";
import type { IntentsDepositMode } from "../../lib/proxy-types";

export type { IntentsDepositMode };

/** Stellar's MEMO_TEXT limit, in UTF-8 bytes (XDR `string text<28>`). */
export const STELLAR_MEMO_TEXT_MAX_BYTES = 28;

/** `nep245:v2_1.omni.hot.tg:<chainId>_<fingerprint>` — the HOT Omni envelope. */
const HOT_OMNI_ASSET = /^nep245:v2_1\.omni\.hot\.tg:(\d+)_/;

/**
 * The `depositMode` a quote for `originAsset` must be requested with:
 * `"MEMO"` for a Stellar-origin asset, `undefined` (= SIMPLE, sent as no field
 * at all) for everything else.
 *
 * Stellar is recognised by the shipped catalog's `blockchain`, and — for a
 * Stellar asset the catalog does not list yet — by the HOT Omni envelope's
 * chain id 1100, the same map the address resolver routes with.
 */
export function intentsDepositModeFor(
  originAsset: string | null | undefined,
): "MEMO" | undefined {
  if (!originAsset) return undefined;
  if (lookupByAssetId(originAsset)?.blockchain === "stellar") return "MEMO";
  const hot = HOT_OMNI_ASSET.exec(originAsset);
  if (hot && HOT_OMNI_CHAIN_TO_KEY[hot[1]] === "stellar") return "MEMO";
  return undefined;
}

/**
 * The `depositMode` field for a quote body whose origin is `originAsset`:
 * `{ depositMode: "MEMO" }` for a Stellar origin, `{}` for every other — so
 * spreading it into a body leaves non-Stellar bodies byte-identical. Every
 * body builder uses this one helper (the real quote, the minimum probes, the
 * route estimator's second hop): 1Click refuses a Stellar-origin quote, dry
 * or not, without the mode.
 */
export function depositModeField(originAsset: string | null | undefined): {
  depositMode?: "MEMO";
} {
  const depositMode = intentsDepositModeFor(originAsset);
  return depositMode ? { depositMode } : {};
}

/** True when a quote carries a deposit memo at all. `null` and `""` do not. */
export function quoteHasDepositMemo(raw: unknown): boolean {
  return raw !== undefined && raw !== null && raw !== "";
}

/**
 * The quote's deposit memo cannot be attached as given — refused before
 * anything is signed. An ordinary refusal: the fix is a new quote (or, for a
 * memo on a chain the wallet cannot attach one to, a wallet change), never a
 * retry of this one.
 */
export class IntentsDepositMemoError extends Error {
  readonly name = "IntentsDepositMemoError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, IntentsDepositMemoError.prototype);
  }
}

/**
 * The memo the deposit must carry, validated — or `undefined` for a chain
 * that takes none. Throws `IntentsDepositMemoError` when:
 *
 *  - a STELLAR deposit's quote has no usable memo (missing, not text, or
 *    blank). Sent without it, the payment lands at an address every Stellar
 *    depositor shares, credited to no swap;
 *  - the memo is longer than Stellar's 28-byte MEMO_TEXT. Truncating it would
 *    attach a DIFFERENT memo, which is worse than attaching none;
 *  - any OTHER chain's quote carries a memo (or was requested in MEMO mode).
 *    The wallet attaches memos only to Stellar deposits; deposited without
 *    it, the funds could not be matched to the swap. Refusing is what keeps
 *    a quiet upstream change (a chain moved to MEMO mode) from becoming a
 *    silent loss.
 *
 * The value returned is `depositMemo` itself, byte for byte: the memo that is
 * validated is the memo that is attached.
 */
export function depositMemoToAttach(args: {
  /** The mode the quote was REQUESTED with (`undefined` = SIMPLE). */
  depositMode: IntentsDepositMode | undefined;
  /** `quote.depositMemo`, as 1Click returned it. */
  depositMemo: unknown;
  chainKind: string;
  ticker: string;
}): string | undefined {
  const { depositMemo: raw, ticker } = args;
  if (args.chainKind !== "STELLAR") {
    if (quoteHasDepositMemo(raw) || args.depositMode === "MEMO") {
      throw new IntentsDepositMemoError(
        `This ${ticker} quote asks for a deposit memo` +
          (quoteHasDepositMemo(raw) ? ` (${String(raw)})` : "") +
          `, and the wallet can attach one only to a Stellar deposit. Sent without ` +
          `it, the deposit could not be matched to this swap. Nothing was signed.`,
      );
    }
    return undefined;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new IntentsDepositMemoError(
      `This ${ticker} quote has no deposit memo. Every Stellar deposit to NEAR ` +
        `Intents goes to one shared address and is matched to its swap by the ` +
        `memo, so a deposit without it would be credited to no swap. Nothing ` +
        `was signed. Close this window and let the form fetch a new quote.`,
    );
  }
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > STELLAR_MEMO_TEXT_MAX_BYTES) {
    throw new IntentsDepositMemoError(
      `This ${ticker} quote's deposit memo is ${bytes} bytes long, and a Stellar ` +
        `text memo holds ${STELLAR_MEMO_TEXT_MAX_BYTES}. It cannot be attached as ` +
        `given, and a shortened memo would name a different deposit. Nothing was ` +
        `signed.`,
    );
  }
  return raw;
}

// ───────────────────────────────────────────────────────────────────────────
// The wallet proxy and depositMode
// ───────────────────────────────────────────────────────────────────────────

/**
 * The wallet proxy stands between the app and 1Click, and is run by another
 * agent on another machine. Its published contract (IntegrationPlanV2.md,
 * `IntentsQuoteRequest`, `additionalProperties: false`) does not list
 * `depositMode`, and nobody on this side can tell whether the live proxy
 * forwards it. Either failure is possible:
 *
 *  - the proxy validates strictly and REFUSES the unknown field (a 400 naming
 *    `depositMode`, "additional properties", "unknown field", …);
 *  - the proxy strips the field and forwards the rest, and 1Click refuses the
 *    Stellar quote: "Incorrect depositMode for originAsset from stellar
 *    chain".
 *
 * Both mean the same thing to the user — XLM cannot be quoted through this
 * server yet — and neither is about the pair or the amount.
 */
export const PROXY_MEMO_UNSUPPORTED_MESSAGE =
  "XLM swaps need the wallet proxy to accept depositMode/memo — the swap server " +
  "refused or dropped the depositMode: MEMO that every Stellar deposit to NEAR " +
  "Intents requires, so it cannot quote an XLM swap yet. This needs a server " +
  "update; it is not a wallet or amount problem. No quote was made and nothing " +
  "was sent.";

/** The proxy (or 1Click behind it) refused a MEMO-mode quote over `depositMode`. */
export class IntentsProxyMemoUnsupportedError extends Error {
  readonly name = "IntentsProxyMemoUnsupportedError";
  /** The server's own words, when it gave any. */
  readonly serverSaid: string | null;
  constructor(serverSaid: string | null) {
    super(
      serverSaid
        ? `${PROXY_MEMO_UNSUPPORTED_MESSAGE} (Server said: "${serverSaid}")`
        : PROXY_MEMO_UNSUPPORTED_MESSAGE,
    );
    this.serverSaid = serverSaid;
    Object.setPrototypeOf(this, IntentsProxyMemoUnsupportedError.prototype);
  }
}

/**
 * Wordings that say "this field is not accepted", across the validators a
 * proxy is likely built on (Ajv/Fastify, zod, Joi, Go's `encoding/json`,
 * pydantic), plus 1Click's own refusal of a Stellar quote without the mode.
 * Matched only for a MEMO-mode request, so no other chain's error is ever
 * rewritten.
 */
const DEPOSIT_MODE_REFUSAL =
  /depositMode|deposit_mode|additional propert|unknown field|unrecognized key|extra (inputs|fields)/i;

/** The server's sentence out of a `proxy returned NNN: {…}` envelope. */
function serverSentence(msg: string): string | null {
  const body = msg.replace(/^[\s\S]*?proxy returned \d{3}:\s*/, "");
  try {
    const v = JSON.parse(body) as Record<string, unknown>;
    for (const k of ["upstreamMessage", "message", "error"]) {
      const s = v?.[k];
      if (typeof s === "string" && s.trim()) return s.trim().slice(0, 160);
    }
  } catch {
    /* not JSON — fall through */
  }
  return null;
}

/**
 * For a MEMO-mode quote request, the proxy-specific error that replaces a
 * refusal over `depositMode`; `null` for any other error or request.
 */
export function proxyMemoRefusal(
  error: unknown,
  request: { depositMode?: string | null },
): IntentsProxyMemoUnsupportedError | null {
  if (request.depositMode !== "MEMO") return null;
  const msg = String((error as { message?: unknown })?.message ?? error);
  if (!DEPOSIT_MODE_REFUSAL.test(msg)) return null;
  return new IntentsProxyMemoUnsupportedError(serverSentence(msg));
}
