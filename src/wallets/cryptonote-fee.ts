/**
 * A Monero or Zephyr fee ESTIMATED without building the transaction
 * (operator request, 2026-10-01).
 *
 * # Why
 *
 * The exact fee of a Monero-family send is known only once the wallet builds
 * it, and every build asks the remote node for the coins it spends together
 * with a fresh set of decoys (`wallet2::get_outs`: the real output is
 * requested with its decoys, then the request is sorted "to ensure the daemon
 * doesn't know which output is ours"). Built once, that hides the real coin.
 * Built again and again for the same spend, it does not: the real coin is in
 * every request and the decoys change, so a node that compares them can tell
 * which coin is the wallet's. Zephyr's Send modal rebuilt its fee preview on
 * every edit and every 60 s, and the conversion modal every 60 s.
 *
 * So a preview is now this estimate, which builds nothing: the network's
 * current per-byte fee times the weight of a typical transaction of the
 * send's shape, rounded up the way wallet2 rounds a real fee. The exact fee
 * comes from the ONE build made when the user asks to review the send, and
 * Confirm relays exactly that build.
 *
 * The rate is the DAEMON's `get_fee_estimate`, read through Rust from the
 * node the wallet already uses (`xmr_fee_estimate` / `zph_fee_estimate`,
 * `wallet_rpc_common.rs`): neither wallet-rpc has the method (-32601), and
 * most public nodes send no CORS headers, so the webview cannot ask them.
 * The request names no address, output or amount.
 *
 * Pure: no I/O here, so the arithmetic is tested against the C++ it ports and
 * against weights measured on chain (`cryptonoteFee.test.ts`).
 */

/** A node's fee rate, as `get_fee_estimate` reports it. */
export interface DaemonFeeRate {
  /**
   * Atomic units per byte of transaction weight, by priority:
   * `[low, normal, elevated, priority]` (wallet2's priorities 1-4). A node too
   * old to report `fees` gives one entry, its `fee` (the low rate).
   */
  perByte: readonly bigint[];
  /** A fee is rounded UP to a multiple of this (`quantization_mask`). */
  quantizationMask: bigint;
}

function positiveSafeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/**
 * The Rust command's reply (`{ fees: number[], quantization_mask: number }`)
 * as a {@link DaemonFeeRate}. Throws on anything that cannot price a fee —
 * a missing or empty list, a zero or fractional rate, a zero mask — so an
 * estimate is either computed from what the node said or not shown at all,
 * never made up and never zero.
 */
export function daemonFeeRateFrom(raw: unknown): DaemonFeeRate {
  const r = (raw ?? {}) as { fees?: unknown; quantization_mask?: unknown };
  const fees = Array.isArray(r.fees) ? r.fees : [];
  if (fees.length === 0 || !fees.every(positiveSafeInteger)) {
    throw new Error("The node reported no usable fee rate.");
  }
  if (!positiveSafeInteger(r.quantization_mask)) {
    throw new Error("The node reported no usable fee rounding (quantization mask).");
  }
  return {
    perByte: (fees as number[]).map((f) => BigInt(f)),
    quantizationMask: BigInt(r.quantization_mask),
  };
}

/** The shape of a RingCT transaction, for {@link rctTxWeight}. */
export interface RctTxShape {
  inputs: number;
  outputs: number;
  /** Ring members per input, the real one included (16 on both networks). */
  ringSize: number;
  /** Bytes of `tx.extra`. */
  extraBytes: number;
  /**
   * Zephyr only: bytes of the asset tag on every input and output (a
   * length-prefixed "ZPH" is 4). Monero has none.
   */
  assetTagBytes?: number;
}

/**
 * The weight wallet2 estimates for a transaction of this shape, with the
 * features both networks use today: CLSAG, one Bulletproof+ for all outputs,
 * one-byte view tags.
 *
 * A port of `estimate_rct_tx_size` and `estimate_tx_weight` (Monero
 * `src/wallet/wallet2.cpp`; Zephyr v2.3.0 `wallet2.cpp:789-872`, whose only
 * difference is the `+4` per input and per output for the asset tag). Weight
 * is the size plus, above two outputs, the "clawback" that charges a large
 * Bulletproof as if it were several small ones.
 */
export function rctTxWeight(shape: RctTxShape): number {
  const { inputs, ringSize, extraBytes } = shape;
  const tag = shape.assetTagBytes ?? 0;
  // A one-output transaction gets a dummy output (`estimate_tx_size_and_weight`:
  // "if (n_outputs == 1) n_outputs = 2").
  const outputs = Math.max(shape.outputs, 2);
  const mixin = ringSize - 1;
  let size = 1 + 6; // version + unlock time
  size += inputs * (1 + 6 + (mixin + 1) * 2 + 32 + tag); // vin: offsets + key image
  size += outputs * (6 + 32 + tag); // vout
  size += extraBytes;
  size += 1; // rct type
  let logPadded = 0;
  while (1 << logPadded < outputs) logPadded++;
  size += (2 * (6 + logPadded) + 6) * 32 + 3; // the Bulletproof+
  size += inputs * (32 * (mixin + 1) + 64); // a CLSAG per input
  size += outputs; // view tags
  size += 32 * inputs; // pseudoOuts
  size += 8 * outputs; // ecdhInfo
  size += 32 * outputs; // outPk (commitments only)
  size += 4; // txnFee
  if (outputs > 2) {
    const bpBase = (32 * (6 + 7 * 2)) / 2;
    let lp = 2;
    while (1 << lp < outputs) lp++;
    const nlr = 2 * (6 + lp);
    const bpSize = 32 * (6 + nlr);
    size += Math.floor(((bpBase * (1 << lp) - bpSize) * 4) / 5);
  }
  return size;
}

/**
 * The fee of `weight` at `perByte`, rounded up to the quantization mask —
 * wallet2's `calculate_fee_from_weight`.
 */
export function feeForWeight(weight: number, perByte: bigint, quantizationMask: bigint): bigint {
  const mask = quantizationMask > 0n ? quantizationMask : 1n;
  const fee = BigInt(weight) * perByte;
  return ((fee + mask - 1n) / mask) * mask;
}

/**
 * The transaction the estimate prices: two inputs, two outputs (the payment
 * and the change). It is the shape wallet2 itself prices before it picks any
 * coins ("this is used to build a tx that's 1 or 2 inputs, and 2 outputs,
 * which will get us a known fee", `create_transactions_2`), and the dearer
 * of the two it prefers, so a one-input send costs less than estimated, not
 * more. `extra` is 44 bytes: the transaction key (33) and the encrypted dummy
 * payment id wallet2 adds to every two-output transaction (11), the "typical
 * makeup" wallet-rpc's `estimate_tx_size_and_weight` uses.
 */
export const TYPICAL_SEND_DESCRIPTION = "two inputs, two outputs";

/**
 * Monero: 2,215. Measured 2026-10-06 on mainnet blocks 3,778,147-3,778,206
 * (a public node, read-only): 584 two-input, two-output transactions weighed
 * 2,177-2,234, median 2,221.
 */
export const MONERO_TYPICAL_SEND_WEIGHT = rctTxWeight({
  inputs: 2,
  outputs: 2,
  ringSize: 16,
  extraBytes: 44,
});

/**
 * Zephyr: 2,231 (Monero's plus the asset tags). Measured 2026-10-06 on
 * mainnet blocks 875,501-879,500: 975 two-input, two-output sends weighed
 * 2,217-2,237, median 2,227.
 */
export const ZEPHYR_TYPICAL_SEND_WEIGHT = rctTxWeight({
  inputs: 2,
  outputs: 2,
  ringSize: 16,
  extraBytes: 44,
  assetTagBytes: 4,
});

/**
 * A Zephyr conversion (mint, redeem, stake, unstake) with two inputs: 2,975,
 * MEASURED, not computed. A conversion has four outputs (the converted amount
 * and the change, each with a dummy, wallet2.cpp:9773-9797 at v2.3.0) and a
 * 33-byte extra, and Zephyr's own estimate for that shape (2,910) leaves out
 * the conversion's `maskSums` (inference: two 32-byte keys, from the gap).
 * Mainnet blocks 875,501-879,500: 15 two-input conversions weighed 2,970-2,982,
 * median 2,975; 18 one-input ones 2,288-2,297.
 */
export const ZEPHYR_TYPICAL_CONVERSION_WEIGHT = 2_975;

/** A typical transaction's fee at the node's current rates. */
export interface TypicalFee {
  /**
   * At the low rate: what the wallet pays. Both wallets send with priority 0,
   * which wallet2 turns into the low rate unless the pool has a backlog at
   * that rate or the last ten blocks are over 80% full (`adjust_priority`).
   */
  usual: bigint;
  /** At the normal rate, which `adjust_priority` picks when the network is busy. */
  busy: bigint | null;
}

export function typicalFee(rate: DaemonFeeRate, weight: number): TypicalFee {
  const [low, normal] = rate.perByte;
  return {
    usual: feeForWeight(weight, low, rate.quantizationMask),
    busy: normal != null ? feeForWeight(weight, normal, rate.quantizationMask) : null,
  };
}
