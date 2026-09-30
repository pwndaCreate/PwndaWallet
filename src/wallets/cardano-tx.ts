/**
 * Cardano transaction construction + signing for ADA-only sends.
 *
 * What this implements:
 *   - UTXO selection (largest-first, adding inputs until the payment, the
 *     exact fee and a change output fit — see `planTransfer`).
 *   - Tx body CBOR encoding (Conway/Babbage era, Mary-compatible: no
 *     scripts, no native assets).
 *   - Fee calculation: `min_fee_a * tx_size + min_fee_b` from Koios
 *     epoch params, with iterative recompute (the body size depends on
 *     the fee field's encoded length, which depends on the fee value).
 *   - BIP-32-Ed25519 signing of the tx body hash (blake2b-256).
 *   - Final tx assembly: `[body, witnessSet, true, null]`.
 *   - Address bytes decoded from bech32 (`addr1…`), and a recipient check
 *     that refuses what an ADA payment must not go to (`recipientAddressBytes`).
 *
 * What this does NOT implement (out of scope — would 5x the surface):
 *   - Native-asset / NFT sends (multi-asset value).
 *   - Plutus / native-script witnesses.
 *   - Stake-key registration / delegation.
 *   - Pool registration.
 *   - Multi-output payments.
 *
 * Spec references:
 *   - CIP-1852 (key derivation)
 *   - CIP-19 (address format)
 *   - https://github.com/IntersectMBO/cardano-ledger/blob/master/eras/conway/impl/cddl-files/conway.cddl
 *
 * Test cross-check: `import "<mnemonic>" into Eternl, send the same
 * amount, compare tx hashes. The tx body bytes are deterministic for a
 * given UTXO set + fee + ttl, so any drift in fields, tags, or canonical
 * form will produce a different hash that Koios rejects.
 */

import { blake2b } from "@noble/hashes/blake2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bech32 } from "@scure/base";
import {
  arrayCbor,
  bytesCbor,
  encodeCbor,
  hexToBytes,
  mapCbor,
  nullCbor,
  uintCbor,
  boolCbor,
  type CborValue,
} from "./cardano-cbor";
import {
  signBip32Ed25519,
  paymentExtendedKey,
} from "./cardano-cip1852";
import {
  getAddressUtxos,
  getCurrentTipSlot,
  getEpochParams,
  submitTx,
  type KoiosUtxo,
} from "./cardano-koios";
import { decimalToAtomic } from "./decimal-amount";

/** Min lovelace per UTXO under the current `coins_per_utxo_size` rules.
 *  Babbage-era effective minimum for a simple ADA-only output is ~1 ADA
 *  (1_000_000 lovelace). We use 1_000_000 as a conservative floor; Koios
 *  surfaces the exact value per epoch but the constant is stable. */
const MIN_UTXO_VALUE = 1_000_000n;

/** Slots in the future to set the TTL — 2 hours covers any reasonable
 *  network propagation delay without being so far out that it ties up
 *  funds during a network stall. Cardano slot is 1 second. */
const TTL_OFFSET_SLOTS = 7200;

/** Lovelace as ADA with all six decimals, e.g. "1.500000" — exact, pasteable. */
function adaText(lovelace: bigint): string {
  const sign = lovelace < 0n ? "-" : "";
  const l = lovelace < 0n ? -lovelace : lovelace;
  return `${sign}${l / 1_000_000n}.${(l % 1_000_000n).toString().padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Address decoding
// ---------------------------------------------------------------------------

/** Decode a `addr1…` bech32 address back to its raw bytes. No policy: see
 *  `recipientAddressBytes` for what a payment may be sent to. */
export function decodeAddressBytes(address: string): Uint8Array {
  const decoded = bech32.decode(address as `${string}1${string}`, 1023);
  return new Uint8Array(bech32.fromWords(decoded.words));
}

/** CIP-19 header types whose payment part is a KEY hash: base (0, 2), pointer (4), enterprise (6). */
const KEY_PAYMENT_TYPES: ReadonlySet<number> = new Set([0, 2, 4, 6]);
/** CIP-19 header types whose payment part is a SCRIPT hash: base (1, 3), pointer (5), enterprise (7). */
const SCRIPT_PAYMENT_TYPES: ReadonlySet<number> = new Set([1, 3, 5, 7]);
const NETWORK_MAINNET = 1;

/** A pointer address's tail: three variable-length naturals, nothing after. */
function isPointerTail(b: Uint8Array): boolean {
  let pos = 0;
  for (let n = 0; n < 3; n++) {
    let len = 0;
    for (;;) {
      if (pos >= b.length || ++len > 10) return false;
      if ((b[pos++] & 0x80) === 0) break;
    }
  }
  return pos === b.length;
}

/**
 * The raw bytes of an address this wallet may pay ADA to, or an Error saying
 * why not (2026-09-29 send-safety audit).
 *
 * This decoded bech32 and checked nothing else: a testnet `addr_test1…`, a
 * `stake1…` reward address and an `addr1…` whose payment part is a SCRIPT
 * all decoded, and the builder put them in an output. Accepted now: mainnet
 * (`addr`, network id 1) addresses whose payment part is a key hash — base
 * (types 0 and 2), pointer (4) and enterprise (6) — of the right length.
 *
 * Script payment addresses are refused. Plain ADA sent to a Plutus V1/V2
 * script without a datum cannot be spent by that script again (inference
 * from the ledger rule that spending a Plutus V1/V2 output needs a datum; a
 * native multisig script would not need one, but the address does not say
 * which kind it is). The contract's own app sends with the datum it expects.
 *
 * Byron addresses (base58, `Ae2…` / `DdzFF…`) are refused with the reason.
 * Decision, not an oversight: supporting them means a second decoder —
 * base58, CBOR, a CRC and a network-magic attribute — whose mistakes would
 * send to outputs nobody can spend, for a format every current wallet
 * replaced with `addr1…` years ago. They failed the bech32 decode before this
 * too, with an unreadable error.
 */
export function recipientAddressBytes(address: string): Uint8Array {
  const a = address.trim();
  if (/^(Ae2|DdzFF)[1-9A-HJ-NP-Za-km-z]+$/.test(a)) {
    throw new Error(
      `"${a}" is a Byron-era Cardano address. This wallet sends only to Shelley addresses ` +
        `(addr1…) — ask the recipient for one; every current Cardano wallet shows it.`,
    );
  }
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(a as `${string}1${string}`, 1023);
  } catch {
    throw new Error(`"${a}" is not a Cardano address (expected addr1…).`);
  }
  if (decoded.prefix === "addr_test") {
    throw new Error(`"${a}" is a Cardano TESTNET address. This wallet sends on mainnet only.`);
  }
  if (decoded.prefix === "stake" || decoded.prefix === "stake_test") {
    throw new Error(
      `"${a}" is a stake (reward) address. It cannot receive a payment — use the recipient's addr1… address.`,
    );
  }
  if (decoded.prefix !== "addr") {
    throw new Error(`"${a}" is not a Cardano address (expected addr1…).`);
  }
  const bytes = new Uint8Array(bech32.fromWords(decoded.words));
  const type = bytes.length > 0 ? bytes[0] >> 4 : -1;
  const network = bytes.length > 0 ? bytes[0] & 0x0f : -1;
  if (SCRIPT_PAYMENT_TYPES.has(type)) {
    throw new Error(
      `"${a}" is a Cardano script address — a smart contract or a multi-signature wallet. ADA ` +
        `sent to one without the datum its contract expects can be locked there for good, so this ` +
        `wallet does not send to script addresses. Send from the app that uses the contract.`,
    );
  }
  const lengthOk =
    type === 0 || type === 2
      ? bytes.length === 57
      : type === 6
        ? bytes.length === 29
        : type === 4
          ? bytes.length > 29 && isPointerTail(bytes.subarray(29))
          : false;
  if (!KEY_PAYMENT_TYPES.has(type) || network !== NETWORK_MAINNET || !lengthOk) {
    throw new Error(`"${a}" is not a valid Cardano payment address.`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Signers
// ---------------------------------------------------------------------------

/**
 * A key that can witness spending from one Cardano address: the witness's
 * verification key (32 bytes; its blake2b-224 is the address's payment
 * credential) and a signature over a 32-byte transaction-body hash.
 */
export interface CardanoSigner {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

const ED25519_N = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

function bigIntLE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/**
 * A signer for a BIP-32-Ed25519 extended secret, kL ‖ kR (64 bytes): what
 * CIP-1852 and Exodus key sets store as `paymentPrivateKey`. The chain code
 * is only needed to derive children, never to sign, so none is held.
 */
export function extendedKeySigner(secret: Uint8Array): CardanoSigner {
  if (secret.length !== 64) throw new Error("A Cardano extended key is 64 bytes.");
  const ext = { secret: Uint8Array.from(secret), chainCode: new Uint8Array(32) };
  // A = kL·B, exactly as `cardano-cip1852.ts` computes the key it hashes.
  const publicKey = ed25519.Point.BASE.multiply(bigIntLE(secret.slice(0, 32)) % ED25519_N).toBytes();
  return { publicKey, sign: (m) => signBip32Ed25519(m, ext) };
}

/** A signer for a standard RFC-8032 Ed25519 seed (Pwnda's pre-2026-05-06 legacy key). */
export function ed25519SeedSigner(seed: Uint8Array): CardanoSigner {
  const key = Uint8Array.from(seed);
  return { publicKey: ed25519.getPublicKey(key), sign: (m) => ed25519.sign(m, key) };
}

/** The CIP-1852 account-0 / index-0 payment key of `mnemonic` — the default signer. */
export function defaultCardanoSigner(mnemonic: string): CardanoSigner {
  return extendedKeySigner(paymentExtendedKey(mnemonic).secret);
}

/**
 * Throw unless `signer` holds the payment key of the address in `fromBytes`.
 *
 * Belt and braces for the adapter's own address resolution (2026-09-29
 * send-safety audit): whatever a caller passes, no transaction is signed that
 * spends an address the key does not control. The node would reject it — but
 * the point is not to build it.
 */
function assertSignerControls(fromBytes: Uint8Array, fromAddress: string, signer: CardanoSigner): void {
  const type = fromBytes.length > 0 ? fromBytes[0] >> 4 : -1;
  const credential = blake2b(signer.publicKey, { dkLen: 28 });
  const matches =
    KEY_PAYMENT_TYPES.has(type) &&
    fromBytes.length >= 29 &&
    credential.every((b, i) => fromBytes[1 + i] === b);
  if (!matches) {
    throw new Error(
      `Refusing to sign: this key does not control ${fromAddress.slice(0, 20)}…, the address ` +
        `the transfer would spend from. Nothing was sent.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tx-body CBOR construction
// ---------------------------------------------------------------------------

interface TxBodyInputs {
  inputs: Array<{ txHash: Uint8Array; outputIndex: number }>;
  outputs: Array<{ addressBytes: Uint8Array; coin: bigint }>;
  fee: bigint;
  ttl: bigint;
}

function buildTxBody(b: TxBodyInputs): CborValue {
  // tx body is a map with numeric keys 0..N. Cardano's canonical form
  // requires keys in numeric ascending order, smallest-form integers,
  // definite-length containers.
  const inputArray = arrayCbor(
    b.inputs.map((i) =>
      arrayCbor([bytesCbor(i.txHash), uintCbor(i.outputIndex)])
    )
  );
  const outputArray = arrayCbor(
    b.outputs.map((o) =>
      // Legacy transaction_output = [address_bytes, coin]. Conway era
      // also accepts post_alonzo_transaction_output (a map), but the
      // legacy form is forward-compatible.
      arrayCbor([bytesCbor(o.addressBytes), uintCbor(o.coin)])
    )
  );
  return mapCbor([
    [uintCbor(0), inputArray],
    [uintCbor(1), outputArray],
    [uintCbor(2), uintCbor(b.fee)],
    [uintCbor(3), uintCbor(b.ttl)],
  ]);
}

// ---------------------------------------------------------------------------
// Witness set
// ---------------------------------------------------------------------------

function buildWitnessSet(vkeys: Array<{ pubkey: Uint8Array; signature: Uint8Array }>): CborValue {
  // transaction_witness_set = { 0 : [* vkey_witness] }
  // vkey_witness = [verification_key, signature]
  return mapCbor([
    [
      uintCbor(0),
      arrayCbor(
        vkeys.map((v) =>
          arrayCbor([bytesCbor(v.pubkey), bytesCbor(v.signature)])
        )
      ),
    ],
  ]);
}

// ---------------------------------------------------------------------------
// UTXO selection
// ---------------------------------------------------------------------------

/**
 * Largest-first single-output coverage: sort UTXOs descending, greedily
 * accumulate until amount + fee + min-utxo-change is covered. Skips any
 * UTXO that carries native assets — sending those would require
 * preserving the asset bundle, which is outside this implementation's
 * scope.
 *
 * Kept for its callers; `buildAndSignTx` selects with `planTransfer`, which
 * knows the exact fee of each candidate transaction.
 */
export interface SelectedInputs {
  selected: KoiosUtxo[];
  totalInLovelace: bigint;
}

/** ADA-only UTXOs (no native assets), largest first. */
function spendableLargestFirst(utxos: KoiosUtxo[]): KoiosUtxo[] {
  return utxos
    .filter((u) => !u.asset_list || u.asset_list.length === 0)
    .sort((a, b) => {
      const va = BigInt(a.value);
      const vb = BigInt(b.value);
      return vb < va ? -1 : vb > va ? 1 : 0;
    });
}

export function selectUtxosForAmount(
  utxos: KoiosUtxo[],
  amountLovelace: bigint,
  feeFloorLovelace: bigint
): SelectedInputs {
  const sorted = spendableLargestFirst(utxos);
  const selected: KoiosUtxo[] = [];
  let total = 0n;
  // Need: amount + fee + change-min-utxo (in case we produce change).
  const target = amountLovelace + feeFloorLovelace + MIN_UTXO_VALUE;
  for (const u of sorted) {
    selected.push(u);
    total += BigInt(u.value);
    if (total >= target) break;
  }
  return { selected, totalInLovelace: total };
}

/** Bytes of a one-key witness set plus the outer `[body, ws, true, null]`
 *  wrapper: 104 + 3, rounded up (a few bytes over only raises the fee by
 *  44 lovelace each; a fee is a floor, never an exact price). */
const WITNESS_BYTES = 110;

type Outputs = TxBodyInputs["outputs"];

interface Plan {
  inputs: KoiosUtxo[];
  outputs: Outputs;
  fee: bigint;
  body: Uint8Array;
}

/**
 * Encode the body and settle its fee. The fee depends on the body's size,
 * which depends on the fee (and on any change output derived from it), so
 * iterate — upward only: the loop ends at the first fee that covers the body
 * it is encoded in, which is the one condition the ledger checks.
 */
function settleFee(
  inputs: KoiosUtxo[],
  outputsFor: (fee: bigint) => Outputs,
  ttl: bigint,
  minA: bigint,
  minB: bigint,
): { fee: bigint; body: Uint8Array; outputs: Outputs } {
  let fee = minB;
  for (;;) {
    const outputs = outputsFor(fee);
    const body = encodeCbor(
      buildTxBody({
        inputs: inputs.map((u) => ({ txHash: hexToBytes(u.tx_hash), outputIndex: u.tx_index })),
        outputs,
        fee,
        ttl,
      }),
    );
    const required = BigInt(body.length + WITNESS_BYTES) * minA + minB;
    if (required <= fee) return { fee, body, outputs };
    fee = required;
  }
}

/**
 * Choose inputs and outputs for sending `amount` to `toBytes`, change back to
 * `fromBytes`.
 *
 * Adds inputs, largest first, until the payment, its exact fee and a change
 * output of at least `MIN_UTXO_VALUE` fit — or the inputs pay the amount and
 * fee exactly, with nothing left. With every input in and something left
 * that is too small to be an output, it REFUSES (2026-09-29 send-safety
 * audit): that change used to be added to the fee without a word, so the
 * user paid up to 1 ADA more than the fee they were shown. The refusal names
 * the amount that would be lost and the amounts that avoid it.
 */
function planTransfer(
  utxos: KoiosUtxo[],
  amount: bigint,
  toBytes: Uint8Array,
  fromBytes: Uint8Array,
  ttl: bigint,
  minA: bigint,
  minB: bigint,
): Plan {
  const sorted = spendableLargestFirst(utxos);
  const settle = (inputs: KoiosUtxo[], outputsFor: (fee: bigint) => Outputs) =>
    settleFee(inputs, outputsFor, ttl, minA, minB);
  const exactFor = (inputs: KoiosUtxo[], send: bigint) =>
    settle(inputs, () => [{ addressBytes: toBytes, coin: send }]);
  const withChangeFor = (inputs: KoiosUtxo[], send: bigint, total: bigint) =>
    settle(inputs, (fee) => {
      const change = total - send - fee;
      return [
        { addressBytes: toBytes, coin: send },
        { addressBytes: fromBytes, coin: change > 0n ? change : 0n },
      ];
    });

  let total = 0n;
  let rest = -1n;
  let exactFee = 0n;
  for (let n = 1; n <= sorted.length; n++) {
    const inputs = sorted.slice(0, n);
    total += BigInt(sorted[n - 1].value);
    const withChange = withChangeFor(inputs, amount, total);
    if (total - amount - withChange.fee >= MIN_UTXO_VALUE) {
      return { inputs, outputs: withChange.outputs, fee: withChange.fee, body: withChange.body };
    }
    const exact = exactFor(inputs, amount);
    rest = total - amount - exact.fee;
    exactFee = exact.fee;
    if (rest === 0n) return { inputs, outputs: exact.outputs, fee: exact.fee, body: exact.body };
    // Short, or left with change too small to be an output: another input
    // helps, if there is one.
  }

  if (sorted.length === 0) {
    throw new Error(
      "All of this address's ADA is held together with tokens, which this wallet cannot send yet. Nothing was sent.",
    );
  }
  if (rest < 0n) {
    const assetOnly = utxos.length > sorted.length;
    throw new Error(
      `Insufficient funds: this address can send ${adaText(total)} ADA, and this transfer needs ` +
        `${adaText(amount + exactFee)} ADA including the ${adaText(exactFee)} ADA network fee.` +
        (assetOnly ? ` (ADA held together with tokens cannot be sent from this wallet yet.)` : ""),
    );
  }

  // Every input is in, and `rest` (0 < rest < MIN_UTXO_VALUE) cannot be an
  // output. Refuse, with two amounts that leave nothing to lose.
  //   - Everything: the amount that makes the no-change transaction exact.
  //     The fee moves only when the amount's encoded size does, so settle.
  let sendAll = total - exactFee;
  for (let i = 0; i < 4; i++) {
    const next = total - exactFor(sorted, sendAll).fee;
    if (next === sendAll) break;
    sendAll = next;
  }
  //   - Keep change: the most that still leaves a change output of the minimum.
  let keep = total - withChangeFor(sorted, amount, total).fee - MIN_UTXO_VALUE;
  for (let i = 0; i < 4 && keep > 0n; i++) {
    const next = total - withChangeFor(sorted, keep, total).fee - MIN_UTXO_VALUE;
    if (next === keep) break;
    keep = next;
  }
  const allFee = total - sendAll;
  throw new Error(
    `Sending ${adaText(amount)} ADA would leave ${adaText(rest)} ADA of change. A Cardano output ` +
      `must hold at least ${adaText(MIN_UTXO_VALUE)} ADA, so that change could only be added to the ` +
      `network fee — and lost. Send ${adaText(sendAll)} ADA instead (all of it, after the ` +
      `${adaText(allFee)} ADA fee)` +
      (keep >= MIN_UTXO_VALUE ? `, or at most ${adaText(keep)} ADA to keep change.` : `.`),
  );
}

// ---------------------------------------------------------------------------
// Top-level builder
// ---------------------------------------------------------------------------

export interface BuildTxArgs {
  /** Mnemonic of the source wallet (for signing). */
  mnemonic: string;
  /** Source address (as displayed in the wallet): inputs come from it, change goes back to it. */
  fromAddress: string;
  /** Destination address — see `recipientAddressBytes` for what is accepted. */
  toAddress: string;
  /**
   * Amount to send, in ADA (decimal string from the user). Provide this
   * OR `amountLovelace`. The dashboard Send flow passes a user-typed
   * decimal here.
   */
  amountAda?: string;
  /**
   * Amount to send, in lovelace (atomic, 1 ADA = 1e6). Takes precedence
   * over `amountAda` when set. The swap-deposit path passes the 1Click
   * `quote.amountIn` (already lovelace) straight through as a bigint so
   * there's no float round-trip. Exactly one of the two must be set.
   */
  amountLovelace?: bigint;
  /**
   * The key that controls `fromAddress`. Omitted: the CIP-1852 account-0 /
   * index-0 payment key of `mnemonic` (what every caller used before
   * 2026-09-29). Either way it must control `fromAddress`, or nothing is
   * signed (`assertSignerControls`).
   */
  signer?: CardanoSigner;
}

export interface BuiltTxResult {
  /** CBOR-encoded full tx, ready to submit. */
  txCborBytes: Uint8Array;
  /** Hex tx hash (= blake2b-256 of body). */
  txHashHex: string;
  /** Computed fee, lovelace. */
  feeLovelace: bigint;
  /** TTL slot used. */
  ttl: bigint;
}

/**
 * Build + sign a Cardano ADA transfer: check the recipient and the key,
 * choose inputs with the exact fee (`planTransfer`), sign the body hash.
 */
export async function buildAndSignTx(args: BuildTxArgs): Promise<BuiltTxResult> {
  const { mnemonic, fromAddress, toAddress } = args;
  // Prefer the lossless lovelace path (swap deposits pass 1Click's
  // quote.amountIn straight through); fall back to the decimal-ADA string
  // (dashboard Send). Exactly one must be provided.
  let amountLovelace: bigint;
  if (args.amountLovelace !== undefined) {
    amountLovelace = args.amountLovelace;
  } else if (args.amountAda !== undefined && args.amountAda !== "") {
    // Exact (2026-09-29 send-safety audit). This was
    // `BigInt(Math.round(parseFloat(amountAda) * 1e6))`: "1,5" sent 1 ADA,
    // "1e3" sent 1000, and "2 ADA" sent 2.
    amountLovelace = decimalToAtomic(args.amountAda, 6, "ADA amount");
  } else {
    throw new Error(
      "Cardano amount missing — provide amountAda (decimal) or amountLovelace (atomic)."
    );
  }
  if (amountLovelace < MIN_UTXO_VALUE) {
    throw new Error(
      `Cardano output minimum is ${MIN_UTXO_VALUE} lovelace (${Number(MIN_UTXO_VALUE) / 1_000_000} ADA). Send at least that much.`
    );
  }
  // Refused before any network call: who the payment can go to, and whether
  // this key can spend from where it would come from.
  const toBytes = recipientAddressBytes(toAddress);
  const fromBytes = decodeAddressBytes(fromAddress);
  const signer = args.signer ?? defaultCardanoSigner(mnemonic);
  assertSignerControls(fromBytes, fromAddress, signer);

  const [params, tipSlot, utxos] = await Promise.all([
    getEpochParams(),
    getCurrentTipSlot(),
    getAddressUtxos(fromAddress),
  ]);
  if (utxos.length === 0) {
    throw new Error("Source address has no UTXOs to spend");
  }
  const minA = BigInt(params.min_fee_a);
  const minB = BigInt(params.min_fee_b);
  const ttl = BigInt(tipSlot + TTL_OFFSET_SLOTS);

  const plan = planTransfer(utxos, amountLovelace, toBytes, fromBytes, ttl, minA, minB);

  // Sign the body hash.
  const bodyHash = blake2b(plan.body, { dkLen: 32 });
  const signature = signer.sign(bodyHash);
  const witnessSet = buildWitnessSet([{ pubkey: signer.publicKey, signature }]);
  const tx = arrayCbor([
    // body — re-decode-and-encode would be wasteful; instead, splice
    // bodyBytes into the outer array by encoding as a tagged "raw cbor"
    // field. We build the outer wrapper from the parsed body via a
    // trick: encode a fresh CborValue tree with the same structure.
    decodeBodyForReuse(plan.body),
    witnessSet,
    boolCbor(true),
    nullCbor(),
  ]);
  const txCborBytes = encodeCbor(tx);
  const txHashHex = Array.from(bodyHash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return { txCborBytes, txHashHex, feeLovelace: plan.fee, ttl };
}

/**
 * Decode the body CBOR back into a CborValue so the outer tx-array
 * encoder can splice it in. We need this because our encoder doesn't
 * have a "raw bytes" mode that would let us inline pre-encoded bytes.
 *
 * The decode is restricted to the shapes our own encoder produces (uint,
 * bytes, array, map) — it's not a general CBOR decoder. Robust enough
 * for the closed-loop reuse here, but should not be exported.
 */
function decodeBodyForReuse(bytes: Uint8Array): CborValue {
  const dec = new MinimalCborDecoder(bytes);
  return dec.readValue();
}

class MinimalCborDecoder {
  private offset = 0;
  constructor(private buf: Uint8Array) {}

  readValue(): CborValue {
    const initial = this.buf[this.offset++];
    const mt = initial >> 5;
    const ai = initial & 0x1f;
    const len = this.readLength(ai);
    switch (mt) {
      case MT_UINT:
        return uintCbor(len);
      case MT_BYTES: {
        const n = Number(len);
        const slice = this.buf.slice(this.offset, this.offset + n);
        this.offset += n;
        return bytesCbor(slice);
      }
      case MT_ARRAY: {
        const n = Number(len);
        const out: CborValue[] = [];
        for (let i = 0; i < n; i++) out.push(this.readValue());
        return arrayCbor(out);
      }
      case MT_MAP: {
        const n = Number(len);
        const entries: Array<[CborValue, CborValue]> = [];
        for (let i = 0; i < n; i++) {
          const k = this.readValue();
          const v = this.readValue();
          entries.push([k, v]);
        }
        return mapCbor(entries);
      }
      default:
        throw new Error(`Unsupported CBOR major type ${mt} at body re-decode`);
    }
  }

  private readLength(ai: number): bigint {
    if (ai < 24) return BigInt(ai);
    if (ai === 24) return BigInt(this.buf[this.offset++]);
    if (ai === 25) {
      const v = (BigInt(this.buf[this.offset]) << 8n) | BigInt(this.buf[this.offset + 1]);
      this.offset += 2;
      return v;
    }
    if (ai === 26) {
      let v = 0n;
      for (let i = 0; i < 4; i++) {
        v = (v << 8n) | BigInt(this.buf[this.offset + i]);
      }
      this.offset += 4;
      return v;
    }
    if (ai === 27) {
      let v = 0n;
      for (let i = 0; i < 8; i++) {
        v = (v << 8n) | BigInt(this.buf[this.offset + i]);
      }
      this.offset += 8;
      return v;
    }
    throw new Error(`Unsupported CBOR additional info ${ai}`);
  }
}

// CBOR major-type constants (mirror cardano-cbor.ts's; we keep them
// inline rather than exporting to avoid widening the module's surface).
const MT_UINT = 0;
const MT_BYTES = 2;
const MT_ARRAY = 4;
const MT_MAP = 5;

// ---------------------------------------------------------------------------
// Send-tx convenience entrypoint
// ---------------------------------------------------------------------------

export interface SendAdaResult {
  txHash: string;
  feeLovelace: bigint;
}

/**
 * Build, sign, and submit an ADA transfer. Single call from the wallet
 * adapter's `sendTransaction`. Throws on insufficient funds, broadcast
 * failure, or any malformed input.
 */
export async function sendAda(args: BuildTxArgs): Promise<SendAdaResult> {
  const built = await buildAndSignTx(args);
  const txHash = await submitTx(built.txCborBytes);
  return { txHash, feeLovelace: built.feeLovelace };
}
