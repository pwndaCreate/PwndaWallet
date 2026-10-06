/**
 * "Speed up" for an unconfirmed BTC transaction this wallet sent: a BIP125
 * replacement that spends the SAME coins, pays every recipient the SAME
 * amount, and takes the higher fee out of the wallet's change (operator
 * request, 2026-10-01).
 *
 * # Why
 *
 * A BTC deposit is signed at the fee rate estimated at that moment. If the
 * network gets busy, it can sit unconfirmed past the swap's deadline, and NEAR
 * then refunds it minus fees instead of swapping. Since 2026-10-01 every BTC
 * transaction the wallet builds signals replace-by-fee (`addBtcInput`,
 * btc-wallet.ts); this is what uses it. The rules a replacement must keep are
 * in `btc-rbf-policy.ts`.
 *
 * # What is read, and what is trusted
 *
 *  - `GET /tx/:txid` (Esplora, both hosts): confirmation status and each
 *    input's prevout (script and value).
 *  - `GET /tx/:txid/hex`: the transaction itself, kept only if its bytes hash
 *    to the txid. Inputs, sequences, outputs, version and locktime come from
 *    these bytes, never from the JSON; the JSON's outpoints must match them.
 *  - `GET /tx/:txid/outspends`: whether any output is already spent. One that
 *    is means a child transaction exists, and a replacement would evict —
 *    cancel — it, so the speed-up is refused. Fails closed: no answer, no
 *    speed-up.
 *  - A prevout's VALUE is checked by the signature for a SegWit input (BIP143
 *    commits to it, so a wrong value makes the replacement invalid), and for a
 *    legacy P2PKH input against the previous transaction itself
 *    (`prevTxsForLegacy` + `addBtcInput`), exactly as a send does.
 *
 * # What is signed
 *
 * Nothing whose inputs are not all the wallet's own: each input's address is
 * found among the wallet's own derivations (the four BTC accounts, receive
 * and change chains; or a private-key wallet's three encodings), and the key
 * is checked against the spent script again in `addBtcInput`. Nothing the
 * app did not build itself (`btc-own-txs.ts` explains why that matters: the
 * swap engine can spend the same keys). The replacement is signed once,
 * checked against the original and the replacement rules on its real size,
 * and pushed once through the same broadcast a send uses (`broadcastBtc`):
 * a lost reply is "may have been sent", never "failed".
 */
import * as bitcoin from "bitcoinjs-lib";
import * as tinysecp from "tiny-secp256k1";
import ECPairFactory from "ecpair";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import {
  addBtcInput,
  broadcastBtc,
  btcAddressFor,
  btcFetch,
  btcUtxoAccounts,
  BTC_API_URLS,
  BTC_DUST_SAT,
  prevTxsForLegacy,
  type BtcCoin,
  type BtcScriptType,
} from "./btc-wallet";
import { outputKind } from "./utxo-send";
import {
  BTC_RBF_SEQUENCE,
  planBtcFeeBump,
  replacementRuleViolation,
  signalsRbf,
  signedVsizeUpperBound,
} from "./btc-rbf-policy";
import { isOwnBtcTx } from "./btc-own-txs";
import { recordTxReplacement, txReplacementOf } from "./tx-replacements";
import { errorText } from "../lib/errorText";
import type { TxResult } from "./types";

bitcoin.initEccLib(tinysecp);
const ECPair = ECPairFactory(tinysecp);
const NETWORK = bitcoin.networks.bitcoin;
const TXID = /^[0-9a-f]{64}$/;

/** What signs: a recovery phrase (every account) or one private key. */
export type BtcWalletSecret = { mnemonic: string } | { privateKey: string };

/** Why a transaction cannot be sped up. Every code has a plain sentence. */
export type BtcSpeedUpRefusalCode =
  | "replaced"
  | "not-found"
  | "confirmed"
  | "not-rbf"
  | "not-own-tx"
  | "not-own-inputs"
  | "descendants"
  | "no-change"
  | "ambiguous-change"
  | "dust"
  | "busy";

/** A speed-up that is not possible, decided before anything was signed. */
export class BtcSpeedUpRefusal extends Error {
  readonly code: BtcSpeedUpRefusalCode;
  constructor(code: BtcSpeedUpRefusalCode, message: string) {
    super(message);
    this.name = "BtcSpeedUpRefusal";
    this.code = code;
  }
}

export function isBtcSpeedUpRefusal(e: unknown): e is BtcSpeedUpRefusal {
  return (
    e instanceof BtcSpeedUpRefusal ||
    (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "BtcSpeedUpRefusal")
  );
}

/** Everything the speed-up shows before it is confirmed. */
export interface BtcSpeedUpQuote {
  txid: string;
  originalFeeSat: number;
  originalVsize: number;
  /** What the original pays, sat/vB. */
  currentRate: number;
  /** The most the signed replacement can weigh; its fee is priced at this. */
  replacementVsize: number;
  minimumFeeSat: number;
  /** The least rate a replacement may pay, sat/vB. */
  minimumRate: number;
  /** The rate asked for (the network's fast tier), or null when none was. */
  targetRate: number | null;
  newFeeSat: number;
  newRate: number;
  extraFeeSat: number;
  /** The target was below the minimum (or absent): the minimum is paid. */
  atMinimum: boolean;
  /** The wallet's output the extra fee comes out of. */
  change: { vout: number; address: string; beforeSat: number; afterSat: number };
  /** Every other output, paid exactly as before. */
  recipients: Array<{ vout: number; address: string | null; valueSat: number }>;
}

// ── Reading the original ───────────────────────────────────────────────────

interface EsploraTxJson {
  txid?: string;
  vin?: Array<{
    txid?: string;
    vout?: number;
    prevout?: { scriptpubkey?: string; value?: number } | null;
  }>;
  fee?: number;
  status?: { confirmed?: boolean };
}

/** One transaction as a replacement needs it. */
export interface BtcTxOnChain {
  txid: string;
  tx: bitcoin.Transaction;
  /** Per input, in order: the output it spends. */
  prevouts: Array<{ script: Uint8Array; valueSat: number; address: string | null }>;
  confirmed: boolean;
  feeSat: number;
  vsize: number;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function txidOfInput(input: { hash: Uint8Array }): string {
  return Buffer.from(input.hash).reverse().toString("hex");
}

function addressOf(script: Uint8Array): string | null {
  try {
    return bitcoin.address.fromOutputScript(script, NETWORK);
  } catch {
    return null;
  }
}

function normTxid(txid: string): string {
  const t = String(txid ?? "").trim().toLowerCase();
  if (!TXID.test(t)) throw new Error(`${JSON.stringify(txid)} is not a transaction id.`);
  return t;
}

/**
 * GET `path` from each Esplora host until one answers. `missing` only when
 * EVERY host answered 404: one host not knowing a fresh transaction while the
 * other cannot be reached says nothing, so that throws.
 */
async function esploraText(path: string): Promise<{ body: string } | "missing"> {
  const failures: string[] = [];
  let missing = 0;
  for (const base of BTC_API_URLS) {
    const host = new URL(base).host;
    try {
      const resp = await fetch(`${base}${path}`);
      if (resp.status === 404) {
        missing++;
        continue;
      }
      const body = await resp.text();
      if (resp.ok) return { body };
      failures.push(`${host}: HTTP ${resp.status}`);
    } catch (e) {
      failures.push(`${host}: ${errorText(e, "request failed")}`);
    }
  }
  if (failures.length === 0 && missing > 0) return "missing";
  throw new Error(`Could not read ${path} — ${failures.join("; ")}`);
}

/** The raw transaction, from the first host whose bytes hash to `txid`. */
async function fetchRawBtcTx(txid: string): Promise<bitcoin.Transaction | null> {
  const failures: string[] = [];
  let missing = 0;
  for (const base of BTC_API_URLS) {
    const host = new URL(base).host;
    try {
      const resp = await fetch(`${base}/tx/${txid}/hex`);
      if (resp.status === 404) {
        missing++;
        continue;
      }
      const body = (await resp.text()).trim();
      if (!resp.ok) {
        failures.push(`${host}: HTTP ${resp.status}`);
        continue;
      }
      const tx = bitcoin.Transaction.fromHex(body);
      if (tx.getId() !== txid) {
        failures.push(`${host}: served a different transaction`);
        continue;
      }
      return tx;
    } catch (e) {
      failures.push(`${host}: ${errorText(e, "request failed")}`);
    }
  }
  if (failures.length === 0 && missing > 0) return null;
  throw new Error(`Could not read transaction ${txid} — ${failures.join("; ")}`);
}

/**
 * The transaction `txid` as the network has it, or null when no explorer
 * knows it (dropped, replaced, or never relayed). Throws when they could not
 * be asked, or when what they said does not hold together.
 */
export async function readBtcTx(txid: string): Promise<BtcTxOnChain | null> {
  const id = normTxid(txid);
  const meta = await esploraText(`/tx/${id}`);
  if (meta === "missing") return null;
  let json: EsploraTxJson;
  try {
    json = JSON.parse(meta.body) as EsploraTxJson;
  } catch {
    throw new Error(`The explorer's answer for ${id} is not JSON.`);
  }
  const tx = await fetchRawBtcTx(id);
  if (!tx) return null;

  const vin = Array.isArray(json.vin) ? json.vin : [];
  if (vin.length !== tx.ins.length) {
    throw new Error(`The explorer lists ${vin.length} inputs for ${id}; the transaction has ${tx.ins.length}.`);
  }
  const prevouts = tx.ins.map((input, i) => {
    const v = vin[i];
    const outpoint = txidOfInput(input);
    if (String(v?.txid ?? "").toLowerCase() !== outpoint || v?.vout !== input.index) {
      throw new Error(`The explorer's input ${i} of ${id} is not the transaction's own.`);
    }
    const p = v.prevout;
    if (!p || typeof p.scriptpubkey !== "string" || !Number.isSafeInteger(p.value) || (p.value ?? -1) < 0) {
      throw new Error(`The explorer does not say what input ${i} of ${id} spends.`);
    }
    const script = hexToBytes(p.scriptpubkey);
    return { script, valueSat: p.value as number, address: addressOf(script) };
  });
  const inSum = prevouts.reduce((s, p) => s + p.valueSat, 0);
  const outSum = tx.outs.reduce((s, o) => s + Number(o.value), 0);
  const feeSat = inSum - outSum;
  if (!Number.isSafeInteger(feeSat) || feeSat < 0) {
    throw new Error(`The inputs the explorer lists for ${id} do not cover its outputs.`);
  }
  if (typeof json.fee === "number" && json.fee !== feeSat) {
    throw new Error(`The explorer's fee for ${id} (${json.fee} sat) is not what its inputs and outputs add up to (${feeSat} sat).`);
  }
  return {
    txid: id,
    tx,
    prevouts,
    confirmed: json.status?.confirmed === true,
    feeSat,
    vsize: tx.virtualSize(),
  };
}

/** The outputs of `txid` that another transaction already spends. Throws when no explorer answers. */
async function readSpentOutputs(txid: string, outputs: number): Promise<Array<{ vout: number; by: string }>> {
  const r = await esploraText(`/tx/${txid}/outspends`);
  if (r === "missing") throw new Error(`No explorer says whether the outputs of ${txid} are spent.`);
  let list: unknown;
  try {
    list = JSON.parse(r.body);
  } catch {
    throw new Error(`The explorer's outspends for ${txid} are not JSON.`);
  }
  if (!Array.isArray(list) || list.length !== outputs) {
    throw new Error(`The explorer's outspends for ${txid} do not cover its ${outputs} outputs.`);
  }
  const spent: Array<{ vout: number; by: string }> = [];
  list.forEach((o, vout) => {
    const e = o as { spent?: unknown; txid?: unknown };
    if (e?.spent === true) spent.push({ vout, by: typeof e.txid === "string" ? e.txid : "another transaction" });
  });
  return spent;
}

// ── Whose keys ─────────────────────────────────────────────────────────────

/** One of the wallet's own addresses, with the key that signs for it. */
export interface OwnBtcKey {
  address: string;
  /** `m/84'/0'/0'/1/3`, or `single key (p2wpkh)` for a private-key wallet. */
  path: string;
  scriptType: BtcScriptType;
  /** 0 receive, 1 change; null for a private-key wallet. */
  chainIndex: 0 | 1 | null;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** The script type a wallet address of this shape would be, or null when the
 *  wallet never derives that shape (P2TR, P2WSH, anything not Bitcoin). */
export function btcScriptTypeOf(address: string): BtcScriptType | null {
  let script: Uint8Array;
  try {
    script = bitcoin.address.toOutputScript(address, NETWORK);
  } catch {
    return null;
  }
  const kind = outputKind(script);
  return kind === "p2wpkh" ? "p2wpkh" : kind === "p2sh" ? "p2sh-p2wpkh" : kind === "p2pkh" ? "p2pkh" : null;
}

/** Indices walked per chain of each account when looking for an address. */
export const OWN_KEY_SEARCH_DEPTH = 200;

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Which of `addresses` are the wallet's own, with their keys.
 *
 * A phrase: every BTC account (`btcUtxoAccounts`), receive and change chains,
 * from index 0 — the four the import picker can choose, so a transaction sent
 * from any of them is found. `known` (the account scan's recorded addresses)
 * is tried first; each is derived again here and kept only if it reproduces
 * the address. The walk goes `OWN_KEY_SEARCH_DEPTH` deep, or 100 past the
 * highest index `known` names, and only through accounts whose script type
 * matches an address still missing. A private key: its three encodings.
 */
export async function findOwnBtcKeys(
  secret: BtcWalletSecret,
  addresses: ReadonlyArray<string>,
  opts: { known?: ReadonlyArray<{ address: string; path: string }>; depth?: number } = {},
): Promise<Map<string, OwnBtcKey>> {
  const want = new Map<string, BtcScriptType>();
  for (const a of addresses) {
    const t = btcScriptTypeOf(a);
    if (t) want.set(a, t);
  }
  const found = new Map<string, OwnBtcKey>();
  if (want.size === 0) return found;

  if ("privateKey" in secret) {
    const key = ECPair.fromPrivateKey(Buffer.from(hexToBytes(secret.privateKey.replace(/^0x/, ""))));
    for (const scriptType of ["p2wpkh", "p2sh-p2wpkh", "p2pkh"] as const) {
      const address = btcAddressFor(key.publicKey, scriptType);
      if (want.get(address) === scriptType) {
        found.set(address, {
          address,
          path: `single key (${scriptType})`,
          scriptType,
          chainIndex: null,
          privateKey: Uint8Array.from(key.privateKey!),
          publicKey: Uint8Array.from(key.publicKey),
        });
      }
    }
    return found;
  }

  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(secret.mnemonic.trim(), ""));
  const take = (address: string, node: HDKey, path: string, scriptType: BtcScriptType, chainIndex: 0 | 1) => {
    if (!node.privateKey || !node.publicKey) return false;
    if (btcAddressFor(node.publicKey, scriptType) !== address) return false;
    found.set(address, {
      address,
      path,
      scriptType,
      chainIndex,
      privateKey: node.privateKey,
      publicKey: node.publicKey,
    });
    return true;
  };

  // 1. What the account scan recorded — re-derived, never taken on trust.
  let highest = -1;
  for (const k of opts.known ?? []) {
    const m = /^(m\/\d+'\/0'\/\d+')\/([01])\/(\d+)$/.exec(k.path);
    if (!m) continue;
    highest = Math.max(highest, Number(m[3]));
    const scriptType = want.get(k.address);
    if (!scriptType || found.has(k.address)) continue;
    try {
      take(k.address, root.derive(k.path), k.path, scriptType, Number(m[2]) as 0 | 1);
    } catch {
      /* a path that does not derive is not this address */
    }
  }

  // 2. Walk the accounts whose type an address still missing has.
  const depth = Math.max(opts.depth ?? OWN_KEY_SEARCH_DEPTH, highest >= 0 ? highest + 100 : 0);
  const missingOf = (t: BtcScriptType) => [...want].filter(([a, type]) => type === t && !found.has(a)).length;
  let derived = 0;
  for (const spec of btcUtxoAccounts) {
    let missing = missingOf(spec.scriptType);
    if (missing === 0) continue;
    const account = root.derive(spec.accountPath);
    for (const chainIndex of [0, 1] as const) {
      const chain = account.deriveChild(chainIndex);
      for (let i = 0; i < depth && missing > 0; i++) {
        const node = chain.deriveChild(i);
        const address = btcAddressFor(node.publicKey!, spec.scriptType);
        if (want.get(address) === spec.scriptType && !found.has(address)) {
          if (take(address, node, `${spec.accountPath}/${chainIndex}/${i}`, spec.scriptType, chainIndex)) missing--;
        }
        // ~0.2 ms a derivation: let the window paint between blocks.
        if (++derived % 64 === 0) await yieldToUi();
      }
    }
  }
  return found;
}

// ── Planning ───────────────────────────────────────────────────────────────

const btc = (sat: number) => (sat / 1e8).toFixed(8);

/**
 * Which output is the wallet's change. Only an output the wallet owns can
 * pay the higher fee; recipients are paid what they were paid.
 *
 *  - A single output is the payment: there is no change.
 *  - One output of the wallet's beside the payment(s) is the change, wherever
 *    it sits (a private-key wallet and the swap's single-address path return
 *    change to the address the coins came from).
 *  - Several of the wallet's (a payment to itself, plus change): the one on
 *    an account's CHANGE chain, if exactly one is. Otherwise it cannot be
 *    told which is the payment, and nothing is changed.
 */
function pickChange(
  outputs: ReadonlyArray<{ vout: number; address: string | null; valueSat: number }>,
  own: ReadonlyMap<string, OwnBtcKey>,
): { vout: number; address: string; valueSat: number } {
  const noChange = () =>
    new BtcSpeedUpRefusal(
      "no-change",
      "This transaction has no change output to take a higher fee from. Speeding it up would " +
        "need another of your coins added as an input, which this wallet does not do yet.",
    );
  if (outputs.length < 2) throw noChange();
  const mine = outputs.filter((o) => o.address !== null && own.has(o.address));
  if (mine.length === 0) throw noChange();
  // One of the wallet's beside at least one payment (there are 2+ outputs).
  if (mine.length === 1) {
    return { vout: mine[0].vout, address: mine[0].address!, valueSat: mine[0].valueSat };
  }
  const onChangeChain = mine.filter((o) => own.get(o.address!)!.chainIndex === 1);
  if (onChangeChain.length === 1) {
    const o = onChangeChain[0];
    return { vout: o.vout, address: o.address!, valueSat: o.valueSat };
  }
  throw new BtcSpeedUpRefusal(
    "ambiguous-change",
    "Every output of this transaction is one of your addresses, so it cannot be told which one " +
      "is the payment and which the change. Nothing was changed.",
  );
}

interface Prepared {
  view: BtcTxOnChain;
  keys: Map<string, OwnBtcKey>;
  quote: BtcSpeedUpQuote;
}

/** Read the original, check every condition, and price the replacement. */
async function prepare(args: {
  txid: string;
  secret: BtcWalletSecret;
  targetRate?: number | null;
  known?: ReadonlyArray<{ address: string; path: string }>;
}): Promise<Prepared> {
  // Replaced already this session: the replacement is the transaction to
  // speed up now. Replacing the original again would compete with it.
  const earlier = txReplacementOf("bitcoin", args.txid);
  if (earlier) {
    throw new BtcSpeedUpRefusal(
      "replaced",
      `It was replaced already, by ${earlier.by}. Open that transaction to speed it up again.`,
    );
  }
  const view = await readBtcTx(args.txid);
  if (!view) {
    throw new BtcSpeedUpRefusal(
      "not-found",
      "The network does not show this transaction: it may have been dropped, or replaced already.",
    );
  }
  if (view.confirmed) {
    throw new BtcSpeedUpRefusal("confirmed", "It is confirmed already: there is nothing to speed up.");
  }
  if (!signalsRbf(view.tx.ins.map((i) => i.sequence))) {
    throw new BtcSpeedUpRefusal(
      "not-rbf",
      "It was sent without replace-by-fee (every send before 2026-10-01 was), so it cannot be " +
        "re-sent with a higher fee. It confirms when a miner includes it.",
    );
  }
  if (!(await isOwnBtcTx(view.txid))) {
    throw new BtcSpeedUpRefusal(
      "not-own-tx",
      "This app did not send it, so it does not offer to replace it: the swap node can spend the " +
        "same keys, and replacing one of its transactions could break a swap.",
    );
  }
  const inputAddresses = view.prevouts.map((p) => p.address);
  const outputAddresses = view.tx.outs.map((o) => addressOf(o.script));
  const keys = await findOwnBtcKeys(
    args.secret,
    [...inputAddresses, ...outputAddresses].filter((a): a is string => a !== null),
    { known: args.known },
  );
  if (inputAddresses.some((a) => a === null || !keys.has(a))) {
    throw new BtcSpeedUpRefusal(
      "not-own-inputs",
      "Not every coin it spends is this wallet's, so the wallet cannot sign a replacement.",
    );
  }
  const spent = await readSpentOutputs(view.txid, view.tx.outs.length);
  if (spent.length > 0) {
    throw new BtcSpeedUpRefusal(
      "descendants",
      `Output ${spent[0].vout} of it is already spent by ${spent[0].by}. Replacing it would ` +
        "cancel that transaction too, so the wallet will not.",
    );
  }
  const outputs = view.tx.outs.map((o, vout) => ({
    vout,
    address: outputAddresses[vout],
    valueSat: Number(o.value),
  }));
  const change = pickChange(outputs, keys);
  const replacementVsize = signedVsizeUpperBound(
    inputAddresses.map((a) => keys.get(a!)!.scriptType),
    view.tx.outs.map((o) => o.script.length),
  );
  const targetRate =
    args.targetRate !== undefined && args.targetRate !== null && Number.isFinite(args.targetRate) && args.targetRate > 0
      ? args.targetRate
      : null;
  const r = planBtcFeeBump({
    originalFeeSat: view.feeSat,
    originalVsize: view.vsize,
    replacementVsize,
    changeValueSat: change.valueSat,
    targetRate,
    dustSat: BTC_DUST_SAT,
  });
  if (!r.ok) {
    throw new BtcSpeedUpRefusal(
      "dust",
      `Your change of ${btc(change.valueSat)} BTC cannot pay the extra ${btc(r.extraFeeSat)} BTC ` +
        `this needs and stay above the dust limit (${BTC_DUST_SAT} sat). Speeding it up would need ` +
        "another of your coins added as an input, which this wallet does not do yet.",
    );
  }
  const p = r.plan;
  return {
    view,
    keys,
    quote: {
      txid: view.txid,
      originalFeeSat: view.feeSat,
      originalVsize: view.vsize,
      currentRate: view.feeSat / view.vsize,
      replacementVsize,
      minimumFeeSat: p.minimumFeeSat,
      minimumRate: p.minimumFeeSat / replacementVsize,
      targetRate,
      newFeeSat: p.newFeeSat,
      newRate: p.newFeeSat / replacementVsize,
      extraFeeSat: p.extraFeeSat,
      atMinimum: p.atMinimum,
      change: { vout: change.vout, address: change.address, beforeSat: change.valueSat, afterSat: p.newChangeSat },
      recipients: outputs
        .filter((o) => o.vout !== change.vout)
        .map((o) => ({ vout: o.vout, address: o.address, valueSat: o.valueSat })),
    },
  };
}

/**
 * Can `txid` be sped up, and at what price? Reads only: nothing is signed.
 * Throws {@link BtcSpeedUpRefusal} with a plain reason when it cannot, and an
 * ordinary Error when the explorers could not be read.
 */
export async function quoteBtcSpeedUp(args: {
  txid: string;
  secret: BtcWalletSecret;
  /** sat/vB wanted — the network's fast tier. Never paid below the minimum. */
  targetRate?: number | null;
  known?: ReadonlyArray<{ address: string; path: string }>;
}): Promise<BtcSpeedUpQuote> {
  return (await prepare(args)).quote;
}

// ── Building, checking, sending ────────────────────────────────────────────

/** The replacement, signed once. */
async function buildReplacement(p: Prepared): Promise<bitcoin.Transaction> {
  const { view, keys, quote } = p;
  const coins: BtcCoin[] = view.tx.ins.map((input, i) => ({
    txid: txidOfInput(input),
    vout: input.index,
    valueSat: view.prevouts[i].valueSat,
    address: view.prevouts[i].address!,
  }));
  // A legacy input's previous transaction is fetched and checked BEFORE
  // anything is signed, as in a send.
  const prevTxs = await prevTxsForLegacy(coins);
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  psbt.setVersion(view.tx.version);
  psbt.setLocktime(view.tx.locktime);
  for (const coin of coins) addBtcInput(psbt, coin, keys.get(coin.address)!.publicKey, prevTxs);
  view.tx.outs.forEach((o, vout) => {
    psbt.addOutput({
      script: o.script,
      value: vout === quote.change.vout ? BigInt(quote.change.afterSat) : o.value,
    });
  });
  coins.forEach((coin, i) => {
    const key = keys.get(coin.address)!;
    const pair = ECPair.fromPrivateKey(Buffer.from(key.privateKey), { network: NETWORK });
    psbt.signInput(i, {
      publicKey: Buffer.from(pair.publicKey),
      sign: (hash: Buffer) => Buffer.from(pair.sign(hash)),
    });
  });
  psbt.finalizeAllInputs();
  return psbt.extractTransaction();
}

/**
 * Check the SIGNED replacement against the original before it goes anywhere:
 * the same inputs in the same order, all signalling; the same outputs with
 * only the change lower, by exactly the planned amount; the planned fee; a
 * size within the bound it was priced at; and the replacement rules on its
 * real size. Any difference stops it, unsent.
 */
export function assertReplacementOf(
  original: { tx: bitcoin.Transaction; feeSat: number; vsize: number },
  replacement: bitcoin.Transaction,
  quote: Pick<BtcSpeedUpQuote, "change" | "newFeeSat" | "replacementVsize">,
): void {
  const stop = (why: string) => new Error(`The replacement ${why}. Nothing was sent.`);
  const a = original.tx;
  if (replacement.ins.length !== a.ins.length) throw stop("does not spend the same inputs");
  replacement.ins.forEach((input, i) => {
    if (txidOfInput(input) !== txidOfInput(a.ins[i]) || input.index !== a.ins[i].index) {
      throw stop(`spends a different coin as input ${i}`);
    }
    if (input.sequence !== BTC_RBF_SEQUENCE) throw stop(`input ${i} does not signal replace-by-fee`);
  });
  if (replacement.outs.length !== a.outs.length) throw stop("does not have the same outputs");
  replacement.outs.forEach((o, vout) => {
    if (!Buffer.from(o.script).equals(Buffer.from(a.outs[vout].script))) throw stop(`pays output ${vout} to another script`);
    const want = vout === quote.change.vout ? BigInt(quote.change.afterSat) : a.outs[vout].value;
    if (o.value !== want) throw stop(`pays output ${vout} ${o.value} sat, not ${want}`);
  });
  const outSum = replacement.outs.reduce((s, o) => s + Number(o.value), 0);
  const originalOutSum = a.outs.reduce((s, o) => s + Number(o.value), 0);
  const feeSat = original.feeSat + (originalOutSum - outSum);
  if (feeSat !== quote.newFeeSat) throw stop(`pays ${feeSat} sat in fees, not the ${quote.newFeeSat} shown`);
  const vsize = replacement.virtualSize();
  if (vsize > quote.replacementVsize) throw stop(`is ${vsize} vB, more than the ${quote.replacementVsize} it was priced at`);
  const broken = replacementRuleViolation({
    originalFeeSat: original.feeSat,
    originalVsize: original.vsize,
    replacementFeeSat: feeSat,
    replacementVsize: vsize,
  });
  if (broken) throw stop(broken);
}

/** txids with a speed-up being signed or broadcast right now. */
const inFlight = new Set<string>();

/**
 * Speed `txid` up: re-read it, re-check everything `quoteBtcSpeedUp` checked,
 * build the replacement, sign it ONCE, check it, and broadcast it ONCE.
 *
 * `expectFeeSat` is the fee the user confirmed; a replacement that would pay
 * anything else is refused, unsent. On success the original is recorded as
 * replaced (`tx-replacements.ts`), so the history drops it.
 *
 * Throws {@link BtcSpeedUpRefusal} or an Error when nothing was sent, and
 * `SendOutcomeUnknownError` (from the broadcast) when the replacement may
 * have reached the network.
 */
export async function speedUpBtcTransaction(args: {
  txid: string;
  secret: BtcWalletSecret;
  targetRate?: number | null;
  known?: ReadonlyArray<{ address: string; path: string }>;
  expectFeeSat: number;
}): Promise<TxResult & { replaces: string }> {
  const id = normTxid(args.txid);
  if (inFlight.has(id)) {
    throw new BtcSpeedUpRefusal("busy", "This transaction is already being sped up.");
  }
  inFlight.add(id);
  try {
    const p = await prepare(args);
    if (p.quote.newFeeSat !== args.expectFeeSat) {
      throw new Error(
        `The speed-up's fee is now ${btc(p.quote.newFeeSat)} BTC, not the ${btc(args.expectFeeSat)} ` +
          "BTC shown. Review it again. Nothing was sent.",
      );
    }
    const tx = await buildReplacement(p);
    assertReplacementOf(p.view, tx, p.quote);
    // Signed once; from here on only these bytes are ever sent.
    const result = await broadcastBtc(tx);
    recordTxReplacement({ chain: "bitcoin", replaced: p.view.txid, by: result.hash });
    return { ...result, replaces: p.view.txid };
  } finally {
    inFlight.delete(id);
  }
}

/** Test seam. */
export const __testing = { prepare, buildReplacement, pickChange };
