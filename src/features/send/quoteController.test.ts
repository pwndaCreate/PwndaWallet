/**
 * Send-modal quote timing (2026-09-15, Zephyr send pricing).
 *
 * Before this the Zephyr Send modal showed no fee at all: its estimate called a
 * daemon method the wallet-rpc does not have. The fee is now the fee of the
 * actual transaction, built without broadcasting. Each rule below is a way that
 * could go wrong without any error on screen: a wallet call per keystroke, a
 * slow answer for old inputs displayed against new ones, two builds racing on
 * the wallet-rpc, or a pricing failure blocking a send it has no bearing on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_QUOTE,
  createQuoteController,
  quotableInputs,
  type QuoteInputs,
  type QuoteSnapshot,
} from "./quoteController";
import { SendQuoteError } from "../../wallets/send-quote";
import type { SendQuote } from "../../wallets/types";

const TO = "ZEPHYR2qjmpfgEjnpvUnmcW84J5q3uvP5Z5oc8h6F9zsTrhpFkPg";

const mkQuote = (amount: string): SendQuote => ({
  to: TO,
  amount,
  fee: "0.0012",
  feeTicker: "ZEPH",
  quotedAt: Date.now(),
  ticket: { amount },
});

function harness(impl: (i: QuoteInputs) => Promise<SendQuote>) {
  const snaps: QuoteSnapshot[] = [];
  const quote = vi.fn(impl);
  const ctrl = createQuoteController({ quote, onChange: (s) => snaps.push(s) });
  const last = () => snaps[snaps.length - 1] ?? EMPTY_QUOTE;
  return { ctrl, quote, snaps, last };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("quotableInputs", () => {
  it("waits for a plausible recipient and a positive plain decimal", () => {
    expect(quotableInputs("", "1")).toBeNull();
    expect(quotableInputs("ZEPHYR2qjm", "1")).toBeNull();
    expect(quotableInputs(`${TO} x`, "1")).toBeNull();
    expect(quotableInputs(TO, "")).toBeNull();
    expect(quotableInputs(TO, "0")).toBeNull();
    expect(quotableInputs(TO, "0.000")).toBeNull();
    expect(quotableInputs(TO, "1.2.3")).toBeNull();
    expect(quotableInputs(TO, "-1")).toBeNull();
    expect(quotableInputs(TO, "1e3")).toBeNull();
  });

  it("trims what it passes on and carries the asset", () => {
    expect(quotableInputs(`  ${TO} `, " 0.5 ", "ZSD")).toEqual({
      to: TO,
      amount: "0.5",
      assetType: "ZSD",
    });
    expect(quotableInputs(TO, "0.001")).toEqual({ to: TO, amount: "0.001" });
  });
});

describe("createQuoteController", () => {
  it("does not call the wallet until typing has paused for 600 ms", async () => {
    const h = harness(async (i) => mkQuote(i.amount));
    h.ctrl.setInputs({ to: TO, amount: "1" });
    await vi.advanceTimersByTimeAsync(300);
    h.ctrl.setInputs({ to: TO, amount: "12" });
    await vi.advanceTimersByTimeAsync(599);
    expect(h.quote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.quote).toHaveBeenCalledTimes(1);
    expect(h.quote).toHaveBeenCalledWith({ to: TO, amount: "12" });
    expect(h.last()).toMatchObject({ pending: false, failure: null, quote: { amount: "12" } });
  });

  it("drops the old quote the moment the inputs change", async () => {
    const h = harness(async (i) => mkQuote(i.amount));
    h.ctrl.setInputs({ to: TO, amount: "1" });
    await vi.advanceTimersByTimeAsync(600);
    expect(h.last().quote?.amount).toBe("1");
    h.ctrl.setInputs({ to: TO, amount: "2" });
    expect(h.last()).toMatchObject({ quote: null, pending: true, inputs: { amount: "2" } });
  });

  it("treats identical inputs as no change (no extra wallet call)", async () => {
    const h = harness(async (i) => mkQuote(i.amount));
    h.ctrl.setInputs({ to: TO, amount: "1" });
    await vi.advanceTimersByTimeAsync(600);
    h.ctrl.setInputs({ to: TO, amount: "1" });
    await vi.advanceTimersByTimeAsync(600);
    expect(h.quote).toHaveBeenCalledTimes(1);
  });

  it("re-prices every 60 s while the inputs stand", async () => {
    const h = harness(async (i) => mkQuote(i.amount));
    h.ctrl.setInputs({ to: TO, amount: "1" });
    await vi.advanceTimersByTimeAsync(600);
    expect(h.quote).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.quote).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.quote).toHaveBeenCalledTimes(3);
  });

  it("never shows an answer that arrives after the inputs changed", async () => {
    let resolveFirst!: (q: SendQuote) => void;
    const h = harness((i) =>
      i.amount === "1"
        ? new Promise<SendQuote>((r) => {
            resolveFirst = r;
          })
        : Promise.resolve(mkQuote(i.amount)),
    );
    h.ctrl.setInputs({ to: TO, amount: "1" });
    await vi.advanceTimersByTimeAsync(600); // the "1" build is now in flight
    h.ctrl.setInputs({ to: TO, amount: "2" });
    const changedAt = h.snaps.length;
    resolveFirst(mkQuote("1"));
    await vi.advanceTimersByTimeAsync(600);
    const afterChange = h.snaps.slice(changedAt);
    expect(afterChange.some((s) => s.quote?.amount === "1")).toBe(false);
    expect(h.last()).toMatchObject({ inputs: { amount: "2" }, quote: { amount: "2" } });
  });

  it("never runs two wallet builds at once", async () => {
    // A slow wallet: every build takes 5 s.
    const h = harness(
      (i) => new Promise<SendQuote>((r) => setTimeout(() => r(mkQuote(i.amount)), 5_000)),
    );
    h.ctrl.setInputs({ to: TO, amount: "1" });
    await vi.advanceTimersByTimeAsync(600); // build 1 starts
    h.ctrl.setInputs({ to: TO, amount: "2" });
    await vi.advanceTimersByTimeAsync(600); // debounce for "2" fires mid-build
    expect(h.quote).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_400); // build 1 settles; "2" starts only now
    expect(h.quote).toHaveBeenCalledTimes(2);
    expect(h.quote.mock.calls[1][0]).toEqual({ to: TO, amount: "2" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.last()).toMatchObject({ pending: false, quote: { amount: "2" } });
  });

  it("blocks on insufficient funds or a bad address, advises on everything else", async () => {
    const cases: Array<[unknown, { kind: string; definitive: boolean; message: string }]> = [
      [
        new SendQuoteError("insufficient-funds", "Not enough unlocked ZEPHUSD."),
        { kind: "insufficient-funds", definitive: true, message: "Not enough unlocked ZEPHUSD." },
      ],
      [
        new SendQuoteError("invalid-address", "Invalid Zephyr address."),
        { kind: "invalid-address", definitive: true, message: "Invalid Zephyr address." },
      ],
      [
        new SendQuoteError("not-ready", "Zephyr wallet is still syncing."),
        { kind: "not-ready", definitive: false, message: "Zephyr wallet is still syncing." },
      ],
      // A Tauri string rejection: advisory, and its text shown verbatim.
      [
        "RPC error -32601: Method not found",
        { kind: "other", definitive: false, message: "RPC error -32601: Method not found" },
      ],
    ];
    for (const [err, expected] of cases) {
      const h = harness(() => Promise.reject(err));
      h.ctrl.setInputs({ to: TO, amount: "1" });
      await vi.advanceTimersByTimeAsync(600);
      expect(h.last()).toMatchObject({ pending: false, quote: null, failure: expected });
      h.ctrl.dispose();
    }
  });

  it("clears and stops re-pricing when the inputs stop being quotable", async () => {
    const h = harness(async (i) => mkQuote(i.amount));
    h.ctrl.setInputs({ to: TO, amount: "1" });
    await vi.advanceTimersByTimeAsync(600);
    h.ctrl.setInputs(null);
    expect(h.last()).toEqual(EMPTY_QUOTE);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.quote).toHaveBeenCalledTimes(1);
  });

  it("retry re-prices immediately", async () => {
    const h = harness(async (i) => mkQuote(i.amount));
    h.ctrl.setInputs({ to: TO, amount: "1" });
    await vi.advanceTimersByTimeAsync(600);
    h.ctrl.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.quote).toHaveBeenCalledTimes(2);
  });

  it("dispose stops every timer and emission", async () => {
    const h = harness(async (i) => mkQuote(i.amount));
    h.ctrl.setInputs({ to: TO, amount: "1" });
    const emitted = h.snaps.length;
    h.ctrl.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.quote).not.toHaveBeenCalled();
    expect(h.snaps.length).toBe(emitted);
  });
});
