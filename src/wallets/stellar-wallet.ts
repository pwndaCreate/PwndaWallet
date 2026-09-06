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
} from "./types";
import { proxyGetJson } from "./_proxy";

const HORIZON_BASE = "https://horizon.stellar.org";
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
  transaction_hash: string;
}

async function fetchHistory(addr: string, limit = 25): Promise<ChainTx[]> {
  try {
    const r = await proxyGetJson<{
      _embedded: { records: HorizonOperation[] };
    }>(`${HORIZON_BASE}/accounts/${addr}/operations?limit=${limit}&order=desc`);
    const records = r._embedded?.records ?? [];
    const items: ChainTx[] = [];
    for (const op of records) {
      if (op.type !== "payment" && op.type !== "create_account") continue;
      if (op.asset_type && op.asset_type !== "native") continue;
      const direction =
        op.from && op.from.toUpperCase() === addr.toUpperCase() ? "out" : "in";
      items.push({
        chain: "stellar",
        hash: op.transaction_hash,
        direction,
        amount: op.amount ?? "0",
        timestamp: Math.floor(new Date(op.created_at).getTime() / 1000),
        confirmations: 1,
        counterparty: direction === "out" ? op.to : op.from,
      });
    }
    return items;
  } catch {
    return [];
  }
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

  async getFeeEstimate(): Promise<FeeEstimate> {
    return {
      normal: { value: "100" },
      unit: "stroops/op",
      fetchedAt: Date.now(),
    };
  },
};
