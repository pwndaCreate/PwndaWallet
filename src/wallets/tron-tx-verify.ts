/**
 * Check a node-built TRON transaction before signing it (2026-09-29).
 *
 * `trx-wallet.ts` and `trc20-wallet.ts` ask a node API to BUILD the
 * transaction (`createtransaction`, `triggersmartcontract`) — TronGrid first,
 * TronStack when TronGrid fails — and then sign the `txID` it returns. The
 * signature commits to `raw_data_hex`, not to the request we sent. Until this
 * date nothing compared the two, so a node answering with another recipient,
 * amount, token contract or fee limit would have had that signed exactly as
 * readily as the real thing.
 *
 * Two checks, both on the bytes that are actually signed:
 *   1. `txID == sha256(raw_data_hex)` — the id we sign IS those bytes;
 *   2. `raw_data_hex`, decoded, holds exactly one contract, of the expected
 *      type, whose fields equal what we asked for.
 *
 * The JSON `raw_data` the node returns beside the hex is ignored on purpose:
 * it is a description, and descriptions are not what gets signed.
 *
 * The decoder reads only the protobuf fields this needs (`Transaction.raw`,
 * `Contract`, `Any`, `TransferContract`, `TriggerSmartContract` — field
 * numbers from `Tron.proto` / `balance_contract.proto` /
 * `smart_contract.proto`), and is locked by transactions TronGrid built.
 *
 * # Repeated fields (2026-09-29 send-safety audit)
 *
 * A protobuf parser — java-tron's included — keeps the LAST copy of a
 * singular field that appears more than once. This decoder read the FIRST.
 * So a node could return a transaction carrying `to_address` twice (the
 * requested one, then its own), or `amount` twice, or the TRC-20 call `data`
 * twice: this check saw the requested values and passed, the txID matched,
 * and the network would have paid the second copy. The audit's
 * proof-of-concept did exactly that for all three.
 *
 * Duplicates inside the contract's parameter bytes are the dangerous ones:
 * `Any.value` is an opaque byte string, so it survives java-tron
 * re-serialising `Transaction.raw` and the signature still verifies. A
 * duplicate elsewhere in `raw` would change the re-serialised bytes and so the
 * id — but none of them is ever legitimate, so every singular field, at every
 * level read here, must now appear at most once, in the wire type its
 * `.proto` declares. The parameter's `type_url` must also name the contract
 * type: java-tron unpacks the parameter by it.
 */
import { ethers } from "ethers";

/** Thrown when the node's transaction is not the one requested. Never sign past it. */
export class TronTxMismatchError extends Error {
  readonly name = "TronTxMismatchError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, TronTxMismatchError.prototype);
  }
}

export type ExpectedTronTx =
  | {
      kind: "trx";
      /** 21-byte `41…` hex, lower or upper case. */
      ownerHex: string;
      toHex: string;
      amountSun: bigint;
    }
  | {
      kind: "trc20";
      ownerHex: string;
      contractHex: string;
      /** ABI call data, hex without `0x`: selector + arguments. */
      data: string;
      /** The fee limit we asked for; the node may not raise it. */
      maxFeeLimitSun: bigint;
    };

// ContractType enum values (Tron.proto).
const TRANSFER_CONTRACT = 1n;
const TRIGGER_SMART_CONTRACT = 31n;

/** `Any.type_url` for each contract type, as TronGrid writes it. */
const TYPE_URL = {
  trx: "type.googleapis.com/protocol.TransferContract",
  trc20: "type.googleapis.com/protocol.TriggerSmartContract",
} as const;

/** Protobuf wire types this decoder distinguishes. */
const VARINT = 0;
const LENGTH_DELIMITED = 2;

/**
 * `Transaction.raw` fields that may legitimately repeat: `auths` (9) and
 * `contract` (11, which must still hold exactly one entry). Every other
 * `raw` field is singular. Every field of `Contract`, `Any`,
 * `TransferContract` and `TriggerSmartContract` is singular.
 */
const RAW_REPEATED = new Set([9, 11]);

interface Field {
  no: number;
  /** Wire type: 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32. */
  wire: number;
  int?: bigint;
  bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = start;
  for (;;) {
    if (pos >= buf.length || shift > 63n) throw new TronTxMismatchError("malformed transaction bytes");
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
}

/** Every top-level field of one protobuf message, in order. */
function fieldsOf(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos);
    const no = Number(key >> 3n);
    const wireType = Number(key & 7n);
    pos = afterKey;
    if (wireType === 0) {
      const [v, next] = readVarint(buf, pos);
      out.push({ no, wire: wireType, int: v });
      pos = next;
    } else if (wireType === 2) {
      const [len, next] = readVarint(buf, pos);
      const end = next + Number(len);
      if (end > buf.length) throw new TronTxMismatchError("malformed transaction bytes");
      out.push({ no, wire: wireType, bytes: buf.slice(next, end) });
      pos = end;
    } else if (wireType === 1) {
      // Recorded (without a value) so a same-numbered copy in another wire
      // type still counts as a repeat.
      out.push({ no, wire: wireType });
      pos += 8;
    } else if (wireType === 5) {
      out.push({ no, wire: wireType });
      pos += 4;
    } else {
      throw new TronTxMismatchError(`unsupported protobuf wire type ${wireType}`);
    }
  }
  if (pos !== buf.length) throw new TronTxMismatchError("malformed transaction bytes");
  return out;
}

const only = (fields: Field[], no: number): Field[] => fields.filter((f) => f.no === no);

/**
 * Throw when any field number in `fields` appears more than once, except the
 * ones in `repeatable`. The network acts on the LAST copy of a singular
 * field; there is no honest reason for a node to send two.
 */
function assertNoRepeats(fields: Field[], where: string, repeatable?: ReadonlySet<number>): void {
  const seen = new Set<number>();
  for (const f of fields) {
    if (repeatable?.has(f.no)) continue;
    if (seen.has(f.no)) {
      throw new TronTxMismatchError(
        `the node's transaction repeats field ${f.no} of its ${where}; the network would act on ` +
          `the last copy, not the one checked here`,
      );
    }
    seen.add(f.no);
  }
}

/**
 * The one copy of singular field `no`, or undefined when it is absent. Call
 * after `assertNoRepeats`. A copy in another wire type than the `.proto`
 * declares is refused: java-tron would skip it as unknown, so what it reads
 * would not be what was checked.
 */
function single(fields: Field[], no: number, wire: number, what: string): Field | undefined {
  const hits = only(fields, no);
  if (hits.length > 1) {
    throw new TronTxMismatchError(`the node's transaction carries its ${what} more than once`);
  }
  if (hits[0] && hits[0].wire !== wire) {
    throw new TronTxMismatchError(`the node's transaction encodes its ${what} in an unexpected form`);
  }
  return hits[0];
}

function hexOf(bytes: Uint8Array | undefined): string {
  return bytes ? ethers.hexlify(bytes).slice(2) : "";
}

function bytesOfHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new TronTxMismatchError("transaction bytes are not hex");
  }
  return ethers.getBytes("0x" + clean);
}

/**
 * Throw `TronTxMismatchError` unless `tx` is exactly the transaction described
 * by `expected`. Returns nothing: passing IS the result.
 */
export function verifyTronTransaction(
  tx: { txID?: unknown; raw_data_hex?: unknown },
  expected: ExpectedTronTx,
): void {
  if (typeof tx.txID !== "string" || typeof tx.raw_data_hex !== "string") {
    throw new TronTxMismatchError("the node returned no transaction to sign");
  }
  const raw = bytesOfHex(tx.raw_data_hex);
  const digest = ethers.sha256(raw).slice(2);
  if (digest !== tx.txID.toLowerCase()) {
    throw new TronTxMismatchError(
      "the transaction id the node returned is not the hash of the transaction it returned",
    );
  }

  const top = fieldsOf(raw);
  assertNoRepeats(top, "transaction", RAW_REPEATED);
  const contracts = only(top, 11);
  if (contracts.length !== 1 || contracts[0].wire !== LENGTH_DELIMITED || !contracts[0].bytes) {
    throw new TronTxMismatchError(`expected one contract, found ${contracts.length}`);
  }
  const contract = fieldsOf(contracts[0].bytes);
  assertNoRepeats(contract, "contract");
  const type = single(contract, 1, VARINT, "contract type")?.int ?? 0n;
  const anyBytes = single(contract, 2, LENGTH_DELIMITED, "contract parameters")?.bytes;
  if (!anyBytes) throw new TronTxMismatchError("the contract carries no parameters");
  const any = fieldsOf(anyBytes);
  assertNoRepeats(any, "contract parameters");
  const typeUrl = new TextDecoder().decode(
    single(any, 1, LENGTH_DELIMITED, "parameter type")?.bytes ?? new Uint8Array(0),
  );
  const value = single(any, 2, LENGTH_DELIMITED, "contract parameters")?.bytes;
  if (!value) throw new TronTxMismatchError("the contract carries no parameters");
  const params = fieldsOf(value);
  assertNoRepeats(params, expected.kind === "trx" ? "transfer" : "contract call");
  const bytesField = (no: number, what: string) =>
    hexOf(single(params, no, LENGTH_DELIMITED, what)?.bytes).toLowerCase();
  const intField = (no: number, what: string) => single(params, no, VARINT, what)?.int ?? 0n;

  const mismatch = (what: string) => {
    throw new TronTxMismatchError(`the node built a transaction with a different ${what} than requested`);
  };

  if (expected.kind === "trx") {
    if (type !== TRANSFER_CONTRACT || typeUrl !== TYPE_URL.trx) mismatch("contract type");
    if (bytesField(1, "sender") !== expected.ownerHex.toLowerCase()) mismatch("sender");
    if (bytesField(2, "recipient") !== expected.toHex.toLowerCase()) mismatch("recipient");
    if (intField(3, "amount") !== expected.amountSun) mismatch("amount");
    return;
  }

  if (type !== TRIGGER_SMART_CONTRACT || typeUrl !== TYPE_URL.trc20) mismatch("contract type");
  if (bytesField(1, "sender") !== expected.ownerHex.toLowerCase()) mismatch("sender");
  if (bytesField(2, "token contract") !== expected.contractHex.toLowerCase()) mismatch("token contract");
  if (intField(3, "TRX value") !== 0n) mismatch("TRX value attached");
  if (bytesField(4, "call data") !== expected.data.toLowerCase()) mismatch("recipient or amount");
  if (intField(5, "token value") !== 0n || intField(6, "token id") !== 0n) {
    mismatch("token value attached");
  }
  const feeLimit = single(top, 18, VARINT, "fee limit")?.int ?? 0n;
  if (feeLimit > expected.maxFeeLimitSun) mismatch("fee limit");
}
