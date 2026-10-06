/**
 * The picker groups per-network legs without hiding the network.
 *
 * Both halves are load-bearing and they pull in opposite directions:
 *
 *  - GROUP, or the dropdown gains fifteen stablecoin rows and the user reads
 *    `USDC-BSC` and guesses;
 *  - never DROP the network, because USDC on Arbitrum and USDC on Base are
 *    different tokens at different contracts, and a swap settles against one
 *    of them.
 *
 * The USDT0 rows are where those two forces actually meet, so most of this
 * file is about them.
 */
import { describe, it, expect } from "vitest";

import { ASSET_CAPABILITIES } from "./asset-capabilities";
import {
  isGrouped,
  networkLabelFor,
  pickerRows,
  symbolFor,
} from "./picker-rows";
import { getDropdownTickers } from "./swap-data";

describe("pickerRows", () => {
  it("leaves an ordinary coin as a single ungrouped row", () => {
    const rows = pickerRows(["BTC", "ETH"]);
    expect(rows.map((r) => r.symbol)).toEqual(["BTC", "ETH"]);
    expect(rows.every((r) => !isGrouped(r))).toBe(true);
    // An ungrouped row IS its asset: picking it selects legs[0].
    expect(rows[0].legs).toEqual(["BTC"]);
  });

  it("collapses USDC's eleven legs into one expandable row", () => {
    const rows = pickerRows(getDropdownTickers({ sourceOnly: true, router: "intents" }));
    const usdc = rows.find((r) => r.symbol === "USDC")!;
    expect(usdc, "USDC row missing").toBeDefined();
    expect(isGrouped(usdc)).toBe(true);
    // Nine since 2026-09-29 (Monad joined the eight EVM/Solana legs); eleven
    // since 2026-10-06, with NEAR and Aptos.
    expect(usdc.legs.length).toBe(11);
    expect(usdc.legs).toContain("USDC-MONAD");
    expect(usdc.legs).toContain("USDC-NEAR");
    expect(usdc.legs).toContain("USDC-APTOS");
    // Every leg resolves to a real registry entry — a row standing for a key
    // nothing can route is the LTC failure wearing a different hat.
    for (const key of usdc.legs) {
      expect(ASSET_CAPABILITIES[key]?.nearIntentsAsset, key).toBeTruthy();
    }
  });

  it("names a network for every leg of a grouped row", () => {
    const rows = pickerRows(getDropdownTickers({ sourceOnly: true, router: "intents" }));
    const usdc = rows.find((r) => r.symbol === "USDC")!;
    for (const n of usdc.networks) {
      expect(n.network.length, `${n.key} has no network label`).toBeGreaterThan(0);
    }
    // Full chain names, not slugs: "Arbitrum", never "ARB".
    expect(usdc.networks.map((n) => n.network)).toContain("Arbitrum");
    expect(usdc.networks.map((n) => n.network)).toContain("Base");
  });

  it("preserves the roster's ordering", () => {
    // `getDropdownTickers` sorts by assetRank; grouping must not resort. A
    // symbol's row takes the position of its FIRST leg.
    const rows = pickerRows(["BTC", "USDC-ARB", "ETH", "USDC-BASE"]);
    expect(rows.map((r) => r.symbol)).toEqual(["BTC", "USDC", "ETH"]);
    expect(rows[1].legs).toEqual(["USDC-ARB", "USDC-BASE"]);
  });

  it("shows an unknown key rather than dropping it", () => {
    // The roster and the registry are meant to agree. Silently hiding a
    // disagreement is how LTC sat unroutable for three months.
    const rows = pickerRows(["BTC", "NOT-A-REAL-ASSET"]);
    expect(rows.map((r) => r.symbol)).toContain("NOT-A-REAL-ASSET");
  });
});

describe("USDT0 — grouped for findability, never disguised", () => {
  it("files under USDT so it is where a user looks for it", () => {
    const rows = pickerRows(getDropdownTickers({ sourceOnly: true, router: "intents" }));
    expect(rows.map((r) => r.symbol)).not.toContain("USDT0");
    const usdt = rows.find((r) => r.symbol === "USDT")!;
    expect(usdt.legs).toContain("USDT0-ARB");
    expect(usdt.legs).toContain("USDT0-POL");
    // Six plain USDT legs plus the two USD₮0 ones. The sixth is Tron,
    // added 2026-09-09 with the XRP/Tron source work; it groups here like
    // every other network rather than becoming its own row.
    expect(usdt.legs).toContain("USDT-TRON");
    // Plus Monad's USD₮0 since 2026-09-29.
    expect(usdt.legs).toContain("USDT0-MONAD");
    // Plus Optimism's USD₮0, and USDT on NEAR and Aptos, since 2026-10-06.
    expect(usdt.legs).toContain("USDT0-OP");
    expect(usdt.legs).toContain("USDT-NEAR");
    expect(usdt.legs).toContain("USDT-APTOS");
    expect(usdt.legs.length).toBe(12);
  });

  // Operator request 2026-10-01: "the row reads USDT, with USD₮0 as a small
  // note". Until 2026-10-06 the network row's NAME was "Arbitrum · USDT0".
  it("still SAYS USD₮0 on the network row — as its note, beside the network", () => {
    // Grouping is for findability. If it also hid which token was being
    // swapped it would be worse than the flat list it replaced: USD₮0 is a
    // different contract and a different bridge standard.
    const rows = pickerRows(getDropdownTickers({ sourceOnly: true, router: "intents" }));
    const usdt = rows.find((r) => r.symbol === "USDT")!;
    const arb = usdt.networks.find((n) => n.key === "USDT0-ARB")!;
    expect(arb).toEqual({ key: "USDT0-ARB", network: "Arbitrum", note: "USD₮0" });
    for (const key of ["USDT0-POL", "USDT0-MONAD", "USDT0-OP"]) {
      expect(usdt.networks.find((n) => n.key === key)?.note, key).toBe("USD₮0");
    }
    // A plain USDT leg carries no note.
    expect(usdt.networks.find((n) => n.key === "USDT-ETH")).toEqual({ key: "USDT-ETH", network: "Ethereum" });
  });

  it("tells Optimism's two USDT rows apart by the note alone", () => {
    // Optimism has the old bridged USDT AND a separate USD₮0 contract; both
    // are offered, under the same network name, so the note is what differs.
    const rows = pickerRows(getDropdownTickers({ router: "intents" }));
    const usdt = rows.find((r) => r.symbol === "USDT")!;
    const op = usdt.networks.filter((n) => n.network === "Optimism");
    expect(op.map((n) => n.key).sort()).toEqual(["USDT-OP", "USDT0-OP"]);
    expect(op.find((n) => n.key === "USDT-OP")?.note).toBeUndefined();
    expect(op.find((n) => n.key === "USDT0-OP")?.note).toBe("USD₮0");
    expect(networkLabelFor("USDT-OP")).toBe("Optimism");
    expect(networkLabelFor("USDT0-OP")).toBe("Optimism · USD₮0");
  });

  it("labels the closed button with both the network and the token", () => {
    // The chip is already the small print, so the note rides in it — spelled
    // as the wallet spells it (USD₮0), not as the registry key (USDT0).
    expect(networkLabelFor("USDT0-ARB")).toBe("Arbitrum · USD₮0");
    // A plain leg needs only its network.
    expect(networkLabelFor("USDC-BASE")).toBe("Base");
    expect(networkLabelFor("USDT-NEAR")).toBe("NEAR");
    expect(networkLabelFor("USDC-APTOS")).toBe("Aptos");
  });

  it("gives a native coin no network chip", () => {
    // "BTC on Bitcoin" is noise; only per-leg keys earn a chip.
    expect(networkLabelFor("BTC")).toBe("");
    expect(networkLabelFor("ETH")).toBe("");
  });
});

describe("symbolFor", () => {
  it("maps a leg key to the symbol its row is filed under", () => {
    expect(symbolFor("USDC-BASE")).toBe("USDC");
    expect(symbolFor("USDT-ETH")).toBe("USDT");
    expect(symbolFor("USDT0-ARB")).toBe("USDT");
    expect(symbolFor("USDT0-OP")).toBe("USDT");
    expect(symbolFor("USDT-NEAR")).toBe("USDT");
    expect(symbolFor("USDC-APTOS")).toBe("USDC");
    expect(symbolFor("BTC")).toBe("BTC");
  });
});
