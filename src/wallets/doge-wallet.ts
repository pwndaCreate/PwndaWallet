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
  assertFeeWithinCap,
  assertNotDust,
  broadcastSignedTx,
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
// Network parameters (Dogecoin Core `chainparams.cpp`)
// =========================================================================
//
// Dogecoin never activated segwit, so `bech32` must match NO address.
//
// CORRECTED 2026-09-29 (send-safety audit): the comment here claimed "doge"
// was "a placeholder string that will never match a real address". It matched
// any checksum-valid `doge1…` string, which bitcoinjs-lib turned into a P2WPKH
// output — a script Dogecoin nodes treat as anyone-can-spend. See
// `NO_SEGWIT_BECH32`; `recipientOutput` also refuses every non-P2PKH/P2SH
// template on this chain.
const dogeNetwork: bitcoin.Network = {
  messagePrefix: "\x19Dogecoin Signed Message:\n",
  bech32: NO_SEGWIT_BECH32,
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

// Standard 1-in 2-out P2PKH tx is ~226 bytes — the size the modal's
// estimate is quoted for. Sends are priced for what they actually build.
const STANDARD_TX_BYTES = 226;

/**
 * The fee band, in satoshi per kB (1 DOGE = 1e8 sat).
 *
 * Floor: Dogecoin Core 1.14.6's recommended 0.01 DOGE/kB — see file header.
 *
 * Ceiling: 0.04 DOGE/kB, four times the recommended rate (2026-09-29
 * send-safety audit). The oracles had no upper bound, and on 2026-09-29 they
 * read 0.58 DOGE/kB (BlockCypher `medium_fee_per_kb` 58,349,538) and 5 DOGE/kB
 * (Blockchair 500,000 sat/B) — 58× and 500× the recommendation. Both are past
 * bitcoinjs-lib's 5,000 sat/B guard, so EVERY DOGE send threw
 * "Warning: You are paying around …"; without that guard they would have paid
 * those rates. Our reading (inference, not measured): the oracles average what
 * transactions pay, and a large share of DOGE traffic still pays the pre-1.14.4
 * default of 1 DOGE/kB. 0.04 leaves room for a genuine uptick at under a cent
 * per send, and stays below the 0.05 DOGE/kB that guard enforces.
 */
export const DOGE_MIN_SAT_PER_KB = 1_000_000;
export const DOGE_MAX_SAT_PER_KB = 4_000_000;

/**
 * Hard sanity cap for a signed DOGE transaction, per vbyte, checked before
 * broadcast (`assertFeeWithinCap`) — bitcoinjs-lib's own default. It replaces
 * that library's generic check, which also counted change folded into the fee
 * and refused a send with 0.009 DOGE of sub-dust change at the FLOOR rate.
 */
const DOGE_FEE_CAP_SAT_PER_VB = 5_000;

/** Clamp any rate reading (sat/kB) into the band; non-numbers fall to the floor. */
export function clampDogeSatPerKb(satPerKb: number | null | undefined): number {
  if (typeof satPerKb !== "number" || !Number.isFinite(satPerKb) || satPerKb <= 0) {
    return DOGE_MIN_SAT_PER_KB;
  }
  return Math.min(Math.max(Math.ceil(satPerKb), DOGE_MIN_SAT_PER_KB), DOGE_MAX_SAT_PER_KB);
}

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
 * Try READ sources in declared order; the first answer wins. On full
 * exhaustion the error names every source with what it said (`trySources`).
 * Never used for broadcasting — see `broadcastDoge`.
 */
function tryEach<T>(sources: Array<{ name: string; fn: () => Promise<T> }>): Promise<T> {
  return trySources<T>("DOGE", sources);
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
// Broadcast — the same signed bytes to each endpoint; the outcome decided by
// `broadcastSignedTx` (utxo-send.ts). DOGE has two live broadcast endpoints
// (dogechain.info is behind a Cloudflare challenge), which made the 2026-09-29
// audit's lost-reply double payment easy to hit here.
// -------------------------------------------------------------------------

const DOGE_BROADCAST: BroadcastEndpoint[] = [
  proxyPushEndpoint(
    "blockcypher",
    (hex) => ({
      url: `${BLOCKCYPHER_BASE}/txs/push`,
      body: JSON.stringify({ tx: hex }),
      contentType: "application/json",
    }),
    (body) => JSON.parse(body)?.tx?.hash,
  ),
  // Blockchair's broadcast endpoint expects form-urlencoded `data=<hex>`; a
  // JSON content-type is rejected with HTTP 400.
  proxyPushEndpoint(
    "blockchair",
    (hex) => ({
      url: `${BLOCKCHAIR_BASE}/push/transaction`,
      body: `data=${encodeURIComponent(hex)}`,
      contentType: "application/x-www-form-urlencoded",
    }),
    (body) => JSON.parse(body)?.data?.transaction_hash,
  ),
  proxyPushEndpoint(
    "dogechain",
    (hex) => ({
      url: `${DOGECHAIN_BASE}/pushtx`,
      body: JSON.stringify({ tx: hex }),
      contentType: "application/json",
    }),
    (body) => {
      const j = JSON.parse(body);
      return j?.success === 1 ? j.tx_hash : undefined;
    },
  ),
];

const DOGE_LOOKUPS: TxLookup[] = [
  proxyTxLookup("blockcypher", (t) => `${BLOCKCYPHER_BASE}/txs/${t}`, (j) => j?.hash),
  proxyTxLookup(
    "blockchair",
    (t) => `${BLOCKCHAIR_BASE}/dashboards/transaction/${t}`,
    (j, t) => j?.data?.[t]?.transaction?.hash,
  ),
];

/**
 * Check the fee, then broadcast. Extracted with bitcoinjs-lib's generic fee
 * check OFF: it counts change folded into the fee as fee rate, so a send
 * leaving up to 0.01 DOGE of sub-dust change tripped its 5,000 sat/B limit even
 * at the floor rate. `assertFeeWithinCap` applies the same limit with that
 * change allowed for.
 */
function broadcastDoge(psbt: bitcoin.Psbt, inputTotalSat: number): Promise<TxResult> {
  const tx = psbt.extractTransaction(true);
  const outTotal = tx.outs.reduce((t, o) => t + Number(o.value), 0);
  assertFeeWithinCap({
    ticker: "DOGE",
    feeSat: inputTotalSat - outTotal,
    vbytes: tx.virtualSize(),
    maxSatPerVByte: DOGE_FEE_CAP_SAT_PER_VB,
    foldAllowanceSat: DOGE_DUST_SAT,
  });
  return broadcastSignedTx({
    ticker: "DOGE",
    txid: tx.getId(),
    rawHex: tx.toHex(),
    endpoints: DOGE_BROADCAST,
    lookups: DOGE_LOOKUPS,
  });
}

/** Decode a DOGE recipient: P2PKH (D…) or P2SH (9…/A…) only. */
function dogeRecipient(to: string) {
  return recipientOutput(to, {
    network: dogeNetwork,
    ticker: "DOGE",
    uriSchemes: ["dogecoin"],
    allowed: LEGACY_CHAIN_OUTPUTS,
  });
}

// -------------------------------------------------------------------------
// Fee oracle — multi-source. Returns sat/kB; always clamped to the band.
// -------------------------------------------------------------------------

async function fetchFeeRateBlockcypher(): Promise<number> {
  const r = await proxyGetJson<{
    high_fee_per_kb?: number;
    medium_fee_per_kb?: number;
    low_fee_per_kb?: number;
  }>(BLOCKCYPHER_BASE);
  // BlockCypher quotes satoshi per kB.
  const med = r.medium_fee_per_kb;
  if (!med || med <= 0) throw new Error("blockcypher fee: invalid");
  return med;
}

async function fetchFeeRateBlockchair(): Promise<number> {
  const r = await proxyGetJson<{
    data: { suggested_transaction_fee_per_byte_sat?: number };
  }>(`${BLOCKCHAIR_BASE}/stats`);
  const perByte = r.data?.suggested_transaction_fee_per_byte_sat;
  if (!perByte || perByte <= 0) throw new Error("blockchair fee: invalid");
  return perByte * 1000; // sat/B → sat/kB
}

/**
 * The rate every DOGE fee decision uses — both send paths and the modal's
 * estimate, so what is shown is what is paid: the oracle's reading clamped to
 * [DOGE_MIN_SAT_PER_KB, DOGE_MAX_SAT_PER_KB], or the floor when both oracles
 * are down.
 */
async function dogeSatPerKb(): Promise<{ satPerKb: number; oracle: number | null }> {
  let oracle: number | null = null;
  try {
    oracle = await tryEach<number>([
      { name: "blockcypher", fn: fetchFeeRateBlockcypher },
      { name: "blockchair", fn: fetchFeeRateBlockchair },
    ]);
  } catch {
    /* keep the floor */
  }
  return { satPerKb: clampDogeSatPerKb(oracle), oracle };
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
 *   - **Legacy P2PKH sizing** (10 / 148 / 34 vB) — `P2PKH_SIZING`, which the
 *     single-key `sendTransaction` now shares too (its own `estimateTxBytes`
 *     copy was retired 2026-09-29). Budgeting a DOGE send with SegWit
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

  // Amount and recipient are settled before anything touches the network
  // (2026-09-29 send-safety audit). Below Dogecoin's 0.01 DOGE soft-dust line
  // an output needs an extra 0.01 DOGE of fee, which this wallet does not add.
  const sendSat = parseSendAmountSat(amount, "DOGE");
  const recipient = dogeRecipient(to);
  assertNotDust(sendSat, DOGE_DUST_SAT, "DOGE");

  // Always inside the band, whatever the source — an override included; the
  // Send modal never passes one for DOGE (its estimate is a total).
  const satPerKb =
    opts?.feeRateOverride !== undefined
      ? clampDogeSatPerKb(opts.feeRateOverride * 1000)
      : (await dogeSatPerKb()).satPerKb;
  const feePerVB = Math.ceil(satPerKb / 1000);

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
    recipientOutputVB: outputVBytes(recipient.script.length),
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
  psbt.addOutput({ script: recipient.script, value: BigInt(sendSat) });
  if (plan.changeSat > 0) {
    psbt.addOutput({ address: change.address, value: BigInt(plan.changeSat) });
  }
  plan.inputs.forEach((input, i) => psbt.signInput(i, keyPairs.get(input.address)!));
  psbt.finalizeAllInputs();

  // Signed once; from here on only these bytes are ever sent.
  return broadcastDoge(psbt, plan.inputs.reduce((t, i) => t + i.valueSat, 0));
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
  // No `opts.feeRate` forwarding: DOGE's estimate is a TOTAL ("0.226 DOGE"),
  // not a rate, so the modal never produces one for it (`feeRateForSend`).
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
    // 0) Settled before any request (2026-09-29 send-safety audit).
    const sendSat = parseSendAmountSat(amount, "DOGE");
    const recipient = dogeRecipient(to);
    assertNotDust(sendSat, DOGE_DUST_SAT, "DOGE");

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

    // 2) Fee rate, clamped to the band (see DOGE_MAX_SAT_PER_KB).
    const { satPerKb } = await dogeSatPerKb();

    // 3) Largest-first selection with the shared planner — the same pricing
    //    and 0.01 DOGE soft-dust fold as the account-wide path.
    const candidates: AccountSpendCandidate[] = utxos.map((u) => {
      if (u.value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(
          `Output ${u.txid}:${u.vout} exceeds 2^53 base units and cannot be ` +
            "selected safely. Nothing was sent.",
        );
      }
      return { path: DERIVATION_PATH, address: senderAddress, txid: u.txid, vout: u.vout, valueSat: Number(u.value) };
    });
    const plan = planAccountSpend({
      candidates,
      sendSat,
      feePerVB: Math.ceil(satPerKb / 1000),
      sizing: P2PKH_SIZING,
      dustSat: DOGE_DUST_SAT,
      recipientOutputVB: outputVBytes(recipient.script.length),
    });
    if (!plan.covered) {
      const have = candidates.reduce((t, c) => t + c.valueSat, 0);
      throw new Error(
        `Insufficient funds. Have ${(have / 1e8).toFixed(8)} DOGE, ` +
          `need ${((have + plan.shortfallSat) / 1e8).toFixed(8)} DOGE ` +
          `(incl. ~${(plan.feeSat / 1e8).toFixed(8)} fee).`
      );
    }

    // 4) Resolve prev-tx hex for each selected input. nonWitnessUtxo is
    //    mandatory for legacy P2PKH spends in bitcoinjs-lib v7.
    const prevTxCache = new Map<string, string>();
    for (const u of plan.inputs) {
      if (prevTxCache.has(u.txid)) continue;
      const hex = await tryEach([
        { name: "blockcypher", fn: () => fetchPrevTxHexBlockcypher(u.txid) },
        { name: "blockchair", fn: () => fetchPrevTxHexBlockchair(u.txid) },
      ]);
      prevTxCache.set(u.txid, hex);
    }

    // 5) Build PSBT.
    const psbt = new bitcoin.Psbt({ network: dogeNetwork });
    for (const u of plan.inputs) {
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        nonWitnessUtxo: Buffer.from(prevTxCache.get(u.txid)!, "hex"),
      });
    }
    psbt.addOutput({ script: recipient.script, value: BigInt(sendSat) });
    if (plan.changeSat > 0) {
      psbt.addOutput({ address: senderAddress, value: BigInt(plan.changeSat) });
    }

    // 6) Sign + finalize. Standard SIGHASH_ALL; bitcoinjs-lib defaults to
    //    this and Dogecoin Core accepts it without modification.
    for (let i = 0; i < psbt.inputCount; i++) {
      psbt.signInput(i, keyPair as any);
    }
    psbt.finalizeAllInputs();

    // 7) Fee check, then the one broadcast (see `broadcastDoge`).
    return broadcastDoge(psbt, plan.inputs.reduce((t, i) => t + i.valueSat, 0));
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
    //
    // The SAME clamped rate the sends use (2026-09-29): the modal showed the
    // raw oracle — 0.13 DOGE at BlockCypher's 0.58 DOGE/kB — for sends that
    // then failed at bitcoinjs-lib's fee guard.
    const { satPerKb, oracle } = await dogeSatPerKb();
    const feeSat = Math.ceil((satPerKb * STANDARD_TX_BYTES) / 1000);
    return {
      normal: { value: (feeSat / 1e8).toFixed(8) },
      unit: "DOGE",
      fetchedAt: Date.now(),
      raw: { source: oracle === null ? "static" : "oracle", satPerKb, oracleSatPerKb: oracle },
    };
  },
};
