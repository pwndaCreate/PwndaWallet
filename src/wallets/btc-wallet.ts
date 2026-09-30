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
  TxParties,
  FeeEstimate,
  SendOptions,
} from "./types";
import { proxyGetJson } from "./_proxy";
import { withFallback } from "./_fallback";
import { readUtxoParties, type UtxoPartiesSource } from "./parties-a-utxo";
import type { TxSizing, UtxoAccountSpec } from "./utxo-account";
import {
  gatherAccountSpend,
  accountShortfallMessage,
  planAccountSpend,
  utxoAccountSpecFor,
  P2WPKH_SIZING,
  P2SH_P2WPKH_SIZING,
  P2PKH_SIZING,
} from "./utxo-account";
import {
  acceptPushReply,
  assertNotDust,
  broadcastSignedTx,
  dustThresholdSat,
  DUST_RELAY_FEE_PER_KB,
  fetchTxLookup,
  outputKind,
  outputVBytes,
  parseSendAmountSat,
  recipientOutput,
  SEGWIT_CHAIN_OUTPUTS,
  type BroadcastEndpoint,
} from "./utxo-send";
import { esploraTxToChainTx, type EsploraTx } from "./esplora-history";
import { errorText } from "../lib/errorText";
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

/**
 * GET from the Esplora hosts in order; the first 2xx (or 404, which Esplora
 * uses for "unknown") wins. When every host fails, the error names each one
 * with its status and reply — it used to keep only the last, as
 * `HTTP 429 from https://mempool.space/api` with no body (2026-09-29
 * send-safety audit). Reads only: broadcasting goes through
 * `broadcastBtc`, which must never treat a lost reply as a failure.
 */
async function btcFetch(path: string, init?: RequestInit): Promise<Response> {
  const failures: string[] = [];
  for (const base of BTC_API_URLS) {
    const host = new URL(base).host;
    try {
      const resp = await fetch(`${base}${path}`, init);
      if (resp.ok || resp.status === 404) return resp;
      let body = "";
      try {
        body = (await resp.text()).replace(/\s+/g, " ").trim().slice(0, 160);
      } catch {
        /* status alone */
      }
      failures.push(`${host}: HTTP ${resp.status}${body ? ` ${body}` : ""}`);
    } catch (e) {
      failures.push(`${host}: ${errorText(e, "request failed")}`);
    }
  }
  throw new Error(`Every BTC explorer failed for ${path} — ${failures.join("; ")}`);
}

/**
 * The broadcast ladder: Esplora `POST /tx` on each host, the same signed bytes
 * to each. See `broadcastSignedTx` (utxo-send.ts) for what a failure means.
 */
const BTC_BROADCAST: BroadcastEndpoint[] = BTC_API_URLS.map((base) => ({
  name: new URL(base).host,
  async send(rawHex: string) {
    const resp = await fetch(`${base}/tx`, { method: "POST", body: rawHex });
    return acceptPushReply(resp.status, await resp.text(), (b) => b.trim());
  },
}));

/**
 * Where `getTransactionParties` reads a transaction: the history's Esplora
 * hosts, in its order, over `fetch` as the history reaches them.
 */
const BTC_PARTIES_SOURCES: UtxoPartiesSource[] = BTC_API_URLS.map((base) => ({
  kind: "esplora",
  base,
  via: "fetch",
}));

/** Esplora `GET /tx/:txid` — used only when every push errored. */
const BTC_LOOKUPS = BTC_API_URLS.map((base) =>
  fetchTxLookup(new URL(base).host, (txid) => `${base}/tx/${txid}`, (j) => j?.txid),
);

/** Broadcast a signed BTC transaction: once, with an honest outcome. */
function broadcastBtc(tx: bitcoin.Transaction): Promise<TxResult> {
  return broadcastSignedTx({
    ticker: "BTC",
    txid: tx.getId(),
    rawHex: tx.toHex(),
    endpoints: BTC_BROADCAST,
    lookups: BTC_LOOKUPS,
  });
}

/** Decode a BTC recipient, trimmed and with a `bitcoin:` URI cut to the address. */
function btcRecipient(to: string) {
  return recipientOutput(to, {
    network: bitcoin.networks.bitcoin,
    ticker: "BTC",
    uriSchemes: ["bitcoin"],
    allowed: SEGWIT_CHAIN_OUTPUTS,
  });
}

/**
 * The rate a BTC send signs with: the Send modal's tier when given, else the
 * Esplora 6-block estimate, else 10 sat/vB. Shared by both send paths — the
 * single-key one ignored the modal's tier until 2026-09-29.
 */
async function btcSendFeeRate(override?: number): Promise<number> {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.max(Math.ceil(override), 1);
  }
  try {
    const resp = await btcFetch(`/fee-estimates`);
    const est = await resp.json();
    return Math.max(Math.ceil(est["6"] ?? est["3"] ?? est["1"] ?? 10), 1);
  } catch {
    return 10;
  }
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

/**
 * The single-key script types a Bitcoin wallet here can hold coins under — one
 * per derivation the import picker (`derivation-detector.ts`) can select:
 * BIP-84 `bc1q…` (and the pre-2026-05-06 BIP-44-path quirk, also P2WPKH),
 * BIP-49 `3…` and BIP-44 `1…`.
 */
export type BtcScriptType = "p2wpkh" | "p2sh-p2wpkh" | "p2pkh";

/**
 * A public key as a BTC address of `scriptType`: the one encoder the account
 * specs and the single-key send share, building the same three payments as the
 * picker's `btcAddressForSpec`. `network` exists for the BIP-49 test vector,
 * which is published for testnet only.
 */
export function btcAddressFor(
  pubkey: Uint8Array,
  scriptType: BtcScriptType,
  network: bitcoin.Network = bitcoin.networks.bitcoin,
): string {
  const pk = Buffer.from(pubkey);
  if (scriptType === "p2wpkh") return bitcoin.payments.p2wpkh({ pubkey: pk, network }).address!;
  if (scriptType === "p2sh-p2wpkh") {
    return bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: pk, network }), network })
      .address!;
  }
  return bitcoin.payments.p2pkh({ pubkey: pk, network }).address!;
}

function getAddress(publicKey: Uint8Array): string {
  return btcAddressFor(publicKey, "p2wpkh");
}

/**
 * Transaction sizing per script type (`TxSizing`, utxo-account.ts). The planner
 * prices inputs and the change output with these, so a BIP-49 send is priced
 * at 91 vB an input and a BIP-44 one at 148 — not at native SegWit's 68, which
 * would underpay a legacy send by more than half.
 */
const BTC_SIZING: Record<BtcScriptType, TxSizing> = {
  p2wpkh: P2WPKH_SIZING,
  "p2sh-p2wpkh": P2SH_P2WPKH_SIZING,
  p2pkh: P2PKH_SIZING,
};

/** Unspent outputs at one address, from Esplora. Throws when no host answers. */
async function fetchBtcUtxos(
  address: string,
): Promise<Array<{ txid: string; vout: number; valueSat: number }>> {
  const resp = await btcFetch(`/address/${address}/utxo`);
  if (!resp.ok) throw new Error(`BTC utxo fetch HTTP ${resp.status}`);
  const list: Array<{ txid: string; vout: number; value: number }> = await resp.json();
  return list.map((u) => ({ txid: u.txid, vout: u.vout, valueSat: u.value }));
}

/**
 * The whole previous transaction a P2PKH input spends — its `nonWitnessUtxo`.
 *
 * Each Esplora host in turn; the first whose bytes hash to `txid` wins. A host
 * that serves anything else is passed over like one that is down: bitcoinjs
 * would refuse to sign against it anyway, and a legacy signature does not
 * commit to the amount, so the transaction the value is read from has to be
 * the right one. Every failure is named when all hosts fail.
 */
async function fetchBtcPrevTx(txid: string): Promise<bitcoin.Transaction> {
  const failures: string[] = [];
  for (const base of BTC_API_URLS) {
    const host = new URL(base).host;
    try {
      const resp = await fetch(`${base}/tx/${txid}/hex`);
      const body = (await resp.text()).trim();
      if (!resp.ok) {
        failures.push(`${host}: HTTP ${resp.status}`);
        continue;
      }
      const tx = bitcoin.Transaction.fromHex(body);
      if (tx.getId() !== txid.toLowerCase()) {
        failures.push(`${host}: served a different transaction`);
        continue;
      }
      return tx;
    } catch (e) {
      failures.push(`${host}: ${errorText(e, "request failed")}`);
    }
  }
  throw new Error(
    `Could not fetch transaction ${txid}, which a legacy (P2PKH) input spends — ` +
      `${failures.join("; ")}. Nothing was sent.`,
  );
}

/** One coin to spend: an outpoint, its value, and the address that holds it. */
type BtcCoin = { txid: string; vout: number; valueSat: number; address: string };

/** The previous transaction of every P2PKH coin in `coins`, one fetch per txid. */
async function prevTxsForLegacy(
  coins: ReadonlyArray<BtcCoin>,
): Promise<Map<string, bitcoin.Transaction>> {
  const out = new Map<string, bitcoin.Transaction>();
  for (const c of coins) {
    if (out.has(c.txid)) continue;
    const script = bitcoin.address.toOutputScript(c.address, bitcoin.networks.bitcoin);
    if (outputKind(script) !== "p2pkh") continue;
    out.set(c.txid, await fetchBtcPrevTx(c.txid));
  }
  return out;
}

/**
 * Add one coin to `psbt` with what ITS script type needs to be signed
 * (2026-09-29 send-safety audit):
 *
 *  - P2WPKH: `witnessUtxo`.
 *  - P2SH-P2WPKH: `witnessUtxo` (the P2SH output) and `redeemScript` (the
 *    P2WPKH program it wraps). Without the redeem script there is nothing to
 *    sign against — and the send path this replaces never produced one: it
 *    re-encoded every key as P2WPKH.
 *  - P2PKH: `nonWitnessUtxo`, the whole previous transaction, whose output must
 *    be this key's and carry exactly the value the explorer listed.
 *
 * The type is read from the address being spent, not assumed from the
 * account, so one transaction can mix types, and the key is checked against
 * the script before anything is signed.
 */
function addBtcInput(
  psbt: bitcoin.Psbt,
  coin: BtcCoin,
  pubkey: Uint8Array,
  prevTxs: ReadonlyMap<string, bitcoin.Transaction>,
): void {
  const network = bitcoin.networks.bitcoin;
  const pk = Buffer.from(pubkey);
  const script = bitcoin.address.toOutputScript(coin.address, network);
  const kind = outputKind(script);
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
  const refuse = (why: string) =>
    new Error(`Cannot spend ${coin.txid}:${coin.vout} at ${coin.address}: ${why}. Nothing was sent.`);

  if (kind === "p2wpkh") {
    const own = bitcoin.payments.p2wpkh({ pubkey: pk, network }).output!;
    if (!same(own, script)) throw refuse("the signing key does not own it");
    psbt.addInput({
      hash: coin.txid,
      index: coin.vout,
      witnessUtxo: { script: own, value: BigInt(coin.valueSat) },
    });
    return;
  }
  if (kind === "p2sh") {
    const redeem = bitcoin.payments.p2wpkh({ pubkey: pk, network });
    const own = bitcoin.payments.p2sh({ redeem, network }).output!;
    if (!same(own, script)) throw refuse("it is not the signing key's wrapped-SegWit (P2SH-P2WPKH) output");
    psbt.addInput({
      hash: coin.txid,
      index: coin.vout,
      witnessUtxo: { script: own, value: BigInt(coin.valueSat) },
      redeemScript: redeem.output!,
    });
    return;
  }
  if (kind === "p2pkh") {
    const own = bitcoin.payments.p2pkh({ pubkey: pk, network }).output!;
    if (!same(own, script)) throw refuse("the signing key does not own it");
    const prev = prevTxs.get(coin.txid);
    const out = prev?.outs[coin.vout];
    if (!prev || !out) throw refuse("the transaction that created it could not be read");
    if (!same(out.script, own)) throw refuse("the transaction that created it pays a different script");
    if (out.value !== BigInt(coin.valueSat)) {
      throw refuse(
        `the explorer listed ${coin.valueSat} sat, the transaction that created it says ${out.value}`,
      );
    }
    psbt.addInput({ hash: coin.txid, index: coin.vout, nonWitnessUtxo: prev.toBuffer() });
    return;
  }
  throw refuse(`${kind ?? "a non-standard"} output is not a type this wallet signs`);
}

/**
 * Where a lone private key's coins are, for the single-key send.
 *
 * A key alone does not say which script type it was used with, and the path
 * this replaces assumed native SegWit: a BIP-49 or BIP-44 key was re-encoded as
 * P2WPKH, found nothing, and the send failed "No UTXOs available" over a funded
 * wallet (2026-09-29 send-safety audit). The three encodings are asked in turn
 * — native SegWit first, the only one a private-key import displays, so that
 * case still costs one request — and the FIRST that holds coins is spent,
 * with the change returning to that same address. Encodings are not mixed: the
 * change needs one home, and it is the address the coins came from.
 */
const SINGLE_KEY_ORDER: readonly BtcScriptType[] = ["p2wpkh", "p2sh-p2wpkh", "p2pkh"];

async function btcKeyCoins(
  pubkey: Uint8Array,
): Promise<{ scriptType: BtcScriptType; address: string; coins: BtcCoin[] }> {
  const looked: string[] = [];
  for (const scriptType of SINGLE_KEY_ORDER) {
    const address = btcAddressFor(pubkey, scriptType);
    const utxos = await fetchBtcUtxos(address);
    if (utxos.length > 0) {
      return { scriptType, address, coins: utxos.map((u) => ({ ...u, address })) };
    }
    looked.push(address);
  }
  throw new Error(
    `No UTXOs available at this key's native SegWit, wrapped SegWit or legacy address ` +
      `(${looked.join(", ")}). Nothing was sent.`,
  );
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

/** A BTC account spec, with the script type its addresses (and change) use. */
export type BtcUtxoAccountSpec = UtxoAccountSpec & { scriptType: BtcScriptType };

function btcAccount(accountPath: string, label: string, scriptType: BtcScriptType): BtcUtxoAccountSpec {
  return {
    chain: "bitcoin",
    accountPath,
    label,
    scriptType,
    deriveAddress: (node) => btcAddressFor(node.publicKey!, scriptType),
    probe: probeBtcAddress,
    probeMany: probeBtcAddresses,
    batchSize: 50,
  };
}

/**
 * Every account a Bitcoin wallet here can be — one per derivation the import
 * picker (`derivation-detector.ts` `BTC_SPECS`) can select. The one the
 * dashboard scans and the Send button spends is whichever derives the
 * DISPLAYED address (`utxoAccountSpecFor`).
 *
 *  - BIP-84 native SegWit, the default. BTC has not been spent from by the
 *    swap engine yet, but it shares LTC's C8 arrangement, so the first BTC
 *    swap will put change on the internal chain exactly as LTC's did.
 *  - The BIP-44 PATH with SegWit ENCODING: `deriveLegacyKeyFromMnemonic`'s
 *    quirk from builds before 2026-05-06, kept so the scan looks where the app
 *    could actually have put funds rather than where the path name suggests.
 *  - BIP-49 wrapped SegWit (`3…`) and BIP-44 legacy (`1…`), added 2026-09-29
 *    (send-safety audit). Import auto-selects them when that is where a seed's
 *    coins are — older Electrum/BlueWallet, Bitcoin Core legacy, Atomic — and
 *    until these specs existed such a wallet read 0 on the dashboard (only the
 *    BIP-84 account was scanned) and could not send: the fallback re-encoded
 *    its key as P2WPKH and found no coins.
 *
 * Order matters in one respect: index 0 is the BIP-84 default — what a send
 * with no `fromAddress` spends, what the sandbox mocks fund, and the only
 * account whose pre-2026-09-29 scan records are still trusted (`recordIsFor`,
 * utxo-account-balance.ts). Keep it first.
 */
export const btcUtxoAccounts: BtcUtxoAccountSpec[] = [
  btcAccount("m/84'/0'/0'", "BIP-84 native SegWit", "p2wpkh"),
  btcAccount("m/44'/0'/0'", "BIP-44 path, SegWit encoding", "p2wpkh"),
  btcAccount("m/49'/0'/0'", "BIP-49 wrapped SegWit", "p2sh-p2wpkh"),
  btcAccount("m/44'/0'/0'", "BIP-44 legacy", "p2pkh"),
];

/** BTC standard relay dust, in sats. */
export const BTC_DUST_SAT = 546;

/**
 * Which of `btcUtxoAccounts` derives `address` at its index-0 receive slot?
 *
 * All four are spendable account-wide, each with its own script type, so this
 * only has to name the RIGHT one: spending the wrong account reports a false
 * shortfall over a funded wallet, the failure account-wide spending exists to
 * remove. Two share the path `m/44'/0'/0'` and differ only in encoding, which
 * is why the match is on the derived address and not on a path or a label.
 */
function btcAccountFor(mnemonic: string, address: string): BtcUtxoAccountSpec | null {
  return utxoAccountSpecFor(mnemonic, btcUtxoAccounts, address);
}

/**
 * Spend from the whole BTC account.
 *
 * See `sendLtcFromAccount` in `ltc-wallet.ts` for the full rationale and the
 * survey of how other wallets do this; the scan/derive/select half is shared
 * (`gatherAccountSpend`). What is Bitcoin-specific here: four candidate
 * accounts to choose between, three script types — each priced at its real
 * input size (`BTC_SIZING`) and signed with what its type needs (`addBtcInput`:
 * `redeemScript` for BIP-49, the previous transaction for BIP-44) — with the
 * change on the SAME account's internal chain, so it is the same type; and
 * Esplora broadcast.
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
  const matched = opts?.fromAddress ? btcAccountFor(mnemonic, opts.fromAddress) : null;
  if (opts?.fromAddress && !matched) {
    throw new Error(
      `${opts.fromAddress} is not an index-0 address of any account this seed ` +
        "derives. Nothing was sent.",
    );
  }
  const spec = matched ?? btcUtxoAccounts[0];

  // Amount and recipient are settled before anything touches the network
  // (2026-09-29 send-safety audit): `parseFloat` sent "1,5" as 1, and the
  // recipient output's real size feeds the fee.
  const sendSat = parseSendAmountSat(amount, "BTC");
  const recipient = btcRecipient(to);
  assertNotDust(sendSat, dustThresholdSat(recipient.script, DUST_RELAY_FEE_PER_KB.bitcoin), "BTC");

  const feePerVB = await btcSendFeeRate(opts?.feeRateOverride);

  // Change goes to the internal chain's lowest unused index (2026-09-04) —
  // the BIP-44 rule every surveyed wallet and the swap engine follow — not
  // back to the displayed address. See `nextChangeIndex` in utxo-account.ts.
  // It is derived by `spec`, so it has the account's own script type.
  const { plan, sources, change } = await gatherAccountSpend({
    mnemonic,
    spec,
    sendSat,
    feePerVB,
    sizing: BTC_SIZING[spec.scriptType],
    dustSat: BTC_DUST_SAT,
    recipientOutputVB: outputVBytes(recipient.script.length),
    gapLimit: opts?.gapLimit,
    fetchUtxos: fetchBtcUtxos,
  });

  if (!plan.covered) {
    const held = plan.inputs.reduce((t, i) => t + i.valueSat, 0);
    throw new Error(accountShortfallMessage(plan, held, plan.inputs.length, "BTC"));
  }

  // Everything the inputs need is fetched BEFORE anything is signed: a legacy
  // input's previous transaction that cannot be read stops the send here.
  const prevTxs = await prevTxsForLegacy(plan.inputs);

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
    addBtcInput(psbt, input, keyPair.publicKey, prevTxs);
  }
  psbt.addOutput({ script: recipient.script, value: BigInt(sendSat) });
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

  // Signed once; from here on only these bytes are ever sent.
  return broadcastBtc(psbt.extractTransaction());
}

export const btcAdapter: ChainAdapter = {
  /**
   * Every BTC account can be spent account-wide — `sendBtcFromAccount` picks
   * the one that derives the displayed address. False only for an address this
   * seed does not derive at index 0 of any of them. It used to be false for a
   * BIP-49 or BIP-44 wallet, which then fell to the single-key path and could
   * not send at all (2026-09-29 send-safety audit).
   */
  supportsAccountSend(mnemonic: string, address: string) {
    return btcAccountFor(mnemonic, address) !== null;
  },

  /** Account-wide send — see . */
  sendFromAccount(
    mnemonic: string,
    to: string,
    amount: string,
    fromAddress?: string,
    opts?: { feeRate?: number },
  ) {
    return sendBtcFromAccount(mnemonic, to, amount, { fromAddress, feeRateOverride: opts?.feeRate });
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

  /**
   * Single-key send — a private-key import, or any wallet `supportsAccountSend`
   * does not cover. Since 2026-09-29 (send-safety audit) it prices the
   * transaction it actually builds — the shared planner, the recipient's real
   * output size — at the Send modal's tier (`opts.feeRate`), where it used to
   * budget a fixed 140 vB at the oracle's rate whatever the tier and however
   * many inputs it spent (0.5 sat/vB measured for three inputs).
   *
   * And it spends the key's coins under the script type they are actually
   * held in (`btcKeyCoins`), priced and signed as that type. It used to
   * re-encode every key as native SegWit, so a BIP-49 or BIP-44 key found no
   * coins: "No UTXOs available" over a funded wallet, the same audit.
   */
  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string,
    _assetType?: string,
    opts?: SendOptions,
  ): Promise<TxResult> {
    const sendSat = parseSendAmountSat(amount, "BTC");
    const recipient = btcRecipient(to);
    assertNotDust(sendSat, dustThresholdSat(recipient.script, DUST_RELAY_FEE_PER_KB.bitcoin), "BTC");

    const privKeyBytes = hexToBytes(privateKey);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privKeyBytes));
    const held = await btcKeyCoins(keyPair.publicKey);

    const feePerVB = await btcSendFeeRate(opts?.feeRate);
    const plan = planAccountSpend({
      candidates: held.coins.map((c) => ({ ...c, path: `single key (${held.scriptType})` })),
      sendSat,
      feePerVB,
      sizing: BTC_SIZING[held.scriptType],
      dustSat: BTC_DUST_SAT,
      recipientOutputVB: outputVBytes(recipient.script.length),
    });
    if (!plan.covered) {
      const have = held.coins.reduce((t, c) => t + c.valueSat, 0);
      throw new Error(
        `Insufficient funds. Have ${(have / 1e8).toFixed(8)} BTC, need ` +
          `${((have + plan.shortfallSat) / 1e8).toFixed(8)} BTC (includes fee)`,
      );
    }

    const prevTxs = await prevTxsForLegacy(plan.inputs);
    const network = bitcoin.networks.bitcoin;
    const psbt = new bitcoin.Psbt({ network });
    for (const input of plan.inputs) addBtcInput(psbt, input, keyPair.publicKey, prevTxs);
    psbt.addOutput({ script: recipient.script, value: BigInt(sendSat) });
    if (plan.changeSat > 0) {
      // Back to the address the coins came from: the same script type.
      psbt.addOutput({ address: held.address, value: BigInt(plan.changeSat) });
    }
    for (let i = 0; i < psbt.inputCount; i++) {
      psbt.signInput(i, keyPair);
    }
    psbt.finalizeAllInputs();
    return broadcastBtc(psbt.extractTransaction());
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
    const txs: EsploraTx[] = await withFallback(BTC_API_URLS, async (base, signal) => {
      const r = await fetch(`${base}${path}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${base}`);
      return (await r.json()) as EsploraTx[];
    });

    // The shared Esplora mapper (2026-09-30), which LTC already used: the same
    // row this built inline, plus `meta.netSat` (the address's SIGNED net) and
    // every address the tx touches — what an account-wide history needs to net
    // a send against its own change (`utxo-account-history.ts`).
    const items: ChainTx[] = txs
      .slice(0, limit)
      .map((tx) => esploraTxToChainTx(tx, address, "bitcoin"));
    const cursor =
      items.length === limit && txs.length > 0 ? txs[txs.length - 1].txid : undefined;
    return { items, cursor };
  },

  /** Every input's and output's address, by txid (`parties-a-utxo.ts`). */
  async getTransactionParties(hash: string): Promise<TxParties | null> {
    return readUtxoParties("BTC", hash, BTC_PARTIES_SOURCES);
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
        // 1-in / 2-out P2WPKH (11 + 68 + 2×31) — lets the modal show a total.
        typicalTxVBytes: 141,
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
        typicalTxVBytes: 141,
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
  // The same broadcast as a send (2026-09-29 send-safety audit): a lost reply
  // is reported as "may have been sent", never as a failed sweep.
  return broadcastBtc(psbt.extractTransaction());
}
