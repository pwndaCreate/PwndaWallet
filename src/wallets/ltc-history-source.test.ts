/**
 * LTC history leads with litecoinspace (2026-09-17).
 *
 * The history hook polls every address the account scan knows, every minute.
 * Leading with BlockCypher (~100 keyless requests an hour) meant failed polls
 * and a stale "Recent" list: the 2026-09-17 P2P swap payout never appeared.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_proxy", () => ({
  proxyGetJson: vi.fn(),
  proxyPostJson: vi.fn(),
  httpProxyCall: vi.fn(),
}));

import { proxyGetJson } from "./_proxy";
import { ltcAdapter } from "./ltc-wallet";

const ADDR = "ltc1qrx8z2xatcuzjpl4gts5666juhq83qd9zq6mkyf";
const PAYOUT = {
  txid: "0683dbe03a9d3255761b780ccde31573f984744c76fdd1869f9e1de317f39e20",
  fee: 162,
  status: { confirmed: true, block_height: 3179459, block_time: 1789649503 },
  vin: [{ prevout: { scriptpubkey_address: "ltc1qlock", value: 9999979 } }],
  vout: [{ scriptpubkey_address: ADDR, value: 9999817 }],
};

const mocked = vi.mocked(proxyGetJson);

// Block body: an arrow returning the mock would make Vitest call it as a
// cleanup, with no arguments (the bch-probe-fallback.test.ts trap).
beforeEach(() => {
  mocked.mockReset();
});

describe("ltcAdapter.getTransactionHistory", () => {
  it("asks litecoinspace first and maps its rows", async () => {
    mocked.mockImplementation(async (url: string) => {
      if (url === `https://litecoinspace.org/api/address/${ADDR}/txs`) return [PAYOUT];
      throw new Error(`unexpected ${url}`);
    });
    const page = await ltcAdapter.getTransactionHistory!(ADDR, { limit: 50 });
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ hash: PAYOUT.txid, direction: "in", amount: "0.09999817" });
    expect(page.cursor).toBeUndefined();
  });

  it("falls back to BlockCypher when litecoinspace fails", async () => {
    const urls: string[] = [];
    mocked.mockImplementation(async (url: string) => {
      urls.push(url);
      if (url.includes("litecoinspace")) throw new Error("HTTP 503");
      if (url.includes("blockcypher")) return { txs: [] };
      throw new Error(`unexpected ${url}`);
    });
    const page = await ltcAdapter.getTransactionHistory!(ADDR, { limit: 50 });
    expect(urls[0]).toContain("litecoinspace");
    expect(urls[1]).toContain("blockcypher");
    expect(page.items).toEqual([]);
  });

  it("a full Esplora page continues from the oldest confirmed txid", async () => {
    const page25 = Array.from({ length: 25 }, (_, i) => ({ ...PAYOUT, txid: `tx${i}` }));
    mocked.mockImplementation(async (url: string) => {
      if (url.endsWith("/txs")) return page25;
      if (url.endsWith("/txs/chain/tx24")) return [];
      throw new Error(`unexpected ${url}`);
    });
    const first = await ltcAdapter.getTransactionHistory!(ADDR, { limit: 50 });
    expect(first.cursor).toBe("ls:tx24");
    const next = await ltcAdapter.getTransactionHistory!(ADDR, { limit: 50, cursor: first.cursor });
    expect(next.items).toEqual([]);
  });
});
