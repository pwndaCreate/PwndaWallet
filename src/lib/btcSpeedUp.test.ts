/**
 * The "Speed up" steps as the screens use them (operator request,
 * 2026-10-01): which history rows are offered it, the state machine behind
 * the panel, and the figures the review shows. The transaction work is
 * faked here (`btc-rbf.test.ts` runs the real one); what is pinned is the
 * order of things — one confirm, one send, the fee the user saw — and the
 * words.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createSpeedUpController,
  formatUsd,
  secretOf,
  speedUpCandidate,
  speedUpFigures,
  type SpeedUpDeps,
  type SpeedUpState,
} from "./btcSpeedUp";
import { BtcSpeedUpRefusal, type BtcSpeedUpQuote } from "../wallets/btc-rbf";
import { SendOutcomeUnknownError } from "../wallets/send-outcome";
import type { ChainTx, TxResult, WalletInfo } from "../wallets/types";

const TXID = "31".repeat(32);
const NEW = "32".repeat(32);

const QUOTE: BtcSpeedUpQuote = {
  txid: TXID,
  originalFeeSat: 282,
  originalVsize: 141,
  currentRate: 2,
  replacementVsize: 141,
  minimumFeeSat: 423,
  minimumRate: 3,
  targetRate: 14,
  newFeeSat: 1974,
  newRate: 14,
  extraFeeSat: 1692,
  atMinimum: false,
  change: { vout: 1, address: "bc1qchange", beforeSat: 999_718, afterSat: 998_026 },
  recipients: [{ vout: 0, address: "bc1qdeposit", valueSat: 1_000_000 }],
};

const row = (over: Partial<ChainTx>): ChainTx => ({
  chain: "bitcoin",
  hash: TXID,
  direction: "pending",
  amount: "0.01",
  confirmations: 0,
  ...over,
});

describe("speedUpCandidate: an unconfirmed BTC transaction the wallet sent", () => {
  it("a pending send (the account merge's netDirection, or a negative per-address net) is a candidate", () => {
    expect(speedUpCandidate(row({ meta: { netDirection: "out" } }))).toBe(true);
    expect(speedUpCandidate(row({ meta: { netDirection: "self" } }))).toBe(true);
    expect(speedUpCandidate(row({ meta: { netSat: -1_000_282 } }))).toBe(true);
    expect(speedUpCandidate(row({ direction: "out", confirmations: 0 }))).toBe(true);
  });

  it("a receipt, a mined row, another chain, or a row that does not say which way it went is not", () => {
    expect(speedUpCandidate(row({ meta: { netDirection: "in" } }))).toBe(false);
    expect(speedUpCandidate(row({ meta: { netSat: 5 } }))).toBe(false);
    expect(speedUpCandidate(row({ direction: "out", confirmations: undefined, height: 900_000 }))).toBe(false);
    expect(speedUpCandidate(row({ direction: "out", confirmations: 3 }))).toBe(false);
    expect(speedUpCandidate(row({ chain: "litecoin", meta: { netDirection: "out" } }))).toBe(false);
    expect(speedUpCandidate(row({}))).toBe(false);
  });
});

describe("secretOf: what signs", () => {
  const w = (over: Partial<WalletInfo>): WalletInfo => ({ chain: "bitcoin", address: "bc1q", mnemonic: "", privateKey: "", ...over });
  it("the phrase, else the key, never a watch-only entry", () => {
    expect(secretOf(w({ mnemonic: "abandon x", privateKey: "11" }))).toEqual({ mnemonic: "abandon x" });
    expect(secretOf(w({ privateKey: "11" }))).toEqual({ privateKey: "11" });
    expect(secretOf(w({ mnemonic: "abandon x", watchOnly: true }))).toBeNull();
    expect(secretOf(null)).toBeNull();
  });
});

function harness(over: Partial<SpeedUpDeps> = {}) {
  const states: SpeedUpState[] = [];
  const deps: SpeedUpDeps = {
    fastRate: vi.fn(async () => 14),
    usdPrice: vi.fn(async () => 95_400),
    quote: vi.fn(async () => QUOTE),
    send: vi.fn(async () => ({ hash: NEW, pending: true, replaces: TXID })),
    ...over,
  };
  const c = createSpeedUpController({ txid: TXID, secret: { mnemonic: "m" } }, deps, (s) => states.push(s));
  return { c, deps, states, phases: () => states.map((s) => s.phase) };
}

describe("the steps: check → ready → review → sending → sent", () => {
  it("asks for the fast rate, quotes at it, and sends at the same rate for the fee the review showed", async () => {
    const h = harness();
    await h.c.check();
    expect(h.deps.quote).toHaveBeenCalledWith(expect.objectContaining({ txid: TXID, targetRate: 14 }));
    expect(h.c.state).toMatchObject({ phase: "ready", usdPrice: 95_400 });
    h.c.review();
    await h.c.confirm();
    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(h.deps.send).toHaveBeenCalledWith(expect.objectContaining({ txid: TXID, targetRate: 14, expectFeeSat: 1974 }));
    expect(h.c.state).toMatchObject({ phase: "sent", newTxid: NEW });
    expect(h.phases()).toEqual(["checking", "ready", "review", "sending", "sent"]);
  });

  it("confirm does nothing until the review is open, and a second press while sending sends nothing", async () => {
    let release!: () => void;
    const h = harness({
      send: vi.fn(
        () =>
          new Promise<TxResult & { replaces: string }>(
            (r) => (release = () => r({ hash: NEW, pending: true, replaces: TXID })),
          ),
      ),
    });
    await h.c.check();
    await h.c.confirm(); // from "ready": ignored
    expect(h.deps.send).not.toHaveBeenCalled();
    h.c.review();
    const first = h.c.confirm();
    const second = h.c.confirm();
    release();
    await Promise.all([first, second]);
    expect(h.deps.send).toHaveBeenCalledTimes(1);
  });

  it("cancel returns to the button; nothing is sent", async () => {
    const h = harness();
    await h.c.check();
    h.c.review();
    h.c.cancel();
    expect(h.c.state.phase).toBe("ready");
    expect(h.deps.send).not.toHaveBeenCalled();
  });

  it("no fee estimate: quoted at the replacement minimum (targetRate null), and sent the same way", async () => {
    const h = harness({ fastRate: vi.fn(async () => null) });
    await h.c.check();
    expect(h.deps.quote).toHaveBeenCalledWith(expect.objectContaining({ targetRate: null }));
    h.c.review();
    await h.c.confirm();
    expect(h.deps.send).toHaveBeenCalledWith(expect.objectContaining({ targetRate: null }));
  });
});

describe("when it cannot be done", () => {
  it("a refusal is shown in its words — or not at all when the transaction is not the wallet's to touch", async () => {
    const said = harness({ quote: vi.fn(async () => Promise.reject(new BtcSpeedUpRefusal("no-change", "No change output."))) });
    await said.c.check();
    expect(said.c.state).toEqual({ phase: "unavailable", code: "no-change", reason: "No change output.", quiet: false });
    const quiet = harness({ quote: vi.fn(async () => Promise.reject(new BtcSpeedUpRefusal("not-own-tx", "x"))) });
    await quiet.c.check();
    expect(quiet.c.state).toMatchObject({ phase: "unavailable", quiet: true });
  });

  it("explorers not answering is an error that can be checked again", async () => {
    const quote = vi.fn<SpeedUpDeps["quote"]>().mockRejectedValueOnce(new Error("HTTP 503")).mockResolvedValueOnce(QUOTE);
    const h = harness({ quote });
    await h.c.check();
    expect(h.c.state).toEqual({ phase: "error", reason: "HTTP 503" });
    await h.c.check();
    expect(h.c.state.phase).toBe("ready");
  });

  it("a send refused before it reached the network: 'not sent', and it may be checked again", async () => {
    const h = harness({ send: vi.fn(async () => Promise.reject(new Error("BTC: … nothing was sent — insufficient fee"))) });
    await h.c.check();
    h.c.review();
    await h.c.confirm();
    expect(h.c.state).toMatchObject({ phase: "failed", reason: "BTC: … nothing was sent — insufficient fee" });
    await h.c.check();
    expect(h.c.state.phase).toBe("ready");
  });

  it("a send that MAY have reached the network is never offered again from this panel", async () => {
    const h = harness({
      send: vi.fn(async () => Promise.reject(new SendOutcomeUnknownError("BTC transaction … may have been sent", NEW))),
    });
    await h.c.check();
    h.c.review();
    await h.c.confirm();
    expect(h.c.state).toEqual({ phase: "unknown", reason: "BTC transaction … may have been sent", newTxid: NEW });
    await h.c.check();
    h.c.review();
    await h.c.confirm();
    expect(h.c.state.phase).toBe("unknown");
    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(h.deps.quote).toHaveBeenCalledTimes(1);
  });

  it("nothing is emitted after the panel goes away", async () => {
    const h = harness();
    const p = h.c.check(); // "checking" is emitted at once
    h.c.dispose();
    await p;
    expect(h.phases()).toEqual(["checking"]); // the quote's "ready" reaches no one
  });
});

describe("what the review shows", () => {
  it("the current and new rate, the new and extra fee in BTC and USD, the change before and after", () => {
    expect(speedUpFigures(QUOTE, 95_400)).toEqual({
      currentRate: "2.0 sat/vB",
      newRate: "14.0 sat/vB",
      newRateSource: "the network's fast rate",
      newFee: "0.00001974 BTC",
      newFeeUsd: "$1.88",
      extraFee: "0.00001692 BTC",
      extraFeeUsd: "$1.61",
      changeBefore: "0.00999718 BTC",
      changeAfter: "0.00998026 BTC",
    });
  });

  it("says when the minimum is paid instead of the fast rate, and drops USD without a price", () => {
    const f = speedUpFigures({ ...QUOTE, atMinimum: true, newRate: 3, targetRate: 2 }, null);
    expect(f.newRateSource).toBe("the least a replacement may pay (the network's fast rate, 2.0 sat/vB, is lower)");
    expect(f.newFeeUsd).toBeNull();
    expect(speedUpFigures({ ...QUOTE, targetRate: null }, 1).newRateSource).toMatch(/could not be read/);
  });

  it("formatUsd", () => {
    expect(formatUsd(0.004)).toBe("< $0.01");
    expect(formatUsd(1.884)).toBe("$1.88");
    expect(formatUsd(12_345.6)).toBe("$12,346");
  });
});
