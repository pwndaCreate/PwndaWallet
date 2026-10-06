/**
 * The swap screens name a leg the way the picker does (2026-10-06; operator
 * request 2026-10-01): "USDT", with "USD₮0" in the small print — never the
 * registry key. Before, after the picker had already dropped the name, the
 * minimum hint still read "Min: 1.5 USDT0 for USDT0-ARB → BTC" and the
 * confirm screen "100 USDT0-OP", which also left Optimism's two USDT legs a
 * "0" apart ("USDT-OP" / "USDT0-OP").
 *
 * Both screens are shared by the portrait and landscape layouts
 * (`SwapForm`, `SwapConfirmModal`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { legDisplayName } from "./picker-rows";
import { AssetAmount } from "./SwapConfirmModal";
import { getAdapter } from "../../wallets";
import type { ChainType } from "../../wallets/types";

const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").replace(/^\||\|$/g, "");

describe("legDisplayName", () => {
  it("spells a leg as the wallet does", () => {
    expect(legDisplayName("USDT0-ARB")).toBe("USDT (Arbitrum · USD₮0)");
    expect(legDisplayName("USDT0-OP")).toBe("USDT (Optimism · USD₮0)");
    expect(legDisplayName("USDT-OP")).toBe("USDT (Optimism)");
    expect(legDisplayName("USDC-ARB")).toBe("USDC (Arbitrum)");
    expect(legDisplayName("BTC")).toBe("BTC");
  });

  it("is the wallet's own name for every USD₮0 leg and every leg added on 2026-10-06", () => {
    const legs: Array<[string, ChainType]> = [
      ["USDT0-ARB", "usdt0-arb"],
      ["USDT0-POL", "usdt0-pol"],
      ["USDT0-MONAD", "usdt0-monad"],
      ["USDT0-OP", "usdt0-op"],
      ["USDT-NEAR", "usdt-near"],
      ["USDC-NEAR", "usdc-near"],
      ["USDT-APTOS", "usdt-aptos"],
      ["USDC-APTOS", "usdc-aptos"],
    ];
    for (const [key, chain] of legs) {
      expect(legDisplayName(key), key).toBe(getAdapter(chain).displayName);
    }
  });
});

describe("the confirm screen's amounts", () => {
  const render = (asset: string, receive = false) =>
    renderToStaticMarkup(createElement(AssetAmount, { label: "you send", amount: "100", asset, receive }));

  it("Optimism's USD₮0: '100 USDT', with 'Optimism · USD₮0' beneath", () => {
    const html = render("USDT0-OP");
    expect(text(html)).toBe("you send|100 |USDT|Optimism · USD₮0");
    expect(html).toContain("data-asset-network");
    expect(html).not.toContain("USDT0");
  });

  it("Optimism's bridged USDT: the same symbol, its own network line", () => {
    expect(text(render("USDT-OP"))).toBe("you send|100 |USDT|Optimism");
  });

  it("a native coin has no network line", () => {
    const html = render("BTC", true);
    expect(text(html)).toBe("you send|100 |BTC");
    expect(html).not.toContain("data-asset-network");
  });

  it("the modal draws both sides with it, and its fee lines use the symbol", () => {
    const src = readFileSync(join(__dirname, "SwapConfirmModal.tsx"), "utf8").replace(/\r\n/g, "\n");
    expect(src).toContain('<AssetAmount label="you send" amount={fromAmount} asset={fromAsset} />');
    expect(src).toContain('<AssetAmount label="you receive" amount={`~${q.expectedReceive}`} asset={toAsset} receive />');
    expect(src).toContain("v={`${q.minReceived} ${symbolFor(toAsset)}`}");
    expect(src).toContain("v={`${q.totalFeesSource} ${symbolFor(fromAsset)}`}");
  });
});

describe("the swap form's hints, quote lines and toasts", () => {
  it("print the picker's symbol and the leg's name, never the key or the registry ticker", () => {
    const src = readFileSync(join(__dirname, "SwapForm.tsx"), "utf8").replace(/\r\n/g, "\n");
    expect(src).toContain("const fromSym = symbolFor(fromCoin);");
    expect(src).toContain("const toSym = symbolFor(toCoin);");
    expect(src).toContain("const fromName = legDisplayName(fromCoin);");
    expect(src).toContain("const toName = legDisplayName(toCoin);");
    expect(src).toContain("for ${fromName} → ${toName}`");
    expect(src).toContain("`1 ${fromSym} = ${fmtBal(rate)} ${toSym}`");
    // The spellings that brought "USDT0" back: the hook's registry ticker,
    // and a key interpolated into text. A key passed as a PROP (`ticker=`,
    // `symbol=`) is an identifier, and stays.
    expect(src).not.toContain("intentsMinimum.ticker");
    expect(src).not.toMatch(/\$\{(fromCoin|toCoin)\}/);
    expect(src).not.toMatch(/[^=]\{(fromCoin|toCoin)\}/);
  });
});
