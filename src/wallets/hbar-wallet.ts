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
  TxParties,
} from "./types";
import { proxyGetJson } from "./_proxy";
import { condenseHttpError } from "./tx-history-errors";
import { uniqueAddresses, urlHost } from "./parties-b-common";

// Hedera's official public mirror node. Documented at 100 req/s per IP —
// one of the most generous keyless tiers we work with.
const MIRROR_BASE = "https://mainnet-public.mirrornode.hedera.com";
const MIRROR_API = `${MIRROR_BASE}/api/v1`;
const DERIVATION_PATH = "m/44'/3030'/0'/0/0";

/**
 * System accounts that collect transaction fees: 0.0.98 (the network fee
 * account) and 0.0.800–0.0.802. In a live sample of mainnet transfers on
 * 2026-09-30 every fee went to 0.0.802; older transactions paid 0.0.98 and
 * the submitting node. Nobody sends a payment to these.
 */
const HEDERA_FEE_ACCOUNTS = ["0.0.98", "0.0.800", "0.0.801", "0.0.802"];

/** A tinybar count from the mirror's JSON (a number), or 0n. */
function tinybarsOf(v: unknown): bigint {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? BigInt(Math.trunc(n)) : 0n;
}

/** Tinybars as HBAR with eight fixed decimals, the rows' format, without floats. */
function tinybarsFixed8(t: bigint): string {
  const n = t < 0n ? -t : t;
  return `${n / 100_000_000n}.${(n % 100_000_000n).toString().padStart(8, "0")}`;
}

/** The paying account of a transaction id (`0.0.1234-1790788932-436079025` → `0.0.1234`). */
function hederaPayerOf(transactionId: unknown): string | undefined {
  const m = /^(\d+\.\d+\.\d+)[-@]/.exec(typeof transactionId === "string" ? transactionId : "");
  return m ? m[1] : undefined;
}

/**
 * A mirror-node transaction's HBAR transfers with its fee taken out, so what
 * is left is what moved between accounts. Exported for tests.
 *
 * `transfers` holds every account's delta, the fee included: the payer's
 * entry is the amount PLUS `charged_tx_fee`, and the fee lands in the
 * collecting accounts. Read raw (as the history did until 2026-09-30), a
 * small send's largest positive entry is the fee collector — a live 1-tinybar
 * transfer read "sent 0.00088997 HBAR to 0.0.802". So the fee is removed
 * from its collectors (the fee accounts first, then the submitting node) and
 * given back to the payer. A collector's entry above the fee is a payment
 * and stays (live: 9 tinybars to node 0.0.28 on top of a fee paid to 0.0.802).
 */
export function hederaValueTransfers(tx: unknown): Array<{ account: string; tinybars: bigint }> {
  const t = (tx ?? {}) as { transfers?: unknown; charged_tx_fee?: unknown; node?: unknown; transaction_id?: unknown };
  const moves = (Array.isArray(t.transfers) ? t.transfers : [])
    .filter((x: any) => typeof x?.account === "string")
    .map((x: any) => ({ account: x.account as string, tinybars: tinybarsOf(x.amount) }));
  let left = tinybarsOf(t.charged_tx_fee);
  const fee = left;
  for (const collector of [...HEDERA_FEE_ACCOUNTS, typeof t.node === "string" ? t.node : ""]) {
    for (const m of moves) {
      if (left <= 0n || m.account !== collector || m.tinybars <= 0n) continue;
      const take = m.tinybars < left ? m.tinybars : left;
      m.tinybars -= take;
      left -= take;
    }
  }
  const payer = moves.find((m) => m.account === hederaPayerOf(t.transaction_id));
  if (payer) payer.tinybars += fee - left;
  return moves.filter((m) => m.tinybars !== 0n);
}

/**
 * One mirror-node transaction as parties (2026-09-30). Exported for tests.
 * Senders are the accounts whose HBAR fell, recipients those whose HBAR
 * rose, once the fee is taken out (`hederaValueTransfers`); a transaction
 * that moved nothing but its fee names its payer as the sender.
 */
export function hederaTxParties(tx: unknown, source?: string): TxParties | null {
  if (!tx || typeof tx !== "object") return null;
  const moves = hederaValueTransfers(tx);
  const from = uniqueAddresses(moves.filter((m) => m.tinybars < 0n).map((m) => m.account));
  return {
    from: from.length > 0 ? from : uniqueAddresses([hederaPayerOf((tx as { transaction_id?: unknown }).transaction_id)]),
    to: uniqueAddresses(moves.filter((m) => m.tinybars > 0n).map((m) => m.account)),
    ...(source ? { source } : {}),
  };
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
      // `transfers` lists every account's hbar delta within the tx, fee
      // included; with the fee taken out (2026-09-30, `hederaValueTransfers`)
      // the entry for our account tells us direction + amount. A transaction
      // this account paid only a fee for is an "out" of 0, with its fee.
      const moves = hederaValueTransfers(tx);
      const tinybars = moves.find((m) => m.account === accountId)?.tinybars ?? 0n;
      const paidFeeOnly = tinybars === 0n && hederaPayerOf(tx.transaction_id) === accountId;
      const direction: ChainTx["direction"] =
        tinybars > 0n ? "in" : tinybars < 0n || paidFeeOnly ? "out" : "self";
      // Counterparty: the largest opposite-sign transfer, fee collectors no
      // longer among them.
      const counterparty = moves
        .filter((m) => m.account !== accountId && (direction === "in" ? m.tinybars < 0n : m.tinybars > 0n))
        .sort((a, b) => {
          const ma = a.tinybars < 0n ? -a.tinybars : a.tinybars;
          const mb = b.tinybars < 0n ? -b.tinybars : b.tinybars;
          return mb > ma ? 1 : mb < ma ? -1 : 0;
        })[0]?.account;
      const success = tx.result === "SUCCESS";
      return {
        chain: "hedera",
        hash: tx.transaction_id,
        direction: success ? direction : "failed",
        amount: tinybarsFixed8(tinybars),
        // The fee is this account's only when it paid for the transaction.
        fee:
          tx.charged_tx_fee && hederaPayerOf(tx.transaction_id) === accountId
            ? tinybarsFixed8(tinybarsOf(tx.charged_tx_fee))
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

  /**
   * The mirror node's `/transactions/{id}`, through the proxy like the
   * history (2026-09-30). `hash` is what the history rows carry: the
   * transaction id (`0.0.payer-seconds-nanos`); the `@` form wallets print
   * (`0.0.payer@seconds.nanos`) is accepted too. An unknown id is HTTP 404
   * (`{"_status":{"messages":[{"message":"Not found"}]}}`).
   *
   * The addresses are account ids (`0.0.x`), while this wallet's own address
   * is its public key, so the details cannot mark the wallet's side by
   * string alone.
   */
  async getTransactionParties(hash: string): Promise<TxParties | null> {
    const at = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(hash.trim());
    const id = at ? `${at[1]}-${at[2]}-${at[3]}` : hash.trim();
    let d: { transactions?: unknown };
    try {
      d = await proxyGetJson(`${MIRROR_API}/transactions/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof Error && /^HTTP 404\b/.test(e.message)) return null;
      throw new Error(`${urlHost(MIRROR_BASE)} could not read transaction ${id}: ${condenseHttpError(e)}`);
    }
    const txs = (Array.isArray(d.transactions) ? d.transactions : []) as Array<Record<string, unknown>>;
    if (txs.length === 0) return null;
    // One id also names the child and scheduled transactions it triggered
    // (nonce > 0); the user's own transaction is nonce 0.
    const tx = txs.find((t) => (t.nonce ?? 0) === 0 && t.scheduled !== true) ?? txs[0];
    return hederaTxParties(tx, urlHost(MIRROR_BASE));
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
