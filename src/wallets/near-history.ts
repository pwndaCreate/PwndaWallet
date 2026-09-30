/**
 * NEAR history from NearBlocks' public API (operator report, 2026-09-30).
 *
 * # Why this exists
 *
 * NEAR's public RPC has no per-account history, so until now the adapter
 * threw "NEAR transaction history is not available in this wallet yet…" —
 * which `useTxHistory` recorded as a failed fetch and the Activity header
 * listed as an error. NearBlocks answers keyless, with
 * `access-control-allow-origin: *` (read 2026-09-30 for the test seed's
 * implicit account 5510e2b4…ee412: HTTP 200, 25 rows, no rate-limit headers).
 *
 * The RECEIPT list (`/v1/account/<id>/txns`) is read, not the transaction
 * list (`/txns-only`). A NEAR payment to this account can be a receipt of a
 * transaction someone else signed — every NEAR Intents withdrawal is
 * `intents.near → <account>` inside a relayer's transaction — and the
 * transaction list does not contain those: for the test account it listed
 * none of the two `intents.near` transfers the receipt list shows.
 * Gas-refund receipts (`system → <account>`) are dropped; they are not
 * payments.
 *
 * NearBlocks is fetched directly from the webview: `nearblocks.io` is not
 * on the backend proxy's allowlist (`http_proxy.rs`), and adding it there is
 * a Rust change. (TRON history, once fetched the same way, goes through the
 * proxy now — `trx-wallet.ts`.) The request carries only the public
 * account ID.
 *
 * Amounts: NearBlocks serialises `deposit` as a JSON NUMBER (`8.4768049e+23`
 * yoctoNEAR), so precision past ~16 significant digits is already gone when
 * the response arrives. `yoctoFromJson` reads the number's shortest decimal
 * form exactly (no float arithmetic), and such a row is marked
 * `meta.amountApprox` so the details view can say so.
 */
import type { ChainTx, TxHistoryPage } from "./types";
import { atomicToDecimal } from "./decimal-amount";
import { dedupeTxRows } from "./tx-row-key";

export const NEARBLOCKS_API = "https://api.nearblocks.io";
export const NEARBLOCKS_HOST = "api.nearblocks.io";
const NEAR_DECIMALS = 24;

/** Per-request timeout. Mutable for tests only. */
export const NEAR_HISTORY_TIMEOUT = { ms: 15_000 };

/**
 * A yoctoNEAR amount from NearBlocks: a digit string, or a JSON number read
 * through its shortest round-trip decimal (`String(8.4768049e+23)`), never
 * through float arithmetic. `null` for anything else.
 */
export function yoctoFromJson(v: unknown): { yocto: bigint; approx: boolean } | null {
  if (typeof v === "string" && /^\d+$/.test(v)) return { yocto: BigInt(v), approx: false };
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const m = /^(\d+)(?:\.(\d+))?(?:e\+?(\d+))?$/i.exec(String(v));
  if (!m) return null; // negative exponents: amounts below 1 yocto do not exist
  const intPart = m[1];
  const frac = m[2] ?? "";
  const exp = Number(m[3] ?? "0");
  const digits = intPart + frac;
  const shift = exp - frac.length;
  const yocto = shift >= 0 ? BigInt(digits) * 10n ** BigInt(shift) : BigInt(digits.slice(0, digits.length + shift) || "0");
  return { yocto, approx: !Number.isSafeInteger(v) };
}

function nsToSeconds(v: unknown): number | undefined {
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(BigInt(v) / 1_000_000_000n);
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v / 1e9);
  return undefined;
}

function heightOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

/**
 * One NearBlocks receipt as a `ChainTx`, or null for a receipt that is not a
 * payment to or from `me` (a gas refund, or one that does not touch `me`).
 * Exported for tests.
 */
export function nearblocksReceiptRow(raw: unknown, me: string): ChainTx | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const hash = typeof r.transaction_hash === "string" ? r.transaction_hash : "";
  if (!hash) return null;
  const from = String(r.predecessor_account_id ?? "");
  const to = String(r.receiver_account_id ?? "");
  if (from === "system") return null; // gas refund
  if (from !== me && to !== me) return null;
  const intended = from === me && to === me ? "self" : from === me ? "out" : "in";

  let yocto = 0n;
  let approx = false;
  const methods: string[] = [];
  for (const a of Array.isArray(r.actions) ? r.actions : []) {
    if (a?.action === "TRANSFER" || a?.action === "FUNCTION_CALL") {
      const d = yoctoFromJson(a.deposit ?? 0);
      if (d) {
        yocto += d.yocto;
        approx ||= d.approx;
      }
    }
    if (typeof a?.method === "string" && a.method) methods.push(a.method);
  }
  const ok = r.receipt_outcome?.status !== false && r.outcomes?.status !== false;
  // The transaction fee is the signer's. Shown only on this wallet's own
  // outgoing receipt; an `intents.near → me` withdrawal's fee was a relayer's.
  const fee = intended !== "in" ? yoctoFromJson(r.outcomes_agg?.transaction_fee) : null;
  return {
    chain: "near",
    hash,
    direction: ok ? intended : "failed",
    amount: atomicToDecimal(yocto, NEAR_DECIMALS),
    fee: fee ? atomicToDecimal(fee.yocto, NEAR_DECIMALS) : undefined,
    timestamp: nsToSeconds(r.block_timestamp) ?? nsToSeconds(r.receipt_block?.block_timestamp),
    // Indexed data is final. No count is given; the height says "in a block".
    height: heightOf(r.block?.block_height) ?? heightOf(r.receipt_block?.block_height),
    counterparty: intended === "in" ? from : to,
    meta: {
      from,
      to,
      intended,
      ...(typeof r.receipt_id === "string" ? { receiptId: r.receipt_id } : {}),
      ...(methods.length ? { method: methods.join(", ") } : {}),
      ...(approx ? { amountApprox: true } : {}),
      ...(ok ? {} : { failure: "receipt failed" }),
      source: NEARBLOCKS_HOST,
    },
  };
}

export async function fetchNearHistory(
  account: string,
  opts: { limit?: number; cursor?: string } | undefined,
): Promise<TxHistoryPage> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 25, 100));
  const cursor = opts?.cursor && /^\d+$/.test(opts.cursor) ? `&cursor=${opts.cursor}` : "";
  const url = `${NEARBLOCKS_API}/v1/account/${encodeURIComponent(account)}/txns?per_page=${limit}&order=desc${cursor}`;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), NEAR_HISTORY_TIMEOUT.ms) : null;
  let body: unknown;
  try {
    const resp = await fetch(url, { signal: ctl?.signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 200)}`);
    }
    body = await resp.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
  const txns = (body as { txns?: unknown } | null)?.txns;
  if (!Array.isArray(txns)) throw new Error("NEAR history: unexpected response from NearBlocks");
  const items = txns
    .map((t) => nearblocksReceiptRow(t, account))
    .filter((x): x is ChainTx => x !== null);
  const next = (body as { cursor?: unknown }).cursor;
  return {
    items: dedupeTxRows(items),
    cursor: txns.length >= limit && (typeof next === "string" || typeof next === "number") ? String(next) : undefined,
  };
}
