/**
 * Account-wide LTC spend — the input selection, which is the part that decides
 * how much money moves.
 *
 * ## The incident this closes
 *
 * On 2026-08-25 the operator's LTC balance read 4.05726856 and was correct:
 * 4.02888049 sat at `m/84'/2'/0'/1/20` (an internal/change index BasicSwap's
 * engine had created), the rest at receive indices 0, 1 and 20. Wallet ► Send
 * could spend **none of it**, because `ltcAdapter.sendTransaction` takes one
 * private key and that key derives exactly `m/84'/2'/0'/0/0` — which held
 * 0.00000000.
 *
 * The engine could always spend all of it, from the same seed, over the same
 * addresses: `_fundTxElectrum` funds from `wm.getFundedAddresses(coin_type)`.
 * Electrum, Sparrow, BlueWallet and Trezor Suite all do the equivalent. This
 * is that behaviour, and these tests pin the selection rules it needs.
 *
 * `sendLtcFromAccount` itself scans, signs and broadcasts, so it is not unit-
 * tested here — same split as `planLtcConsolidation` vs
 * `consolidateLtcAccount` in `ltc-consolidate.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  planAccountSpend,
  LTC_DUST_SAT,
  P2WPKH_SIZING,
  type AccountSpendCandidate,
} from "./ltc-wallet";

/** LTC is native SegWit at the standard 546-lit dust threshold. Spread into
 *  every call so the sizing under test is stated once, not twelve times. */
const LTC = { sizing: P2WPKH_SIZING, dustSat: LTC_DUST_SAT } as const;

/** A UTXO at a given account path. `chain` 1 = change, the indices Send missed. */
function utxo(
  chain: 0 | 1,
  index: number,
  valueSat: number,
  vout = 0,
): AccountSpendCandidate {
  return {
    path: `m/84'/2'/0'/${chain}/${index}`,
    address: `ltc1q${chain}x${index}`,
    txid: `${chain}${index}`.padStart(64, "a"),
    vout,
    valueSat,
  };
}

/** The operator's account as it stood on 2026-08-25, in litoshi. */
const REAL_ACCOUNT = [
  utxo(1, 20, 402_888_049), // the change output the single-key path could not see
  utxo(0, 20, 2_015_766),
  utxo(0, 1, 823_041),
];

describe("planAccountSpend — reaching the whole account", () => {
  it("spends the change-index output the single-key path could not reach", () => {
    // The regression, stated as directly as it can be: a send larger than
    // every receive-chain output combined must still succeed, because the
    // money is on the change chain.
    const plan = planAccountSpend({
      candidates: REAL_ACCOUNT,
      sendSat: 100_000_000, // 1 LTC — more than indices 0/1 and 0/20 hold together
      feePerVB: 1,
      ...LTC,
    });
    expect(plan.covered).toBe(true);
    expect(plan.inputs.map((i) => i.path)).toContain("m/84'/2'/0'/1/20");
  });

  it("would have failed on the receive chain alone — the pre-fix behaviour", () => {
    // The control. Without it the test above proves only "selection works",
    // not "selection is what fixed this".
    const receiveOnly = REAL_ACCOUNT.filter((c) => c.path.includes("/0/"));
    expect(receiveOnly, "filter must keep the receive-chain entries, not zero")
      .toHaveLength(2);
    const plan = planAccountSpend({
      candidates: receiveOnly,
      sendSat: 100_000_000,
      feePerVB: 1,
      ...LTC,
    });
    expect(plan.covered).toBe(false);
    expect(plan.shortfallSat).toBeGreaterThan(0);
  });

  it("sends the full displayed balance minus fee — no stranded remainder", () => {
    // A user who reads 4.05726856 and types it minus fee expects it to go.
    const total = REAL_ACCOUNT.reduce((t, c) => t + c.valueSat, 0);
    expect(total).toBe(405_726_856); // matches the chain, and the engine's SUM
    const plan = planAccountSpend({
      candidates: REAL_ACCOUNT,
      sendSat: total - 1_000,
      feePerVB: 1,
      ...LTC,
    });
    expect(plan.covered).toBe(true);
    expect(plan.inputs).toHaveLength(3);
    expect(plan.feeSat + plan.changeSat + (total - 1_000)).toBe(total);
  });
});

describe("planAccountSpend — selection and fee arithmetic", () => {
  it("takes the largest output first, and only as many as needed", () => {
    const plan = planAccountSpend({
      candidates: REAL_ACCOUNT,
      sendSat: 1_000_000,
      feePerVB: 1,
      ...LTC,
    });
    expect(plan.inputs).toHaveLength(1);
    expect(plan.inputs[0].valueSat).toBe(402_888_049);
  });

  it("re-prices the fee as inputs accumulate", () => {
    // The subtle one. A fee computed for 1 input and then paid for 3 underpays
    // by ~136 vB and the tx sits unconfirmed. Each added input must cost more.
    const one = planAccountSpend({
      candidates: REAL_ACCOUNT,
      sendSat: 1_000_000,
      feePerVB: 10,
      ...LTC,
    });
    const three = planAccountSpend({
      candidates: REAL_ACCOUNT,
      sendSat: 405_000_000, // forces all three
      feePerVB: 10,
      ...LTC,
    });
    expect(one.inputs).toHaveLength(1);
    expect(three.inputs).toHaveLength(3);
    expect(three.feeSat).toBeGreaterThan(one.feeSat);
    // 11 + 3*68 + 2*31 = 277 vB at 10 sat/vB
    expect(three.feeSat).toBe(2_770);
  });

  it("conserves value exactly — inputs = amount + fee + change", () => {
    // The invariant that makes a bug here impossible to hide: nothing may
    // vanish between selection and the PSBT.
    for (const sendSat of [50_000, 1_000_000, 402_000_000, 405_000_000]) {
      const plan = planAccountSpend({
        candidates: REAL_ACCOUNT,
        sendSat,
        feePerVB: 3,
      ...LTC,
      });
      expect(plan.covered, `sendSat=${sendSat} should be affordable`).toBe(true);
      const inputTotal = plan.inputs.reduce((t, i) => t + i.valueSat, 0);
      expect(inputTotal, `sendSat=${sendSat}`).toBe(
        sendSat + plan.feeSat + plan.changeSat,
      );
    }
  });

  it("folds dust change into the fee instead of creating an unspendable output", () => {
    // 200 lit of change costs ~68 lit to spend later and bloats the UTXO set.
    const single = [utxo(0, 0, 100_000)];
    const feeWithChange = Math.ceil(1 * (11 + 68 + 62)); // 141
    const plan = planAccountSpend({
      candidates: single,
      sendSat: 100_000 - feeWithChange - 200,
      feePerVB: 1,
      ...LTC,
    });
    expect(plan.covered).toBe(true);
    expect(plan.changeSat).toBe(0);
    expect(plan.feeSat).toBe(feeWithChange + 200);
  });

  it("keeps change once it clears dust", () => {
    const single = [utxo(0, 0, 100_000)];
    const plan = planAccountSpend({
      candidates: single,
      sendSat: 10_000,
      feePerVB: 1,
      ...LTC,
    });
    expect(plan.changeSat).toBeGreaterThan(LTC_DUST_SAT);
  });
});

describe("planAccountSpend — refusals", () => {
  it("refuses an empty account rather than building a zero-input tx", () => {
    const plan = planAccountSpend({ candidates: [], sendSat: 1_000, feePerVB: 1, ...LTC });
    expect(plan.covered).toBe(false);
    expect(plan.inputs).toHaveLength(0);
    expect(plan.shortfallSat).toBeGreaterThan(1_000);
  });

  it("refuses when the balance covers the amount but not the fee", () => {
    // The off-by-a-fee case: 'you have exactly 1 LTC, send 1 LTC' cannot work,
    // and must say so rather than build an under-funded tx.
    const single = [utxo(0, 0, 100_000_000)];
    const plan = planAccountSpend({
      candidates: single,
      sendSat: 100_000_000,
      feePerVB: 5,
      ...LTC,
    });
    expect(plan.covered).toBe(false);
    expect(plan.shortfallSat).toBe(plan.feeSat);
  });

  it("counts the shortfall against the whole account, not one address", () => {
    // The error message a user sees must be true of their wallet. Reporting a
    // per-address shortfall over a funded account is the original bug wearing
    // a different hat.
    const plan = planAccountSpend({
      candidates: REAL_ACCOUNT,
      sendSat: 500_000_000,
      feePerVB: 1,
      ...LTC,
    });
    expect(plan.covered).toBe(false);
    const total = REAL_ACCOUNT.reduce((t, c) => t + c.valueSat, 0);
    expect(plan.shortfallSat).toBe(500_000_000 + plan.feeSat - total);
  });
});
