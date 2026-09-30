/**
 * BCH history's Blockchair fallback read every row as a 0 BCH "self"
 * transfer — found 2026-09-30 while adding `getTransactionParties`.
 *
 * Blockchair prints BCH addresses as BARE CashAddr (`qrepx94s…` in a live
 * `dashboards/transaction` read of 2026-09-30); this wallet's addresses are
 * `bitcoincash:`-prefixed (`encodeCashAddr`), and the fallback compared them
 * with `===`, so no input or output was ever the wallet's. The haskoin branch
 * above it already compared without the prefix (`mine`).
 *
 * Whether Blockchair keys its address dashboard by the prefixed or the bare
 * form is not verified (the probe got HTTP 430), so both keyings are pinned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_proxy", () => ({
  proxyGetJson: vi.fn(),
  proxyPostJson: vi.fn(),
  httpProxyCall: vi.fn(),
}));

import { proxyGetJson } from "./_proxy";
import { bchAdapter, encodeCashAddr } from "./bch-wallet";

const ME = "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6"; // the test seed's
const ME_BARE = ME.replace(/^bitcoincash:/, "");
const OTHER_BARE = encodeCashAddr(new Uint8Array(20).fill(7), "p2pkh").replace(/^bitcoincash:/, "");
const RECEIVE = "d1".repeat(32);
const SEND = "d2".repeat(32);

function stub(dashboardKey: string) {
  vi.mocked(proxyGetJson).mockImplementation(async (url: string) => {
    if (url.includes("haskoin")) throw new Error(`HTTP 503 from ${url}: `);
    if (url.includes("/dashboards/address/")) {
      return { data: { [dashboardKey]: { address: { balance: 46858 }, transactions: [SEND, RECEIVE] } }, context: { code: 200 } };
    }
    if (url.includes("/dashboards/transactions/")) {
      return {
        data: {
          [RECEIVE]: {
            transaction: { hash: RECEIVE, time: "2026-09-21 10:00:00", block_id: 963641, fee: 219 },
            inputs: [{ recipient: OTHER_BARE, value: 1_000_000 }],
            outputs: [
              { recipient: ME_BARE, value: 46_858 },
              { recipient: OTHER_BARE, value: 952_923 },
            ],
          },
          [SEND]: {
            transaction: { hash: SEND, time: "2026-09-21 11:00:00", block_id: 963772, fee: 6_821 },
            inputs: [{ recipient: ME_BARE, value: 46_858 }],
            outputs: [{ recipient: OTHER_BARE, value: 40_037 }],
          },
        },
      };
    }
    throw new Error(`TEST TRIPWIRE: ${url}`);
  });
}

beforeEach(() => {
  vi.mocked(proxyGetJson).mockReset();
});

describe("BCH history, Blockchair fallback (haskoin down)", () => {
  for (const [label, key] of [
    ["dashboard keyed by the address as asked (prefixed)", ME],
    ["dashboard keyed by the bare CashAddr", ME_BARE],
  ] as const) {
    it(`${label}: a receive is 'in' and a send is 'out', with their amounts — not 0 BCH 'self'`, async () => {
      stub(key);
      const { items } = await bchAdapter.getTransactionHistory(ME);
      expect(items.map((t) => [t.hash, t.direction, t.amount])).toEqual([
        [SEND, "out", "0.00046858"],
        [RECEIVE, "in", "0.00046858"],
      ]);
      expect(items[0]).toMatchObject({ fee: "0.00006821", counterparty: OTHER_BARE, meta: { netSat: -46_858 } });
    });
  }
});
