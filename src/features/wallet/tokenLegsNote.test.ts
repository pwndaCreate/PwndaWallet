/**
 * The tokens strip (`TokenLegsCard`, mounted in BOTH layouts) names a USD₮0
 * leg "USDT", with "USD₮0" as a small note (2026-10-06; operator request
 * 2026-10-01). Until then it listed "USDT0 on Arbitrum" on a parent chain and
 * "Arbitrum · USD₮0" among USDT's networks. On Optimism the note is the only
 * difference between its two USDT rows.
 *
 * Rendered with react-dom/server; the landscape rail and portrait list read
 * the same rows from `stablecoinRailGroups` (`stablecoins.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenLegsCard } from "./TokenLegsCard";
import type { ChainType, WalletInfo } from "../../wallets/types";

const w = (chain: ChainType): WalletInfo => ({ chain, address: "0x" + "11".repeat(20), mnemonic: "", privateKey: "" });
const wallets = Object.fromEntries(
  (["optimism", "usdt-op", "usdt0-op", "usdc-op", "arbitrum", "usdt0-arb", "usdt-eth"] as ChainType[]).map((c) => [c, w(c)]),
) as Partial<Record<ChainType, WalletInfo>>;

function render(activeChain: ChainType) {
  return renderToStaticMarkup(
    createElement(TokenLegsCard, {
      activeChain,
      walletsByChain: wallets,
      balancesByChain: { "usdt-op": "0", "usdt0-op": "33", "usdc-op": "0", "usdt0-arb": "512", "usdt-eth": "1" },
      onSelect: () => {},
    }),
  );
}
/** The visible label of the row for `chain` (tags stripped). */
function rowText(html: string, chain: ChainType): string {
  const m = new RegExp(`<button[^>]*data-token-leg="${chain}"[^>]*>([\\s\\S]*?)</button>`).exec(html);
  return (m?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("the tokens strip", () => {
  it("on Optimism lists two USDT rows, the USD₮0 one with its note", () => {
    const html = render("optimism");
    expect(rowText(html, "usdt-op")).toBe("USDT on Optimism 0 USDT");
    expect(rowText(html, "usdt0-op")).toBe("USDT USD₮0 on Optimism 33 USDT");
    expect(html).not.toContain("USDT0");
  });

  it("on a USD₮0 leg lists USDT's networks, the note beside each USD₮0 network", () => {
    const html = render("usdt0-arb");
    expect(rowText(html, "usdt0-arb")).toMatch(/^Arbitrum USD₮0 · viewing 512 USDT$/);
    expect(rowText(html, "usdt0-op")).toBe("Optimism USD₮0 33 USDT");
    expect(rowText(html, "usdt-op")).toBe("Optimism 0 USDT");
    // The fee line names the leg as USDT, with the note.
    expect(html).toContain("Fees for USDT (USD₮0) on Arbitrum are paid in ETH");
  });

  it("is the one component both layouts mount", () => {
    for (const f of ["DashboardView.tsx", "WalletLandscapeView.tsx"]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      expect(src, f).toContain("<TokenLegsCard");
    }
    // The landscape rail draws the same note mark for its network rows.
    const landscape = readFileSync(join(__dirname, "WalletLandscapeView.tsx"), "utf8");
    expect(landscape).toContain("<LegNote note={r.note} />");
  });
});
