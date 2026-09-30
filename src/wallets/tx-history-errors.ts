/**
 * "This wallet cannot read history for this chain yet" — which is NOT a
 * failure, and must never render as one or as "no transactions".
 *
 * # Why this exists (operator report, 2026-09-30)
 *
 * The landscape Activity header read
 * `· errors on ETH, USDT, USDT, USDC, … , MON, NEAR`. Two of those chains had
 * no history source at all:
 *
 *  - NEAR's adapter threw a plain `Error("NEAR transaction history is not
 *    available…")` (2026-09-29), so `useTxHistory` counted it as a failed
 *    fetch, polled it with back-off, and the header listed it as an error.
 *  - BNB Smart Chain's explorer (Routescan, chain 56) answers HTTP 200
 *    `{"status":"0","message":"chain not supported","result":null}`, which
 *    the EVM adapter read as an empty list, so BSC said "no transactions"
 *    instead of either.
 *
 * An adapter with no working source throws `HistoryUnavailableError`. Its
 * message is a fixed sentence (`history not available for <chain> yet`) so it
 * survives being stored as the hook's per-pair error STRING — every history
 * surface already renders that string instead of "no transactions" — and the
 * Activity header can tell it apart from a real failure
 * (`isHistoryUnavailableMessage`) and list it separately, in a neutral tone.
 */

/** The fixed start of every unavailable-history message. */
export const HISTORY_UNAVAILABLE_PREFIX = "history not available for ";

export class HistoryUnavailableError extends Error {
  /** The chain's display name, as the message names it. */
  readonly chainName: string;
  constructor(chainName: string, detail?: string) {
    super(`${HISTORY_UNAVAILABLE_PREFIX}${chainName} yet${detail ? ` (${detail})` : ""}`);
    this.name = "HistoryUnavailableError";
    this.chainName = chainName;
  }
}

/** True for a thrown `HistoryUnavailableError` (by class or, across realms, by name). */
export function isHistoryUnavailable(e: unknown): e is HistoryUnavailableError {
  return (
    e instanceof HistoryUnavailableError ||
    (e instanceof Error && e.name === "HistoryUnavailableError")
  );
}

/**
 * True when a stored per-pair error string is an unavailable-history
 * message rather than a failure. `useTxHistory` keeps errors as strings, so
 * this is how a view recognises one after the error object is gone.
 */
export function isHistoryUnavailableMessage(msg: string | null | undefined): boolean {
  return typeof msg === "string" && msg.startsWith(HISTORY_UNAVAILABLE_PREFIX);
}

/** The host of an http(s) URL, or the input when it is not one. */
export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1] : url;
}

/**
 * One source's failure, short enough to show. `proxyGetJson` throws
 * `HTTP 429 from <full url>: <body>`; this keeps the status and the source's
 * own message (Blockscout's "Too many requests…", an Etherscan-style
 * `result` string) and drops the URL — the caller names the host — and any
 * HTML page. Anything else keeps its first line.
 */
export function condenseHttpError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^HTTP (\d{3}) from \S+?(?:: ([\s\S]*))?$/.exec(msg);
  if (!m) return msg.split("\n", 1)[0].slice(0, 200);
  const body = (m[2] ?? "").trim();
  let why = "";
  try {
    const j = JSON.parse(body);
    // `Error` (capitalised) is TronGrid's field.
    why = [j?.message, typeof j?.result === "string" ? j.result : undefined, j?.error, j?.Error]
      .filter((x) => typeof x === "string" && x)
      .join(": ");
  } catch {
    why = /^\s*</.test(body) ? "" : body;
  }
  why = why.replace(/\s+/g, " ").trim().slice(0, 140);
  return `HTTP ${m[1]}${why ? ` (${why})` : ""}`;
}
