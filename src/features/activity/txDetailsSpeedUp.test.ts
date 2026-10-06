/**
 * The transaction details offer "Speed up" for an unconfirmed BTC send
 * (operator request, 2026-10-01) — in every place they open: Activity in
 * both layouts and the wallet's Recent rows, which all render `TxDetails`
 * (`txDetails.test.ts` pins those mounts). The panel is the shared
 * `components/SpeedUpPanel.tsx`; the swap details mount the same one.
 *
 * Rendered with react-dom/server, so the panel shows its first frame
 * ("checking"): the chain is read in an effect, which a server render never
 * runs. Fails on 6b4e160: no panel exists.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock("../../state/AppStateContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../state/AppStateContext")>();
  return {
    ...real,
    useAppStateOptional: () => (h.wallet ? { walletsByChain: { bitcoin: h.wallet } } : null),
  };
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TxDetails } from "./TxDetails";
import type { ChainTx, WalletInfo } from "../../wallets/types";

const ME = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const WALLET: WalletInfo = {
  chain: "bitcoin",
  address: ME,
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  privateKey: "",
};

/** The account history's row for a pending send (`netAccountTx`). */
const pendingSend: ChainTx = {
  chain: "bitcoin",
  hash: "317a82a5ddce9b6c997ae6fd6491d0e6e010f2db84ebcf5b0b32d9918615d703",
  direction: "pending",
  amount: "0.01000000",
  fee: "0.00000282",
  confirmations: 0,
  counterparty: "bc1qe5xk329xk5tfz3ldvfqxqxahajdva5jl4jzcmy",
  meta: {
    netSat: -1_000_282,
    netDirection: "out",
    inputs: [ME],
    outputs: ["bc1qe5xk329xk5tfz3ldvfqxqxahajdva5jl4jzcmy", "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el"],
  },
};

const render = (tx: ChainTx, wallet: WalletInfo | null = WALLET) => {
  h.wallet = wallet;
  return renderToStaticMarkup(createElement(TxDetails, { tx, ownAddress: ME, pricesByTicker: { BTC: 95_400 } }));
};

describe("TxDetails: the Speed up panel", () => {
  it("an unconfirmed BTC send gets it, above the Copy hash / View on explorer buttons", () => {
    const html = render(pendingSend);
    expect(html).toContain('data-speed-up="checking"');
    expect(html.indexOf("data-speed-up")).toBeLessThan(html.indexOf("Copy hash"));
  });

  it("not a mined row, not a receipt, not another chain, not without a key that can sign", () => {
    expect(render({ ...pendingSend, direction: "out", confirmations: undefined, height: 900_000 })).not.toContain("data-speed-up");
    expect(render({ ...pendingSend, meta: { ...pendingSend.meta, netDirection: "in", netSat: 5 } })).not.toContain("data-speed-up");
    expect(render({ ...pendingSend, chain: "litecoin" })).not.toContain("data-speed-up");
    expect(render(pendingSend, null)).not.toContain("data-speed-up");
    expect(render(pendingSend, { ...WALLET, watchOnly: true })).not.toContain("data-speed-up");
  });
});

describe("one panel for every surface (landscape-first rule)", () => {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const code = (p: string) => readFileSync(resolve(root, p), "utf8");

  it("the transaction details and the swap details mount the SAME shared component", () => {
    for (const f of ["src/features/activity/TxDetails.tsx", "src/features/swap/SwapDetailsModal.tsx"]) {
      expect(code(f), f).toMatch(/import \{ SpeedUpPanel \} from "\.\.\/\.\.\/components\/SpeedUpPanel";/);
      expect(code(f), f).toMatch(/<SpeedUpPanel\b/);
    }
  });
});
