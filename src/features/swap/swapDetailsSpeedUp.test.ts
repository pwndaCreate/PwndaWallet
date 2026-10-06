/**
 * The swap details offer "Speed up" under a NEAR Intents swap's BTC deposit
 * while the swap is open (operator request, 2026-10-01: "BTC deposits ... a
 * stuck deposit still can't be sped up"). The shared panel reads the deposit
 * from the chain and stays silent unless it can be replaced; here, rendered
 * with react-dom/server, it shows its first frame. Fails on 6b4e160: no panel.
 *
 * And the row follows a replacement: whichever screen the speed-up was
 * pressed on, every row whose source transaction was replaced takes the
 * replacement's hash and explorer link (`swap-source-replacement.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock("../../state/AppStateContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../state/AppStateContext")>();
  return {
    ...real,
    useAppStateOptional: () => (h.wallet ? { walletsByChain: { bitcoin: h.wallet } } : null),
  };
});
const mem = new Map<string, unknown>();
vi.mock("../../store", () => ({
  getStore: async () => ({
    get: async (k: string) => mem.get(k),
    set: async (k: string, v: unknown) => {
      mem.set(k, v);
    },
    save: async () => {},
  }),
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SwapDetailsModal } from "./SwapDetailsModal";
import { loadSwapHistory, type SwapHistoryEntry } from "./swap-history-store";
import {
  _stopFollowingSourceReplacementsForTests,
  followSourceReplacementsOnce,
  rowsAfterReplacement,
} from "./swap-source-replacement";
import { _clearTxReplacementsForTests, recordTxReplacement } from "../../wallets/tx-replacements";
import type { WalletInfo } from "../../wallets/types";

const DEPOSIT_TX = "317a82a5ddce9b6c997ae6fd6491d0e6e010f2db84ebcf5b0b32d9918615d703";
const REPLACEMENT = "8b".repeat(32);
const WALLET: WalletInfo = {
  chain: "bitcoin",
  address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  privateKey: "",
};

function btcRow(over: Partial<SwapHistoryEntry> = {}): SwapHistoryEntry {
  return {
    id: "swap-btc-usdc",
    fromAsset: "BTC",
    toAsset: "USDC-ETH",
    fromAmount: "0.01",
    toAmount: "947.21",
    status: "pending",
    sourceTxHash: DEPOSIT_TX,
    sourceExplorerUrl: `https://mempool.space/tx/${DEPOSIT_TX}`,
    provider: "NEAR Intents",
    createdAt: "2026-10-01T10:00:00.000Z",
    depositAddress: "bc1qe5xk329xk5tfz3ldvfqxqxahajdva5jl4jzcmy",
    depositDeadline: "2026-10-01T12:00:00.000Z",
    refundTo: WALLET.address,
    ...over,
  };
}

const render = (entry: SwapHistoryEntry, wallet: WalletInfo | null = WALLET) => {
  h.wallet = wallet;
  return renderToStaticMarkup(createElement(SwapDetailsModal, { entry, onClose: () => {} }));
};

beforeEach(() => {
  mem.clear();
  _clearTxReplacementsForTests();
  _stopFollowingSourceReplacementsForTests();
});

describe("SwapDetailsModal: Speed up under a stuck BTC deposit", () => {
  it("a pending NEAR Intents swap from BTC gets the panel, after the source transaction", () => {
    const html = render(btcRow());
    expect(html).toContain('data-speed-up="checking"');
    expect(html.indexOf("data-speed-up")).toBeGreaterThan(html.indexOf("source tx"));
  });

  it("not once the swap is finished, not for another coin, not without a key that can sign", () => {
    expect(render(btcRow({ status: "success" }))).not.toContain("data-speed-up");
    expect(render(btcRow({ status: "refunded" }))).not.toContain("data-speed-up");
    expect(render(btcRow({ status: "failed", failureReason: "deposit-not-on-chain" }))).not.toContain("data-speed-up");
    expect(render(btcRow({ fromAsset: "LTC" }))).not.toContain("data-speed-up");
    expect(render(btcRow(), null)).not.toContain("data-speed-up");
  });
});

describe("a swap's source hash follows its replacement", () => {
  const r = { chain: "bitcoin" as const, replaced: DEPOSIT_TX, by: REPLACEMENT, at: 1 };

  it("the row whose deposit was replaced takes the new hash and link; nothing else changes", () => {
    const other = btcRow({ id: "other", sourceTxHash: "11".repeat(32) });
    const ltc = btcRow({ id: "ltc", fromAsset: "LTC" });
    const next = rowsAfterReplacement([btcRow(), other, ltc], r)!;
    // The link the swap registry builds for BTC, as the confirm modal does.
    expect(next[0]).toMatchObject({ sourceTxHash: REPLACEMENT, sourceExplorerUrl: `https://blockstream.info/tx/${REPLACEMENT}` });
    expect(next[1]).toBe(other);
    // The same hash on another chain is another transaction.
    expect(next[2]).toBe(ltc);
    expect(rowsAfterReplacement([other], r)).toBeNull();
  });

  it("the following starts with the swap resume pass, which App.tsx runs as soon as a wallet is open", () => {
    const src = readFileSync(resolve(fileURLToPath(new URL(".", import.meta.url)), "intents-status-resume.ts"), "utf8");
    expect(src).toMatch(/export function resumePendingIntentsSwapsOnce\(\): void \{\s*followSourceReplacementsOnce\(\);/);
  });

  it("recorded anywhere — the transaction details too — it is written to the stored history", async () => {
    mem.set("swapHistory", [btcRow()]);
    followSourceReplacementsOnce();
    followSourceReplacementsOnce(); // idempotent: one write, not two
    recordTxReplacement(r);
    await vi.waitFor(async () => {
      const [row] = await loadSwapHistory();
      expect(row.sourceTxHash).toBe(REPLACEMENT);
    });
  });
});
