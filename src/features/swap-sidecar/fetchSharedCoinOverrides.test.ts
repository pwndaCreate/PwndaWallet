/**
 * The network half of C8's authority switch. The stakes named in the module
 * header: a hung engine must cost the dashboard a BOUNDED delay, never an
 * unbounded stall, and a lookup failure must resolve to a value, never throw
 * into the caller's own chain-fetch error handling.
 */
import { describe, it, expect, vi } from "vitest";
import type { CoinEnableStatus, SidecarStatus } from "../../api/basicswap";
import {
  fetchSharedCoinOverrides,
  type SharedBalanceDeps,
} from "./fetchSharedCoinOverrides";

function status(over: Partial<CoinEnableStatus> & { ticker: string }): CoinEnableStatus {
  return {
    coin: over.ticker.toLowerCase(),
    enabled: true,
    binaryPresent: true,
    configured: true,
    adoption: "deposit",
    descriptorsImported: false,
    mode: "lean",
    configuredMode: "lean",
    canRunLean: true,
    canShareWallet: true,
    sharesWallet: false,
    xmrHostWalletActive: false,
    estDiskGb: 0,
    ...over,
  };
}

const RUNNING: SidecarStatus = {
  running: true,
  phase: "healthy",
  optedIn: true,
} as unknown as SidecarStatus;

const STOPPED: SidecarStatus = {
  running: false,
  phase: "stopped",
  optedIn: true,
} as unknown as SidecarStatus;

function deps(over: Partial<SharedBalanceDeps>): SharedBalanceDeps {
  return {
    coinStatus: vi.fn().mockResolvedValue([]),
    sidecarStatus: vi.fn().mockResolvedValue(RUNNING),
    fetchWallets: vi.fn().mockResolvedValue({}),
    ...over,
  };
}

describe("fetchSharedCoinOverrides — the cheap path (the common case)", () => {
  it("touches the network NOT AT ALL when no coin is verified shared", async () => {
    const fetchWallets = vi.fn().mockResolvedValue({});
    const d = deps({
      coinStatus: vi.fn().mockResolvedValue([status({ ticker: "BTC", adoption: "deposit" })]),
      fetchWallets,
    });
    const overrides = await fetchSharedCoinOverrides(d);
    expect(overrides).toEqual([]);
    expect(fetchWallets).not.toHaveBeenCalled();
  });

  it("does not call fetchWallets when the node is not running", async () => {
    const fetchWallets = vi.fn().mockResolvedValue({});
    const d = deps({
      sidecarStatus: vi.fn().mockResolvedValue(STOPPED),
      coinStatus: vi.fn().mockResolvedValue([status({ ticker: "BTC", adoption: "accountkey" })]),
      fetchWallets,
    });
    const overrides = await fetchSharedCoinOverrides(d);
    expect(overrides).toEqual([]);
    expect(fetchWallets).not.toHaveBeenCalled();
  });
});

describe("fetchSharedCoinOverrides — the shared path", () => {
  it("returns the engine's balance for a verified-shared coin", async () => {
    const d = deps({
      coinStatus: vi.fn().mockResolvedValue([status({ ticker: "BTC", adoption: "accountkey" })]),
      fetchWallets: vi.fn().mockResolvedValue({ BTC: { balance: "0.5" } }),
    });
    const overrides = await fetchSharedCoinOverrides(d);
    expect(overrides).toEqual([{ ticker: "BTC", chain: "bitcoin", balance: "0.5" }]);
  });

  it("both shared coins resolve from one fetchWallets call", async () => {
    const fetchWallets = vi
      .fn()
      .mockResolvedValue({ BTC: { balance: "0.5" }, LTC: { balance: "4.3" } });
    const d = deps({
      coinStatus: vi.fn().mockResolvedValue([
        status({ ticker: "BTC", adoption: "accountkey" }),
        status({ ticker: "LTC", adoption: "accountkey" }),
      ]),
      fetchWallets,
    });
    const overrides = await fetchSharedCoinOverrides(d);
    expect(overrides.sort((a, b) => a.ticker.localeCompare(b.ticker))).toEqual([
      { ticker: "BTC", chain: "bitcoin", balance: "0.5" },
      { ticker: "LTC", chain: "litecoin", balance: "4.3" },
    ]);
    expect(fetchWallets).toHaveBeenCalledTimes(1);
  });
});

describe("fetchSharedCoinOverrides — failure is a value, never a throw", () => {
  it("a timed-out engine resolves with null balances, within the bound", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => {}); // hangs forever
      const d = deps({
        coinStatus: vi.fn().mockResolvedValue([status({ ticker: "BTC", adoption: "accountkey" })]),
        fetchWallets: vi.fn().mockReturnValue(never),
      });
      const p = fetchSharedCoinOverrides(d);
      await vi.advanceTimersByTimeAsync(4000);
      const overrides = await p;
      expect(overrides).toEqual([{ ticker: "BTC", chain: "bitcoin", balance: null }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejected fetchWallets resolves with null balances, not a throw", async () => {
    const d = deps({
      coinStatus: vi.fn().mockResolvedValue([status({ ticker: "BTC", adoption: "accountkey" })]),
      fetchWallets: vi.fn().mockRejectedValue(new Error("network down")),
    });
    await expect(fetchSharedCoinOverrides(d)).resolves.toEqual([
      { ticker: "BTC", chain: "bitcoin", balance: null },
    ]);
  });

  it("an error-shaped fetchWallets body resolves with null balances", async () => {
    const d = deps({
      coinStatus: vi.fn().mockResolvedValue([status({ ticker: "BTC", adoption: "accountkey" })]),
      fetchWallets: vi.fn().mockResolvedValue({ error: "checkSystemStatus threw" }),
    });
    await expect(fetchSharedCoinOverrides(d)).resolves.toEqual([
      { ticker: "BTC", chain: "bitcoin", balance: null },
    ]);
  });

  it("a throw from coinStatus/sidecarStatus resolves to [], never rejects", async () => {
    const d = deps({
      coinStatus: vi.fn().mockRejectedValue(new Error("sidecar command missing (lite build)")),
    });
    await expect(fetchSharedCoinOverrides(d)).resolves.toEqual([]);
  });

  it("one coin's row-level error does not sink the other coin's balance", async () => {
    const d = deps({
      coinStatus: vi.fn().mockResolvedValue([
        status({ ticker: "BTC", adoption: "accountkey" }),
        status({ ticker: "LTC", adoption: "accountkey" }),
      ]),
      fetchWallets: vi.fn().mockResolvedValue({
        BTC: { balance: "0.5" },
        LTC: { error: "timeout" },
      }),
    });
    const overrides = await fetchSharedCoinOverrides(d);
    expect(overrides.sort((a, b) => a.ticker.localeCompare(b.ticker))).toEqual([
      { ticker: "BTC", chain: "bitcoin", balance: "0.5" },
      { ticker: "LTC", chain: "litecoin", balance: null },
    ]);
  });
});
