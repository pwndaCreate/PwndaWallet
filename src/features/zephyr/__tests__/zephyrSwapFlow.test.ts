/**
 * The Zephyr conversion modal's quote → confirm → relay sequence
 * (2026-09-29 send-safety audit, findings 2 and 9).
 *
 * Found by reading the modal's handlers: the silent 60 s re-quote, if in
 * flight when Confirm was pressed, resolved DURING "submitting" and put the
 * modal back into "quote" with a new signed transaction and a live Confirm
 * while the first relay was still running — a second press converted twice.
 * Confirm also had no age limit, so after a failed silent re-quote an
 * arbitrarily old quote stayed relayable. And MAX filled the whole unlocked
 * balance although the fee is paid in the source asset.
 *
 * Operator request, 2026-10-01: build the conversion once. Every build asks the
 * node for the coins it spends with fresh decoys, and the modal rebuilt the
 * shown conversion every 60 s and again whenever Confirm found it 90 s old: a
 * node that compares those requests can tell which coins are the wallet's. Now
 * nothing builds in the background, Review of the same inputs shows the same
 * build, and Confirm never builds — past the 5-minute window it sends nothing
 * and asks for a new review.
 *
 * `createSwapFlow` is the modal's sequencing, free of React; the modal only
 * wires it to state. Builds and relays are deferred promises here, so every
 * interleaving is explicit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("../../../utils/openExternal", () => ({ openExternal: vi.fn() }));
vi.mock("../../../wallets/zph-wallet", () => ({
  getZphSessionEpoch: vi.fn(() => 1),
  relayZphTransaction: vi.fn(),
  getZphFeeRate: vi.fn(),
  zphConversionFeeEstimate: vi.fn(),
}));

import { SendOutcomeUnknownError } from "../../../wallets/send-outcome";
import type { TxResult } from "../../../wallets/types";
import {
  ZPH_CONVERSION_FEE_RESERVE_ATOMIC,
  conversionFeeReserve,
  createSwapFlow,
  maxConvertibleAmount,
  swapQuoteIsFresh,
  type SwapModalState,
  type SwapQuote,
} from "../ZephyrSwapModal";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const quoteOf = (txHash: string, quotedAt: number): SwapQuote => ({
  response: { tx_hash: txHash, tx_key: "k", amount: 1e12, fee: 25_400_000, tx_metadata: `meta-${txHash}` },
  quotedAt,
  epoch: 1,
});

const MIN = 60_000;

function harness(start = 1_000_000) {
  let now = start;
  let key = "ZEPHYR2dest|1.5|ZPH|ZSD|1";
  const builds: Deferred<SwapQuote>[] = [];
  const relayed: SwapQuote[] = [];
  const relays: Deferred<TxResult>[] = [];
  const states: SwapModalState[] = [];
  const flow = createSwapFlow({
    build: () => {
      const d = deferred<SwapQuote>();
      builds.push(d);
      return d.promise;
    },
    relay: (q) => {
      relayed.push(q);
      const d = deferred<TxResult>();
      relays.push(d);
      return d.promise;
    },
    onChange: (s) => states.push(s),
    inputsKey: () => key,
    now: () => now,
  });
  return {
    flow,
    builds,
    relayed,
    relays,
    states,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    setKey: (k: string) => {
      key = k;
    },
  };
}

/** Review: the build the press starts, resolved as `txHash`. */
async function reviewed(h: ReturnType<typeof harness>, txHash: string) {
  const p = h.flow.quote();
  h.builds[h.builds.length - 1].resolve(quoteOf(txHash, h.now()));
  await p;
  expect(h.flow.state()).toMatchObject({ kind: "quote", loading: false });
}

describe("one build per conversion (operator request, 2026-10-01)", () => {
  it("Confirm relays a build two minutes old exactly as built: nothing is rebuilt", async () => {
    const h = harness();
    await reviewed(h, "Q1");
    h.advance(2 * MIN);
    const confirm = h.flow.confirm();
    // Was: at 90 s Confirm re-priced — a second build of the same conversion.
    expect(h.builds).toHaveLength(1);
    h.relays[0].resolve({ hash: "Q1" });
    await confirm;
    expect(h.relayed.map((q) => q.response.tx_hash)).toEqual(["Q1"]);
    expect(h.flow.state()).toEqual({ kind: "success", txHash: "Q1", pending: false });
  });

  it("past the 5-minute window Confirm sends nothing and builds nothing: the user reviews again", async () => {
    const h = harness();
    await reviewed(h, "Q1");
    h.advance(6 * MIN);
    const confirm = h.flow.confirm();
    // Checked before awaiting: a Confirm that starts a build (the old one did,
    // at 90 s) never settles here, because the test resolves no second build.
    expect(h.builds).toHaveLength(1);
    await confirm;
    expect(h.relayed).toEqual([]);
    expect(h.flow.state()).toMatchObject({ kind: "error" });
    const message = (h.flow.state() as { message: string }).message;
    expect(message).toMatch(/Nothing was sent/);
    expect(message).toMatch(/review it\s+again/);
    // The user goes back and reviews: that press, and only it, builds again.
    h.flow.edit();
    await reviewed(h, "Q2");
    expect(h.builds).toHaveLength(2);
  });

  it("Review again with the same inputs shows the same build instead of building it twice", async () => {
    const h = harness();
    await reviewed(h, "Q1");
    h.flow.edit(); // ◄ Edit, nothing changed
    const review = h.flow.quote(); // ► Review
    expect(h.builds).toHaveLength(1); // checked before awaiting: a second build would never settle here
    await review;
    expect(h.flow.state()).toMatchObject({ kind: "quote", loading: false, quote: { response: { tx_hash: "Q1" } } });
  });

  it("changed inputs are built once more, on their own Review", async () => {
    const h = harness();
    await reviewed(h, "Q1");
    h.flow.edit();
    h.setKey("ZEPHYR2dest|2|ZPH|ZSD|1");
    await reviewed(h, "Q2");
    expect(h.builds).toHaveLength(2);
    expect(h.flow.state()).toMatchObject({ quote: { response: { tx_hash: "Q2" } } });
  });

  it("a build too old to relay is not offered again by a second Review", async () => {
    const h = harness();
    await reviewed(h, "Q1");
    h.flow.edit();
    h.advance(6 * MIN);
    const p = h.flow.quote();
    expect(h.builds).toHaveLength(2); // built afresh, not the stale Q1
    h.builds[1].resolve(quoteOf("Q2", h.now()));
    await p;
    expect(h.flow.state()).toMatchObject({ quote: { response: { tx_hash: "Q2" } } });
  });

  it("a relayed build is never offered again, whatever the outcome", async () => {
    const h = harness();
    await reviewed(h, "Q1");
    const confirm = h.flow.confirm();
    h.relays[0].reject(new Error("The Zephyr wallet did not broadcast the transaction. Nothing was sent."));
    await confirm;
    h.flow.edit();
    const p = h.flow.quote();
    expect(h.builds).toHaveLength(2);
    h.builds[1].resolve(quoteOf("Q2", h.now()));
    await p;
  });

  it("one press while building is one build", async () => {
    const h = harness();
    const first = h.flow.quote();
    void h.flow.quote(); // a double click
    expect(h.builds).toHaveLength(1);
    h.builds[0].resolve(quoteOf("Q1", h.now()));
    await first;
  });

  it("the boundary: relayable under 5 minutes, never from the future", () => {
    expect(swapQuoteIsFresh(0, 5 * MIN - 1)).toBe(true);
    expect(swapQuoteIsFresh(0, 5 * MIN)).toBe(false);
    expect(swapQuoteIsFresh(10, 0)).toBe(false); // a quote from the future (clock moved)
  });

  it("the modal itself schedules no build: no timer calls quote()", () => {
    const src = readFileSync(join(__dirname, "..", "ZephyrSwapModal.tsx"), "utf8").replace(/\r\n/g, "\n");
    // Was: setInterval(() => { void flowRef.current?.quote(true); }, QUOTE_REFRESH_MS)
    const intervals = src.match(/setInterval\([\s\S]*?\);/g) ?? [];
    expect(intervals.length).toBeGreaterThan(0); // the fee-rate poll is one
    for (const call of intervals) expect(call).not.toMatch(/quote\(/);
    expect(src).not.toMatch(/QUOTE_REFRESH_MS/);
  });
});

describe("the quote generation token (2026-09-29 send-safety audit, finding 2)", () => {
  it("a Review pressed while Confirm relays does nothing: one conversion, no second Confirm", async () => {
    const h = harness();
    await reviewed(h, "Q1");
    const confirm = h.flow.confirm();
    expect(h.flow.state().kind).toBe("submitting");
    await h.flow.quote(); // ignored while relaying
    await h.flow.confirm(); // a second press while relaying does nothing
    expect(h.builds).toHaveLength(1);
    h.relays[0].resolve({ hash: "Q1" });
    await confirm;
    expect(h.relayed.map((q) => q.response.tx_hash)).toEqual(["Q1"]);
    expect(h.flow.state()).toEqual({ kind: "success", txHash: "Q1", pending: false });
  });

  it("drops a build that lands after the user went back to editing", async () => {
    const h = harness();
    const pending = h.flow.quote();
    h.flow.edit();
    h.builds[0].resolve(quoteOf("Q1", h.now()));
    await pending;
    expect(h.flow.state()).toEqual({ kind: "edit" });
  });

  it("drops everything after the modal closes", async () => {
    const h = harness();
    const pending = h.flow.quote();
    const seen = h.states.length;
    h.flow.dispose();
    h.builds[0].resolve(quoteOf("Q1", h.now()));
    await pending;
    expect(h.states.length).toBe(seen);
  });
});

describe("relay outcomes in the conversion modal (2026-09-29)", () => {
  it("an outcome that may have gone out ends in 'unknown' with the txid, with no way back to Confirm", async () => {
    const h = harness();
    await reviewed(h, "Q1");
    const confirm = h.flow.confirm();
    h.relays[0].reject(new SendOutcomeUnknownError("did not confirm the broadcast", "Q1"));
    await confirm;
    expect(h.flow.state()).toMatchObject({ kind: "unknown", txHash: "Q1" });
    // Was: an error state whose "◄ Back" led to Get Quote + Confirm again.
    await h.flow.confirm();
    void h.flow.quote(); // nothing builds after a relay that may have gone out
    expect(h.builds).toHaveLength(1);
    expect(h.flow.state().kind).toBe("unknown");
    expect(h.relayed).toHaveLength(1);
  });

  it("a relay that provably sent nothing is an error the user can go back from", async () => {
    const h = harness();
    await reviewed(h, "Q1");
    const confirm = h.flow.confirm();
    h.relays[0].reject(new Error("The Zephyr wallet did not broadcast the transaction. Nothing was sent."));
    await confirm;
    expect(h.flow.state()).toMatchObject({ kind: "error" });
    h.flow.edit();
    expect(h.flow.state()).toEqual({ kind: "edit" });
  });
});

describe("MAX leaves the fee (2026-09-29 send-safety audit, finding 9)", () => {
  it("keeps the fee reserve back before clamping to 4 decimals", () => {
    // 1.2345 exactly: the old MAX filled 1.2345 and left nothing for the fee.
    expect(maxConvertibleAmount(1_234_500_000_000n, ZPH_CONVERSION_FEE_RESERVE_ATOMIC)).toBe("1.2335");
    expect(maxConvertibleAmount(1_234_567_890_123, ZPH_CONVERSION_FEE_RESERVE_ATOMIC)).toBe("1.2335");
  });

  it("uses a larger reserve when one is given (a quoted fee above the default)", () => {
    expect(maxConvertibleAmount(10_000_000_000_000n, 5_000_000_000n)).toBe("9.995");
  });

  it("offers nothing when the balance cannot cover the fee", () => {
    expect(maxConvertibleAmount(ZPH_CONVERSION_FEE_RESERVE_ATOMIC, ZPH_CONVERSION_FEE_RESERVE_ATOMIC)).toBeNull();
    expect(maxConvertibleAmount(1_000_050_000n, ZPH_CONVERSION_FEE_RESERVE_ATOMIC)).toBeNull(); // 0.00000005 left
    expect(maxConvertibleAmount(0, ZPH_CONVERSION_FEE_RESERVE_ATOMIC)).toBeNull();
  });

  it("reserves the estimate at the busy rate when it is above the fixed 0.001 (2026-10-01)", () => {
    // A two-input conversion at the normal rate measured 2026-10-06:
    // 2,975 × 820,000 = 0.00243950 ZEPH, more than the 0.001 reserve.
    expect(conversionFeeReserve({ estimatedBusy: 2_439_500_000n })).toBe(2_439_500_000n);
    expect(conversionFeeReserve({ quoted: 3_000_000_000n, estimatedBusy: 2_439_500_000n })).toBe(3_000_000_000n);
    expect(conversionFeeReserve({ estimatedBusy: 624_750_000n })).toBe(ZPH_CONVERSION_FEE_RESERVE_ATOMIC);
    expect(conversionFeeReserve({})).toBe(ZPH_CONVERSION_FEE_RESERVE_ATOMIC);
  });
});
