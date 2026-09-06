/**
 * Ravencoin (RVN) ChainAdapter.
 *
 * Network-side architecture (2026-04-25):
 *   - Primary backend: `blockbook.ravencoin.org` (Trezor-style BlockBook,
 *     asset-aware, the same backend Trezor Suite and Edge use). Returns
 *     full vout `hex` so we can detect `OP_RVN_ASSET` (0xC0) and never
 *     spend asset-bearing UTXOs as if they were dust RVN.
 *   - Fallback: legacy Insight-API forks at `api.ravencoin.org` and
 *     `rvn.cryptoscope.io`. These are the same hosts we used pre-2026-04;
 *     kept around as redundancy when BlockBook is throttling or down.
 *
 * Asset safety: a Bitcoin-naive UTXO selector that grabbed every output at
 * the user's address would happily include asset-bearing outputs, and the
 * resulting tx would be rejected by every RVN node ("bad-txns-asset-…" /
 * "asset-tx-malformed"). We filter aggressively — see `isPlainP2pkhScript`.
 *
 * Storage: the RVN private key is never persisted separately; it is
 * derived at unlock time from the BIP39 phrase that lives in the
 * AES-256-GCM-encrypted vault payload (see [[vault-encryption]]). Same
 * model as every other BIP44 chain in this app.
 */

import * as bitcoin from "bitcoinjs-lib";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import * as tinysecp from "tiny-secp256k1";
import ECPairFactory from "ecpair";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
} from "./types";
import { proxyGetJson, proxyPostJson } from "./_proxy";
import type { UtxoAccountSpec } from "./utxo-account";
import type { UtxoProbeResult } from "./_utxo-probes";

bitcoin.initEccLib(tinysecp);
const ECPair = ECPairFactory(tinysecp);

// =========================================================================
// Network parameters
// =========================================================================
//
// `bech32` is intentionally absent. Ravencoin never activated BIP141/BIP173
// (no segwit on chain — see RavenProject/Ravencoin `chainparams.cpp`); the
// nodes don't accept witness-style addresses. Setting a HRP here would be
// cosmetic at best and an active foot-gun at worst (any future call to
// `bitcoin.payments.p2wpkh({ network: rvnNetwork })` would mint addresses
// no node accepts). Removed 2026-04-25.
const rvnNetwork: bitcoin.Network = {
  messagePrefix: "\x16Raven Signed Message:\n",
  // bech32: omitted — see comment above.
  bech32: "",
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 0x3c, // "R…" addresses
  scriptHash: 0x7a, // "r…" addresses (P2SH)
  wif: 0x80,
};

// =========================================================================
// Backends — BlockBook primary, Insight forks fallback
// =========================================================================

const BLOCKBOOK_URL = "https://blockbook.ravencoin.org";
const INSIGHT_URLS = [
  "https://api.ravencoin.org/api",
  "https://rvn.cryptoscope.io/api",
];
const DERIVATION_PATH = "m/44'/175'/0'/0/0";

// Standard P2PKH scriptPubKey (no asset suffix) is exactly 25 bytes:
//   OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG
//   76    a9        14 ...           88            ac
// = 50 hex characters. RVN asset-bearing outputs append OP_RVN_ASSET (0xC0)
// + a varlen asset payload + OP_DROP after the standard prefix, so they
// always exceed 25 bytes. Length-equality is a bulletproof filter and
// doesn't require parsing the asset payload.
const STANDARD_P2PKH_HEX_LEN = 50;

function isPlainP2pkhScript(scriptHex: string | undefined | null): boolean {
  if (!scriptHex) return false;
  return scriptHex.length === STANDARD_P2PKH_HEX_LEN;
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

function getAddress(publicKey: Uint8Array): string {
  const { address } = bitcoin.payments.p2pkh({
    pubkey: Buffer.from(publicKey),
    network: rvnNetwork,
  });
  return address!;
}

/**
 * Derive the RVN wallet at an ARBITRARY HD path. Pwnda's default is
 * `m/44'/175'/0'/0/0`; Exodus fully-hardens the last two steps
 * (`m/44'/175'/0'/0'/0'`). Reuses the EXACT same `getAddress` (p2pkh +
 * rvnNetwork) encoder, so the standard path is byte-identical to
 * `deriveFromMnemonic` (locked by a round-trip test). Exported for
 * `derivePerChoice`.
 */
export function deriveRvnAtPath(mnemonic: string, path: string): WalletInfo {
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  return {
    chain: "ravencoin",
    address: getAddress(child.publicKey!),
    mnemonic: mnemonic.trim(),
    privateKey: bytesToHex(child.privateKey!),
  };
}

// -------------------------------------------------------------------------
// BlockBook V2 helpers
// -------------------------------------------------------------------------

interface BlockBookAddress {
  address: string;
  balance: string; // satoshis as string
  totalReceived?: string;
  totalSent?: string;
  unconfirmedBalance?: string;
  txs?: number;
  txids?: string[];
  transactions?: BlockBookTx[];
}

interface BlockBookVin {
  txid?: string;
  vout?: number;
  addresses?: string[];
  value?: string;
  hex?: string;
}
interface BlockBookVout {
  value?: string;
  n?: number;
  hex?: string;
  addresses?: string[];
}
interface BlockBookTx {
  txid: string;
  blockHeight?: number;
  blockTime?: number;
  confirmations?: number;
  fees?: string;
  vin?: BlockBookVin[];
  vout?: BlockBookVout[];
}

interface BlockBookUtxo {
  txid: string;
  vout: number;
  value: string; // satoshis
  height?: number;
  confirmations?: number;
}

async function blockbookGet<T>(path: string): Promise<T> {
  return proxyGetJson<T>(`${BLOCKBOOK_URL}${path}`);
}

// -------------------------------------------------------------------------
// Insight-fork helpers (fallback)
// -------------------------------------------------------------------------

async function insightGet<T>(path: string): Promise<T> {
  let lastError: unknown = null;
  for (const base of INSIGHT_URLS) {
    try {
      return await proxyGetJson<T>(`${base}${path}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("All Insight-API mirrors failed");
}

// =========================================================================
// Adapter
// =========================================================================

/**
 * Balance + history-existence for one RVN address. Throws when no source
 * answered — never coerces an outage into a zero.
 *
 * **Keys on HISTORY, not balance.** An address that received and spent
 * everything is `used` with `balanceSat: 0`; treating it as unused truncates
 * the gap walk exactly where activity is densest. That is the whole 2026-08-22
 * incident, and the reason this is a probe rather than a call to `getBalance`.
 *
 * BlockBook first (it reports `txs` directly), Insight as the fallback. Insight
 * spells its history counter `txApperances` — the upstream typo is load-bearing
 * and must be matched exactly; the correctly-spelled key does not exist.
 */
async function probeRvnAddress(address: string): Promise<UtxoProbeResult> {
  let lastError: unknown = null;
  try {
    const r = await blockbookGet<BlockBookAddress>(
      `/api/v2/address/${address}?details=basic`,
    );
    if (r.balance === undefined) throw new Error("blockbook: no balance field");
    const conf = Number(BigInt(r.balance ?? "0"));
    const unconf = Number(BigInt(r.unconfirmedBalance ?? "0"));
    return { balanceSat: conf + unconf, used: (r.txs ?? 0) > 0 };
  } catch (e) {
    lastError = e;
  }
  try {
    const r = await insightGet<{
      balanceSat?: number;
      unconfirmedBalanceSat?: number;
      txApperances?: number;
      unconfirmedTxApperances?: number;
    }>(`/addr/${address}?noTxList=1`);
    if (typeof r?.balanceSat !== "number") {
      throw new Error("insight: no balanceSat field");
    }
    const seen = (r.txApperances ?? 0) + (r.unconfirmedTxApperances ?? 0);
    return {
      balanceSat: r.balanceSat + (r.unconfirmedBalanceSat ?? 0),
      used: seen > 0 || r.balanceSat > 0,
    };
  } catch (e) {
    lastError = e;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`All Ravencoin sources failed probing ${address}`);
}

/**
 * Ravencoin's single BIP-44 account.
 *
 * Added 2026-08-25 — RVN was the one UTXO adapter the 2026-08-22 account-wide
 * balance pass missed, so until now its balance came from `getBalance()` on the
 * single index-0 address. That is a strictly worse failure than the sibling
 * send gap: an account-unaware SEND fails loudly and recoverably ("No spendable
 * UTXOs available for this address"), while an account-unaware BALANCE silently
 * shows a number that is too low, with no error to act on.
 *
 * RVN is NOT reachable by BasicSwap — the sidecar has no ravencoin entry at
 * all, so neither C8 account-key sharing nor C3.5 descriptor adoption can touch
 * it — and this app's own send returns change to the sender address. So RVN
 * cannot scatter itself today. It is listed anyway for the reason the DOGE spec
 * above gives: **the account is the truth, the single address is an
 * assumption**, and an imported seed from any wallet that used real BIP-32
 * change addresses arrives already scattered.
 */
export const rvnUtxoAccounts: UtxoAccountSpec[] = [
  {
    chain: "ravencoin",
    accountPath: "m/44'/175'/0'",
    label: "BIP-44 legacy",
    deriveAddress: (node) => getAddress(node.publicKey!),
    probe: probeRvnAddress,
  },
];

export const rvnAdapter: ChainAdapter = {
  utxoAccounts: rvnUtxoAccounts,
  chain: "ravencoin",
  displayName: "Ravencoin",
  ticker: "RVN",
  color: "#7681d4",
  addressPlaceholder: "R...",
  derivation: {
    kind: "bip39",
    path: "m/44'/175'/0'/0/0",
    standard: "BIP-44 coin type 175 — Ravencoin Core",
    hasAlternatives: true,
  },
  /** Arbitrary-path derivation for the generic finder + balance sweep. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    return deriveRvnAtPath(mnemonic, path);
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const privKeyBytes = hexToBytes(privateKey);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes), {
      network: rvnNetwork,
    });
    const address = getAddress(keyPair.publicKey);
    return {
      chain: "ravencoin",
      address,
      mnemonic: "",
      privateKey: bytesToHex(privKeyBytes),
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const seed = mnemonicToSeedSync(mnemonic.trim(), "");
    const root = HDKey.fromMasterSeed(seed);
    const child = root.derive(DERIVATION_PATH);
    const address = getAddress(child.publicKey!);
    return {
      chain: "ravencoin",
      address,
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(child.privateKey!),
    };
  },

  /**
   * Confirmed + mempool RVN balance, in RVN. Asset balances are deliberately
   * not surfaced here (the adapter's `getBalance` is RVN-only by contract).
   * Tries BlockBook first, then Insight-API mirrors. Throws on full
   * exhaustion so the caller can render a real error instead of silently
   * showing zero.
   */
  async getBalance(address: string): Promise<string> {
    let lastError: unknown = null;
    try {
      const r = await blockbookGet<BlockBookAddress>(
        `/api/v2/address/${address}?details=basic`
      );
      const conf = BigInt(r.balance ?? "0");
      const unconf = BigInt(r.unconfirmedBalance ?? "0");
      return (Number(conf + unconf) / 1e8).toFixed(8);
    } catch (e) {
      lastError = e;
    }
    try {
      const sats = await insightGet<number | string>(`/addr/${address}/balance`);
      const conf = Number(sats);
      const mempool = await insightGet<number | string>(
        `/addr/${address}/unconfirmedBalance`
      ).catch(() => 0);
      const unconf = Number(mempool);
      return ((conf + unconf) / 1e8).toFixed(8);
    } catch (e) {
      lastError = e;
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("All Ravencoin sources failed");
  },

  /**
   * Build, sign, and broadcast a 1-of-N → 2-out P2PKH transfer.
   *
   * Asset safety: every UTXO whose scriptPubKey isn't the standard
   * 25-byte P2PKH form is excluded from the input set. That filter
   * catches every asset-bearing output (transfer, issuance, reissuance,
   * owner) because they all append `OP_RVN_ASSET (0xC0) + payload + OP_DROP`
   * after the P2PKH prefix and so always exceed 25 bytes.
   *
   * Fees: estimated against the live RVN-network fee oracle via
   * `getFeeEstimate()`; capped at the consensus floor of 0.01 RVN/kB.
   * Standard 1-in / 2-out segwit-less tx is ≈ 226 vbytes.
   */
  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    const privKeyBytes = hexToBytes(privateKey);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes), {
      network: rvnNetwork,
    });
    const senderAddress = getAddress(keyPair.publicKey);

    // 1) Fetch UTXOs (BlockBook first, Insight fallback).
    let utxos: BlockBookUtxo[] = [];
    try {
      utxos = await blockbookGet<BlockBookUtxo[]>(
        `/api/v2/utxo/${senderAddress}?confirmed=true`
      );
    } catch {
      const insightUtxos = await insightGet<
        Array<{ txid: string; vout: number; satoshis?: number; amount?: number; confirmations?: number }>
      >(`/addr/${senderAddress}/utxo`);
      utxos = insightUtxos.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value:
          u.satoshis !== undefined
            ? String(u.satoshis)
            : String(Math.round((u.amount ?? 0) * 1e8)),
        confirmations: u.confirmations,
      }));
    }
    if (utxos.length === 0) {
      throw new Error("No spendable UTXOs available for this address.");
    }

    // 2) Resolve each UTXO's scriptPubKey via tx detail. We need the script
    //    bytes for two reasons: PSBT input construction (legacy `nonWitnessUtxo`
    //    requires the full prev tx), and asset-aware filtering. BlockBook's
    //    `/tx/{txid}` returns vouts with a `hex` field for scriptPubKey AND
    //    a top-level `hex` field for the full raw transaction.
    interface TxDetail {
      hex?: string;
      vout?: BlockBookVout[];
    }
    const txDetailCache = new Map<string, TxDetail>();
    const resolveTx = async (txid: string): Promise<TxDetail> => {
      const cached = txDetailCache.get(txid);
      if (cached) return cached;
      let detail: TxDetail | null = null;
      try {
        detail = await blockbookGet<TxDetail>(`/api/v2/tx/${txid}`);
      } catch {
        // Insight `/rawtx/{txid}` returns `{rawtx: hex}`; vout details from
        // `/tx/{txid}`. We need both.
        try {
          const raw = await insightGet<{ rawtx: string }>(`/rawtx/${txid}`);
          const tx = await insightGet<{ vout: { scriptPubKey?: { hex?: string } }[] }>(
            `/tx/${txid}`
          );
          detail = {
            hex: raw.rawtx,
            vout: (tx.vout ?? []).map((v) => ({ hex: v.scriptPubKey?.hex })),
          };
        } catch {
          throw new Error(`Failed to resolve tx ${txid} from any backend`);
        }
      }
      txDetailCache.set(txid, detail);
      return detail;
    };

    const spendable: Array<{
      utxo: BlockBookUtxo;
      rawTxHex: string;
      scriptHex: string;
      sats: bigint;
    }> = [];
    for (const u of utxos) {
      const detail = await resolveTx(u.txid);
      const out = detail.vout?.[u.vout];
      const scriptHex = out?.hex ?? "";
      if (!isPlainP2pkhScript(scriptHex)) continue; // asset-bearing — skip
      if (!detail.hex) continue; // need raw tx for legacy PSBT
      spendable.push({
        utxo: u,
        rawTxHex: detail.hex,
        scriptHex,
        sats: BigInt(u.value || "0"),
      });
    }
    if (spendable.length === 0) {
      throw new Error(
        "No plain RVN UTXOs available — all outputs at this address carry assets."
      );
    }

    // 3) Pick a fee rate. Try the live oracle, fall back to the consensus
    //    floor of 0.01 RVN/kB.
    let feePerKbRvn = 0.01;
    try {
      const fee = await this.getFeeEstimate();
      const v = Number(fee.normal.value);
      if (Number.isFinite(v) && v > 0) feePerKbRvn = Math.max(v, 0.01);
    } catch {
      /* keep default */
    }
    const estimatedSizeBytes = 226n; // 1-in 2-out P2PKH
    const feeSat = BigInt(Math.ceil((feePerKbRvn * 1e8 * Number(estimatedSizeBytes)) / 1000));

    const sendSat = BigInt(Math.round(parseFloat(amount) * 1e8));
    if (sendSat <= 0n) throw new Error("Amount must be greater than zero.");

    // 4) Greedy input selection (largest first) until we cover sendSat + fee.
    spendable.sort((a, b) => (a.sats < b.sats ? 1 : a.sats > b.sats ? -1 : 0));
    const selected: typeof spendable = [];
    let total = 0n;
    for (const s of spendable) {
      selected.push(s);
      total += s.sats;
      if (total >= sendSat + feeSat) break;
    }
    if (total < sendSat + feeSat) {
      const have = (Number(total) / 1e8).toFixed(8);
      const need = (Number(sendSat + feeSat) / 1e8).toFixed(8);
      throw new Error(
        `Insufficient funds. Have ${have} RVN, need ${need} RVN (incl. ~${(
          Number(feeSat) / 1e8
        ).toFixed(8)} fee).`
      );
    }

    // 5) Build PSBT.
    const psbt = new bitcoin.Psbt({ network: rvnNetwork });
    for (const s of selected) {
      psbt.addInput({
        hash: s.utxo.txid,
        index: s.utxo.vout,
        // Legacy P2PKH input — RVN is pre-segwit, must use nonWitnessUtxo.
        nonWitnessUtxo: Buffer.from(s.rawTxHex, "hex"),
      });
    }
    psbt.addOutput({ address: to, value: sendSat });
    const change = total - sendSat - feeSat;
    if (change >= 546n) {
      // Above dust — add a change output back to ourselves. Index reuse
      // (sender == change addr) matches the rest of this app today; xpub
      // discovery would split this out.
      psbt.addOutput({ address: senderAddress, value: change });
    }

    // 6) Sign every input with the same key (single-key wallet today).
    for (let i = 0; i < psbt.inputCount; i++) {
      psbt.signInput(i, keyPair as any);
    }
    psbt.finalizeAllInputs();
    const rawTxHex = psbt.extractTransaction().toHex();

    // 7) Broadcast — BlockBook first, Insight fallback. BlockBook's
    //    `/api/v2/sendtx/{hex}` accepts a GET with the tx hex in the path;
    //    POST `/api/v2/sendtx` with the hex body works too. Insight uses
    //    `POST /tx/send` with `{ rawtx }`.
    let txid: string | null = null;
    try {
      const r = await proxyPostJson<{ result?: string; error?: { message?: string } }>(
        `${BLOCKBOOK_URL}/api/v2/sendtx`,
        rawTxHex,
        { "Content-Type": "text/plain" }
      );
      if (r.error?.message) throw new Error(r.error.message);
      if (r.result) txid = r.result;
    } catch (e) {
      // Insight fallback.
      try {
        for (const base of INSIGHT_URLS) {
          try {
            const r = await proxyPostJson<{ txid?: string }>(
              `${base}/tx/send`,
              { rawtx: rawTxHex }
            );
            if (r.txid) {
              txid = r.txid;
              break;
            }
          } catch {
            /* try next mirror */
          }
        }
      } catch {
        /* fallthrough */
      }
      if (!txid) throw e;
    }
    if (!txid) throw new Error("Broadcast returned no txid.");
    return { hash: txid };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const r = await blockbookGet<{ blockbook?: { bestHeight?: number }; backend?: { blocks?: number } }>(
        `/api`
      );
      const h = r.backend?.blocks ?? r.blockbook?.bestHeight;
      return {
        label: "Block",
        value: h ? h.toLocaleString() : "N/A",
        unit: "",
      };
    } catch {
      try {
        const data = await insightGet<{ info?: { blocks?: number } }>(`/status`);
        return {
          label: "Block",
          value: data.info?.blocks?.toLocaleString() ?? "N/A",
          unit: "",
        };
      } catch {
        return { label: "Network", value: "Mainnet", unit: "" };
      }
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;

    // Prefer BlockBook (asset-aware payload, gives us a `meta.assets`
    // field for txs that move tokens). Fall back to Insight on any error.
    try {
      const page = opts?.cursor ? Number(opts.cursor) : 1;
      const r = await blockbookGet<BlockBookAddress & {
        page?: number;
        totalPages?: number;
      }>(`/api/v2/address/${address}?details=txs&page=${page}&pageSize=${limit}`);
      const txs = r.transactions ?? [];
      const items: ChainTx[] = txs.map((tx) => bbTxToChainTx(tx, address));
      const next =
        r.page !== undefined && r.totalPages !== undefined && r.page < r.totalPages
          ? String(r.page + 1)
          : undefined;
      return { items, cursor: next };
    } catch {
      // Insight fallback (legacy path).
      const from = opts?.cursor ? Number(opts.cursor) : 0;
      const to = from + limit;
      const data = await insightGet<{ items: any[] }>(
        `/addrs/${address}/txs?from=${from}&to=${to}`
      );
      const items: ChainTx[] = (data.items ?? []).map((tx) =>
        insightTxToChainTx(tx, address)
      );
      const cursor = items.length === limit ? String(to) : undefined;
      return { items, cursor };
    }
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // BlockBook exposes `/api/v2/estimatefee/{blocks}` returning RVN/kB.
    // Try it first, then Insight `/utils/estimatefee`. If both fail, fall
    // back to the consensus floor and tag the result so the UI can label
    // it as a static estimate.
    let estimate: number | null = null;
    let source: "blockbook" | "insight" | "static" = "static";
    try {
      const r = await blockbookGet<{ result?: string }>(`/api/v2/estimatefee/2`);
      const v = Number(r.result);
      if (Number.isFinite(v) && v > 0) {
        estimate = v;
        source = "blockbook";
      }
    } catch {
      /* try Insight */
    }
    if (estimate === null) {
      for (const base of INSIGHT_URLS) {
        try {
          const data = await proxyGetJson<Record<string, number>>(
            `${base}/utils/estimatefee?nbBlocks=2`
          );
          const v = data["2"] ?? data["1"];
          if (typeof v === "number" && v > 0) {
            estimate = v;
            source = "insight";
            break;
          }
        } catch {
          /* try next */
        }
      }
    }
    const perKb = Math.max(estimate ?? 0.01, 0.01); // floor at consensus min
    return {
      normal: { value: perKb.toFixed(8) },
      unit: "RVN/kB",
      fetchedAt: Date.now(),
      raw: { perKb, source },
    };
  },
};

// =========================================================================
// Tx → ChainTx mappers
// =========================================================================

/**
 * BlockBook returns vins with `addresses` and `value` resolved server-side
 * (no separate prevout lookup needed). This makes net-balance computation
 * a one-pass walk over inputs and outputs. Asset-bearing vouts are flagged
 * by `hex.length !== 50`; we leave them in the count for `meta.hadAsset`
 * but exclude their `value` from the RVN delta.
 */
function bbTxToChainTx(tx: BlockBookTx, address: string): ChainTx {
  let outFromMe = 0n;
  for (const vin of tx.vin ?? []) {
    if ((vin.addresses ?? []).includes(address)) {
      outFromMe += BigInt(vin.value ?? "0");
    }
  }
  let inToMe = 0n;
  let firstExternal: string | undefined;
  let touchedAsset = false;
  for (const vout of tx.vout ?? []) {
    if (!isPlainP2pkhScript(vout.hex ?? "")) {
      touchedAsset = true;
      continue;
    }
    const addrs = vout.addresses ?? [];
    const v = BigInt(vout.value ?? "0");
    if (addrs.includes(address)) inToMe += v;
    else if (!firstExternal && addrs[0]) firstExternal = addrs[0];
  }
  const net = inToMe - outFromMe;
  const direction: ChainTx["direction"] =
    net > 0n ? "in" : net < 0n ? "out" : "self";
  const fee = tx.fees ? (Number(tx.fees) / 1e8).toFixed(8) : undefined;
  return {
    chain: "ravencoin",
    hash: tx.txid,
    direction,
    amount: (Number(net < 0n ? -net : net) / 1e8).toFixed(8),
    fee: direction === "out" ? fee : undefined,
    timestamp: tx.blockTime,
    confirmations: tx.confirmations,
    height: tx.blockHeight,
    counterparty: direction === "out" ? firstExternal : undefined,
    meta: { hadAsset: touchedAsset || undefined },
  };
}

/**
 * Insight V1 fallback shape. Less detail than BlockBook (no per-vout `hex`
 * for asset detection), so we approximate: any tx whose recorded RVN net
 * is zero AND has more than 1 vout is probably an asset-only tx and gets
 * the `hadAsset` marker. False-positive rate is low because regular RVN
 * transfers always move some non-zero amount.
 */
function insightTxToChainTx(tx: any, address: string): ChainTx {
  let outFromMe = 0;
  for (const vin of tx.vin ?? []) {
    if (vin.addr === address) outFromMe += Math.round((vin.value ?? 0) * 1e8);
  }
  let inToMe = 0;
  let firstExternalOut: string | undefined;
  for (const vout of tx.vout ?? []) {
    const addr = vout.scriptPubKey?.addresses?.[0];
    const sat = Math.round(parseFloat(vout.value ?? "0") * 1e8);
    if (addr === address) inToMe += sat;
    else if (!firstExternalOut && addr) firstExternalOut = addr;
  }
  const net = inToMe - outFromMe;
  const direction: ChainTx["direction"] =
    net > 0 ? "in" : net < 0 ? "out" : "self";
  const fee = tx.fees ? Number(tx.fees).toFixed(8) : undefined;
  return {
    chain: "ravencoin",
    hash: tx.txid,
    direction,
    amount: (Math.abs(net) / 1e8).toFixed(8),
    fee: direction === "out" ? fee : undefined,
    timestamp: tx.time,
    confirmations: tx.confirmations,
    height: tx.blockheight,
    counterparty: direction === "out" ? firstExternalOut : undefined,
    meta: {
      hadAsset:
        net === 0 && (tx.vout?.length ?? 0) > 1 ? true : undefined,
      _via: "insight",
    },
  };
}
