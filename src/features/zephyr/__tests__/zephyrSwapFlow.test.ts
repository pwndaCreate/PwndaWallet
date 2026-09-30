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
 * `createSwapFlow` is the modal's sequencing, free of React; the modal only
 * wires it to state. Builds and relays are deferred promises here, so every
 * interleaving is explicit.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("../../../utils/openExternal", () => ({ openExternal: vi.fn() }));
vi.mock("../../../wallets/zph-wallet", () => ({
  getZphSessionEpoch: vi.fn(() => 1),
  relayZphTransaction: vi.fn(),
}));

import { SendOutcomeUnknownError } from "../../../wallets/send-outcome";
import type { TxResult } from "../../../wallets/types";
import {
  ZPH_CONVERSION_FEE_RESERVE_ATOMIC,
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

function harness(start = 1_000_000) {
  let now = start;
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
  };
}

async function shownQuote(h: ReturnType<typeof harness>, txHash: string) {
  const p = h.flow.quote(false);
  h.builds[h.builds.length - 1].resolve(quoteOf(txHash, h.now()));
  await p;
  expect(h.flow.state()).toMatchObject({ kind: "quote", loading: false });
}

describe("the quote generation token (2026-09-29 send-safety audit, finding 2)", () => {
  it("drops a re-quote that lands while Confirm is relaying: one conversion, no second Confirm", async () => {
    const h = harness();
    await shownQuote(h, "Q1");

    const refresh = h.flow.quote(true); // the silent 60 s re-quote starts…
    const confirm = h.flow.confirm(); // …and Confirm is pressed while it runs
    expect(h.flow.state().kind).toBe("submitting");

    h.builds[1].resolve(quoteOf("Q2", h.now())); // the re-quote lands mid-relay
    await refresh;
    // Was: back to "quote" with Q2 and a live Confirm, so a second press relayed Q2 too.
    expect(h.flow.state().kind).toBe("submitting");
    await h.flow.confirm(); // a second press while relaying does nothing

    h.relays[0].resolve({ hash: "Q1" });
    await confirm;
    expect(h.relayed.map((q) => q.response.tx_hash)).toEqual(["Q1"]);
    expect(h.flow.state()).toEqual({ kind: "success", txHash: "Q1", pending: false });
    expect(h.states.some((s) => s.kind === "quote" && !s.loading && s.quote.response.tx_hash === "Q2")).toBe(
      false,
    );
  });

  it("drops a quote that lands after the user went back to editing", async () => {
    const h = harness();
    const pending = h.flow.quote(false);
    h.flow.edit();
    h.builds[0].resolve(quoteOf("Q1", h.now()));
    await pending;
    expect(h.flow.state()).toEqual({ kind: "edit" });
  });

  it("drops everything after the modal closes", async () => {
    const h = harness();
    const pending = h.flow.quote(false);
    const seen = h.states.length;
    h.flow.dispose();
    h.builds[0].resolve(quoteOf("Q1", h.now()));
    await pending;
    expect(h.states.length).toBe(seen);
  });
});

describe("no quote older than 90 s is relayed (2026-09-29 send-safety audit, finding 2)", () => {
  it("re-prices instead of relaying a stale quote; the user confirms the new one", async () => {
    const h = harness();
    await shownQuote(h, "Q1");
    h.advance(91_000);

    const confirm = h.flow.confirm();
    expect(h.relayed).toEqual([]); // Q1 is not relayed
    expect(h.flow.state()).toEqual({ kind: "quote", loading: true });
    h.builds[1].resolve(quoteOf("Q2", h.now()));
    await confirm;
    expect(h.flow.state()).toMatchObject({ kind: "quote", loading: false });

    const second = h.flow.confirm();
    h.relays[0].resolve({ hash: "Q2" });
    await second;
    expect(h.relayed.map((q) => q.response.tx_hash)).toEqual(["Q2"]);
  });

  it("a failed silent re-quote keeps the shown quote, and Confirm re-prices it once it is stale", async () => {
    const h = harness();
    await shownQuote(h, "Q1");
    h.advance(61_000);
    const refresh = h.flow.quote(true);
    h.builds[1].reject("RPC timed out after 30s");
    await refresh;
    expect(h.flow.state()).toMatchObject({ kind: "quote", loading: false });

    h.advance(30_000); // 91 s old now
    void h.flow.confirm();
    expect(h.relayed).toEqual([]);
    expect(h.builds).toHaveLength(3);
  });

  it("the boundary is the Send modal's: fresh under 90 s", () => {
    expect(swapQuoteIsFresh(0, 89_999)).toBe(true);
    expect(swapQuoteIsFresh(0, 90_000)).toBe(false);
    expect(swapQuoteIsFresh(10, 0)).toBe(false); // a quote from the future (clock moved)
  });
});

describe("relay outcomes in the conversion modal (2026-09-29)", () => {
  it("an outcome that may have gone out ends in 'unknown' with the txid, with no way back to Confirm", async () => {
    const h = harness();
    await shownQuote(h, "Q1");
    const confirm = h.flow.confirm();
    h.relays[0].reject(new SendOutcomeUnknownError("did not confirm the broadcast", "Q1"));
    await confirm;
    expect(h.flow.state()).toMatchObject({ kind: "unknown", txHash: "Q1" });
    // Was: an error state whose "◄ Back" led to Get Quote + Confirm again.
    await h.flow.confirm();
    await h.flow.quote(true);
    expect(h.flow.state().kind).toBe("unknown");
    expect(h.relayed).toHaveLength(1);
  });

  it("a relay that provably sent nothing is an error the user can go back from", async () => {
    const h = harness();
    await shownQuote(h, "Q1");
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
});
