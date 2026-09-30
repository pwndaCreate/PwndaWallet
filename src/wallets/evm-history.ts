/**
 * EVM transaction history: which explorer to ask, and how to read its answer.
 *
 * # Why this was rewritten (operator report, 2026-09-30)
 *
 * The landscape Activity header listed 17 EVM rows as errors (ETH, every
 * USDC/USDT/USD₮0 leg on Ethereum, Arbitrum, Base, Optimism and Polygon, POL,
 * ETH ×3 for the L2s, MON). Read-only probes with the world-public test
 * address 0x9858EfFD232B4033E47d90003D41EC34EcaEda94 found three causes:
 *
 *  1. Blockscout's Etherscan-compatible endpoint (`/api?module=account…`),
 *     which every chain used, now allows a keyless client 10 requests per
 *     ~20-minute window, shared by every `*.blockscout.com` instance
 *     (`x-ratelimit-limit: 10`, `x-ratelimit-reset: 1217167` ms), and answers
 *     `HTTP 429 {"message":"Too many requests. Increase limits now at
 *     https://dev.blockscout.com",…}`. The wallet polls ~15 EVM pairs a minute.
 *     The same instances' v2 REST API (`/api/v2/addresses/…`) allows 180 a
 *     minute per instance (Base: 150), keyless — so v2 is the primary now.
 *  2. Monad's configured explorer, `explorer.monad.xyz`, does not resolve
 *     (ENOTFOUND) and is not on the backend proxy's allowlist, so every Monad
 *     row failed before a request was made. No keyless Monad history API was
 *     found (Routescan: "chain not supported"; Etherscan v2 and BlockVision
 *     need a key; MonadVision / monadexplorer sit behind a bot challenge).
 *  3. BNB Smart Chain's explorer (Routescan, chain 56) answers HTTP 200
 *     `{"status":"0","message":"chain not supported","result":null}`, and the
 *     old reader turned any non-array `result` into an EMPTY LIST — BSC said
 *     "no transactions" instead of failing. No keyless BSC source was found
 *     either (BscScan v1 is retired; Etherscan v2's free tier excludes BSC).
 *
 * Monad and BSC now throw `HistoryUnavailableError` — said as such, never as
 * an error and never as "no transactions". An Etherscan-style `status: "0"`
 * is an empty list only when the explorer says so ("No transactions found"
 * with an array); anything else is a failure.
 *
 * Every row now also carries what the details view needs: a reverted
 * transaction is `failed` (the old reader showed a reverted incoming
 * transfer as money received), the fee is the one THIS wallet paid (sent
 * rows only), and `meta.from` / `meta.to` hold both sides.
 */
import type { ChainTx, ChainType, TxHistoryPage } from "./types";
import { atomicToDecimal } from "./decimal-amount";
import { HistoryUnavailableError, condenseHttpError, hostOf } from "./tx-history-errors";
import { dedupeTxRows } from "./tx-row-key";

/**
 * One history source. `blockscout` is a Blockscout instance ROOT (for example
 * `https://eth.blockscout.com`), read through its v2 REST API. `etherscan` is
 * a full Etherscan-compatible `…/api` URL (Routescan's chain-id routes).
 */
export type EvmExplorer =
  | { kind: "blockscout"; base: string }
  | { kind: "etherscan"; base: string };

export const blockscoutV2 = (base: string): EvmExplorer => ({
  kind: "blockscout",
  base: base.replace(/\/+$/, ""),
});
export const etherscanCompatible = (base: string): EvmExplorer => ({ kind: "etherscan", base });

export interface EvmHistoryConfig {
  chain: ChainType;
  /** Names the chain in "history not available for … yet". */
  displayName: string;
  /** Tried in order. Empty = this chain has no history source. */
  explorers: EvmExplorer[];
  /** Present on an ERC-20 leg. */
  tokenContract?: string;
  /** The token's decimals, or 18 for the native coin. */
  decimals: number;
}

/** GET and parse JSON; throws on a non-2xx (as `proxyGetJson` does). */
export type GetJson = (url: string) => Promise<unknown>;

/** A Blockscout v2 page is 50 items. The app never asks for more. */
const PAGE_SIZE = 50;

/** Paging state: which source produced the page, and its own continuation. */
interface Cursor {
  i: number;
  p: unknown;
}

function parseCursor(c: string | undefined): Cursor | null {
  if (!c) return null;
  try {
    const v = JSON.parse(c);
    return v && typeof v === "object" && Number.isInteger(v.i) ? (v as Cursor) : null;
  } catch {
    return null;
  }
}

/**
 * History for `address`: each source in order, first answer wins. Throws
 * `HistoryUnavailableError` when the chain has no source, and an Error
 * naming every source's failure when all of them failed.
 */
export async function fetchEvmHistory(
  cfg: EvmHistoryConfig,
  address: string,
  opts: { limit?: number; cursor?: string } | undefined,
  getJson: GetJson,
): Promise<TxHistoryPage> {
  if (cfg.explorers.length === 0) throw new HistoryUnavailableError(cfg.displayName);
  const limit = Math.max(1, Math.min(opts?.limit ?? 25, PAGE_SIZE));
  const cursor = parseCursor(opts?.cursor);
  // A continuation belongs to the source that issued it.
  const order = cursor ? [cursor.i] : cfg.explorers.map((_, i) => i);
  const failures: string[] = [];
  for (const i of order) {
    const ex = cfg.explorers[i];
    if (!ex) continue;
    try {
      const page =
        ex.kind === "blockscout"
          ? await readBlockscout(ex, cfg, address, limit, cursor?.p, getJson)
          : await readEtherscan(ex, cfg, address, limit, cursor?.p, getJson);
      return {
        items: dedupeTxRows(page.items),
        cursor: page.next === undefined ? undefined : JSON.stringify({ i, p: page.next }),
      };
    } catch (e) {
      failures.push(`${hostOf(ex.base)}: ${condenseHttpError(e)}`);
    }
  }
  throw new Error(`every history source failed — ${failures.join("; ")}`);
}

// ── Blockscout v2 ───────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function addrOf(v: unknown): string | undefined {
  // v2 addresses are objects `{ hash, … }`; tolerate a bare string too.
  if (typeof v === "string") return v || undefined;
  if (v && typeof v === "object") return str((v as { hash?: unknown }).hash);
  return undefined;
}

function isoSeconds(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function intOf(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function weiOf(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

type Intended = "in" | "out" | "self";

function intendedOf(from: string | undefined, to: string | undefined, me: string): Intended {
  const f = from?.toLowerCase() === me;
  const t = to?.toLowerCase() === me;
  return f && t ? "self" : f ? "out" : "in";
}

function counterpartyOf(intended: Intended, from?: string, to?: string): string | undefined {
  return intended === "in" ? from : to;
}

async function readBlockscout(
  ex: EvmExplorer,
  cfg: EvmHistoryConfig,
  address: string,
  limit: number,
  pageParams: unknown,
  getJson: GetJson,
): Promise<{ items: ChainTx[]; next?: unknown }> {
  const q = new URLSearchParams();
  if (cfg.tokenContract) {
    q.set("type", "ERC-20");
    q.set("token", cfg.tokenContract);
  }
  if (pageParams && typeof pageParams === "object") {
    for (const [k, v] of Object.entries(pageParams as Record<string, unknown>)) {
      if (v !== null && v !== undefined) q.set(k, String(v));
    }
  }
  const path = cfg.tokenContract ? "token-transfers" : "transactions";
  const qs = q.toString();
  const body = (await getJson(
    `${ex.base}/api/v2/addresses/${address}/${path}${qs ? `?${qs}` : ""}`,
  )) as { items?: unknown; next_page_params?: unknown; message?: unknown } | null;
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) {
    const why = body && typeof body === "object" ? str(body.message) : undefined;
    throw new Error(`unexpected response${why ? `: ${why}` : ""}`);
  }
  const me = address.toLowerCase();
  const host = hostOf(ex.base);
  const rows: ChainTx[] = [];
  for (const r of body.items as unknown[]) {
    const row = cfg.tokenContract
      ? blockscoutTransferRow(r, me, cfg, host)
      : blockscoutTxRow(r, me, cfg, host);
    if (row) rows.push(row);
  }
  if (cfg.tokenContract) await addTokenSendFees(ex, address, rows, getJson);
  // A continuation is offered only when the whole explorer page was returned:
  // Blockscout's `next_page_params` points past item 50, not past item `limit`.
  const next =
    body.next_page_params && typeof body.next_page_params === "object" && rows.length <= limit
      ? body.next_page_params
      : undefined;
  return { items: rows.slice(0, limit), next };
}

/** A Blockscout v2 `/transactions` item as a `ChainTx`. Exported for tests. */
export function blockscoutTxRow(
  raw: unknown,
  me: string,
  cfg: Pick<EvmHistoryConfig, "chain" | "decimals">,
  source: string,
): ChainTx | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const hash = str(r.hash);
  if (!hash) return null;
  const from = addrOf(r.from);
  const to = addrOf(r.to) ?? addrOf(r.created_contract);
  const intended = intendedOf(from, to, me);
  const height = intOf(r.block_number) ?? intOf(r.block);
  const pending = height === undefined || r.result === "pending";
  const failed = !pending && (r.status === "error" || r.result === "dropped/replaced");
  const value = weiOf(r.value) ?? 0n;
  const feeWei = weiOf((r.fee as { value?: unknown } | null | undefined)?.value);
  const confirmations = intOf(r.confirmations);
  return {
    chain: cfg.chain,
    hash,
    direction: failed ? "failed" : intended,
    amount: atomicToDecimal(value, cfg.decimals),
    // The fee is shown only where this wallet paid it.
    fee: intended !== "in" && feeWei !== null ? atomicToDecimal(feeWei, 18) : undefined,
    timestamp: isoSeconds(r.timestamp),
    confirmations: pending ? 0 : confirmations,
    height,
    counterparty: counterpartyOf(intended, from, to),
    meta: {
      from,
      to,
      intended,
      method: str(r.method),
      ...(failed ? { failure: str(r.result) ?? "reverted" } : {}),
      source,
    },
  };
}

/**
 * The gas this wallet paid for its token SENDS. Blockscout's transfer list
 * has no fee; the address's own `/transactions` list does, for every
 * transaction the address sent (a token send is one: from = the wallet,
 * to = the token contract). One extra request, only when there is a sent
 * row to fill. Best-effort: if it fails, or a send is older than that page,
 * the fee stays unknown and the transfers are still right.
 */
async function addTokenSendFees(
  ex: EvmExplorer,
  address: string,
  rows: ChainTx[],
  getJson: GetJson,
): Promise<void> {
  const need = rows.filter((r) => r.meta?.intended !== "in" && r.fee === undefined);
  if (need.length === 0) return;
  let items: unknown;
  try {
    items = ((await getJson(`${ex.base}/api/v2/addresses/${address}/transactions`)) as { items?: unknown } | null)
      ?.items;
  } catch {
    return;
  }
  if (!Array.isArray(items)) return;
  const fees = new Map<string, bigint>();
  for (const t of items as Record<string, unknown>[]) {
    const hash = str(t?.hash);
    const fee = weiOf((t?.fee as { value?: unknown } | null | undefined)?.value);
    if (hash && fee !== null && addrOf(t.from)?.toLowerCase() === address.toLowerCase()) {
      fees.set(hash.toLowerCase(), fee);
    }
  }
  for (const r of need) {
    const fee = fees.get(r.hash.toLowerCase());
    if (fee !== undefined) r.fee = atomicToDecimal(fee, 18);
  }
}

/** A Blockscout v2 `/token-transfers` item as a `ChainTx`. Exported for tests. */
export function blockscoutTransferRow(
  raw: unknown,
  me: string,
  cfg: Pick<EvmHistoryConfig, "chain" | "decimals" | "tokenContract">,
  source: string,
): ChainTx | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const hash = str(r.transaction_hash) ?? str(r.tx_hash);
  if (!hash) return null;
  const token = r.token as { address?: unknown; address_hash?: unknown } | undefined;
  const tokenAddr = str(token?.address) ?? str(token?.address_hash);
  // Asked with `token=`, but never trust a filter to have been applied.
  if (cfg.tokenContract && tokenAddr && tokenAddr.toLowerCase() !== cfg.tokenContract.toLowerCase()) {
    return null;
  }
  const from = addrOf(r.from);
  const to = addrOf(r.to);
  const intended = intendedOf(from, to, me);
  const value = weiOf((r.total as { value?: unknown } | null | undefined)?.value);
  if (value === null) return null;
  const logIndex = intOf(r.log_index);
  return {
    chain: cfg.chain,
    hash,
    direction: intended,
    // The configured (on-chain verified) decimals, not the explorer's.
    amount: atomicToDecimal(value, cfg.decimals),
    timestamp: isoSeconds(r.timestamp),
    // The transfer list carries no count; it lists mined transfers only.
    confirmations: undefined,
    height: intOf(r.block_number),
    counterparty: counterpartyOf(intended, from, to),
    meta: {
      from,
      to,
      intended,
      method: str(r.method),
      contractAddress: tokenAddr,
      ...(logIndex !== undefined ? { logIndex } : {}),
      source,
    },
  };
}

// ── Etherscan-compatible ────────────────────────────────────────────────────

/**
 * The rows of an Etherscan-style answer, or a thrown refusal. `status: "0"` is
 * an empty list ONLY with an array `result` (the "No transactions found"
 * shape); `{"status":"0","message":"chain not supported","result":null}` and
 * `{"status":"0","message":"NOTOK","result":"Max rate limit reached"}` are
 * failures. Exported for tests.
 */
export function etherscanRows(body: unknown): unknown[] {
  if (!body || typeof body !== "object") throw new Error("unexpected response");
  const b = body as { status?: unknown; message?: unknown; result?: unknown };
  if (Array.isArray(b.result) && (b.status === "1" || b.result.length === 0)) return b.result;
  const why = [str(b.message), str(b.result)].filter(Boolean).join(": ");
  throw new Error(`explorer refused: ${why || "unexpected response"}`);
}

async function readEtherscan(
  ex: EvmExplorer,
  cfg: EvmHistoryConfig,
  address: string,
  limit: number,
  endBlock: unknown,
  getJson: GetJson,
): Promise<{ items: ChainTx[]; next?: unknown }> {
  const action = cfg.tokenContract ? "tokentx" : "txlist";
  // No start/end block on the first page: the explorer's default is "all".
  // The old query pinned `endblock=99999999`, a block Arbitrum (≈478M) and
  // Optimism (≈154M) passed long ago (inference: it would have hidden their
  // recent transactions had the query ever answered).
  const end = typeof endBlock === "number" && endBlock > 0 ? `&endblock=${endBlock}` : "";
  const url =
    `${ex.base}?module=account&action=${action}&address=${address}` +
    `${end}&page=1&offset=${limit}&sort=desc` +
    (cfg.tokenContract ? `&contractaddress=${cfg.tokenContract}` : "");
  const rows = etherscanRows(await getJson(url));
  const me = address.toLowerCase();
  const host = hostOf(ex.base);
  const items = rows
    .map((r) => etherscanRow(r, me, cfg, host))
    .filter((x): x is ChainTx => x !== null);
  const heights = items.map((t) => t.height).filter((h): h is number => h !== undefined);
  const next = rows.length >= limit && heights.length ? Math.min(...heights) - 1 : undefined;
  return { items, next };
}

/** An Etherscan-style `txlist` / `tokentx` row as a `ChainTx`. Exported for tests. */
export function etherscanRow(
  raw: unknown,
  me: string,
  cfg: Pick<EvmHistoryConfig, "chain" | "decimals" | "tokenContract">,
  source: string,
): ChainTx | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const hash = str(r.hash);
  if (!hash) return null;
  if (
    cfg.tokenContract &&
    str(r.contractAddress) &&
    str(r.contractAddress)!.toLowerCase() !== cfg.tokenContract.toLowerCase()
  ) {
    return null;
  }
  const from = str(r.from);
  const to = str(r.to) ?? str(r.contractAddress);
  const intended = intendedOf(from, to, me);
  const failed = r.isError === "1" || r.txreceipt_status === "0";
  const value = weiOf(r.value) ?? 0n;
  const gasUsed = weiOf(r.gasUsed);
  const gasPrice = weiOf(r.gasPrice);
  const logIndex = intOf(r.logIndex);
  return {
    chain: cfg.chain,
    hash,
    direction: failed ? "failed" : intended,
    amount: atomicToDecimal(value, cfg.decimals),
    fee:
      intended !== "in" && gasUsed !== null && gasPrice !== null
        ? atomicToDecimal(gasUsed * gasPrice, 18)
        : undefined,
    timestamp: intOf(r.timeStamp),
    confirmations: intOf(r.confirmations),
    height: intOf(r.blockNumber),
    counterparty: counterpartyOf(intended, from, to),
    meta: {
      from,
      to,
      intended,
      method: str(r.functionName) ?? str(r.methodId),
      ...(cfg.tokenContract ? { contractAddress: str(r.contractAddress) } : {}),
      ...(logIndex !== undefined ? { logIndex } : {}),
      ...(failed ? { failure: "reverted" } : {}),
      source,
    },
  };
}
