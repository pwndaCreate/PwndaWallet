import { sendAlgo } from "./algo-tx";
import { mnemonicToSeedSync } from "@scure/bip39";
import { derivePath } from "ed25519-hd-key";
import { HDKey } from "@scure/bip32";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512, sha512_256 } from "@noble/hashes/sha2.js";
import { base32 } from "@scure/base";
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

const ALGO_API = "https://mainnet-api.algonode.cloud";
const ALGO_INDEXER = "https://mainnet-idx.algonode.cloud";

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
 * Algorand address = base32(public_key + last_4_bytes_of_sha512_256(public_key))
 * Total 36 bytes base32 encoded = 58 characters
 */
export function algoAddressFromPublicKey(publicKey: Uint8Array): string {
  return publicKeyToAddress(publicKey);
}

function publicKeyToAddress(publicKey: Uint8Array): string {
  const checksum = sha512_256(publicKey).slice(-4);
  const addressBytes = new Uint8Array(36);
  addressBytes.set(publicKey, 0);
  addressBytes.set(checksum, 32);
  return base32.encode(addressBytes).replace(/=+$/, "");
}

/**
 * Decode an Algorand address back to the 32-byte public key.
 */
function addressToPublicKey(address: string): Uint8Array {
  // Pad to multiple of 8 for base32
  const padded = address + "=".repeat((8 - (address.length % 8)) % 8);
  const decoded = base32.decode(padded);
  return decoded.slice(0, 32);
}

/**
 * Identifiers for every ALGO derivation scheme Pwnda supports. The
 * vault stores the user's pick in `derivationChoice.algorand` and
 * `deriveAlgoFromMnemonic` uses it to route to the matching algorithm.
 * Default for new vaults is `"exodus"` (confirmed 2026-05-25 against a
 * real Exodus seed → address pair).
 */
export type AlgoDerivationId =
  | "exodus" // BIP-32 secp256k1 → ed25519 @ m/44'/283'/0'/0/0  ← Exodus, Atomic
  | "slip10-5h" // SLIP-0010 ed25519 @ m/44'/283'/0'/0'/0'           ← Ledger, MyAlgo BIP-39
  | "slip10-4h" // SLIP-0010 ed25519 @ m/44'/283'/0'/0'              ← Solana-style
  | "slip10-3h" // SLIP-0010 ed25519 @ m/44'/283'/0'                 ← NEAR-style
  | "legacy-sha512_256"; // sha512_256(seed[0..32])                  ← pre-2026-05-25 Pwnda

export const DEFAULT_ALGO_DERIVATION: AlgoDerivationId = "exodus";

interface AlgoKeys {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Derive the ALGO keypair from `mnemonic` using the named scheme.
 * `choice` may be one of `AlgoDerivationId` (named preset) OR an
 * arbitrary `m/...` BIP path string (treated as a SLIP-0010 ed25519
 * walk, all segments auto-hardened by ed25519-hd-key). This second form
 * is what the brute-force detector returns when it finds a non-default
 * account/index variant.
 */
export function deriveAlgoFromMnemonic(
  mnemonic: string,
  choice: AlgoDerivationId | string = DEFAULT_ALGO_DERIVATION
): AlgoKeys {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const seedHex = Buffer.from(seed).toString("hex");

  // Exodus (and Atomic) scheme: BIP-32 secp256k1 walk at the literal
  // documented path `m/44'/283'/0'/0/0` (last two segments unhardened —
  // fine for secp256k1, which is what makes this distinct from SLIP-0010),
  // then take the 32-byte secp256k1 private key directly as the ed25519
  // seed. Confirmed 2026-05-25 against user-provided Exodus address pair.
  // Mirrors the Solana Exodus scheme documented at
  // `src/features/onboarding/derivation-detector.ts:519-558`.
  if (choice === "exodus" || /^m\/.+\/0\/\d+$/.test(choice)) {
    const path = choice === "exodus" ? "m/44'/283'/0'/0/0" : choice;
    const root = HDKey.fromMasterSeed(seed);
    const child = root.derive(path);
    if (!child.privateKey) throw new Error(`Exodus derivation at ${path} produced no private key`);
    const privateKey = child.privateKey;
    const publicKey = ed25519.getPublicKey(privateKey);
    return { privateKey, publicKey };
  }

  // Exodus variant with SHA-512 fold (some closed-source wallets do
  // this; tried as a fallback by the brute-force detector). Identified
  // by the `"exodus-folded:"` prefix on the choice string.
  if (choice.startsWith("exodus-folded:")) {
    const path = choice.slice("exodus-folded:".length);
    const root = HDKey.fromMasterSeed(seed);
    const child = root.derive(path);
    if (!child.privateKey) throw new Error(`Exodus-folded derivation at ${path} produced no private key`);
    const privateKey = sha512(child.privateKey).slice(0, 32);
    const publicKey = ed25519.getPublicKey(privateKey);
    return { privateKey, publicKey };
  }

  if (choice === "legacy-sha512_256") {
    const privateKey = sha512_256(seed.slice(0, 32));
    const publicKey = ed25519.getPublicKey(privateKey);
    return { privateKey, publicKey };
  }

  const slipPath =
    choice === "slip10-5h"
      ? "m/44'/283'/0'/0'/0'"
      : choice === "slip10-4h"
        ? "m/44'/283'/0'/0'"
        : choice === "slip10-3h"
          ? "m/44'/283'/0'"
          : choice; // arbitrary `m/...` SLIP-0010 path
  const { key } = derivePath(slipPath, seedHex);
  const privateKey = new Uint8Array(key);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export const algoAdapter: ChainAdapter = {
  chain: "algorand",
  displayName: "Algorand",
  ticker: "ALGO",
  color: "#b8c2cc",
  addressPlaceholder: "ALGO...",
  derivation: {
    kind: "bip39",
    path: "m/44'/283'/0'/0/0",
    standard: "BIP-44 coin type 283 — Exodus/Atomic form",
    hasAlternatives: true,
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const privBytes = hexToBytes(privateKey);
    const pubBytes = ed25519.getPublicKey(privBytes);
    const address = publicKeyToAddress(pubBytes);
    return {
      chain: "algorand",
      address,
      mnemonic: "",
      privateKey: bytesToHex(privBytes),
    };
  },

  deriveFromMnemonic(mnemonic: string, choice?: string): WalletInfo {
    const { privateKey, publicKey } = deriveAlgoFromMnemonic(
      mnemonic,
      (choice as AlgoDerivationId | undefined) ?? DEFAULT_ALGO_DERIVATION
    );
    const address = publicKeyToAddress(publicKey);
    return {
      chain: "algorand",
      address,
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(privateKey),
    };
  },

  async getBalance(address: string): Promise<string> {
    // Rejects on failure (2026-08-22) so the caller renders "—" (unknown)
    // rather than "0.000000" (confidently empty). The outer catch used to
    // convert every error — including the explicit `throw` below — into a zero,
    // so the error was raised and then immediately discarded.
    //
    // 404 is NOT a failure: Algorand returns it for an address that has never
    // been funded, which is a genuine zero.
    const resp = await fetch(`${ALGO_API}/v2/accounts/${address}`);
    if (!resp.ok) {
      if (resp.status === 404) return "0.000000";
      throw new Error(`Failed to fetch ALGO balance (HTTP ${resp.status})`);
    }
    const data = await resp.json();
    const microAlgos = data.amount || 0;
    return (microAlgos / 1_000_000).toFixed(6);
  },

  /**
   * Wired 2026-09-02. The blocker was never the crypto — the key is already
   * derived above — it was Algorand's canonical msgpack, which `algo-tx.ts`
   * now implements directly rather than pulling in 8 MB of `algosdk` for one
   * transaction type. See [[remaining-send-chains]] for that sizing.
   */
  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    const key = Uint8Array.from(Buffer.from(privateKey.replace(/^0x/, ""), "hex"));
    const from = publicKeyToAddress(ed25519.getPublicKey(key));
    const { hash } = await sendAlgo({
      privateKey: key,
      fromAddress: from,
      to,
      amount,
      api: ALGO_API,
    });
    return { hash };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const resp = await fetch(`${ALGO_API}/v2/status`);
      if (!resp.ok) throw new Error("Failed to fetch network info");
      const data = await resp.json();
      return {
        label: "Round",
        value: data["last-round"]?.toLocaleString() ?? "N/A",
        unit: "",
      };
    } catch {
      return { label: "Network", value: "Mainnet", unit: "" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    const next = opts?.cursor ? `&next=${encodeURIComponent(opts.cursor)}` : "";
    const data = await proxyGetJson<{
      transactions: any[];
      "next-token"?: string;
    }>(
      `${ALGO_INDEXER}/v2/accounts/${address}/transactions?limit=${limit}${next}`
    );
    const items: ChainTx[] = (data.transactions ?? [])
      .map((tx) => {
        if (tx["tx-type"] !== "pay") return null; // skip ASA / app calls in v1
        const xfer = tx["payment-transaction"] ?? {};
        const isOut = tx.sender === address;
        const isIn = xfer.receiver === address;
        if (!isIn && !isOut) return null;
        const amountMicro = Number(xfer.amount ?? 0);
        const direction: ChainTx["direction"] =
          isIn && isOut ? "self" : isOut ? "out" : "in";
        const fee = Number(tx.fee ?? 0);
        return {
          chain: "algorand",
          hash: tx.id,
          direction,
          amount: (amountMicro / 1_000_000).toFixed(6),
          fee: direction === "out" ? (fee / 1_000_000).toFixed(6) : undefined,
          timestamp: tx["round-time"],
          height: tx["confirmed-round"],
          counterparty: direction === "out" ? xfer.receiver : tx.sender,
          meta: {
            note: tx.note,
            type: tx["tx-type"],
          },
        } as ChainTx;
      })
      .filter((x): x is ChainTx => x !== null);
    return { items, cursor: data["next-token"] };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    try {
      const params = await proxyGetJson<{
        fee: number;
        "min-fee": number;
      }>(`${ALGO_API}/v2/transactions/params`);
      // `params.fee` is a "suggested per-byte fee"; min-fee is the floor.
      // For a typical 250-byte payment, max(fee*size, min-fee) is what
      // algod will accept.
      const sized = (params.fee || 0) * 250;
      const fee = Math.max(sized, params["min-fee"] || 1000);
      return {
        normal: { value: (fee / 1_000_000).toFixed(6) },
        unit: "ALGO",
        fetchedAt: Date.now(),
        raw: params,
      };
    } catch {
      return {
        normal: { value: "0.001" },
        unit: "ALGO",
        fetchedAt: Date.now(),
      };
    }
  },
};
