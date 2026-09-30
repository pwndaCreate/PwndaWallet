/**
 * The swap details show where each leg was sent from and received at
 * (2026-09-30).
 *
 * The operator asked to see "which address each transaction was sent and
 * received from". The swap details listed hashes and the deposit address, but
 * not where the swap paid out, where a refund would go, or which of the
 * wallet's addresses the deposit came from — for a UTXO account that is often
 * a change address, not the one on screen. Now:
 *  - history rows store the quote's payout (`recipient`) and refund
 *    (`refundTo`) addresses; older rows read them from 1Click's echo;
 *  - each leg's sender and recipient are read from its chain by hash
 *    (`getTransactionParties`, via `useTxParties`), the wallet's marked.
 *
 * Addresses and hashes are invented.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readIntentsLiveDetails, swapLegChain } from "./swap-details";
import { SwapDetailsModal } from "./SwapDetailsModal";
import type { SwapHistoryEntry } from "./swap-history-store";
import { ALL_CHAINS, getAdapter } from "../../wallets";
import { ASSET_CAPABILITIES } from "./asset-capabilities";
import type { TxParties } from "../../wallets/types";
import { clearTxPartiesCache, readTxParties } from "../../lib/txParties";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

const DEPOSIT = "LSandboxDepositInvented00000000000";
const REFUND = "ltc1qrefundinvented0000000000000000000000";
const CHANGE = "ltc1qchangeinvented0000000000000000000000";
const INPUT = "ltc1qinputinvented00000000000000000000000";
const PAYOUT = "0x0000000000000000000000000000000000abcdef";
const SOURCE_HASH = "5a4d" + "0".repeat(56) + "beef";

const row = (extra: Partial<SwapHistoryEntry> = {}): SwapHistoryEntry => ({
  id: "s1",
  fromAsset: "LTC",
  toAsset: "USDC-POL",
  fromAmount: "0.25",
  toAmount: "16.80",
  status: "success",
  sourceTxHash: SOURCE_HASH,
  sourceExplorerUrl: "",
  provider: "NEAR Intents · 1Click",
  createdAt: "2026-09-30T12:20:00.000Z",
  depositAddress: DEPOSIT,
  ...extra,
});

afterEach(() => {
  clearTxPartiesCache();
  vi.restoreAllMocks();
});

describe("where the swap pays out and where a refund goes", () => {
  it("the confirm modal stores both on the history row", () => {
    const src = read("SwapConfirmModal.tsx");
    const writer = src.slice(src.indexOf("const writeIntentsRow"), src.indexOf("const followIntents"));
    expect(writer).toContain("recipient: q.intentsRequest.recipient");
    expect(writer).toContain("refundTo: q.intentsRequest.refundTo");
  });

  it("older rows read them from 1Click's echo of the request", () => {
    const live = readIntentsLiveDetails({
      status: "SUCCESS",
      quoteResponse: { quoteRequest: { recipient: PAYOUT, refundTo: REFUND }, quote: {} },
    });
    expect(live.recipient).toBe(PAYOUT);
    expect(live.refundTo).toBe(REFUND);
    expect(readIntentsLiveDetails({ status: "SUCCESS" }).recipient).toBeNull();
  });

  it("the details show both, named by network", () => {
    const html = renderToStaticMarkup(
      createElement(SwapDetailsModal, { entry: row({ recipient: PAYOUT, refundTo: REFUND }), onClose: () => {} }),
    );
    expect(html).toContain("payout address · yours on Polygon");
    expect(html).toContain(PAYOUT);
    expect(html).toContain("refund address · yours on Litecoin");
    expect(html).toContain(REFUND);
  });
});

describe("each leg's sender and recipient, read from its chain", () => {
  it("maps a swap asset to the wallet chain whose adapter reads that leg", () => {
    expect(swapLegChain("LTC")).toBe("litecoin");
    expect(swapLegChain("USDC-POL")).toBe("usdc-pol");
    expect(swapLegChain("usdt-tron")).toBe("usdt-tron");
    expect(swapLegChain("XMR")).toBe("monero");
    expect(swapLegChain("ZEPHUSD")).toBe("zephyr");
    expect(swapLegChain("NOT-AN-ASSET")).toBeNull();
  });

  it("a native EVM coin maps to its own chain, not the shared ethereum wallet", () => {
    // Every EVM coin's `walletsByChainKey` is `ethereum` (one key), so a POL
    // leg was looked up on Ethereum's RPCs until 2026-09-30 (found by the
    // wiki pass).
    expect(swapLegChain("ETH")).toBe("ethereum");
    expect(swapLegChain("POL")).toBe("polygon");
    expect(swapLegChain("AVAX")).toBe("avalanche");
    expect(swapLegChain("FLR")).toBe("flare");
    expect(swapLegChain("MON")).toBe("monad");
    expect(swapLegChain("BNB")).toBe("bsc");
  });

  it("every native EVM swap coin lands on the wallet chain with its own ticker", () => {
    const natives = Object.entries(ASSET_CAPABILITIES).filter(
      ([t, cap]) => cap.chainKind === "EVM" && !ALL_CHAINS.some((c) => c === t.toLowerCase()),
    );
    expect(natives.length).toBeGreaterThanOrEqual(6);
    for (const [ticker] of natives) {
      const chain = swapLegChain(ticker);
      expect(chain, ticker).not.toBeNull();
      expect(getAdapter(chain!).ticker, ticker).toBe(ticker);
    }
  });

  it("the deposit leg names the deposit address, the wallet's inputs, and its change", async () => {
    const adapter = getAdapter("litecoin") as unknown as { getTransactionParties?: unknown };
    const had = adapter.getTransactionParties;
    adapter.getTransactionParties = vi.fn(
      async () => ({ from: [INPUT], to: [DEPOSIT, CHANGE], source: "litecoinspace.org" }) as TxParties,
    );
    try {
      // The answer the details view would get when it opens (cached, so the
      // static render below sees it on its first render).
      await readTxParties("litecoin", SOURCE_HASH, REFUND);
      // The account scan knows the input and the change address as the wallet's.
      const registry = await import("../../lib/utxoAccountRegistry");
      registry.setUtxoAccountSummary("litecoin", {
        entries: [
          { address: INPUT, chain: 1, index: 4, sat: 0, used: true },
          { address: CHANGE, chain: 1, index: 5, sat: 0, used: true },
        ],
      } as never);
      const html = renderToStaticMarkup(
        createElement(SwapDetailsModal, { entry: row({ refundTo: REFUND }), onClose: () => {} }),
      );
      expect(html).toContain("data-leg-parties");
      expect(html).toContain(`${DEPOSIT}<span`);
      expect(html).toContain("· NEAR Intents deposit");
      expect(html).toContain("· you (change)");
      expect(html).toMatch(new RegExp(`${INPUT}<span[^>]*>· you<`));
      registry.clearUtxoAccountSummary("litecoin");
    } finally {
      adapter.getTransactionParties = had;
    }
  });
});
