/**
 * Litecoin (LTC) ChainAdapter.
 *
 * Pure clone of [[Bitcoin]] with LTC's network bytes. Same crypto path
 * (BIP-143 segwit sighash, P2WPKH outputs), so the entire `bitcoinjs-lib`
 * PSBT pipeline transfers verbatim — only the network constants and the
 * data-source endpoints change.
 *
 * Network-side architecture:
 *   - Primary backend: BlockCypher's keyless LTC main endpoint
 *     (`api.blockcypher.com/v1/ltc/main`). Returns balance, UTXO,
 *     fee tiers, and accepts raw-tx broadcast in a single REST surface.
 *   - Fallback backend: Blockchair's `litecoin/dashboards/...` endpoints
 *     for balance + paginated history. Already on the proxy allowlist
 *     via the BTC and DOGE entries.
 *
 * MWEB note: Litecoin's Mimblewimble Extension Blocks (2022) introduced
 * `ltcmweb1...` addresses that look bech32-ish but use a different
 * encoding. We only ever generate P2WPKH (`ltc1...`) and never spend
 * MWEB outputs, so the adapter doesn't need MWEB awareness; if a user
 * pastes an MWEB address as recipient, `bitcoinjs-lib` will throw on
 * decode and the UI will surface a real error.
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
  scanUtxoAccount,
  DEFAULT_GAP_LIMIT,
  gatherAccountSpend,
  accountShortfallMessage,
  P2WPKH_SIZING,
} from "./utxo-account";
// Re-exported so the account-send tests and any future caller have one
// import site per concept; the DEFINITION lives in `utxo-account.ts`
// (moved there 2026-08-25 when BTC/DOGE/DASH/BCH adopted it).
export {
  planAccountSpend,
  P2WPKH_SIZING,
  P2PKH_SIZING,
} from "./utxo-account";
export type {
  AccountSpendCandidate,
  AccountSpendPlan,
  TxSizing,
} from "./utxo-account";
/** LTC/BTC standard relay dust. */
export const LTC_DUST_SAT = 546;
import {
  parseEsploraStats,
  blockchairProbe,
  blockcypherProbe,
  type UtxoProbeResult,
} from "./_utxo-probes";

bitcoin.initEccLib(tinysecp);
const ECPair = ECPairFactory(tinysecp);

// =========================================================================
// Network parameters — values pulled from `litecoin-project/litecoin`
// `chainparams.cpp`. The bip32 version bytes are LTC's official "Ltub"/
// "Ltpv" prefixes (SLIP-0132); they only matter if we ever serialize an
// xpub, which we don't today. pubKeyHash 0x30 → "L..." legacy P2PKH;
// scriptHash 0x32 → "M..." (post-2017 P2SH); bech32 'ltc' → "ltc1..."
// segwit. Setting all three means PSBT.addOutput() accepts every modern
// LTC recipient form a user is likely to paste.
// =========================================================================
const ltcNetwork: bitcoin.Network = {
  messagePrefix: "\x19Litecoin Signed Message:\n",
  bech32: "ltc",
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

const BLOCKCYPHER_BASE = "https://api.blockcypher.com/v1/ltc/main";
const BLOCKCHAIR_BASE = "https://api.blockchair.com/litecoin";
// 2026-06-14 — third provider. Esplora (Blockstream-API-compatible) LTC
// instance, marked verified-working in chain-rpcs.ts. Gives the send path
// (UTXO + broadcast) and balance a third way out so a single provider's
// 429/outage can't strand a transaction. Must be on the Rust allowlist
// (src-tauri/src/http_proxy.rs). See [[remote-connections-inventory]].
const LITECOINSPACE_BASE = "https://litecoinspace.org/api";

// Multi-source try-each — same pattern as doge/bch/dash. A signed tx must
// have more than one way to broadcast, and reads must survive one provider
// rate-limiting. Returns the first source that succeeds; throws only if ALL
// fail, naming each tried source.
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
    `All ${tried.length} LTC source(s) failed [${tried.join(", ")}]: ${tail}`
  );
}

/** Normalized UTXO across providers — shaped to match the existing PSBT
 *  loop (tx_hash / tx_output_n / value-litoshi) so the signing path is
 *  untouched. */
interface NormalizedLtcUtxo {
  tx_hash: string;
  tx_output_n: number;
  value: number;
}

async function fetchUtxosBlockcypher(addr: string): Promise<NormalizedLtcUtxo[]> {
  const r = await proxyGetJson<BlockCypherUtxoSet>(
    `${BLOCKCYPHER_BASE}/addrs/${addr}?unspentOnly=true&limit=2000`
  );
  return [...(r.txrefs ?? []), ...(r.unconfirmed_txrefs ?? [])].map((u) => ({
    tx_hash: u.tx_hash,
    tx_output_n: u.tx_output_n,
    value: u.value,
  }));
}

async function fetchUtxosBlockchair(addr: string): Promise<NormalizedLtcUtxo[]> {
  const r = await proxyGetJson<{
    data: Record<
      string,
      { utxo?: Array<{ transaction_hash: string; index: number; value: number }> }
    >;
  }>(`${BLOCKCHAIR_BASE}/dashboards/address/${addr}?limit=2000`);
  return (r.data?.[addr]?.utxo ?? []).map((u) => ({
    tx_hash: u.transaction_hash,
    tx_output_n: u.index,
    value: u.value,
  }));
}

async function fetchUtxosLitecoinspace(addr: string): Promise<NormalizedLtcUtxo[]> {
  const r = await proxyGetJson<Array<{ txid: string; vout: number; value: number }>>(
    `${LITECOINSPACE_BASE}/address/${addr}/utxo`
  );
  return (Array.isArray(r) ? r : []).map((u) => ({
    tx_hash: u.txid,
    tx_output_n: u.vout,
    value: u.value,
  }));
}

async function broadcastBlockcypher(rawHex: string): Promise<string> {
  const r = await proxyPostJson<{ tx?: { hash?: string }; error?: string }>(
    `${BLOCKCYPHER_BASE}/txs/push`,
    { tx: rawHex }
  );
  if (r.error) throw new Error(`blockcypher push: ${r.error}`);
  const hash = r.tx?.hash;
  if (!hash) throw new Error("blockcypher push: no txid");
  return hash;
}

async function broadcastBlockchair(rawHex: string): Promise<string> {
  // Blockchair wants form-urlencoded `data=<hex>`; proxyPostJson forces a
  // JSON content-type that blockchair rejects, so go through httpProxyCall.
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

async function broadcastLitecoinspace(rawHex: string): Promise<string> {
  // Esplora POST /tx — raw hex body, returns the txid as PLAIN TEXT.
  const r = await httpProxyCall({
    method: "POST",
    url: `${LITECOINSPACE_BASE}/tx`,
    body: rawHex,
    headers: { "Content-Type": "text/plain" },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`litecoinspace push HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  }
  const txid = r.body.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new Error(`litecoinspace push: unexpected response ${txid.slice(0, 80)}`);
  }
  return txid;
}

/** Multi-source UTXO fetch for one address (BlockCypher → Blockchair →
 *  litecoinspace). An address with no UTXOs returns `[]` from the first
 *  reachable source (a valid success), so tryEach stops there rather than
 *  treating "empty" as a failure to retry. */
async function fetchUtxos(addr: string): Promise<NormalizedLtcUtxo[]> {
  return tryEach<NormalizedLtcUtxo[]>([
    { name: "blockcypher", fn: () => fetchUtxosBlockcypher(addr) },
    { name: "blockchair", fn: () => fetchUtxosBlockchair(addr) },
    { name: "litecoinspace", fn: () => fetchUtxosLitecoinspace(addr) },
  ]);
}

// ── Raw previous-transaction hex ──────────────────────────────────────────
// Spending a LEGACY P2PKH (L…) input requires the FULL previous transaction
// (`nonWitnessUtxo`), not just the output's value+script the way a segwit
// `witnessUtxo` input does — bitcoinjs-lib refuses to sign a P2PKH input
// without it (defends against the SegWit fee-forgery attack). These fetchers
// return the raw tx hex for one txid across the same three providers.

async function fetchRawTxLitecoinspace(txid: string): Promise<string> {
  // Esplora GET /tx/{txid}/hex → raw hex as plain text.
  const r = await httpProxyCall({
    method: "GET",
    url: `${LITECOINSPACE_BASE}/tx/${txid}/hex`,
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`litecoinspace hex HTTP ${r.status}: ${r.body.slice(0, 120)}`);
  }
  const hex = r.body.trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 20) {
    throw new Error(`litecoinspace hex: unexpected response ${hex.slice(0, 80)}`);
  }
  return hex;
}

async function fetchRawTxBlockcypher(txid: string): Promise<string> {
  const r = await proxyGetJson<{ hex?: string }>(
    `${BLOCKCYPHER_BASE}/txs/${txid}?includeHex=true&limit=1`
  );
  if (!r.hex) throw new Error("blockcypher: no hex in tx response");
  return r.hex;
}

async function fetchRawTxBlockchair(txid: string): Promise<string> {
  const r = await proxyGetJson<{
    data?: Record<string, { raw_transaction?: string }>;
  }>(`${BLOCKCHAIR_BASE}/raw/transaction/${txid}`);
  const hex = r.data?.[txid]?.raw_transaction;
  if (!hex) throw new Error("blockchair: no raw_transaction");
  return hex;
}

/** First provider that yields the raw hex wins. Esplora's `/tx/{id}/hex` is
 *  the most reliable plain-hex surface, so it leads. */
async function fetchRawTxHex(txid: string): Promise<string> {
  return tryEach<string>([
    { name: "litecoinspace", fn: () => fetchRawTxLitecoinspace(txid) },
    { name: "blockcypher", fn: () => fetchRawTxBlockcypher(txid) },
    { name: "blockchair", fn: () => fetchRawTxBlockchair(txid) },
  ]);
}
// DEFAULT: BIP-84 native SegWit P2WPKH path (m/84'/2'/0'/0/0 → ltc1q…).
// Aligned with the Rust swap core (src-tauri/src/swap/derive.rs) so the
// dashboard address, the swap "Extra source addresses" card, and the
// address the Rust signer scans during a NEAR Intents transfer all match.
// This matches Electrum and Trezor (native segwit).
//
// CORRECTED 2026-06-14: this is NOT what Exodus uses. Exodus derives
// Litecoin at BIP-44 legacy m/44'/2'/0'/0/0 → an "L…" P2PKH address (per
// Exodus's own published derivation table, transcribed in
// PwndaWalletVault/wiki/concepts/derivation-paths.md). Earlier comments
// here and in the wiki claimed BIP-84 "matches Exodus" — that was false
// and is why a user's Exodus LTC balance is invisible in this app. The
// legacy capability below lets a user reach their Exodus L… address
// WITHOUT changing this default (flipping it would strand anyone already
// funded at the current ltc1q… address — the exact BTC bug from
// [[post-mortem-derivation-paths]]). See [[2026-06-14-litecoin-derivation-exodus]].
const DERIVATION_PATH = "m/84'/2'/0'/0/0";
// Exodus-matching BIP-44 legacy path → P2PKH "L…" address.
const LEGACY_BIP44_PATH = "m/44'/2'/0'/0/0";

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
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(publicKey),
    network: ltcNetwork,
  });
  return address!;
}

/** Encode the BIP-44 legacy P2PKH "L…" address — the form Exodus uses. */
function getLegacyAddress(publicKey: Uint8Array): string {
  const { address } = bitcoin.payments.p2pkh({
    pubkey: Buffer.from(publicKey),
    network: ltcNetwork,
  });
  return address!;
}

/**
 * Derive LTC at the Exodus-matching BIP-44 legacy path (m/44'/2'/0'/0/0),
 * encoded as a P2PKH "L…" address. NON-DEFAULT capability used by the
 * derivation picker so a user importing an Exodus seed can see their LTC.
 * The default `deriveFromMnemonic` stays BIP-84 ltc1q… so existing vaults
 * are unchanged (flipping the default would strand funds at the current
 * address). Receiving + balance at the L… address work today; SPENDING from
 * it needs a P2PKH (nonWitnessUtxo) send path, added with the picker UI.
 */
export function deriveLtcLegacyFromMnemonic(mnemonic: string): WalletInfo {
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(LEGACY_BIP44_PATH);
  return {
    chain: "litecoin",
    address: getLegacyAddress(child.publicKey!),
    mnemonic: mnemonic.trim(),
    privateKey: bytesToHex(child.privateKey!),
  };
}

// ── Legacy → modern migration (2026-08-21) ────────────────────────────────
// The mirror of btc-wallet's legacy sweep, with the direction inverted: on
// this chain it is the LEGACY derivation that can be the ACTIVE one (the
// import picker selects m/44'/2'/0'/0/0 for Exodus-style seeds, because that
// is where the funds are), and the modern BIP-84 ltc1… address is the
// migration TARGET. Two reasons a user migrates:
//
//  1. C8 wallet sharing: the swap engine's WalletManager encodes native
//     SegWit only, so a legacy-derivation LTC cannot be shared — the DEX
//     coins row says so. After this one send, it shares like BTC.
//  2. Fees: spending P2PKH inputs costs ~2.4x the vbytes of P2WPKH.
//
// The destination is DERIVED here from the caller's own mnemonic — there is
// no address parameter on the panel that uses this, for the same W-2 reason
// `swap_bridge` pins its sweep destination: a fund-moving affordance must not
// accept a typed destination.

/** One spendable coin at the legacy address, as the planner consumes it. */
export interface LegacySweepUtxo {
  txid: string;
  vout: number;
  /** litoshis */
  value: number;
}

export interface LegacySweepPlan {
  /** Every UTXO — a sweep leaves nothing behind by definition. */
  inputs: LegacySweepUtxo[];
  /** litoshis reaching the destination. */
  sendValue: number;
  /** litoshis paid to miners. */
  fee: number;
  /** Estimated vsize the fee was computed against. */
  estimatedVBytes: number;
}

/** P2PKH input ≈148 vB (scriptSig carries sig+pubkey, no witness discount);
 *  one P2WPKH output ≈31 vB; ~10 vB overhead. +20 cushions estimate error the
 *  same way the BTC sweep does. */
const LEGACY_SWEEP_DUST_LITS = 546;

/**
 * Pure sweep planner — exported for tests, because the two failure modes here
 * are silent money bugs: an underestimated size becomes a stuck low-fee tx,
 * and a missed dust check becomes a sweep that burns most of a tiny balance
 * as fees without asking.
 */
export function planLegacyLtcSweep(
  utxos: readonly LegacySweepUtxo[],
  feePerVB: number,
): LegacySweepPlan {
  if (utxos.length === 0) {
    throw new Error("The legacy address has no spendable coins to move.");
  }
  if (!Number.isFinite(feePerVB) || feePerVB <= 0) {
    throw new Error(`Invalid fee rate: ${feePerVB}`);
  }
  const totalInput = utxos.reduce((acc, u) => acc + u.value, 0);
  const estimatedVBytes = 10 + 148 * utxos.length + 31 + 20;
  const fee = Math.ceil(feePerVB * estimatedVBytes);
  const sendValue = totalInput - fee;
  if (sendValue < LEGACY_SWEEP_DUST_LITS) {
    throw new Error(
      `The legacy balance (${(totalInput / 1e8).toFixed(8)} LTC) is below the ` +
        `dust + fee threshold (fee ≈ ${(fee / 1e8).toFixed(8)} LTC) — nothing ` +
        "worth moving.",
    );
  }
  return { inputs: [...utxos], sendValue, fee, estimatedVBytes };
}

/** The wallet's modern BIP-84 address for this mnemonic — the migration
 *  target, derived rather than accepted as input. */
export function modernLtcAddressFromMnemonic(mnemonic: string): string {
  // Same construction as the adapter's own deriveFromMnemonic — the standard
  // BIP-84 path — restated here because the adapter object is declared below
  // this point in the file.
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const child = HDKey.fromMasterSeed(seed).derive(DERIVATION_PATH);
  return getAddress(child.publicKey!);
}

/** Spendable balance (litoshis) at any LTC address, via the same
 *  multi-provider UTXO fetch the send path uses. */
export async function getLtcAddressBalanceLits(address: string): Promise<number> {
  const utxos = await fetchUtxos(address);
  return utxos.reduce((acc, u) => acc + u.value, 0);
}

/**
 * Sweep the ENTIRE legacy-derivation balance to the same mnemonic's modern
 * BIP-84 address. Single transaction; the legacy address ends at zero.
 *
 * Both keys come from one mnemonic, so this never crosses wallets — it is a
 * self-send between two derivations of the same seed. Broadcast goes through
 * the same three-provider ladder as an ordinary send.
 */
export async function sweepLegacyLtcToModern(
  mnemonic: string,
  feeRateOverride?: number,
): Promise<TxResult & { destination: string; sweptLits: number }> {
  const legacy = deriveLtcLegacyFromMnemonic(mnemonic);
  const destination = modernLtcAddressFromMnemonic(mnemonic);

  const keyPair = ECPair.fromPrivateKey(
    Buffer.from(hexToBytes(legacy.privateKey)),
    { network: ltcNetwork },
  );

  const rawUtxos = await fetchUtxos(legacy.address);
  const utxos: LegacySweepUtxo[] = rawUtxos.map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_output_n,
    value: u.value,
  }));

  let feePerVB = feeRateOverride ?? 10; // sendTransaction's own default
  if (feeRateOverride === undefined) {
    // Same two oracles the send path consults, same order, same fallback.
    try {
      feePerVB = await tryEach<number>([
        {
          name: "blockcypher",
          fn: async () => {
            const info = await proxyGetJson<BlockCypherChainInfo>(BLOCKCYPHER_BASE);
            const perKb = info.medium_fee_per_kb;
            if (!perKb || perKb <= 0) throw new Error("no blockcypher fee");
            return Math.max(Math.ceil(perKb / 1000), 1);
          },
        },
        {
          name: "litecoinspace",
          fn: async () => {
            const est = await proxyGetJson<Record<string, number>>(
              `${LITECOINSPACE_BASE}/fee-estimates`
            );
            const v = est["6"] ?? est["3"] ?? est["1"];
            if (!v || v <= 0) throw new Error("no esplora fee");
            return Math.max(Math.ceil(v), 1);
          },
        },
      ]);
    } catch {
      /* keep the default */
    }
  }

  const plan = planLegacyLtcSweep(utxos, feePerVB);

  const psbt = new bitcoin.Psbt({ network: ltcNetwork });
  // P2PKH inputs each need the FULL previous transaction (nonWitnessUtxo) —
  // bitcoinjs refuses to sign without it. Same fetch ladder as the send path.
  for (const input of plan.inputs) {
    const rawHex = await fetchRawTxHex(input.txid);
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      nonWitnessUtxo: Buffer.from(rawHex, "hex"),
    });
  }
  psbt.addOutput({ address: destination, value: BigInt(plan.sendValue) });
  for (let i = 0; i < plan.inputs.length; i++) {
    psbt.signInput(i, {
      publicKey: Buffer.from(keyPair.publicKey),
      sign: (hash: Buffer) => Buffer.from(keyPair.sign(hash)),
    });
  }
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();

  const hash = await tryEach<string>([
    { name: "blockcypher", fn: () => broadcastBlockcypher(rawTx) },
    { name: "blockchair", fn: () => broadcastBlockchair(rawTx) },
    { name: "litecoinspace", fn: () => broadcastLitecoinspace(rawTx) },
  ]);
  return { hash, destination, sweptLits: plan.sendValue };
}

// -------------------------------------------------------------------------
// BlockCypher response shapes (subset of what we read)
// -------------------------------------------------------------------------

interface BlockCypherTxRef {
  tx_hash: string;
  tx_output_n: number;
  value: number; // litoshis
  confirmations?: number;
}

interface BlockCypherBalance {
  balance: number;
  unconfirmed_balance: number;
  final_balance: number;
}

interface BlockCypherUtxoSet {
  txrefs?: BlockCypherTxRef[];
  unconfirmed_txrefs?: BlockCypherTxRef[];
}

interface BlockCypherFullTx {
  hash: string;
  block_height?: number;
  confirmations?: number;
  confirmed?: string;
  fees?: number;
  inputs?: { addresses?: string[]; output_value?: number }[];
  outputs?: { addresses?: string[]; value: number }[];
}

interface BlockCypherChainInfo {
  high_fee_per_kb?: number;
  medium_fee_per_kb?: number;
  low_fee_per_kb?: number;
  height?: number;
}

// -------------------------------------------------------------------------
// History fetchers — extracted so the cursor-routed `getTransactionHistory`
// can rotate between BlockCypher (rich one-shot, but rate-limited) and
// Blockchair (two-step dashboard + batched detail; same shape DOGE/BCH use).
// -------------------------------------------------------------------------

async function fetchHistoryBlockcypher(
  address: string,
  limit: number,
  beforeCursor: string | undefined
): Promise<TxHistoryPage> {
  const beforeQuery = beforeCursor ? `&before=${beforeCursor}` : "";
  const r = await proxyGetJson<{ txs?: BlockCypherFullTx[] }>(
    `${BLOCKCYPHER_BASE}/addrs/${address}/full?limit=${limit}${beforeQuery}&txlimit=200`
  );
  const txs = r.txs ?? [];
  const items: ChainTx[] = txs.map((tx) => {
    let outFromMe = 0;
    for (const inp of tx.inputs ?? []) {
      if ((inp.addresses ?? []).includes(address)) {
        outFromMe += inp.output_value || 0;
      }
    }
    let inToMe = 0;
    let firstExternal: string | undefined;
    for (const out of tx.outputs ?? []) {
      const addrs = out.addresses ?? [];
      if (addrs.includes(address)) inToMe += out.value || 0;
      else if (!firstExternal && addrs[0]) firstExternal = addrs[0];
    }
    const net = inToMe - outFromMe;
    const direction: ChainTx["direction"] =
      net > 0 ? "in" : net < 0 ? "out" : "self";
    const ts = tx.confirmed
      ? Math.floor(new Date(tx.confirmed).getTime() / 1000)
      : undefined;
    return {
      chain: "litecoin",
      hash: tx.hash,
      direction,
      amount: (Math.abs(net) / 1e8).toFixed(8),
      fee:
        direction === "out" && tx.fees !== undefined
          ? (tx.fees / 1e8).toFixed(8)
          : undefined,
      timestamp: ts,
      confirmations: tx.confirmations,
      height: tx.block_height,
      counterparty: direction === "out" ? firstExternal : undefined,
      meta: { _via: "blockcypher" },
    };
  });
  const heights = items
    .map((i) => i.height)
    .filter((h): h is number => typeof h === "number");
  const cursor =
    items.length === limit && heights.length > 0
      ? `bc:${Math.min(...heights)}`
      : undefined;
  return { items, cursor };
}

async function fetchHistoryBlockchair(
  address: string,
  limit: number,
  offset: number
): Promise<TxHistoryPage> {
  const dash = await proxyGetJson<{
    data: Record<
      string,
      {
        address: { received: number; spent: number };
        transactions: string[];
      }
    >;
  }>(
    `https://api.blockchair.com/litecoin/dashboards/address/${address}?limit=${limit}&offset=${offset}`
  );
  const txids = (dash.data?.[address]?.transactions ?? []).slice(0, limit);
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
      }>(
        `https://api.blockchair.com/litecoin/dashboards/transactions/${batch.join(",")}`
      );
      for (const txid of batch) {
        const d = detail.data?.[txid];
        if (!d) continue;
        let outFromMe = 0;
        for (const inp of d.inputs ?? []) {
          if (inp.recipient === address) outFromMe += inp.value || 0;
        }
        let inToMe = 0;
        let firstExternal: string | undefined;
        for (const out of d.outputs ?? []) {
          if (out.recipient === address) inToMe += out.value || 0;
          else if (!firstExternal && out.recipient) firstExternal = out.recipient;
        }
        const net = inToMe - outFromMe;
        const direction: ChainTx["direction"] =
          net > 0 ? "in" : net < 0 ? "out" : "self";
        items.push({
          chain: "litecoin",
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
          counterparty: direction === "out" ? firstExternal : undefined,
          meta: { _via: "blockchair" },
        });
      }
    } catch {
      /* skip the batch on failure; partial history is still useful */
    }
  }

  const cursor = txids.length === limit ? `bk:${offset + limit}` : undefined;
  return { items, cursor };
}

/**
 * Balance AND history-existence for one address, in a single answer.
 *
 * The account walk needs `used` — "has this address ever seen a transaction"
 * — not just the balance. An address that received and spent everything reads
 * `0`, and treating that as "unused" would let the gap run swallow exactly the
 * region where a wallet has been active. Every source below reports both, so
 * this costs no extra round trip over `getBalance`.
 *
 * Throws when no source answers — a scan that cannot see is not a scan that
 * saw nothing (see `ChainAdapter.getBalance`'s contract).
 */
async function probeLtcAddress(
  address: string,
): Promise<UtxoProbeResult> {
  return tryEach<UtxoProbeResult>([
    {
      // Esplora leads: it is the only source here that reports confirmed and
      // mempool sums plus a tx count in one document, and it did not rate-limit
      // during the 2026-08-22 survey while BlockCypher returned 429.
      name: "litecoinspace",
      fn: async () =>
        parseEsploraStats(await proxyGetJson(`${LITECOINSPACE_BASE}/address/${address}`)),
    },
    { name: "blockcypher", fn: () => blockcypherProbe(BLOCKCYPHER_BASE, address) },
    { name: "blockchair", fn: () => blockchairProbe(BLOCKCHAIR_BASE, address) },
  ]);
}

/**
 * The two accounts a Litecoin wallet's funds can live under.
 *
 * BIP-84 is this app's default derivation; BIP-44 legacy is what Exodus and
 * Atomic produce, and the import picker can select it. Both are listed because
 * "where are my coins" must not depend on which one the vault happens to hold
 * — the recovery surface in particular needs to answer for the seed, not for
 * the currently-selected derivation.
 */
/**
 * Consolidate an LTC account's scattered outputs into its own displayed address.
 *
 * # Why this exists, and why it is MANUAL
 *
 * Spending a UTXO sends the remainder to a fresh change address, so an account
 * that has been spent from a few times holds its money at derivation indices
 * the user has never seen. That is normal and correct — but it has two real
 * costs: a restore must scan far enough to find every one of them (see
 * `analyzeRecoveryRisk` / `assessGapHeadroom`), and every future send pays for
 * more inputs.
 *
 * A 2026-08-25 survey of Electrum, Sparrow, BlueWallet, Trezor Suite, Ledger
 * Live and Wasabi found **none of them consolidate automatically**, and the
 * reasons are not stylistic:
 *
 *  - **Privacy.** Merging previously-separate outputs publishes, on-chain and
 *    permanently, that one entity owns all of them (the common-input-ownership
 *    heuristic). Wasabi warns above ~10 inputs for exactly this reason.
 *  - **Fees.** A consolidation buys the user nothing today; it is a bet on
 *    future fee rates, and which fee environment to take it in is the user's
 *    call, not the wallet's.
 *  - **Timing.** Sweeping outputs that a swap has reserved would be actively
 *    harmful, and a background task cannot know.
 *
 * So this is a function a user invokes, never a schedule. The caller is
 * responsible for the in-flight-swap check — see `ConsolidationPlan.blocked`.
 *
 * # The destination is derived, never passed
 *
 * It is `modernLtcAddressFromMnemonic(mnemonic)` — index 0 of the receive
 * chain, the address the dashboard already shows. Nothing in the UI can change
 * where this sends, which is the same rule `sweepLegacyLtcToModern` follows and
 * the reason neither takes a destination argument.
 */
export interface ConsolidationInput {
  /** Full BIP-32 path of the address holding the output. */
  path: string;
  address: string;
  chainIndex: 0 | 1;
  index: number;
  balanceSat: number;
}

export interface ConsolidationPlan {
  /** Where everything lands — derived from the seed, never supplied. */
  destination: string;
  /** Addresses that will be swept (excludes the destination itself). */
  sources: ConsolidationInput[];
  /** Sum of the sources' balances, before fee. */
  totalSat: number;
  /** Estimated fee at the resolved rate. */
  feeSat: number;
  /** What actually arrives: `totalSat - feeSat`. */
  netSat: number;
  feePerVB: number;
  /** Set when the plan must not be run; the sentence says why. */
  blocked: string | null;
}

/** P2WPKH: ~68 vB per input, ~31 vB per output, ~11 vB overhead. */
export function estimateConsolidationVBytes(inputCount: number): number {
  return 11 + inputCount * 68 + 31;
}

/**
 * Decide what a consolidation would do, WITHOUT touching the network or
 * signing anything. Pure, so every refusal below is unit-testable.
 *
 * Refuses (via `blocked`) rather than throwing, so a caller can render the
 * reason next to a disabled button instead of catching to find out.
 */
export function planLtcConsolidation(args: {
  destination: string;
  entries: ConsolidationInput[];
  feePerVB: number;
  /** True while any swap is in flight — the caller knows, this module cannot. */
  swapInFlight?: boolean;
  /** Below this, sweeping costs more than it moves. */
  dustSat?: number;
}): ConsolidationPlan {
  const dust = args.dustSat ?? 546;
  // The destination's own output is already where we want it; including it
  // would spend and re-create it for nothing but a fee.
  const sources = args.entries
    .filter((e) => e.balanceSat > 0 && e.address !== args.destination)
    .sort((a, b) => b.balanceSat - a.balanceSat);
  const totalSat = sources.reduce((s, e) => s + e.balanceSat, 0);
  const feeSat = Math.ceil(
    args.feePerVB * estimateConsolidationVBytes(sources.length),
  );
  const netSat = totalSat - feeSat;

  let blocked: string | null = null;
  if (args.swapInFlight) {
    blocked =
      "A swap is still running. Some of these coins may be committed to it, " +
      "so consolidating now could interfere with settlement. Let it finish first.";
  } else if (sources.length === 0) {
    blocked =
      "Everything is already at your main address — there is nothing to bring together.";
  } else if (sources.length === 1) {
    blocked =
      "Only one address holds coins besides your main one, so consolidating " +
      "would pay a fee to move a single output. Not worth it.";
  } else if (netSat <= dust) {
    blocked =
      "The network fee would consume the whole amount. Try again when fees are lower.";
  }

  return {
    destination: args.destination,
    sources,
    totalSat,
    feeSat,
    netSat,
    feePerVB: args.feePerVB,
    blocked,
  };
}

export const ltcUtxoAccounts: UtxoAccountSpec[] = [
  {
    chain: "litecoin",
    accountPath: "m/84'/2'/0'",
    label: "BIP-84 native SegWit",
    deriveAddress: (node) => getAddress(node.publicKey!),
    probe: probeLtcAddress,
  },
  {
    chain: "litecoin",
    accountPath: "m/44'/2'/0'",
    label: "BIP-44 legacy (Exodus/Atomic)",
    deriveAddress: (node) => getLegacyAddress(node.publicKey!),
    probe: probeLtcAddress,
  },
];

/**
 * Execute a consolidation: sweep every funded address of the BIP-84 account
 * into that account's own index-0 receive address.
 *
 * Signs each input with the key derived for THAT input's own path — the whole
 * point is that the outputs live at different derivation indices, so there is
 * no single key that spends them. Deliberately BIP-84-only: the legacy account
 * has its own dedicated migration (`sweepLegacyLtcToModern`), and mixing
 * script types here would mean two witness shapes in one estimator.
 *
 * Re-plans against freshly fetched UTXOs rather than trusting the caller's
 * `entries`: an account scan can be minutes old, and signing inputs that were
 * already spent produces a transaction the network rejects. The plan the user
 * approved is re-derived here and any `blocked` reason aborts the send.
 */
export async function consolidateLtcAccount(
  mnemonic: string,
  opts?: { feeRateOverride?: number; swapInFlight?: boolean; gapLimit?: number },
): Promise<TxResult & { destination: string; movedLits: number; inputs: number }> {
  const spec = ltcUtxoAccounts[0]; // BIP-84 — see the doc above
  const destination = modernLtcAddressFromMnemonic(mnemonic);

  // 1) Find the account's funded addresses, now — not from a cached scan.
  const scan = await scanUtxoAccount(mnemonic, spec, {
    gapLimit: opts?.gapLimit ?? DEFAULT_GAP_LIMIT,
  });
  if (!scan.complete) {
    throw new Error(
      "Could not see the whole account — a block explorer did not answer. " +
        "Consolidating on a partial view could miss coins, so nothing was sent.",
    );
  }

  // 2) Resolve a fee rate from the same oracles the send path uses.
  let feePerVB = opts?.feeRateOverride ?? 10;
  if (opts?.feeRateOverride === undefined) {
    try {
      feePerVB = await tryEach<number>([
        {
          name: "blockcypher",
          fn: async () => {
            const info = await proxyGetJson<BlockCypherChainInfo>(BLOCKCYPHER_BASE);
            const perKb = info.medium_fee_per_kb;
            if (!perKb || perKb <= 0) throw new Error("no blockcypher fee");
            return Math.max(Math.ceil(perKb / 1000), 1);
          },
        },
        {
          name: "litecoinspace",
          fn: async () => {
            const est = await proxyGetJson<Record<string, number>>(
              `${LITECOINSPACE_BASE}/fee-estimates`,
            );
            const v = est["6"] ?? est["3"] ?? est["1"];
            if (!v || v <= 0) throw new Error("no esplora fee");
            return Math.max(Math.ceil(v), 1);
          },
        },
      ]);
    } catch {
      /* keep the default */
    }
  }

  const plan = planLtcConsolidation({
    destination,
    entries: scan.entries
      .filter((e) => e.balanceSat > 0)
      .map((e) => ({
        path: e.path,
        address: e.address,
        chainIndex: e.chainIndex,
        index: e.index,
        balanceSat: e.balanceSat,
      })),
    feePerVB,
    swapInFlight: opts?.swapInFlight,
  });
  if (plan.blocked) throw new Error(plan.blocked);

  // 3) One key per source address. `deriveChild` twice mirrors
  //    `deriveUtxoAddresses`' own walk, so a path here cannot drift from the
  //    path the scan reported.
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  const account = root.derive(spec.accountPath);

  const psbt = new bitcoin.Psbt({ network: ltcNetwork });
  const signers: Array<ReturnType<typeof ECPair.fromPrivateKey>> = [];
  let totalInput = 0;

  for (const src of plan.sources) {
    const node = account.deriveChild(src.chainIndex).deriveChild(src.index);
    if (!node.privateKey) {
      throw new Error(`No signing key for ${src.path}; nothing was sent.`);
    }
    const keyPair = ECPair.fromPrivateKey(Buffer.from(node.privateKey), {
      network: ltcNetwork,
    });
    // A derived address that does not match what the scan recorded means the
    // path and the address have diverged — refuse rather than sign blind.
    const derived = spec.deriveAddress(node);
    if (derived !== src.address) {
      throw new Error(
        `Derivation mismatch at ${src.path}: expected ${src.address}, got ` +
          `${derived}. Nothing was sent.`,
      );
    }
    const witnessScript = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: ltcNetwork,
    }).output!;

    for (const u of await fetchUtxos(src.address)) {
      psbt.addInput({
        hash: u.tx_hash,
        index: u.tx_output_n,
        witnessUtxo: { script: witnessScript, value: BigInt(u.value) },
      });
      signers.push(keyPair);
      totalInput += u.value;
    }
  }

  if (signers.length === 0) {
    throw new Error(
      "Those addresses hold no spendable outputs right now — they may have " +
        "just been spent. Nothing was sent.",
    );
  }

  // 4) Re-price against the REAL input count (the plan estimated from address
  //    count; one address can hold several outputs).
  const feeSat = Math.ceil(
    feePerVB * estimateConsolidationVBytes(signers.length),
  );
  const sendValue = totalInput - feeSat;
  if (sendValue <= 546) {
    throw new Error(
      `The network fee (${(feeSat / 1e8).toFixed(8)} LTC) would consume the ` +
        `whole amount. Nothing was sent.`,
    );
  }

  psbt.addOutput({ address: destination, value: BigInt(sendValue) });
  for (let i = 0; i < signers.length; i++) {
    const kp = signers[i];
    psbt.signInput(i, {
      publicKey: Buffer.from(kp.publicKey),
      sign: (hash: Buffer) => Buffer.from(kp.sign(hash)),
    });
  }
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();

  const hash = await tryEach<string>([
    { name: "blockcypher", fn: () => broadcastBlockcypher(rawTx) },
    { name: "blockchair", fn: () => broadcastBlockchair(rawTx) },
    { name: "litecoinspace", fn: () => broadcastLitecoinspace(rawTx) },
  ]);
  return { hash, destination, movedLits: sendValue, inputs: signers.length };
}
/**
 * Spend from the whole LTC account — the way every other wallet does.
 *
 * # Why this exists
 *
 * `sendTransaction` takes one private key and can therefore only spend
 * `m/84'/2'/0'/0/0`. On a UTXO chain that address goes empty the first time
 * anything spends with real BIP-32 change behaviour, and the money moves to
 * indices that key cannot reach. On 2026-08-25 that meant 4.05726856 LTC —
 * a correct, displayed, on-chain balance — could not be sent, because index
 * 0/0 held nothing.
 *
 * Every wallet that does not have this problem solves it the same way, and
 * none of them avoid the splitting itself:
 *
 *   - **Electrum / Sparrow / BlueWallet / Trezor Suite** keep a derived-address
 *     set per account, sync balances across all of it, and select inputs from
 *     the whole set at spend time. Coin control exists to let a user OVERRIDE
 *     that selection, which is only meaningful because the default is
 *     account-wide.
 *   - **BasicSwap's own `WalletManager`** — the LTC wallet inside the DEX —
 *     does exactly this too: `_fundTxElectrum` calls
 *     `wm.getFundedAddresses(coin_type)` and funds from every address the
 *     account owns. It is why the engine could always spend the 4.02888049
 *     that pwnda's Send button could not.
 *
 * So this is not a novel mechanism. It is the standard one, which pwnda's
 * UTXO adapters skipped because a single-address model was true right up
 * until something spent properly.
 *
 * # What it does
 *
 * The scan / derive / select half is `gatherAccountSpend` in
 * `utxo-account.ts`, shared with BTC, DOGE, DASH and BCH. What stays here is
 * the part that is genuinely Litecoin's: P2WPKH `witnessUtxo` inputs, a PSBT,
 * and the three-source broadcast.
 *
 * Change goes to the internal chain — the lowest unused index there
 * (`nextChangeIndex`, utxo-account.ts) — since 2026-09-04. Until then it went
 * back to the index-0 receive address on the theory that this "consolidates
 * rather than fragments"; that theory put every send's change on the one
 * address receive rotation exists to stop reusing, and it was the opposite of
 * what Electrum, Sparrow, BlueWallet, Trezor Suite, Exodus and the swap engine
 * (PWNDA-PATCH-9) all do. Two spenders with two change policies on one
 * account is how the 2026-08-22 incident happened; now there is one policy.
 * The balance side already walks the internal chain and its cheap path keeps
 * a lookahead window past the highest used index, so the change is visible on
 * the next refresh.
 */
export async function sendLtcFromAccount(
  mnemonic: string,
  to: string,
  amount: string,
  opts?: { feeRateOverride?: number; gapLimit?: number; fromAddress?: string },
): Promise<TxResult> {
  const spec = ltcUtxoAccounts[0]; // BIP-84; the legacy account has its own sweep
  const primaryAddress = modernLtcAddressFromMnemonic(mnemonic);
  // Belt and braces with `supportsAccountSend`. This function moves money; it
  // should not depend on a caller having asked the right question first.
  if (opts?.fromAddress && opts.fromAddress !== primaryAddress) {
    throw new Error(
      `${opts.fromAddress} is not this seed's BIP-84 index-0 address ` +
        `(${primaryAddress}). Account-wide send only covers the BIP-84 ` +
        "account; nothing was sent.",
    );
  }

  const sendSat = Math.round(parseFloat(amount) * 1e8);
  if (!Number.isFinite(sendSat) || sendSat <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  let feePerVB = opts?.feeRateOverride ?? 10;
  if (opts?.feeRateOverride === undefined) {
    try {
      feePerVB = await tryEach<number>([
        {
          name: "blockcypher",
          fn: async () => {
            const info = await proxyGetJson<BlockCypherChainInfo>(BLOCKCYPHER_BASE);
            const perKb = info.medium_fee_per_kb;
            if (!perKb || perKb <= 0) throw new Error("no blockcypher fee");
            return Math.max(Math.ceil(perKb / 1000), 1);
          },
        },
        {
          name: "litecoinspace",
          fn: async () => {
            const est = await proxyGetJson<Record<string, number>>(
              `${LITECOINSPACE_BASE}/fee-estimates`,
            );
            const v = est["6"] ?? est["3"] ?? est["1"];
            if (!v || v <= 0) throw new Error("no esplora fee");
            return Math.max(Math.ceil(v), 1);
          },
        },
      ]);
    } catch {
      /* keep the default */
    }
  }

  const { plan, sources, change } = await gatherAccountSpend({
    mnemonic,
    spec,
    sendSat,
    feePerVB,
    sizing: P2WPKH_SIZING,
    dustSat: LTC_DUST_SAT,
    gapLimit: opts?.gapLimit,
    fetchUtxos: async (address) =>
      (await fetchUtxos(address)).map((u) => ({
        txid: u.tx_hash,
        vout: u.tx_output_n,
        valueSat: u.value,
      })),
  });

  if (!plan.covered) {
    const held = plan.inputs.reduce((t, i) => t + i.valueSat, 0);
    throw new Error(accountShortfallMessage(plan, held, plan.inputs.length, "LTC"));
  }

  const psbt = new bitcoin.Psbt({ network: ltcNetwork });
  const keyPairs = new Map<string, ReturnType<typeof ECPair.fromPrivateKey>>();
  for (const input of plan.inputs) {
    let keyPair = keyPairs.get(input.address);
    if (!keyPair) {
      const src = sources.get(input.address);
      if (!src) throw new Error(`No signer for ${input.address}; nothing was sent.`);
      keyPair = ECPair.fromPrivateKey(Buffer.from(src.node.privateKey!), {
        network: ltcNetwork,
      });
      keyPairs.set(input.address, keyPair);
    }
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      witnessUtxo: {
        script: bitcoin.payments.p2wpkh({
          pubkey: Buffer.from(keyPair.publicKey),
          network: ltcNetwork,
        }).output!,
        value: BigInt(input.valueSat),
      },
    });
  }
  psbt.addOutput({ address: to, value: BigInt(sendSat) });
  if (plan.changeSat > 0) {
    psbt.addOutput({ address: change.address, value: BigInt(plan.changeSat) });
  }
  plan.inputs.forEach((input, i) => {
    const keyPair = keyPairs.get(input.address)!;
    psbt.signInput(i, {
      publicKey: Buffer.from(keyPair.publicKey),
      sign: (hash: Buffer) => Buffer.from(keyPair.sign(hash)),
    });
  });
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();

  const hash = await tryEach<string>([
    { name: "blockcypher", fn: () => broadcastBlockcypher(rawTx) },
    { name: "blockchair", fn: () => broadcastBlockchair(rawTx) },
    { name: "litecoinspace", fn: () => broadcastLitecoinspace(rawTx) },
  ]);
  return { hash };
}

export const ltcAdapter: ChainAdapter = {
  utxoAccounts: ltcUtxoAccounts,
  chain: "litecoin",
  displayName: "Litecoin",
  ticker: "LTC",
  color: "#345d9d",
  addressPlaceholder: "ltc1...",
  derivation: {
    kind: "bip39",
    path: "m/84'/2'/0'/0/0",
    standard: "BIP-84 with SLIP-44 coin type 2 — Electrum-LTC",
    hasAlternatives: true,
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const privKeyBytes = hexToBytes(privateKey);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes), {
      network: ltcNetwork,
    });
    const address = getAddress(keyPair.publicKey);
    return {
      chain: "litecoin",
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
      chain: "litecoin",
      address,
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(child.privateKey!),
    };
  },

  async getBalance(address: string): Promise<string> {
    const sat = await tryEach<number>([
      {
        name: "blockcypher",
        fn: async () => {
          const r = await proxyGetJson<BlockCypherBalance>(
            `${BLOCKCYPHER_BASE}/addrs/${address}/balance`
          );
          return (r.balance || 0) + (r.unconfirmed_balance || 0);
        },
      },
      {
        name: "blockchair",
        fn: async () => {
          const r = await proxyGetJson<{
            data: Record<string, { address: { balance: number } }>;
          }>(`${BLOCKCHAIR_BASE}/dashboards/address/${address}?limit=1`);
          // A missing key is "Blockchair did not answer for this address",
          // not "zero" (2026-08-22) — throw so tryEach rotates to the next
          // source instead of accepting a silent 0 as the final word.
          const b = r.data?.[address]?.address?.balance;
          if (typeof b !== "number") throw new Error("blockchair: address missing from response");
          return b;
        },
      },
      {
        name: "litecoinspace",
        fn: async () => {
          const r = await proxyGetJson<{
            chain_stats?: { funded_txo_sum: number; spent_txo_sum: number };
            mempool_stats?: { funded_txo_sum: number; spent_txo_sum: number };
          }>(`${LITECOINSPACE_BASE}/address/${address}`);
          const c = r.chain_stats;
          if (!c) throw new Error("no esplora chain_stats");
          const m = r.mempool_stats;
          return (
            c.funded_txo_sum -
            c.spent_txo_sum +
            ((m?.funded_txo_sum ?? 0) - (m?.spent_txo_sum ?? 0))
          );
        },
      },
    ]);
    return (sat / 1e8).toFixed(8);
  },

  /**
   * Build, sign, and broadcast an LTC transfer. Handles BOTH address types
   * the derivation picker can produce:
   *   - BIP-84 native SegWit (ltc1q…, P2WPKH) — the default; inputs carry a
   *     `witnessUtxo` (output script + value only).
   *   - BIP-44 legacy (L…, P2PKH) — what Exodus derives; inputs require the
   *     FULL previous transaction (`nonWitnessUtxo`), fetched per input.
   *
   * The adapter's send signature carries only the private key, not which
   * address the user spends from, so we detect it: probe the segwit address
   * first (the common case → one round-trip) and fall back to the legacy
   * address when segwit holds no UTXOs (an Exodus-derived wallet). The same
   * key signs either form; bitcoinjs-lib finalizes each input by its type.
   */
  /**
   * BIP-84 only. The legacy BIP-44 account is P2PKH — different witness
   * shape, different sizing, and its own migration
   * (`sweepLegacyLtcToModern`) — and BasicSwap only ever touched the
   * BIP-84 account, so legacy wallets never split in the first place.
   */
  supportsAccountSend(mnemonic: string, address: string) {
    return modernLtcAddressFromMnemonic(mnemonic) === address;
  },

  /** Account-wide send — see `sendLtcFromAccount`. `useSend` prefers this
   *  over `sendTransaction` whenever a mnemonic is available, because the
   *  single-key path cannot reach change addresses. */
  sendFromAccount(mnemonic: string, to: string, amount: string, fromAddress?: string) {
    return sendLtcFromAccount(mnemonic, to, amount, { fromAddress });
  },

  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    const privKeyBytes = hexToBytes(privateKey);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes), {
      network: ltcNetwork,
    });
    const segwitAddress = getAddress(keyPair.publicKey); // ltc1q… (P2WPKH)
    const legacyAddress = getLegacyAddress(keyPair.publicKey); // L… (P2PKH)

    // 1) Decide which address holds the spendable UTXOs. Default (segwit)
    //    first; legacy is the fallback for Exodus-derived wallets. Each probe
    //    is multi-source (BlockCypher → Blockchair → litecoinspace) so one
    //    provider's 429/outage can't block the send.
    let senderAddress = segwitAddress;
    let isLegacy = false;
    let utxos = await fetchUtxos(segwitAddress);
    if (utxos.length === 0) {
      const legacyUtxos = await fetchUtxos(legacyAddress);
      if (legacyUtxos.length > 0) {
        senderAddress = legacyAddress;
        isLegacy = true;
        utxos = legacyUtxos;
      }
    }
    if (utxos.length === 0) {
      throw new Error("No spendable UTXOs available for this address.");
    }

    // 2) Fee rate: live oracle (multi-source), fall back to a sane default.
    let feePerVB = 10;
    try {
      feePerVB = await tryEach<number>([
        {
          name: "blockcypher",
          fn: async () => {
            // BlockCypher returns satoshi/kB; convert to sat/vB.
            const info = await proxyGetJson<BlockCypherChainInfo>(BLOCKCYPHER_BASE);
            const perKb = info.medium_fee_per_kb;
            if (!perKb || perKb <= 0) throw new Error("no blockcypher fee");
            return Math.max(Math.ceil(perKb / 1000), 1);
          },
        },
        {
          name: "litecoinspace",
          fn: async () => {
            // Esplora /fee-estimates is a { "<target>": sat/vB } map.
            const est = await proxyGetJson<Record<string, number>>(
              `${LITECOINSPACE_BASE}/fee-estimates`
            );
            const v = est["6"] ?? est["3"] ?? est["1"];
            if (!v || v <= 0) throw new Error("no esplora fee");
            return Math.max(Math.ceil(v), 1);
          },
        },
      ]);
    } catch {
      /* keep default 10 sat/vB */
    }
    // P2PKH inputs are ~3× the size of a P2WPKH input's witness, so a legacy
    // 1-in/2-out tx is ~226 vB vs ~140 vB for segwit. Estimate before input
    // selection (the fee determines how many inputs to pull); LTC fees are
    // tiny so a small miss is harmless.
    const estimatedSizeVB = isLegacy ? 226 : 140;
    const feeSat = feePerVB * estimatedSizeVB;

    const sendSat = Math.round(parseFloat(amount) * 1e8);
    if (sendSat <= 0) throw new Error("Amount must be greater than zero.");

    // 3) Greedy input selection — decide the set BEFORE building the PSBT. A
    //    legacy build fetches a full raw tx per selected input, so we must not
    //    fetch for inputs we won't use.
    const selected: NormalizedLtcUtxo[] = [];
    let totalInput = 0;
    for (const u of utxos) {
      selected.push(u);
      totalInput += u.value;
      if (totalInput >= sendSat + feeSat) break;
    }
    if (totalInput < sendSat + feeSat) {
      throw new Error(
        `Insufficient funds. Have ${(totalInput / 1e8).toFixed(8)} LTC, need ${(
          (sendSat + feeSat) /
          1e8
        ).toFixed(8)} LTC (incl. ~${(feeSat / 1e8).toFixed(8)} fee).`
      );
    }

    // 4) Build PSBT inputs per address type.
    const psbt = new bitcoin.Psbt({ network: ltcNetwork });
    if (isLegacy) {
      // P2PKH: each input needs the FULL previous transaction (nonWitnessUtxo).
      for (const u of selected) {
        const rawHex = await fetchRawTxHex(u.tx_hash);
        psbt.addInput({
          hash: u.tx_hash,
          index: u.tx_output_n,
          nonWitnessUtxo: Buffer.from(rawHex, "hex"),
        });
      }
    } else {
      const witnessScript = bitcoin.payments.p2wpkh({
        pubkey: keyPair.publicKey,
        network: ltcNetwork,
      }).output!;
      for (const u of selected) {
        psbt.addInput({
          hash: u.tx_hash,
          index: u.tx_output_n,
          witnessUtxo: { script: witnessScript, value: BigInt(u.value) },
        });
      }
    }

    // 5) Outputs: recipient + change (above 546 sat dust) back to whichever
    //    address (segwit or legacy) we're spending from.
    psbt.addOutput({ address: to, value: BigInt(sendSat) });
    const change = totalInput - sendSat - feeSat;
    if (change > 546) {
      psbt.addOutput({ address: senderAddress, value: BigInt(change) });
    }

    // 6) Sign + finalize — signInput handles both P2PKH and P2WPKH inputs;
    //    finalizeAllInputs auto-detects the script type per input.
    for (let i = 0; i < psbt.inputCount; i++) {
      psbt.signInput(i, keyPair as any);
    }
    psbt.finalizeAllInputs();
    const rawTx = psbt.extractTransaction().toHex();

    // 7) Broadcast — multi-source. A signed tx must have more than one way
    //    out: if BlockCypher 429s/rejects, try Blockchair then litecoinspace
    //    before giving up.
    const hash = await tryEach<string>([
      { name: "blockcypher", fn: () => broadcastBlockcypher(rawTx) },
      { name: "blockchair", fn: () => broadcastBlockchair(rawTx) },
      { name: "litecoinspace", fn: () => broadcastLitecoinspace(rawTx) },
    ]);
    return { hash };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const info = await proxyGetJson<BlockCypherChainInfo>(BLOCKCYPHER_BASE);
      return {
        label: "Block",
        value: info.height?.toLocaleString() ?? "Mainnet",
        unit: "",
      };
    } catch {
      return { label: "Network", value: "Mainnet", unit: "" };
    }
  },

  /**
   * Tx history with BlockCypher → Blockchair failover.
   *
   * BlockCypher's `/full` endpoint is the richer single-call source
   * (inputs and outputs returned in one shot, no per-tx round trip)
   * but its keyless tier rate-limits aggressively (HTTP 429 "Limits
   * reached"). When that happens we fall back to the same DOGE/BCH
   * Blockchair pattern: dashboard → batched tx detail.
   *
   * Cursor scheme: `bc:<height>` for BlockCypher (the `before=` token),
   * `bk:<offset>` for Blockchair. A bare numeric cursor is treated as
   * BlockCypher legacy. On a fresh call without a cursor we always
   * try BlockCypher first; on its failure we silently move to Blockchair.
   */
  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    const cursor = opts?.cursor;

    // Cursor routing: if a previous page locked into a source, stay there.
    if (cursor?.startsWith("bk:")) {
      return fetchHistoryBlockchair(address, limit, Number(cursor.slice(3)));
    }
    if (cursor?.startsWith("bc:")) {
      return fetchHistoryBlockcypher(address, limit, cursor.slice(3));
    }

    // First page (no cursor) or legacy bare-number cursor → BlockCypher
    // first, Blockchair fallback. Don't propagate the BlockCypher error
    // up — silently fail over so a 429 is invisible to the user.
    try {
      return await fetchHistoryBlockcypher(address, limit, cursor);
    } catch {
      return await fetchHistoryBlockchair(address, limit, 0);
    }
  },

  /**
   * Fee tiers from BlockCypher. Returned as sat/vB to match what every
   * BTC-style fee UI in this app already speaks. Falls back to a static
   * 10 sat/vB when the oracle is down — same surface as the BTC adapter.
   */
  async getFeeEstimate(): Promise<FeeEstimate> {
    try {
      const info = await proxyGetJson<BlockCypherChainInfo>(BLOCKCYPHER_BASE);
      const high = info.high_fee_per_kb;
      const med = info.medium_fee_per_kb;
      const low = info.low_fee_per_kb;
      const toVB = (perKb: number | undefined) =>
        perKb && perKb > 0 ? Math.max(Math.ceil(perKb / 1000), 1) : 1;
      return {
        slow: { value: String(toVB(low)), eta: "~1 hr" },
        normal: { value: String(toVB(med)), eta: "~30 min" },
        fast: { value: String(toVB(high)), eta: "next block" },
        unit: "sat/vB",
        fetchedAt: Date.now(),
        raw: info,
      };
    } catch {
      return {
        normal: { value: "10" },
        unit: "sat/vB",
        fetchedAt: Date.now(),
      };
    }
  },
};
