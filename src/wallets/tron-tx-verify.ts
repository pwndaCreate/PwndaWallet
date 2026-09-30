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

interface Field {
  no: number;
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
      out.push({ no, int: v });
      pos = next;
    } else if (wireType === 2) {
      const [len, next] = readVarint(buf, pos);
      const end = next + Number(len);
      if (end > buf.length) throw new TronTxMismatchError("malformed transaction bytes");
      out.push({ no, bytes: buf.slice(next, end) });
      pos = end;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      throw new TronTxMismatchError(`unsupported protobuf wire type ${wireType}`);
    }
  }
  if (pos !== buf.length) throw new TronTxMismatchError("malformed transaction bytes");
  return out;
}

const only = (fields: Field[], no: number): Field[] => fields.filter((f) => f.no === no);

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
  const contracts = only(top, 11);
  if (contracts.length !== 1 || !contracts[0].bytes) {
    throw new TronTxMismatchError(`expected one contract, found ${contracts.length}`);
  }
  const contract = fieldsOf(contracts[0].bytes);
  const type = only(contract, 1)[0]?.int ?? 0n;
  const any = only(contract, 2)[0]?.bytes;
  if (!any) throw new TronTxMismatchError("the contract carries no parameters");
  const value = only(fieldsOf(any), 2)[0]?.bytes;
  if (!value) throw new TronTxMismatchError("the contract carries no parameters");
  const params = fieldsOf(value);
  const bytesField = (no: number) => hexOf(only(params, no)[0]?.bytes).toLowerCase();
  const intField = (no: number) => only(params, no)[0]?.int ?? 0n;

  const mismatch = (what: string) => {
    throw new TronTxMismatchError(`the node built a transaction with a different ${what} than requested`);
  };

  if (expected.kind === "trx") {
    if (type !== TRANSFER_CONTRACT) mismatch("contract type");
    if (bytesField(1) !== expected.ownerHex.toLowerCase()) mismatch("sender");
    if (bytesField(2) !== expected.toHex.toLowerCase()) mismatch("recipient");
    if (intField(3) !== expected.amountSun) mismatch("amount");
    return;
  }

  if (type !== TRIGGER_SMART_CONTRACT) mismatch("contract type");
  if (bytesField(1) !== expected.ownerHex.toLowerCase()) mismatch("sender");
  if (bytesField(2) !== expected.contractHex.toLowerCase()) mismatch("token contract");
  if (intField(3) !== 0n) mismatch("TRX value attached");
  if (bytesField(4) !== expected.data.toLowerCase()) mismatch("recipient or amount");
  if (intField(5) !== 0n || intField(6) !== 0n) mismatch("token value attached");
  const feeLimit = only(top, 18)[0]?.int ?? 0n;
  if (feeLimit > expected.maxFeeLimitSun) mismatch("fee limit");
}
