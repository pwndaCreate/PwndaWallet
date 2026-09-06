import { ethers } from "ethers";
import bs58check from "bs58check";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
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

const TRON_API_URLS = [
  "https://api.trongrid.io",
  "https://api.tronstack.io",
];

export async function tronFetch(path: string, init?: RequestInit): Promise<Response> {
  let lastError: any;
  for (const base of TRON_API_URLS) {
    try {
      const resp = await fetch(`${base}${path}`, init);
      if (resp.ok) return resp;
      lastError = new Error(`HTTP ${resp.status} from ${base}`);
    } catch (e) {
      lastError = e;
      continue;
    }
  }
  throw lastError;
}

const TRONGRID_API = TRON_API_URLS[0];

/**
 * Convert an Ethereum-style address to a TRON base58 address.
 * TRON addresses use 0x41 prefix + 20-byte address, then base58check encode.
 */
export function ethAddressToTron(ethAddress: string): string {
  const clean = ethAddress.replace(/^0x/, "");
  const addressBytes = new Uint8Array(21);
  addressBytes[0] = 0x41; // TRON mainnet prefix
  const hexBytes = hexToBytes(clean);
  addressBytes.set(hexBytes, 1);
  return bs58check.encode(addressBytes);
}

/**
 * Convert a TRON base58 address back to hex (with 41 prefix).
 */
export function tronAddressToHex(tronAddress: string): string {
  const decoded = bs58check.decode(tronAddress);
  return bytesToHex(decoded);
}

/**
 * Derive the TRON wallet at an ARBITRARY HD path. Pwnda's DEFAULT reuses the
 * EVM key (`m/44'/60'/0'/0/0`, via `ethers.Wallet.fromPhrase`); Exodus/Atomic
 * use TRX's own coin-type (`m/44'/195'/…`). This manually walks HDKey so any
 * path works, then reuses the EXACT same eth-address → `ethAddressToTron`
 * encoder, so the standard path is byte-identical to `deriveFromMnemonic`
 * (locked by a round-trip test). Exported for `derivePerChoice`.
 */
export function deriveTrxAtPath(mnemonic: string, path: string): WalletInfo {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  const wallet = new ethers.Wallet("0x" + bytesToHex(child.privateKey!));
  return {
    chain: "tron",
    address: ethAddressToTron(wallet.address),
    mnemonic: mnemonic.trim(),
    privateKey: wallet.privateKey,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const trxAdapter: ChainAdapter = {
  chain: "tron",
  displayName: "TRON",
  ticker: "TRX",
  color: "#eb0029",
  addressPlaceholder: "T...",
  derivation: {
    kind: "bip39",
    path: "m/44'/60'/0'/0/0",
    standard: "TronLink convention: ETH coin type 60, not TRX's own 195",
    hasAlternatives: true,
  },
  /** Arbitrary-path derivation for the generic finder + balance sweep. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    return deriveTrxAtPath(mnemonic, path);
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const wallet = new ethers.Wallet(privateKey.trim());
    const tronAddress = ethAddressToTron(wallet.address);
    return {
      chain: "tron",
      address: tronAddress,
      mnemonic: "",
      privateKey: wallet.privateKey,
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const wallet = ethers.Wallet.fromPhrase(mnemonic.trim());
    const tronAddress = ethAddressToTron(wallet.address);
    return {
      chain: "tron",
      address: tronAddress,
      mnemonic: mnemonic.trim(),
      privateKey: wallet.privateKey,
    };
  },

  async getBalance(address: string): Promise<string> {
    // Route through tronFetch for the TronGrid → TronStack fallback so
    // a 429 / 5xx on the primary doesn't fail the whole call. Previously
    // used raw fetch on TRONGRID_API only — surfaced as a "GET …
    // 429 (Too Many Requests)" in the dev console under load.
    const resp = await tronFetch(`/v1/accounts/${address}`);
    if (!resp.ok) throw new Error("Failed to fetch TRX balance");
    const data = await resp.json();
    if (!data.data || data.data.length === 0) {
      return "0.000000";
    }
    const balance = data.data[0].balance || 0;
    return (balance / 1_000_000).toFixed(6);
  },

  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    const wallet = new ethers.Wallet(privateKey.trim());
    const fromHex = tronAddressToHex(ethAddressToTron(wallet.address));
    const toHex = tronAddressToHex(to);
    const sunAmount = Math.round(parseFloat(amount) * 1_000_000);

    // Create transaction via TronGrid (with TronStack fallback).
    const createResp = await tronFetch(`/wallet/createtransaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_address: fromHex,
        to_address: toHex,
        amount: sunAmount,
      }),
    });
    if (!createResp.ok) throw new Error("Failed to create TRX transaction");
    const txData = await createResp.json();

    // Sign the transaction
    const txID = txData.txID;
    const signingKey = new ethers.SigningKey(privateKey.trim());
    const signature = signingKey.sign(hexToBytes(txID));
    const sigHex =
      signature.r.slice(2) +
      signature.s.slice(2) +
      (signature.v === 27 ? "00" : "01");

    txData.signature = [sigHex];

    // Broadcast (with fallback). Tron node propagation: regardless of
    // which API mirror accepts the broadcast, the tx fans out across
    // the actual Tron network within a block, so we don't need to retry
    // both — first success is final.
    const broadcastResp = await tronFetch(`/wallet/broadcasttransaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(txData),
    });
    if (!broadcastResp.ok) throw new Error("Failed to broadcast TRX transaction");
    const result = await broadcastResp.json();
    if (!result.result) {
      throw new Error(result.message || "Broadcast failed");
    }
    return { hash: txID };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const resp = await tronFetch(`/wallet/getnowblock`);
      const data = await resp.json();
      const blockNum = data.block_header?.raw_data?.number;
      return {
        label: "Block",
        value: blockNum ? blockNum.toLocaleString() : "N/A",
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
    const fingerprint = opts?.cursor ? `&fingerprint=${opts.cursor}` : "";
    let lastError: unknown = null;
    for (const base of TRON_API_URLS) {
      try {
        const data = await proxyGetJson<{ data: any[]; meta?: { fingerprint?: string } }>(
          `${base}/v1/accounts/${address}/transactions?limit=${limit}&only_confirmed=true${fingerprint}`
        );
        const items: ChainTx[] = (data.data ?? [])
          .map((tx) => {
            const c =
              tx.raw_data?.contract?.[0]?.parameter?.value ?? null;
            if (!c) return null;
            const contractType = tx.raw_data?.contract?.[0]?.type;
            if (contractType !== "TransferContract") return null; // skip non-TRX transfers
            const fromHex = c.owner_address;
            const toHex = c.to_address;
            const fromTron = hexToTronAddress(fromHex);
            const toTron = hexToTronAddress(toHex);
            const isOut = fromTron === address;
            const direction: ChainTx["direction"] =
              isOut && toTron === address ? "self" : isOut ? "out" : "in";
            const sun = Number(c.amount ?? 0);
            const amount = (sun / 1_000_000).toFixed(6);
            const success =
              tx.ret?.[0]?.contractRet === "SUCCESS" || !tx.ret?.[0]?.contractRet;
            return {
              chain: "tron",
              hash: tx.txID,
              direction: success ? direction : "failed",
              amount,
              fee: tx.net_fee
                ? (Number(tx.net_fee) / 1_000_000).toFixed(6)
                : undefined,
              timestamp: tx.block_timestamp
                ? Math.floor(tx.block_timestamp / 1000)
                : undefined,
              height: tx.blockNumber,
              counterparty: direction === "out" ? toTron : fromTron,
              meta: { contractType, raw_ret: tx.ret },
            } as ChainTx;
          })
          .filter((x): x is ChainTx => x !== null);
        return { items, cursor: data.meta?.fingerprint };
      } catch (e) {
        lastError = e;
        continue;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("All Tron sources failed");
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // Standard TRX transfer is 268 bytes ≈ 268 bandwidth points. Free tier
    // covers most simple transfers; if exhausted, the network burns ~0.268 TRX
    // (1 sun/byte). Surface that ceiling as the practical fee — TronGrid
    // exposes the per-byte cost via `getchainparameters` (key
    // `getTransactionFee`, default 1000 sun/byte).
    let perByte = 1000; // default per Tron docs
    try {
      const params = await proxyGetJson<{ chainParameter: { key: string; value?: number }[] }>(
        `${TRONGRID_API}/wallet/getchainparameters`
      );
      const txFee = params.chainParameter.find(
        (p) => p.key === "getTransactionFee"
      );
      if (txFee?.value) perByte = txFee.value;
    } catch {
      /* keep default */
    }
    const standardSize = 268;
    const trxFee = ((perByte * standardSize) / 1_000_000).toFixed(6);
    return {
      normal: { value: trxFee, eta: "if no free bandwidth" },
      unit: "TRX",
      fetchedAt: Date.now(),
      raw: { perByte, size: standardSize },
    };
  },
};

function hexToTronAddress(hex: string): string {
  if (!hex) return "";
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Tron addresses are 21-byte bs58check (0x41 prefix + 20-byte address).
  const b = hexToBytes(clean);
  if (b.length !== 21) return "";
  return bs58check.encode(b);
}
