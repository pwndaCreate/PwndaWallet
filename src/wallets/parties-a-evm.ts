/**
 * EVM chains and their ERC-20 legs: who sent a transaction and who received
 * it, read by hash (`ChainAdapter.getTransactionParties`, 2026-09-30).
 *
 * # Why this exists
 *
 * The operator asked to see, in a transaction's details, which address it was
 * sent from and which it was received at. BSC and Monad have no history source
 * at all (`evm-history.ts`), and a swap leg is opened by hash, not from a row.
 *
 * # What is read
 *
 *  - Native coin: `eth_getTransactionByHash` — `from` and `to`. A transaction
 *    still in the mempool has both already; a reverted one keeps its intended
 *    parties (the row already says it failed). A contract creation has no
 *    `to`; its receipt's `contractAddress` stands in.
 *  - ERC-20 leg: the receipt's `Transfer(address,address,uint256)` logs
 *    emitted by THAT token contract, `from` and `to` from topics 1 and 2. The
 *    transaction's own `to` is the token contract, or a router, and its `from`
 *    need not be the token's sender either: the world-public test address's
 *    USDC transfer 0x2c9af6a8… (read live 2026-09-30) was sent by a sweeper
 *    (from 0x44a3…) through a helper contract (to 0x2c64…), and only its log
 *    names the account the USDC left (0x9858…) and the one it reached (0x44a3…).
 *    A reverted transfer emits no log; its calldata (`transfer` /
 *    `transferFrom` on the token itself) names the intended parties. With no
 *    receipt yet there is no answer, and `null` says so.
 *
 * # Transport
 *
 * JSON-RPC over `fetch`, to the adapter's own RPC list in its own order — the
 * requests the adapter's ethers provider makes for `getBalance`, and the ones
 * `evm-send.ts` makes directly. Not through a provider: its batching and 429
 * retry loop are not wanted for a one-off read, and its errors print the full
 * URL, which for an env-override RPC can carry an API key. Errors here name
 * the host only.
 *
 * A node that does not know the hash does not end the search: a transaction
 * just broadcast can be in one node's mempool and not another's. `null` means
 * no RPC had it and at least one said so.
 */
import { getAddress } from "ethers";
import type { TxParties } from "./types";
import { errorText } from "../lib/errorText";

/** keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** `transfer(address,uint256)` and `transferFrom(address,address,uint256)`. */
const TRANSFER_SELECTOR = "a9059cbb";
const TRANSFER_FROM_SELECTOR = "23b872dd";

/** Mutable so tests need not wait; nothing in the app writes it. */
export const EVM_PARTIES_TIMING = { requestTimeoutMs: 10_000 };

export interface EvmPartiesConfig {
  /** Names the chain in the error when every RPC failed ("Arbitrum", "USDC (Arbitrum)"). */
  chainName: string;
  /** The adapter's RPC list, in its order. */
  urls: readonly string[];
  /** Present on an ERC-20 leg: the token whose transfers are the parties. */
  tokenContract?: string;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Host only: an env-override RPC URL can carry an API key in its path. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

function clip(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

let rpcId = 0;

/** One JSON-RPC call. Throws with the status (and the node's own message) when there is no result. */
async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const ms = EVM_PARTIES_TIMING.requestTimeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    let resp: Response;
    let text: string;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: ctrl.signal,
      });
      text = await resp.text();
    } catch (e) {
      throw new Error(ctrl.signal.aborted ? `no answer within ${Math.round(ms / 1000)} s` : `request failed (${clip(errorText(e), 80)})`);
    }
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const err = body && typeof body === "object" && !Array.isArray(body) ? body.error : undefined;
    if (err && typeof err === "object") {
      const msg = typeof err.message === "string" ? err.message : "";
      throw new Error(`${resp.ok ? "" : `HTTP ${resp.status}, `}JSON-RPC error ${err.code ?? "?"}${msg ? `: ${clip(msg)}` : ""}`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (!body || typeof body !== "object" || Array.isArray(body) || !("result" in body)) {
      throw new Error(`HTTP ${resp.status}, not a JSON-RPC answer`);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/** A checksummed address, or undefined for anything that is not one. */
function address(v: unknown): string | undefined {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) return undefined;
  return getAddress(v.toLowerCase());
}

/** The address in a 32-byte ABI word or log topic (its last 20 bytes). */
function wordAddress(word: unknown): string | undefined {
  if (typeof word !== "string") return undefined;
  const hex = word.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
  return getAddress("0x" + hex.slice(24).toLowerCase());
}

function unique(list: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const a of list) if (a && !out.includes(a)) out.push(a);
  return out;
}

const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** A transfer's two parties. */
interface Transfer {
  from?: string;
  to?: string;
}

/**
 * Keep the transfers that involve `own`, or all of them when none does, and
 * list their senders and recipients (the rule `TxParties` sets for a
 * transaction that moves one token more than once).
 */
function partiesOf(transfers: Transfer[], own: string): { from: string[]; to: string[] } {
  const mine = transfers.filter((t) => same(t.from, own) || same(t.to, own));
  const pick = mine.length ? mine : transfers;
  return { from: unique(pick.map((t) => t.from)), to: unique(pick.map((t) => t.to)) };
}

/**
 * The `Transfer` logs of `token` in a receipt. A four-topic `Transfer` is
 * ERC-721 (the id is indexed too), not this token's. Exported for tests.
 */
export function erc20TransferLogs(receipt: unknown, token: string): Transfer[] {
  const logs = (receipt as { logs?: unknown } | null)?.logs;
  if (!Array.isArray(logs)) return [];
  const out: Transfer[] = [];
  for (const l of logs) {
    const topics = l?.topics;
    if (!same(l?.address, token) || !Array.isArray(topics) || topics.length !== 3) continue;
    if (String(topics[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    out.push({ from: wordAddress(topics[1]), to: wordAddress(topics[2]) });
  }
  return out;
}

/**
 * The transfer a transaction ASKED the token for, from its calldata: only
 * when it calls `token` itself with `transfer` or `transferFrom`. What a
 * reverted transfer leaves to read. Exported for tests.
 */
export function erc20CalldataTransfer(tx: unknown, token: string): Transfer | null {
  const t = tx as { to?: unknown; from?: unknown; input?: unknown; data?: unknown } | null;
  if (!t || !same(typeof t.to === "string" ? t.to : undefined, token)) return null;
  const raw = typeof t.input === "string" ? t.input : typeof t.data === "string" ? t.data : "";
  const data = raw.replace(/^0x/, "").toLowerCase();
  const word = (i: number) => data.slice(8 + 64 * i, 8 + 64 * (i + 1));
  if (data.startsWith(TRANSFER_SELECTOR) && data.length >= 8 + 64 * 2) {
    return { from: address(t.from), to: wordAddress(word(0)) };
  }
  if (data.startsWith(TRANSFER_FROM_SELECTOR) && data.length >= 8 + 64 * 3) {
    return { from: wordAddress(word(0)), to: wordAddress(word(1)) };
  }
  return null;
}

/**
 * `getTransactionParties` for an EVM adapter. `null` for a string that is not
 * a transaction hash, and when no RPC had the transaction (for a token leg:
 * had its receipt) and at least one said so; throws, naming every RPC with
 * its failure, when none answered.
 */
export async function readEvmParties(
  cfg: EvmPartiesConfig,
  hash: string,
  ownAddress: string,
): Promise<TxParties | null> {
  const h = String(hash ?? "").trim();
  if (!HASH.test(h)) return null;
  const failures: string[] = [];
  let unknown = false;
  for (const url of cfg.urls) {
    const host = hostOf(url);
    try {
      const parties = cfg.tokenContract
        ? await readTokenParties(url, h, cfg.tokenContract, ownAddress)
        : await readNativeParties(url, h);
      if (!parties) {
        unknown = true;
        continue;
      }
      return { ...parties, source: host };
    } catch (e) {
      failures.push(`${host}: ${errorText(e)}`);
    }
  }
  if (unknown) return null;
  throw new Error(
    `every ${cfg.chainName} RPC failed — ${failures.join("; ") || "no RPC configured"}`,
  );
}

function checkTx(tx: unknown, hash: string): Record<string, unknown> {
  if (!tx || typeof tx !== "object" || !same((tx as { hash?: string }).hash, hash)) {
    throw new Error("not the transaction asked for");
  }
  return tx as Record<string, unknown>;
}

async function readNativeParties(url: string, hash: string): Promise<{ from: string[]; to: string[] } | null> {
  const raw = await rpcCall(url, "eth_getTransactionByHash", [hash]);
  if (raw === null) return null;
  const tx = checkTx(raw, hash);
  let to = address(tx.to);
  if (!to) {
    // A contract creation: the new contract is where the value went. Read
    // only for this case; a pending creation has no receipt and no address.
    const receipt = (await rpcCall(url, "eth_getTransactionReceipt", [hash])) as { contractAddress?: unknown } | null;
    to = address(receipt?.contractAddress);
  }
  return { from: unique([address(tx.from)]), to: unique([to]) };
}

async function readTokenParties(
  url: string,
  hash: string,
  token: string,
  own: string,
): Promise<{ from: string[]; to: string[] } | null> {
  const receipt = await rpcCall(url, "eth_getTransactionReceipt", [hash]);
  // No receipt: unknown here, or not mined yet. Either way no transfer to read.
  if (receipt === null) return null;
  if (!receipt || typeof receipt !== "object" || !same((receipt as { transactionHash?: string }).transactionHash, hash)) {
    throw new Error("not the receipt asked for");
  }
  const transfers = erc20TransferLogs(receipt, token);
  if (transfers.length) return partiesOf(transfers, own);
  // No log of this token: a reverted transfer (status 0x0 keeps no logs), or
  // a transaction that moved none of it. The calldata tells the first apart.
  const tx = await rpcCall(url, "eth_getTransactionByHash", [hash]);
  const asked = tx ? erc20CalldataTransfer(checkTx(tx, hash), token) : null;
  return asked ? partiesOf([asked], own) : { from: [], to: [] };
}
