/**
 * A wallet's own history opens a transaction's details (operator request,
 * 2026-10-01): "In each respective asset in the wallet under the recent
 * subheader can you make it so I can click on each given recent transaction
 * for a respective asset and a mini window or panel appears with the
 * transaction details".
 *
 * Before this, a row in landscape's Recent block, or on portrait's
 * per-asset history page, opened nothing: only its hash was clickable
 * (explorer, or copy). Every one of those surfaces now takes `onOpenTx`;
 * `LandscapeRoot` and `ViewRouter` render the details, because the wallet
 * feature may not import Activity's `TxDetails` (BOUNDARIES.md).
 *
 * Hashes and addresses below are invented.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/openExternal", () => ({ openExternal: vi.fn(async () => true) }));

import { openExternal } from "../../utils/openExternal";
import { openableRowProps } from "../../components/openableRow";
import type { ChainTx } from "../../wallets/types";
import type { XmrTransfer } from "../../wallets/xmr-rpc";
import type { ZanoTransferEntry } from "../../wallets/zano-rpc";
import type { XelisTransferEntry } from "../../wallets/xelis-rpc";
import { ChainTxCard } from "./ChainTxCard";
import { XmrTxHistoryCard } from "../monero/XmrTxHistoryCard";
import { ZanoTxHistoryCard } from "../zano/ZanoTxHistoryCard";
import { XelisTxHistoryCard } from "../xelis/XelisTxHistoryCard";
import { TxDetailsSheet } from "../activity/TxDetails";

/** Every element in a tree, depth first (as `txDetails.test.ts`). */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
  } else if (isValidElement(node)) {
    out.push(node);
    walk((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

type RowProps = { role?: string; onClick?: (e?: unknown) => void; onKeyDown?: (e: unknown) => void };
const rowsOf = (tree: ReactElement[]) =>
  tree.filter((el) => (el.props as RowProps).role === "button") as ReactElement<RowProps>[];
const codesOf = (tree: ReactElement[]) =>
  tree.filter((el) => el.type === "code") as ReactElement<{ onClick: (e: unknown) => void }>[];
const click = () => ({ shiftKey: false, stopPropagation: vi.fn() });

const ETH_SEND: ChainTx = {
  chain: "ethereum",
  hash: "0x" + "12".repeat(32),
  direction: "out",
  amount: "0.5",
  timestamp: 1_790_000_000,
  confirmations: 12,
};

describe("portrait's generic history card (ChainTxCard)", () => {
  const card = (onOpenTx?: (tx: ChainTx) => void) =>
    walk(ChainTxCard({ chain: "ethereum", txs: [ETH_SEND], loading: false, error: null, onOpenTx }));

  it("a row opens its transaction's details", () => {
    const onOpenTx = vi.fn();
    const rows = rowsOf(card(onOpenTx));
    expect(rows).toHaveLength(1);
    rows[0].props.onClick!();
    expect(onOpenTx).toHaveBeenCalledWith(ETH_SEND);
  });

  it("the hash keeps its own click: the explorer, not the details as well", () => {
    const onOpenTx = vi.fn();
    const e = click();
    codesOf(card(onOpenTx))[0].props.onClick(e);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining(ETH_SEND.hash));
    expect(onOpenTx).not.toHaveBeenCalled();
  });

  it("with no handler a row is not a button (nothing would open)", () => {
    expect(rowsOf(card())).toHaveLength(0);
  });
});

describe("Monero, Zano and Xelis open the row Activity shows for the same transfer", () => {
  it("Monero: a mempool receipt opens as received with 0 confirmations", () => {
    const pool: XmrTransfer = {
      txid: "ab".repeat(32),
      amount: 1_500_000_000_000,
      fee: 0,
      height: 0,
      timestamp: 1_790_000_000,
      confirmations: 0,
      type: "pool",
      address: "8Bexample",
      locked: true,
      payment_id: "",
      subaddr_index: { major: 0, minor: 3 },
    };
    const onOpenTx = vi.fn();
    const onCopy = vi.fn();
    const tree = walk(XmrTxHistoryCard({ syncState: "synced", txHistory: [pool], txLoading: false, onCopy, onOpenTx }));
    rowsOf(tree)[0].props.onClick!();
    expect(onOpenTx).toHaveBeenCalledWith(
      expect.objectContaining({ chain: "monero", hash: pool.txid, direction: "in", amount: "1.5", confirmations: 0 }),
    );
    // The txid still copies, and only copies.
    const e = click();
    codesOf(tree)[0].props.onClick(e);
    expect(onCopy).toHaveBeenCalledWith(pool.txid);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(onOpenTx).toHaveBeenCalledTimes(1);
  });

  it("Zano: an amount the wallet could not read opens as no amount, not 0", () => {
    const unknown: ZanoTransferEntry = {
      isIncome: true,
      amount: 0,
      assetId: "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a",
      height: 3_839_000,
      txHash: "cd".repeat(32),
      timestamp: 1_790_000_000,
      amountUnknown: true,
    };
    const noHash: ZanoTransferEntry = { isIncome: false, amount: 1, assetId: unknown.assetId, height: 0 };
    const onOpenTx = vi.fn();
    const tree = walk(
      ZanoTxHistoryCard({ syncState: "ready", txHistory: [unknown, noHash], txLoading: false, onCopy: vi.fn(), onOpenTx }),
    );
    // A transfer with no hash has nothing to look up: one openable row of two.
    const rows = rowsOf(tree);
    expect(rows).toHaveLength(1);
    rows[0].props.onClick!();
    expect(onOpenTx).toHaveBeenCalledWith(
      expect.objectContaining({ chain: "zano", hash: unknown.txHash, direction: "in", amount: "" }),
    );
  });

  it("Xelis: each row opens its own entry, timestamp in seconds", () => {
    const entries: XelisTransferEntry[] = [
      { hash: "ef".repeat(32), kind: "incoming", amountAtomic: 150_000_000n, feeAtomic: null, topoheight: 10, timestamp: 1_790_000_000_000, counterparty: "xel:sender" },
      { hash: "01".repeat(32), kind: "outgoing", amountAtomic: 50_000_000n, feeAtomic: 1_000n, topoheight: 11, timestamp: 1_790_000_100_000, counterparty: "xel:recipient" },
    ];
    const onOpenTx = vi.fn();
    const rows = rowsOf(
      walk(XelisTxHistoryCard({ syncState: "synced", txHistory: entries, txLoading: false, txError: null, onCopy: vi.fn(), onOpenTx })),
    );
    expect(rows).toHaveLength(2);
    rows[1].props.onClick!();
    expect(onOpenTx).toHaveBeenCalledWith(
      expect.objectContaining({ chain: "xelis", hash: entries[1].hash, direction: "out", timestamp: 1_790_000_100 }),
    );
  });
});

describe("an openable row is a button to the keyboard too", () => {
  it("Enter and Space on the row open it; a key on a control inside it does not", () => {
    const open = vi.fn();
    const props = openableRowProps(open);
    const row = {};
    const key = (k: string, target: unknown) => ({ key: k, target, currentTarget: row, preventDefault: vi.fn() });
    props.onKeyDown!(key("Enter", row) as never);
    props.onKeyDown!(key(" ", row) as never);
    props.onKeyDown!(key("Enter", {}) as never);
    props.onKeyDown!(key("a", row) as never);
    expect(open).toHaveBeenCalledTimes(2);
    expect(props).toMatchObject({ role: "button", tabIndex: 0 });
    expect(openableRowProps(undefined)).toEqual({});
  });
});

describe("the details window", () => {
  it("landscape: a centred window titled as the swap details are", () => {
    const html = renderToStaticMarkup(
      createElement(TxDetailsSheet, { tx: ETH_SEND, placement: "window", onClose: () => {} }),
    );
    expect(html).toContain('data-tx-details="window"');
    expect(html).toContain("transaction details");
    expect(html).toContain("align-items:center");
    expect(html).toContain(ETH_SEND.hash);
  });

  it("portrait: the bottom sheet Activity opens, unchanged by default", () => {
    const html = renderToStaticMarkup(createElement(TxDetailsSheet, { tx: ETH_SEND, onClose: () => {} }));
    expect(html).toContain('data-tx-details="sheet"');
    expect(html).toContain("align-items:flex-end");
  });
});

/**
 * The wiring, read from the source: every live history surface of the wallet
 * is given the handler, in both layouts, and both shells render the details.
 * (`DashboardTxHistoryLegacy.tsx` is a frozen backup nothing mounts.)
 */
describe("every wallet history surface opens the details, in both layouts", () => {
  const src = (p: string) =>
    readFileSync(resolve(__dirname, p), "utf8")
      // Comments are prose, not wiring.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
  const mounts = (code: string, name: string) =>
    [...code.matchAll(new RegExp(`<${name}\\b[\\s\\S]*?\\/>`, "g"))].map((m) => m[0]);

  const cases: Array<[string, string, RegExp, number]> = [
    ["../landscape/LandscapeRoot.tsx", "WalletLandscapeView", /onOpenTx=\{txWindow\.open\}/, 1],
    ["../landscape/LandscapeRoot.tsx", "ZanoTxHistoryCard", /onOpenTx=\{txWindow\.open\}/, 1],
    ["../landscape/LandscapeRoot.tsx", "XelisTxHistoryCard", /onOpenTx=\{txWindow\.open\}/, 1],
    ["./WalletLandscapeView.tsx", "ActivityList", /onOpen=\{onOpenTx\}/, 2],
    ["./WalletTxHistorySubview.tsx", "XmrTxHistoryCard", /onOpenTx=\{onOpenTx\}/, 1],
    ["./WalletTxHistorySubview.tsx", "ZanoTxHistoryCard", /onOpenTx=\{onOpenTx\}/, 1],
    ["./WalletTxHistorySubview.tsx", "XelisTxHistoryCard", /onOpenTx=\{onOpenTx\}/, 1],
    ["./WalletTxHistorySubview.tsx", "ChainTxCard", /onOpenTx=\{onOpenTx\}/, 1],
    ["./DashboardView.tsx", "WalletTxHistorySubview", /onOpenTx=\{onOpenTx\}/, 1],
    ["../../ViewRouter.tsx", "DashboardView", /onOpenTx=\{txWindow\.open\}/, 1],
  ];
  for (const [file, name, wired, count] of cases) {
    it(`${file.split("/").pop()}: <${name}> gets the handler`, () => {
      const found = mounts(src(file), name);
      // Positive control: the mounts were located at all.
      expect(found).toHaveLength(count);
      for (const m of found) expect(m).toMatch(wired);
    });
  }

  it("both shells render the details they hold", () => {
    expect(src("../landscape/LandscapeRoot.tsx")).toMatch(/\{txWindow\.element\}/);
    expect(src("../../ViewRouter.tsx")).toMatch(/\{txWindow\.element\}/);
  });
});
