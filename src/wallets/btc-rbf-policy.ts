/**
 * Replace-by-fee for Bitcoin, the rules half: pure numbers, no network, no
 * keys (operator request, 2026-10-01).
 *
 * # Why
 *
 * A BTC deposit is signed at the fee rate estimated at that moment. When the
 * network gets busy after that, it can sit unconfirmed past a NEAR Intents
 * quote's deadline, and NEAR then refunds it, minus fees, instead of swapping.
 * Every BTC transaction this wallet built carried nSequence 0xffffffff on every
 * input (bitcoinjs-lib's default), so none of them could be replaced: a stuck
 * one could only wait. Since 2026-10-01 every input of every BTC transaction
 * the wallet builds is {@link BTC_RBF_SEQUENCE} (BIP125 opt-in), and the
 * "Speed up" action (`btc-rbf.ts`) re-sends one with a higher fee.
 *
 * Litecoin is deliberately NOT included. Litecoin Core's current release
 * (v0.21.5.8, 2026-09-12; master the same) ships
 * `DEFAULT_ENABLE_REPLACEMENT = false` (`src/validation.h:80`) and accepts a
 * replacement only when a node runs with `-mempoolreplacement`
 * (`src/validation.cpp:660-672`: "Litecoin: Only support BIP125 RBF when
 * -mempoolreplacement arg is set"); it has no full-RBF option. A default
 * Litecoin node answers any replacement with `txn-mempool-conflict`.
 *
 * # The replacement rules (BIP125, as Bitcoin Core applies them)
 *
 *  1. The original signals: some input's nSequence ≤ 0xfffffffd
 *     ({@link signalsRbf}). Bitcoin Core 28+ accepts replacements of
 *     transactions that do not signal (full RBF), but the action is offered
 *     only for one that does (the operator's brief), which every version
 *     accepts.
 *  2. No new unconfirmed inputs: the replacement spends exactly the
 *     original's inputs, in the original's order (`btc-rbf.ts`).
 *  3. Its absolute fee is at least the original's (implied by 4).
 *  4. The fee it ADDS pays for its own relay: at least the incremental relay
 *     fee times its vsize. Core's default is 0.1 sat/vB since the 2026 point
 *     releases (`DEFAULT_INCREMENTAL_RELAY_FEE{100}` sat/kvB in v28.4, v29.4,
 *     v31.1) and 1 sat/vB before them; {@link INCREMENTAL_RELAY_SAT_PER_VB} is
 *     1, which every version accepts.
 *  5. At most 100 transactions evicted: only the original. A transaction one
 *     of whose outputs is already spent is refused (`btc-rbf.ts`), because
 *     replacing it would evict — cancel — the transaction that spends it.
 *  6. A higher fee RATE than the original (Core's "insufficient fee …
 *     new feerate <= old feerate", and the feerate-diagram check since v29).
 */

/** The nSequence every BTC input carries: BIP125 opt-in, no relative lock time
 *  (bit 31, BIP68's disable flag, is set), no effect on nLockTime 0. */
export const BTC_RBF_SEQUENCE = 0xfffffffd;

/** BIP125: a transaction is replaceable when any input's nSequence is at most this. */
export const MAX_BIP125_RBF_SEQUENCE = 0xfffffffd;

/** sat/vB a replacement must add per vbyte of its own size (rule 4); see the header. */
export const INCREMENTAL_RELAY_SAT_PER_VB = 1;

/** Does a transaction with these input nSequence values signal replaceability? */
export function signalsRbf(sequences: ReadonlyArray<number>): boolean {
  return sequences.some((s) => Number.isInteger(s) && s >= 0 && s <= MAX_BIP125_RBF_SEQUENCE);
}

/** How a wallet input is spent, which decides its signed size. */
export type BtcSpendKind = "p2wpkh" | "p2sh-p2wpkh" | "p2pkh";

function varintBytes(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
}

/** The largest signature push: a 71-byte DER signature (33-byte R with its
 *  0x00 pad, low S) plus the sighash byte. */
const MAX_SIGNATURE_BYTES = 72;
const COMPRESSED_PUBKEY_BYTES = 33;
/** P2SH-P2WPKH's scriptSig: one push of the 22-byte `0014{hash160}` program. */
const P2SH_P2WPKH_SCRIPTSIG_BYTES = 23;

/**
 * The most vbytes a transaction with these inputs and outputs can weigh once
 * signed: every signature at its longest. A replacement is priced at this, so
 * whatever lengths the real signatures come out at, its fee rate is never
 * below the one shown (and `btc-rbf.ts` checks the signed size against it).
 *
 * The same numbers the send planner's sizing uses: a P2WPKH input is 68 vB, a
 * P2SH-P2WPKH input 91, a P2PKH input 148, and one P2WPKH input with two
 * P2WPKH outputs is 141 vB.
 */
export function signedVsizeUpperBound(
  inputs: ReadonlyArray<BtcSpendKind>,
  outputScriptLengths: ReadonlyArray<number>,
): number {
  let base = 4 + varintBytes(inputs.length) + varintBytes(outputScriptLengths.length) + 4;
  let witness = 0;
  let segwit = false;
  for (const kind of inputs) {
    const scriptSig =
      kind === "p2wpkh"
        ? 0
        : kind === "p2sh-p2wpkh"
          ? P2SH_P2WPKH_SCRIPTSIG_BYTES
          : 1 + MAX_SIGNATURE_BYTES + 1 + COMPRESSED_PUBKEY_BYTES;
    base += 32 + 4 + varintBytes(scriptSig) + scriptSig + 4;
    if (kind === "p2pkh") {
      witness += 1; // an empty stack, once any input of the transaction has a witness
    } else {
      segwit = true;
      witness += 1 + 1 + MAX_SIGNATURE_BYTES + 1 + COMPRESSED_PUBKEY_BYTES;
    }
  }
  for (const len of outputScriptLengths) base += 8 + varintBytes(len) + len;
  const weight = base * 4 + (segwit ? 2 + witness : 0);
  return Math.ceil(weight / 4);
}

/**
 * The least a replacement of size `replacementVsize` may pay: rule 4 (the
 * original's fee plus its own relay), and a fee rate strictly above the
 * original's (rule 6). Rule 3 follows from rule 4.
 */
export function minimumReplacementFeeSat(
  originalFeeSat: number,
  originalVsize: number,
  replacementVsize: number,
): number {
  const byRelay = originalFeeSat + Math.ceil(INCREMENTAL_RELAY_SAT_PER_VB * replacementVsize);
  const byRate = Math.floor((originalFeeSat * replacementVsize) / originalVsize) + 1;
  return Math.max(byRelay, byRate);
}

/**
 * Which replacement rule a SIGNED replacement breaks, in words, or null when
 * it keeps them all. Checked against the real size after signing, before
 * anything is broadcast.
 */
export function replacementRuleViolation(a: {
  originalFeeSat: number;
  originalVsize: number;
  replacementFeeSat: number;
  replacementVsize: number;
}): string | null {
  if (!(a.replacementFeeSat > a.originalFeeSat)) {
    return `pays ${a.replacementFeeSat} sat, not more than the original's ${a.originalFeeSat} sat (BIP125 rule 3)`;
  }
  const relay = Math.ceil(INCREMENTAL_RELAY_SAT_PER_VB * a.replacementVsize);
  if (a.replacementFeeSat - a.originalFeeSat < relay) {
    return (
      `adds ${a.replacementFeeSat - a.originalFeeSat} sat, less than the ${relay} sat its own ` +
      `${a.replacementVsize} vB must pay to be relayed (BIP125 rule 4)`
    );
  }
  if (a.replacementFeeSat * a.originalVsize <= a.originalFeeSat * a.replacementVsize) {
    return "pays a fee rate no higher than the original's (BIP125 rule 6)";
  }
  return null;
}

export interface BtcFeeBumpPlan {
  /** The least any replacement of this size may pay. */
  minimumFeeSat: number;
  /** What this one pays: the target rate, never below the minimum. */
  newFeeSat: number;
  /** `newFeeSat` minus the original's fee: what comes out of the change. */
  extraFeeSat: number;
  newChangeSat: number;
  /** The target was absent or below the minimum, so the minimum is paid. */
  atMinimum: boolean;
}

export type BtcFeeBumpResult =
  | { ok: true; plan: BtcFeeBumpPlan }
  | {
      ok: false;
      /** The change cannot pay `extraFeeSat` and stay above dust. */
      reason: "dust";
      minimumFeeSat: number;
      newFeeSat: number;
      extraFeeSat: number;
      changeSat: number;
    };

/** `rate × vsize`, rounded up, without float noise turning 230 into 231. */
function feeAt(rate: number, vsize: number): number {
  return Math.ceil(Number((rate * vsize).toFixed(6)));
}

/**
 * The replacement's fee and change. Pure.
 *
 * Every recipient keeps its amount; the whole increase comes out of the
 * wallet's change. A change that would be left at or below `dustSat` is
 * refused rather than dropped: dropping it would hand the remainder to the
 * miner and change the transaction's shape, and the only other source of a
 * higher fee — adding another of the wallet's coins as an input — is not
 * something this does (it would need a coin choice, a second key lookup and a
 * new input the original did not have, which rule 2 then requires to be
 * confirmed).
 */
export function planBtcFeeBump(a: {
  originalFeeSat: number;
  originalVsize: number;
  /** An upper bound on the signed replacement's size ({@link signedVsizeUpperBound}). */
  replacementVsize: number;
  changeValueSat: number;
  /** sat/vB asked for (the fast tier); absent or below the minimum pays the minimum. */
  targetRate?: number | null;
  /** The change must stay ABOVE this (the send planner's own rule). */
  dustSat: number;
}): BtcFeeBumpResult {
  for (const [k, v] of Object.entries({
    originalFeeSat: a.originalFeeSat,
    originalVsize: a.originalVsize,
    replacementVsize: a.replacementVsize,
    changeValueSat: a.changeValueSat,
  })) {
    if (!Number.isSafeInteger(v) || v < 0 || ((k === "originalVsize" || k === "replacementVsize") && v === 0)) {
      throw new Error(`Cannot plan a fee bump: ${k} is ${v}. Nothing was sent.`);
    }
  }
  const minimumFeeSat = minimumReplacementFeeSat(a.originalFeeSat, a.originalVsize, a.replacementVsize);
  const rate = a.targetRate;
  const targetFee = rate !== null && rate !== undefined && Number.isFinite(rate) && rate > 0
    ? feeAt(rate, a.replacementVsize)
    : 0;
  const newFeeSat = Math.max(minimumFeeSat, targetFee);
  const extraFeeSat = newFeeSat - a.originalFeeSat;
  const newChangeSat = a.changeValueSat - extraFeeSat;
  if (newChangeSat <= a.dustSat) {
    return { ok: false, reason: "dust", minimumFeeSat, newFeeSat, extraFeeSat, changeSat: a.changeValueSat };
  }
  return {
    ok: true,
    plan: { minimumFeeSat, newFeeSat, extraFeeSat, newChangeSat, atMinimum: targetFee <= minimumFeeSat },
  };
}
