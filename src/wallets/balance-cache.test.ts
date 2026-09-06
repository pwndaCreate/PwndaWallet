import { describe, it, expect } from "vitest";
import {
  hydrateBalances,
  isNumericBalance,
  keepLastGood,
  orderChains,
  runLimited,
  withTimeout,
} from "./balance-cache";
import type { ChainType, WalletInfo } from "./index";

const w = (address: string) => ({ address }) as WalletInfo;

describe("isNumericBalance — what counts as a real number", () => {
  it("accepts decimal strings, rejects placeholders and prose", () => {
    expect(isNumericBalance("0")).toBe(true);
    expect(isNumericBalance("4.32888299")).toBe(true);
    expect(isNumericBalance("—")).toBe(false);
    expect(isNumericBalance("--")).toBe(false);
    expect(isNumericBalance("Syncing…")).toBe(false);
    expect(isNumericBalance("No account (create on network)")).toBe(false);
    expect(isNumericBalance("")).toBe(false);
    expect(isNumericBalance(undefined)).toBe(false);
  });
});

describe("runLimited — bounded fan-out", () => {
  it("never exceeds the limit and settles every task, even failing ones", async () => {
    let inFlight = 0;
    let peak = 0;
    const ran: number[] = [];
    const tasks = Array.from({ length: 12 }, (_, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      ran.push(i);
      inFlight--;
      if (i % 4 === 0) throw new Error("boom");
    });
    await runLimited(tasks, 3);
    expect(peak).toBeLessThanOrEqual(3);
    expect(ran.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it("handles an empty list and a limit larger than the list", async () => {
    await expect(runLimited([], 6)).resolves.toBeUndefined();
    let n = 0;
    await runLimited([async () => { n++; }], 100);
    expect(n).toBe(1);
  });
});

describe("withTimeout — the per-chain deadline", () => {
  it("rejects with a named error once the deadline passes", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 10, "solana balance")).rejects.toThrow(
      /solana balance timed out after 10 ms/,
    );
  });

  it("passes a value through untouched when it beats the deadline", async () => {
    await expect(withTimeout(Promise.resolve("4.3"), 1000, "x")).resolves.toBe("4.3");
  });
});

describe("orderChains — the focal chain lands first", () => {
  const entries: [ChainType, WalletInfo][] = [
    ["bitcoin", w("a")],
    ["litecoin", w("b")],
    ["solana", w("c")],
  ];
  it("moves the active chain to the front and keeps the rest in order", () => {
    expect(orderChains(entries, "solana").map(([c]) => c)).toEqual([
      "solana", "bitcoin", "litecoin",
    ]);
  });
  it("is a stable copy when there is no active chain", () => {
    const out = orderChains(entries, null);
    expect(out.map(([c]) => c)).toEqual(["bitcoin", "litecoin", "solana"]);
    expect(out).not.toBe(entries);
  });
});

describe("keepLastGood — a failed refresh never blanks a real number", () => {
  it("keeps a numeric value and writes — only when there was none", () => {
    expect(keepLastGood({ litecoin: "4.03" }, "litecoin")).toEqual({ litecoin: "4.03" });
    expect(keepLastGood({}, "litecoin")).toEqual({ litecoin: "—" });
    expect(keepLastGood({ litecoin: "Syncing…" }, "litecoin")).toEqual({ litecoin: "—" });
  });
  it("returns a new object", () => {
    const prev = { litecoin: "1" };
    expect(keepLastGood(prev, "litecoin")).not.toBe(prev);
  });
});

describe("hydrateBalances — cached readings land before the network does", () => {
  const entries: [ChainType, WalletInfo][] = [
    ["litecoin", w("ltc1new")],
    ["bitcoin", w("bc1same")],
    ["solana", w("sol1")],
  ];
  it("uses the cache for a cold start and drops a value recorded for another address", () => {
    const { balances, addrs } = hydrateBalances(
      { litecoin: "9.99", bitcoin: "0.5" }, // in-session values
      { litecoin: "ltc1OLD", bitcoin: "bc1same" }, // …recorded for these addresses
      entries,
      {
        "litecoin:ltc1new": { balance: "4.03", fetchedAt: 1 },
        "solana:sol1": { balance: "12.5", fetchedAt: 1 },
      },
    );
    // LTC: the in-session 9.99 belonged to a different address → replaced by cache
    expect(balances.litecoin).toBe("4.03");
    // BTC: same address → in-session value kept over the cache
    expect(balances.bitcoin).toBe("0.5");
    // SOL: nothing in session → cache
    expect(balances.solana).toBe("12.5");
    expect(addrs).toEqual({ litecoin: "ltc1new", bitcoin: "bc1same", solana: "sol1" });
  });
  it("keeps a pre-bookkeeping value (no recorded address) and ignores junk cache rows", () => {
    const { balances } = hydrateBalances(
      { bitcoin: "0.5" },
      {},
      entries,
      { "litecoin:ltc1new": { balance: "—", fetchedAt: 1 } },
    );
    expect(balances.bitcoin).toBe("0.5");
    expect(balances.litecoin).toBeUndefined();
  });
});

/**
 * 2026-09-02 incident: after switching wallet, Cardano still showed the
 * previous wallet's 1,283.46 ADA — at the NEW wallet's address, next to
 * correctly-zeroed EVM rows. Only slow / rate-limited chains were affected,
 * which is what made it look random.
 *
 * Two independent paths could put it there. Both are pinned here.
 */
describe("wallet switch must not show the previous wallet's balance", () => {
  const A = "addr1q8qf6l_MAIN";
  const B = "addr1q8v7vq_OTHER";
  const entry = (chain: ChainType, address: string): [ChainType, WalletInfo] =>
    [chain, { chain, address, mnemonic: "", privateKey: "" } as WalletInfo];

  it("keepLastGood refuses a value fetched for a different address", () => {
    const prev = { cardano: "1283.46" } as Partial<Record<ChainType, string>>;
    const kept = keepLastGood(prev, "cardano", {
      recordedAddress: A,
      currentAddress: B,
    });
    expect(kept.cardano).toBe("—");
  });

  it("keepLastGood still keeps a stale value for the SAME address", () => {
    const prev = { cardano: "1283.46" } as Partial<Record<ChainType, string>>;
    const kept = keepLastGood(prev, "cardano", {
      recordedAddress: A,
      currentAddress: A,
    });
    expect(kept.cardano).toBe("1283.46");
  });

  it("hydrate's caller must not write its address book inside the updater", () => {
    // Reproduces the second path exactly: App.tsx used to assign
    // `balanceAddrRef.current = addrs` INSIDE the setState updater. React may
    // invoke an updater more than once for one update (StrictMode does in dev),
    // and the second pass then read back the addresses the first had written,
    // saw "same address", and restored the balance it had just dropped.
    const entries = [entry("cardano", B)];
    const prev = { cardano: "1283.46" } as Partial<Record<ChainType, string>>;

    const impure = { current: { cardano: A } as Partial<Record<ChainType, string>> };
    const impureUpdater = (p: typeof prev) => {
      const r = hydrateBalances(p, impure.current, entries, {});
      impure.current = r.addrs; // the bug
      return r.balances;
    };
    expect(impureUpdater(prev).cardano).toBeUndefined();
    expect(impureUpdater(prev).cardano).toBe("1283.46"); // replay resurrects it

    // The shipped shape: snapshot the ref, write it after — replay-safe.
    const snapshot = { cardano: A } as Partial<Record<ChainType, string>>;
    const pureUpdater = (p: typeof prev) =>
      hydrateBalances(p, snapshot, entries, {}).balances;
    expect(pureUpdater(prev).cardano).toBeUndefined();
    expect(pureUpdater(prev).cardano).toBeUndefined();
  });
});
