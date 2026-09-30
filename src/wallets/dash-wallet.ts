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
  SendOptions,
} from "./types";
import { proxyGetJson } from "./_proxy";
import type { UtxoAccountSpec } from "./utxo-account";
import {
  gatherAccountSpend,
  accountShortfallMessage,
  planAccountSpend,
  P2PKH_SIZING,
  type AccountSpendCandidate,
} from "./utxo-account";
import {
  assertNotDust,
  broadcastSignedTx,
  dustThresholdSat,
  DUST_RELAY_FEE_PER_KB,
  LEGACY_CHAIN_OUTPUTS,
  NO_SEGWIT_BECH32,
  outputVBytes,
  parseSendAmountSat,
  proxyPushEndpoint,
  proxyTxLookup,
  recipientOutput,
  trySources,
  type BroadcastEndpoint,
  type TxLookup,
} from "./utxo-send";
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
  // Dash never activated segwit. This was "dash" — a matchable prefix, so a
  // checksum-valid `dash1…` string decoded to a P2WPKH output Dash nodes treat
  // as anyone-can-spend (2026-09-29 send-safety audit). See NO_SEGWIT_BECH32.
  bech32: NO_SEGWIT_BECH32,
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

/** READ sources in order; every source's error on exhaustion (`trySources`).
 *  Never for broadcasting — see `broadcastDash`. */
function tryEach<T>(sources: Array<{ name: string; fn: () => Promise<T> }>): Promise<T> {
  return trySources<T>("DASH", sources);
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

// The same signed bytes to each endpoint; the outcome decided by
// `broadcastSignedTx` (utxo-send.ts). DASH has only these two, which made the
// 2026-09-29 audit's lost-reply double payment easy to hit here.
const DASH_BROADCAST: BroadcastEndpoint[] = [
  proxyPushEndpoint(
    "blockcypher",
    (hex) => ({
      url: `${BLOCKCYPHER_BASE}/txs/push`,
      body: JSON.stringify({ tx: hex }),
      contentType: "application/json",
    }),
    (body) => JSON.parse(body)?.tx?.hash,
  ),
  proxyPushEndpoint(
    "blockchair",
    (hex) => ({
      url: `${BLOCKCHAIR_BASE}/push/transaction`,
      body: `data=${encodeURIComponent(hex)}`,
      contentType: "application/x-www-form-urlencoded",
    }),
    (body) => JSON.parse(body)?.data?.transaction_hash,
  ),
];

const DASH_LOOKUPS: TxLookup[] = [
  proxyTxLookup("blockcypher", (t) => `${BLOCKCYPHER_BASE}/txs/${t}`, (j) => j?.hash),
  proxyTxLookup(
    "blockchair",
    (t) => `${BLOCKCHAIR_BASE}/dashboards/transaction/${t}`,
    (j, t) => j?.data?.[t]?.transaction?.hash,
  ),
  proxyTxLookup("insight", (t) => `${INSIGHT_BASE}/tx/${t}`, (j) => j?.txid),
];

function broadcastDash(tx: bitcoin.Transaction): Promise<TxResult> {
  return broadcastSignedTx({
    ticker: "DASH",
    txid: tx.getId(),
    rawHex: tx.toHex(),
    endpoints: DASH_BROADCAST,
    lookups: DASH_LOOKUPS,
  });
}

/** Decode a DASH recipient: P2PKH (X…) or P2SH (7…) only. */
function dashRecipient(to: string) {
  return recipientOutput(to, {
    network: dashNetwork,
    ticker: "DASH",
    uriSchemes: ["dash"],
    allowed: LEGACY_CHAIN_OUTPUTS,
  });
}

/** Duffs per vbyte to sign with: the modal's tier when given, else the
 *  oracle (never below the floor). */
async function dashSendFeeRate(override?: number): Promise<number> {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.max(Math.ceil(override), 1);
  }
  const ratePerKb = Math.max(
    await fetchFeeRateBlockcypher().catch(() => MIN_RECOMMENDED_RATE_PER_KB),
    MIN_RECOMMENDED_RATE_PER_KB,
  );
  return Math.max(Math.ceil((ratePerKb * 1e8) / 1000), 1);
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

  // Amount and recipient are settled before anything touches the network
  // (2026-09-29 send-safety audit): `parseFloat` sent "1,5" as 1.
  const sendSat = parseSendAmountSat(amount, "DASH");
  const recipient = dashRecipient(to);
  assertNotDust(sendSat, dustThresholdSat(recipient.script, DUST_RELAY_FEE_PER_KB.dash), "DASH");

  // The oracle quotes DASH/kB; the planner wants duffs/vB.
  const feePerVB = await dashSendFeeRate(opts?.feeRateOverride);

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
    recipientOutputVB: outputVBytes(recipient.script.length),
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
  psbt.addOutput({ script: recipient.script, value: BigInt(sendSat) });
  if (plan.changeSat > 0) {
    psbt.addOutput({ address: change.address, value: BigInt(plan.changeSat) });
  }
  plan.inputs.forEach((input, i) => psbt.signInput(i, keyPairs.get(input.address)!));
  psbt.finalizeAllInputs();

  // Signed once; from here on only these bytes are ever sent.
  return broadcastDash(psbt.extractTransaction());
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
  sendFromAccount(
    mnemonic: string,
    to: string,
    amount: string,
    fromAddress?: string,
    opts?: { feeRate?: number },
  ) {
    return sendDashFromAccount(mnemonic, to, amount, { fromAddress, feeRateOverride: opts?.feeRate });
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
    amount: string,
    _assetType?: string,
    opts?: SendOptions,
  ): Promise<TxResult> {
    // Settled before any request (2026-09-29 send-safety audit).
    const amountDuffs = parseSendAmountSat(amount, "DASH");
    const recipient = dashRecipient(to);
    assertNotDust(amountDuffs, dustThresholdSat(recipient.script, DUST_RELAY_FEE_PER_KB.dash), "DASH");

    const cleaned = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const keyPair = ECPair.fromPrivateKey(Buffer.from(hexToBytes(cleaned)), {
      network: dashNetwork,
    });
    const fromAddress = getAddress(keyPair.publicKey);

    const utxos = await tryEach([
      { name: "blockcypher", fn: () => fetchUtxosBlockcypher(fromAddress) },
      { name: "blockchair", fn: () => fetchUtxosBlockchair(fromAddress) },
    ]);
    if (utxos.length === 0) throw new Error("No DASH UTXOs available");

    // Largest-first selection with the shared planner. Change of 1–546 duffs
    // is folded into the fee: this path used to emit ANY positive change as an
    // output (`change > 0n`), and Dash nodes refuse a transaction carrying a
    // 100-duff output as dust (2026-09-29 send-safety audit).
    const candidates: AccountSpendCandidate[] = utxos.map((u) => {
      if (u.value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(
          `Output ${u.txid}:${u.vout} exceeds 2^53 duffs and cannot be selected safely. Nothing was sent.`,
        );
      }
      return { path: DERIVATION_PATH, address: fromAddress, txid: u.txid, vout: u.vout, valueSat: Number(u.value) };
    });
    const plan = planAccountSpend({
      candidates,
      sendSat: amountDuffs,
      feePerVB: await dashSendFeeRate(opts?.feeRate),
      sizing: P2PKH_SIZING,
      dustSat: DASH_DUST_SAT,
      recipientOutputVB: outputVBytes(recipient.script.length),
    });
    if (!plan.covered) {
      throw new Error("Insufficient DASH balance for amount + fee");
    }

    const psbt = new bitcoin.Psbt({ network: dashNetwork });
    for (const u of plan.inputs) {
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
    psbt.addOutput({ script: recipient.script, value: BigInt(amountDuffs) });
    if (plan.changeSat > 0) {
      psbt.addOutput({ address: fromAddress, value: BigInt(plan.changeSat) });
    }

    psbt.signAllInputs(keyPair);
    psbt.finalizeAllInputs();
    return broadcastDash(psbt.extractTransaction());
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
    let isFallback = false;
    const ratePerKb = await fetchFeeRateBlockcypher().catch(() => {
      isFallback = true;
      return MIN_RECOMMENDED_RATE_PER_KB;
    });
    const satPerVb = (ratePerKb * 1e8) / 1000;
    return {
      normal: { value: satPerVb.toFixed(2) },
      unit: "duffs/vB",
      // 1-in / 2-out P2PKH (10 + 148 + 2×34) — lets the modal show a total.
      typicalTxVBytes: 226,
      ...(isFallback ? { isFallback: true } : {}),
      fetchedAt: Date.now(),
    };
  },
};
