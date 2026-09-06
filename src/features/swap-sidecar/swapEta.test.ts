import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCK_SECONDS,
  CONFIRMATIONS,
  elapsedSeconds,
  etaSentence,
  etaStanding,
  etaWindow,
  formatElapsed,
  formatEtaWindow,
} from "./swapEta";

const REPO = path.resolve(__dirname, "..", "..", "..");

describe("etaWindow", () => {
  it("reproduces the one swap we actually measured", () => {
    // bid 000000006a9c5eaa…, 0.04 BCH → 0.01862 XMR, created 18:25 UTC
    // 2026-09-05, completed ~19:02 UTC. 37 minutes, wall clock.
    const w = etaWindow("BCH", "XMR");
    expect(w).not.toBeNull();
    // 2 * (1 lock * 600s + 3 locks * 120s) = 1920s = 32 min.
    expect(w!.typicalSec).toBe(1920);
    const measuredSec = 37 * 60;
    // The measurement must land inside the window — that is the whole claim
    // the estimate makes. If a table edit pushes the real swap outside it,
    // this goes red rather than the user quietly being told "overdue".
    expect(measuredSec).toBeGreaterThan(w!.typicalSec * 0.5);
    expect(measuredSec).toBeLessThanOrEqual(w!.highSec);
    // ...and must therefore read as ON TRACK. A real, healthy swap being
    // graded "slow" while the UI beside it says "usually 30-60 min" is the
    // incoherence this assertion exists to prevent.
    expect(etaStanding(measuredSec, w)).toBe("onTrack");
  });

  it("is symmetric — the direction does not change the physics", () => {
    expect(etaWindow("XMR", "BCH")).toEqual(etaWindow("BCH", "XMR"));
  });

  it("is case- and whitespace-insensitive about tickers", () => {
    expect(etaWindow(" bch ", "xmr")).toEqual(etaWindow("BCH", "XMR"));
  });

  /**
   * The regression that a green unit test could not have caught, because the
   * unit test wrote tickers and the app passes NAMES.
   * `SidecarTrackedSwap.sendCoin` is upstream's `coin_to`, which reads
   * "Litecoin". The first cut upcased it, got "LITECOIN", missed the table,
   * and dropped the estimate from every in-flight card while the timer beside
   * it still worked — which is exactly why it survived to the sandbox.
   */
  it("takes upstream's display names, which is what the tracker actually holds", () => {
    expect(etaWindow("Litecoin", "Monero")).toEqual(etaWindow("LTC", "XMR"));
    expect(etaWindow("Bitcoin Cash", "Monero")).toEqual(etaWindow("BCH", "XMR"));
    expect(etaWindow("Zano", "Bitcoin")).toEqual(etaWindow("ZANO", "BTC"));
  });

  it("says nothing rather than guessing for a coin it has no depth for", () => {
    // Every non-Grove coin the swap form can name reaches here eventually.
    expect(etaWindow("BCH", "DOGE")).toBeNull();
    expect(etaWindow("ETH", "XMR")).toBeNull();
    expect(etaWindow("", "XMR")).toBeNull();
  });

  it("prices the slow-confirmation chains as slower", () => {
    const zano = etaWindow("BCH", "ZANO")!; // 10 confirmations at 60s
    const xmr = etaWindow("BCH", "XMR")!; //  3 confirmations at 120s
    expect(zano.typicalSec).toBeGreaterThan(xmr.typicalSec);
    const ltc = etaWindow("LTC", "XMR")!; // 2 at 150s beats 1 at 600s
    expect(ltc.typicalSec).toBeLessThan(xmr.typicalSec);
  });
});

describe("the confirmation table mirrors the engine, not a guess", () => {
  /**
   * ZEPH and ZANO are coins WE added to the engine, so their depths have a
   * source in this repo. If a patch changes one, this table is wrong and the
   * estimate silently drifts — so read the patch rather than trusting the
   * copy.
   */
  it("agrees with the Zephyr and Zano coin-module patches", () => {
    const cases: Array<[string, string, number]> = [
      ["upstream/patches/0013-zephyr-coin-module.patch", "ZEPH", CONFIRMATIONS.ZEPH],
      ["upstream/patches/0015-zano-coin-module.patch", "ZANO", CONFIRMATIONS.ZANO],
    ];
    for (const [rel, ticker, expected] of cases) {
      const src = readFileSync(path.join(REPO, rel), "utf8");
      const depths = [...src.matchAll(/"blocks_confirmed":\s*(\d+)/g)].map((m) =>
        Number(m[1]),
      );
      expect(depths.length, `${rel} declares no blocks_confirmed`).toBeGreaterThan(0);
      expect(
        depths,
        `${ticker} is ${expected} in swapEta.ts but ${depths} in ${rel}`,
      ).toContain(expected);
    }
  });

  it("has a block time for every coin it has a confirmation depth for", () => {
    for (const ticker of Object.keys(CONFIRMATIONS)) {
      expect(BLOCK_SECONDS[ticker], `${ticker} has no block time`).toBeGreaterThan(0);
    }
  });
});

describe("elapsedSeconds", () => {
  const now = 1_788_640_000_000; // ms

  it("counts from the engine's unix seconds", () => {
    expect(elapsedSeconds(1_788_639_400, now)).toBe(600);
  });

  it("clamps a small clock skew to zero rather than showing a negative", () => {
    expect(elapsedSeconds(Math.floor(now / 1000) + 20, now)).toBe(0);
  });

  it("refuses a timestamp it cannot believe", () => {
    expect(elapsedSeconds(0, now)).toBeNull();
    expect(elapsedSeconds(Number.NaN, now)).toBeNull();
    // Well in the future: not skew, a different unit or a different field.
    expect(elapsedSeconds(Math.floor(now / 1000) + 3600, now)).toBeNull();
  });
});

describe("formatting", () => {
  it("shows seconds for the first minute, then minutes and seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(42)).toBe("42s");
    expect(formatElapsed(252)).toBe("4m 12s");
    expect(formatElapsed(605)).toBe("10m 05s");
  });

  it("switches to hours past sixty minutes", () => {
    expect(formatElapsed(3960)).toBe("1h 06m");
  });

  it("renders the window in round five-minute steps", () => {
    expect(formatEtaWindow(etaWindow("BCH", "XMR")!)).toBe("about 30–60 min");
  });
});

describe("etaSentence", () => {
  const w = etaWindow("BCH", "XMR")!;

  it("never tells the user a slow swap is a broken one", () => {
    for (const elapsed of [60, w.highSec + 60, w.highSec * 3]) {
      const s = etaSentence(elapsed, w);
      expect(s).not.toMatch(/fail|stuck|lost|error/i);
    }
    // Past the window it must say what protects them, not just "late".
    expect(etaSentence(w.highSec * 3, w)).toMatch(/timelock/);
    // The middle band is reassuring, not alarming.
    expect(etaSentence(w.highSec + 60, w)).toMatch(/nothing to do/i);
  });

  it("still says something useful with no window and no clock", () => {
    expect(etaSentence(null, null)).toMatch(/background/);
  });
});

describe("the locked-and-waiting state", () => {
  it("is keyed on the state id, not on upstream's prose", async () => {
    const { counterpartyHoldsLockedFunds, refundDeadlineLabel } = await import(
      "./SidecarSwapTracker"
    );
    // The live 2026-09-05 bid: state 11, both locks confirmed, offerer quiet.
    expect(counterpartyHoldsLockedFunds({ bid_state_ind: 11 })).toBe(true);
    // Everything else, including the stage that LOOKS the same in the UI
    // ("waiting for the other user") but has no funds committed.
    for (const ind of [0, 1, 8, 9, 20, 31, undefined]) {
      expect(counterpartyHoldsLockedFunds({ bid_state_ind: ind }), String(ind)).toBe(false);
    }
    expect(counterpartyHoldsLockedFunds(null)).toBe(false);

    // The deadline is quoted against the CHAIN's clock, which trails real
    // time — a wall-clock countdown would promise the refund early. Rendered
    // in UTC and labelled as such: the upstream console renders the same
    // instant in LOCAL time (it showed 18:51 for this bid, at UTC-4), and an
    // unlabelled timestamp that disagrees with the console by four hours is
    // worse than either convention on its own.
    expect(
      refundDeadlineLabel({
        coin_a_lock_refund_tx_est_final: 1_788_735_095,
        coin_a_last_median_time: 1_788_653_161,
      }),
    ).toBe("2026-09-06 22:51 UTC — about 23h of chain time away");
    // No median time: the stamp alone, never an invented countdown.
    expect(
      refundDeadlineLabel({ coin_a_lock_refund_tx_est_final: 1_788_735_095 }),
    ).toBe("2026-09-06 22:51 UTC");
    expect(refundDeadlineLabel(null)).toMatch(/as soon as the chain allows/);
  });
});
