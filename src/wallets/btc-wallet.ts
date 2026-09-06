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
import { withFallback } from "./_fallback";
import type { UtxoAccountSpec } from "./utxo-account";
import {
  gatherAccountSpend,
  accountShortfallMessage,
  P2WPKH_SIZING,
} from "./utxo-account";
import {
  parseEsploraStats,
  blockchairProbe,
  blockcypherProbe,
  haskoinProbeMany,
  type UtxoProbeResult,
} from "./_utxo-probes";

bitcoin.initEccLib(tinysecp);
const ECPair = ECPairFactory(tinysecp);

const BTC_API_URLS = [
  "https://blockstream.info/api",
  "https://mempool.space/api",
];

async function btcFetch(path: string, init?: RequestInit): Promise<Response> {
  let lastError: any;
  for (const base of BTC_API_URLS) {
    try {
      const resp = await fetch(`${base}${path}`, init);
      if (resp.ok || resp.status === 404) return resp;
      lastError = new Error(`HTTP ${resp.status} from ${base}`);
    } catch (e) {
      lastError = e;
      continue;
    }
  }
  throw lastError;
}

const BLOCKSTREAM_API = BTC_API_URLS[0];

// Standard BIP-84 native-SegWit (P2WPKH) derivation. Matches Exodus,
// Trust Wallet, Phantom, Ledger Live, Trezor Suite, and effectively
// every modern wallet that produces `bc1q…` addresses.
//
// Earlier PwndaWallet builds (≤ 2026-05-05) derived the key from the
// BIP-44 path m/44'/0'/0'/0/0 and then encoded the *result* as P2WPKH —
// a non-standard combination no other wallet produces. `deriveLegacy*`
// below preserves access to that path so users with funds at the old
// address can sweep them onto the standard one. See the migration
// helper at the bottom of this file.
const DERIVATION_PATH = "m/84'/0'/0'/0/0";
const LEGACY_DERIVATION_PATH = "m/44'/0'/0'/0/0";

function deriveAtPath(mnemonic: string, path: string) {
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  return root.derive(path);
}

function deriveKeyFromMnemonic(mnemonic: string) {
  return deriveAtPath(mnemonic, DERIVATION_PATH);
}

function deriveLegacyKeyFromMnemonic(mnemonic: string) {
  return deriveAtPath(mnemonic, LEGACY_DERIVATION_PATH);
}

function getAddress(publicKey: Uint8Array): string {
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(publicKey),
    network: bitcoin.networks.bitcoin,
  });
  return address!;
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

/**
 * Balance + "has any history" for one address, from the Esplora surface this
 * adapter already speaks. `used` is what the account walk keys on — see
 * `utxo-account.ts`.
 */
async function probeBtcAddress(address: string): Promise<UtxoProbeResult> {
  const resp = await btcFetch(`/address/${address}`);
  if (!resp.ok) throw new Error(`BTC address probe HTTP ${resp.status}`);
  return parseEsploraStats(await resp.json());
}

/**
 * haskoin-store's BTC deployments — the batch probe for the account walk
 * (2026-09-04). Esplora answers one address per request; a gap walk asks
 * about ~90 per refresh, and two public Esplora hosts are the only thing
 * between that and a rate limit. haskoin answers a block of 50 in one call
 * (100 measured live). On failure of both deployments the walk falls back
 * to `probeBtcAddress` per address, so this only ever removes requests.
 */
const HASKOIN_BTC_BASES = [
  "https://api.blockchain.info/haskoin-store/btc",
  "https://api.haskoin.com/btc",
] as const;

async function probeBtcAddresses(addresses: string[]): Promise<UtxoProbeResult[]> {
  let lastErr: unknown;
  for (const base of HASKOIN_BTC_BASES) {
    try {
      return await haskoinProbeMany(base, addresses);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * BTC has not yet been spent from by the swap engine, so its change chain is
 * still untouched — but it shares the identical C8 arrangement with LTC, so
 * the first BTC swap will put change on the internal chain exactly as LTC's
 * did. Listing the account now means that day is a non-event.
 *
 * The second entry mirrors this adapter's own `deriveLegacyKeyFromMnemonic`,
 * which derives at the BIP-44 PATH but still encodes P2WPKH — a quirk of this
 * codebase, reproduced here deliberately so the scan looks where the app can
 * actually put funds rather than where the path name suggests.
 */
export const btcUtxoAccounts: UtxoAccountSpec[] = [
  {
    chain: "bitcoin",
    accountPath: "m/84'/0'/0'",
    label: "BIP-84 native SegWit",
    deriveAddress: (node) => getAddress(node.publicKey!),
    probe: probeBtcAddress,
    probeMany: probeBtcAddresses,
    batchSize: 50,
  },
  {
    chain: "bitcoin",
    accountPath: "m/44'/0'/0'",
    label: "BIP-44 path, SegWit encoding",
    deriveAddress: (node) => getAddress(node.publicKey!),
    probe: probeBtcAddress,
    probeMany: probeBtcAddresses,
    batchSize: 50,
  },
];

/** BTC standard relay dust, in sats. */
export const BTC_DUST_SAT = 546;

/**
 * Which of `btcUtxoAccounts` derives `address` at its index-0 receive slot?
 *
 * BTC differs from LTC here: **both** its accounts encode as native SegWit
 * (`getAddress` is p2wpkh for both specs — the BIP-44 entry is a non-standard
 * path with SegWit encoding, not a legacy P2PKH account). So unlike LTC, where
 * account-wide sending has to refuse the legacy account outright, BTC can serve
 * either — it only has to spend the RIGHT one. Picking the wrong account would
 * report a false shortfall over a funded wallet, which is the same failure
 * account-wide spending exists to remove.
 */
function btcAccountFor(mnemonic: string, address: string): UtxoAccountSpec | null {
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  for (const spec of btcUtxoAccounts) {
    const node = root.derive(spec.accountPath).deriveChild(0).deriveChild(0);
    if (node.publicKey && spec.deriveAddress(node) === address) return spec;
  }
  return null;
}

/**
 * Spend from the whole BTC account.
 *
 * See `sendLtcFromAccount` in `ltc-wallet.ts` for the full rationale and the
 * survey of how other wallets do this; the scan/derive/select half is shared
 * (`gatherAccountSpend`). What is Bitcoin-specific here: two candidate
 * accounts to choose between, P2WPKH `witnessUtxo` inputs, and Esplora
 * broadcast.
 *
 * **BTC is not a hypothetical.** It is one of exactly two coins BasicSwap can
 * adopt via C8 account-key sharing (`ELECTRUM_CAPABLE` = bitcoin, litecoin) and
 * one of five it can adopt via C3.5 descriptor import. Once adopted, the engine
 * spends the user's outputs and puts change at indices of its own choosing —
 * precisely what happened to LTC on 2026-08-22. BTC has not split yet only
 * because it has not been swapped yet.
 */
export async function sendBtcFromAccount(
  mnemonic: string,
  to: string,
  amount: string,
  opts?: { feeRateOverride?: number; gapLimit?: number; fromAddress?: string },
): Promise<TxResult> {
  const spec =
    (opts?.fromAddress ? btcAccountFor(mnemonic, opts.fromAddress) : null) ??
    btcUtxoAccounts[0];
  if (opts?.fromAddress && !btcAccountFor(mnemonic, opts.fromAddress)) {
    throw new Error(
      `${opts.fromAddress} is not an index-0 address of any account this seed ` +
        "derives. Nothing was sent.",
    );
  }

  const sendSat = Math.round(parseFloat(amount) * 1e8);
  if (!Number.isFinite(sendSat) || sendSat <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  let feePerVB = opts?.feeRateOverride;
  if (feePerVB === undefined) {
    try {
      const resp = await btcFetch(`/fee-estimates`);
      const est = await resp.json();
      feePerVB = Math.max(Math.ceil(est["6"] ?? est["3"] ?? est["1"] ?? 10), 1);
    } catch {
      feePerVB = 10;
    }
  }

  // Change goes to the internal chain's lowest unused index (2026-09-04) —
  // the BIP-44 rule every surveyed wallet and the swap engine follow — not
  // back to the displayed address. See `nextChangeIndex` in utxo-account.ts.
  const { plan, sources, change } = await gatherAccountSpend({
    mnemonic,
    spec,
    sendSat,
    feePerVB,
    sizing: P2WPKH_SIZING,
    dustSat: BTC_DUST_SAT,
    gapLimit: opts?.gapLimit,
    fetchUtxos: async (address) => {
      const resp = await btcFetch(`/address/${address}/utxo`);
      if (!resp.ok) throw new Error(`BTC utxo fetch HTTP ${resp.status}`);
      const list: Array<{ txid: string; vout: number; value: number }> =
        await resp.json();
      return list.map((u) => ({ txid: u.txid, vout: u.vout, valueSat: u.value }));
    },
  });

  if (!plan.covered) {
    const held = plan.inputs.reduce((t, i) => t + i.valueSat, 0);
    throw new Error(accountShortfallMessage(plan, held, plan.inputs.length, "BTC"));
  }

  const network = bitcoin.networks.bitcoin;
  const psbt = new bitcoin.Psbt({ network });
  const keyPairs = new Map<string, ReturnType<typeof ECPair.fromPrivateKey>>();
  for (const input of plan.inputs) {
    let keyPair = keyPairs.get(input.address);
    if (!keyPair) {
      const src = sources.get(input.address);
      if (!src) throw new Error(`No signer for ${input.address}; nothing was sent.`);
      keyPair = ECPair.fromPrivateKey(Buffer.from(src.node.privateKey!), { network });
      keyPairs.set(input.address, keyPair);
    }
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      witnessUtxo: {
        script: bitcoin.payments.p2wpkh({
          pubkey: Buffer.from(keyPair.publicKey),
          network,
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

  const resp = await btcFetch(`/tx`, { method: "POST", body: rawTx });
  if (!resp.ok) {
    throw new Error(`Broadcast failed: ${await resp.text()}`);
  }
  return { hash: (await resp.text()).trim() };
}

export const btcAdapter: ChainAdapter = {
  /**
   * Both BTC accounts encode as native SegWit, so either can be spent
   * account-wide —  picks the matching one. Returns
   * false only for an address this seed does not derive at index 0.
   */
  supportsAccountSend(mnemonic: string, address: string) {
    return btcAccountFor(mnemonic, address) !== null;
  },

  /** Account-wide send — see . */
  sendFromAccount(mnemonic: string, to: string, amount: string, fromAddress?: string) {
    return sendBtcFromAccount(mnemonic, to, amount, { fromAddress });
  },
  utxoAccounts: btcUtxoAccounts,
  chain: "bitcoin",
  displayName: "Bitcoin",
  ticker: "BTC",
  color: "#f7931a",
  addressPlaceholder: "bc1...",
  derivation: {
    kind: "bip39",
    path: "m/84'/0'/0'/0/0",
    standard: "BIP-84 native SegWit — Sparrow, Electrum, Trezor, Ledger",
    hasAlternatives: true,
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const privKeyBytes = hexToBytes(privateKey);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes));
    const address = getAddress(keyPair.publicKey);
    return {
      chain: "bitcoin",
      address,
      mnemonic: "",
      privateKey: bytesToHex(privKeyBytes),
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const child = deriveKeyFromMnemonic(mnemonic);
    const address = getAddress(child.publicKey!);
    return {
      chain: "bitcoin",
      address,
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(child.privateKey!),
    };
  },

  async getBalance(address: string): Promise<string> {
    const resp = await btcFetch(`/address/${address}`);
    if (!resp.ok) throw new Error("Failed to fetch BTC balance");
    const data = await resp.json();
    const funded = data.chain_stats.funded_txo_sum || 0;
    const spent = data.chain_stats.spent_txo_sum || 0;
    const mempoolFunded = data.mempool_stats.funded_txo_sum || 0;
    const mempoolSpent = data.mempool_stats.spent_txo_sum || 0;
    const satoshis = funded - spent + mempoolFunded - mempoolSpent;
    return (satoshis / 1e8).toFixed(8);
  },

  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    const privKeyBytes = hexToBytes(privateKey);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes));
    const senderAddress = getAddress(keyPair.publicKey);

    // Fetch UTXOs
    const utxoResp = await btcFetch(`/address/${senderAddress}/utxo`);
    if (!utxoResp.ok) throw new Error("Failed to fetch UTXOs");
    const utxos: any[] = await utxoResp.json();

    if (utxos.length === 0) throw new Error("No UTXOs available");

    // Fetch fee rate
    const feeResp = await btcFetch(`/fee-estimates`);
    const feeEstimates = await feeResp.json();
    const feeRate = Math.ceil(feeEstimates["6"] || 10); // sat/vB, target 6 blocks

    const satoshisToSend = Math.round(parseFloat(amount) * 1e8);
    const estimatedSize = 140; // rough estimate for 1-in 2-out segwit tx
    const fee = feeRate * estimatedSize;

    // Select UTXOs
    let totalInput = 0;
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

    for (const utxo of utxos) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: bitcoin.payments.p2wpkh({
            pubkey: keyPair.publicKey,
            network: bitcoin.networks.bitcoin,
          }).output!,
          value: BigInt(utxo.value),
        },
      });
      totalInput += utxo.value;
      if (totalInput >= satoshisToSend + fee) break;
    }

    if (totalInput < satoshisToSend + fee) {
      throw new Error(
        `Insufficient funds. Have ${(totalInput / 1e8).toFixed(8)} BTC, need ${((satoshisToSend + fee) / 1e8).toFixed(8)} BTC (includes fee)`
      );
    }

    // Output: recipient
    psbt.addOutput({ address: to, value: BigInt(satoshisToSend) });

    // Change output
    const change = totalInput - satoshisToSend - fee;
    if (change > 546) {
      psbt.addOutput({ address: senderAddress, value: BigInt(change) });
    }

    // Sign all inputs
    for (let i = 0; i < psbt.inputCount; i++) {
      psbt.signInput(i, keyPair);
    }

    psbt.finalizeAllInputs();
    const rawTx = psbt.extractTransaction().toHex();

    // Broadcast
    const broadcastResp = await btcFetch(`/tx`, {
      method: "POST",
      body: rawTx,
    });

    if (!broadcastResp.ok) {
      const errText = await broadcastResp.text();
      throw new Error(`Broadcast failed: ${errText}`);
    }

    const txid = await broadcastResp.text();
    return { hash: txid };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const resp = await btcFetch(`/fee-estimates`);
      const data = await resp.json();
      const feeRate = data["6"] ? parseFloat(data["6"]).toFixed(1) : "N/A";
      return { label: "Fee Rate", value: feeRate, unit: "sat/vB" };
    } catch {
      return { label: "Fee Rate", value: "N/A", unit: "sat/vB" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    // Esplora returns the latest 25 confirmed + all mempool by default.
    // To page further back, the cursor is the txid of the oldest entry
    // returned and `/txs/chain/{txid}` continues from there.
    const path = opts?.cursor
      ? `/address/${address}/txs/chain/${opts.cursor}`
      : `/address/${address}/txs`;
    const txs: any[] = await withFallback(BTC_API_URLS, async (base, signal) => {
      const r = await fetch(`${base}${path}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${base}`);
      return (await r.json()) as any[];
    });

    const items: ChainTx[] = txs.slice(0, limit).map((tx) => {
      // Determine direction by comparing sums of inputs vs outputs touching us.
      let outFromMe = 0;
      for (const vin of tx.vin ?? []) {
        if (vin.prevout?.scriptpubkey_address === address) {
          outFromMe += vin.prevout.value || 0;
        }
      }
      let inToMe = 0;
      let firstExternalOut: string | undefined;
      for (const vout of tx.vout ?? []) {
        if (vout.scriptpubkey_address === address) {
          inToMe += vout.value || 0;
        } else if (!firstExternalOut && vout.scriptpubkey_address) {
          firstExternalOut = vout.scriptpubkey_address;
        }
      }
      const net = inToMe - outFromMe;
      const direction: ChainTx["direction"] =
        net > 0 ? "in" : net < 0 ? "out" : "self";
      const absSat = Math.abs(net);
      const amount = (absSat / 1e8).toFixed(8);
      const fee = tx.fee !== undefined ? (tx.fee / 1e8).toFixed(8) : undefined;
      const confirmed = tx.status?.confirmed ?? false;
      return {
        chain: "bitcoin",
        hash: tx.txid,
        direction: confirmed ? direction : "pending",
        amount,
        fee: direction === "out" ? fee : undefined,
        timestamp: tx.status?.block_time ?? undefined,
        confirmations: confirmed ? undefined : 0,
        height: tx.status?.block_height ?? undefined,
        counterparty: direction === "out" ? firstExternalOut : undefined,
        meta: { vin_count: tx.vin?.length, vout_count: tx.vout?.length },
      };
    });
    const cursor =
      items.length === limit && txs.length > 0 ? txs[txs.length - 1].txid : undefined;
    return { items, cursor };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // mempool.space gives us slow/normal/fast in one call. Blockstream's
    // `/fee-estimates` returns block-target buckets we can map onto the
    // same tiers as a fallback.
    try {
      const r = await proxyGetJson<{
        fastestFee: number;
        halfHourFee: number;
        hourFee: number;
        economyFee: number;
        minimumFee: number;
      }>("https://mempool.space/api/v1/fees/recommended");
      return {
        slow: { value: String(r.hourFee), eta: "~1 hr" },
        normal: { value: String(r.halfHourFee), eta: "~30 min" },
        fast: { value: String(r.fastestFee), eta: "next block" },
        unit: "sat/vB",
        fetchedAt: Date.now(),
        raw: r,
      };
    } catch {
      const r = await proxyGetJson<Record<string, number>>(
        "https://blockstream.info/api/fee-estimates"
      );
      const get = (k: string) => (r[k] ? Number(r[k].toFixed(1)) : undefined);
      const fast = get("1") ?? get("2") ?? 1;
      const normal = get("6") ?? get("3") ?? fast;
      const slow = get("144") ?? get("36") ?? normal;
      return {
        slow: { value: String(slow), eta: "~1 day" },
        normal: { value: String(normal), eta: "~1 hr" },
        fast: { value: String(fast), eta: "next block" },
        unit: "sat/vB",
        fetchedAt: Date.now(),
        raw: r,
      };
    }
  },
};

/**
 * Derive the legacy `bc1q…` address that pre-2026-05-06 PwndaWallet
 * builds produced from this mnemonic. Used by the WalletDetailsCard
 * "Legacy BTC address" panel to surface any funds stranded at the old
 * non-standard derivation (BIP-44 path encoded as P2WPKH). Returns the
 * full WalletInfo so callers can fetch balance / sweep.
 */
export function deriveLegacyBtcFromMnemonic(mnemonic: string): WalletInfo {
  const child = deriveLegacyKeyFromMnemonic(mnemonic);
  const address = getAddress(child.publicKey!);
  return {
    chain: "bitcoin",
    address,
    mnemonic: mnemonic.trim(),
    privateKey: bytesToHex(child.privateKey!),
  };
}

/**
 * Test whether the legacy address has any on-chain balance. Returns
 * the satoshi amount (not BTC). Used to decide whether to surface the
 * "Legacy BTC address" sweep UI at all — most users won't have funds
 * at the old derivation.
 */
export async function getLegacyBtcBalanceSats(legacyAddress: string): Promise<number> {
  const resp = await btcFetch(`/address/${legacyAddress}`);
  if (!resp.ok) return 0;
  const data = await resp.json();
  const funded = data.chain_stats.funded_txo_sum || 0;
  const spent = data.chain_stats.spent_txo_sum || 0;
  const mempoolFunded = data.mempool_stats.funded_txo_sum || 0;
  const mempoolSpent = data.mempool_stats.spent_txo_sum || 0;
  return funded - spent + mempoolFunded - mempoolSpent;
}

/**
 * Send the entire balance of the legacy-derivation address to the
 * standard BIP-84 address (or any other address). Single-tx sweep.
 * Computes fee against the actual UTXO count, leaves nothing at the
 * old address. Throws if the balance is too low to cover dust + fee.
 */
export async function sweepLegacyBtcToAddress(
  legacyPrivateKey: string,
  destinationAddress: string,
  feeRateOverride?: number
): Promise<TxResult> {
  const privKeyBytes = hexToBytes(legacyPrivateKey);
  const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes));
  const sourceAddress = getAddress(keyPair.publicKey);

  const utxoResp = await btcFetch(`/address/${sourceAddress}/utxo`);
  if (!utxoResp.ok) throw new Error("Failed to fetch UTXOs for legacy address");
  const utxos: any[] = await utxoResp.json();
  if (utxos.length === 0) throw new Error("Legacy address has no UTXOs to sweep");

  let feeRate = feeRateOverride;
  if (feeRate === undefined) {
    const feeResp = await btcFetch(`/fee-estimates`);
    const feeEstimates = await feeResp.json();
    feeRate = Math.ceil(feeEstimates["6"] || 10);
  }

  const totalInput = utxos.reduce((acc, u) => acc + u.value, 0);
  // SegWit single-output sweep: ~10 base + 68×inputs witness + 31 vbytes
  // for the P2WPKH output. +20 cushions partial-input edge cases.
  const estimatedSize = 10 + 68 * utxos.length + 31 + 20;
  const fee = feeRate * estimatedSize;
  const sendAmount = totalInput - fee;
  if (sendAmount < 546) {
    throw new Error(
      `Legacy balance ${(totalInput / 1e8).toFixed(8)} BTC is below the dust+fee threshold (${(fee / 1e8).toFixed(8)} BTC). Nothing to sweep.`
    );
  }

  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
  for (const utxo of utxos) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: bitcoin.payments.p2wpkh({
          pubkey: keyPair.publicKey,
          network: bitcoin.networks.bitcoin,
        }).output!,
        value: BigInt(utxo.value),
      },
    });
  }
  psbt.addOutput({ address: destinationAddress, value: BigInt(sendAmount) });
  for (let i = 0; i < psbt.inputCount; i++) {
    psbt.signInput(i, keyPair);
  }
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();
  const broadcastResp = await btcFetch(`/tx`, { method: "POST", body: rawTx });
  if (!broadcastResp.ok) {
    const errText = await broadcastResp.text();
    throw new Error(`Sweep broadcast failed: ${errText}`);
  }
  const txid = await broadcastResp.text();
  return { hash: txid };
}
