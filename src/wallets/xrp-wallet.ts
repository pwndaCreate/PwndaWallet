import { Wallet as XrplWallet, Client } from "xrpl";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import * as tinysecp from "tiny-secp256k1";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
} from "./types";

const XRP_RPC_URLS = [
  "wss://xrplcluster.com",
  "wss://s1.ripple.com",
  "wss://s2.ripple.com",
];
const DERIVATION_PATH = "m/44'/144'/0'/0/0";

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

function privateKeyToWallet(privateKeyHex: string): XrplWallet {
  const privBytes = hexToBytes(privateKeyHex);
  const pubBytes = tinysecp.pointFromScalar(privBytes)!;
  const publicKeyHex = bytesToHex(pubBytes);
  return new XrplWallet(publicKeyHex, privateKeyHex);
}

function deriveFromSeed(mnemonic: string): { address: string; privateKey: string } {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(DERIVATION_PATH);
  const privateKeyHex = bytesToHex(child.privateKey!);
  const wallet = privateKeyToWallet(privateKeyHex);
  return { address: wallet.classicAddress, privateKey: privateKeyHex };
}

/**
 * Derive the XRP wallet at an ARBITRARY HD path (not just the standard
 * `m/44'/144'/0'/0/0`). The derivation-profile system uses this so an
 * Exodus seed (Exodus fully-hardens the last two steps →
 * `m/44'/144'/0'/0'/0'`) resolves without changing the default. Reuses the
 * EXACT same secp256k1 → XrplWallet encoder as `deriveFromMnemonic`, so the
 * standard path is byte-identical (locked by a round-trip test). Exported
 * for `derivePerChoice`.
 */
export function deriveXrpAtPath(mnemonic: string, path: string): WalletInfo {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  const privateKeyHex = bytesToHex(child.privateKey!);
  const wallet = privateKeyToWallet(privateKeyHex);
  return {
    chain: "xrp",
    address: wallet.classicAddress,
    mnemonic: mnemonic.trim(),
    privateKey: privateKeyHex,
  };
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  let lastError: any;
  for (const url of XRP_RPC_URLS) {
    try {
      const client = new Client(url);
      await client.connect();
      try {
        return await fn(client);
      } finally {
        await client.disconnect();
      }
    } catch (e) {
      lastError = e;
      continue;
    }
  }
  throw lastError;
}

export const xrpAdapter: ChainAdapter = {
  chain: "xrp",
  displayName: "XRP",
  ticker: "XRP",
  color: "#bac6d4",
  addressPlaceholder: "r...",
  derivation: {
    kind: "bip39",
    path: "m/44'/144'/0'/0/0",
    standard: "BIP-44 coin type 144 — XUMM",
    hasAlternatives: true,
  },
  /** Arbitrary-path derivation for the generic finder + balance sweep. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    return deriveXrpAtPath(mnemonic, path);
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const clean = privateKey.trim().replace(/^0x/, "");
    const wallet = privateKeyToWallet(clean);
    return {
      chain: "xrp",
      address: wallet.classicAddress,
      mnemonic: "",
      privateKey: clean,
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const { address, privateKey } = deriveFromSeed(mnemonic);
    return {
      chain: "xrp",
      address,
      mnemonic: mnemonic.trim(),
      privateKey,
    };
  },

  async getBalance(address: string): Promise<string> {
    return withClient(async (client) => {
      try {
        const response = await client.request({
          command: "account_info",
          account: address,
          ledger_index: "validated",
        });
        const drops = response.result.account_data.Balance;
        return (Number(drops) / 1_000_000).toFixed(6);
      } catch (e: any) {
        if (e?.data?.error === "actNotFound") {
          return "0.000000";
        }
        throw e;
      }
    });
  },

  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    return withClient(async (client) => {
      const wallet = privateKeyToWallet(privateKey);
      const drops = Math.round(parseFloat(amount) * 1_000_000).toString();
      const prepared = await client.autofill({
        TransactionType: "Payment",
        Account: wallet.classicAddress,
        Amount: drops,
        Destination: to,
      });
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
      return { hash: result.result.hash };
    });
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      return await withClient(async (client) => {
        const response = await client.request({
          command: "server_info",
        });
        const ledger =
          response.result.info.validated_ledger?.seq?.toLocaleString() ?? "N/A";
        return { label: "Ledger", value: ledger, unit: "" };
      });
    } catch {
      return { label: "Network", value: "Mainnet", unit: "" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    return withClient(async (client) => {
      // marker: opaque pagination token from rippled. We round-trip as a
      // base64 JSON string so callers don't need to know the inner shape.
      let marker: any = undefined;
      if (opts?.cursor) {
        try {
          marker = JSON.parse(atob(opts.cursor));
        } catch {
          /* ignore bad cursor */
        }
      }
      const resp = await client.request({
        command: "account_tx",
        account: address,
        limit,
        ledger_index_min: -1,
        ledger_index_max: -1,
        marker,
        forward: false,
      } as any);
      const txs: any[] = (resp.result as any).transactions ?? [];
      const items: ChainTx[] = txs
        .map((wrapper) => {
          const tx = wrapper.tx ?? wrapper.tx_json ?? {};
          const meta = wrapper.meta ?? {};
          if (tx.TransactionType !== "Payment") return null;
          const isIn = tx.Destination === address;
          const isOut = tx.Account === address;
          if (!isIn && !isOut) return null;
          // For XRP, Amount can be a string of drops (XRP) or an object
          // (issued currency). We surface only XRP-denominated payments here;
          // issued-currency rows go in `meta` for the detail drawer.
          let amountXrp = "0";
          if (typeof tx.Amount === "string") {
            amountXrp = (Number(tx.Amount) / 1_000_000).toFixed(6);
          }
          const fee = tx.Fee ? (Number(tx.Fee) / 1_000_000).toFixed(6) : undefined;
          const direction: ChainTx["direction"] = isOut && isIn ? "self" : isOut ? "out" : "in";
          const success =
            meta.TransactionResult === "tesSUCCESS" || !meta.TransactionResult;
          return {
            chain: "xrp",
            hash: tx.hash ?? wrapper.hash ?? "",
            direction: success ? direction : "failed",
            amount: amountXrp,
            fee: direction === "out" ? fee : undefined,
            timestamp: tx.date
              ? // rippled "date" is seconds since 2000-01-01; convert to POSIX.
                Number(tx.date) + 946_684_800
              : undefined,
            confirmations: wrapper.validated ? undefined : 0,
            height: tx.ledger_index ?? wrapper.ledger_index,
            counterparty: direction === "out" ? tx.Destination : tx.Account,
            meta: {
              transactionType: tx.TransactionType,
              destinationTag: tx.DestinationTag,
              transactionResult: meta.TransactionResult,
              issuedAmount:
                typeof tx.Amount === "object" ? tx.Amount : undefined,
            },
          } as ChainTx;
        })
        .filter((x): x is ChainTx => x !== null);
      const m = (resp.result as any).marker;
      const cursor = m ? btoa(JSON.stringify(m)) : undefined;
      return { items, cursor };
    });
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    return withClient(async (client) => {
      const r = await client.request({ command: "server_info" });
      const info = r.result.info as any;
      const baseXrp = Number(info.validated_ledger?.base_fee_xrp ?? 0.00001);
      const load = Number(info.load_factor ?? 1);
      const normal = baseXrp * load;
      // No `fast` tier officially exposed; bumping by 20% / 50% is the
      // common pattern XRPL clients use to clear loaded ledgers.
      return {
        slow: { value: baseXrp.toFixed(6) },
        normal: { value: normal.toFixed(6) },
        fast: { value: (normal * 1.5).toFixed(6) },
        unit: "XRP",
        fetchedAt: Date.now(),
        raw: { base_fee_xrp: baseXrp, load_factor: load },
      };
    });
  },
};
