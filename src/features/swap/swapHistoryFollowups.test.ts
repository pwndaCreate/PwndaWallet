/**
 * Two swap-history gaps closed on 2026-09-30, after the swap-details view
 * landed.
 *
 *  - The minimum received was never stored on a history row, so the details
 *    view could only show it while 1Click still echoed the quote.
 *  - Unfinished NEAR Intents swaps were re-tracked only when the Swap form
 *    mounted: after a restart, a swap that had finished read "pending" in
 *    Activity until the user happened to open Swap.
 *
 * Source assertions (the modal and App need a full context to render), plus
 * the pure reader.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { minReceivedOf } from "./swap-details";
import type { SwapHistoryEntry } from "./swap-history-store";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

const row = (extra: Partial<SwapHistoryEntry>): SwapHistoryEntry => ({
  id: "r1",
  fromAsset: "LTC",
  toAsset: "USDC-POL",
  fromAmount: "0.1",
  toAmount: "7.0",
  status: "pending",
  sourceTxHash: "",
  sourceExplorerUrl: "",
  createdAt: "2026-09-30T00:00:00.000Z",
  ...extra,
});

describe("the minimum received is kept with the swap", () => {
  it("the confirm modal writes it into the NEAR Intents history row", () => {
    const src = read("SwapConfirmModal.tsx");
    const writer = src.slice(src.indexOf("const writeIntentsRow"), src.indexOf("const followIntents"));
    expect(writer).toContain("minReceived: q.minReceived");
  });

  it("the details view reads it back, and treats blank as absent", () => {
    expect(minReceivedOf(row({ minReceived: "6.91" }))).toBe("6.91");
    expect(minReceivedOf(row({ minReceived: "  " }))).toBeNull();
    expect(minReceivedOf(row({}))).toBeNull();
  });
});

describe("unfinished swaps are re-tracked when a wallet opens, not when Swap mounts", () => {
  it("App starts the resume pass once a wallet is loaded", () => {
    const app = read("../../App.tsx");
    expect(app).toMatch(/import \{[^}]*resumePendingIntentsSwapsOnce[^}]*\} from "\.\/features\/swap"/);
    expect(app).toMatch(
      /if \(Object\.keys\(walletsByChain\)\.length > 0\) resumePendingIntentsSwapsOnce\(\);/,
    );
  });

  it("the swap barrel exports it (App may not reach into the feature's files)", () => {
    expect(read("index.ts")).toContain(
      'export { resumePendingIntentsSwapsOnce } from "./intents-status-resume";',
    );
  });
});
