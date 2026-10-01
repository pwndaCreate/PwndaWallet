/**
 * Sui (SUI) ChainAdapter — Phase 7 (2026-05-08).
 *
 * Sui is a Move-based account-model L1. Keys: ed25519 (flag 0x00).
 * Addresses: 0x + 64 lowercase hex chars (32 bytes). The address bytes
 * are `BLAKE2b-256(flag || pubkey)`.
 *
 * Standard derivation: SLIP-0010 ed25519, path `m/44'/784'/0'/0'/0'`
 * (5 hardened segments — Sui CLI default account 0).
 *
 * This adapter handles the dashboard surface: derive address, fetch SUI
 * balance, paginate transaction history.
 *
 * ## 2026-08-14 — migrated from JSON-RPC to GraphQL
 *
 * Mysten permanently deactivated JSON-RPC on public Sui fullnodes on
 * 2026-07-31. Every method this adapter used — `suix_getBalance`,
 * `suix_queryTransactionBlocks`, `suix_getReferenceGasPrice` — now returns
 *
 *   -32601 "Method not found. JSON-RPC on public fullnodes has been
 *           deprecated. Please migrate to gRPC or GraphQL endpoints."
 *
 * over a perfectly healthy-looking HTTP 200. Balances stopped loading two
 * weeks before anyone noticed, because "the host replied" and "the API still
 * exists" are different questions and we were only asking the first one.
 *
 * Every query below was verified against mainnet on 2026-08-14. Two shape
 * changes worth knowing about, both of which would produce silently wrong
 * output rather than an error if you got them wrong:
 *
 *   - `coinType.repr` comes back FULLY EXPANDED
 *     (`0x0000…0002::sui::SUI`), while queries take the short form
 *     (`0x2::sui::SUI`). Comparing the two with `===` matches nothing, so
 *     history would render as an empty list rather than fail. Hence
 *     `normalizeCoinType`.
 *   - `effects.timestamp` is an ISO-8601 string, not epoch milliseconds.
 *     `parseInt` on it yields the year (2026), i.e. a timestamp in 1970.
 *
 * Sending is not done HERE: the Rust signer (`swap_sign_sui_tx`) is
 * session-gated, so the dashboard Send goes through
 * `features/swap/session-send.ts::executeSuiTransfer` (wired 2026-09-02; the
 * note that stood here said it had never been written, which stopped being
 * true that day). See `sendTransaction` below.
 *
 * ## 2026-10-01 — every read, and the send's, on GraphQL (operator request)
 *
 * The balance and the by-hash read moved from publicnode's JSON-RPC to
 * GraphQL, and the send's chain calls (its coins, the gas price, the dry run,
 * the submit and the status) are the GraphQL functions in "The send's chain
 * calls" below. Sui's published timeline ends JSON-RPC on full nodes, code
 * included, in mid-October 2026 (docs.sui.io/develop/accessing-data/
 * json-rpc-migration, read 2026-10-01). publicnode's own page announced
 * nothing that day, so when it stops is not known. `SUI_RPC` is kept for one
 * case only, explained at the constant.
 */

import { mnemonicToSeedSync } from "@scure/bip39";
import { derivePath } from "ed25519-hd-key";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
  TxParties,
} from "./types";
import { httpProxyCall } from "./_proxy";
import { rpcsFor } from "./chain-rpcs";
import { uniqueAddresses, urlHost } from "./parties-b-common";

// The official public endpoint (`fullnode.mainnet.sui.io`) was DEPRECATED
// upstream 2026-08-22: every `suix_*` method now returns
// `-32601 Method not found ... migrate to gRPC or GraphQL`
// (docs.sui.io/develop/accessing-data/json-rpc-migration). It was the sole,
// hardcoded, no-fallback source here, so every dashboard read failed on
// every session — "Sui not loaded" wasn't intermittent, it was permanent.
// (Corrected 2026-10-01: 2026-08-22 is when this wallet noticed. Sui's
// timeline has JSON-RPC off on its own mainnet full nodes from the week of
// 2026-07-27, as the header's 2026-08-14 note says.)
//
// publicnode.com still serves the legacy JSON-RPC surface and is already on
// the Rust proxy allowlist (used by ETH/AVAX/Polygon/Arbitrum/Base/Optimism/
// BSC/Monad/Solana already), so this needed no allowlist change. Verified
// live 2026-08-22 for all three methods this adapter calls
// (suix_getBalance, suix_getReferenceGasPrice, suix_queryTransactionBlocks).
//
// Exported 2026-09-29 (send-safety audit): the SEND path in
// `features/swap/session-send.ts` hard-coded the dead official host, so every
// Sui send failed at build time with the same -32601 while balances loaded
// fine from here. One constant, so the two cannot drift apart again. That path
// calls it directly from the webview through the SDK's `SuiClient`; publicnode
// answers CORS for any origin, including the SDK's own request headers
// (preflight checked 2026-09-29).
//
// History is no longer read here (2026-10-01): `suix_queryTransactionBlocks`
// fails WHOLE once publicnode has pruned one old transaction of the address
// (see `getTransactionHistory`), so it moved to GraphQL.
//
// Nor, later that day, are the balance, the by-hash read or the send
// (operator request, 2026-10-01; the header has why). What still uses this
// host is ONE path of the send: a wallet that holds SUI in an ADDRESS BALANCE
// (Sui's per-address balance with no coin object, on mainnet since release
// 1.72, May 2026). `@mysten/sui` 1.x has no transaction format that spends an
// address balance. A fullnode's JSON-RPC hands such clients a "compatibility
// coin reservation" instead, a synthetic coin in `suix_getCoins` that spends
// from the address balance (docs.sui.io, "Migrating from Coin to Address
// Balances"; `get_owned_coins` in sui-json-rpc at mainnet-v1.80.1). GraphQL
// lists real coins only. So `session-send.ts` builds that one case here, and
// when this host stops answering, a wallet whose SUI sits in an address
// balance can send only what its coins hold, until the wallet moves to
// `@mysten/sui` 2.x.
export const SUI_RPC = "https://sui-rpc.publicnode.com";
const DERIVATION_PATH = "m/44'/784'/0'/0'/0'";

/** Queries take the short form; responses come back fully expanded. */
const SUI_COIN_TYPE = "0x2::sui::SUI";
/** 1 SUI = 1e9 MIST. */
const MIST_PER_SUI = 1_000_000_000n;

// =========================================================================
// Address derivation
// =========================================================================

const SIGNATURE_SCHEME_ED25519 = 0x00;

/** Exported 2026-09-29: the send path checks the signer's key against it. */
export function suiAddressFromPublicKey(pk: Uint8Array): string {
  const input = new Uint8Array(1 + pk.length);
  input[0] = SIGNATURE_SCHEME_ED25519;
  input.set(pk, 1);
  const h = blake2b(input, { dkLen: 32 });
  return "0x" + Buffer.from(h).toString("hex");
}

function deriveKeypair(mnemonic: string, path: string = DERIVATION_PATH): { secret: Uint8Array; publicKey: Uint8Array } {
  const seed = mnemonicToSeedSync(mnemonic);
  const seedHex = Buffer.from(seed).toString("hex");
  const { key } = derivePath(path, seedHex);
  const publicKey = ed25519.getPublicKey(key);
  return { secret: key, publicKey };
}

// =========================================================================
// Sui GraphQL helpers
// =========================================================================

/**
 * Normalize a Move type so the short and expanded forms compare equal.
 *
 * Sui accepts `0x2::sui::SUI` in a query but reports it back as
 * `0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI`.
 * Both name the same coin. Without this, filtering history by coin type
 * silently matches nothing and the user sees an empty transaction list
 * instead of an error — the failure mode that hides itself.
 */
function normalizeCoinType(repr: string): string {
  const sep = repr.indexOf("::");
  if (sep < 0) return repr;
  const addr = repr.slice(0, sep).replace(/^0x0+(?=.)/, "0x");
  return addr + repr.slice(sep);
}

const isSuiCoin = (repr: string | undefined): boolean =>
  !!repr && normalizeCoinType(repr) === SUI_COIN_TYPE;

/** MIST (bigint) → a fixed-9-decimal SUI string. */
function formatMist(mist: bigint): string {
  const neg = mist < 0n;
  const abs = neg ? -mist : mist;
  const int = abs / MIST_PER_SUI;
  const frac = abs % MIST_PER_SUI;
  return `${neg ? "-" : ""}${int}.${frac.toString().padStart(9, "0")}`;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The JSON-RPC helper that stood here (`suiRpcCall`, publicnode) went with
// its last two callers, the balance and the first by-hash read, on
// 2026-10-01.

/**
 * POST a GraphQL query, trying each configured endpoint in turn.
 *
 * Rejects — never resolves to a default — when every endpoint fails. Callers
 * that need a "0" for the genuinely-empty case must get that 0 from the
 * chain, not from a catch block. Sui currently has exactly ONE working public
 * endpoint (see `chain-rpcs.ts`), which makes that distinction load-bearing:
 * with no redundancy, a blip is guaranteed to reach the UI, and it must
 * arrive labelled "unknown" rather than "you have nothing".
 */
async function suiGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  return (await suiGraphQLAt<T>(query, variables)).data;
}

/** `suiGraphQL`, also saying which endpoint answered (for a `source` line). */
async function suiGraphQLAt<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<{ data: T; url: string }> {
  const endpoints = rpcsFor("SUI");
  const failures: string[] = [];

  for (const url of endpoints) {
    let r;
    try {
      r = await httpProxyCall({
        method: "POST",
        url,
        body: JSON.stringify({ query, variables }),
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      failures.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (r.status < 200 || r.status >= 300) {
      failures.push(`${url}: HTTP ${r.status} ${r.body.slice(0, 120)}`);
      continue;
    }

    let parsed: GraphQLResponse<T>;
    try {
      parsed = JSON.parse(r.body) as GraphQLResponse<T>;
    } catch {
      failures.push(`${url}: unparseable body ${r.body.slice(0, 120)}`);
      continue;
    }

    // GraphQL reports errors in a 200 body. Treating that as success is
    // exactly how the JSON-RPC deprecation went unnoticed for two weeks.
    if (parsed.errors?.length) {
      failures.push(`${url}: ${parsed.errors.map((e) => e.message).join("; ")}`);
      continue;
    }
    if (parsed.data == null) {
      failures.push(`${url}: 200 but no data`);
      continue;
    }
    return { data: parsed.data, url };
  }

  throw new Error(
    `Sui GraphQL failed on all ${endpoints.length} endpoint(s): ${failures.join(" | ")}`
  );
}

// =========================================================================
// Transaction parties (2026-09-30)
// =========================================================================

/** One balance change: its owner, coin type and signed amount. */
export interface SuiBalanceChange {
  /** The owning address; absent for object-owned, shared or immutable owners. */
  owner?: string;
  coinType: string;
  /** Signed, in the coin's base unit (MIST for SUI). */
  amount: bigint;
}

/**
 * A transaction's parties from its sender and its balance changes. Exported
 * for tests.
 *
 * `from` is the transaction's SENDER, not the gas payer: a sponsored
 * transaction's gas comes from the sponsor (`gasData.owner`), whose SUI falls
 * while the sender's may not move at all (seen live 2026-09-30, digest
 * 5iVDN5Kz…). `to` is every owner whose SUI rose; when no SUI rose (a
 * transfer of another coin, whose sender paid only gas), every owner whose
 * balance of any coin rose. Nobody when nothing rose — a call that paid
 * only gas.
 */
export function suiTransferParties(
  sender: string | undefined,
  changes: readonly SuiBalanceChange[],
  source?: string,
): TxParties {
  const risers = (list: readonly SuiBalanceChange[]) =>
    uniqueAddresses(list.filter((c) => c.amount > 0n).map((c) => c.owner));
  const sui = changes.filter((c) => isSuiCoin(c.coinType));
  const to = risers(sui).length > 0 ? risers(sui) : risers(changes);
  return { from: uniqueAddresses([sender]), to, ...(source ? { source } : {}) };
}

/**
 * The other side of a history row, from its SUI balance changes. A send's
 * counterparty is the owner whose SUI rose the most; a receipt's, the owner
 * whose SUI fell the most.
 *
 * Corrected 2026-10-01: this read a receipt's sender as "the largest faller,
 * since a sponsor's fall is only gas". That is wrong whenever the amount is
 * smaller than the gas — it named the sponsor. The GraphQL history knows the
 * sender and names it (`suiHistoryRow`); this is left for a receipt the
 * address sent itself (a swap that paid it SUI) and for sends.
 */
function suiRowCounterparty(
  changes: readonly SuiBalanceChange[],
  me: string,
  direction: "in" | "out",
): string | undefined {
  let best: SuiBalanceChange | undefined;
  for (const c of changes) {
    if (!c.owner || c.owner.toLowerCase() === me || !isSuiCoin(c.coinType)) continue;
    const toward = direction === "out" ? c.amount > 0n : c.amount < 0n;
    if (!toward) continue;
    const mag = c.amount < 0n ? -c.amount : c.amount;
    const bestMag = best ? (best.amount < 0n ? -best.amount : best.amount) : -1n;
    if (mag > bestMag) best = c;
  }
  return best?.owner;
}

/**
 * One transaction's sender and balance changes (`getTransactionParties`).
 *
 * `balanceChangesJson` since 2026-10-01, as in the history query: the typed
 * `balanceChanges` connection this read before answers one page, 20 changes
 * unless asked for more (`serviceConfig.defaultPageSize`, read live
 * 2026-10-01), so a transaction that paid more owners than that listed only
 * some of its recipients.
 */
const SUI_TX_PARTIES_QUERY = `query ($digest: String!) {
  transaction(digest: $digest) {
    sender { address }
    effects { balanceChangesJson }
  }
}`;

/** The SUI balance (`getBalance`): coins plus the address balance. */
const SUI_BALANCE_QUERY = `query ($address: SuiAddress!) {
  address(address: $address) { balance(coinType: "0x2::sui::SUI") { totalBalance } }
}`;

// =========================================================================
// History over GraphQL (2026-10-01)
// =========================================================================

/**
 * The most transactions one GraphQL page holds. Checked live 2026-10-01:
 * `serviceConfig.maxPageSize` reads 50 for `Address.transactions`, and 51 is
 * refused with `Page size is too large: 51 > 50` (GRAPHQL_VALIDATION_FAILED).
 */
export const SUI_HISTORY_MAX_PAGE = 50;

/**
 * An address's transactions (operator request, 2026-10-01: Sui history moved
 * off publicnode's JSON-RPC, which fails the whole list over one pruned
 * transaction).
 *
 *  - `relation: AFFECTED` is load-bearing. The field defaults to `SENT` (its
 *    schema description), which lists what the address sent and nothing it
 *    received — the Aptos receipt gap of 2026-09-30 in another chain.
 *    AFFECTED is "the sender, sponsor, or the owner of some object that was
 *    created, modified or transferred".
 *  - `last: N` is the newest N, listed OLDEST first within the page;
 *    `before: <startCursor>` pages further back.
 *  - `balanceChangesJson` is every balance change at once, in the gRPC proto
 *    format (`[{ address, coinType, amount }]`, read live). The typed
 *    `balanceChanges` connection pages at 50, so an airdrop to more owners
 *    than that could cut this address's own change off the first page.
 */
const SUI_HISTORY_QUERY = `query ($address: SuiAddress!, $last: Int!, $before: String) {
  address(address: $address) {
    transactions(last: $last, before: $before, relation: AFFECTED) {
      pageInfo { hasPreviousPage startCursor }
      nodes {
        digest
        sender { address }
        effects {
          status
          timestamp
          checkpoint { sequenceNumber }
          executionError { message }
          balanceChangesJson
        }
      }
    }
  }
}`;

/** One `Address.transactions` node, as `SUI_HISTORY_QUERY` asks for it. */
export interface SuiHistoryNode {
  digest?: unknown;
  sender?: { address?: unknown } | null;
  effects?: {
    status?: unknown;
    /** ISO-8601, like `effects.timestamp` everywhere in this API (see the file header). */
    timestamp?: unknown;
    checkpoint?: { sequenceNumber?: unknown } | null;
    executionError?: { message?: unknown } | null;
    balanceChangesJson?: unknown;
  } | null;
}

/**
 * `balanceChangesJson` (`[{ address, coinType, amount }]`) as balance changes;
 * `null` when the field is not a list at all. Exported for tests.
 */
export function suiJsonBalanceChanges(raw: unknown): SuiBalanceChange[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SuiBalanceChange[] = [];
  for (const c of raw) {
    const amount = String(c?.amount ?? "");
    if (!/^-?\d+$/.test(amount)) continue;
    out.push({
      ...(typeof c?.address === "string" ? { owner: c.address } : {}),
      coinType: String(c?.coinType ?? ""),
      amount: BigInt(amount),
    });
  }
  return out;
}

/**
 * One history node as `address`'s SUI row, or `null` for a transaction that
 * changed no balance at all (the JSON-RPC rows left those out too). Exported
 * for tests. The rules the JSON-RPC rows followed are kept:
 *
 *  - the amount is this address's own SUI balance change (a send it paid gas
 *    for includes the gas, as before); a transaction that moved only another
 *    coin reads 0;
 *  - a send's other side comes from the same balance changes
 *    (`suiRowCounterparty`); a receipt's is the transaction's sender;
 *  - a checkpointed transaction is final: no count, its checkpoint as height.
 *
 * New with GraphQL, which says whether the transaction executed: a FAILURE is
 * `failed`. It moved nothing, so its amount is 0 and the gas this address
 * paid is its fee; the JSON-RPC rows read that gas as a send.
 */
export function suiHistoryRow(node: SuiHistoryNode, address: string): ChainTx | null {
  const digest = typeof node?.digest === "string" ? node.digest : "";
  if (!digest) return null;
  const me = address.trim().toLowerCase();
  const fx: NonNullable<SuiHistoryNode["effects"]> = node.effects ?? {};
  const ms = typeof fx.timestamp === "string" ? Date.parse(fx.timestamp) : NaN;
  const cp = fx.checkpoint?.sequenceNumber;
  const height = cp != null && /^\d+$/.test(String(cp)) ? Number(cp) : undefined;
  const placed = {
    timestamp: Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined,
    // A checkpointed transaction is final (2026-09-30; a count of 1 read
    // "1 / 6 pending"). GraphQL lists checkpointed transactions only, so the
    // `0` is for an answer that ever lacks one.
    confirmations: height !== undefined ? undefined : 0,
    height,
  };
  const sender = typeof node.sender?.address === "string" ? node.sender.address : undefined;
  const sentByMe = sender?.toLowerCase() === me;

  const changes = suiJsonBalanceChanges(fx.balanceChangesJson);
  if (changes === null) {
    // No balance changes in the answer: the transaction is real, its amount
    // is not known. "" is how a row says so (`TxDetails`: "—").
    return { chain: "sui", hash: digest, direction: sentByMe ? "out" : "in", amount: "", ...placed };
  }
  if (changes.length === 0) return null;
  const mine = changes
    .filter((c) => c.owner?.toLowerCase() === me && isSuiCoin(c.coinType))
    .reduce((sum, c) => sum + c.amount, 0n);

  if (fx.status === "FAILURE") {
    const why = typeof fx.executionError?.message === "string" ? fx.executionError.message.trim() : "";
    return {
      chain: "sui",
      hash: digest,
      direction: "failed",
      amount: formatMist(0n),
      ...(mine < 0n ? { fee: formatMist(-mine) } : {}),
      ...placed,
      meta: { intended: sentByMe ? "out" : "in", failure: why ? why.slice(0, 160) : "FAILURE" },
    };
  }

  const direction = mine < 0n ? "out" : "in";
  // The other side (2026-09-30: rows named nobody). `meta.from` / `meta.to`
  // are what the details read. A receipt's is the transaction's SENDER, which
  // GraphQL names: the JSON-RPC rows inferred it as the largest SUI faller,
  // and that is the gas SPONSOR whenever the amount is smaller than the gas
  // (2026-10-01). A send's is the owner whose SUI rose most, as before.
  const counterparty =
    direction === "in" && sender && !sentByMe ? sender : suiRowCounterparty(changes, me, direction);
  return {
    chain: "sui",
    hash: digest,
    direction,
    amount: formatMist(mine < 0n ? -mine : mine),
    ...(counterparty
      ? {
          counterparty,
          meta:
            direction === "out"
              ? { from: address, to: counterparty }
              : { from: counterparty, to: address },
        }
      : {}),
    ...placed,
  };
}

// =========================================================================
// The send's chain calls, over GraphQL (operator request, 2026-10-01)
// =========================================================================
//
// `session-send.ts::executeSuiTransfer` builds a transfer with
// `@mysten/sui` 1.45.2. Until 2026-10-01 it handed the SDK a JSON-RPC client
// (publicnode), whose resolver (`jsonRpc/json-rpc-resolver.js`) did three
// things: gas price = `suix_getReferenceGasPrice`; budget = a dry run of the
// transfer at `SUI_DRY_RUN_BUDGET` with no gas coins, its computation cost +
// `SUI_GAS_SAFE_OVERHEAD` × price + storage cost − rebate, never less than
// computation + overhead; gas payment = the first page of `suix_getCoins`.
// The functions below are those three reads on GraphQL, plus the submit and
// the status. Fed the same chain state, the transfer they build is the same
// bytes (`suiSend.test.ts`).

/**
 * The budget the dry run is asked at, 50 SUI in MIST: the SDK resolver's
 * `MAX_GAS`. Kept equal, so the dry run is the same transaction.
 */
export const SUI_DRY_RUN_BUDGET = 50_000_000_000n;

/** The resolver's `GAS_SAFE_OVERHEAD`: 1,000 gas units at the gas price. */
const SUI_GAS_SAFE_OVERHEAD = 1000n;

/**
 * The most coins one gas payment holds: one page of `suix_getCoins`, which
 * is what the JSON-RPC resolver used (the fullnode's `QUERY_MAX_RESULT_LIMIT`,
 * 50 unless the operator configures another). GraphQL's `Address.objects`
 * pages at 50 too (`serviceConfig.maxPageSize`, read live 2026-10-01).
 */
export const SUI_GAS_PAYMENT_MAX = 50;

/** One SUI coin object. */
export interface SuiCoinRef {
  objectId: string;
  /** A u64, as a decimal string. */
  version: string;
  /** Base58. */
  digest: string;
  balance: bigint;
}

/** What a transfer is built from: the gas price, the balance's two halves, the coins. */
export interface SuiSendState {
  referenceGasPrice: bigint;
  /** SUI in coin objects. */
  coinBalance: bigint;
  /** SUI in the address balance, which has no coin object (see `SUI_RPC`). */
  addressBalance: bigint;
  /** The address's SUI coins: one page, at most `SUI_GAS_PAYMENT_MAX`. */
  coins: SuiCoinRef[];
}

/** The gas a dry run reports. */
export interface SuiGasUsed {
  computationCost: bigint;
  storageCost: bigint;
  storageRebate: bigint;
}

/** What `executeTransaction` answered. */
export interface SuiExecution {
  digest?: string;
  status?: "SUCCESS" | "FAILURE";
  error?: string;
}

const SUI_SEND_STATE_QUERY = `query ($address: SuiAddress!) {
  epoch { referenceGasPrice }
  address(address: $address) {
    balance(coinType: "0x2::sui::SUI") { coinBalance addressBalance }
    objects(first: ${SUI_GAS_PAYMENT_MAX}, filter: { type: "0x2::coin::Coin<0x2::sui::SUI>" }) {
      nodes { address version digest contents { json } }
    }
  }
}`;

const SUI_SIMULATE_QUERY = `query ($tx: JSON!) {
  simulateTransaction(transaction: $tx) {
    effects {
      status
      executionError { message }
      gasEffects { gasSummary { computationCost storageCost storageRebate } }
    }
  }
}`;

const SUI_EXECUTE_MUTATION = `mutation ($tx: Base64!, $signatures: [Base64!]!) {
  executeTransaction(transactionDataBcs: $tx, signatures: $signatures) {
    effects { digest status executionError { message } }
  }
}`;

const SUI_EFFECTS_QUERY = `query ($digest: String!) {
  transactionEffects(digest: $digest) { status executionError { message } }
}`;

/**
 * A u64 out of a GraphQL answer: `BigInt` and `UInt53` fields arrive as a
 * string or a number. Throws, naming `what`, on anything else.
 */
function suiU64(v: unknown, what: string): bigint {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : typeof v === "string" ? v : "";
  if (!/^\d+$/.test(s)) throw new Error(`Sui returned no ${what}`);
  return BigInt(s);
}

/**
 * The gas price, both halves of the SUI balance, and up to 50 SUI coins of
 * `address`, in one GraphQL request. Exported for `session-send.ts` and tests.
 *
 * Throws when any part is missing, and on a coin it cannot read: dropping a
 * coin would change which coins pay, so a coin it cannot read is an error.
 * An address with no coins answers `nodes: []` (the public test seed, live
 * 2026-10-01).
 */
export async function readSuiSendState(address: string): Promise<SuiSendState> {
  type Node = { address?: unknown; version?: unknown; digest?: unknown; contents?: { json?: { balance?: unknown } | null } | null };
  const d = await suiGraphQL<{
    epoch?: { referenceGasPrice?: unknown } | null;
    address?: {
      balance?: { coinBalance?: unknown; addressBalance?: unknown } | null;
      objects?: { nodes?: Node[] | null } | null;
    } | null;
  }>(SUI_SEND_STATE_QUERY, { address: address.trim() });
  const referenceGasPrice = suiU64(d.epoch?.referenceGasPrice, "reference gas price");
  const balance = d.address?.balance;
  const nodes = d.address?.objects?.nodes;
  if (!balance || !Array.isArray(nodes)) throw new Error("Sui returned no balance or coin list for this address");
  const coins = nodes.map((n): SuiCoinRef => {
    const objectId = typeof n?.address === "string" ? n.address.toLowerCase() : "";
    const digest = typeof n?.digest === "string" ? n.digest : "";
    // 32 bytes in base58 is 32 to 44 characters; the SDK checks the length
    // again when it encodes the payment.
    if (!/^0x[0-9a-f]{64}$/.test(objectId) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(digest)) {
      throw new Error(`Sui returned a coin this wallet cannot read: ${JSON.stringify(n).slice(0, 160)}`);
    }
    return {
      objectId,
      version: suiU64(n.version, "coin version").toString(),
      digest,
      balance: suiU64(n.contents?.json?.balance, "coin balance"),
    };
  });
  return {
    referenceGasPrice,
    coinBalance: suiU64(balance.coinBalance, "coin balance"),
    addressBalance: suiU64(balance.addressBalance, "address balance"),
    coins,
  };
}

/**
 * The gas payment: the largest coins first, ties by object id, at most
 * `SUI_GAS_PAYMENT_MAX` — the order `suix_getCoins` lists them in (its index
 * key is the inverted balance, then the object id: `CoinIndexKey2`,
 * sui-core `jsonrpc_index.rs` at mainnet-v1.80.1). GraphQL's coin index is
 * keyed the same way (`object_by_owner.rs` in sui-indexer-alt-consistent-
 * store), so this sort should change nothing; it is here so the payment does
 * not depend on that. Exported for tests.
 */
export function suiGasPayment(coins: readonly SuiCoinRef[]): SuiCoinRef[] {
  return [...coins]
    .sort((a, b) =>
      a.balance !== b.balance
        ? a.balance > b.balance
          ? -1
          : 1
        : a.objectId < b.objectId
          ? -1
          : a.objectId > b.objectId
            ? 1
            : 0,
    )
    .slice(0, SUI_GAS_PAYMENT_MAX);
}

/** The JSON-RPC resolver's budget from a dry run's gas. Exported for tests. */
export function suiGasBudget(price: bigint, gas: SuiGasUsed): bigint {
  const base = gas.computationCost + SUI_GAS_SAFE_OVERHEAD * price;
  const total = base + gas.storageCost - gas.storageRebate;
  return total > base ? total : base;
}

/**
 * Dry-run `txBytes` (`simulateTransaction`, the GraphQL form of
 * `sui_dryRunTransactionBlock`) and return its gas. A dry run that fails
 * throws the resolver's own words, so an error reads as it did. With no gas
 * coins in the transaction, both APIs run it on a stand-in gas coin
 * (`0xff…ff`, version 2) and report the same costs: checked live on
 * 2026-10-01 for a transfer from the public test seed, 100,000 computation,
 * 1,976,000 storage, 0 rebate from each.
 */
export async function simulateSuiGas(txBytes: Uint8Array): Promise<SuiGasUsed> {
  type Effects = {
    status?: unknown;
    executionError?: { message?: unknown } | null;
    gasEffects?: { gasSummary?: Record<string, unknown> | null } | null;
  };
  const d = await suiGraphQL<{ simulateTransaction?: { effects?: Effects | null } | null }>(SUI_SIMULATE_QUERY, {
    tx: { bcs: { value: Buffer.from(txBytes).toString("base64") } },
  });
  const fx = d.simulateTransaction?.effects;
  if (fx?.status === "FAILURE") {
    const why = typeof fx.executionError?.message === "string" ? fx.executionError.message : "FAILURE";
    throw new Error(`Dry run failed, could not automatically determine a budget: ${why}`);
  }
  if (fx?.status !== "SUCCESS") throw new Error("Sui's dry run returned no result");
  const g = fx.gasEffects?.gasSummary;
  return {
    computationCost: suiU64(g?.computationCost, "computation cost"),
    storageCost: suiU64(g?.storageCost, "storage cost"),
    storageRebate: suiU64(g?.storageRebate, "storage rebate"),
  };
}

/**
 * Submit signed bytes (`executeTransaction`, which answers once the
 * transaction is final). Throws when no endpoint answered; the caller settles
 * that by digest, never by building again. With more than one endpoint
 * configured, the next is sent the same bytes: the same transaction, which
 * Sui runs at most once.
 */
export async function executeSuiTransaction(txBytesBase64: string, signatureBase64: string): Promise<SuiExecution> {
  const d = await suiGraphQL<{
    executeTransaction?: { effects?: { digest?: unknown; status?: unknown; executionError?: { message?: unknown } | null } | null } | null;
  }>(SUI_EXECUTE_MUTATION, { tx: txBytesBase64, signatures: [signatureBase64] });
  const fx = d.executeTransaction?.effects;
  return {
    ...(typeof fx?.digest === "string" ? { digest: fx.digest } : {}),
    ...(fx?.status === "SUCCESS" || fx?.status === "FAILURE" ? { status: fx.status } : {}),
    ...(typeof fx?.executionError?.message === "string" ? { error: fx.executionError.message } : {}),
  };
}

/**
 * A transaction's outcome by digest, or `null` while GraphQL does not have
 * it. Its indexing can trail the network, so a fresh transaction may read
 * `null` for a moment (the schema says so).
 */
export async function suiTransactionStatus(
  digest: string,
): Promise<{ status: "SUCCESS" | "FAILURE"; error?: string } | null> {
  const d = await suiGraphQL<{
    transactionEffects?: { status?: unknown; executionError?: { message?: unknown } | null } | null;
  }>(SUI_EFFECTS_QUERY, { digest });
  const fx = d.transactionEffects;
  if (fx == null) return null;
  if (fx.status !== "SUCCESS" && fx.status !== "FAILURE") throw new Error("Sui returned effects with no status");
  const error = typeof fx.executionError?.message === "string" ? fx.executionError.message : undefined;
  return { status: fx.status, ...(error ? { error } : {}) };
}

// =========================================================================
// Adapter
// =========================================================================

export const suiAdapter: ChainAdapter = {
  chain: "sui",
  displayName: "Sui",
  ticker: "SUI",
  color: "#4ca3ff",
  addressPlaceholder: "0x...",
  derivation: {
    kind: "bip39",
    path: "m/44'/784'/0'/0'/0'",
    standard: "Sui Wallet / Suiet convention",
    hasAlternatives: false,
  },
  /** Arbitrary-path derivation — powers the generic finder + funded-path scan. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    const { secret, publicKey } = deriveKeypair(mnemonic, path);
    return {
      chain: "sui",
      address: suiAddressFromPublicKey(publicKey),
      mnemonic,
      privateKey: Buffer.from(secret).toString("hex"),
    };
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const clean = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const secret = new Uint8Array(clean.length / 2);
    for (let i = 0; i < secret.length; i++) {
      secret[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    if (secret.length !== 32) {
      throw new Error("Sui secret must be 32 bytes");
    }
    const publicKey = ed25519.getPublicKey(secret);
    return {
      chain: "sui",
      address: suiAddressFromPublicKey(publicKey),
      mnemonic: "",
      privateKey: clean,
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const { secret, publicKey } = deriveKeypair(mnemonic);
    return {
      chain: "sui",
      address: suiAddressFromPublicKey(publicKey),
      mnemonic,
      privateKey: Buffer.from(secret).toString("hex"),
    };
  },

  /**
   * The SUI balance, from GraphQL since 2026-10-01 (operator request; it was
   * publicnode's `suix_getBalance`).
   *
   * `totalBalance` is the coins plus the address balance, the same sum the
   * JSON-RPC `totalBalance` was (docs.sui.io, "Migrating from Coin to Address
   * Balances"), so the number does not change.
   *
   * Throws on a failed read (2026-08-22) — it used to read as zero. An
   * unfunded address is a real `totalBalance: "0"` (the public test seed,
   * live 2026-10-01), not an exception.
   */
  async getBalance(address: string): Promise<string> {
    const d = await suiGraphQL<{ address?: { balance?: { totalBalance?: unknown } | null } | null }>(
      SUI_BALANCE_QUERY,
      { address: address.trim() },
    );
    return formatMist(suiU64(d.address?.balance?.totalBalance, "balance for this address"));
  },

  async sendTransaction(): Promise<TxResult> {
    // Reachable only if something bypasses the app-layer override. The
    // dashboard Send for this chain goes through `sessionSignedSendOverride`
    // in App.tsx -> `features/swap/session-send.ts`, because the signer is
    // session-gated in Rust and an adapter cannot open a session without
    // importing the vault + swap layers (BOUNDARIES.md forbids that
    // direction). Wired 2026-09-02; before then this chain was receive-only.
    throw new Error(
      "Sui send must go through the app-layer session override (features/swap/session-send.ts::executeSuiTransfer) — the signer is session-gated."
    );
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    // Throws rather than falling back to a made-up price. The old fallback
    // claimed 1000 MIST; the real reference price is 100, so the "safe
    // default" was a silent 10x overstatement that looked like real data.
    const d = await suiGraphQL<{ epoch: { referenceGasPrice: string } | null }>(
      `{ epoch { referenceGasPrice } }`
    );
    const price = d.epoch?.referenceGasPrice;
    if (price == null) throw new Error("Sui returned no reference gas price");
    return { label: "Gas price", value: price, unit: "MIST" };
  },

  /**
   * The address's transactions through Sui's GraphQL (`SUI_HISTORY_QUERY`),
   * newest first (operator request, 2026-10-01).
   *
   * # Why not publicnode's `suix_queryTransactionBlocks` any more
   *
   * It fails WHOLE once publicnode has pruned one old transaction of the
   * address. Both of its filters (`FromAddress`, `ToAddress` — the compound
   * `FromOrToAddress` was removed upstream on 2026-08-22) answered, for the
   * public test seed, live on 2026-09-30 and again on 2026-10-01:
   *
   *   -32000 ErrorObject { code: InvalidParams, message: "unable to derive
   *   balance/object changes because effect is empty", data: None }
   *
   * so the history threw "Sui history could not be read" for every address
   * with history older than publicnode keeps. GraphQL returned all 31 of the
   * same address's transactions in one 200 ms request. It was also the
   * adapter's other host already (fees, network info, the parties fallback),
   * on the Rust proxy allowlist as `sui.io`; since later that day it is the
   * only one (the header).
   *
   * One request: GraphQL lists what the address sent AND received
   * (`relation: AFFECTED`), where the JSON-RPC history needed two queries
   * merged by digest. A failed read throws: an address with no transactions
   * answers an empty list, so an error is never "no transactions".
   */
  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const last = Math.min(Math.max(1, Math.floor(opts?.limit ?? 25)), SUI_HISTORY_MAX_PAGE);
    type Page = {
      address: {
        transactions: {
          pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null } | null;
          nodes?: SuiHistoryNode[] | null;
        } | null;
      } | null;
    };
    let page: Page;
    try {
      page = await suiGraphQL<Page>(SUI_HISTORY_QUERY, {
        address: address.trim(),
        last,
        before: opts?.cursor ?? null,
      });
    } catch (e) {
      throw new Error(`Sui history could not be read: ${errorText(e)}`);
    }
    const conn = page.address?.transactions;
    if (!conn) {
      // `address` is answered for any valid address, even an unused one
      // (`nodes: []`, checked live), so its absence is not an empty history.
      throw new Error("Sui history could not be read: the answer listed no transactions field for the address");
    }
    // The page is oldest first; the history is newest first.
    const items = [...(conn.nodes ?? [])]
      .reverse()
      .map((n) => suiHistoryRow(n, address))
      .filter((r): r is ChainTx => r !== null);
    const info = conn.pageInfo;
    return {
      items,
      ...(info?.hasPreviousPage && info.startCursor ? { cursor: info.startCursor } : {}),
    };
  },

  /**
   * One transaction's sender and recipients, from Sui's GraphQL
   * (`transaction(digest)`); `null` when GraphQL answers `transaction: null`.
   *
   * GraphQL alone since 2026-10-01 (operator request). publicnode's
   * `sui_getTransactionBlock` was asked first until then, and its "not found"
   * was never believed: it PRUNES. A digest its own history still listed
   * (EFPAnhSs…, the public test seed, 2026-05-11) answered `-32602 Could not
   * find the referenced transaction` on 2026-09-30, while GraphQL returned it
   * in full. GraphQL serves transactions from the first checkpoint on
   * (`serviceConfig.availableRange`, read live 2026-10-01).
   */
  async getTransactionParties(hash: string): Promise<TxParties | null> {
    const digest = hash.trim();
    let answer: {
      data: { transaction?: { sender?: { address?: unknown } | null; effects?: { balanceChangesJson?: unknown } | null } | null };
      url: string;
    };
    try {
      answer = await suiGraphQLAt(SUI_TX_PARTIES_QUERY, { digest });
    } catch (e) {
      throw new Error(`Sui transaction ${digest} could not be read: ${errorText(e)}`);
    }
    const t = answer.data.transaction;
    if (t == null) return null;
    const sender = typeof t.sender?.address === "string" ? t.sender.address : undefined;
    return suiTransferParties(sender, suiJsonBalanceChanges(t.effects?.balanceChangesJson) ?? [], urlHost(answer.url));
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // Throws rather than inventing a number — see getNetworkInfo. Callers
    // (useFeeEstimate, SendModal) already handle a rejection by showing the
    // error, which beats quoting a fee we didn't fetch.
    const d = await suiGraphQL<{ epoch: { referenceGasPrice: string } | null }>(
      `{ epoch { referenceGasPrice } }`
    );
    const price = d.epoch?.referenceGasPrice;
    if (price == null) throw new Error("Sui returned no reference gas price");
    return {
      normal: { value: price },
      unit: "MIST/gas-unit",
      fetchedAt: Date.now(),
    };
  },
};
