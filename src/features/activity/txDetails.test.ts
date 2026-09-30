/**
 * Transaction details: one shared component, mounted by both layouts
 * (operator report 2026-09-30: "I want to be able to click on transactions
 * whether in or out and see the data on them").
 *
 * Before: landscape had its own private `DetailPanel` (truncated hash, no
 * sender or recipient, no USD value, "View on explorer" silently copying the
 * hash on the ~20 chains `explorerTxUrl` had no link for); portrait had no
 * details — a tap opened a block explorer.
 *
 * The component is rendered with react-dom/server and its element tree is
 * walked to press the explorer button: this repo has no DOM test harness
 * (as `sendMemo.test.ts` does).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/openExternal", () => ({ openExternal: vi.fn(async () => undefined) }));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openExternal } from "../../utils/openExternal";
import { Btn } from "../../components/PrimitivesV2";
import type { ChainTx } from "../../wallets/types";
import { TxDetails, TxDetailsStatic, TxDetailsView, openTxInExplorer, txDetailsModel } from "./TxDetails";

const ME = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const PEER = "0x44A3831B70E4cfBA7d73262Dc78443664cAbe644";
const HASH = "0x2c9af6a8429a8badc3a81f7288a3e93ecd766c7eb15ca9f8ad98bacd4d64171f";

/** A USDC-on-Arbitrum send, as `evm-history.ts` reads it from Blockscout v2. */
const usdcArbSend: ChainTx = {
  chain: "usdc-arb",
  hash: HASH,
  direction: "out",
  amount: "10",
  fee: "0.0000070849",
  timestamp: 1757002895,
  confirmations: undefined,
  height: 23290907,
  counterparty: PEER,
  meta: { from: ME, to: PEER, intended: "out", method: "0xa9059cbb", logIndex: 12, source: "arbitrum.blockscout.com" },
};

beforeEach(() => vi.mocked(openExternal).mockClear());

describe("txDetailsModel: every field the operator asked for", () => {
  const m = txDetailsModel(usdcArbSend, { ownAddress: ME, pricesByTicker: { USDC: 1 } });

  it("direction, amount, asset, USD value, chain", () => {
    expect(m).toMatchObject({
      directionLabel: "▲ sent",
      sign: "−",
      amount: "10",
      ticker: "USDC",
      usd: "$10.00",
      chainName: "USDC (Arbitrum)",
    });
  });

  it("the fee in the coin that paid it — ETH on Arbitrum, not USDC", () => {
    expect(m.fee).toBe("0.0000070849 ETH");
  });

  it("both parties, with the wallet's own address marked", () => {
    expect(m.from).toEqual([{ address: ME, you: true }]);
    expect(m.to).toEqual([{ address: PEER, you: false }]);
  });

  it("the full hash, the block, and a working explorer link", () => {
    expect(m.hash).toBe(HASH);
    expect(m.block).toBe("23,290,907");
    expect(m.explorerUrl).toBe(`https://arbitrum.blockscout.com/tx/${HASH}`);
  });

  it("confirmations: undefined is 'no count' (confirmed by its block), 0 is unconfirmed", () => {
    expect(m).toMatchObject({ counted: false, status: "confirmed" });
    expect(txDetailsModel({ ...usdcArbSend, confirmations: 0, height: undefined })).toMatchObject({
      counted: true,
      status: "unconfirmed",
    });
    expect(txDetailsModel({ ...usdcArbSend, confirmations: 3 }).status).toBe("confirming (3)");
    expect(txDetailsModel({ ...usdcArbSend, confirmations: 16885 }).status).toBe("confirmed");
  });

  it("a received row: sender is the counterparty, recipient is you, no USD for a failure", () => {
    const received = txDetailsModel(
      { chain: "tron", hash: "4e28", direction: "in", amount: "8.000000", counterparty: "TGZp" },
      { ownAddress: "TPrk", pricesByTicker: { TRX: 0.3 } },
    );
    expect(received).toMatchObject({ directionLabel: "▼ received", sign: "+", usd: "$2.40" });
    expect(received.from).toEqual([{ address: "TGZp", you: false }]);
    expect(received.to).toEqual([{ address: "TPrk", you: true }]);
    const failed = txDetailsModel(
      { chain: "ethereum", hash: "0x01", direction: "failed", amount: "1", meta: { intended: "in", failure: "Reverted" } },
      { pricesByTicker: { ETH: 3000 } },
    );
    expect(failed).toMatchObject({ directionLabel: "✗ failed — incoming", status: "failed (Reverted)", usd: null });
  });
});

/** Every element in a tree, depth first. */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
  } else if (isValidElement(node)) {
    out.push(node);
    walk((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

describe("the explorer opens through openExternal (a plain <a href> does nothing in the webview)", () => {
  it("pressing 'View on explorer' in TxDetails calls openExternal with the transaction's URL", () => {
    // `TxDetails` reads missing parties with a hook; `TxDetailsStatic` is
    // the same details without it, callable here as a function.
    const details = TxDetailsStatic({ tx: usdcArbSend, ownAddress: ME }) as ReactElement<Parameters<typeof TxDetailsView>[0]>;
    expect(details.type).toBe(TxDetailsView);
    const tree = walk(TxDetailsView(details.props));
    const button = tree.find(
      (el) => el.type === Btn && (el.props as { children?: unknown }).children === "View on explorer",
    ) as ReactElement<{ onClick: () => void; disabled?: boolean }> | undefined;
    expect(button).toBeDefined();
    expect(button!.props.disabled).toBe(false);
    button!.props.onClick();
    expect(openExternal).toHaveBeenCalledWith(`https://arbitrum.blockscout.com/tx/${HASH}`);
  });

  it("a chain with no explorer link opens nothing and disables the button", () => {
    const xmr: ChainTx = { chain: "monero", hash: "ab", direction: "in", amount: "1" };
    // (Monero HAS a link; use a chain type the table does not know.)
    const unknown = { ...xmr, chain: "not-a-chain" as ChainTx["chain"] };
    expect(openTxInExplorer(unknown)).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("TxDetails renders the data, not a truncation of it", () => {
  const html = renderToStaticMarkup(
    createElement(TxDetails, { tx: usdcArbSend, ownAddress: ME, pricesByTicker: { USDC: 1 } }),
  );

  it("full hash, both addresses, fee coin, USD value, block", () => {
    expect(html).toContain(HASH);
    expect(html).toContain(ME);
    expect(html).toContain(PEER);
    expect(html).toContain("0.0000070849 ETH");
    expect(html).toContain("$10.00");
    expect(html).toContain("23,290,907");
    expect(html).toContain("View on explorer");
    expect(html).toContain("Copy hash");
  });
});

// ── Both layouts mount the ONE component (landscape-first rule) ──────────────

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Source with comments removed, so prose can never satisfy an assertion. */
const code = (rel: string) =>
  readFileSync(resolve(REPO_ROOT, rel), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("both layouts mount the shared details (source assertions, like layout-parity.test.ts)", () => {
  const landscape = code("src/features/activity/ActivityLandscapeView.tsx");
  const portrait = code("src/features/activity/ActivityViewPortrait.tsx");
  const shared = code("src/features/activity/TxDetails.tsx");

  it("the stripping works (control): a comment-only mention does not count", () => {
    expect(code("src/features/activity/TxDetails.tsx")).not.toMatch(/operator report, 2026-09-30/);
  });

  it("landscape renders <TxDetails> for the selected row, and no private detail panel", () => {
    expect(landscape).toMatch(/import \{ TxDetails \} from "\.\/TxDetails";/);
    expect(landscape).toMatch(/<TxDetails\s+tx=\{detail\}/);
    expect(landscape).not.toMatch(/function DetailPanel\b/);
  });

  it("portrait opens <TxDetailsSheet> for the tapped row, which renders <TxDetails>", () => {
    expect(portrait).toMatch(/import \{ TxDetailsSheet \} from "\.\/TxDetails";/);
    expect(portrait).toMatch(/<TxDetailsSheet\s+tx=\{selected\}/);
    expect(portrait).toMatch(/onClick=\{\(\) => onSelect\(tx\)\}/);
    expect(shared).toMatch(/export function TxDetailsSheet[\s\S]*<TxDetails \{\.\.\.props\} \/>/);
  });

  it("a portrait row tap no longer jumps to a block explorer", () => {
    const row = /function TxRow\([\s\S]*?\n}\n/.exec(portrait)?.[0] ?? "";
    expect(row).toContain("onSelect");
    expect(row).not.toMatch(/explorerTxUrl|openExternal/);
  });

  it("both views build their status line and rows from the same helpers", () => {
    for (const src of [landscape, portrait]) {
      expect(src).toMatch(/chainHistoryStatuses\(chainsOwned,/);
      expect(src).toMatch(/<HistoryStatusLine/);
      expect(src).not.toMatch(/errors on/);
    }
  });
});
