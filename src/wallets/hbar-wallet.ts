import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
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

// Hedera's official public mirror node. Documented at 100 req/s per IP —
// one of the most generous keyless tiers we work with.
const MIRROR_BASE = "https://mainnet-public.mirrornode.hedera.com";
const MIRROR_API = `${MIRROR_BASE}/api/v1`;
const DERIVATION_PATH = "m/44'/3030'/0'/0/0";

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
 * Derive an Ed25519 key from the BIP44 path for Hedera (coin type 3030).
 * Hedera uses SLIP-0010 Ed25519 derivation. We use the raw seed bytes
 * from BIP32 derivation and take the first 32 bytes as the Ed25519 seed.
 */
function deriveKeysFromMnemonic(mnemonic: string, path: string = DERIVATION_PATH): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  // Use derived private key as Ed25519 seed
  const privateKey = child.privateKey!;
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Hedera accounts are identified by shard.realm.num (e.g., 0.0.12345).
 * You cannot derive an account ID from a key alone — accounts must be
 * created on the network first. We display the public key as the "address"
 * since the account ID needs to be looked up or created separately.
 */
function publicKeyToDisplay(publicKey: Uint8Array): string {
  return "0x" + bytesToHex(publicKey);
}

export const hbarAdapter: ChainAdapter = {
  chain: "hedera",
  displayName: "Hedera",
  ticker: "HBAR",
  color: "#00d4aa",
  addressPlaceholder: "0.0.xxxxx",
  derivation: {
    kind: "bip39",
    path: "m/44'/3030'/0'/0/0",
    standard: "BIP-44 coin type 3030 — HashPack",
    hasAlternatives: false,
  },
  /** Arbitrary-path derivation — powers the generic finder + funded-path scan. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    const { privateKey, publicKey } = deriveKeysFromMnemonic(mnemonic, path);
    return {
      chain: "hedera",
      address: publicKeyToDisplay(publicKey),
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(privateKey),
    };
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const privBytes = hexToBytes(privateKey);
    const pubBytes = ed25519.getPublicKey(privBytes);
    return {
      chain: "hedera",
      address: publicKeyToDisplay(pubBytes),
      mnemonic: "",
      privateKey: bytesToHex(privBytes),
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const { privateKey, publicKey } = deriveKeysFromMnemonic(mnemonic);
    return {
      chain: "hedera",
      address: publicKeyToDisplay(publicKey),
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(privateKey),
    };
  },

  async getBalance(address: string): Promise<string> {
    // address here is the public key hex; we try to look up the account.
    //
    // Failures THROW (2026-08-22) so the caller renders "—" (unknown) rather
    // than "0.00000000". Note Hedera already had a distinct string for the
    // genuinely-absent case ("No account (create on network)") — the old
    // catch-and-zero collapsed a mirror-node outage into a balance claim,
    // losing that distinction precisely when it mattered.
    const pubKeyHex = address.replace(/^0x/, "");
    const resp = await fetch(
      `${MIRROR_API}/accounts?account.publickey=${pubKeyHex}&limit=1`
    );
    if (!resp.ok) {
      throw new Error(`Hedera mirror node returned HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (data.accounts && data.accounts.length > 0) {
      const account = data.accounts[0];
      const tinybars = account.balance?.balance || 0;
      return (tinybars / 1e8).toFixed(8);
    }
    // Queried successfully; this public key has no account on the network.
    return "No account (create on network)";
  },

  async sendTransaction(
    _privateKey: string,
    _to: string,
    _amount: string
  ): Promise<TxResult> {
    throw new Error(
      "Hedera send is not yet implemented. Hedera transactions require the Hedera SDK for protobuf serialization and network submission."
    );
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const resp = await fetch(`${MIRROR_API}/blocks?limit=1&order=desc`);
      if (!resp.ok) throw new Error("Failed to fetch network info");
      const data = await resp.json();
      const blockNum = data.blocks?.[0]?.number;
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
    // Resolve the public-key "address" (our display form) to a Hedera
    // account id via mirror. Then pull recent CRYPTOTRANSFER txs.
    const pubKeyHex = address.replace(/^0x/, "");
    let accountId: string | null = null;
    try {
      const r = await proxyGetJson<{ accounts: { account: string }[] }>(
        `${MIRROR_API}/accounts?account.publickey=${pubKeyHex}&limit=1`
      );
      accountId = r.accounts?.[0]?.account ?? null;
    } catch {
      /* no account on network yet */
    }
    if (!accountId) return { items: [] };

    const cursorPart = opts?.cursor ? `&timestamp=lt:${opts.cursor}` : "";
    const data = await proxyGetJson<{
      transactions: any[];
      links?: { next?: string | null };
    }>(
      `${MIRROR_API}/transactions?account.id=${accountId}&order=desc&limit=${limit}${cursorPart}`
    );
    const items: ChainTx[] = (data.transactions ?? []).map((tx) => {
      // `transfers` lists every account's hbar delta within the tx. The
      // entry for our account tells us direction + amount.
      const ours = tx.transfers?.find((t: any) => t.account === accountId);
      const tinybars = Number(ours?.amount ?? 0);
      const direction: ChainTx["direction"] = tinybars > 0 ? "in" : tinybars < 0 ? "out" : "self";
      // Counterparty: the largest opposite-sign transfer.
      const others: any[] = (tx.transfers ?? []).filter(
        (t: any) => t.account !== accountId
      );
      const counterparty = others
        .filter((t) =>
          direction === "in" ? Number(t.amount) < 0 : Number(t.amount) > 0
        )
        .sort(
          (a, b) =>
            Math.abs(Number(b.amount)) - Math.abs(Number(a.amount))
        )[0]?.account;
      const success = tx.result === "SUCCESS";
      return {
        chain: "hedera",
        hash: tx.transaction_id,
        direction: success ? direction : "failed",
        amount: (Math.abs(tinybars) / 1e8).toFixed(8),
        fee: tx.charged_tx_fee
          ? (Number(tx.charged_tx_fee) / 1e8).toFixed(8)
          : undefined,
        timestamp: tx.consensus_timestamp
          ? Math.floor(Number(tx.consensus_timestamp.split(".")[0]))
          : undefined,
        counterparty,
        meta: {
          name: tx.name,
          result: tx.result,
          memo_base64: tx.memo_base64,
        },
      } as ChainTx;
    });

    // Mirror's own pagination cursor lives at `links.next` as a relative
    // URL; we extract the `timestamp` query for our cursor space.
    let nextCursor: string | undefined;
    const next = data.links?.next;
    if (next) {
      const m = next.match(/timestamp=lt:([\d.]+)/);
      if (m) nextCursor = m[1];
    }
    return { items, cursor: nextCursor };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // Hedera fee schedule is deterministic and tied to a USD price target
    // baked into the network. Mirror exposes `network/fees` with per-op
    // tinybar cost. CRYPTOTRANSFER is the row we care about.
    try {
      const r = await proxyGetJson<{
        fees: { transaction_type: string; gas: number }[];
        timestamp?: string;
      }>(`${MIRROR_API}/network/fees`);
      const xfer = r.fees?.find(
        (f) => f.transaction_type === "CryptoTransfer"
      );
      const tinybars = xfer?.gas ?? 50_000;
      return {
        normal: { value: (tinybars / 1e8).toFixed(8) },
        unit: "HBAR",
        fetchedAt: Date.now(),
        raw: r,
      };
    } catch {
      // Sane fallback baked from the published fee schedule.
      return {
        normal: { value: "0.0001" },
        unit: "HBAR",
        fetchedAt: Date.now(),
      };
    }
  },
};


/**
 * Look up the Hedera account id (`0.0.x`) for a derived public key.
 *
 * `null` means the mirror node answered and found nothing — the account has
 * not been created yet, which on Hedera is a normal state rather than an
 * error: an account must be created and funded by an EXISTING account before
 * it can hold or receive HBAR. Throws only on an actual network/mirror
 * failure, so "no account" and "could not ask" stay distinguishable.
 *
 * Exported for `HederaSetupPanel`, which needs the id itself (not just a
 * balance) to tell the user their account is now live.
 */
export async function lookupHederaAccountId(
  publicKeyHex: string,
): Promise<string | null> {
  const key = publicKeyHex.replace(/^0x/, "");
  const resp = await fetch(`${MIRROR_API}/accounts?account.publickey=${key}&limit=1`);
  if (!resp.ok) throw new Error(`Hedera mirror node HTTP ${resp.status}`);
  const data = await resp.json();
  const acct = data?.accounts?.[0];
  return acct?.account ?? null;
}

/** True when a balance string is the adapter's "account does not exist yet"
 *  sentinel. One definition so the UI never re-matches the literal. */
export const HBAR_NO_ACCOUNT = "No account (create on network)";
export function isHederaAccountMissing(balance: string | undefined): boolean {
  return balance === HBAR_NO_ACCOUNT;
}
