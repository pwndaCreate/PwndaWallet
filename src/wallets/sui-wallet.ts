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
// ⚠ publicnode's JSON-RPC surface may itself go away around mid-October 2026,
// following the upstream JSON-RPC deprecation. When it does, the fix is the
// GraphQL/gRPC migration (the reads here and the SDK transport for sends), not
// another JSON-RPC host. Not migrated yet on purpose: a transport change to the
// send path wants its own verification pass.
//
// History is no longer read here (2026-10-01): `suix_queryTransactionBlocks`
// fails WHOLE once publicnode has pruned one old transaction of the address
// (see `getTransactionHistory`), so it moved to GraphQL. The balance and the
// first parties read still use this host.
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
// Legacy JSON-RPC call against the publicnode endpoint (see SUI_RPC above).
// Restored during the origin/main merge: the auto-merge kept origin/main's
// GraphQL helper and dropped this one, while the adapter body below (taken from
// the swap-desk side, which has the working send path) still calls it.
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function suiRpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const r = await httpProxyCall({
    method: "POST",
    url: SUI_RPC,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    headers: { "Content-Type": "application/json" },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`Sui RPC HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(r.body) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (parsed.error) {
    throw new Error(`Sui RPC ${method}: ${parsed.error.message}`);
  }
  if (parsed.result === undefined) {
    throw new Error(`Sui RPC ${method}: no result`);
  }
  return parsed.result;
}

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

/** One balance change, owner and amount read out of either API's shape. */
export interface SuiBalanceChange {
  /** The owning address; absent for object-owned, shared or immutable owners. */
  owner?: string;
  coinType: string;
  /** Signed, in the coin's base unit (MIST for SUI). */
  amount: bigint;
}

/** JSON-RPC `balanceChanges` (`owner: { AddressOwner }`, `amount` as a string). */
export function suiRpcBalanceChanges(raw: unknown): SuiBalanceChange[] {
  const out: SuiBalanceChange[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const amount = String(c?.amount ?? "");
    if (!/^-?\d+$/.test(amount)) continue;
    const owner = c?.owner?.AddressOwner;
    out.push({
      ...(typeof owner === "string" ? { owner } : {}),
      coinType: String(c?.coinType ?? ""),
      amount: BigInt(amount),
    });
  }
  return out;
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

/** publicnode's answer for a digest it does not hold (checked live 2026-09-30). */
function isSuiRpcNotFound(e: unknown): boolean {
  return /Could not find the referenced transaction/i.test(errorText(e));
}

const SUI_TX_PARTIES_QUERY = `query ($digest: String!) {
  transaction(digest: $digest) {
    sender { address }
    effects { balanceChanges { nodes { owner { address } amount coinType { repr } } } }
  }
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

  async getBalance(address: string): Promise<string> {
    // Throws on RPC failure (2026-08-22) — used to read as zero. An
    // unfunded address is a real `totalBalance: "0"`, not an exception.
    const r = await suiRpcCall<{ totalBalance: string }>(
      "suix_getBalance",
      [address, "0x2::sui::SUI"]
    );
    const mist = BigInt(r.totalBalance);
    // 1 SUI = 1e9 MIST.
    const intPart = mist / 1_000_000_000n;
    const fracPart = mist % 1_000_000_000n;
    return `${intPart}.${fracPart.toString().padStart(9, "0")}`;
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
   * same address's transactions in one 200 ms request. It is also the
   * adapter's other host already (fees, network info, the parties fallback),
   * on the Rust proxy allowlist as `sui.io`.
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
   * `sui_getTransactionBlock` on publicnode, then Sui's GraphQL — the
   * adapter's other host — when publicnode does not have it (2026-09-30).
   *
   * The second source is not redundancy for its own sake: publicnode PRUNES.
   * Checked live 2026-09-30 on the public test seed's history, a digest its
   * own `suix_queryTransactionBlocks` still lists (EFPAnhSs…, 2026-05-11)
   * answers `-32602 Could not find the referenced transaction`, while
   * graphql.mainnet.sui.io returns it in full. So publicnode's "not found"
   * is not the chain's; GraphQL's `transaction: null` is.
   */
  async getTransactionParties(hash: string): Promise<TxParties | null> {
    const digest = hash.trim();
    const failures: string[] = [];
    try {
      const r = await suiRpcCall<{
        transaction?: { data?: { sender?: string } };
        balanceChanges?: unknown;
      }>("sui_getTransactionBlock", [digest, { showInput: true, showBalanceChanges: true }]);
      return suiTransferParties(
        r.transaction?.data?.sender,
        suiRpcBalanceChanges(r.balanceChanges),
        urlHost(SUI_RPC),
      );
    } catch (e) {
      failures.push(`${urlHost(SUI_RPC)}: ${isSuiRpcNotFound(e) ? "not found (pruned or unknown)" : errorText(e)}`);
    }
    try {
      type Node = { owner?: { address?: string } | null; amount?: string; coinType?: { repr?: string } | null };
      const { data: d, url } = await suiGraphQLAt<{
        transaction: {
          sender?: { address?: string } | null;
          effects?: { balanceChanges?: { nodes?: Node[] } | null } | null;
        } | null;
      }>(SUI_TX_PARTIES_QUERY, { digest });
      if (d.transaction == null) return null;
      const changes: SuiBalanceChange[] = [];
      for (const n of d.transaction.effects?.balanceChanges?.nodes ?? []) {
        if (!/^-?\d+$/.test(String(n?.amount ?? ""))) continue;
        changes.push({
          ...(typeof n.owner?.address === "string" ? { owner: n.owner.address } : {}),
          coinType: String(n.coinType?.repr ?? ""),
          amount: BigInt(String(n.amount)),
        });
      }
      return suiTransferParties(d.transaction.sender?.address, changes, urlHost(url));
    } catch (e) {
      failures.push(errorText(e));
    }
    throw new Error(`Sui transaction ${digest} could not be read: ${failures.join(" | ")}`);
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
