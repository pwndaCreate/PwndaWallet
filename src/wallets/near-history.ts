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
import type { ChainTx, ChainType, TxHistoryPage, TxParties } from "./types";
import { atomicToDecimal } from "./decimal-amount";
import { dedupeTxRows } from "./tx-row-key";
import { uniqueAddresses } from "./parties-b-common";

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

/**
 * One transaction from NearBlocks, WITH its receipts' parties, or `null`
 * when NearBlocks does not have it (yet): an unknown hash answers HTTP 200
 * `{"txns":[]}` (checked 2026-09-30). Throws on a failed request.
 *
 * `/v1/txns/<hash>/full`, not `/v1/txns/<hash>`: both are keyless on the host
 * the history already uses, but only `/full` names each receipt's
 * `predecessor_account_id` and `receiver_account_id` — the plain one lists
 * receipts as bare `{ fts, nfts }` (both read 2026-09-30 for BiuXnScW…).
 */
export async function fetchNearblocksTxn(hash: string): Promise<Record<string, unknown> | null> {
  const url = `${NEARBLOCKS_API}/v1/txns/${encodeURIComponent(hash)}/full`;
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
  if (!Array.isArray(txns)) throw new Error("NEAR transaction: unexpected response from NearBlocks");
  const txn = txns.find((t) => (t as { transaction_hash?: unknown })?.transaction_hash === hash) ?? txns[0];
  return txn && typeof txn === "object" ? (txn as Record<string, unknown>) : null;
}

// =========================================================================
// NEP-141 token history (2026-10-06, the USDT/USDC legs on NEAR)
// =========================================================================
//
// NearBlocks indexes every NEP-141 `ft_transfer` EVENT the token contract logs
// (NEP-297), per account: `/v1/account/<id>/ft-txns?contract=<token>`. Read
// live for the public test seed's account (5510e2b4…ee412) and for
// `intents.near` on 2026-10-06; each row is one balance change of the
// account:
//
//   { affected_account_id, involved_account_id, delta_amount: "-148600459",
//     cause: "TRANSFER" | "MINT" | "BURN", transaction_hash, block_timestamp
//     (ns, string), block: { block_height }, outcomes: { status },
//     outcomes_agg: { transaction_fee }, ft: { contract, symbol, decimals } }
//
// `delta_amount` is SIGNED: negative when the account paid, positive when it
// received (both signs seen on intents.near's USDT rows). An event is only
// logged by a transfer that executed, so these rows are never failures.

/** One NearBlocks FT event as a `ChainTx`, or null when it is not a row. Exported for tests. */
export function nearblocksFtRow(
  raw: unknown,
  me: string,
  token: { chain: ChainType; contract: string; decimals: number },
): ChainTx | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const hash = typeof r.transaction_hash === "string" ? r.transaction_hash : "";
  if (!hash) return null;
  // Another token's event (the filter is the API's; never trusted alone).
  if (r.ft?.contract !== undefined && r.ft?.contract !== token.contract) return null;
  if (r.affected_account_id !== undefined && r.affected_account_id !== me) return null;
  const delta = typeof r.delta_amount === "string" ? r.delta_amount.trim() : String(r.delta_amount ?? "");
  const m = /^(-)?(\d+)$/.exec(delta);
  if (!m || BigInt(m[2]) === 0n) return null;
  const out = m[1] === "-";
  const counterparty = typeof r.involved_account_id === "string" ? r.involved_account_id : "";
  // The fee belongs to the transaction's signer: this wallet's only on a send.
  const fee = out ? yoctoFromJson(r.outcomes_agg?.transaction_fee) : null;
  return {
    chain: token.chain,
    hash,
    direction: out ? "out" : "in",
    amount: atomicToDecimal(BigInt(m[2]), token.decimals),
    fee: fee ? atomicToDecimal(fee.yocto, NEAR_DECIMALS) : undefined,
    timestamp: nsToSeconds(r.block_timestamp),
    height: heightOf(r.block?.block_height),
    counterparty,
    meta: {
      intended: out ? "out" : "in",
      ...(typeof r.cause === "string" ? { cause: r.cause } : {}),
      contract: token.contract,
      source: NEARBLOCKS_HOST,
    },
  };
}

/**
 * The account's transfers of ONE NEP-141 token, newest first, from NearBlocks
 * (2026-10-06). Throws on a failed request — never an empty list for one.
 */
export async function fetchNep141History(
  account: string,
  token: { chain: ChainType; contract: string; decimals: number },
  opts: { limit?: number; cursor?: string } | undefined,
): Promise<TxHistoryPage> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 25, 100));
  const cursor = opts?.cursor && /^\d+$/.test(opts.cursor) ? `&cursor=${opts.cursor}` : "";
  const url =
    `${NEARBLOCKS_API}/v1/account/${encodeURIComponent(account)}/ft-txns` +
    `?contract=${encodeURIComponent(token.contract)}&per_page=${limit}&order=desc${cursor}`;
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
  if (!Array.isArray(txns)) throw new Error("NEAR token history: unexpected response from NearBlocks");
  const items = txns
    .map((t) => nearblocksFtRow(t, account, token))
    .filter((x): x is ChainTx => x !== null);
  const next = (body as { cursor?: unknown }).cursor;
  return {
    items: dedupeTxRows(items),
    cursor: txns.length >= limit && (typeof next === "string" || typeof next === "number") ? String(next) : undefined,
  };
}

/**
 * One transaction's NEP-141 parties for `contract`, from a NearBlocks `/full`
 * transaction (2026-10-06): who the token left and who it reached, never the
 * token contract (which is the transaction's RECEIVER, and what
 * `nearblocksTxnParties` would name).
 *
 * The receipts' `fts` events first: they are what executed (seen live on
 * 8xvZKGz2…, whose `fts` named the payer with `delta_amount: -9800000` and
 * the payee as `involved_account_id`). When the indexer lists no event — a
 * transfer that failed, or one not processed yet — the `ft_transfer` /
 * `ft_transfer_call` action's own `receiver_id` and the signer. `null` when
 * neither names a transfer of this token.
 */
export function nep141TxnParties(
  txn: Record<string, unknown>,
  contract: string,
  own: string,
  decimals: number,
  source = NEARBLOCKS_HOST,
): TxParties | null {
  const receipts = (Array.isArray(txn.receipts) ? txn.receipts : []) as Array<Record<string, unknown>>;
  const from: string[] = [];
  const to: string[] = [];
  let ownDelta = 0n;
  for (const rc of receipts) {
    for (const ev of (Array.isArray(rc?.fts) ? rc.fts : []) as Array<Record<string, any>>) {
      if ((ev?.ft_meta?.contract ?? ev?.ft?.contract) !== contract) continue;
      const d = typeof ev.delta_amount === "number" || typeof ev.delta_amount === "string"
        ? String(ev.delta_amount)
        : "";
      const m = /^(-)?(\d+)/.exec(d);
      if (!m) continue;
      const affected = typeof ev.affected_account_id === "string" ? ev.affected_account_id : "";
      if (!affected) continue;
      (m[1] === "-" ? from : to).push(affected);
      // NearBlocks serialises this field as a JSON number in `/full` (seen
      // 2026-10-06: `-9800000`); a large one loses precision, so the amount is
      // reported only from a digit string.
      if (affected === own && typeof ev.delta_amount === "string") {
        ownDelta += (m[1] === "-" ? -1n : 1n) * BigInt(m[2]);
      }
    }
  }
  if (from.length || to.length) {
    return {
      from: uniqueAddresses(from),
      to: uniqueAddresses(to),
      ...(ownDelta !== 0n
        ? {
            direction: ownDelta < 0n ? ("out" as const) : ("in" as const),
            amount: atomicToDecimal(ownDelta < 0n ? -ownDelta : ownDelta, decimals),
          }
        : {}),
      source,
    };
  }
  if (txn.receiver_account_id !== contract) return null;
  const actions = (Array.isArray(txn.actions) ? txn.actions : []) as Array<Record<string, any>>;
  const receivers: string[] = [];
  for (const a of actions) {
    if (a?.method !== "ft_transfer" && a?.method !== "ft_transfer_call") continue;
    let args: any = a?.args_full?.args_json;
    if (!args && typeof a?.args === "string") {
      try {
        args = JSON.parse(a.args);
      } catch {
        args = null;
      }
    }
    if (typeof args?.receiver_id === "string") receivers.push(args.receiver_id);
  }
  if (receivers.length === 0) return null;
  const signer = typeof txn.signer_account_id === "string" ? txn.signer_account_id : "";
  return { from: uniqueAddresses([signer]), to: uniqueAddresses(receivers), source };
}

/**
 * A NearBlocks transaction as parties, from `own`'s side. Exported for tests.
 *
 * The transaction's own `signer_account_id` → `receiver_account_id`, unless
 * `own` is neither and appears only in a receipt. Then the receipts that
 * touch `own` are the parties: every NEAR Intents withdrawal is
 * `intents.near → <account>` inside a relayer's transaction, whose signer
 * and receiver name neither this wallet nor the payer (the history reads the
 * same receipts, `nearblocksReceiptRow`). Gas refunds (`system → …`) are not
 * payments and are skipped.
 */
export function nearblocksTxnParties(txn: Record<string, unknown>, own: string, source = NEARBLOCKS_HOST): TxParties {
  const signer = typeof txn.signer_account_id === "string" ? txn.signer_account_id : "";
  const receiver = typeof txn.receiver_account_id === "string" ? txn.receiver_account_id : "";
  if (own && own !== signer && own !== receiver) {
    const receipts = (Array.isArray(txn.receipts) ? txn.receipts : []) as Array<Record<string, unknown>>;
    const moves = receipts.filter(
      (r) =>
        typeof r?.predecessor_account_id === "string" &&
        typeof r?.receiver_account_id === "string" &&
        r.predecessor_account_id !== "system",
    );
    const toMe = moves.filter((r) => r.receiver_account_id === own);
    if (toMe.length > 0) {
      return { from: uniqueAddresses(toMe.map((r) => r.predecessor_account_id)), to: [own], source };
    }
    const fromMe = moves.filter((r) => r.predecessor_account_id === own);
    if (fromMe.length > 0) {
      return { from: [own], to: uniqueAddresses(fromMe.map((r) => r.receiver_account_id)), source };
    }
  }
  return { from: uniqueAddresses([signer]), to: uniqueAddresses([receiver]), source };
}
