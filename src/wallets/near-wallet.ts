/**
 * NEAR (NEAR Protocol) ChainAdapter.
 *
 * NEAR uses ed25519 keypairs derived via SLIP-10 at `m/44'/397'/0'`
 * (3 hardened steps — the NEAR CLI / Ledger convention). The implicit
 * account ID is `hex(public_key)` — a 64-character lowercase hex string
 * that is BOTH the account name and the deposit address for unfunded
 * accounts.
 *
 * Algorithm parity: this TS adapter produces byte-for-byte identical
 * addresses to the Rust `derive::near_implicit_account` function in
 * `src-tauri/src/swap/derive.rs:340` (the path `m/44'/397'/0'` and the
 * ed25519 public-key form are identical). The Rust path remains in
 * place for swap source-tx signing (`swap_sign_near_tx`), which still
 * needs the session-gated keypair access for actual transaction bytes.
 * This adapter only does what every chain adapter does: derive the
 * address at vault-load so it lands in `WalletsByChain.near` and is
 * available to the dashboard, the swap form, and the registry-driven
 * `addressForTicker` resolver — no Rust session needed.
 *
 * Pre-2026-05-25 the address derivation was Rust-only and gated behind
 * `swap_unlock`. That meant `WalletsByChain.near` was never populated
 * by `useVault.deriveAllChains`, which in turn meant
 * `addressForTicker("NEAR", wallets)` returned null, which collapsed
 * `SwapView.confirmReady` to false for any NEAR-source pair — the
 * exact bug class as the CARDANO blocker resolved earlier the same
 * day. Deriving in TS unblocks it.
 *
 * Sending runs through the Rust `swap_sign_near_tx` + `executeNearNativeTransfer`
 * path (the signer is session-gated), for both the dashboard Send and NEAR
 * Intents deposits.
 *
 * 2026-09-29 send-safety audit: `getBalance` was hard-coded to "0" and
 * `getTransactionHistory` to an empty list, so a funded NEAR wallet read as
 * empty with "no transactions". The balance is now read with `view_account`
 * across the NEAR RPC list. History, which no public NEAR RPC serves, said it
 * was unavailable; since 2026-09-30 it is read from NearBlocks
 * (`near-history.ts`). This file also holds the NEAR RPC helpers and the
 * account-ID rules the send path uses.
 */

import { mnemonicToSeedSync } from "@scure/bip39";
import { derivePath } from "ed25519-hd-key";
import { ed25519 } from "@noble/curves/ed25519.js";
import { atomicToDecimal } from "./decimal-amount";
import { NEAR_RPCS } from "./chain-rpcs";
import {
  NEARBLOCKS_HOST,
  fetchNearHistory,
  fetchNearblocksTxn,
  nearblocksTxnParties,
} from "./near-history";
import { uniqueAddresses, urlHost } from "./parties-b-common";
import { errorText } from "../lib/errorText";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  TxHistoryPage,
  FeeEstimate,
  TxParties,
} from "./types";

const DERIVATION_PATH = "m/44'/397'/0'";

/** 1 NEAR = 10^24 yoctoNEAR. */
export const NEAR_DECIMALS = 24;

// =========================================================================
// NEAR JSON-RPC
// =========================================================================

/**
 * An error the NEAR node itself answered with. `causeName` is NEAR's
 * machine-readable reason (`UNKNOWN_ACCOUNT`, `UNKNOWN_TRANSACTION`,
 * `UNKNOWN_ACCESS_KEY`, `TIMEOUT_ERROR`, …), read from the error's
 * `cause.name`. The old helper kept only `message`, which for every one of
 * these is the literal "Server error".
 */
export class NearRpcError extends Error {
  readonly causeName?: string;
  readonly code?: number;
  constructor(message: string, causeName?: string, code?: number) {
    super(message);
    this.name = "NearRpcError";
    this.causeName = causeName;
    this.code = code;
  }
}

/** Per-request timeout. Mutable for tests only. */
export const NEAR_RPC_TIMEOUT = { ms: 15_000 };

/** One JSON-RPC call to one NEAR node. Throws `NearRpcError` for a node's own error. */
export async function nearRpcCall<T>(url: string, method: string, params: unknown): Promise<T> {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), NEAR_RPC_TIMEOUT.ms) : null;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl?.signal,
    });
    if (!resp.ok) throw new Error(`NEAR RPC ${method} at ${url}: HTTP ${resp.status}`);
    const json = (await resp.json()) as {
      result?: T;
      error?: { message?: string; data?: unknown; code?: number; cause?: { name?: string } };
    };
    if (json.error) {
      const e = json.error;
      const detail = typeof e.data === "string" ? e.data : (e.message ?? "error");
      throw new NearRpcError(
        `NEAR RPC ${method}: ${e.cause?.name ? `${e.cause.name}: ` : ""}${detail}`,
        e.cause?.name,
        e.code,
      );
    }
    if (json.result === undefined) throw new Error(`NEAR RPC ${method} at ${url}: no result`);
    return json.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The same call against each URL in turn until one answers.
 *
 * `isAnswer(e)` marks an error that IS the answer (e.g. `UNKNOWN_ACCOUNT` for
 * `view_account`) and must not be rotated past: a second node would say the
 * same. Everything else — HTTP errors, timeouts, a provider that does not
 * serve the method (`1rpc.io/near` answers `query` with -32601, checked
 * 2026-09-29) — moves on to the next URL. Throws the last error when all fail.
 */
export async function nearRpcAny<T>(
  urls: string[],
  method: string,
  params: unknown,
  isAnswer: (e: unknown) => boolean = () => false,
): Promise<T> {
  if (urls.length === 0) throw new Error("No NEAR RPC endpoints configured.");
  let last: unknown;
  for (const url of urls) {
    try {
      return await nearRpcCall<T>(url, method, params);
    } catch (e) {
      if (isAnswer(e)) throw e;
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function isNearCause(e: unknown, causeName: string): boolean {
  return e instanceof NearRpcError && e.causeName === causeName;
}

/** `view_account`'s answer, for the fields this wallet reads. */
export interface NearAccountView {
  /** Liquid balance in yoctoNEAR (includes the part held for storage). */
  amount: string;
  /** Validator stake, yoctoNEAR. Not spendable. */
  locked: string;
  /** Bytes of state the account pays storage for. */
  storage_usage: number;
}

/**
 * The account's state, or `null` when NEAR says it does not exist
 * (`UNKNOWN_ACCOUNT`). An implicit account does not exist until it is first
 * funded, so `null` is a legitimate empty wallet for one. Throws when no node
 * can be reached.
 */
export async function viewNearAccount(
  accountId: string,
  urls: string[] = NEAR_RPCS(),
): Promise<NearAccountView | null> {
  try {
    return await nearRpcAny<NearAccountView>(
      urls,
      "query",
      { request_type: "view_account", finality: "final", account_id: accountId },
      (e) => isNearCause(e, "UNKNOWN_ACCOUNT"),
    );
  } catch (e) {
    if (isNearCause(e, "UNKNOWN_ACCOUNT")) return null;
    throw e;
  }
}

/**
 * Storage staking: every byte of account state keeps 10^19 yoctoNEAR
 * (1 NEAR per 100 kB) in the account, and that part of `amount` cannot be
 * sent. NEAR's `storage_amount_per_byte`; unchanged since 2020.
 */
export const NEAR_STORAGE_YOCTO_PER_BYTE = 10n ** 19n;

/**
 * What the account can actually send, yoctoNEAR: `amount` minus the storage
 * stake not already covered by `locked` (NEAR counts a validator stake toward
 * storage). Never negative.
 */
export function nearAvailableYocto(v: NearAccountView): bigint {
  const amount = BigInt(v.amount);
  const locked = BigInt(v.locked || "0");
  const storage = BigInt(v.storage_usage || 0) * NEAR_STORAGE_YOCTO_PER_BYTE;
  const held = storage > locked ? storage - locked : 0n;
  return amount > held ? amount - held : 0n;
}

// =========================================================================
// Account IDs
// =========================================================================

/** NEAR's own account-ID grammar (nearcore `AccountId` validation). */
const NEAR_ACCOUNT_ID =
  /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * A NEAR send recipient (2026-09-29 send-safety audit). The recipient used to
 * go into the transaction untrimmed and unchecked.
 *
 *  - implicit account: exactly 64 lowercase hex characters (it is the public
 *    key; a transfer creates it);
 *  - named account: 2–64 characters, lowercase a–z and 0–9, parts joined by
 *    single `-`, `_` or `.` separators. Whether it EXISTS is a network
 *    question the send asks separately (a transfer to a missing named account
 *    fails on chain);
 *  - `0x` + 40 hex (an "ETH-implicit" account) is refused: NEAR would create
 *    an account there that only an Ethereum wallet using NEAR's Ethereum-
 *    wallet support can move funds from, and a user pasting it almost always
 *    meant an Ethereum address.
 *
 * Only surrounding whitespace is removed. Upper case is refused, not
 * lowered: "Alice.near" is not an account, and guessing which one was meant
 * is not this wallet's call.
 */
export function parseNearRecipient(input: string): { accountId: string; implicit: boolean } {
  const id = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(id)) {
    throw new Error(
      "That is an Ethereum-style address. NEAR can hold funds there only for an Ethereum wallet " +
        "using NEAR's Ethereum-wallet support, so this wallet does not send to it. Use a NEAR account " +
        "(name.near, or a 64-character implicit account).",
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(id)) {
    if (id !== id.toLowerCase()) {
      throw new Error("A NEAR implicit account is written in lowercase hex. Check the address.");
    }
    return { accountId: id, implicit: true };
  }
  if (id.length < 2 || id.length > 64) {
    throw new Error(
      `A NEAR account ID is 2 to 64 characters; this one has ${id.length}. Check the recipient.`,
    );
  }
  if (!NEAR_ACCOUNT_ID.test(id)) {
    throw new Error(
      "That is not a valid NEAR account ID: only lowercase letters, digits, and single - _ or . " +
        "between them (for example alice.near).",
    );
  }
  return { accountId: id, implicit: false };
}

/**
 * A transaction this wallet signed, from the NEAR RPC nodes (`tx`), for when
 * NearBlocks has not indexed it yet or cannot be reached (2026-09-30).
 *
 * `tx` needs the signer's account id to find the transaction's shard, and
 * the public nodes are not archival: a days-old transaction answers
 * `UNKNOWN_TRANSACTION` (drpc, checked 2026-09-30). So this finds exactly the
 * case NearBlocks can miss — this wallet's own fresh send — and nothing else.
 * `wait_until: "NONE"` returns at once, with the transaction when the node
 * knows it. `"unknown"` for `UNKNOWN_TRANSACTION`; throws when no node
 * answered.
 */
async function nearRpcOwnTxParties(hash: string, own: string): Promise<TxParties | "unknown"> {
  const urls = NEAR_RPCS();
  let last: unknown = new Error("No NEAR RPC endpoints configured.");
  for (const url of urls) {
    try {
      const r = await nearRpcCall<{ transaction?: { signer_id?: unknown; receiver_id?: unknown } }>(
        url,
        "tx",
        { tx_hash: hash, sender_account_id: own, wait_until: "NONE" },
      );
      const t = r?.transaction;
      // Known, not executed yet: nothing to name.
      if (!t || typeof t.signer_id !== "string") return "unknown";
      return { from: [t.signer_id], to: uniqueAddresses([t.receiver_id]), source: urlHost(url) };
    } catch (e) {
      if (isNearCause(e, "UNKNOWN_TRANSACTION")) return "unknown";
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function deriveKeypair(mnemonic: string, path: string = DERIVATION_PATH): {
  secret: Uint8Array;
  publicKey: Uint8Array;
} {
  const seed = mnemonicToSeedSync(mnemonic);
  const seedHex = Buffer.from(seed).toString("hex");
  const { key } = derivePath(path, seedHex);
  const publicKey = ed25519.getPublicKey(key);
  return { secret: new Uint8Array(key), publicKey };
}

/**
 * NEAR implicit account ID = hex-encoded ed25519 public key.
 * 64 lowercase hex characters.
 */
function nearImplicitAccount(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("hex");
}

export const nearAdapter: ChainAdapter = {
  chain: "near",
  displayName: "NEAR Protocol",
  ticker: "NEAR",
  color: "#00c08b",
  addressPlaceholder: "<64-char hex implicit account>",
  derivation: {
    kind: "bip39",
    path: "m/44'/397'/0'",
    standard: "NEAR CLI convention — 3 hardened steps, ed25519",
    hasAlternatives: false,
  },
  /** Arbitrary-path derivation — powers the generic finder + funded-path scan. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    const { secret, publicKey } = deriveKeypair(mnemonic, path);
    return {
      chain: "near",
      address: nearImplicitAccount(publicKey),
      mnemonic,
      privateKey: Buffer.from(secret).toString("hex"),
    };
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    // NEAR private keys are typically expressed as `ed25519:<base58>`
    // (64-byte expanded form) but we accept the raw 32-byte hex seed
    // shape here for symmetry with the other ed25519 adapters. The
    // 64-byte expanded import path can be added when a user actually
    // needs it.
    const clean = privateKey.startsWith("0x")
      ? privateKey.slice(2)
      : privateKey;
    const secret = new Uint8Array(clean.length / 2);
    for (let i = 0; i < secret.length; i++) {
      secret[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    if (secret.length !== 32) {
      throw new Error("NEAR secret must be 32 bytes");
    }
    const publicKey = ed25519.getPublicKey(secret);
    return {
      chain: "near",
      address: nearImplicitAccount(publicKey),
      mnemonic: "",
      privateKey: clean,
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const { secret, publicKey } = deriveKeypair(mnemonic);
    return {
      chain: "near",
      address: nearImplicitAccount(publicKey),
      mnemonic,
      privateKey: Buffer.from(secret).toString("hex"),
    };
  },

  /**
   * The SPENDABLE balance (2026-09-29 send-safety audit): `view_account`'s
   * `amount` minus the storage stake (see `nearAvailableYocto`). For an
   * ordinary implicit account that is about 0.00182 NEAR less than an
   * explorer's total. Used to be hard-coded "0" for every wallet.
   *
   * An account NEAR does not know yet (never funded) is a real 0; any failure
   * to reach a node throws, per the `getBalance` contract.
   */
  async getBalance(address: string): Promise<string> {
    const view = await viewNearAccount(address.trim());
    if (!view) return "0";
    return atomicToDecimal(nearAvailableYocto(view), NEAR_DECIMALS);
  },

  async sendTransaction(): Promise<TxResult> {
    // NEAR source-tx broadcast flows through
    // `swap-sources.ts::executeNearNativeTransfer`, which uses the
    // session-gated Rust signer (`swap_sign_near_tx`). The
    // dashboard's generic Send button is not wired for NEAR in v1.x.
    // Reachable only if something bypasses the app-layer override. The
    // dashboard Send for this chain goes through `sessionSignedSendOverride`
    // in App.tsx -> `features/swap/session-send.ts`, because the signer is
    // session-gated in Rust and an adapter cannot open a session without
    // importing the vault + swap layers (BOUNDARIES.md forbids that
    // direction). Wired 2026-09-02; before then this chain was receive-only.
    throw new Error(
      "NEAR send must go through the app-layer session override (App.tsx -> executeNearNativeTransfer) — the signer is session-gated."
    );
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    // No RPC call — adapters that can't reach a network return a
    // placeholder rather than block the dashboard's network-info row.
    return { label: "Network", value: "mainnet", unit: "" };
  },

  /**
   * From NearBlocks' receipt list (`near-history.ts`), since 2026-09-30.
   *
   * NEAR's public RPC has no per-account history. Until 2026-09-29 this
   * returned `{ items: [] }` ("No transactions yet", right after a send);
   * then it threw "…not available in this wallet yet…", which the Activity
   * header counted as an error (operator report 2026-09-30). A NearBlocks
   * failure still throws — never an empty list.
   */
  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<TxHistoryPage> {
    return fetchNearHistory(address.trim(), opts);
  },

  /**
   * NearBlocks first (the history's host, fetched directly the same way),
   * then the RPC nodes for this wallet's own fresh send (2026-09-30).
   *
   * `null` when NearBlocks answered that it does not have the hash and no
   * node knows it as this wallet's send. When NearBlocks FAILED, a node's
   * "unknown" settles nothing (the transaction may be someone else's, which
   * `tx` cannot find by this wallet's id), so that throws.
   */
  async getTransactionParties(hash: string, ownAddress: string): Promise<TxParties | null> {
    const id = hash.trim();
    const own = ownAddress.trim();
    let indexedError: unknown = null;
    try {
      const txn = await fetchNearblocksTxn(id);
      if (txn) return nearblocksTxnParties(txn, own);
    } catch (e) {
      indexedError = e;
    }
    let rpc: TxParties | "unknown";
    try {
      rpc = own ? await nearRpcOwnTxParties(id, own) : "unknown";
    } catch (e) {
      if (!indexedError) return null;
      throw new Error(
        `NEAR transaction ${id} could not be read: ${NEARBLOCKS_HOST}: ${errorText(indexedError)}; ` +
          `RPC nodes: ${errorText(e)}`,
      );
    }
    if (rpc !== "unknown") return rpc;
    if (!indexedError) return null;
    throw new Error(
      `NEAR transaction ${id} could not be read: ${NEARBLOCKS_HOST}: ${errorText(indexedError)} ` +
        `(and it is not a recent transaction of this wallet's)`,
    );
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    return {
      normal: { value: "0.0001" },
      unit: "NEAR",
      fetchedAt: Date.now(),
    };
  },
};
