/**
 * Dash (DASH) ChainAdapter — full send + receive + history.
 *
 * Phase 5 (2026-05-08). Dash is a Bitcoin fork: UTXO-based, P2PKH legacy
 * script, secp256k1 ECDSA signing, standard SIGHASH_ALL. Differences from
 * BTC/LTC/DOGE that matter:
 *   - Address P2PKH version byte: 0x4c (addresses start with `X`).
 *   - Address P2SH version byte:  0x10 (addresses start with `7`).
 *   - WIF prefix: 0xcc.
 *   - No segwit. Same legacy sighash as DOGE.
 *
 * Multi-source: BlockCypher Dash + Blockchair Dash. Same fallback pattern
 * as doge-wallet.ts.
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
import { proxyGetJson, proxyPostJson, httpProxyCall } from "./_proxy";
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
  type UtxoProbeResult,
} from "./_utxo-probes";

bitcoin.initEccLib(tinysecp);
const ECPair = ECPairFactory(tinysecp);

// =========================================================================
// Network parameters (Dash Core `chainparams.cpp`)
// =========================================================================

const dashNetwork: bitcoin.Network = {
  messagePrefix: "\x19DarkCoin Signed Message:\n",
  bech32: "dash", // placeholder — Dash never activated segwit
  bip32: { public: 0x0488b21e, private: 0x0488ade4 }, // standard BIP-32
  pubKeyHash: 0x4c, // "X..." legacy P2PKH
  scriptHash: 0x10, // "7..." P2SH
  wif: 0xcc,
};

const BLOCKCYPHER_BASE = "https://api.blockcypher.com/v1/dash/main";
const BLOCKCHAIR_BASE = "https://api.blockchair.com/dash";
// Dash's official Insight explorer API — keyless, no Cloudflare gate, and not
// subject to BlockCypher's hourly cap or Blockchair's free-tier IP blacklist
// (HTTP 430), both of which left DASH blank ("—") under a multi-chain refresh
// (2026-06-17 — DASH had ONLY those two sources). Bitcore doesn't serve DASH,
// so Insight is the reliable primary. Verified live: HTTP 200, returns
// {balanceSat, unconfirmedBalanceSat}.
const INSIGHT_BASE = "https://insight.dash.org/insight-api";
const DERIVATION_PATH = "m/44'/5'/0'/0/0"; // BIP-44, SLIP-44 coin type 5 = Dash

// Standard 1-in 2-out P2PKH tx is ~226 bytes. Same as DOGE.
const STANDARD_TX_BYTES = 226;
const MIN_RECOMMENDED_RATE_PER_KB = 0.0001; // DASH/kB — Dash relays cheaply

// =========================================================================
// Helpers
// =========================================================================

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
    network: dashNetwork,
  });
  return address!;
}

/**
 * Derive the DASH wallet at an ARBITRARY HD path. Pwnda's default is
 * `m/44'/5'/0'/0/0`; Atomic uses a 3-step path (`m/44'/5'/0'`). Reuses the
 * EXACT same `getAddress` (p2pkh + dashNetwork) encoder, so the standard
 * path is byte-identical to `deriveFromMnemonic` (locked by a round-trip
 * test). Exported for `derivePerChoice`.
 */
export function deriveDashAtPath(mnemonic: string, path: string): WalletInfo {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  if (!child.privateKey || !child.publicKey) {
    throw new Error("dash: derive failed (missing keys)");
  }
  return {
    chain: "dash",
    address: getAddress(child.publicKey),
    mnemonic,
    privateKey: bytesToHex(child.privateKey),
  };
}

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
    `All ${tried.length} DASH source(s) failed [${tried.join(", ")}]: ${tail}`
  );
}

function estimateTxBytes(inputCount: number, outputCount = 2): number {
  return 10 + 148 * inputCount + 34 * outputCount;
}

interface NormalizedUtxo {
  txid: string;
  vout: number;
  /** Duff value (1 DASH = 1e8 duffs). */
  value: bigint;
}

// =========================================================================
// Balance
// =========================================================================

async function fetchBalanceInsight(addr: string): Promise<string> {
  // Insight `/addr/{addr}?noTxList=1` returns confirmed + unconfirmed balance
  // in satoshis (unconfirmedBalanceSat can be negative for pending spends).
  const r = await proxyGetJson<{
    balanceSat?: number;
    unconfirmedBalanceSat?: number;
  }>(`${INSIGHT_BASE}/addr/${addr}?noTxList=1`);
  const sat = (r.balanceSat ?? 0) + (r.unconfirmedBalanceSat ?? 0);
  return (Math.max(0, sat) / 1e8).toFixed(8);
}

async function fetchBalanceBlockcypher(addr: string): Promise<string> {
  const r = await proxyGetJson<{ balance: number; unconfirmed_balance: number }>(
    `${BLOCKCYPHER_BASE}/addrs/${addr}/balance`
  );
  return (((r.balance || 0) + (r.unconfirmed_balance || 0)) / 1e8).toFixed(8);
}

async function fetchBalanceBlockchair(addr: string): Promise<string> {
  const r = await proxyGetJson<{
    data: Record<string, { address: { balance: number } }>;
  }>(`${BLOCKCHAIR_BASE}/dashboards/address/${addr}?limit=1`);
  const sat = r.data?.[addr]?.address?.balance ?? 0;
  return (sat / 1e8).toFixed(8);
}

// =========================================================================
// UTXOs
// =========================================================================

async function fetchUtxosBlockcypher(addr: string): Promise<NormalizedUtxo[]> {
  const r = await proxyGetJson<{
    txrefs?: Array<{ tx_hash: string; tx_output_n: number; value: number }>;
    unconfirmed_txrefs?: Array<{ tx_hash: string; tx_output_n: number; value: number }>;
  }>(`${BLOCKCYPHER_BASE}/addrs/${addr}?unspentOnly=true&limit=2000`);
  const all = [...(r.txrefs ?? []), ...(r.unconfirmed_txrefs ?? [])];
  return all.map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_output_n,
    value: BigInt(u.value),
  }));
}

async function fetchUtxosBlockchair(addr: string): Promise<NormalizedUtxo[]> {
  const r = await proxyGetJson<{
    data: Record<
      string,
      { utxo?: Array<{ transaction_hash: string; index: number; value: number }> }
    >;
  }>(`${BLOCKCHAIR_BASE}/dashboards/address/${addr}?limit=2000`);
  const utxos = r.data?.[addr]?.utxo ?? [];
  return utxos.map((u) => ({
    txid: u.transaction_hash,
    vout: u.index,
    value: BigInt(u.value),
  }));
}

// =========================================================================
// Prev-tx hex (for nonWitnessUtxo)
// =========================================================================

async function fetchPrevTxHexBlockcypher(txid: string): Promise<string> {
  const r = await proxyGetJson<{ hex?: string }>(
    `${BLOCKCYPHER_BASE}/txs/${txid}?includeHex=true&limit=0`
  );
  if (!r.hex) throw new Error("blockcypher tx: no hex");
  return r.hex;
}

async function fetchPrevTxHexBlockchair(txid: string): Promise<string> {
  const r = await proxyGetJson<{
    data: Record<string, { raw_transaction?: string }>;
  }>(`${BLOCKCHAIR_BASE}/raw/transaction/${txid}`);
  const hex = r.data?.[txid]?.raw_transaction;
  if (!hex) throw new Error("blockchair raw: no rawtx");
  return hex;
}

// =========================================================================
// Broadcast
// =========================================================================

async function broadcastBlockcypher(rawHex: string): Promise<string> {
  const r = await proxyPostJson<{ tx?: { hash?: string }; error?: string }>(
    `${BLOCKCYPHER_BASE}/txs/push`,
    { tx: rawHex }
  );
  if (r.error) throw new Error(`blockcypher push: ${r.error}`);
  if (!r.tx?.hash) throw new Error("blockcypher push: no hash");
  return r.tx.hash;
}

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

// =========================================================================
// Fee oracle — Dash relays cheap; default to ~0.0001 DASH/kB
// =========================================================================

async function fetchFeeRateBlockcypher(): Promise<number> {
  // BlockCypher's Dash chain endpoint exposes high/medium/low_fee_per_kb in duffs.
  const r = await proxyGetJson<{
    high_fee_per_kb?: number;
    medium_fee_per_kb?: number;
    low_fee_per_kb?: number;
  }>(`${BLOCKCYPHER_BASE}`);
  const duffs = r.medium_fee_per_kb ?? r.high_fee_per_kb ?? 10000;
  return duffs / 1e8;
}

// =========================================================================
// Tx history
// =========================================================================

interface BlockCypherTxRef {
  tx_hash: string;
  block_height: number;
  confirmations: number;
  confirmed?: string;
  value: number;
  tx_input_n: number;
  tx_output_n: number;
  spent: boolean;
  ref_balance?: number;
}

async function fetchHistoryBlockcypher(
  addr: string,
  limit = 25
): Promise<ChainTx[]> {
  const r = await proxyGetJson<{
    txrefs?: BlockCypherTxRef[];
    unconfirmed_txrefs?: BlockCypherTxRef[];
  }>(`${BLOCKCYPHER_BASE}/addrs/${addr}?limit=${limit}`);
  const all = [...(r.unconfirmed_txrefs ?? []), ...(r.txrefs ?? [])];
  return all.map<ChainTx>((t) => ({
    chain: "dash",
    hash: t.tx_hash,
    direction: t.tx_input_n >= 0 ? "out" : "in",
    amount: (Math.abs(t.value) / 1e8).toFixed(8),
    timestamp: t.confirmed ? Math.floor(new Date(t.confirmed).getTime() / 1000) : undefined,
    confirmations: t.confirmations ?? 0,
    height: t.block_height > 0 ? t.block_height : undefined,
  }));
}

// =========================================================================
// Adapter
// =========================================================================

/** Balance + history-existence for one DASH address. Throws when no source
 *  answered — never coerces an outage into a zero. */
async function probeDashAddress(address: string): Promise<UtxoProbeResult> {
  return tryEach<UtxoProbeResult>([
    { name: "blockchair", fn: () => blockchairProbe(BLOCKCHAIR_BASE, address) },
    { name: "blockcypher", fn: () => blockcypherProbe(BLOCKCYPHER_BASE, address) },
  ]);
}

/** Dash's single BIP-44 account — see the DOGE note for why the account, and
 *  not one address, is what gets scanned. */
export const dashUtxoAccounts: UtxoAccountSpec[] = [
  {
    chain: "dash",
    accountPath: "m/44'/5'/0'",
    label: "BIP-44 legacy",
    deriveAddress: (node) => getAddress(node.publicKey!),
    probe: probeDashAddress,
  },
];

/**
 * DASH standard relay dust, in duffs.
 *
 * 546 — Bitcoin's value, NOT Dogecoin's 1_000_000. Dash Core inherits Bitcoin's
 * dust policy; Dogecoin deliberately raised it. This constant was very nearly
 * copied across from `doge-wallet.ts` while adapting that file's structure,
 * which would have folded up to 0.01 DASH of legitimate change into the fee on
 * every send. A threshold is a property of the chain, not of the file you
 * copied the shape from.
 */
export const DASH_DUST_SAT = 546;

/**
 * Spend from the whole DASH account.
 *
 * See `sendLtcFromAccount` in `ltc-wallet.ts` for the rationale and the survey
 * of how other wallets do this; the scan/derive/select half is shared
 * (`gatherAccountSpend`). Dash-specific: legacy P2PKH sizing, `nonWitnessUtxo`
 * inputs (so one prev-tx fetch per distinct funding txid), a two-source
 * explorer set, and the 546-duff dust floor above.
 */
export async function sendDashFromAccount(
  mnemonic: string,
  to: string,
  amount: string,
  opts?: { feeRateOverride?: number; gapLimit?: number; fromAddress?: string },
): Promise<TxResult> {
  const spec = dashUtxoAccounts[0];
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const account = HDKey.fromMasterSeed(seed).derive(spec.accountPath);
  const primaryAddress = spec.deriveAddress(account.deriveChild(0).deriveChild(0));
  if (opts?.fromAddress && opts.fromAddress !== primaryAddress) {
    throw new Error(
      `${opts.fromAddress} is not this seed's index-0 DASH address ` +
        `(${primaryAddress}). Nothing was sent.`,
    );
  }

  const sendSat = Math.round(parseFloat(amount) * 1e8);
  if (!Number.isFinite(sendSat) || sendSat <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  // The oracle quotes DASH/kB; the planner wants duffs/vB.
  const ratePerKb = Math.max(
    await fetchFeeRateBlockcypher().catch(() => MIN_RECOMMENDED_RATE_PER_KB),
    MIN_RECOMMENDED_RATE_PER_KB,
  );
  const feePerVB =
    opts?.feeRateOverride ?? Math.max(Math.ceil((ratePerKb * 1e8) / 1000), 1);

  // Change goes to the internal chain's lowest unused index (2026-09-04) —
  // the BIP-44 rule every surveyed wallet and the swap engine follow — not
  // back to the displayed address. See `nextChangeIndex` in utxo-account.ts.
  const { plan, sources, change } = await gatherAccountSpend({
    mnemonic,
    spec,
    sendSat,
    feePerVB,
    sizing: P2PKH_SIZING,
    dustSat: DASH_DUST_SAT,
    gapLimit: opts?.gapLimit,
    fetchUtxos: async (address) => {
      const utxos = await tryEach([
        { name: "blockcypher", fn: () => fetchUtxosBlockcypher(address) },
        { name: "blockchair", fn: () => fetchUtxosBlockchair(address) },
      ]);
      // bigint here, number in the shared planner. Check BEFORE narrowing —
      // checking after would inspect a value that already lost precision.
      return utxos.map((u) => {
        if (u.value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(
            `Output ${u.txid}:${u.vout} exceeds 2^53 duffs and cannot be ` +
              "selected safely. Nothing was sent.",
          );
        }
        return { txid: u.txid, vout: u.vout, valueSat: Number(u.value) };
      });
    },
  });

  if (!plan.covered) {
    const held = plan.inputs.reduce((t, i) => t + i.valueSat, 0);
    throw new Error(accountShortfallMessage(plan, held, plan.inputs.length, "DASH"));
  }

  const prevTx = new Map<string, string>();
  for (const input of plan.inputs) {
    if (prevTx.has(input.txid)) continue;
    prevTx.set(
      input.txid,
      await tryEach([
        { name: "blockcypher", fn: () => fetchPrevTxHexBlockcypher(input.txid) },
        { name: "blockchair", fn: () => fetchPrevTxHexBlockchair(input.txid) },
      ]),
    );
  }

  const psbt = new bitcoin.Psbt({ network: dashNetwork });
  const keyPairs = new Map<string, ReturnType<typeof ECPair.fromPrivateKey>>();
  for (const input of plan.inputs) {
    if (!keyPairs.has(input.address)) {
      const src = sources.get(input.address);
      if (!src) throw new Error(`No signer for ${input.address}; nothing was sent.`);
      keyPairs.set(
        input.address,
        ECPair.fromPrivateKey(Buffer.from(src.node.privateKey!), {
          network: dashNetwork,
        }),
      );
    }
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      nonWitnessUtxo: Buffer.from(hexToBytes(prevTx.get(input.txid)!)),
    });
  }
  psbt.addOutput({ address: to, value: BigInt(sendSat) });
  if (plan.changeSat > 0) {
    psbt.addOutput({ address: change.address, value: BigInt(plan.changeSat) });
  }
  plan.inputs.forEach((input, i) => psbt.signInput(i, keyPairs.get(input.address)!));
  psbt.finalizeAllInputs();
  const rawHex = psbt.extractTransaction().toHex();

  const hash = await tryEach([
    { name: "blockcypher", fn: () => broadcastBlockcypher(rawHex) },
    { name: "blockchair", fn: () => broadcastBlockchair(rawHex) },
  ]);
  return { hash };
}

export const dashAdapter: ChainAdapter = {
  /** DASH has one account; account-wide send serves any wallet on it. */
  supportsAccountSend(mnemonic: string, address: string) {
    const spec = dashUtxoAccounts[0];
    const seed = mnemonicToSeedSync(mnemonic.trim(), "");
    const node = HDKey.fromMasterSeed(seed)
      .derive(spec.accountPath)
      .deriveChild(0)
      .deriveChild(0);
    return spec.deriveAddress(node) === address;
  },

  /** Account-wide send — see `sendDashFromAccount`. */
  sendFromAccount(mnemonic: string, to: string, amount: string, fromAddress?: string) {
    return sendDashFromAccount(mnemonic, to, amount, { fromAddress });
  },
  utxoAccounts: dashUtxoAccounts,
  chain: "dash",
  displayName: "Dash",
  ticker: "DASH",
  color: "#008de4",
  addressPlaceholder: "X...",
  derivation: {
    kind: "bip39",
    path: "m/44'/5'/0'/0/0",
    standard: "BIP-44 coin type 5 — Dash Core",
    hasAlternatives: true,
  },
  /** Arbitrary-path derivation for the generic finder + balance sweep. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    return deriveDashAtPath(mnemonic, path);
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const cleaned = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const keyPair = ECPair.fromPrivateKey(Buffer.from(hexToBytes(cleaned)), {
      network: dashNetwork,
    });
    return {
      chain: "dash",
      address: getAddress(keyPair.publicKey),
      mnemonic: "",
      privateKey: cleaned,
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const seed = mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    const child = root.derive(DERIVATION_PATH);
    if (!child.privateKey || !child.publicKey) {
      throw new Error("dash: derive failed (missing keys)");
    }
    const privateKey = bytesToHex(child.privateKey);
    return {
      chain: "dash",
      address: getAddress(child.publicKey),
      mnemonic,
      privateKey,
    };
  },

  async getBalance(address: string): Promise<string> {
    return tryEach([
      // Insight first — keyless, no Cloudflare gate, immune to the
      // BlockCypher 429 / Blockchair 430 that blanked DASH (2026-06-17).
      { name: "insight", fn: () => fetchBalanceInsight(address) },
      { name: "blockcypher", fn: () => fetchBalanceBlockcypher(address) },
      { name: "blockchair", fn: () => fetchBalanceBlockchair(address) },
    ]);
  },

  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    const cleaned = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const keyPair = ECPair.fromPrivateKey(Buffer.from(hexToBytes(cleaned)), {
      network: dashNetwork,
    });
    const fromAddress = getAddress(keyPair.publicKey);
    const amountDuffs = BigInt(Math.round(parseFloat(amount) * 1e8));

    const utxos = await tryEach([
      { name: "blockcypher", fn: () => fetchUtxosBlockcypher(fromAddress) },
      { name: "blockchair", fn: () => fetchUtxosBlockchair(fromAddress) },
    ]);
    if (utxos.length === 0) throw new Error("No DASH UTXOs available");

    const feeRatePerKb = await fetchFeeRateBlockcypher().catch(
      () => MIN_RECOMMENDED_RATE_PER_KB
    );
    const ratePerKb = Math.max(feeRatePerKb, MIN_RECOMMENDED_RATE_PER_KB);

    // Sort UTXOs largest-first; pick until we cover amount + fee.
    const sorted = [...utxos].sort((a, b) => Number(b.value - a.value));
    const picked: NormalizedUtxo[] = [];
    let inSum = 0n;
    let feeDuffs = 0n;
    for (const u of sorted) {
      picked.push(u);
      inSum += u.value;
      const bytes = estimateTxBytes(picked.length, 2);
      feeDuffs = BigInt(Math.ceil(((bytes / 1000) * ratePerKb) * 1e8));
      if (inSum >= amountDuffs + feeDuffs) break;
    }
    if (inSum < amountDuffs + feeDuffs) {
      throw new Error("Insufficient DASH balance for amount + fee");
    }
    const change = inSum - amountDuffs - feeDuffs;

    const psbt = new bitcoin.Psbt({ network: dashNetwork });
    for (const u of picked) {
      const prevHex = await tryEach([
        { name: "blockcypher", fn: () => fetchPrevTxHexBlockcypher(u.txid) },
        { name: "blockchair", fn: () => fetchPrevTxHexBlockchair(u.txid) },
      ]);
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        nonWitnessUtxo: Buffer.from(hexToBytes(prevHex)),
      });
    }
    psbt.addOutput({ address: to, value: amountDuffs });
    if (change > 0n) {
      psbt.addOutput({ address: fromAddress, value: change });
    }

    psbt.signAllInputs(keyPair);
    psbt.finalizeAllInputs();
    const rawHex = psbt.extractTransaction().toHex();

    const hash = await tryEach([
      { name: "blockcypher", fn: () => broadcastBlockcypher(rawHex) },
      { name: "blockchair", fn: () => broadcastBlockchair(rawHex) },
    ]);
    return { hash };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const ratePerKb = await fetchFeeRateBlockcypher();
      const satPerVb = (ratePerKb * 1e8) / 1000;
      return {
        label: "Fee",
        value: satPerVb.toFixed(2),
        unit: "duffs/vB",
      };
    } catch {
      return { label: "Fee", value: "1.00", unit: "duffs/vB" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    const items = await fetchHistoryBlockcypher(address, limit).catch(() => []);
    return { items };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    const ratePerKb = await fetchFeeRateBlockcypher().catch(
      () => MIN_RECOMMENDED_RATE_PER_KB
    );
    const satPerVb = (ratePerKb * 1e8) / 1000;
    return {
      normal: { value: satPerVb.toFixed(2) },
      unit: "duffs/vB",
      fetchedAt: Date.now(),
    };
  },
};
