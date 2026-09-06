import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
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

// Conflux Core Space mainnet RPC endpoints
const CFX_RPC_URLS = [
  "https://main.confluxrpc.com",
  "https://main.confluxrpc.org",
];

// BIP44 derivation path for Conflux Core Space (coin type 503)
const DERIVATION_PATH = "m/44'/503'/0'/0/0";

// Network prefix for mainnet
const NETWORK_PREFIX = "cfx";

// CIP-37 base32 alphabet (excludes i, l, o, q for readability)
const BASE32_ALPHABET = "abcdefghjkmnprstuvwxyz0123456789";

// ── Utility functions ──

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

// ── CIP-37 Base32 Address Encoding ──

/**
 * PolyMod checksum algorithm (Bitcoin Cash / CIP-37 style).
 * Produces a 40-bit checksum from 5-bit input values.
 */
function polyMod(values: number[]): bigint {
  const GENERATORS: bigint[] = [
    0x98f2bc8e61n,
    0x79b76d99e2n,
    0xf33e5fb3c4n,
    0xae2eabe2a8n,
    0x1e4f43e470n,
  ];
  let c = 1n;
  for (const v of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) {
      if ((c0 >> BigInt(i)) & 1n) {
        c ^= GENERATORS[i];
      }
    }
  }
  return c ^ 1n;
}

/**
 * Convert a prefix string (e.g. "cfx") to 5-bit values for checksum calculation.
 * Each character contributes its lower 5 bits, followed by a 0 separator.
 */
function prefixToFiveBits(prefix: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < prefix.length; i++) {
    result.push(prefix.charCodeAt(i) & 0x1f);
  }
  result.push(0); // separator
  return result;
}

/**
 * Convert byte array to 5-bit groups for base32 encoding.
 * Pads the last group with zeros if needed.
 */
function bytesTo5BitGroups(data: Uint8Array): number[] {
  const result: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result.push((buffer >> bits) & 0x1f);
    }
  }
  // Pad remaining bits
  if (bits > 0) {
    result.push((buffer << (5 - bits)) & 0x1f);
  }
  return result;
}

/**
 * Encode a 20-byte Conflux hex address to CIP-37 base32 format.
 * @param hexAddress 20-byte address as hex string (with or without 0x prefix)
 * @returns CIP-37 address like "cfx:aak..."
 */
function encodeCfxAddress(hexAddress: string): string {
  const addrBytes = hexToBytes(hexAddress);
  if (addrBytes.length !== 20) {
    throw new Error(`Invalid address length: expected 20 bytes, got ${addrBytes.length}`);
  }

  // Version byte: 0x00 for 160-bit hash, user type
  const versionByte = 0x00;
  const payload = new Uint8Array(1 + addrBytes.length);
  payload[0] = versionByte;
  payload.set(addrBytes, 1);

  // Convert payload to 5-bit groups
  const payloadBits = bytesTo5BitGroups(payload);

  // Calculate checksum
  const prefixBits = prefixToFiveBits(NETWORK_PREFIX);
  const checksumInput = [...prefixBits, ...payloadBits, 0, 0, 0, 0, 0, 0, 0, 0];
  const checksumValue = polyMod(checksumInput);

  // Extract 8 x 5-bit checksum values
  const checksumBits: number[] = [];
  for (let i = 7; i >= 0; i--) {
    checksumBits.push(Number((checksumValue >> BigInt(i * 5)) & 0x1fn));
  }

  // Encode to base32 string
  const allBits = [...payloadBits, ...checksumBits];
  let encoded = "";
  for (const v of allBits) {
    encoded += BASE32_ALPHABET[v];
  }

  return `${NETWORK_PREFIX}:${encoded}`;
}

// ── Key derivation ──

/**
 * Derive secp256k1 keys from a BIP39 mnemonic using Conflux Core BIP44 path.
 * Returns the private key bytes and the 20-byte Conflux hex address.
 */
function deriveFromMnemonicInternal(mnemonic: string): {
  privateKey: Uint8Array;
  hexAddress: string;
} {
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(DERIVATION_PATH);
  const privateKey = child.privateKey!;

  const hexAddress = privateKeyToHexAddress(privateKey);
  return { privateKey, hexAddress };
}

/**
 * Convert a secp256k1 private key to a 20-byte Conflux hex address.
 * Process: privKey → uncompressed pubKey (64 bytes, no 04 prefix) → keccak256 → last 20 bytes → set type nibble
 */
function privateKeyToHexAddress(privateKey: Uint8Array): string {
  // Get uncompressed public key (65 bytes: 04 || x || y)
  const uncompressedPubKey = secp256k1.getPublicKey(privateKey, false);

  // Strip the 0x04 prefix → 64 bytes
  const pubKeyNoPrefix = uncompressedPubKey.slice(1);

  // Keccak-256 hash
  const hash = keccak_256(pubKeyNoPrefix);

  // Take last 20 bytes
  const addressBytes = hash.slice(12);

  // Set the first nibble to 0x1 (user/EOA address type in Conflux Core)
  const addrCopy = new Uint8Array(addressBytes);
  addrCopy[0] = (addrCopy[0] & 0x0f) | 0x10;

  return "0x" + bytesToHex(addrCopy);
}

// ── RPC helper ──

async function cfxRpcCall(method: string, params: any[]): Promise<any> {
  let lastError: any;
  for (const url of CFX_RPC_URLS) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
      });
      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status} from ${url}`);
        continue;
      }
      const data = await resp.json();
      if (data.error) {
        lastError = new Error(data.error.message || JSON.stringify(data.error));
        continue;
      }
      return data.result;
    } catch (e) {
      lastError = e;
      continue;
    }
  }
  throw lastError;
}

// ── Adapter ──

export const cfxAdapter: ChainAdapter = {
  chain: "conflux",
  displayName: "Conflux",
  ticker: "CFX",
  color: "#8f8fe0",
  addressPlaceholder: "cfx:...",
  derivation: {
    kind: "bip39",
    path: "m/44'/503'/0'/0/0",
    standard: "BIP-44 coin type 503 — Fluent, Conflux Portal",
    hasAlternatives: false,
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const privBytes = hexToBytes(privateKey);
    const hexAddress = privateKeyToHexAddress(privBytes);
    const cfxAddress = encodeCfxAddress(hexAddress.replace(/^0x/, ""));
    return {
      chain: "conflux",
      address: cfxAddress,
      mnemonic: "",
      privateKey: bytesToHex(privBytes),
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const { privateKey, hexAddress } = deriveFromMnemonicInternal(mnemonic);
    const cfxAddress = encodeCfxAddress(hexAddress.replace(/^0x/, ""));
    return {
      chain: "conflux",
      address: cfxAddress,
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(privateKey),
    };
  },

  async getBalance(address: string): Promise<string> {
    // Throws on RPC failure (2026-08-22) — used to read as zero. Rejects so the
    // caller renders "—" (unknown) rather than a confident zero. The old catch
    // also returned a DIFFERENT zero than the success path formats (8 decimal
    // places vs 18), so a failed lookup was detectable only by counting digits.
    const result = await cfxRpcCall("cfx_getBalance", [address, "latest_state"]);
    if (!result) {
      throw new Error("Conflux RPC returned no result for cfx_getBalance");
    }
    // Result is hex Drip (1 CFX = 10^18 Drip)
    const drip = BigInt(result);
    const whole = drip / 10n ** 18n;
    const fraction = drip % 10n ** 18n;
    const fractionStr = fraction.toString().padStart(18, "0").slice(0, 8);
    return `${whole}.${fractionStr}`;
  },

  async sendTransaction(
    _privateKey: string,
    _to: string,
    _amount: string
  ): Promise<TxResult> {
    throw new Error(
      "Conflux Core Space send is not yet implemented. Conflux Core transactions require epoch height, storage limit, and RLP serialization."
    );
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const result = await cfxRpcCall("cfx_epochNumber", ["latest_state"]);
      const epoch = parseInt(result, 16);
      return {
        label: "Epoch",
        value: epoch.toLocaleString(),
        unit: "",
      };
    } catch {
      return { label: "Network", value: "Core Space Mainnet", unit: "" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    const skip = opts?.cursor ? Number(opts.cursor) : 0;
    // ConfluxScan REST is keyless. The 2026 host is `www.confluxscan.org`
    // (the older `confluxscan.io/v1/account/.../transactions` path was
    // removed and now 404s; that host 301-redirects here too). The
    // current path is a flat `/v1/transaction?accountAddress=...` and
    // the response is wrapped one level deeper in `{code, message, data}`.
    const wrapped = await proxyGetJson<{
      code: number;
      message: string;
      data: { total: number; list: any[] };
    }>(
      `https://www.confluxscan.org/v1/transaction?accountAddress=${encodeURIComponent(address)}&limit=${limit}&skip=${skip}`
    );
    if (wrapped.code !== 0) {
      throw new Error(`ConfluxScan: ${wrapped.message || `code=${wrapped.code}`}`);
    }
    const data = wrapped.data ?? { total: 0, list: [] };
    const items: ChainTx[] = (data.list ?? []).map((t) => {
      const isOut = (t.from ?? "").toLowerCase() === address.toLowerCase();
      const isIn = (t.to ?? "").toLowerCase() === address.toLowerCase();
      const direction: ChainTx["direction"] =
        isIn && isOut ? "self" : isOut ? "out" : "in";
      // ConfluxScan returns value in Drip (1 CFX = 1e18 Drip) as a string.
      let amount = "0";
      try {
        const drip = BigInt(t.value ?? "0");
        const whole = drip / 10n ** 18n;
        const frac = drip % 10n ** 18n;
        amount = `${whole}.${frac.toString().padStart(18, "0").slice(0, 8)}`;
      } catch {
        /* leave amount=0 */
      }
      const fee = (() => {
        if (t.gasFee) {
          try {
            const drip = BigInt(t.gasFee);
            const whole = drip / 10n ** 18n;
            const frac = drip % 10n ** 18n;
            return `${whole}.${frac.toString().padStart(18, "0").slice(0, 8)}`;
          } catch {
            return undefined;
          }
        }
        return undefined;
      })();
      return {
        chain: "conflux",
        hash: t.hash,
        direction: t.status === 1 ? direction : direction, // 0=success in CFX
        amount,
        fee: direction === "out" ? fee : undefined,
        timestamp: t.timestamp,
        height: t.blockNumber ?? t.epochNumber,
        counterparty: direction === "out" ? t.to : t.from,
        meta: {
          status: t.status,
          contractCreated: t.contractCreated,
        },
      };
    });
    const cursor =
      items.length === limit && skip + limit < (data.total ?? 0)
        ? String(skip + limit)
        : undefined;
    return { items, cursor };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // `cfx_gasPrice` returns hex Drip; standard transfer ≈ 21 000 gas.
    const result = await cfxRpcCall("cfx_gasPrice", []);
    const gasPriceDrip = BigInt(result);
    const standardGas = 21000n;
    const totalDrip = gasPriceDrip * standardGas;
    const whole = totalDrip / 10n ** 18n;
    const frac = totalDrip % 10n ** 18n;
    const cfx = `${whole}.${frac.toString().padStart(18, "0").slice(0, 8)}`;
    return {
      normal: { value: cfx },
      unit: "CFX",
      fetchedAt: Date.now(),
      raw: { gasPriceDrip: gasPriceDrip.toString(), assumedGas: "21000" },
    };
  },
};
