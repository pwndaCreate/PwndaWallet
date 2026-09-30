/**
 * Algorand payment transactions — canonical msgpack, signing, submission.
 *
 * # Why this is hand-rolled
 *
 * `algosdk` is 8.13 MB unpacked with 8 direct dependencies, and this module needs
 * exactly one transaction type. The encoding it requires is a small, fully specified
 * subset of msgpack, so the dependency is disproportionate — see
 * [[remaining-send-chains]] for the sizing that led to this call.
 *
 * That trade is only defensible if the encoder is actually correct, so the rules are
 * spelled out below and pinned by tests, including a live decode check against a real
 * algod node (`scripts/verify-algo-tx.mjs`).
 *
 * # Algorand's canonical msgpack, in full
 *
 * Not "msgpack" generically — a restricted profile. Get any of these wrong and the
 * signature covers different bytes than the node hashes, so the transaction is
 * rejected as unauthorised with no hint about which rule you broke:
 *
 * 1. **Maps are sorted by key**, byte-wise on the UTF-8 key.
 * 2. **Zero-valued fields are OMITTED entirely.** Not encoded as 0, not encoded as
 *    nil — absent. `amt: 0`, an empty note, a zero fee: all disappear. This is the
 *    rule that most often produces a silently invalid signature, because the
 *    transaction still encodes and still submits.
 * 3. **Integers use the shortest encoding** that fits.
 * 4. **Byte strings use `bin`, text uses `str`.** Addresses and the genesis hash are
 *    32 raw bytes (`bin`), never base32/base64 text.
 * 5. The signed payload is `"TX" || msgpack(txn)` — a domain-separation prefix, so a
 *    transaction signature can never be replayed as a bid/vote signature.
 *
 * The transaction id is `base32(sha512_256("TX" || msgpack(txn)))`, unpadded — the
 * same bytes that are signed, which is why a correct txId is decent evidence the
 * encoding is right.
 */
import { atomicToDecimal, decimalToAtomic } from "./decimal-amount";
import { SendOutcomeUnknownError } from "./send-outcome";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512_256 } from "@noble/hashes/sha2.js";
import { base32 } from "@scure/base";

const ALGO_API = "https://mainnet-api.algonode.cloud";

/** 1 ALGO = 1e6 microAlgos. */
const MICRO = 1_000_000n;

/**
 * Algorand's minimum account balance for a bare account. An account must
 * retain its minimum or the transaction fails; the minimum rises by 0.1 ALGO
 * per asset opted into (and more for apps and boxes). `sendAlgo` uses the
 * account's own figure, algod's `min-balance`, and this only when algod does
 * not report one — see `accountMinBalance`.
 */
export const ALGO_MIN_BALANCE_MICRO = 100_000n;

/**
 * The minimum balance THIS account must keep, in microAlgos: algod's
 * `min-balance`, which counts every asset, app and box the account holds.
 *
 * Until 2026-09-29 (send-safety audit) the check used 0.1 ALGO for every
 * account, so an account holding two assets (minimum 0.3) could be offered a
 * send that algod then refused. Falls back to the bare-account 0.1 only when
 * the field is absent or not a whole number.
 */
export function accountMinBalance(account: unknown): bigint {
  const v = (account as Record<string, unknown> | null)?.["min-balance"];
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return ALGO_MIN_BALANCE_MICRO;
}

/** microAlgos as ALGO, exact, trailing zeros dropped. */
function algoText(micro: bigint): string {
  return atomicToDecimal(micro, 6);
}

// ─── canonical msgpack (the subset Algorand uses) ───────────────────────

type MsgValue = bigint | number | string | Uint8Array;

function encodeUint(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("Algorand msgpack: negative integers are not used");
  if (n < 128n) return Uint8Array.of(Number(n));
  if (n <= 0xffn) return Uint8Array.of(0xcc, Number(n));
  if (n <= 0xffffn) return Uint8Array.of(0xcd, Number(n >> 8n) & 0xff, Number(n & 0xffn));
  if (n <= 0xffffffffn) {
    return Uint8Array.of(
      0xce,
      Number((n >> 24n) & 0xffn),
      Number((n >> 16n) & 0xffn),
      Number((n >> 8n) & 0xffn),
      Number(n & 0xffn),
    );
  }
  const out = new Uint8Array(9);
  out[0] = 0xcf;
  for (let i = 8; i >= 1; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function encodeStr(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  if (b.length < 32) return concat(Uint8Array.of(0xa0 | b.length), b);
  if (b.length <= 0xff) return concat(Uint8Array.of(0xd9, b.length), b);
  throw new Error("Algorand msgpack: string too long for this encoder");
}

function encodeBin(b: Uint8Array): Uint8Array {
  if (b.length <= 0xff) return concat(Uint8Array.of(0xc4, b.length), b);
  if (b.length <= 0xffff) {
    return concat(Uint8Array.of(0xc5, (b.length >> 8) & 0xff, b.length & 0xff), b);
  }
  throw new Error("Algorand msgpack: byte string too long for this encoder");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function encodeValue(v: MsgValue): Uint8Array {
  if (v instanceof Uint8Array) return encodeBin(v);
  if (typeof v === "string") return encodeStr(v);
  return encodeUint(typeof v === "bigint" ? v : BigInt(v));
}

/**
 * Encode a map under Algorand's canonical rules. **Entries whose value is zero,
 * empty-string or empty-bytes are dropped** before anything else happens — see rule 2
 * in the header. Keys are then sorted byte-wise.
 */
export function encodeCanonicalMap(fields: Record<string, MsgValue | undefined>): Uint8Array {
  const kept: [string, MsgValue][] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (typeof v === "bigint" && v === 0n) continue;
    if (typeof v === "number" && v === 0) continue;
    if (typeof v === "string" && v.length === 0) continue;
    if (v instanceof Uint8Array && v.length === 0) continue;
    kept.push([k, v]);
  }
  kept.sort(([a], [b]) => {
    const ab = new TextEncoder().encode(a);
    const bb = new TextEncoder().encode(b);
    const n = Math.min(ab.length, bb.length);
    for (let i = 0; i < n; i++) if (ab[i] !== bb[i]) return ab[i] - bb[i];
    return ab.length - bb.length;
  });

  if (kept.length > 15) throw new Error("Algorand msgpack: map too large for fixmap");
  const parts: Uint8Array[] = [Uint8Array.of(0x80 | kept.length)];
  for (const [k, v] of kept) {
    parts.push(encodeStr(k));
    parts.push(encodeValue(v));
  }
  return concat(...parts);
}

// ─── addresses ──────────────────────────────────────────────────────────

/** Algorand address (58-char base32, 4-byte checksum) → 32-byte public key. */
export function addressToPublicKey(address: string): Uint8Array {
  const clean = address.trim().toUpperCase();
  if (clean.length !== 58) {
    throw new Error(`Invalid Algorand address: expected 58 characters, got ${clean.length}`);
  }
  let raw: Uint8Array;
  try {
    raw = base32.decode(clean + "======");
  } catch {
    throw new Error("Invalid Algorand address: not valid base32");
  }
  if (raw.length !== 36) throw new Error("Invalid Algorand address: wrong decoded length");
  const pub = raw.slice(0, 32);
  const check = raw.slice(32);
  const expect = sha512_256(pub).slice(-4);
  for (let i = 0; i < 4; i++) {
    if (check[i] !== expect[i]) throw new Error("Invalid Algorand address: checksum mismatch");
  }
  return pub;
}

// ─── amounts ────────────────────────────────────────────────────────────

/** Decimal ALGO → microAlgos, exactly. Never via float. */
export function algoToMicro(amount: string): bigint {
  return decimalToAtomic(amount, 6, "ALGO amount");
}

// ─── transaction ────────────────────────────────────────────────────────

export interface AlgoSuggestedParams {
  fee: bigint;
  minFee: bigint;
  firstValid: bigint;
  lastValid: bigint;
  genesisId: string;
  genesisHash: Uint8Array;
}

/**
 * Fetch suggested params. Must be called IMMEDIATELY before signing: the
 * validity window is ~1000 rounds (~45 min), and a transaction built against
 * stale params is rejected after it expires.
 */
export async function fetchSuggestedParams(api = ALGO_API): Promise<AlgoSuggestedParams> {
  const r = await fetch(`${api}/v2/transactions/params`);
  if (!r.ok) throw new Error(`Algorand node HTTP ${r.status} fetching suggested params`);
  const p = await r.json();
  const minFee = BigInt(p["min-fee"] ?? 1000);
  const suggested = BigInt(p.fee ?? 0);
  return {
    // `fee` is a per-byte rate and is 0 on an idle network; the flat min-fee is
    // the floor either way, so take whichever is larger.
    fee: suggested > minFee ? suggested : minFee,
    minFee,
    firstValid: BigInt(p["last-round"]),
    lastValid: BigInt(p["last-round"]) + 1000n,
    genesisId: String(p["genesis-id"]),
    genesisHash: base64ToBytes(String(p["genesis-hash"])),
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** Canonical msgpack of an unsigned `pay` transaction. */
export function encodePayTransaction(args: {
  from: Uint8Array;
  to: Uint8Array;
  amountMicro: bigint;
  params: AlgoSuggestedParams;
  note?: Uint8Array;
}): Uint8Array {
  return encodeCanonicalMap({
    amt: args.amountMicro,
    fee: args.params.fee,
    fv: args.params.firstValid,
    gen: args.params.genesisId,
    gh: args.params.genesisHash,
    lv: args.params.lastValid,
    note: args.note,
    rcv: args.to,
    snd: args.from,
    type: "pay",
  });
}

/** `base32(sha512_256("TX" || txn))`, unpadded — Algorand's transaction id. */
export function transactionId(encodedTxn: Uint8Array): string {
  const digest = sha512_256(concat(new TextEncoder().encode("TX"), encodedTxn));
  return base32.encode(digest).replace(/=+$/, "");
}

/**
 * Sign an encoded transaction and wrap it as a `SignedTransaction`.
 * The signed payload is `"TX" || txn`; the wrapper is `{sig, txn}`, which sorts
 * correctly by the same canonical rule (`sig` < `txn`).
 */
export function signTransaction(encodedTxn: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const sig = ed25519.sign(concat(new TextEncoder().encode("TX"), encodedTxn), privateKey);
  // The txn is spliced in already-encoded: re-encoding it through the map
  // helper would require decoding it first, and a round-trip is exactly where
  // a canonical-encoding bug would hide.
  return concat(
    Uint8Array.of(0x82), // fixmap, 2 entries
    encodeStr("sig"),
    encodeBin(sig),
    encodeStr("txn"),
    encodedTxn,
  );
}

/** algod answered and refused the transaction (HTTP 4xx): nothing was sent. */
export class AlgodRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AlgodRefusal";
    Object.setPrototypeOf(this, AlgodRefusal.prototype);
  }
}

/**
 * Submit a signed transaction blob. Returns algod's transaction id, or
 * undefined when algod accepted it without a readable one.
 *
 * Throws `AlgodRefusal` when algod refused it (4xx). Anything else it throws —
 * no answer, a 5xx — says nothing about whether the node took it.
 */
export async function submitTransaction(
  signed: Uint8Array,
  api = ALGO_API,
): Promise<string | undefined> {
  const r = await fetch(`${api}/v2/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-binary" },
    body: signed as BodyInit,
  });
  const text = await r.text();
  if (!r.ok) {
    let message = text;
    try {
      message = JSON.parse(text).message ?? text;
    } catch {
      /* algod returns plain text for some errors */
    }
    if (r.status >= 400 && r.status < 500) {
      throw new AlgodRefusal(`Algorand rejected the transaction: ${message}`, r.status);
    }
    throw new Error(`Algorand node answered HTTP ${r.status}: ${message}`);
  }
  try {
    return JSON.parse(text).txId;
  } catch {
    return undefined; // accepted; the id is computed locally anyway
  }
}

/**
 * Build, sign and submit a payment.
 *
 * The minimum-balance rule is checked HERE rather than left to the node, because
 * algod's rejection ("account ... balance N below min") arrives after the user has
 * already confirmed and reads like a bug. Deducting it silently would be worse: the
 * user would receive less than they typed with no explanation.
 */
export async function sendAlgo(args: {
  privateKey: Uint8Array;
  fromAddress: string;
  to: string;
  amount: string;
  note?: string;
  api?: string;
}): Promise<{ hash: string }> {
  const api = args.api ?? ALGO_API;
  const from = addressToPublicKey(args.fromAddress);
  const to = addressToPublicKey(args.to);
  const amountMicro = algoToMicro(args.amount);
  if (amountMicro <= 0n) throw new Error("Amount must be greater than zero.");

  const params = await fetchSuggestedParams(api);

  const balResp = await fetch(`${api}/v2/accounts/${args.fromAddress}`);
  if (balResp.ok) {
    const acct = await balResp.json();
    const balance = BigInt(acct.amount ?? 0);
    const minBalance = accountMinBalance(acct);
    const required = amountMicro + params.fee + minBalance;
    if (balance < required) {
      throw new Error(
        `Not enough ALGO. This send needs ${algoText(amountMicro)} plus the ${algoText(params.fee)} ` +
          `fee, and this account must keep ${algoText(minBalance)} ALGO — Algorand's minimum balance, ` +
          `which rises with every asset or app an account holds — short by ` +
          `${algoText(required - balance)} ALGO.`,
      );
    }
  }

  const note = args.note ? new TextEncoder().encode(args.note) : undefined;
  const encoded = encodePayTransaction({ from, to, amountMicro, params, note });
  const signed = signTransaction(encoded, args.privateKey);
  const localId = transactionId(encoded);
  let nodeId: string | undefined;
  try {
    nodeId = await submitTransaction(signed, api);
  } catch (e) {
    if (e instanceof AlgodRefusal) throw e;
    // No answer, or a 5xx from the node's gateway: the node may have taken
    // the payment (2026-09-29 send-safety audit). This was a plain failure
    // with the form still filled, and one more press built a NEW transaction
    // (fresh validity window, new id) that paid again once the first landed.
    throw new SendOutcomeUnknownError(
      `The Algorand node gave no clear answer to the payment: ${e instanceof Error ? e.message : String(e)}`,
      localId,
    );
  }

  // A mismatch means our encoding and the node's differ — the transaction went
  // through, but our canonical encoder has a bug worth knowing about loudly.
  if (nodeId && nodeId !== localId) {
    console.warn(
      `[algo-tx] txId mismatch: local ${localId} vs node ${nodeId} — canonical encoding may be wrong`,
    );
  }
  return { hash: nodeId || localId };
}

export { bytesToBase64 };
