/**
 * The shared account-spend planner, across every chain that now uses it.
 *
 * `planAccountSpend` moved out of `ltc-wallet.ts` on 2026-08-25 when BTC, DOGE,
 * DASH and BCH adopted account-wide sending. The LTC-specific cases stay in
 * `ltc-account-send.test.ts` (they encode the operator's real incident); what
 * is here is everything that must hold for ALL of them, and specifically the
 * two parameters that differ per chain and are silent when wrong:
 *
 *   - **sizing** — a legacy P2PKH input is 148 vB against native SegWit's 68.
 *     Budget a DOGE send with SegWit constants and it underpays by ~80 vB per
 *     input, producing a transaction that is valid, broadcastable, and sits
 *     unconfirmed. Nothing throws.
 *   - **dustSat** — 546 on BTC/LTC/DASH/BCH, 1_000_000 on DOGE. Use the low
 *     value on DOGE and you emit change Dogecoin Core penalises; use DOGE's on
 *     DASH and you silently donate up to 0.01 DASH of change to the miner.
 *
 * Both are wrong-but-plausible failures, which is why they are required
 * arguments rather than defaults, and why they are pinned here.
 */
import { describe, it, expect } from "vitest";
import {
  planAccountSpend,
  P2WPKH_SIZING,
  P2PKH_SIZING,
  type AccountSpendCandidate,
} from "./utxo-account";
import { getAdapter } from "./index";

function utxo(n: number, valueSat: number): AccountSpendCandidate {
  return {
    path: `m/44'/0'/0'/1/${n}`,
    address: `addr${n}`,
    txid: String(n).padStart(64, "0"),
    vout: 0,
    valueSat,
  };
}

const SEGWIT = { sizing: P2WPKH_SIZING, dustSat: 546 };
const LEGACY = { sizing: P2PKH_SIZING, dustSat: 546 };
const DOGE = { sizing: P2PKH_SIZING, dustSat: 1_000_000 };

describe("sizing is honoured, not assumed", () => {
  it("charges a legacy input more than a SegWit one", () => {
    // If sizing were ignored (or defaulted), these two would be equal and a
    // DOGE/DASH/BCH send would underpay on every input.
    const candidates = [utxo(1, 50_000_000)];
    const segwit = planAccountSpend({ candidates, sendSat: 1_000_000, feePerVB: 5, ...SEGWIT });
    const legacy = planAccountSpend({ candidates, sendSat: 1_000_000, feePerVB: 5, ...LEGACY });
    expect(legacy.feeSat).toBeGreaterThan(segwit.feeSat);
    // 11 + 68 + 62 = 141 vB @5 = 705 ; 10 + 148 + 68 = 226 vB @5 = 1130
    expect(segwit.feeSat).toBe(705);
    expect(legacy.feeSat).toBe(1_130);
  });

  it("matches doge-wallet's own estimateTxBytes for legacy sizing", () => {
    // `estimateTxBytes` there is `10 + 148*in + 34*out`. If these ever drift,
    // one send path prices a transaction differently from the other in the
    // same file, which is the kind of disagreement nobody notices until a tx
    // sticks.
    const three = [utxo(1, 5e8), utxo(2, 5e8), utxo(3, 5e8)];
    const plan = planAccountSpend({
      candidates: three,
      sendSat: 1_400_000_000,
      feePerVB: 1,
      ...LEGACY,
    });
    expect(plan.inputs).toHaveLength(3);
    expect(plan.feeSat).toBe(10 + 148 * 3 + 34 * 2);
  });
});

describe("dust threshold is per-chain", () => {
  it("keeps a 600-sat change output on a 546-dust chain", () => {
    const fee = 11 + 68 + 62; // 141 vB at 1 sat/vB
    const plan = planAccountSpend({
      candidates: [utxo(1, 100_000)],
      sendSat: 100_000 - fee - 600,
      feePerVB: 1,
      ...SEGWIT,
    });
    expect(plan.changeSat).toBe(600);
  });

  it("folds that same 600 into the fee on DOGE", () => {
    // The parameter actually doing something. 600 is far below Dogecoin Core's
    // 0.01 DOGE floor, so emitting it would cost more than it is worth.
    const fee = 10 + 148 + 68; // 226 vB at 1 sat/vB
    const plan = planAccountSpend({
      candidates: [utxo(1, 100_000)],
      sendSat: 100_000 - fee - 600,
      feePerVB: 1,
      ...DOGE,
    });
    expect(plan.changeSat).toBe(0);
    expect(plan.feeSat).toBe(fee + 600);
  });

  it("keeps change on DOGE once it clears 0.01 DOGE", () => {
    const plan = planAccountSpend({
      candidates: [utxo(1, 500_000_000)],
      sendSat: 100_000_000,
      feePerVB: 1,
      ...DOGE,
    });
    expect(plan.changeSat).toBeGreaterThan(1_000_000);
  });
});

describe("invariants that hold for every chain", () => {
  const PROFILES = [
    ["segwit", SEGWIT],
    ["legacy", LEGACY],
    ["doge", DOGE],
  ] as const;

  it("conserves value exactly — inputs = amount + fee + change", () => {
    // Nothing may vanish between selection and the transaction builder.
    const candidates = [utxo(1, 402_888_049), utxo(2, 2_015_766), utxo(3, 823_041)];
    for (const [name, profile] of PROFILES) {
      for (const sendSat of [50_000, 1_000_000, 402_000_000, 405_000_000]) {
        const plan = planAccountSpend({ candidates, sendSat, feePerVB: 3, ...profile });
        expect(plan.covered, `${name} @ ${sendSat}`).toBe(true);
        const inputTotal = plan.inputs.reduce((t, i) => t + i.valueSat, 0);
        expect(inputTotal, `${name} @ ${sendSat}`).toBe(
          sendSat + plan.feeSat + plan.changeSat,
        );
      }
    }
  });

  it("never selects an input it does not need", () => {
    const candidates = [utxo(1, 402_888_049), utxo(2, 2_015_766), utxo(3, 823_041)];
    for (const [name, profile] of PROFILES) {
      const plan = planAccountSpend({ candidates, sendSat: 1_000, feePerVB: 1, ...profile });
      expect(plan.inputs, name).toHaveLength(1);
      expect(plan.inputs[0].valueSat, name).toBe(402_888_049);
    }
  });

  it("refuses rather than building an under-funded transaction", () => {
    for (const [name, profile] of PROFILES) {
      const plan = planAccountSpend({
        candidates: [utxo(1, 100_000_000)],
        sendSat: 100_000_000, // exactly the balance — the fee has nowhere to come from
        feePerVB: 5,
        ...profile,
      });
      expect(plan.covered, name).toBe(false);
      expect(plan.shortfallSat, name).toBe(plan.feeSat);
    }
  });
});

describe("every account-aware chain also spends account-wide", () => {
  // The pairing that matters. A chain with an account-wide BALANCE and a
  // single-address SEND displays money it cannot spend — the exact 2026-08-25
  // LTC failure. RVN is the deliberate exception: it gained the balance half
  // today and its send half is tracked separately.
  const EXPECTED_BOTH = [
    "bitcoin",
    "litecoin",
    "dogecoin",
    "dash",
    "bitcoin-cash",
  ] as const;

  for (const chain of EXPECTED_BOTH) {
    it(`${chain} has both halves`, () => {
      const a = getAdapter(chain);
      expect(a.utxoAccounts, `${chain} lost its account spec`).toBeTruthy();
      expect(typeof a.sendFromAccount, `${chain} lost account-wide send`).toBe("function");
      expect(typeof a.supportsAccountSend, `${chain} lost its account guard`).toBe(
        "function",
      );
    });
  }

  it("ravencoin is balance-only, and that is a known gap not a silent one", () => {
    const a = getAdapter("ravencoin");
    expect(a.utxoAccounts, "RVN account-wide balance shipped 2026-08-25").toBeTruthy();
    // If this ever flips, delete this test and add "ravencoin" to EXPECTED_BOTH
    // above — do not just update the expectation, because the pairing is the
    // point.
    expect(a.sendFromAccount).toBeUndefined();
  });
});
