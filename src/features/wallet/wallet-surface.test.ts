/**
 * The rules both wallet layouts share (`wallet-surface.ts`), pinned by
 * behaviour. Each block names the drift the portrait-vs-landscape parity
 * audit of 2026-09-16 found; `layout-parity.test.ts` pins that both views
 * actually call these.
 */
import { describe, it, expect } from "vitest";
import { ALL_CHAINS, getAdapter } from "../../wallets";
import type { ChainType, WalletInfo } from "../../wallets";
import { ASSET_CAPABILITIES } from "../swap/asset-capabilities";
import { isIntentsRoutable, isSwapKitRoutable } from "../swap/swap-data";
import { isDeskRoutableFromRegistry } from "../swap/asset-capabilities";
import { isBasicswapRoutable } from "../swap-sidecar";
import {
  assetUsdValue,
  displayedReceiveAddress,
  formatAssetBalance,
  formatAssetPrice,
  formatAssetUsd,
  hasDedicatedHistoryCard,
  hasSwapVenue,
  historySurfaceFor,
  importableChains,
  isAlwaysListed,
  receiveBlockedReason,
  sendBlockedReason,
  swapAssetKeyFor,
  swapBlockedReason,
} from "./wallet-surface";

const wallet = (chain: ChainType, address: string): WalletInfo => ({
  chain,
  address,
  mnemonic: "",
  privateKey: "",
});

describe("a known zero is $0.00; only an unknown value is —", () => {
  it("prices a zero balance at a known price as $0.00", () => {
    // Portrait printed "—" here, the glyph it also used for a failed load.
    expect(assetUsdValue("0", 2.5)).toBe(0);
    expect(formatAssetUsd(assetUsdValue("0.00000000", 2.5))).toBe("$0.00");
  });

  it("says — when the price or the balance is unknown", () => {
    expect(formatAssetUsd(assetUsdValue("1.5", undefined))).toBe("—");
    expect(formatAssetUsd(assetUsdValue("1.5", Number.NaN))).toBe("—");
    expect(formatAssetUsd(assetUsdValue(undefined, 2))).toBe("—");
    expect(formatAssetUsd(assetUsdValue("—", 2))).toBe("—");
    // AccountCard printed "$NaN" for this before it used the shared helper.
    expect(formatAssetUsd(assetUsdValue("Not initialized", 2))).toBe("—");
  });

  it("formats a value the way landscape always did", () => {
    expect(formatAssetUsd(assetUsdValue("1,234.5", 2))).toBe("$2,469");
    expect(formatAssetUsd(12.345)).toBe("$12.35");
  });

  it("keeps a sub-dollar price readable instead of rounding it to $0.00", () => {
    expect(formatAssetPrice(0.003456)).toBe("$0.003456");
    expect(formatAssetPrice(0.5)).toBe("$0.50");
    expect(formatAssetPrice(0.1234)).toBe("$0.1234");
    expect(formatAssetPrice(64000)).toBe("$64,000");
    expect(formatAssetPrice(null)).toBe("—");
  });

  it("formats balances the same in both layouts", () => {
    expect(formatAssetBalance(undefined)).toBe("—");
    expect(formatAssetBalance("--")).toBe("—");
    expect(formatAssetBalance("0")).toBe("0");
    expect(formatAssetBalance("2.481900")).toBe("2.4819");
    expect(formatAssetBalance("0.00012300")).toBe("0.000123");
    // A statement from the chain is shown as it is, not as a failed read.
    expect(formatAssetBalance("No account (create on network)")).toBe(
      "No account (create on network)",
    );
  });
});

describe("independent-seed chains: listed from the adapter flag, not a hand list", () => {
  const independent = (ALL_CHAINS as ChainType[]).filter(
    (c) => !!getAdapter(c).usesIndependentSeed,
  );

  it("positive control: the adapters declare the four sidecar chains", () => {
    // If this set shrank to nothing, every assertion below would pass vacuously.
    expect(independent).toEqual(
      expect.arrayContaining(["monero", "zephyr", "zano", "xelis"]),
    );
  });

  it("offers an import row for every independent-seed chain with no wallet", () => {
    expect(importableChains({}).sort()).toEqual([...independent].sort());
  });

  it("drops the row once that chain has a wallet", () => {
    const rows = importableChains({ xelis: wallet("xelis", ""), zano: wallet("zano", "Zx1") });
    expect(rows).not.toContain("xelis");
    expect(rows).not.toContain("zano");
    expect(rows).toContain("monero");
  });

  it("never offers an import row for a BIP-39 chain", () => {
    expect(importableChains({})).not.toContain("bitcoin");
    expect(importableChains({})).not.toContain("ethereum");
  });

  it("keeps every held independent-seed chain in portrait's collapsed list, and only those", () => {
    // 2026-08-28: ZANO missing from a hand-kept ticker set made the chain
    // unreachable. The rule is now the flag itself.
    for (const c of ALL_CHAINS as ChainType[]) {
      expect(isAlwaysListed(c), c).toBe(!!getAdapter(c).usesIndependentSeed);
    }
    expect(isAlwaysListed("xelis")).toBe(true);
  });
});

describe("history: one surface per chain", () => {
  it("gives Monero, Zano and Xelis their own card", () => {
    expect(historySurfaceFor("monero")).toBe("monero");
    expect(historySurfaceFor("zano")).toBe("zano");
    expect(historySurfaceFor("xelis")).toBe("xelis");
    expect(hasDedicatedHistoryCard("xelis")).toBe(true);
  });

  it("sends every other chain to the generic feed, Zephyr included", () => {
    expect(historySurfaceFor("zephyr")).toBe("generic");
    expect(historySurfaceFor("bitcoin")).toBe("generic");
    expect(hasDedicatedHistoryCard("bitcoin")).toBe(false);
  });
});

describe("Send is gated on the chain's own sync, in both layouts", () => {
  const allSynced = { monero: true, zephyr: true, zano: true, xelis: true };

  it("blocks an unsynced Xelis and an unsynced Zephyr wallet", () => {
    // Portrait gated Monero only until 2026-09-16.
    expect(sendBlockedReason("xelis", { ...allSynced, xelis: false })).toMatch(/Xelis/);
    expect(sendBlockedReason("zephyr", { ...allSynced, zephyr: false })).toMatch(/Zephyr/);
    expect(sendBlockedReason("monero", { ...allSynced, monero: false })).toMatch(/Monero/);
  });

  it("blocks a Zano wallet whose session is not open yet, and says 'open', not 'synced'", () => {
    // Neither layout gated Zano until 2026-09-16 (the audit's open item). Its
    // session has no sync progress, only starting → ready, so the reason must
    // not promise a sync the UI never shows.
    const reason = sendBlockedReason("zano", { ...allSynced, zano: false });
    expect(reason).toMatch(/Zano/);
    expect(reason).toMatch(/open/);
    expect(reason).not.toMatch(/sync/);
    expect(sendBlockedReason("zano", allSynced)).toBeNull();
  });

  it("allows a synced one", () => {
    expect(sendBlockedReason("xelis", allSynced)).toBeNull();
    expect(sendBlockedReason("zephyr", allSynced)).toBeNull();
  });

  it("reads each chain's OWN state, not a neighbour's", () => {
    // A synced Zephyr must not unlock an unsynced Xelis (the Zano/Zephyr
    // mix-up of 2026-09-15, in another place).
    expect(
      sendBlockedReason("xelis", { monero: true, zephyr: true, zano: true, xelis: false }),
    ).not.toBeNull();
    expect(
      sendBlockedReason("zano", { monero: true, zephyr: true, zano: false, xelis: true }),
    ).not.toBeNull();
  });

  it("gates every chain whose sends go through its own sidecar", () => {
    // The independent-seed chains are exactly the sidecar-backed ones. A new
    // one that is not added to the gate would let Send run before its RPC.
    const none = { monero: false, zephyr: false, zano: false, xelis: false };
    for (const c of ALL_CHAINS as ChainType[]) {
      if (!getAdapter(c).usesIndependentSeed) continue;
      expect(sendBlockedReason(c, none), c).not.toBeNull();
    }
  });

  it("never gates a chain with no sync step", () => {
    const none = { monero: false, zephyr: false, zano: false, xelis: false };
    expect(sendBlockedReason("bitcoin", none)).toBeNull();
    expect(sendBlockedReason("ethereum", none)).toBeNull();
  });
});

describe("Receive needs an address", () => {
  it("is blocked, with a reason, while the address is unknown", () => {
    expect(receiveBlockedReason("")).not.toBeNull();
    expect(receiveBlockedReason(null)).not.toBeNull();
    expect(receiveBlockedReason("xel:abc")).toBeNull();
  });

  it("copies what the card displays: the fresh UTXO address unless the user asked for the primary", () => {
    const base = {
      chain: "bitcoin" as ChainType,
      walletAddress: "bc1-primary",
      xmrReceiveAddress: null,
      xmrShowPrimary: true,
      utxoReceiveAddress: "bc1-fresh",
    };
    // Portrait's Receive copied the primary here while the card showed fresh.
    expect(displayedReceiveAddress({ ...base, utxoShowPrimary: false })).toBe("bc1-fresh");
    expect(displayedReceiveAddress({ ...base, utxoShowPrimary: true })).toBe("bc1-primary");
    expect(
      displayedReceiveAddress({ ...base, utxoReceiveAddress: null, utxoShowPrimary: false }),
    ).toBe("bc1-primary");
  });

  it("copies Monero's subaddress only when the user chose it", () => {
    const base = {
      chain: "monero" as ChainType,
      walletAddress: "4primary",
      xmrReceiveAddress: "8sub",
      utxoReceiveAddress: null,
      utxoShowPrimary: false,
    };
    expect(displayedReceiveAddress({ ...base, xmrShowPrimary: false })).toBe("8sub");
    expect(displayedReceiveAddress({ ...base, xmrShowPrimary: true })).toBe("4primary");
    expect(
      displayedReceiveAddress({ ...base, xmrReceiveAddress: null, xmrShowPrimary: false }),
    ).toBe("4primary");
  });

  it("leaves a Xelis wallet with no address yet with nothing to copy", () => {
    const addr = displayedReceiveAddress({
      chain: "xelis",
      walletAddress: "",
      xmrReceiveAddress: null,
      xmrShowPrimary: true,
      utxoReceiveAddress: null,
      utxoShowPrimary: false,
    });
    expect(addr).toBe("");
    expect(receiveBlockedReason(addr)).not.toBeNull();
  });
});

describe("Swap is offered only for an asset some venue carries", () => {
  const registryTickers = [
    ...new Set(Object.values(ASSET_CAPABILITIES).map((c) => c.ticker.toUpperCase())),
  ];
  const walletTickers = [
    ...new Set((ALL_CHAINS as ChainType[]).map((c) => getAdapter(c).ticker.toUpperCase())),
  ];
  const noVenue = walletTickers.filter((t) => !hasSwapVenue(t));

  it("positive control: XEL has no venue and the majors do", () => {
    expect(noVenue).toContain("XEL");
    for (const t of ["BTC", "ETH", "XMR", "ZEPH", "ZANO", "ADA", "LTC"]) {
      expect(hasSwapVenue(t), t).toBe(true);
    }
  });

  it("matches stablecoin legs by ticker, not by their per-network key", () => {
    // The wallet row says USDC; the registry keys the legs USDC-ARB etc.
    expect(hasSwapVenue("USDC")).toBe(true);
    expect(hasSwapVenue("USDT")).toBe(true);
    expect(hasSwapVenue("usdt0")).toBe(true);
  });

  it("agrees with every router: a ticker with no venue routes nowhere", () => {
    // The check that makes `hasSwapVenue` a claim about the routers rather
    // than about a list. If a router learns XEL without the registry learning
    // it, this goes red and the Swap tile's gate must be revisited.
    const routed: string[] = [];
    for (const t of noVenue) {
      for (const other of registryTickers) {
        for (const [from, to] of [
          [t, other],
          [other, t],
        ]) {
          if (
            isIntentsRoutable(from, to) ||
            isSwapKitRoutable(from, to) ||
            isBasicswapRoutable(from, to) ||
            isDeskRoutableFromRegistry(from, to)
          ) {
            routed.push(`${from}->${to}`);
          }
        }
      }
    }
    expect(routed).toEqual([]);
  });

  it("gives a reason for each blocked case", () => {
    expect(swapBlockedReason("xelis", true)).toMatch(/XEL/);
    expect(swapBlockedReason("bitcoin", false)).not.toBeNull();
    expect(swapBlockedReason("bitcoin", true)).toBeNull();
  });
});

describe("Swap seeds the Swap tab with the asset's own registry entry", () => {
  const chains = ALL_CHAINS as ChainType[];

  it("every key it returns is a registry key, on the same network as the wallet chain", () => {
    for (const c of chains) {
      const key = swapAssetKeyFor(c);
      if (key == null) continue;
      const cap = ASSET_CAPABILITIES[key];
      expect(cap, `${c} → ${key} is not a registry key`).toBeDefined();
      expect(cap.ticker.toUpperCase(), c).toBe(getAdapter(c).ticker.toUpperCase());
    }
  });

  it("seeds a stablecoin leg with its per-network key, not the bare ticker", () => {
    // 2026-09-16: the tile seeded "USDC", which is no registry key, so the
    // Swap form opened with nothing selected.
    expect(swapAssetKeyFor("usdc-arb")).toBe("USDC-ARB");
    expect(swapAssetKeyFor("usdt-tron")).toBe("USDT-TRON");
    expect(swapAssetKeyFor("usdt0-pol")).toBe("USDT0-POL");
    for (const c of chains) {
      const key = swapAssetKeyFor(c);
      if (key) expect(key, c).not.toMatch(/^(USDC|USDT|USDT0)$/);
    }
  });

  it("does not hand L2 ETH mainnet ETH's entry", () => {
    // Arbitrum/Base/Optimism report ticker "ETH". The ticker check found
    // mainnet ETH and seeded it — a different asset on a different network.
    expect(swapAssetKeyFor("ethereum")).toBe("ETH");
    for (const c of ["arbitrum", "base", "optimism"] as ChainType[]) {
      expect(swapAssetKeyFor(c), c).toBeNull();
      expect(swapBlockedReason(c, true), c).toMatch(new RegExp(`on ${getAdapter(c).displayName}`));
    }
  });

  it("maps the EVM natives whose address lives under 'ethereum' to their own chain", () => {
    expect(swapAssetKeyFor("avalanche")).toBe("AVAX");
    expect(swapAssetKeyFor("polygon")).toBe("POL");
    expect(swapAssetKeyFor("bsc")).toBe("BNB");
  });

  it("follows landscape's focused Zephyr sub-asset", () => {
    expect(swapAssetKeyFor("zephyr")).toBe("ZEPH");
    expect(swapAssetKeyFor("zephyr", "ZPH")).toBe("ZEPH");
    expect(swapAssetKeyFor("zephyr", "ZSD")).toBe("ZEPHUSD");
    expect(swapAssetKeyFor("zephyr", "ZYS")).toBe("ZEPHYRS");
  });

  it("offers Swap exactly where a key exists (no chain regressed to blocked)", () => {
    // Every chain the ticker check allowed still has a key, except the three
    // L2 ETH chains, which were the bug.
    const lost = chains.filter(
      (c) => hasSwapVenue(getAdapter(c).ticker) && swapAssetKeyFor(c) == null,
    );
    expect(lost.sort()).toEqual(["arbitrum", "base", "optimism"]);
    for (const c of chains) {
      expect(swapBlockedReason(c, true) == null, c).toBe(swapAssetKeyFor(c) != null);
    }
  });
});
