/**
 * Stellar (XLM) ChainAdapter — Phase 6 (2026-05-08).
 *
 * Stellar is account-based with sequence numbers. Keys: ed25519. Addresses:
 * StrKey base32 with version byte 0x30 (account public key prefix → "G...").
 * Standard derivation: SLIP-0010 ed25519, path `m/44'/148'/0'`. Each segment
 * hardened (Phantom/Solflare-style).
 *
 * Source-tx signing happens in `src/features/swap/swap-sources.ts` via the
 * Rust `swap_sign_stellar_tx` command. This adapter handles the dashboard
 * surface: derive address, fetch balance from Horizon, paginate history.
 *
 * Send/receive UX in the wallet view is destination-only by default; a
 * direct send flow (XLM → arbitrary G-address) is wired through Horizon's
 * `/transactions` endpoint with a Payment operation.
 */

import { mnemonicToSeedSync } from "@scure/bip39";
import { derivePath } from "ed25519-hd-key";
import { ed25519 } from "@noble/curves/ed25519.js";
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
import { proxyGetJson } from "./_proxy";
import { condenseHttpError } from "./tx-history-errors";
import { uniqueAddresses } from "./parties-b-common";

const HORIZON_BASE = "https://horizon.stellar.org";
const HORIZON_HOST = "horizon.stellar.org";
const DERIVATION_PATH = "m/44'/148'/0'";

// =========================================================================
// StrKey codec (base32 + CRC16-XMODEM)
// =========================================================================
//
// StrKey layout: version byte (0x30 = account public key) || raw 32-byte
// key || 2-byte CRC16-XMODEM checksum, all base32-encoded with the
// standard alphabet (A-Z, 2-7, no padding).

const STRKEY_VERSION_ACCOUNT = 0x30;
const STRKEY_VERSION_SEED = 0xc0; // we never expose this — kept for completeness

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(data: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function base32Decode(s: string): Uint8Array {
  const cleaned = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base32 char: ${c}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc <<= 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

export function strkeyEncode(versionByte: number, payload: Uint8Array): string {
  const body = new Uint8Array(1 + payload.length);
  body[0] = versionByte;
  body.set(payload, 1);
  const crc = crc16Xmodem(body);
  const full = new Uint8Array(body.length + 2);
  full.set(body, 0);
  full[full.length - 2] = crc & 0xff;
  full[full.length - 1] = (crc >> 8) & 0xff;
  return base32Encode(full);
}

export function strkeyDecode(s: string): { versionByte: number; payload: Uint8Array } {
  const decoded = base32Decode(s);
  if (decoded.length < 3) throw new Error("StrKey too short");
  const versionByte = decoded[0];
  const payload = decoded.slice(1, decoded.length - 2);
  const provided = (decoded[decoded.length - 1] << 8) | decoded[decoded.length - 2];
  const computed = crc16Xmodem(decoded.slice(0, decoded.length - 2));
  if (provided !== computed) {
    throw new Error("StrKey checksum mismatch");
  }
  return { versionByte, payload };
}

// =========================================================================
// Key derivation
// =========================================================================

function deriveKeypair(mnemonic: string, path: string = DERIVATION_PATH): { secret: Uint8Array; publicKey: Uint8Array } {
  const seed = mnemonicToSeedSync(mnemonic);
  const seedHex = Buffer.from(seed).toString("hex");
  const { key } = derivePath(path, seedHex);
  // ed25519 secret here is the 32-byte seed; deriving the public key
  // requires running the ed25519 KDF (sha512 → clamp → scalar mult).
  // @noble/curves's `ed25519.getPublicKey` does exactly this.
  const publicKey = ed25519.getPublicKey(key);
  return { secret: key, publicKey };
}

function addressFromPublicKey(pk: Uint8Array): string {
  return strkeyEncode(STRKEY_VERSION_ACCOUNT, pk);
}

// =========================================================================
// Horizon API
// =========================================================================

interface HorizonAccount {
  id: string;
  account_id: string;
  sequence: string;
  balances: Array<{
    asset_type: string; // "native" | "credit_alphanum4" | "credit_alphanum12"
    balance: string;
    asset_code?: string;
    asset_issuer?: string;
  }>;
}

async function fetchAccount(addr: string): Promise<HorizonAccount> {
  // Horizon returns 404 for unfunded accounts.
  return proxyGetJson<HorizonAccount>(`${HORIZON_BASE}/accounts/${addr}`);
}

interface HorizonOperation {
  id: string;
  type: string;
  type_i: number;
  created_at: string;
  source_account: string;
  amount?: string;
  asset_type?: string;
  to?: string;
  from?: string;
  /** `create_account` names its parties and amount differently. */
  funder?: string;
  account?: string;
  starting_balance?: string;
  /** `account_merge`: the account that received the merged one's XLM. */
  into?: string;
  /** Path payments: the asset the sender paid (`asset_type` is the one delivered). */
  source_asset_type?: string;
  transaction_hash: string;
}

/**
 * One operation's value transfer: who paid, who was paid, and whether XLM
 * moved. `null` for operations that pay nobody (trust lines, offers, options,
 * sponsorship markers). `create_account` and `account_merge` name their
 * parties in fields of their own (`funder` / `account`, `account` / `into`).
 */
function operationTransfer(
  op: HorizonOperation,
): { from?: string; to?: string; native: boolean } | null {
  switch (op.type) {
    case "payment":
      return { from: op.from, to: op.to, native: op.asset_type === "native" };
    case "path_payment_strict_send":
    case "path_payment_strict_receive":
      return {
        from: op.from,
        to: op.to,
        native: op.asset_type === "native" || op.source_asset_type === "native",
      };
    case "create_account":
      return { from: op.funder, to: op.account, native: true };
    case "account_merge":
      return { from: op.account, to: op.into, native: true };
    default:
      return null;
  }
}

/**
 * A transaction's operations (Horizon `/transactions/{hash}/operations`, in
 * the transaction's order) as parties (2026-09-30). Exported for tests.
 *
 * XLM transfers are preferred over other assets' (this is the XLM adapter);
 * among them, the ones that involve `own`, else all — the rule the contract
 * gives token legs. A transaction that pays nobody names its source account
 * as the sender and no recipient.
 */
export function stellarOperationsParties(
  records: readonly HorizonOperation[],
  own: string,
  source?: string,
): TxParties | null {
  if (records.length === 0) return null;
  const src = source ? { source } : {};
  const transfers = records
    .map(operationTransfer)
    .filter((t): t is { from?: string; to?: string; native: boolean } => t !== null);
  const native = transfers.filter((t) => t.native);
  const pool = native.length > 0 ? native : transfers;
  const me = own.trim().toUpperCase();
  const mine = pool.filter((t) => t.from?.toUpperCase() === me || t.to?.toUpperCase() === me);
  const chosen = mine.length > 0 ? mine : pool;
  if (chosen.length === 0) {
    return { from: uniqueAddresses([records[0].source_account]), to: [], ...src };
  }
  return {
    from: uniqueAddresses(chosen.map((t) => t.from)),
    to: uniqueAddresses(chosen.map((t) => t.to)),
    ...src,
  };
}

/**
 * The ledger an operation closed in. Horizon's operation id is a TOID:
 * ledger sequence << 32 | transaction order << 12 | operation index.
 */
export function ledgerOfOperationId(id: string): number | undefined {
  if (!/^\d+$/.test(id)) return undefined;
  const ledger = Number(BigInt(id) >> 32n);
  return ledger > 0 ? ledger : undefined;
}

/** One Horizon effect, the fields a merge's amount is read from. */
interface HorizonEffect {
  type: string;
  account?: string;
  amount?: string;
  asset_type?: string;
}

/** Merged amounts already read, by operation id: an operation never changes. */
const mergedAmounts = new Map<string, string>();

/** For tests: forget the merged amounts read this session. */
export function clearStellarMergeCache(): void {
  mergedAmounts.clear();
}

/**
 * The XLM an `account_merge` moved (2026-10-01). The operation names only
 * its two accounts (`account` merged into `into`); the amount is in its
 * effects, read live for the public test seed's merge (94390a05…, operation
 * 275583690330103809):
 *
 *   account_debited             GB3JDW…  0.9998310 native
 *   account_credited            GCNAQJ…  0.9998310 native
 *   account_removed             GB3JDW…
 *   account_sponsorship_removed GB3JDW…
 *
 * `undefined` when the effects do not say; a failed read throws. One request
 * per merge, once per session.
 */
async function accountMergeAmount(op: HorizonOperation): Promise<string | undefined> {
  const known = mergedAmounts.get(op.id);
  if (known) return known;
  const r = await proxyGetJson<{ _embedded?: { records?: HorizonEffect[] } }>(
    `${HORIZON_BASE}/operations/${encodeURIComponent(op.id)}/effects?limit=50`,
  );
  const effects = r._embedded?.records ?? [];
  const native = (e: HorizonEffect) => (e.asset_type ?? "native") === "native";
  const amount =
    effects.find((e) => e.type === "account_credited" && e.account === op.into && native(e))?.amount ??
    effects.find((e) => e.type === "account_debited" && e.account === op.account && native(e))?.amount;
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) return undefined;
  mergedAmounts.set(op.id, amount);
  return amount;
}

async function fetchHistory(addr: string, limit = 25): Promise<ChainTx[]> {
  let r: { _embedded: { records: HorizonOperation[] } };
  try {
    r = await proxyGetJson(`${HORIZON_BASE}/accounts/${addr}/operations?limit=${limit}&order=desc`);
  } catch (e) {
    // An account nobody has funded does not exist yet: Horizon answers
    // 404, and that is an empty history. Any other failure is an error
    // (2026-09-30): this caught everything and returned no rows, so a
    // failed read looked like a wallet with no transactions.
    if (e instanceof Error && /^HTTP 404\b/.test(e.message)) return [];
    throw e;
  }
  const records = r._embedded?.records ?? [];
  const items: ChainTx[] = [];
  const me = addr.toUpperCase();
  for (const op of records) {
    const merge = op.type === "account_merge";
    if (op.type !== "payment" && op.type !== "create_account" && !merge) continue;
    if (op.asset_type && op.asset_type !== "native") continue;
    // An account's first funding is a `create_account`, whose parties and
    // amount are `funder` / `account` / `starting_balance`. Read as a
    // payment, it was "+0 XLM" received from nobody (2026-09-30).
    //
    // An `account_merge` moves the merged account's whole XLM balance into
    // `into` and deletes it. It was skipped until 2026-10-01 (operator
    // request), so the move that emptied an account never showed in
    // Activity. Its amount is read from its effects (`accountMergeAmount`);
    // when they cannot be read, the amount is "" — unknown, shown as "—" —
    // and asked again on the next read.
    const create = op.type === "create_account";
    const from = create ? op.funder : merge ? op.account : op.from;
    const to = create ? op.account : merge ? op.into : op.to;
    const direction = from && from.toUpperCase() === me ? "out" : "in";
    let amount = (create ? op.starting_balance : op.amount) ?? "0";
    if (merge) {
      try {
        amount = (await accountMergeAmount(op)) ?? "";
      } catch {
        amount = "";
      }
    }
    items.push({
      chain: "stellar",
      hash: op.transaction_hash,
      direction,
      amount,
      timestamp: Math.floor(new Date(op.created_at).getTime() / 1000),
      // Horizon lists closed ledgers only, and a closed ledger is final:
      // no count, the ledger as the block (a count of 1 read "1 / 6
      // pending" in the details).
      confirmations: undefined,
      height: ledgerOfOperationId(op.id),
      counterparty: direction === "out" ? to : from,
      meta: {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(merge ? { method: "account merge" } : {}),
      },
    });
  }
  return items;
}

// =========================================================================
// Adapter
// =========================================================================

export const stellarAdapter: ChainAdapter = {
  chain: "stellar",
  displayName: "Stellar",
  ticker: "XLM",
  color: "#7b86ff",
  addressPlaceholder: "G...",
  derivation: {
    kind: "bip39",
    path: "m/44'/148'/0'",
    standard: "SEP-0005 — all hardened, ed25519 SLIP-0010",
    hasAlternatives: false,
  },
  /**
   * The memo field (2026-09-29 send-safety audit). Exchanges receive every
   * customer's XLM at one account and credit the deposit by memo; before this
   * the Send modal had no memo field at all, so a deposit arrived without the
   * memo and was credited to nobody. A destination that publishes SEP-29's
   * `config.memo_required` is also refused without one (`session-send.ts`).
   * 28 bytes is Stellar's MEMO_TEXT limit.
   */
  memo: {
    label: "Memo",
    hint:
      "Required by most exchanges: use the memo they gave you, with the type they name (text or ID), or the XLM is credited to nobody. Leave empty for a personal wallet.",
    textMaxBytes: 28,
  },
  /** Arbitrary-path derivation — powers the generic finder + funded-path scan. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    const { secret, publicKey } = deriveKeypair(mnemonic, path);
    return {
      chain: "stellar",
      address: addressFromPublicKey(publicKey),
      mnemonic,
      privateKey: Buffer.from(secret).toString("hex"),
    };
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    // Stellar StrKey-encoded seed: starts with `S`. We accept either that
    // or a raw 32-byte hex secret.
    let secret: Uint8Array;
    if (privateKey.startsWith("S")) {
      const decoded = strkeyDecode(privateKey);
      if (decoded.versionByte !== STRKEY_VERSION_SEED) {
        throw new Error("Stellar private key must be a StrKey seed (S-prefix)");
      }
      secret = decoded.payload;
    } else {
      const clean = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
      secret = new Uint8Array(clean.length / 2);
      for (let i = 0; i < secret.length; i++) {
        secret[i] = parseInt(clean.substr(i * 2, 2), 16);
      }
    }
    if (secret.length !== 32) {
      throw new Error("Stellar secret must be 32 bytes");
    }
    const publicKey = ed25519.getPublicKey(secret);
    return {
      chain: "stellar",
      address: addressFromPublicKey(publicKey),
      mnemonic: "",
      privateKey: Buffer.from(secret).toString("hex"),
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const { secret, publicKey } = deriveKeypair(mnemonic);
    return {
      chain: "stellar",
      address: addressFromPublicKey(publicKey),
      mnemonic,
      privateKey: Buffer.from(secret).toString("hex"),
    };
  },

  async getBalance(address: string): Promise<string> {
    try {
      const account = await fetchAccount(address);
      const native = account.balances.find((b) => b.asset_type === "native");
      return native ? native.balance : "0";
    } catch (e) {
      // Unfunded accounts return 404 — that one IS a zero balance. Anything
      // else (429, 5xx, timeout) throws (2026-08-22) instead of reading as 0.
      const msg = e instanceof Error ? e.message : String(e);
      if (/\b404\b|not found/i.test(msg)) return "0";
      throw e;
    }
  },

  async sendTransaction(): Promise<TxResult> {
    // The dashboard send UX is wired through the swap source-tx pipeline
    // via `executeStellarTransfer` in `swap-sources.ts`. A direct
    // dashboard "Send" button uses the same Rust signer. For now,
    // surface a clear error so callers can explicitly route through the
    // swap helper.
    // Reachable only if something bypasses the app-layer override. The
    // dashboard Send for this chain goes through `sessionSignedSendOverride`
    // in App.tsx -> `features/swap/session-send.ts`, because the signer is
    // session-gated in Rust and an adapter cannot open a session without
    // importing the vault + swap layers (BOUNDARIES.md forbids that
    // direction). Wired 2026-09-02; before then this chain was receive-only.
    throw new Error(
      "Stellar send must go through the app-layer session override (features/swap/session-send.ts::executeStellarTransfer) — the signer is session-gated."
    );
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    return { label: "Base fee", value: "100", unit: "stroops/op" };
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    const items = await fetchHistory(address, limit);
    return { items };
  },

  /**
   * Horizon's operations for one transaction, through the proxy like every
   * other Horizon read (2026-09-30). 200 is Horizon's page maximum and a
   * transaction holds at most 100 operations, so one page is all of them.
   * An unknown hash is Horizon's 404 ("Resource Missing").
   */
  async getTransactionParties(hash: string, ownAddress: string): Promise<TxParties | null> {
    const id = hash.trim();
    let r: { _embedded?: { records?: HorizonOperation[] } };
    try {
      r = await proxyGetJson(
        `${HORIZON_BASE}/transactions/${encodeURIComponent(id)}/operations?limit=200`,
      );
    } catch (e) {
      if (e instanceof Error && /^HTTP 404\b/.test(e.message)) return null;
      throw new Error(`${HORIZON_HOST} could not read transaction ${id}: ${condenseHttpError(e)}`);
    }
    return stellarOperationsParties(r._embedded?.records ?? [], ownAddress, HORIZON_HOST);
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    return {
      normal: { value: "100" },
      unit: "stroops/op",
      fetchedAt: Date.now(),
    };
  },
};
