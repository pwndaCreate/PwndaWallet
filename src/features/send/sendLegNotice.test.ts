/**
 * The Send modal names a stablecoin leg's network, with USD₮0's note, and
 * shows a cost beyond the fee before Send (2026-10-06; operator request
 * 2026-10-01).
 *
 *  - "Send USDT" alone cannot tell Optimism's bridged USDT from its USD₮0 —
 *    both read USDT since the relabel — so a leg's modal says "on Optimism",
 *    with the "USD₮0" note on the USD₮0 one.
 *  - A NEP-141 send to an unregistered account also pays the contract's
 *    storage deposit, and an Aptos token send to a first-time recipient pays
 *    for its store: the adapters say so in `GasBudget.notice`, which the modal
 *    shows whatever the verdict.
 *
 * Rendered with react-dom/server (effects do not run, so the budget-driven
 * notice is rendered through its own component), as `sendMemo.test.ts` does.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GasNotice, SendModal } from "./SendModal";
import { getAdapter } from "../../wallets";
import type { ChainAdapter, ChainType } from "../../wallets/types";

function render(adapter: ChainAdapter) {
  return renderToStaticMarkup(
    createElement(SendModal, {
      adapter,
      sendTo: "",
      setSendTo: () => {},
      sendAmount: "",
      setSendAmount: () => {},
      sending: false,
      onSend: () => {},
      onClose: () => {},
    }),
  );
}
const legLine = (html: string) => /<div data-send-leg[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? null;
const strip = (s: string | null) => (s ?? "").replace(/<[^>]+>/g, "");

describe("the Send modal names the leg", () => {
  it("Optimism's USD₮0: 'Send USDT', on Optimism, with the USD₮0 note", () => {
    const html = render(getAdapter("usdt0-op"));
    expect(html).toContain("<h3>Send USDT</h3>");
    const line = legLine(html);
    expect(line).toContain("data-leg-note");
    expect(strip(line)).toBe("on OptimismUSD₮0");
  });

  it("Optimism's bridged USDT: the same title, on Optimism, no note", () => {
    const html = render(getAdapter("usdt-op"));
    expect(html).toContain("<h3>Send USDT</h3>");
    expect(strip(legLine(html))).toBe("on Optimism");
    expect(legLine(html)).not.toContain("data-leg-note");
  });

  it("every USD₮0 leg carries the note; a NEAR or Aptos leg names its chain", () => {
    for (const c of ["usdt0-arb", "usdt0-pol", "usdt0-monad"] as ChainType[]) {
      expect(legLine(render(getAdapter(c))), c).toContain("USD₮0");
    }
    expect(strip(legLine(render(getAdapter("usdt-near"))))).toBe("on NEAR");
    expect(strip(legLine(render(getAdapter("usdc-aptos"))))).toBe("on Aptos");
  });

  it("a chain that is not a leg gets no such line", () => {
    expect(legLine(render(getAdapter("bitcoin")))).toBeNull();
    expect(legLine(render(getAdapter("near")))).toBeNull();
  });
});

describe("a cost beyond the fee is shown before Send", () => {
  it("renders the adapter's notice, and nothing without one", () => {
    const html = renderToStaticMarkup(
      createElement(GasNotice, { notice: "this send also registers it: 0.00125 NEAR" }),
    );
    expect(html).toContain("data-gas-notice");
    expect(html).toContain("0.00125 NEAR");
    expect(renderToStaticMarkup(createElement(GasNotice, { notice: undefined }))).toBe("");
  });

  it("the modal feeds it the live budget's notice, outside the shortfall box", () => {
    const src = readFileSync(join(__dirname, "SendModal.tsx"), "utf8").replace(/\r\n/g, "\n");
    expect(src).toContain("<GasNotice notice={gas?.notice} />");
    // Not inside `gas.sufficient === false`: shown whatever the verdict.
    const at = src.indexOf("<GasNotice notice={gas?.notice} />");
    const shortfall = src.indexOf("{gas && gas.sufficient === false && (");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(shortfall);
  });
});
