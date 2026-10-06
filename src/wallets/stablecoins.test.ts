import { describe, it, expect } from "vitest";
import {
  STABLECOINS,
  STABLECOIN_NETWORKS,
  coinMarkFor,
  groupStablecoins,
  isStablecoinChain,
  stablecoinLegLabel,
  stablecoinLegName,
  stablecoinNetworkFor,
  stablecoinRailGroups,
  tokenLegsHeldBy,
} from "./stablecoins";
import { getAdapter, ALL_CHAINS } from "./index";
import { COIN_METADATA } from "./coin-metadata";
import { resolveCoinGlyph } from "../components/CoinIcon";
import { deriveTrxAtPath, trxAdapter } from "./trx-wallet";
import { usdtTronAdapter } from "./trc20-wallet";
import { readFileSync } from "node:fs";
import type { ChainType } from "./types";
import { SOURCE_CAPABLE_BLOCKCHAINS } from "../features/swap/intents-source-capability";

/**
 * The registry is the contract between a verified on-chain fact and the
 * balance the user reads. `scripts/verify-stablecoins.mjs` checks the
 * addresses against the chains; these tests check everything that does not
 * need a network.
 */
describe("stablecoin registry", () => {
  it("every leg is a real, registered chain with an adapter", () => {
    for (const n of STABLECOIN_NETWORKS) {
      expect(ALL_CHAINS).toContain(n.chain);
      const a = getAdapter(n.chain);
      expect(a).toBeDefined();
      expect(a.chain).toBe(n.chain);
    }
  });

  it("no contract address is reused across two different symbols", () => {
    // A duplicate here would mean two rows reading the SAME token and the
    // stacked total counting one balance twice.
    const byAddr = new Map<string, string[]>();
    for (const n of STABLECOIN_NETWORKS) {
      const k = `${n.parent}:${n.contract.toLowerCase()}`;
      byAddr.set(k, [...(byAddr.get(k) ?? []), n.symbol]);
    }
    for (const [k, syms] of byAddr) {
      expect(new Set(syms).size, `${k} claimed by ${syms.join(" + ")}`).toBe(1);
    }
  });

  it("decimals are declared per contract, not assumed", () => {
    // BSC's USDC and USDT are 18; everything else verified at 6. A blanket 6
    // would understate a BSC balance by a factor of 10^12.
    const bsc = STABLECOIN_NETWORKS.filter((n) => n.parent === "bsc");
    expect(bsc.length).toBeGreaterThan(0);
    for (const n of bsc) expect(n.decimals).toBe(18);
    for (const n of STABLECOIN_NETWORKS.filter((x) => x.parent !== "bsc")) {
      expect(n.decimals).toBe(6);
    }
  });

  it("classifies leg chains and leaves ordinary chains alone", () => {
    expect(isStablecoinChain("usdc-base")).toBe(true);
    expect(isStablecoinChain("usdt-avax")).toBe(true);
    expect(isStablecoinChain("ethereum")).toBe(false);
    expect(isStablecoinChain("zano")).toBe(false);
    expect(stablecoinNetworkFor("usdc-bsc")?.symbol).toBe("USDC");
    expect(stablecoinNetworkFor("ethereum")).toBeUndefined();
  });

  it("Polygon's old USDT address is filed under USDT0, not USDT", () => {
    // Verified live 2026-09-02: 0xc2132D05… answers symbol() = "USDT0".
    // Filing it under USDT would mislabel the token the user actually holds.
    const row = STABLECOIN_NETWORKS.find(
      (n) => n.contract.toLowerCase() === "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    );
    expect(row?.symbol).toBe("USDT0");
    expect(row?.parent).toBe("polygon");
  });

  it("ships no bridged USDC.e address under the USDC symbol", () => {
    // Both of these answer symbol() = "USDC" while being a DIFFERENT token
    // with its own liquidity — only name() tells them apart. Shipping either
    // would show a balance the user cannot spend as native USDC.
    const bridged = [
      "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", // Arbitrum USDC.e
      "0x7f5c764cbc14f9669b88837ca1490cca17c31607", // Optimism USDC.e
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // Polygon USDC.e (PoS)
      "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664", // Avalanche USDC.e
    ];
    const shipped = STABLECOIN_NETWORKS.map((n) => n.contract.toLowerCase());
    for (const b of bridged) expect(shipped).not.toContain(b);
  });
});

describe("groupStablecoins — stacking, and what a missing balance means", () => {
  const bal = (o: Partial<Record<ChainType, string>>) => o;

  it("sums the networks that answered into one family total", () => {
    const g = groupStablecoins(
      bal({ "usdc-eth": "10.5", "usdc-base": "4.5", "usdc-bsc": "0" }),
    ).find((x) => x.symbol === "USDC")!;
    expect(g.total).toBe(15);
    expect(g.rows.find((r) => r.chain === "usdc-eth")!.amount).toBe(10.5);
  });

  it("treats a FAILED network as unknown, not as zero", () => {
    // The distinction is the whole point: summing a failed chain as 0 quietly
    // understates what the user owns, and they have no way to tell.
    const g = groupStablecoins(
      bal({ "usdc-eth": "10", "usdc-base": "—", "usdc-op": "Syncing…" }),
    ).find((x) => x.symbol === "USDC")!;
    expect(g.total).toBe(10);
    expect(g.rows.find((r) => r.chain === "usdc-base")!.amount).toBeNull();
    expect(g.rows.find((r) => r.chain === "usdc-op")!.amount).toBeNull();
  });

  it("total is null — not 0 — when EVERY network failed", () => {
    const g = groupStablecoins(bal({ "usdt-eth": "—" })).find(
      (x) => x.symbol === "USDT",
    )!;
    expect(g.total).toBeNull();
  });

  it("returns a group per family, each with all of its networks", () => {
    const groups = groupStablecoins({});
    expect(groups.map((g) => g.symbol)).toEqual(["USDC", "USDT", "USDT0"]);
    for (const g of groups) {
      const family = STABLECOINS.find((f) => f.symbol === g.symbol)!;
      expect(g.rows).toHaveLength(family.networks.length);
    }
  });

  it("marks only legs the wallet can actually swap via NEAR", () => {
    // A route the wallet cannot sign must not be advertised. Derived from
    // `SOURCE_CAPABLE_BLOCKCHAINS` rather than a hand-copied list — an earlier
    // version of this test hardcoded the chains and went red the moment Solana
    // legs were added, even though Solana has had a source signer all along.
    // A test that has to be edited whenever the truth changes is not testing
    // the truth.
    const toIntents: Partial<Record<ChainType, string>> = {
      ethereum: "eth", arbitrum: "arb", base: "base", optimism: "op",
      polygon: "pol", avalanche: "avax", bsc: "bnb", monad: "monad",
      solana: "sol", tron: "tron", near: "near", stellar: "stellar",
      // 2026-10-06: the USDT/USDC legs on Aptos.
      aptos: "aptos",
    };
    for (const n of STABLECOIN_NETWORKS) {
      if (!n.nearIntents) continue;
      const id = toIntents[n.parent];
      expect(id, `no Intents id mapped for ${n.parent}`).toBeDefined();
      expect(
        SOURCE_CAPABLE_BLOCKCHAINS.has(id as never),
        `${n.chain} advertises a NEAR route but ${n.parent} has no source signer`,
      ).toBe(true);
    }
  });
});

/**
 * USDT on TRON must sit on the same account as TRX (2026-09-29).
 *
 * The TRC-20 adapter derives by delegating to TRON's DEFAULT derivation. A
 * derivation choice (an Exodus/Atomic import puts TRX on TRX's own coin type,
 * m/44'/195'/...) moved `tron` and left `usdt-tron` behind, so the dashboard
 * showed two different TRON addresses, USDT's without the TRX its sends burn
 * for energy, and a swap paying out USDT landed where the TRX row was not.
 */
describe("token legs follow their parent's chosen path", () => {
  const ABANDON =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  it("moves USDT on TRON to wherever TRON was derived", () => {
    const tronAlt = deriveTrxAtPath(ABANDON, "m/44'/195'/0'/0/0");
    const legs = tokenLegsHeldBy("tron", tronAlt);
    expect(legs["usdt-tron"]?.address).toBe(tronAlt.address);
    expect(legs["usdt-tron"]?.privateKey).toBe(tronAlt.privateKey);
    expect(legs["usdt-tron"]?.chain).toBe("usdt-tron");
    // The adapter on its own still derives the default path, which is the
    // divergence this closes.
    expect(usdtTronAdapter.deriveFromMnemonic(ABANDON).address).not.toBe(tronAlt.address);
  });

  it("changes nothing on the default path", () => {
    const legs = tokenLegsHeldBy("tron", trxAdapter.deriveFromMnemonic(ABANDON));
    expect(legs["usdt-tron"]).toEqual(usdtTronAdapter.deriveFromMnemonic(ABANDON));
  });

  it("returns nothing for a coin with no token legs, or no parent entry", () => {
    expect(tokenLegsHeldBy("xrp", trxAdapter.deriveFromMnemonic(ABANDON))).toEqual({});
    expect(tokenLegsHeldBy("tron", undefined)).toEqual({});
  });

  it("is applied at unlock, on a single-coin path change and on a profile switch", () => {
    // Wiring check: those are the three places `useVault` re-derives TRON
    // from a derivation choice. Missing one reopens the split for that flow.
    const src = readFileSync(
      new URL("../features/vault/useVault.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain('Object.assign(newWallets, tokenLegsHeldBy("tron", perChoice.tron));');
    expect(src).toContain("...tokenLegsHeldBy(coin, next[coin]),");
    expect(src).toContain('...tokenLegsHeldBy("tron", next.tron),');
  });
});

/**
 * Every stablecoin family is listed whether or not anything is held.
 *
 * Reported 2026-09-29: "I don't see USDT or USDC provided in the pwnda wallet,
 * I don't see any UI for it." Both layouts dropped a family until something
 * was held, so a wallet that had never held a stablecoin had no row to
 * receive one into, in either layout. USDC and USDT were listed always that
 * day, and then every family: "show even if it has a 0 balance, let this be
 * true for any other assets that might have the same or similar attribute".
 */
describe("the stablecoin rows the wallet lists", () => {
  it("lists USDC and USDT on an empty wallet", () => {
    const groups = stablecoinRailGroups({});
    expect(groups.map((g) => g.symbol)).toEqual(["USDC", "USDT"]);
    // Nothing read yet: "—", not a claimed zero.
    for (const g of groups) expect(g.total).toBeNull();
  });

  it("reaches every leg in the registry at a zero balance", () => {
    const zeros = Object.fromEntries(STABLECOIN_NETWORKS.map((n) => [n.chain, "0"]));
    const groups = stablecoinRailGroups(zeros);
    const listed = groups.flatMap((g) => g.rows.map((r) => r.chain)).sort();
    expect(listed).toEqual(STABLECOIN_NETWORKS.map((n) => n.chain).sort());
    for (const g of groups) expect(g.total).toBe(0);
    // Control: USD₮0 is a family of its own in the registry, so "every leg is
    // reachable" is not just "every family has a row".
    expect(STABLECOINS.map((f) => f.symbol)).toContain("USDT0");
  });

  it("files USD₮0 under USDT, labelled, and counts it into the total", () => {
    const usdt = stablecoinRailGroups({ "usdt0-arb": "12.5", "usdt-tron": "1" }).find(
      (g) => g.symbol === "USDT",
    )!;
    const arb = usdt.rows.find((r) => r.chain === "usdt0-arb")!;
    // The row reads as its network, with "USD₮0" as a small note beside it
    // (operator request 2026-10-01; until 2026-10-06 the network itself read
    // "Arbitrum · USD₮0").
    expect(arb.network).toBe("Arbitrum");
    expect(arb.note).toBe("USD₮0");
    // A plain USDT leg carries no note.
    expect(usdt.rows.find((r) => r.chain === "usdt-tron")!.note).toBeUndefined();
    expect(usdt.total).toBe(13.5);
    // No separate USD₮0 family row left behind.
    expect(stablecoinRailGroups({ "usdt0-arb": "12.5" }).map((g) => g.symbol)).toEqual([
      "USDC",
      "USDT",
    ]);
  });

  it("is the one rule both layouts use", () => {
    const portrait = readFileSync(new URL("../features/wallet/DashboardView.tsx", import.meta.url), "utf8");
    const landscape = readFileSync(new URL("../features/wallet/WalletLandscapeView.tsx", import.meta.url), "utf8");
    for (const src of [portrait, landscape]) {
      expect(src).toContain("stablecoinRailGroups(balancesByChain)");
    }
  });
});

/**
 * USD₮0 reads as USDT, with "USD₮0" as a small note (operator request,
 * 2026-10-01). On Arbitrum, Polygon and Monad USD₮0 IS the USDT; on Optimism
 * it sits beside the older bridged USDT and the note is the difference.
 */
describe("USD₮0 legs read as USDT, with the note", () => {
  const USDT0_LEGS: ChainType[] = ["usdt0-arb", "usdt0-pol", "usdt0-monad", "usdt0-op"];

  it("every USD₮0 leg is labelled USDT + its network + the note", () => {
    expect(stablecoinLegLabel("usdt0-arb")).toEqual({ symbol: "USDT", network: "Arbitrum", note: "USD₮0" });
    expect(stablecoinLegLabel("usdt0-op")).toEqual({ symbol: "USDT", network: "Optimism", note: "USD₮0" });
    for (const c of USDT0_LEGS) expect(stablecoinLegLabel(c)?.note, c).toBe("USD₮0");
    // Everything else: no note, its own symbol; not a leg: nothing.
    expect(stablecoinLegLabel("usdt-op")).toEqual({ symbol: "USDT", network: "Optimism" });
    expect(stablecoinLegLabel("usdc-near")).toEqual({ symbol: "USDC", network: "NEAR" });
    expect(stablecoinLegLabel("ethereum")).toBeUndefined();
    expect(stablecoinLegName("usdt0-pol")).toBe("USDT (Polygon · USD₮0)");
  });

  it("the adapters and coin-metadata say USDT, with the note after the network", () => {
    // Until 2026-10-06: ticker "USDT0", name "USD₮0 (Arbitrum)" — the token's
    // own name as the row's name, which is what the operator asked to change.
    for (const c of USDT0_LEGS) {
      const a = getAdapter(c);
      expect(a.ticker, c).toBe("USDT");
      expect(a.displayName, c).toBe(stablecoinLegName(c));
      expect(COIN_METADATA[c].ticker, c).toBe("USDT");
      expect(COIN_METADATA[c].displayName, c).toBe(stablecoinLegName(c));
    }
  });

  it("keeps the USD₮0 mark on the coin icon — the icon's note", () => {
    for (const c of USDT0_LEGS) {
      expect(coinMarkFor(c, getAdapter(c).ticker), c).toBe("USDT0");
      expect(resolveCoinGlyph(coinMarkFor(c, "USDT"))?.badge?.t, c).toBe("0");
    }
    expect(coinMarkFor("usdt-op", "USDT")).toBe("USDT");
    expect(resolveCoinGlyph(coinMarkFor("usdt-op", "USDT"))?.badge).toBeUndefined();
    expect(coinMarkFor("bitcoin", "BTC")).toBe("BTC");
  });

  it("Optimism holds two USDT legs at two contracts, and the rail lists both, told apart by the note", () => {
    const op = STABLECOIN_NETWORKS.filter((n) => n.parent === "optimism" && n.symbol !== "USDC");
    expect(op.map((n) => [n.chain, n.contract.toLowerCase()]).sort()).toEqual([
      ["usdt-op", "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58"],
      ["usdt0-op", "0x01bff41798a0bcf287b996046ca68b395dbc1071"],
    ]);
    const usdt = stablecoinRailGroups({ "usdt-op": "0", "usdt0-op": "33" }).find((g) => g.symbol === "USDT")!;
    const rows = usdt.rows.filter((r) => r.network === "Optimism");
    expect(rows.map((r) => [r.chain, r.note ?? null])).toEqual([
      ["usdt-op", null],
      ["usdt0-op", "USD₮0"],
    ]);
  });
});

/**
 * USDT and USDC on NEAR (NEP-141) and on Aptos (fungible assets), 2026-10-06.
 * Contracts read live that day from each chain and matched to 1Click's list.
 */
describe("the NEAR and Aptos legs", () => {
  const ABANDON =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  it("names the verified token on each chain", () => {
    const row = (c: ChainType) => stablecoinNetworkFor(c)!;
    expect(row("usdt-near")).toMatchObject({ parent: "near", symbol: "USDT", contract: "usdt.tether-token.near", decimals: 6, nearIntents: true });
    expect(row("usdc-near")).toMatchObject({
      parent: "near",
      symbol: "USDC",
      contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      decimals: 6,
      nearIntents: true,
    });
    expect(row("usdt-aptos")).toMatchObject({
      parent: "aptos",
      symbol: "USDT",
      contract: "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b",
      decimals: 6,
      nearIntents: true,
    });
    expect(row("usdc-aptos")).toMatchObject({
      parent: "aptos",
      symbol: "USDC",
      contract: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
      decimals: 6,
      nearIntents: true,
    });
  });

  it("each leg is held by its parent's own account, and pays fees in the parent's coin", () => {
    const near = getAdapter("near").deriveFromMnemonic(ABANDON);
    const aptos = getAdapter("aptos").deriveFromMnemonic(ABANDON);
    for (const c of ["usdt-near", "usdc-near"] as const) {
      const w = getAdapter(c).deriveFromMnemonic(ABANDON);
      expect(w.address, c).toBe(near.address);
      expect(w.privateKey, c).toBe(near.privateKey);
      expect(w.chain, c).toBe(c);
      expect(getAdapter(c).gasToken, c).toEqual({ ticker: "NEAR", chainName: "NEAR" });
    }
    for (const c of ["usdt-aptos", "usdc-aptos"] as const) {
      const w = getAdapter(c).deriveFromMnemonic(ABANDON);
      expect(w.address, c).toBe(aptos.address);
      expect(w.chain, c).toBe(c);
      expect(getAdapter(c).gasToken, c).toEqual({ ticker: "APT", chainName: "Aptos" });
    }
  });

  it("the rail lists them under their families at a zero balance", () => {
    const groups = stablecoinRailGroups({});
    const chains = (s: string) => groups.find((g) => g.symbol === s)!.rows.map((r) => r.chain);
    expect(chains("USDT")).toEqual(expect.arrayContaining(["usdt-near", "usdt-aptos", "usdt0-op"]));
    expect(chains("USDC")).toEqual(expect.arrayContaining(["usdc-near", "usdc-aptos"]));
  });
});
