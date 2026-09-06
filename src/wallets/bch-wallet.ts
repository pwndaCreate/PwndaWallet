/**
 * Bitcoin Cash (BCH) ChainAdapter — full send + receive + history.
 *
 * Pure HTTP, no local node. UTXO listing, balance, broadcast, and fee
 * each rotate across multiple keyless public backends. A single endpoint
 * outage rolls over to the next without surfacing as a user-visible
 * failure.
 *
 * Network-side architecture (2026-04-27, reordered 2026-09-04):
 *   - haskoin-store  `api.blockchain.info/haskoin-store/bch` and
 *     `api.haskoin.com/bch` — PRIMARY for balance, used-ness, UTXO and
 *     history since 2026-09-04, and the account walk's batch probe (one
 *     request per block of addresses). Two deployments of one indexer.
 *   - Bitcore        `api.bitcore.io/api/BCH` — keyless, per-address,
 *     rate-limited (~10/burst); serialized through one queue below.
 *   - Blockchair    `api.blockchair.com/bitcoin-cash` — was primary for
 *     balance, history, fee, UTXO, broadcast; 430-blacklists shared IPs.
 *   - FullStack.cash `bchn.fullstack.cash/v4/electrumx` — DEAD since at
 *     least 2026-09-04 (every path serves the marketing SPA's HTML). Kept
 *     in ladders as a never-last entry; see `FULLSTACK_BASE`.
 *
 * Crypto path: BCH inputs require **SIGHASH_FORKID (0x40)** signing —
 * a BIP-143-style preimage with a 24-bit fork id (= 0 on mainnet)
 * packed into the high bits of the sighash byte. `bitcoinjs-lib` v7's
 * `Psbt` does not produce that signature; signing through it would
 * yield a tx every BCH node rejects (`mandatory-script-verify-flag-failed
 * (Signature must use SIGHASH_FORKID)`). Spec:
 * https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/replay-protected-sighash.md
 *
 * Rather than depend on `@psf/bch-js` (1.59 MB install, 124 transitive
 * deps, brings the SLP token surface we don't use), we hand-roll the
 * preimage + ECDSA signing + manual tx serializer. Everything sits
 * inline in this file: ~350 LOC of crypto code, no new deps. Reuses
 * `@noble/curves` and `@noble/hashes` which the rest of the wallet
 * already pulls in.
 *
 * Address format: CashAddr (`bitcoincash:q...` for P2PKH,
 * `bitcoincash:p...` for P2SH). Encoder + decoder + both type variants
 * implemented inline below; spec at
 * https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md.
 * Legacy base58check addresses (`1...`, `3...`) are also accepted as
 * recipients — the decoder transparently converts them via `bs58check`.
 */

import * as bitcoin from "bitcoinjs-lib";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import * as tinysecp from "tiny-secp256k1";
import ECPairFactory from "ecpair";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import bs58check from "bs58check";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
} from "./types";
import { proxyGetJson, httpProxyCall } from "./_proxy";
import type { UtxoAccountSpec } from "./utxo-account";
import {
  gatherAccountSpend,
  accountShortfallMessage,
  P2PKH_SIZING,
} from "./utxo-account";
import {
  parseEsploraStats,
  blockchairProbe,
  blockcypherProbe,
  haskoinProbe,
  haskoinProbeMany,
  type UtxoProbeResult,
} from "./_utxo-probes";

bitcoin.initEccLib(tinysecp);
const ECPair = ECPairFactory(tinysecp);

const BLOCKCHAIR_BASE = "https://api.blockchair.com/bitcoin-cash";
// DEAD as of 2026-09-04: every path under /v4/electrumx (balance, utxos, fee)
// answers HTTP 200 with the FullStack marketing SPA's HTML, not JSON, so every
// caller below throws and rotates. Kept rather than deleted so that if the API
// comes back this file needs no change, and so the next reader does not re-add
// it as a "missing" source. It must never be the LAST entry in a ladder: for a
// while it was, behind a 430-blocked Blockchair, which left BCH with no working
// source for UTXOs or broadcast at all. Verified with a direct fetch of all three.
const FULLSTACK_BASE = "https://bchn.fullstack.cash/v4/electrumx";
/**
 * haskoin-store (2026-09-04) — the primary BCH source for balance, `used`,
 * UTXOs and history, and the ONLY one with a batch balance endpoint. Two
 * independent public deployments of the same software, tried in order: the
 * one behind blockchain.com's own wallet, then the project's. Both answered
 * a 100-address batch in ~150 ms when measured; see `_utxo-probes.ts`.
 *
 * Why this exists: the gap walk needs ~90 answers per refresh, bitcore
 * rate-limits at ~10 per burst and Blockchair 430-blacklists the shared IP,
 * so the walk could not complete and a funded account read 0. With a batch
 * source the same walk is two requests.
 */
const HASKOIN_BASES = [
  "https://api.blockchain.info/haskoin-store/bch",
  "https://api.haskoin.com/bch",
] as const;
// Bitpay Bitcore — keyless public node API, no Cloudflare gate, and not subject
// to Blockchair's free-tier IP blacklist (HTTP 430) that used to blank BCH ("—")
// when the multi-chain sweep exhausted the shared Blockchair quota (2026-06-17).
// The reliable primary balance source. BCH addresses MUST be the bare CashAddr
// (no "bitcoincash:" scheme — Bitcore returns 0 for the prefixed form, verified
// live 2026-06-17). Returns {confirmed,unconfirmed,balance} in satoshis.
const BITCORE_BCH_BALANCE = (bareCashaddr: string) =>
  `https://api.bitcore.io/api/BCH/mainnet/address/${bareCashaddr}/balance`;
// Coin records (mints and spends) for one address. Non-empty ⇒ the address has
// history, which is what `used` means — see `bitcoreProbe`. Verified live
// 2026-09-04 against both a funded address (records) and a never-used one (`[]`).
const BITCORE_BCH_TXS = (bareCashaddr: string) =>
  `https://api.bitcore.io/api/BCH/mainnet/address/${bareCashaddr}/txs?limit=1`;
// Unspent coin records. Each carries mintTxid/mintIndex/value, which maps
// directly onto NormalizedUtxo. Verified live 2026-09-04.
const BITCORE_BCH_UTXOS = (bareCashaddr: string) =>
  `https://api.bitcore.io/api/BCH/mainnet/address/${bareCashaddr}/?unspent=true&limit=2000`;
const BITCORE_BCH_SEND = "https://api.bitcore.io/api/BCH/mainnet/tx/send";
const DERIVATION_PATH = "m/44'/145'/0'/0/0";
const CASHADDR_PREFIX = "bitcoincash";

// SIGHASH constants. BCH mainnet fork id = 0. SIGHASH_ALL | SIGHASH_FORKID
// is the standard sighash byte appended to every signature in the scriptSig.
const SIGHASH_ALL = 0x01;
const SIGHASH_FORKID = 0x40;
const BCH_SIGHASH = SIGHASH_ALL | SIGHASH_FORKID; // 0x41

// Standard 1-in 1-out P2PKH on BCH: ~192 bytes. Each extra input adds
// ~148 bytes; each extra output adds ~34 bytes. Used by the fee math.
const SOFT_DUST_SAT = 546n; // BCH's standard dust threshold

// =========================================================================
// Multi-source helper (mirrors `tryEach` in doge-wallet.ts)
// =========================================================================

async function tryEach<T>(
  sources: Array<{ name: string; fn: () => Promise<T> }>
): Promise<T> {
  let lastError: unknown = null;
  const tried: string[] = [];
  for (const s of sources) {
    tried.push(s.name);
    try {
      return await s.fn();
    } catch (e) {
      lastError = e;
    }
  }
  const tail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `All ${tried.length} BCH source(s) failed [${tried.join(", ")}]: ${tail}`
  );
}

// =========================================================================
// CashAddr — encoder, decoder, both type variants
// =========================================================================
//
// BCH addresses share bech32's 32-character `qpzry9x8gf2tvdw0s3jn54khce6mua7l`
// charset and similar polymod structure, but the polynomial constants and
// checksum length differ — they are NOT bech32-compatible. Spec:
// https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHARSET_REV: Record<string, number> = {};
for (let i = 0; i < CHARSET.length; i++) CHARSET_REV[CHARSET[i]] = i;

const POLY_C = [
  0x98f2bc8e61n,
  0x79b76d99e2n,
  0xf33e5fb3c4n,
  0xae2eabe2a8n,
  0x1e4f43e470n,
];

function cashaddrPolymod(values: ArrayLike<number>): bigint {
  let c = 1n;
  for (let i = 0; i < values.length; i++) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(values[i] & 0xff);
    for (let j = 0; j < 5; j++) {
      if ((c0 >> BigInt(j)) & 1n) c ^= POLY_C[j];
    }
  }
  return c ^ 1n;
}

/**
 * BIP-173-style 8↔5 bit regrouping. `pad=true` pads the final group
 * with zeros (used in encoding 8→5); `pad=false` errors if there are
 * leftover bits (used in decoding 5→8 — leftover bits indicate a
 * malformed address).
 */
function convertBits(
  data: ArrayLike<number>,
  from: number,
  to: number,
  pad: boolean
): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const value = data[i] & 0xff;
    if (value < 0 || value >> from !== 0) {
      throw new Error("convertBits: input out of range");
    }
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      result.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) result.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error("convertBits: invalid padding");
  }
  return result;
}

export type AddressType = "p2pkh" | "p2sh";

function versionByteFor(type: AddressType, hashLen: number): number {
  if (hashLen !== 20) {
    throw new Error(`CashAddr: only 20-byte hashes supported, got ${hashLen}`);
  }
  // Type bits 4-7, size bits 0-2. Size 0 = 160-bit hash.
  return type === "p2pkh" ? 0x00 : 0x08;
}

function typeFromVersionByte(version: number): AddressType {
  const type = (version >> 3) & 0x0f;
  if (type === 0) return "p2pkh";
  if (type === 1) return "p2sh";
  throw new Error(`CashAddr: unsupported address type ${type}`);
}

function hashSizeFromVersionByte(version: number): number {
  // sizes: 0→20, 1→24, 2→28, 3→32, 4→40, 5→48, 6→56, 7→64
  const sizeBits = version & 0x07;
  const sizes = [20, 24, 28, 32, 40, 48, 56, 64];
  return sizes[sizeBits];
}

/**
 * Encode a 20-byte hash as a mainnet CashAddr (`bitcoincash:` prefix,
 * `q` start for P2PKH, `p` start for P2SH).
 */
export function encodeCashAddr(hash: Uint8Array, type: AddressType): string {
  const versionByte = versionByteFor(type, hash.length);
  const payloadBytes = new Uint8Array(1 + hash.length);
  payloadBytes[0] = versionByte;
  payloadBytes.set(hash, 1);
  const payload5 = convertBits(payloadBytes, 8, 5, true);

  const prefix5 = new Array(CASHADDR_PREFIX.length);
  for (let i = 0; i < CASHADDR_PREFIX.length; i++) {
    prefix5[i] = CASHADDR_PREFIX.charCodeAt(i) & 0x1f;
  }
  const template = [...prefix5, 0, ...payload5, 0, 0, 0, 0, 0, 0, 0, 0];
  const poly = cashaddrPolymod(template);
  const checksum5: number[] = [];
  for (let i = 0; i < 8; i++) {
    checksum5.push(Number((poly >> BigInt(5 * (7 - i))) & 0x1fn));
  }
  const combined = [...payload5, ...checksum5];
  let body = "";
  for (let i = 0; i < combined.length; i++) body += CHARSET[combined[i]];
  return `${CASHADDR_PREFIX}:${body}`;
}

/**
 * Decode a CashAddr back to {type, hash}. Verifies polymod checksum and
 * version-byte length consistency. Accepts addresses with or without the
 * `bitcoincash:` prefix; rejects addresses for any other prefix
 * (`bchtest:`, `ecash:`, etc.) so we never sign sends on the wrong
 * network.
 */
export function decodeCashAddr(input: string): { type: AddressType; hash: Uint8Array } {
  const trimmed = input.trim().toLowerCase();
  let prefix = CASHADDR_PREFIX;
  let body = trimmed;
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx !== -1) {
    prefix = trimmed.slice(0, colonIdx);
    body = trimmed.slice(colonIdx + 1);
  }
  if (prefix !== CASHADDR_PREFIX) {
    throw new Error(
      `CashAddr: refusing to decode '${prefix}:' — only mainnet '${CASHADDR_PREFIX}:' is supported`
    );
  }

  const data: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const v = CHARSET_REV[body[i]];
    if (v === undefined) throw new Error(`CashAddr: invalid char '${body[i]}'`);
    data.push(v);
  }

  const prefix5 = new Array(prefix.length);
  for (let i = 0; i < prefix.length; i++) prefix5[i] = prefix.charCodeAt(i) & 0x1f;
  if (cashaddrPolymod([...prefix5, 0, ...data]) !== 0n) {
    throw new Error("CashAddr: bad checksum");
  }

  // Strip 8-symbol checksum, regroup 5→8.
  const payload5 = data.slice(0, -8);
  const payloadBytes = convertBits(payload5, 5, 8, false);
  const versionByte = payloadBytes[0];
  const hash = new Uint8Array(payloadBytes.slice(1));
  const expectedSize = hashSizeFromVersionByte(versionByte);
  if (hash.length !== expectedSize) {
    throw new Error(
      `CashAddr: hash length mismatch (got ${hash.length}, expected ${expectedSize})`
    );
  }
  return { type: typeFromVersionByte(versionByte), hash };
}

/**
 * Parse a recipient address that the user may have pasted in any
 * supported format: CashAddr (preferred), or legacy base58check
 * (`1...` for P2PKH, `3...` for P2SH). Returns the script pubkey
 * type and 20-byte hash160 — enough to build the output script.
 */
function parseRecipient(addr: string): { type: AddressType; hash: Uint8Array } {
  const trimmed = addr.trim();
  // CashAddr if it contains ':' or starts with charset chars after stripping
  if (trimmed.toLowerCase().includes(":") || trimmed.startsWith("q") || trimmed.startsWith("p")) {
    return decodeCashAddr(trimmed);
  }
  // Legacy base58check (BTC-style) — version 0x00 → P2PKH, 0x05 → P2SH.
  // Many BCH services still display these for backwards compat.
  let decoded: Uint8Array;
  try {
    decoded = bs58check.decode(trimmed);
  } catch {
    throw new Error(`Cannot parse address: ${trimmed}`);
  }
  if (decoded.length !== 21) throw new Error("Legacy address: bad length");
  const version = decoded[0];
  const hash = decoded.slice(1);
  if (version === 0x00) return { type: "p2pkh", hash };
  if (version === 0x05) return { type: "p2sh", hash };
  throw new Error(`Legacy address: unsupported version byte 0x${version.toString(16)}`);
}

// =========================================================================
// Hash + key helpers
// =========================================================================

function dsha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Compressed secp256k1 public key from a 32-byte private key. We compute
 * this through `tiny-secp256k1` (already used elsewhere in the wallet)
 * to stay consistent with the rest of the bitcoinjs-lib stack.
 */
function pubkeyFromPriv(privKey: Uint8Array): Uint8Array {
  const pub = (tinysecp as unknown as {
    pointFromScalar: (priv: Uint8Array, compressed: boolean) => Uint8Array | null;
  }).pointFromScalar(privKey, true);
  if (!pub) throw new Error("Invalid private key");
  return pub;
}

function getAddress(publicKey: Uint8Array): string {
  return encodeCashAddr(hash160(publicKey), "p2pkh");
}

// =========================================================================
// Tx serialization primitives
// =========================================================================
//
// We hand-roll the serializer instead of going through bitcoinjs-lib's
// `Transaction` class because we need full control over the FORKID
// sighash flow and bitcoinjs-lib's PSBT path is not FORKID-aware.

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function u8(n: number): Uint8Array {
  return new Uint8Array([n & 0xff]);
}

function u32LE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

function u64LE(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

function varInt(n: number): Uint8Array {
  if (n < 0xfd) return u8(n);
  if (n <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    new DataView(b.buffer).setUint16(1, n, true);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = new Uint8Array(5);
    b[0] = 0xfe;
    new DataView(b.buffer).setUint32(1, n >>> 0, true);
    return b;
  }
  const b = new Uint8Array(9);
  b[0] = 0xff;
  new DataView(b.buffer).setBigUint64(1, BigInt(n), true);
  return b;
}

function reverseBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

/** scriptPubKey for P2PKH: OP_DUP OP_HASH160 <20> hash OP_EQUALVERIFY OP_CHECKSIG */
function scriptP2PKH(hash: Uint8Array): Uint8Array {
  return concatBytes(u8(0x76), u8(0xa9), u8(0x14), hash, u8(0x88), u8(0xac));
}

/** scriptPubKey for P2SH: OP_HASH160 <20> hash OP_EQUAL */
function scriptP2SH(hash: Uint8Array): Uint8Array {
  return concatBytes(u8(0xa9), u8(0x14), hash, u8(0x87));
}

function outputScriptForRecipient(parsed: { type: AddressType; hash: Uint8Array }): Uint8Array {
  return parsed.type === "p2pkh" ? scriptP2PKH(parsed.hash) : scriptP2SH(parsed.hash);
}

// =========================================================================
// BIP-143-with-FORKID preimage + ECDSA signing
// =========================================================================

interface BchInput {
  txid: string;
  vout: number;
  /** Satoshi value of the input being spent. */
  value: bigint;
  sequence?: number;
}

interface BchOutput {
  value: bigint;
  scriptPubKey: Uint8Array;
}

/**
 * Build the BIP-143-with-FORKID preimage for a single input. The double
 * SHA-256 of this byte string is what gets ECDSA-signed and embedded in
 * the input's scriptSig along with the public key.
 *
 * Spec: https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/replay-protected-sighash.md
 *
 * Layout (little-endian where applicable):
 *   nVersion         4 bytes
 *   hashPrevouts    32 bytes (dSHA256 of every input outpoint)
 *   hashSequence    32 bytes (dSHA256 of every input nSequence)
 *   outpoint        36 bytes (this input's txid LE + vout LE)
 *   scriptCode      varlen  (the standard P2PKH script for this input)
 *   value            8 bytes (satoshi amount of this input)
 *   nSequence        4 bytes
 *   hashOutputs     32 bytes (dSHA256 of all serialized outputs)
 *   nLocktime        4 bytes
 *   sighashType      4 bytes (BCH_SIGHASH = 0x41 in low byte; fork id 0)
 */
function buildSighashPreimage(
  inputs: BchInput[],
  outputs: BchOutput[],
  inputIndex: number,
  scriptCode: Uint8Array,
  version: number,
  locktime: number
): Uint8Array {
  // hashPrevouts = dSHA256(concat( txid_LE | vout_LE for every input ))
  const prevoutsBuf = concatBytes(
    ...inputs.map((i) => concatBytes(reverseBytes(hexToBytes(i.txid)), u32LE(i.vout)))
  );
  const hashPrevouts = dsha256(prevoutsBuf);

  // hashSequence = dSHA256(concat( sequence_LE for every input ))
  const seqBuf = concatBytes(...inputs.map((i) => u32LE(i.sequence ?? 0xffffffff)));
  const hashSequence = dsha256(seqBuf);

  // hashOutputs = dSHA256(concat( value_LE | varlen(script) | script for every output ))
  const outsBuf = concatBytes(
    ...outputs.map((o) => concatBytes(u64LE(o.value), varInt(o.scriptPubKey.length), o.scriptPubKey))
  );
  const hashOutputs = dsha256(outsBuf);

  const input = inputs[inputIndex];
  return concatBytes(
    u32LE(version),
    hashPrevouts,
    hashSequence,
    reverseBytes(hexToBytes(input.txid)),
    u32LE(input.vout),
    varInt(scriptCode.length),
    scriptCode,
    u64LE(input.value),
    u32LE(input.sequence ?? 0xffffffff),
    hashOutputs,
    u32LE(locktime),
    u32LE(BCH_SIGHASH) // sighash type with FORKID; high 24 bits = fork id (0 mainnet)
  );
}

/**
 * ECDSA-sign a 32-byte digest with secp256k1, low-S DER. Append the
 * BCH sighash byte (0x41) and return the bytes that go directly into
 * the scriptSig as `<sig>`.
 */
function signSighash(digest: Uint8Array, privKey: Uint8Array): Uint8Array {
  const der = secp256k1.sign(digest, privKey, {
    format: "der",
    prehash: false,
    lowS: true,
  });
  return concatBytes(der, u8(BCH_SIGHASH));
}

/**
 * Serialize the final signed transaction as raw hex. Builds the standard
 * legacy (pre-segwit) Bitcoin tx layout — BCH never adopted segwit, so
 * there's no witness section.
 */
function serializeSignedTx(
  inputs: BchInput[],
  outputs: BchOutput[],
  scriptSigs: Uint8Array[],
  version: number,
  locktime: number
): string {
  const ins = concatBytes(
    varInt(inputs.length),
    ...inputs.map((inp, i) =>
      concatBytes(
        reverseBytes(hexToBytes(inp.txid)),
        u32LE(inp.vout),
        varInt(scriptSigs[i].length),
        scriptSigs[i],
        u32LE(inp.sequence ?? 0xffffffff)
      )
    )
  );
  const outs = concatBytes(
    varInt(outputs.length),
    ...outputs.map((o) => concatBytes(u64LE(o.value), varInt(o.scriptPubKey.length), o.scriptPubKey))
  );
  return bytesToHex(concatBytes(u32LE(version), ins, outs, u32LE(locktime)));
}

// =========================================================================
// Backend helpers — Blockchair + FullStack.cash
// =========================================================================

interface NormalizedUtxo {
  txid: string;
  vout: number;
  value: bigint;
}

interface BlockchairAddressEntry {
  address: { balance: number };
  transactions: string[];
  utxo?: Array<{ transaction_hash: string; index: number; value: number }>;
}

interface BlockchairTxEntry {
  transaction: { hash: string; time: string; block_id: number; fee: number };
  inputs: { recipient: string; value: number }[];
  outputs: { recipient: string; value: number }[];
}

// Balance ----------------------------------------------------------------

async function fetchBalanceBitcore(addr: string): Promise<string> {
  // Bitcore keys BCH by the bare CashAddr (no "bitcoincash:" scheme prefix) and
  // returns confirmed/unconfirmed/balance in satoshis (1 BCH = 1e8 sat).
  const bare = addr.replace(/^bitcoincash:/i, "");
  const r = await proxyGetJson<{
    confirmed?: number;
    unconfirmed?: number;
    balance?: number;
  }>(BITCORE_BCH_BALANCE(bare));
  const sat = (r.confirmed ?? 0) + (r.unconfirmed ?? 0);
  return (sat / 1e8).toFixed(8);
}

async function fetchBalanceBlockchair(addr: string): Promise<string> {
  const r = await proxyGetJson<{ data: Record<string, BlockchairAddressEntry> }>(
    `${BLOCKCHAIR_BASE}/dashboards/address/${addr}?limit=1`
  );
  const sat = r.data?.[addr]?.address?.balance ?? 0;
  return (sat / 1e8).toFixed(8);
}

async function fetchBalanceFullstack(addr: string): Promise<string> {
  const r = await proxyGetJson<{
    success: boolean;
    balance: { confirmed: number; unconfirmed: number };
  }>(`${FULLSTACK_BASE}/balance/${addr}`);
  if (!r.success) throw new Error("fullstack balance: success=false");
  return (((r.balance.confirmed ?? 0) + (r.balance.unconfirmed ?? 0)) / 1e8).toFixed(8);
}

// haskoin-store ------------------------------------------------------------
//
// Every shape below was captured from the live API on 2026-09-04 (see the
// vault log for that date), not inferred from documentation.

async function fetchBalanceHaskoin(base: string, addr: string): Promise<string> {
  const r = await haskoinProbe(base, addr);
  return (r.balanceSat / 1e8).toFixed(8);
}

/** `/address/{addr}/unspent` → `[{address, block:{height,position}, txid, index, pkscript, value}]`. */
async function fetchUtxosHaskoin(base: string, addr: string): Promise<NormalizedUtxo[]> {
  const rows = await proxyGetJson<Array<{ txid?: string; index?: number; value?: number }>>(
    `${base}/address/${addr}/unspent`,
  );
  if (!Array.isArray(rows)) throw new Error("haskoin unspent: unexpected shape");
  return rows
    .filter((u) => typeof u.txid === "string" && typeof u.value === "number")
    .map((u) => ({ txid: u.txid!, vout: u.index ?? 0, value: BigInt(u.value!) }));
}

/**
 * `POST /transactions` with the raw hex body → `{ txid }`.
 *
 * **Not verified against the live endpoint** — verifying a broadcast means
 * broadcasting, so it is proven by the first real send, like `broadcastBitcore`.
 * The body format (hex, or binary) is from haskoin-store's `Web.hs`
 * (`parseBody: bin b <> hex b`); the response shape is inferred from the
 * same file's `postTx` returning a `TxId`. A wrong guess fails loudly with
 * the endpoint's own status and body and rotates to the next source.
 */
async function broadcastHaskoin(base: string, rawHex: string): Promise<string> {
  const r = await httpProxyCall({
    method: "POST",
    url: `${base}/transactions`,
    body: rawHex,
    headers: { "Content-Type": "text/plain" },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`haskoin push HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(r.body) as { txid?: string };
  if (!parsed.txid) throw new Error(`haskoin push: no txid in ${r.body.slice(0, 200)}`);
  return parsed.txid;
}

/** One row of `/address/{addr}/transactions/full`, as captured live. */
interface HaskoinFullTx {
  txid: string;
  fee?: number;
  time?: number;
  block?: { height?: number; position?: number } | null;
  inputs?: Array<{ coinbase?: boolean; address?: string | null; value?: number }>;
  outputs?: Array<{ address?: string | null; value?: number }>;
}

/** `/address/{addr}/transactions/full?limit=&offset=`, newest first. */
async function fetchHistoryHaskoin(
  base: string,
  addr: string,
  limit: number,
  offset: number,
): Promise<HaskoinFullTx[]> {
  const rows = await proxyGetJson<HaskoinFullTx[]>(
    `${base}/address/${addr}/transactions/full?limit=${limit}&offset=${offset}`,
  );
  if (!Array.isArray(rows)) throw new Error("haskoin history: unexpected shape");
  return rows;
}

/** `/health` → `{ blocks: { blocks, headers, … }, … }`. */
async function fetchHeightHaskoin(base: string): Promise<number> {
  const r = await proxyGetJson<{ blocks?: { blocks?: number } }>(`${base}/health`);
  const h = r.blocks?.blocks;
  if (typeof h !== "number") throw new Error("haskoin health: no block height");
  return h;
}

// UTXOs ------------------------------------------------------------------

async function fetchUtxosBlockchair(addr: string): Promise<NormalizedUtxo[]> {
  const r = await proxyGetJson<{ data: Record<string, BlockchairAddressEntry> }>(
    `${BLOCKCHAIR_BASE}/dashboards/address/${addr}?limit=2000`
  );
  const utxos = r.data?.[addr]?.utxo ?? [];
  return utxos.map((u) => ({
    txid: u.transaction_hash,
    vout: u.index,
    value: BigInt(u.value),
  }));
}

async function fetchUtxosFullstack(addr: string): Promise<NormalizedUtxo[]> {
  const r = await proxyGetJson<{
    success: boolean;
    utxos?: Array<{ tx_hash: string; tx_pos: number; value: number }>;
  }>(`${FULLSTACK_BASE}/utxos/${addr}`);
  if (!r.success) throw new Error("fullstack utxos: success=false");
  return (r.utxos ?? []).map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_pos,
    value: BigInt(u.value),
  }));
}

// Broadcast --------------------------------------------------------------

async function broadcastBlockchair(rawHex: string): Promise<string> {
  const r = await httpProxyCall({
    method: "POST",
    url: `${BLOCKCHAIR_BASE}/push/transaction`,
    body: `data=${encodeURIComponent(rawHex)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`blockchair push HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(r.body) as {
    data?: { transaction_hash?: string };
    context?: { error?: string };
  };
  if (parsed.context?.error) throw new Error(`blockchair: ${parsed.context.error}`);
  const hash = parsed.data?.transaction_hash;
  if (!hash) throw new Error("blockchair push: no transaction_hash");
  return hash;
}

/**
 * Bitpay Bitcore broadcast — `POST /tx/send` with `{ rawTx }`, returns `{ txid }`.
 *
 * **Not verified against the live endpoint**, unlike this file's other Bitcore
 * calls (balance, coin records and unspents were each fetched for real on
 * 2026-09-04). Verifying a broadcast means broadcasting, which is not something
 * to do for a test. It sits BEHIND Blockchair in the ladder for that reason.
 *
 * It is still worth having: before this, the broadcast ladder was Blockchair
 * (430-blocked) followed by FullStack (dead), i.e. no working path at all. A
 * wrong guess here fails loudly with the endpoint's own status and body, which
 * is strictly better than the empty ladder it replaces — but treat the first
 * real BCH send as the thing that confirms it.
 */
async function broadcastBitcore(rawHex: string): Promise<string> {
  const r = await httpProxyCall({
    method: "POST",
    url: BITCORE_BCH_SEND,
    body: JSON.stringify({ rawTx: rawHex }),
    headers: { "Content-Type": "application/json" },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`bitcore push HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(r.body) as { txid?: string; txid$?: string };
  const txid = parsed.txid ?? parsed.txid$;
  if (!txid) throw new Error(`bitcore push: no txid in ${r.body.slice(0, 200)}`);
  return txid;
}

async function broadcastFullstack(rawHex: string): Promise<string> {
  // FullStack's bch-api accepts POST { txHex } at /tx/broadcast.
  const r = await httpProxyCall({
    method: "POST",
    url: `${FULLSTACK_BASE}/tx/broadcast`,
    body: JSON.stringify({ txHex: rawHex }),
    headers: { "Content-Type": "application/json" },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`fullstack push HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(r.body) as {
    success?: boolean;
    txid?: string;
    error?: string;
  };
  if (parsed.error) throw new Error(`fullstack push: ${parsed.error}`);
  if (!parsed.txid) throw new Error("fullstack push: no txid");
  return parsed.txid;
}

// Fee oracle -------------------------------------------------------------

async function fetchFeeRateBlockchair(): Promise<number> {
  const r = await proxyGetJson<{
    data: { suggested_transaction_fee_per_byte_sat?: number };
  }>(`${BLOCKCHAIR_BASE}/stats`);
  const perByte = r.data?.suggested_transaction_fee_per_byte_sat;
  if (!perByte || perByte <= 0) throw new Error("blockchair fee: invalid");
  return Math.max(perByte, 1);
}

async function fetchFeeRateFullstack(): Promise<number> {
  // FullStack's bch-api `/tx/fee-rate` doesn't exist; ElectrumX
  // doesn't expose a per-byte fee. We treat 1 sat/B as the safe BCH
  // default (next-block in 2026 mempool conditions).
  return 1;
}

// =========================================================================
// Adapter
// =========================================================================

/**
 * Balance + history-existence for one BCH address.
 *
 * Blockchair keys its response by the address form IT chose, which for BCH is
 * the CashAddr WITHOUT the `bitcoincash:` prefix even when asked with it — so
 * both forms are offered as lookup keys. Getting this wrong reads as "address
 * missing from response", which correctly rotates rather than reporting zero,
 * but would burn the good source for no reason.
 */
async function probeBchAddress(address: string): Promise<UtxoProbeResult> {
  const bare = address.includes(":") ? address.split(":")[1] : address;
  return tryEach<UtxoProbeResult>([
    // haskoin first (2026-09-04): balance AND history in one call, no
    // rate-limit at the walk's request volume, two independent deployments.
    { name: "haskoin", fn: () => haskoinProbe(HASKOIN_BASES[0], address) },
    { name: "haskoin-2", fn: () => haskoinProbe(HASKOIN_BASES[1], address) },
    // Bitcore next, for exactly the reason `getBalance` already gives: Blockchair
    // 430-blacklists the shared free-tier IP under a multi-chain sweep.
    //
    // 2026-09-04: this probe had Blockchair as its ONLY source while `getBalance`
    // — the other half of the same question — had already been hardened with
    // Bitcore in front of it. So the dashboard (which routes UTXO chains through
    // this probe, not through getBalance) read 0 for a funded BCH account while
    // the derivation scanner, which calls getBalance directly, reported the real
    // balance at the very same address. Confirmed live: Blockchair answered
    // `HTTP 430 "Your IP address is temporary blacklisted"` while Bitcore
    // returned 63891881 sat for the address the UI was showing as empty.
    //
    // Two paths answering one question, one hardened and one not, is the
    // half-wired-site shape this repo keeps finding — here it cost a user a
    // wallet that said zero over real funds.
    { name: "bitcore", fn: () => bitcoreProbe(bare) },
    { name: "blockchair", fn: () => blockchairProbe(BLOCKCHAIR_BASE, address, bare) },
  ]);
}

/**
 * Batch probe for the account walk — a whole block of addresses per request.
 * Throws when BOTH haskoin deployments fail, at which point `probeAddresses`
 * falls back to `probeBchAddress` per address for that block.
 */
async function probeBchAddresses(addresses: string[]): Promise<UtxoProbeResult[]> {
  return tryEach<UtxoProbeResult[]>([
    { name: "haskoin", fn: () => haskoinProbeMany(HASKOIN_BASES[0], addresses) },
    { name: "haskoin-2", fn: () => haskoinProbeMany(HASKOIN_BASES[1], addresses) },
  ]);
}

// =========================================================================
// Bitcore pacing — why every bitcore call goes through one queue
// =========================================================================
//
// A gap walk probes DEFAULT_GAP_LIMIT (40) consecutive unused addresses on
// each of the receive and change chains, so a single balance refresh is 80+
// requests. Bitcore rate-limits hard: measured 2026-09-04 against distinct
// addresses, 60 requests at concurrency 6 returned **10 OK and 50 HTTP 429**,
// and even concurrency 2 with a 120 ms delay still lost 26 of 60.
//
// That mattered far more than "some probes are slow", because
// `resolveUtxoAccountBalance` bails the whole walk the moment one probe fails
// (`complete = false`), and `App.tsx` THROWS on an incomplete scan rather than
// show a lower bound as a balance. With Blockchair simultaneously 430-blocked,
// both sources failed, so BCH showed 0 over real funds -- and it could never
// recover, because a deep scan that never completes is never persisted, so the
// next refresh runs the same doomed deep scan again.
//
// A 429 is the server saying "slow down", not "no". Treating it as a hard
// failure is what turned a pacing problem into a wrong balance.
//
// An earlier attempt to rule rate-limiting out measured the SAME address 50
// times and saw zero failures -- a cached response, i.e. a check that could not
// fail for the reason it was run. Distinct addresses are the only meaningful
// test here.
const BITCORE_MIN_INTERVAL_MS = 130;
const BITCORE_MAX_ATTEMPTS = 5;
let bitcoreQueue: Promise<unknown> = Promise.resolve();
let bitcoreLastAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for the shapes `proxyGetJson` produces on a throttle response. */
function isRateLimited(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes("429") || /rate limit/i.test(m);
}

/**
 * Every bitcore request, serialized behind one queue with a minimum spacing and
 * exponential backoff on 429. Serialized rather than merely throttled because
 * the limit is server-side and global to this client — running two "paced"
 * callers concurrently just halves the spacing.
 */
async function bitcoreGet<T>(url: string): Promise<T> {
  const run = async (): Promise<T> => {
    for (let attempt = 0; attempt < BITCORE_MAX_ATTEMPTS; attempt++) {
      const wait = bitcoreLastAt + BITCORE_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      bitcoreLastAt = Date.now();
      try {
        return await proxyGetJson<T>(url);
      } catch (e) {
        // Only a throttle is retried. A 404/500/parse error is a real answer
        // and must rotate to the next source immediately.
        if (!isRateLimited(e) || attempt === BITCORE_MAX_ATTEMPTS - 1) throw e;
        await sleep(400 * 2 ** attempt); // 400, 800, 1600, 3200 ms
      }
    }
    throw new Error("bitcore: retries exhausted");
  };
  // Chain onto the queue whether the previous call resolved or rejected.
  const p = bitcoreQueue.then(run, run);
  bitcoreQueue = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/**
 * Bitcore probe: balance always, `used` only when it can be established.
 *
 * `used` (not the balance) drives the gap walk — see `utxo-account.ts`, and the
 * 2026-08-22 LTC incident where funds sat at change index 20. An address that
 * received and spent everything is `used` with a zero balance, and reporting it
 * as unused truncates the scan exactly where activity is densest. So this never
 * infers `used: false` from a zero balance:
 *
 *   - balance > 0  ⇒ used, trivially, and no second request is made.
 *   - balance == 0 ⇒ ask for coin records. Non-empty ⇒ used. `[]` ⇒ genuinely
 *     unused (verified against a never-used address, which returns `[]` rather
 *     than an error).
 *
 * Anything unparseable throws, so `tryEach` rotates to the next source rather
 * than a guess being recorded as fact.
 */
async function bitcoreProbe(bare: string): Promise<UtxoProbeResult> {
  // ── Order matters for COST, and the cheap case is the common one ────────
  //
  // Blockchair answered balance and history in ONE call. Bitcore needs two
  // endpoints, so which one goes first decides how many requests a scan makes.
  //
  // A gap walk is overwhelmingly UNUSED addresses: it only stops after
  // DEFAULT_GAP_LIMIT consecutive unused ones, so every completed walk ends
  // with a run of them, and most probed addresses in any account are empty.
  // Asking `/balance` first meant every one of those cost two requests (zero
  // balance, then a history lookup to prove "unused" rather than assume it) —
  // doubling the request count of the exact case that dominates.
  //
  // `/txs?limit=1` collapses it: an empty array is BOTH "no balance" and "never
  // used", settled in one call. Only an address with history needs the second
  // request, and there are few of those. So: 1 call for unused, 2 for used,
  // instead of 2 for unused and 1 for funded.
  const coins = await bitcoreGet<unknown>(BITCORE_BCH_TXS(bare));
  if (!Array.isArray(coins)) {
    // Cannot establish history ⇒ cannot answer honestly ⇒ rotate to the next
    // source rather than record a guess as fact.
    throw new Error("bitcore probe: unexpected coin-record shape");
  }
  if (coins.length === 0) return { balanceSat: 0, used: false };

  // Has history. `used` is settled; ask for the authoritative balance rather
  // than summing coin records here — the endpoint already nets spends, and
  // reimplementing that netting is how two balance figures come to disagree.
  const b = await bitcoreGet<{
    confirmed?: number;
    unconfirmed?: number;
  }>(BITCORE_BCH_BALANCE(bare));
  const balanceSat = (b.confirmed ?? 0) + (b.unconfirmed ?? 0);
  if (!Number.isFinite(balanceSat)) {
    throw new Error("bitcore probe: non-numeric balance");
  }
  return { balanceSat, used: true };
}

/** Unspent coin records → NormalizedUtxo. */
async function fetchUtxosBitcore(addr: string): Promise<NormalizedUtxo[]> {
  const bare = addr.includes(":") ? addr.split(":")[1] : addr;
  const coins = await proxyGetJson<
    Array<{ mintTxid?: string; mintIndex?: number; value?: number }>
  >(BITCORE_BCH_UTXOS(bare));
  if (!Array.isArray(coins)) throw new Error("bitcore utxos: unexpected shape");
  return coins
    .filter((c) => typeof c.mintTxid === "string" && typeof c.value === "number")
    .map((c) => ({
      txid: c.mintTxid!,
      vout: c.mintIndex ?? 0,
      value: BigInt(c.value!),
    }));
}

/**
 * Bitcoin Cash's single BIP-44 account.
 *
 * BCH is not shared with the swap engine at all (BasicSwap has no light mode
 * and no remote-RPC option for it — it would need a local pruned BCHN), so
 * nothing external spends these keys today. The account is still what gets
 * scanned, for the same reason as DOGE and DASH.
 */
export const bchUtxoAccounts: UtxoAccountSpec[] = [
  {
    chain: "bitcoin-cash",
    accountPath: "m/44'/145'/0'",
    label: "BIP-44 legacy (CashAddr)",
    deriveAddress: (node) => getAddress(node.publicKey!),
    probe: probeBchAddress,
    probeMany: probeBchAddresses,
    batchSize: 50,
  },
];

/**
 * Spend from the whole BCH account.
 *
 * See `sendLtcFromAccount` in `ltc-wallet.ts` for the rationale and the survey
 * of how other wallets do this; the scan/derive/select half is shared
 * (`gatherAccountSpend`).
 *
 * # The one thing that is genuinely different here
 *
 * BCH does not go through PSBT at all — `bitcoinjs-lib` cannot produce
 * SIGHASH_FORKID signatures, so this file hand-rolls the BIP-143-with-FORKID
 * preimage (see the module header). The single-key `sendTransaction` above
 * passes `senderScript` as the **scriptCode for every input**, which is correct
 * only because every input belongs to one address.
 *
 * Account-wide, that assumption breaks: the scriptCode committed to in input
 * *i*'s preimage must be the scriptPubKey of the output *i* actually spends. Reuse
 * one address's script across inputs from several addresses and every
 * signature but one is invalid — and it fails at RELAY time, after broadcast,
 * with a generic script error rather than anywhere useful. Hence the per-input
 * `scriptCode` below, derived from each input's own key.
 */
export async function sendBchFromAccount(
  mnemonic: string,
  to: string,
  amount: string,
  opts?: { feeRateOverride?: number; gapLimit?: number; fromAddress?: string },
): Promise<TxResult> {
  const spec = bchUtxoAccounts[0];
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const account = HDKey.fromMasterSeed(seed).derive(spec.accountPath);
  const primaryAddress = spec.deriveAddress(account.deriveChild(0).deriveChild(0));
  if (opts?.fromAddress && opts.fromAddress !== primaryAddress) {
    throw new Error(
      `${opts.fromAddress} is not this seed's index-0 BCH address ` +
        `(${primaryAddress}). Nothing was sent.`,
    );
  }

  const sendSatNum = Math.round(parseFloat(amount) * 1e8);
  if (!Number.isFinite(sendSatNum) || sendSatNum <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  // BCH has no real fee market — every backend defaults to 1 sat/B and the
  // mempool clears next block. Query anyway to honour an uptick. sat/B and
  // sat/vB are the same number on a chain with no witness discount.
  let feePerVB = opts?.feeRateOverride ?? 1;
  if (opts?.feeRateOverride === undefined) {
    try {
      feePerVB = Math.max(
        await tryEach([
          { name: "blockchair", fn: () => fetchFeeRateBlockchair() },
          { name: "fullstack", fn: () => fetchFeeRateFullstack() },
        ]),
        1,
      );
    } catch {
      /* keep 1 sat/B */
    }
  }

  // Change goes to the internal chain's lowest unused index (2026-09-04) —
  // the BIP-44 rule every surveyed wallet and the swap engine follow — not
  // back to the displayed address. See `nextChangeIndex` in utxo-account.ts.
  const { plan, sources, change } = await gatherAccountSpend({
    mnemonic,
    spec,
    sendSat: sendSatNum,
    feePerVB,
    sizing: P2PKH_SIZING,
    dustSat: Number(SOFT_DUST_SAT),
    gapLimit: opts?.gapLimit,
    fetchUtxos: async (address) => {
      const utxos = await tryEach([
        { name: "haskoin", fn: () => fetchUtxosHaskoin(HASKOIN_BASES[0], address) },
        { name: "haskoin-2", fn: () => fetchUtxosHaskoin(HASKOIN_BASES[1], address) },
        { name: "bitcore", fn: () => fetchUtxosBitcore(address) },
        // FullStack is DEAD (serves HTML) and must never be last — see
        // FULLSTACK_BASE. Blockchair is alive but 430-blacklists shared IPs.
        { name: "fullstack", fn: () => fetchUtxosFullstack(address) },
        { name: "blockchair", fn: () => fetchUtxosBlockchair(address) },
      ]);
      // bigint here, number in the shared planner. Check BEFORE narrowing.
      return utxos.map((u) => {
        if (u.value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(
            `Output ${u.txid}:${u.vout} exceeds 2^53 sats and cannot be ` +
              "selected safely. Nothing was sent.",
          );
        }
        return { txid: u.txid, vout: u.vout, valueSat: Number(u.value) };
      });
    },
  });

  if (!plan.covered) {
    const held = plan.inputs.reduce((t, i) => t + i.valueSat, 0);
    throw new Error(accountShortfallMessage(plan, held, plan.inputs.length, "BCH"));
  }

  // One key + its own scriptPubKey per funding address. `scriptCode` for a
  // single-key P2PKH input is that output's scriptPubKey, so this map IS the
  // per-input scriptCode table the preimage needs.
  const keys = new Map<string, { priv: Uint8Array; pub: Uint8Array; script: Uint8Array }>();
  for (const input of plan.inputs) {
    if (keys.has(input.address)) continue;
    const src = sources.get(input.address);
    if (!src) throw new Error(`No signer for ${input.address}; nothing was sent.`);
    const priv = src.node.privateKey!;
    const pub = pubkeyFromPriv(priv);
    keys.set(input.address, { priv, pub, script: scriptP2PKH(hash160(pub)) });
  }

  const inputs: BchInput[] = plan.inputs.map((i) => ({
    txid: i.txid,
    vout: i.vout,
    value: BigInt(i.valueSat),
  }));
  const outputs: BchOutput[] = [
    { value: BigInt(sendSatNum), scriptPubKey: outputScriptForRecipient(parseRecipient(to)) },
  ];
  if (plan.changeSat > 0) {
    outputs.push({
      value: BigInt(plan.changeSat),
      scriptPubKey: outputScriptForRecipient(parseRecipient(change.address)),
    });
  }

  const VERSION = 2;
  const LOCKTIME = 0;
  const scriptSigs: Uint8Array[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const k = keys.get(plan.inputs[i].address)!;
    const preimage = buildSighashPreimage(
      inputs,
      outputs,
      i,
      k.script, // THIS input's script, not the wallet's — see the doc above
      VERSION,
      LOCKTIME,
    );
    const sig = signSighash(dsha256(preimage), k.priv);
    scriptSigs.push(concatBytes(u8(sig.length), sig, u8(k.pub.length), k.pub));
  }

  const rawHex = serializeSignedTx(inputs, outputs, scriptSigs, VERSION, LOCKTIME);
  return { hash: await broadcastBch(rawHex) };
}

/**
 * The one broadcast ladder, shared by both send paths so they cannot drift.
 *
 * Order: the two sources whose call shape is documented (Blockchair's is
 * verified, though its free tier 430-blacklists shared IPs; Bitcore's is
 * documented but unverified), then haskoin's two deployments (unverified, see
 * `broadcastHaskoin`), then FullStack — which is DEAD and, per the rule on
 * `FULLSTACK_BASE`, must never be the last entry, so Blockchair-via-form-post
 * is not repeated after it. A ladder that ends on a dead source is no ladder.
 */
async function broadcastBch(rawHex: string): Promise<string> {
  return tryEach([
    { name: "blockchair", fn: () => broadcastBlockchair(rawHex) },
    { name: "bitcore", fn: () => broadcastBitcore(rawHex) },
    { name: "fullstack", fn: () => broadcastFullstack(rawHex) },
    { name: "haskoin", fn: () => broadcastHaskoin(HASKOIN_BASES[0], rawHex) },
    { name: "haskoin-2", fn: () => broadcastHaskoin(HASKOIN_BASES[1], rawHex) },
  ]);
}

export const bchAdapter: ChainAdapter = {
  /** BCH has one account; account-wide send serves any wallet on it. */
  supportsAccountSend(mnemonic: string, address: string) {
    const spec = bchUtxoAccounts[0];
    const seed = mnemonicToSeedSync(mnemonic.trim(), "");
    const node = HDKey.fromMasterSeed(seed)
      .derive(spec.accountPath)
      .deriveChild(0)
      .deriveChild(0);
    return spec.deriveAddress(node) === address;
  },

  /** Account-wide send — see `sendBchFromAccount`. */
  sendFromAccount(mnemonic: string, to: string, amount: string, fromAddress?: string) {
    return sendBchFromAccount(mnemonic, to, amount, { fromAddress });
  },
  utxoAccounts: bchUtxoAccounts,
  chain: "bitcoin-cash",
  displayName: "Bitcoin Cash",
  ticker: "BCH",
  color: "#0ac18e",
  addressPlaceholder: "bitcoincash:q...",
  derivation: {
    kind: "bip39",
    path: "m/44'/145'/0'/0/0",
    standard: "BIP-44 coin type 145 — Electron Cash",
    hasAlternatives: true,
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const privKeyBytes = hexToBytes(privateKey);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes));
    const address = getAddress(keyPair.publicKey);
    return {
      chain: "bitcoin-cash",
      address,
      mnemonic: "",
      privateKey: bytesToHex(privKeyBytes),
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveAtPath!(mnemonic, DERIVATION_PATH);
  },

  /**
   * Derive at an arbitrary HD path. Same secp256k1 walk + address encoding as
   * the default path — only the path varies — so the generic finder and the
   * funded-path scan work here with no chain-specific code.
   */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    const seed = mnemonicToSeedSync(mnemonic.trim(), "");
    const root = HDKey.fromMasterSeed(seed);
    const child = root.derive(path);
    const address = getAddress(child.publicKey!);
    return {
      chain: "bitcoin-cash",
      address,
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(child.privateKey!),
    };
  },

  async getBalance(address: string): Promise<string> {
    return tryEach([
      // haskoin first (2026-09-04): same source the account walk uses, so a
      // single-address read and the dashboard's account read cannot disagree
      // because they asked different indexers.
      { name: "haskoin", fn: () => fetchBalanceHaskoin(HASKOIN_BASES[0], address) },
      { name: "haskoin-2", fn: () => fetchBalanceHaskoin(HASKOIN_BASES[1], address) },
      // Bitcore next — keyless, no Cloudflare gate, immune to Blockchair's 430
      // IP blacklist that used to blank BCH under a multi-chain refresh.
      { name: "bitcore", fn: () => fetchBalanceBitcore(address) },
      // FullStack is DEAD (HTML) and must never be last — see FULLSTACK_BASE.
      { name: "fullstack", fn: () => fetchBalanceFullstack(address) },
      { name: "blockchair", fn: () => fetchBalanceBlockchair(address) },
    ]);
  },

  /**
   * Build, sign (with SIGHASH_FORKID), and broadcast a P2PKH spend.
   *
   * Steps:
   *   1. UTXO listing across Blockchair → FullStack.
   *   2. Greedy input selection sized against a 1 sat/B fee oracle.
   *   3. For each input, compute the BIP-143-with-FORKID sighash and
   *      ECDSA-sign with low-S DER; embed `<sig+0x41> <pubkey>` as the
   *      scriptSig.
   *   4. Serialize the legacy (pre-segwit) raw tx.
   *   5. Broadcast across Blockchair → FullStack.
   *
   * Recipient parsing accepts CashAddr (`bitcoincash:q...` for P2PKH,
   * `bitcoincash:p...` for P2SH) or legacy base58check (`1...` / `3...`)
   * — see `parseRecipient`.
   */
  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    const privKey = hexToBytes(privateKey);
    const pubKey = pubkeyFromPriv(privKey);
    const senderHash = hash160(pubKey);
    const senderAddr = encodeCashAddr(senderHash, "p2pkh");
    const senderScript = scriptP2PKH(senderHash);

    const recipient = parseRecipient(to);
    const recipientScript = outputScriptForRecipient(recipient);

    // 1) UTXOs (multi-source). Same ladder as the account-wide path.
    const utxos = await tryEach([
      { name: "haskoin", fn: () => fetchUtxosHaskoin(HASKOIN_BASES[0], senderAddr) },
      { name: "haskoin-2", fn: () => fetchUtxosHaskoin(HASKOIN_BASES[1], senderAddr) },
      { name: "bitcore", fn: () => fetchUtxosBitcore(senderAddr) },
      { name: "fullstack", fn: () => fetchUtxosFullstack(senderAddr) },
      { name: "blockchair", fn: () => fetchUtxosBlockchair(senderAddr) },
    ]);
    if (utxos.length === 0) {
      throw new Error("No spendable UTXOs available for this address.");
    }

    // 2) Fee rate (sat/B). BCH has no real fee market in 2026 — every
    //    backend defaults to 1 sat/B and the mempool clears in the next
    //    block. We still query the oracle to honor any uptick.
    let feeSatPerB = 1;
    try {
      feeSatPerB = Math.max(
        await tryEach([
          { name: "blockchair", fn: () => fetchFeeRateBlockchair() },
          { name: "fullstack", fn: () => fetchFeeRateFullstack() },
        ]),
        1
      );
    } catch {
      /* keep 1 sat/B */
    }

    const sendSat = BigInt(Math.round(parseFloat(amount) * 1e8));
    if (sendSat <= 0n) throw new Error("Amount must be greater than zero.");

    // 3) Input selection (largest-first), sized against actual byte count.
    const sortedUtxos = [...utxos].sort((a, b) =>
      a.value < b.value ? 1 : a.value > b.value ? -1 : 0
    );
    const selected: NormalizedUtxo[] = [];
    let total = 0n;
    let estimatedBytes = 192;
    let feeSat = BigInt(estimatedBytes * feeSatPerB);
    for (const u of sortedUtxos) {
      selected.push(u);
      total += u.value;
      // 1 P2PKH input ≈ 148 bytes signed; overhead/output = 44; with
      // change output = +34; total ≈ 10 + 148*N + 34*outputCount.
      estimatedBytes = 10 + 148 * selected.length + 34 * 2;
      feeSat = BigInt(estimatedBytes * feeSatPerB);
      if (total >= sendSat + feeSat) break;
    }
    if (total < sendSat + feeSat) {
      throw new Error(
        `Insufficient funds. Have ${(Number(total) / 1e8).toFixed(8)} BCH, ` +
          `need ${(Number(sendSat + feeSat) / 1e8).toFixed(8)} BCH ` +
          `(incl. ~${(Number(feeSat) / 1e8).toFixed(8)} fee).`
      );
    }

    // 4) Build inputs + outputs.
    const inputs: BchInput[] = selected.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
    }));
    const outputs: BchOutput[] = [{ value: sendSat, scriptPubKey: recipientScript }];
    const change = total - sendSat - feeSat;
    if (change >= SOFT_DUST_SAT) {
      outputs.push({ value: change, scriptPubKey: senderScript });
    }

    // 5) Sign each input with FORKID sighash. scriptCode for a single-key
    //    P2PKH input is just the prev output's scriptPubKey.
    const VERSION = 2;
    const LOCKTIME = 0;
    const scriptSigs: Uint8Array[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const preimage = buildSighashPreimage(
        inputs,
        outputs,
        i,
        senderScript,
        VERSION,
        LOCKTIME
      );
      const digest = dsha256(preimage);
      const sig = signSighash(digest, privKey);
      // scriptSig: <push len(sig)> <sig> <push len(pubkey)> <pubkey>
      const scriptSig = concatBytes(
        u8(sig.length),
        sig,
        u8(pubKey.length),
        pubKey
      );
      scriptSigs.push(scriptSig);
    }

    // 6) Serialize + broadcast.
    const rawHex = serializeSignedTx(inputs, outputs, scriptSigs, VERSION, LOCKTIME);
    return { hash: await broadcastBch(rawHex) };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const height = await tryEach<number>([
        { name: "haskoin", fn: () => fetchHeightHaskoin(HASKOIN_BASES[0]) },
        {
          name: "blockchair",
          fn: async () => {
            const r = await proxyGetJson<{ data: { blocks: number } }>(`${BLOCKCHAIR_BASE}/stats`);
            if (typeof r.data?.blocks !== "number") throw new Error("blockchair stats: no blocks");
            return r.data.blocks;
          },
        },
      ]);
      return { label: "Block", value: height.toLocaleString(), unit: "" };
    } catch {
      return { label: "Network", value: "Mainnet", unit: "" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    const offset = opts?.cursor ? Number(opts.cursor) : 0;

    // haskoin first (2026-09-04): one request returns full transactions with
    // inputs/outputs resolved, and Blockchair — the only source before this —
    // 430-blacklists the shared IP, which left BCH history empty as well as
    // the balance. Shape captured live; see `HaskoinFullTx`.
    const mine = (a: string | null | undefined) =>
      !!a && a.toLowerCase().replace(/^bitcoincash:/, "") === address.toLowerCase().replace(/^bitcoincash:/, "");
    for (const base of HASKOIN_BASES) {
      try {
        const rows = await fetchHistoryHaskoin(base, address, limit, offset);
        const items: ChainTx[] = rows.map((d) => {
          let outFromMe = 0;
          for (const inp of d.inputs ?? []) if (!inp.coinbase && mine(inp.address)) outFromMe += inp.value ?? 0;
          let inToMe = 0;
          let firstExternal: string | undefined;
          for (const out of d.outputs ?? []) {
            if (mine(out.address)) inToMe += out.value ?? 0;
            else if (!firstExternal && out.address) firstExternal = out.address;
          }
          const net = inToMe - outFromMe;
          const direction: ChainTx["direction"] = net > 0 ? "in" : net < 0 ? "out" : "self";
          return {
            chain: "bitcoin-cash",
            hash: d.txid,
            direction,
            amount: (Math.abs(net) / 1e8).toFixed(8),
            fee: direction === "out" && d.fee ? (d.fee / 1e8).toFixed(8) : undefined,
            timestamp: typeof d.time === "number" ? d.time : undefined,
            height: d.block?.height ?? undefined,
            counterparty: direction === "out" ? firstExternal : undefined,
            meta: {},
          };
        });
        return { items, cursor: rows.length === limit ? String(offset + limit) : undefined };
      } catch {
        /* rotate: next deployment, then Blockchair */
      }
    }

    const r = await proxyGetJson<{
      data: Record<string, BlockchairAddressEntry>;
    }>(
      `${BLOCKCHAIR_BASE}/dashboards/address/${address}?limit=${limit}&offset=${offset}`
    );
    const entry = r.data?.[address];
    const txids = (entry?.transactions ?? []).slice(0, limit);
    if (txids.length === 0) return { items: [] };

    const items: ChainTx[] = [];
    for (let i = 0; i < txids.length; i += 10) {
      const batch = txids.slice(i, i + 10);
      try {
        const detail = await proxyGetJson<{
          data: Record<string, BlockchairTxEntry>;
        }>(`${BLOCKCHAIR_BASE}/dashboards/transactions/${batch.join(",")}`);
        for (const txid of batch) {
          const d = detail.data?.[txid];
          if (!d) continue;
          let outFromMe = 0;
          for (const inp of d.inputs ?? []) {
            if (inp.recipient === address) outFromMe += inp.value || 0;
          }
          let inToMe = 0;
          let firstExternal: string | undefined;
          for (const out of d.outputs ?? []) {
            if (out.recipient === address) inToMe += out.value || 0;
            else if (!firstExternal && out.recipient) firstExternal = out.recipient;
          }
          const net = inToMe - outFromMe;
          const direction: ChainTx["direction"] =
            net > 0 ? "in" : net < 0 ? "out" : "self";
          items.push({
            chain: "bitcoin-cash",
            hash: d.transaction.hash,
            direction,
            amount: (Math.abs(net) / 1e8).toFixed(8),
            fee:
              direction === "out" && d.transaction.fee
                ? (d.transaction.fee / 1e8).toFixed(8)
                : undefined,
            timestamp: d.transaction.time
              ? Math.floor(new Date(d.transaction.time + "Z").getTime() / 1000)
              : undefined,
            height: d.transaction.block_id,
            counterparty: direction === "out" ? firstExternal : undefined,
            meta: {},
          });
        }
      } catch {
        /* partial history is still useful — skip the failing batch */
      }
    }

    const cursor = txids.length === limit ? String(offset + limit) : undefined;
    return { items, cursor };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    let perByte = 1;
    try {
      perByte = await tryEach([
        { name: "blockchair", fn: () => fetchFeeRateBlockchair() },
        { name: "fullstack", fn: () => fetchFeeRateFullstack() },
      ]);
    } catch {
      /* keep 1 sat/B */
    }
    return {
      normal: { value: String(Math.max(perByte, 1)) },
      unit: "sat/B",
      fetchedAt: Date.now(),
      raw: { perByte },
    };
  },
};
