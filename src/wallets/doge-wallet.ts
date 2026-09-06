/**
 * Dogecoin (DOGE) ChainAdapter — full send + receive + history.
 *
 * Pure HTTP, no local node. UTXO listing, prev-tx hex resolution, fee
 * oracle, broadcast, balance, and history each rotate across multiple
 * keyless public backends. A single-endpoint outage rolls over to the
 * next without surfacing as a user-visible failure.
 *
 * Network-side architecture (2026-04-27):
 *   - BlockCypher  `api.blockcypher.com/v1/doge/main` — primary for
 *     UTXO + prev-tx hex + broadcast + fee tiers; richest single
 *     surface in the public DOGE ecosystem.
 *   - Blockchair   `api.blockchair.com/dogecoin`     — primary for
 *     history (one-shot dashboard + batched tx detail), fallback for
 *     balance / UTXO / broadcast.
 *   - dogechain.info `dogechain.info/api/v1`         — tertiary for
 *     balance + UTXO + broadcast. API shape less consistent than the
 *     other two so we treat it as last-resort.
 *
 * All three hosts are already on `http_proxy.rs` allowlist via the
 * existing BTC/DOGE entries — no Rust change required.
 *
 * Crypto path: legacy P2PKH only (no segwit on Dogecoin chain). PSBT
 * inputs use `nonWitnessUtxo` (full prev-tx hex), signed with standard
 * `SIGHASH_ALL (0x01)` — bitcoinjs-lib v7 produces this natively. No
 * special sighash like BCH.
 *
 * Fee policy (Dogecoin Core 1.14.6 `doc/fee-recommendation.md`):
 *   - Min relay  : 0.001 DOGE/kB (consensus floor)
 *   - Recommended: 0.01  DOGE/kB (10× the relay floor)
 *   - Hard dust  : 0.001 DOGE per output
 *   - Soft dust  : 0.01  DOGE per output (below this requires +0.01
 *     DOGE per output added to the fee)
 * We default to 0.01 DOGE/kB and never go below it, matching
 * what every modern DOGE wallet ships in 2026.
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
// Network parameters (Dogecoin Core `chainparams.cpp`)
// =========================================================================
//
// Dogecoin never activated segwit — `bech32` is intentionally a placeholder
// string that will never match a real address. Any future call to
// `bitcoin.payments.p2wpkh({ network: dogeNetwork })` would mint addresses
// no Dogecoin node accepts.
const dogeNetwork: bitcoin.Network = {
  messagePrefix: "\x19Dogecoin Signed Message:\n",
  bech32: "doge",
  bip32: { public: 0x02facafd, private: 0x02fac398 },
  pubKeyHash: 0x1e, // "D..." legacy P2PKH
  scriptHash: 0x16, // "9..." or "A..." P2SH
  wif: 0x9e,
};

const BLOCKCYPHER_BASE = "https://api.blockcypher.com/v1/doge/main";
const BLOCKCHAIR_BASE = "https://api.blockchair.com/dogecoin";
const DOGECHAIN_BASE = "https://dogechain.info/api/v1";
// Bitpay Bitcore — keyless public node API. Unlike dogechain.info and the Trezor
// BlockBook instances (both behind Cloudflare, which 403s programmatic clients
// regardless of User-Agent), Bitcore has no bot gate, and unlike BlockCypher
// (~100 req/hr) it isn't hour-capped. It's the reliable primary balance source;
// the other three stay as fallbacks. Verified live 2026-06-17 (HTTP 200, returns
// {confirmed,unconfirmed,balance} in satoshis).
const BITCORE_DOGE_BALANCE = (addr: string) =>
  `https://api.bitcore.io/api/DOGE/mainnet/address/${addr}/balance`;
const DERIVATION_PATH = "m/44'/3'/0'/0/0";

// Standard 1-in 2-out P2PKH tx is ~226 bytes. We use 226 in fee math
// throughout; oversized inputs (e.g. multi-input consolidations) round
// up via the input count adder in `estimateTxBytes`.
const STANDARD_TX_BYTES = 226;
const MIN_RECOMMENDED_RATE_PER_KB = 0.01; // DOGE/kB — see file header

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
    network: dogeNetwork,
  });
  return address!;
}

/**
 * Try a sequence of async sources in declared order; return the first
 * value that resolves successfully. Throws on full exhaustion with the
 * last underlying error preserved. Used by every multi-source fetch in
 * this adapter so a single endpoint outage doesn't surface to the user.
 */
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
    `All ${tried.length} DOGE source(s) failed [${tried.join(", ")}]: ${tail}`
  );
}

function estimateTxBytes(inputCount: number, outputCount = 2): number {
  // Empirically: 10 bytes overhead + 148 bytes/legacy P2PKH input + 34 bytes/P2PKH output.
  // Matches Bitcoin Core's `GetVirtualTransactionSize` for legacy 1-of-1 inputs.
  return 10 + 148 * inputCount + 34 * outputCount;
}

// =========================================================================
// Normalized UTXO + prev-tx shapes (one per source)
// =========================================================================

interface NormalizedUtxo {
  txid: string;
  vout: number;
  /** Satoshi value (1 DOGE = 1e8). */
  value: bigint;
}

// -------------------------------------------------------------------------
// Balance — multi-source
// -------------------------------------------------------------------------

async function fetchBalanceBitcore(addr: string): Promise<string> {
  // Bitcore returns confirmed/unconfirmed/balance in satoshis (numbers);
  // `balance` already equals confirmed + unconfirmed.
  const r = await proxyGetJson<{
    confirmed?: number;
    unconfirmed?: number;
    balance?: number;
  }>(BITCORE_DOGE_BALANCE(addr));
  const sat = (r.confirmed ?? 0) + (r.unconfirmed ?? 0);
  return (sat / 1e8).toFixed(8);
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

async function fetchBalanceDogechain(addr: string): Promise<string> {
  const r = await proxyGetJson<{ success: number; balance: string }>(
    `${DOGECHAIN_BASE}/address/balance/${addr}`
  );
  if (r.success !== 1) throw new Error("dogechain.info balance: success!=1");
  return parseFloat(r.balance).toFixed(8);
}

// -------------------------------------------------------------------------
// UTXO listing — multi-source, normalized
// -------------------------------------------------------------------------

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

async function fetchUtxosDogechain(addr: string): Promise<NormalizedUtxo[]> {
  // dogechain.info's `unspent_outputs` returns value as a satoshi number.
  const r = await proxyGetJson<{
    success: number;
    unspent_outputs?: Array<{ tx_hash: string; tx_output_n: number; value: string }>;
  }>(`${DOGECHAIN_BASE}/unspent/${addr}`);
  if (r.success !== 1) throw new Error("dogechain.info unspent: success!=1");
  return (r.unspent_outputs ?? []).map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_output_n,
    value: BigInt(u.value),
  }));
}

// -------------------------------------------------------------------------
// Prev-tx hex resolution — needed for nonWitnessUtxo (legacy P2PKH)
// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------
// Broadcast — multi-source
// -------------------------------------------------------------------------

async function broadcastBlockcypher(rawHex: string): Promise<string> {
  const r = await proxyPostJson<{
    tx?: { hash?: string };
    error?: string;
  }>(`${BLOCKCYPHER_BASE}/txs/push`, { tx: rawHex });
  if (r.error) throw new Error(`blockcypher push: ${r.error}`);
  if (!r.tx?.hash) throw new Error("blockcypher push: no hash");
  return r.tx.hash;
}

async function broadcastBlockchair(rawHex: string): Promise<string> {
  // Blockchair's broadcast endpoint expects form-urlencoded `data=<hex>`.
  // Going through `httpProxyCall` directly because `proxyPostJson` always
  // sets JSON content-type, which blockchair rejects with HTTP 400.
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

async function broadcastDogechain(rawHex: string): Promise<string> {
  const r = await proxyPostJson<{ success?: number; tx_hash?: string; error?: string }>(
    `${DOGECHAIN_BASE}/pushtx`,
    { tx: rawHex }
  );
  if (r.error) throw new Error(`dogechain push: ${r.error}`);
  if (!r.tx_hash) throw new Error("dogechain push: no tx_hash");
  return r.tx_hash;
}

// -------------------------------------------------------------------------
// Fee oracle — multi-source. Returns DOGE/kB.
// -------------------------------------------------------------------------

async function fetchFeeRateBlockcypher(): Promise<number> {
  const r = await proxyGetJson<{
    high_fee_per_kb?: number;
    medium_fee_per_kb?: number;
    low_fee_per_kb?: number;
  }>(BLOCKCYPHER_BASE);
  // BlockCypher returns satoshi/kB; convert to DOGE/kB.
  const med = r.medium_fee_per_kb;
  if (!med || med <= 0) throw new Error("blockcypher fee: invalid");
  return med / 1e8;
}

async function fetchFeeRateBlockchair(): Promise<number> {
  const r = await proxyGetJson<{
    data: { suggested_transaction_fee_per_byte_sat?: number };
  }>(`${BLOCKCHAIR_BASE}/stats`);
  const perByte = r.data?.suggested_transaction_fee_per_byte_sat;
  if (!perByte || perByte <= 0) throw new Error("blockchair fee: invalid");
  return (perByte * 1000) / 1e8; // sat/B → DOGE/kB
}

// =========================================================================
// Adapter
// =========================================================================

/** Balance + history-existence for one DOGE address. Throws when no source
 *  answered — never coerces an outage into a zero. */
async function probeDogeAddress(address: string): Promise<UtxoProbeResult> {
  return tryEach<UtxoProbeResult>([
    { name: "blockchair", fn: () => blockchairProbe(BLOCKCHAIR_BASE, address) },
    { name: "blockcypher", fn: () => blockcypherProbe(BLOCKCYPHER_BASE, address) },
  ]);
}

/**
 * Dogecoin's single BIP-44 account. DOGE is not a C8-shared coin today, so its
 * change chain is only reachable via this app's own sends — which currently
 * reuse the sender address. Listed anyway: the account is the truth, the
 * single address is an assumption, and the assumption is what broke on LTC.
 */
export const dogeUtxoAccounts: UtxoAccountSpec[] = [
  {
    chain: "dogecoin",
    accountPath: "m/44'/3'/0'",
    label: "BIP-44 legacy",
    deriveAddress: (node) => getAddress(node.publicKey!),
    probe: probeDogeAddress,
  },
];

/**
 * Dogecoin Core 1.14.6's soft dust threshold: outputs below 0.01 DOGE carry an
 * extra 0.01 DOGE fee penalty, so a change output smaller than this costs more
 * than it is worth. Three orders of magnitude above BTC/LTC's 546 — which is
 * exactly why `planAccountSpend` takes `dustSat` rather than defaulting.
 */
export const DOGE_DUST_SAT = 1_000_000;

/**
 * Spend from the whole DOGE account.
 *
 * See `sendLtcFromAccount` in `ltc-wallet.ts` for the rationale and the survey
 * of how other wallets do this; the scan/derive/select half is shared
 * (`gatherAccountSpend`). What is Dogecoin-specific here:
 *
 *   - **Legacy P2PKH sizing** (10 / 148 / 34 vB) — `P2PKH_SIZING` matches this
 *     file's own `estimateTxBytes` exactly. Budgeting a DOGE send with SegWit
 *     constants would underpay by ~80 vB per input.
 *   - **`nonWitnessUtxo`**, which means fetching the FULL previous transaction
 *     for every input. bitcoinjs-lib v7 requires it for legacy spends. This is
 *     the real cost of account-wide sending on a pre-SegWit chain: one extra
 *     round-trip per distinct funding transaction, deduped by txid below.
 *   - **The 0.01 DOGE dust floor** above.
 *
 * DOGE is not currently reachable by BasicSwap's account-key sharing (only BTC
 * and LTC are `ELECTRUM_CAPABLE`), but it IS one of the five coins C3.5
 * descriptor adoption covers, and an imported seed can arrive already
 * scattered. The account is the truth; the single address is an assumption.
 */
export async function sendDogeFromAccount(
  mnemonic: string,
  to: string,
  amount: string,
  opts?: { feeRateOverride?: number; gapLimit?: number; fromAddress?: string },
): Promise<TxResult> {
  const spec = dogeUtxoAccounts[0];
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const account = HDKey.fromMasterSeed(seed).derive(spec.accountPath);
  const primaryAddress = spec.deriveAddress(account.deriveChild(0).deriveChild(0));
  if (opts?.fromAddress && opts.fromAddress !== primaryAddress) {
    throw new Error(
      `${opts.fromAddress} is not this seed's index-0 DOGE address ` +
        `(${primaryAddress}). Nothing was sent.`,
    );
  }

  const sendSat = Math.round(parseFloat(amount) * 1e8);
  if (!Number.isFinite(sendSat) || sendSat <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  // Oracles quote DOGE/kB; the planner wants sat/vB. Never below the network's
  // recommended floor — DOGE's relay minimum is high and a cheaper tx simply
  // does not propagate.
  let perKb = MIN_RECOMMENDED_RATE_PER_KB;
  if (opts?.feeRateOverride === undefined) {
    try {
      const oracle = await tryEach<number>([
        { name: "blockcypher", fn: fetchFeeRateBlockcypher },
        { name: "blockchair", fn: fetchFeeRateBlockchair },
      ]);
      if (oracle > perKb) perKb = oracle;
    } catch {
      /* keep the floor */
    }
  }
  const feePerVB =
    opts?.feeRateOverride ?? Math.max(Math.ceil((perKb * 1e8) / 1000), 1);

  // Change goes to the internal chain's lowest unused index (2026-09-04) —
  // the BIP-44 rule every surveyed wallet and the swap engine follow — not
  // back to the displayed address. See `nextChangeIndex` in utxo-account.ts.
  const { plan, sources, change } = await gatherAccountSpend({
    mnemonic,
    spec,
    sendSat,
    feePerVB,
    sizing: P2PKH_SIZING,
    dustSat: DOGE_DUST_SAT,
    gapLimit: opts?.gapLimit,
    fetchUtxos: async (address) => {
      const utxos = await tryEach<NormalizedUtxo[]>([
        { name: "blockcypher", fn: () => fetchUtxosBlockcypher(address) },
        { name: "blockchair", fn: () => fetchUtxosBlockchair(address) },
        { name: "dogechain", fn: () => fetchUtxosDogechain(address) },
      ]);
      // This file works in bigint; the shared planner works in number.
      // Check the BIGINT before narrowing — checking after the conversion
      // would inspect a value that has already lost precision, which is a
      // check that cannot fail for the reason it is run.
      return utxos.map((u) => {
        if (u.value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(
            `Output ${u.txid}:${u.vout} exceeds 2^53 base units and cannot ` +
              "be selected safely. Nothing was sent.",
          );
        }
        return { txid: u.txid, vout: u.vout, valueSat: Number(u.value) };
      });
    },
  });

  if (!plan.covered) {
    const held = plan.inputs.reduce((t, i) => t + i.valueSat, 0);
    throw new Error(accountShortfallMessage(plan, held, plan.inputs.length, "DOGE"));
  }

  // Legacy inputs need the whole previous transaction. Deduped by txid: two
  // outputs of one funding tx cost one fetch, not two.
  const prevTx = new Map<string, string>();
  for (const input of plan.inputs) {
    if (prevTx.has(input.txid)) continue;
    prevTx.set(
      input.txid,
      await tryEach<string>([
        { name: "blockcypher", fn: () => fetchPrevTxHexBlockcypher(input.txid) },
        { name: "blockchair", fn: () => fetchPrevTxHexBlockchair(input.txid) },
      ]),
    );
  }

  const psbt = new bitcoin.Psbt({ network: dogeNetwork });
  const keyPairs = new Map<string, ReturnType<typeof ECPair.fromPrivateKey>>();
  for (const input of plan.inputs) {
    if (!keyPairs.has(input.address)) {
      const src = sources.get(input.address);
      if (!src) throw new Error(`No signer for ${input.address}; nothing was sent.`);
      keyPairs.set(
        input.address,
        ECPair.fromPrivateKey(Buffer.from(src.node.privateKey!), {
          network: dogeNetwork,
        }),
      );
    }
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      nonWitnessUtxo: Buffer.from(prevTx.get(input.txid)!, "hex"),
    });
  }
  psbt.addOutput({ address: to, value: BigInt(sendSat) });
  if (plan.changeSat > 0) {
    psbt.addOutput({ address: change.address, value: BigInt(plan.changeSat) });
  }
  plan.inputs.forEach((input, i) => psbt.signInput(i, keyPairs.get(input.address)!));
  psbt.finalizeAllInputs();
  const rawHex = psbt.extractTransaction().toHex();

  const hash = await tryEach<string>([
    { name: "blockcypher", fn: () => broadcastBlockcypher(rawHex) },
    { name: "blockchair", fn: () => broadcastBlockchair(rawHex) },
    { name: "dogechain", fn: () => broadcastDogechain(rawHex) },
  ]);
  return { hash };
}

export const dogeAdapter: ChainAdapter = {
  /** DOGE has one account; account-wide send serves any wallet on it. */
  supportsAccountSend(mnemonic: string, address: string) {
    const spec = dogeUtxoAccounts[0];
    const seed = mnemonicToSeedSync(mnemonic.trim(), "");
    const node = HDKey.fromMasterSeed(seed)
      .derive(spec.accountPath)
      .deriveChild(0)
      .deriveChild(0);
    return spec.deriveAddress(node) === address;
  },

  /** Account-wide send — see . */
  sendFromAccount(mnemonic: string, to: string, amount: string, fromAddress?: string) {
    return sendDogeFromAccount(mnemonic, to, amount, { fromAddress });
  },
  utxoAccounts: dogeUtxoAccounts,
  chain: "dogecoin",
  displayName: "Dogecoin",
  ticker: "DOGE",
  color: "#c2a633",
  addressPlaceholder: "D...",
  derivation: {
    kind: "bip39",
    path: "m/44'/3'/0'/0/0",
    standard: "BIP-44 coin type 3 — Dogecoin Core, Exodus",
    hasAlternatives: true,
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const privKeyBytes = hexToBytes(privateKey);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes), {
      network: dogeNetwork,
    });
    const address = getAddress(keyPair.publicKey);
    return {
      chain: "dogecoin",
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
      chain: "dogecoin",
      address,
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(child.privateKey!),
    };
  },

  async getBalance(address: string): Promise<string> {
    return tryEach([
      // Bitcore first — keyless, no Cloudflare gate, and not hour-capped like
      // the other three (BlockCypher 429 + Blockchair 430 + dogechain 403 all
      // failed simultaneously, which blanked DOGE — 2026-06-17).
      { name: "bitcore", fn: () => fetchBalanceBitcore(address) },
      { name: "blockcypher", fn: () => fetchBalanceBlockcypher(address) },
      { name: "blockchair", fn: () => fetchBalanceBlockchair(address) },
      { name: "dogechain", fn: () => fetchBalanceDogechain(address) },
    ]);
  },

  /**
   * Build, sign, and broadcast a 1-of-N → 2-out P2PKH transfer.
   *
   * Each of the four network steps (UTXO listing, prev-tx hex resolution,
   * fee oracle, broadcast) rotates across multiple endpoints — see the
   * source-specific helpers above. Construction itself is offline:
   * `bitcoinjs-lib` v7's PSBT path produces standard `SIGHASH_ALL`
   * signatures which Dogecoin Core accepts directly (no FORKID variant
   * like BCH).
   */
  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    const privKeyBytes = hexToBytes(privateKey);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes), {
      network: dogeNetwork,
    });
    const senderAddress = getAddress(keyPair.publicKey);

    // 1) UTXOs (multi-source).
    const utxos = await tryEach([
      { name: "blockcypher", fn: () => fetchUtxosBlockcypher(senderAddress) },
      { name: "blockchair", fn: () => fetchUtxosBlockchair(senderAddress) },
      { name: "dogechain", fn: () => fetchUtxosDogechain(senderAddress) },
    ]);
    if (utxos.length === 0) {
      throw new Error("No spendable UTXOs available for this address.");
    }

    // 2) Fee rate. Floor at the recommended 0.01 DOGE/kB so we never
    //    fall below modern wallet defaults even if every oracle is down.
    let perKbRate = MIN_RECOMMENDED_RATE_PER_KB;
    try {
      const oracle = await tryEach([
        { name: "blockcypher", fn: () => fetchFeeRateBlockcypher() },
        { name: "blockchair", fn: () => fetchFeeRateBlockchair() },
      ]);
      if (oracle > perKbRate) perKbRate = oracle;
    } catch {
      /* keep MIN_RECOMMENDED_RATE_PER_KB */
    }

    // 3) Greedy input selection (largest-first). Re-estimate fee with the
    //    actual selected input count once we've picked.
    const sendSat = BigInt(Math.round(parseFloat(amount) * 1e8));
    if (sendSat <= 0n) throw new Error("Amount must be greater than zero.");

    const sortedUtxos = [...utxos].sort((a, b) =>
      a.value < b.value ? 1 : a.value > b.value ? -1 : 0
    );
    const selected: NormalizedUtxo[] = [];
    let total = 0n;
    let feeSat = BigInt(
      Math.ceil((perKbRate * 1e8 * estimateTxBytes(1)) / 1000)
    );
    for (const u of sortedUtxos) {
      selected.push(u);
      total += u.value;
      const sizeBytes = estimateTxBytes(selected.length);
      feeSat = BigInt(Math.ceil((perKbRate * 1e8 * sizeBytes) / 1000));
      if (total >= sendSat + feeSat) break;
    }
    if (total < sendSat + feeSat) {
      throw new Error(
        `Insufficient funds. Have ${(Number(total) / 1e8).toFixed(8)} DOGE, ` +
          `need ${(Number(sendSat + feeSat) / 1e8).toFixed(8)} DOGE ` +
          `(incl. ~${(Number(feeSat) / 1e8).toFixed(8)} fee).`
      );
    }

    // 4) Resolve prev-tx hex for each selected input. nonWitnessUtxo is
    //    mandatory for legacy P2PKH spends in bitcoinjs-lib v7.
    const prevTxCache = new Map<string, string>();
    for (const u of selected) {
      if (prevTxCache.has(u.txid)) continue;
      const hex = await tryEach([
        { name: "blockcypher", fn: () => fetchPrevTxHexBlockcypher(u.txid) },
        { name: "blockchair", fn: () => fetchPrevTxHexBlockchair(u.txid) },
      ]);
      prevTxCache.set(u.txid, hex);
    }

    // 5) Build PSBT.
    const psbt = new bitcoin.Psbt({ network: dogeNetwork });
    for (const u of selected) {
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        nonWitnessUtxo: Buffer.from(prevTxCache.get(u.txid)!, "hex"),
      });
    }
    psbt.addOutput({ address: to, value: sendSat });
    const change = total - sendSat - feeSat;
    // Soft dust threshold per Dogecoin Core 1.14.6 fee policy:
    // outputs below 0.01 DOGE (1_000_000 satoshi) are discouraged
    // (extra +0.01 DOGE fee penalty). If our change is smaller than
    // that, fold it into the fee rather than emitting a costly output.
    const SOFT_DUST_SAT = 1_000_000n;
    if (change >= SOFT_DUST_SAT) {
      psbt.addOutput({ address: senderAddress, value: change });
    }

    // 6) Sign + finalize. Standard SIGHASH_ALL; bitcoinjs-lib defaults to
    //    this and Dogecoin Core accepts it without modification.
    for (let i = 0; i < psbt.inputCount; i++) {
      psbt.signInput(i, keyPair as any);
    }
    psbt.finalizeAllInputs();
    const rawHex = psbt.extractTransaction().toHex();

    // 7) Broadcast (multi-source).
    return {
      hash: await tryEach([
        { name: "blockcypher", fn: () => broadcastBlockcypher(rawHex) },
        { name: "blockchair", fn: () => broadcastBlockchair(rawHex) },
        { name: "dogechain", fn: () => broadcastDogechain(rawHex) },
      ]),
    };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const r = await tryEach([
        {
          name: "blockchair",
          fn: () =>
            proxyGetJson<{ data: { blocks: number } }>(
              `${BLOCKCHAIR_BASE}/stats`
            ).then((d) => d.data.blocks),
        },
        {
          name: "blockcypher",
          fn: () =>
            proxyGetJson<{ height?: number }>(BLOCKCYPHER_BASE).then(
              (d) => d.height ?? 0
            ),
        },
      ]);
      return {
        label: "Block",
        value: r ? r.toLocaleString() : "Mainnet",
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
    const offset = opts?.cursor ? Number(opts.cursor) : 0;

    // Blockchair's `dashboards/address` is the richest one-shot source for
    // a doge address (sorted txid list, pagination via offset). Tx detail
    // is then resolved in batches of 10. dogechain.info's history shape is
    // less consistent — kept as a soft fallback only for the listing step,
    // not for tx detail.
    const data = await proxyGetJson<{
      data: Record<
        string,
        {
          address: { received: number; spent: number };
          transactions: string[];
        }
      >;
    }>(
      `${BLOCKCHAIR_BASE}/dashboards/address/${address}?limit=${limit}&offset=${offset}`
    );
    const entry = data.data?.[address];
    const txids: string[] = (entry?.transactions ?? []).slice(0, limit);
    if (txids.length === 0) return { items: [] };

    const items: ChainTx[] = [];
    for (let i = 0; i < txids.length; i += 10) {
      const batch = txids.slice(i, i + 10);
      try {
        const detail = await proxyGetJson<{
          data: Record<
            string,
            {
              transaction: { hash: string; time: string; block_id: number; fee: number };
              inputs: { recipient: string; value: number }[];
              outputs: { recipient: string; value: number }[];
            }
          >;
        }>(`${BLOCKCHAIR_BASE}/dashboards/transactions/${batch.join(",")}`);
        for (const txid of batch) {
          const d = detail.data?.[txid];
          if (!d) continue;
          let outFromMe = 0;
          for (const inp of d.inputs ?? []) {
            if (inp.recipient === address) outFromMe += inp.value || 0;
          }
          let inToMe = 0;
          let firstExternalOut: string | undefined;
          for (const out of d.outputs ?? []) {
            if (out.recipient === address) inToMe += out.value || 0;
            else if (!firstExternalOut) firstExternalOut = out.recipient;
          }
          const net = inToMe - outFromMe;
          const direction: ChainTx["direction"] =
            net > 0 ? "in" : net < 0 ? "out" : "self";
          items.push({
            chain: "dogecoin",
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
            counterparty: direction === "out" ? firstExternalOut : undefined,
            meta: {},
          });
        }
      } catch {
        /* skip the batch on failure; partial history is still useful */
      }
    }

    const cursor = txids.length === limit ? String(offset + limit) : undefined;
    return { items, cursor };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // Returns a single `normal` tier in DOGE per standard 226-byte tx, so
    // the existing FeeEstimate UI can render "<N> DOGE" without per-tier
    // confusion. DOGE has no real fee market in 2026 — slow/normal/fast
    // tiers would all collapse to the same value, so we don't bother.
    let perKb = MIN_RECOMMENDED_RATE_PER_KB;
    let raw: unknown = { source: "static", perKb };
    try {
      const oracle = await tryEach([
        { name: "blockcypher", fn: () => fetchFeeRateBlockcypher() },
        { name: "blockchair", fn: () => fetchFeeRateBlockchair() },
      ]);
      if (oracle > perKb) {
        perKb = oracle;
        raw = { source: "oracle", perKb };
      }
    } catch {
      /* keep MIN_RECOMMENDED_RATE_PER_KB */
    }
    const fee = (perKb * STANDARD_TX_BYTES) / 1000;
    return {
      normal: { value: fee.toFixed(8) },
      unit: "DOGE",
      fetchedAt: Date.now(),
      raw,
    };
  },
};
