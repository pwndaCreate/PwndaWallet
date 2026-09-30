/**
 * The Activity data path, end to end, after the two 2026-09-30 history fixes
 * were combined: the Activity branch's per-chain merge (`historyStatus.ts`)
 * and the wallet layer's account netting (`utxo-account-history.ts`) now use
 * ONE rule, in `mergeChainTx`.
 *
 * The operator's report: one Litecoin send listed five times in Activity as
 * "▼ recv +4.02888049 LTC", and no way to see what a transaction was. The
 * incident shape is rebuilt here from invented addresses and an invented txid
 * (the real ones are the operator's): the primary address spent 4.32888299,
 * 0.3 went to someone else, 4.02888049 came back as change to change/20, and
 * the fee was 250 sat.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChainTx } from "../../wallets/types";
import { esploraTxToChainTx, type EsploraTx } from "../../wallets/esplora-history";
import {
  chainAddresses,
  compareTxNewestFirst,
  displayedAddressByChain,
  mergeChainTx,
  ownedChainsOf,
} from "./useTxHistory";
import { chainHistoryStatuses } from "./historyStatus";
import { txDetailsModel, TxDetailsSheet } from "./TxDetails";
import { ModalBackdrop } from "../../components/ModalBackdrop";
import { Backdrop } from "../swap/modal-parts";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

const PRIMARY = "ltc1qprimaryaddressinvented0000000000000";
const CHANGE = Array.from({ length: 4 }, (_, i) => `ltc1qchangeaddressinvented00000000000${i}`);
const CHANGE20 = CHANGE[3];
const EXTERNAL = "ltc1qsomeoneelseinvented000000000000000";
const TXID = "a11ce" + "0".repeat(58) + "1";

const SEND: EsploraTx = {
  txid: TXID,
  fee: 250,
  status: { confirmed: true, block_height: 3_160_000, block_time: 1_787_400_000 },
  vin: [{ prevout: { scriptpubkey_address: PRIMARY, value: 432_888_299 } }],
  vout: [
    { scriptpubkey_address: EXTERNAL, value: 30_000_000 },
    { scriptpubkey_address: CHANGE20, value: 402_888_049 },
  ],
};

/** `useTxHistory`'s pairs for the account: the displayed address first. */
const PAIRS = [PRIMARY, ...CHANGE].map((address) => ({ chain: "litecoin" as const, address }));

/** Per-address rows as the LTC adapter's Esplora reader returns them. */
function txByChainFor(txs: EsploraTx[]): Record<string, ChainTx[]> {
  const out: Record<string, ChainTx[]> = {};
  for (const { chain, address } of PAIRS) {
    out[`${chain}:${address}`] = txs
      .filter((t) =>
        [
          ...(t.vin ?? []).map((v) => v.prevout?.scriptpubkey_address),
          ...(t.vout ?? []).map((v) => v.scriptpubkey_address),
        ].includes(address),
      )
      .map((t) => esploraTxToChainTx(t, address, chain));
  }
  return out;
}

describe("the incident, through the Activity views' own data path", () => {
  it("one row: a 0.3 LTC send to the other party, the fee beside it", () => {
    const txByChain = txByChainFor([SEND]);
    const statuses = chainHistoryStatuses(ownedChainsOf(PAIRS), { txByChain });
    expect(statuses).toHaveLength(1);
    expect(statuses[0].txs).toHaveLength(1);
    expect(statuses[0].txs[0]).toMatchObject({
      hash: TXID,
      direction: "out",
      amount: "0.30000000",
      fee: "0.00000250",
      counterparty: EXTERNAL,
    });
  });

  it("App's chain list names Litecoin once, and its address is the displayed one", () => {
    expect(ownedChainsOf(PAIRS)).toEqual(["litecoin"]);
    expect(displayedAddressByChain(PAIRS)).toEqual({ litecoin: PRIMARY });
    // Before: one entry per pair, and the LAST pair's address.
    const before: Record<string, string> = {};
    for (const p of PAIRS) before[p.chain] = p.address;
    expect(PAIRS.map((p) => p.chain)).toHaveLength(5);
    expect(before.litecoin).toBe(CHANGE20);
  });

  it("App builds both from the helpers", () => {
    const app = read("../../App.tsx");
    expect(app).toContain("const ownedChains = useMemo(() => ownedChainsOf(txPairs), [txPairs]);");
    expect(app).toContain("const addressByChain = useMemo(() => displayedAddressByChain(txPairs), [txPairs]);");
  });

  it("a send whose change came back to the SAME address also states the amount without the fee", () => {
    const selfChange: EsploraTx = {
      ...SEND,
      txid: "b0b" + "0".repeat(60) + "2",
      vin: [{ prevout: { scriptpubkey_address: PRIMARY, value: 100_000_000 } }],
      vout: [
        { scriptpubkey_address: EXTERNAL, value: 10_000_000 },
        { scriptpubkey_address: PRIMARY, value: 89_999_750 },
      ],
    };
    const [row] = mergeChainTx({ txByChain: txByChainFor([selfChange]) }, "litecoin").txs;
    expect(row).toMatchObject({ direction: "out", amount: "0.10000000", fee: "0.00000250", counterparty: EXTERNAL });
  });

  it("an account-model chain is untouched: its amount already excludes the fee", () => {
    const eth: ChainTx = { chain: "ethereum", hash: "0x01", direction: "out", amount: "1.5", fee: "0.001", timestamp: 5 };
    const [row] = mergeChainTx({ txByChain: { "ethereum:0xme": [eth] } }, "ethereum").txs;
    expect(row).toEqual(eth);
  });
});

describe("a transaction waiting for a block is listed first", () => {
  const mined = (hash: string, timestamp: number): ChainTx => ({ chain: "litecoin", hash, direction: "in", amount: "1", timestamp });
  const mempool: ChainTx = { chain: "litecoin", hash: "m", direction: "pending", amount: "1", confirmations: 0 };

  it("an unmined row sorts above every mined one (it had no timestamp, so it sank to the bottom)", () => {
    const rows = [mined("old", 100), mempool, mined("new", 300)].sort(compareTxNewestFirst);
    expect(rows.map((r) => r.hash)).toEqual(["m", "new", "old"]);
  });

  it("a mined row without a timestamp still sorts last; an SPL 'pending' with a block is not unmined", () => {
    const noTime: ChainTx = { chain: "ethereum", hash: "nt", direction: "in", amount: "1", height: 10 };
    const spl: ChainTx = { chain: "usdc-sol", hash: "spl", direction: "pending", amount: "", height: 99, timestamp: 50 };
    const rows = [noTime, mined("a", 100), spl].sort(compareTxNewestFirst);
    expect(rows.map((r) => r.hash)).toEqual(["a", "spl", "nt"]);
  });

  it("a row already in a block is never pinned, whatever its count says", () => {
    // Aptos reported its failed transactions as `confirmations: 0`
    // (aptHistory.test.ts); a block height settles it.
    const inBlock: ChainTx = { chain: "aptos", hash: "f", direction: "failed", amount: "1", confirmations: 0, height: 7, timestamp: 50 };
    const rows = [inBlock, mined("new", 300)].sort(compareTxNewestFirst);
    expect(rows.map((r) => r.hash)).toEqual(["new", "f"]);
  });

  it("mergeChainTx and both mounted Activity views sort with it", () => {
    const pending: EsploraTx = {
      ...SEND,
      txid: "c0ffee" + "0".repeat(57) + "3",
      status: { confirmed: false },
    };
    const txs = mergeChainTx({ txByChain: txByChainFor([SEND, pending]) }, "litecoin").txs;
    expect(txs[0].hash).toBe(pending.txid);
    expect(txs[0].direction).toBe("pending");
    for (const view of ["ActivityLandscapeView.tsx", "ActivityViewPortrait.tsx"]) {
      expect(read(view)).toContain("deduped.sort(compareTxNewestFirst);");
    }
  });
});

describe("the details name the wallet's side of a UTXO transaction exactly", () => {
  const own = chainAddresses(txByChainFor([SEND]), "litecoin");

  it("chainAddresses lists every address the history holds for the chain", () => {
    expect(own).toEqual([PRIMARY, ...CHANGE]);
  });

  it("a send: from the address that actually paid (you), to the other party", () => {
    const [row] = mergeChainTx({ txByChain: txByChainFor([SEND]) }, "litecoin").txs;
    const m = txDetailsModel(row, { ownAddress: PRIMARY, ownAddresses: own });
    expect(m.from).toEqual([{ address: PRIMARY, you: true }]);
    // Every output: the other party, and the change back to this wallet.
    expect(m.to).toEqual([
      { address: EXTERNAL, you: false },
      { address: CHANGE20, you: true, change: true },
    ]);
  });

  it("a receipt at a change address: to that address (you), from the sender's input", () => {
    const receipt: EsploraTx = {
      ...SEND,
      txid: "d00d" + "0".repeat(59) + "4",
      vin: [{ prevout: { scriptpubkey_address: EXTERNAL, value: 50_000_000 } }],
      vout: [{ scriptpubkey_address: CHANGE[1], value: 49_999_750 }],
    };
    const [row] = mergeChainTx({ txByChain: txByChainFor([receipt]) }, "litecoin").txs;
    // Before: "to" was the displayed address, whatever address received.
    const m = txDetailsModel(row, { ownAddress: PRIMARY, ownAddresses: own });
    expect(m.to).toEqual([{ address: CHANGE[1], you: true }]);
    expect(m.from).toEqual([{ address: EXTERNAL, you: false }]);
  });

  it("both views pass the chain's addresses to the details", () => {
    expect(read("ActivityLandscapeView.tsx")).toContain("ownAddresses={chainAddresses(txByChain, detail.chain)}");
    expect(read("ActivityViewPortrait.tsx")).toContain("ownAddresses={chainAddresses(txByChain, selected.chain)}");
  });
});

describe("the portrait details sheet survives a window move (the swap modals' 2026-09-30 fix)", () => {
  it("it is built on the shared ModalBackdrop, which the swap modals use too", () => {
    const html = renderToStaticMarkup(
      createElement(TxDetailsSheet, {
        tx: { chain: "litecoin", hash: TXID, direction: "in", amount: "1" },
        onClose: () => {},
      }),
    );
    expect(html).toContain("data-modal-backdrop");
    // The title-bar strip that lets a press there move the window.
    expect(html).toMatch(/data-tauri-drag-region="true"/);
    // One implementation: the swap modals' `Backdrop` IS this component, so
    // swapDetails.test.ts's press/drag/release cases cover the sheet too.
    expect(Backdrop).toBe(ModalBackdrop);
  });
});
