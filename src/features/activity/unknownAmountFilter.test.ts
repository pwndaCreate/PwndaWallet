/**
 * Portrait Activity's default "hide zero" filter and rows whose amount is
 * unknown (operator request, 2026-10-01).
 *
 * `txIsMeaningful` read an empty amount as zero: `parseFloat("")` is NaN, and
 * NaN failed the `> 0` test. Two kinds of row have no amount on purpose, and
 * portrait Activity hid both by default and counted them as "zero-amount
 * hidden":
 *  - a Solana token (SPL) row: the list reads only the signature, so its
 *    direction and amount are read when the details open
 *    (`spl-token-wallet.ts`, `amount: ""`);
 *  - a Zano transfer the wallet could not read an amount for
 *    (`zanoTransfersToChainTx`, `amount: ""` since 2026-10-01).
 * An unknown amount is not a zero amount. Only a parsed 0 is hidden.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(async () => null) }));

import type { ChainTx } from "../../wallets/types";
import { zanoTransfersToChainTx } from "../../wallets/zano-wallet";
import { txIsMeaningful } from "./txFilters";

/** An SPL list row as `spl-token-wallet.ts` builds it from a signature (invented values). */
const splRow: ChainTx = {
  chain: "usdc-sol",
  hash: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
  direction: "pending",
  amount: "",
  timestamp: 1_790_000_000,
  height: 300_000_000,
};

const ZANO_NATIVE = "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a";

describe("hide zero keeps rows whose amount is unknown", () => {
  it("an empty amount is not zero: an SPL row and an unread Zano transfer stay visible", () => {
    const [zano] = zanoTransfersToChainTx([
      { isIncome: true, amount: 0, amountUnknown: true, assetId: ZANO_NATIVE, height: 3_100_000, txHash: "97".repeat(32) },
    ]);
    expect(zano.amount).toBe("");
    // Was: both false, so the default filter hid them.
    expect(txIsMeaningful(splRow)).toBe(true);
    expect(txIsMeaningful(zano)).toBe(true);
  });

  it("a parsed zero is still hidden, and an amount above zero is still shown", () => {
    const row = (amount: string): ChainTx => ({ chain: "ripple", hash: "A1", direction: "in", amount });
    expect(txIsMeaningful(row("0"))).toBe(false);
    expect(txIsMeaningful(row("0.000000000"))).toBe(false);
    expect(txIsMeaningful(row("0.00000001"))).toBe(true);
    expect(txIsMeaningful(row("1500"))).toBe(true);
  });

  it("the hidden count reads the same rule: unknown amounts are not counted as zero-amount", () => {
    const rows: ChainTx[] = [
      splRow,
      { chain: "ripple", hash: "A1", direction: "in", amount: "0" },
      { chain: "ripple", hash: "A2", direction: "in", amount: "12.5" },
    ];
    // The portrait view's two expressions (`ActivityViewPortrait.tsx`).
    expect(rows.filter(txIsMeaningful).map((t) => t.hash)).toEqual([splRow.hash, "A2"]);
    expect(rows.filter((t) => !txIsMeaningful(t))).toHaveLength(1);
  });

  it("the views that hide zero rows filter AND count with this one rule; landscape hides none", () => {
    const src = (f: string) => readFileSync(resolve(__dirname, f), "utf8");
    const portrait = src("ActivityViewPortrait.tsx");
    expect(portrait).toContain("pool = pool.filter(txIsMeaningful)");
    expect(portrait).toContain("pool.filter((t) => !txIsMeaningful(t)).length");
    // The legacy table (mounted nowhere since landscape took over, kept live).
    const table = src("ActivityView.tsx");
    expect(table).toContain('amountFilter === "meaningful" && !txIsMeaningful(tx)');
    expect(table).toContain("!txIsMeaningful(row.tx)");
    // Landscape Activity has no zero filter: every row is listed.
    expect(src("ActivityLandscapeView.tsx")).not.toContain("txIsMeaningful");
  });
});
