/**
 * The portrait wallet's history card for a chain with no history source
 * (2026-09-30).
 *
 * BSC and Monad have no free history source, and their adapters throw
 * `HistoryUnavailableError`. Activity lists them apart from failures, in a
 * neutral tone; this card still printed the orange
 * "Couldn't fetch BNB transactions: history not available for …" line, so the
 * same chain read as broken in one place and as expected in the other. Found
 * by the wiki pass after the Activity fixes were combined.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChainTxCard } from "./ChainTxCard";
import { HistoryUnavailableError } from "../../wallets/tx-history-errors";

const render = (error: string) =>
  renderToStaticMarkup(createElement(ChainTxCard, { chain: "bsc", txs: [], loading: false, error }));

describe("ChainTxCard when a chain's history cannot be read", () => {
  it("a chain with no history source reads as not available, not as a failure", () => {
    const html = render(new HistoryUnavailableError("BNB Smart Chain").message);
    expect(html).toContain("not available in the wallet yet");
    expect(html).not.toContain("Couldn&#x27;t fetch");
    expect(html).not.toContain("No transactions yet");
  });

  it("a real failure still says so, with the error", () => {
    const html = render("HTTP 503 from https://api.routescan.io/…");
    expect(html).toContain("Couldn&#x27;t fetch");
    expect(html).toContain("HTTP 503");
  });
});
