/**
 * Hedera history across the mirror node's time windows, and the wallet's own
 * account id on every row (operator request, 2026-10-01).
 *
 * The mirror answers `/transactions?account.id=…` one window at a time —
 * about 60 days, read live: successive `links.next` timestamps 5,184,000 s
 * apart — and an empty window still links to the one before it. The history
 * made ONE request, so an account idle for more than ~60 days read "no
 * transactions". Now up to `HEDERA_HISTORY_MAX_PAGES` windows are followed.
 *
 * The wallet's address is its public key while every row and party is an
 * account id (`0.0.x`), so the details could not mark the wallet's side
 * "you". Rows now carry `meta.ownAccountId` (and both sides as account ids).
 *
 * Layouts are the mirror's live answers (trimmed); account ids, timestamps
 * and transaction ids are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProxyReq = { method: string; url: string; body?: string };
const proxy = vi.hoisted(() => ({
  handler: null as null | ((req: ProxyReq) => { status: number; body: string }),
  calls: [] as ProxyReq[],
}));

vi.mock("../lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args: ProxyReq) => {
    if (cmd !== "http_proxy_call" || !proxy.handler) throw new Error(`unexpected invoke ${cmd}`);
    proxy.calls.push(args);
    return { ...proxy.handler(args), headers: [] };
  }),
}));

import { HEDERA_HISTORY_MAX_PAGES, hbarAdapter } from "./hbar-wallet";

const BASE = "https://mainnet-public.mirrornode.hedera.com";
const PUBKEY = "0x" + "2e".repeat(32);
const ME = "0.0.3229";
const THEM = "0.0.3230";
const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

beforeEach(() => {
  proxy.handler = null;
  proxy.calls = [];
});
afterEach(() => vi.clearAllMocks());

/** A transfer of `tinybars` from `from` to `to`, the fee (88,996) to 0.0.802 (the live layout). */
function transfer(seconds: number, from: string, to: string, tinybars: number) {
  return {
    charged_tx_fee: 88996,
    consensus_timestamp: `${seconds}.000000001`,
    name: "CRYPTOTRANSFER",
    node: "0.0.21",
    nonce: 0,
    result: "SUCCESS",
    scheduled: false,
    transaction_id: `${from}-${seconds - 1}-000000001`,
    transfers: [
      { account: "0.0.802", amount: 88996, is_approval: false },
      { account: from, amount: -(tinybars + 88996), is_approval: false },
      { account: to, amount: tinybars, is_approval: false },
    ],
  };
}

/** `links.next` as the mirror writes it: relative, one window further back. */
const nextLink = (lt: number, limit = 25) =>
  `/api/v1/transactions?account.id=${ME}&order=desc&limit=${limit}&timestamp=lt:${lt}.381000001`;

/** The account lookup, then `pages` in order: each a transactions answer. */
function stubMirror(pages: Array<{ status?: number; body?: unknown }>) {
  let page = 0;
  proxy.handler = ({ url }) => {
    if (url.includes("account.publickey")) return json(200, { accounts: [{ account: ME }] });
    expect(url.startsWith(`${BASE}/api/v1/transactions?`)).toBe(true);
    const p = pages[page++] ?? { body: { transactions: [], links: { next: null } } };
    return json(p.status ?? 200, p.body);
  };
  return () => proxy.calls.filter((c) => c.url.includes("/api/v1/transactions?"));
}

describe("Hedera history follows the mirror's windows", () => {
  it("an account idle for more than one window: empty windows are followed until rows appear", async () => {
    // Was: one request, so this account read "no transactions".
    const pages = stubMirror([
      { body: { transactions: [], links: { next: nextLink(1785645127) } } },
      { body: { transactions: [], links: { next: nextLink(1780461127) } } },
      { body: { transactions: [transfer(1779000000, ME, THEM, 1), transfer(1778000000, THEM, ME, 100000000)], links: { next: nextLink(1778000000) } } },
    ]);
    const { items } = await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 25 });
    expect(items.map((t) => [t.direction, t.amount])).toEqual([
      ["out", "0.00000001"],
      ["in", "1.00000000"],
    ]);
    // Each window's own link was followed, as the mirror wrote it, and on
    // past the window with rows, since 2 rows did not fill the 25 asked for
    // (the fourth answer has no `next`, which ends the read).
    expect(pages().map((c) => c.url.slice(BASE.length))).toEqual([
      `/api/v1/transactions?account.id=${ME}&order=desc&limit=25`,
      nextLink(1785645127),
      nextLink(1780461127),
      nextLink(1778000000),
    ]);
  });

  it(`stops after ${HEDERA_HISTORY_MAX_PAGES} windows, with the cursor to go further`, async () => {
    const empty = (lt: number) => ({ body: { transactions: [], links: { next: nextLink(lt) } } });
    const pages = stubMirror(Array.from({ length: 9 }, (_, i) => empty(1785645127 - i * 5184000)));
    const page = await hbarAdapter.getTransactionHistory(PUBKEY);
    expect(page.items).toEqual([]);
    expect(pages()).toHaveLength(HEDERA_HISTORY_MAX_PAGES);
    expect(page.cursor).toBe(`${1785645127 - (HEDERA_HISTORY_MAX_PAGES - 1) * 5184000}.381000001`);
  });

  it("stops once `limit` rows are read; the cursor is then the last kept row's timestamp", async () => {
    const pages = stubMirror([
      { body: { transactions: [transfer(1790000003, ME, THEM, 1), transfer(1790000002, ME, THEM, 2), transfer(1790000001, ME, THEM, 3)], links: { next: nextLink(1785000000, 4) } } },
      { body: { transactions: [transfer(1784000003, ME, THEM, 4), transfer(1784000002, ME, THEM, 5)], links: { next: nextLink(1779000000, 4) } } },
    ]);
    const page = await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 4 });
    expect(page.items.map((t) => t.amount)).toEqual(["0.00000001", "0.00000002", "0.00000003", "0.00000004"]);
    expect(pages()).toHaveLength(2);
    expect(page.cursor).toBe("1784000003.000000001");
  });

  it("follows only the mirror's own relative links", async () => {
    const pages = stubMirror([
      { body: { transactions: [], links: { next: "https://elsewhere.example/api/v1/transactions?account.id=0.0.3229" } } },
    ]);
    expect((await hbarAdapter.getTransactionHistory(PUBKEY)).items).toEqual([]);
    expect(pages()).toHaveLength(1);
  });

  it("a later window failing keeps what was read; failing before anything was read throws", async () => {
    stubMirror([
      { body: { transactions: [transfer(1790000000, ME, THEM, 7)], links: { next: nextLink(1785000000) } } },
      { status: 502, body: "bad gateway" },
    ]);
    const kept = await hbarAdapter.getTransactionHistory(PUBKEY);
    expect(kept.items.map((t) => t.amount)).toEqual(["0.00000007"]);
    expect(kept.cursor).toBe("1785000000.381000001");

    stubMirror([
      { body: { transactions: [], links: { next: nextLink(1785645127) } } },
      { status: 429, body: '{"_status":{"messages":[{"message":"Too many requests"}]}}' },
    ]);
    await expect(hbarAdapter.getTransactionHistory(PUBKEY)).rejects.toThrow(/HTTP 429/);
  });
});

describe("Hedera rows name the wallet's own account id", () => {
  it("meta.ownAccountId, and both sides as account ids without the fee collector", async () => {
    stubMirror([
      { body: { transactions: [transfer(1790000000, ME, THEM, 1), transfer(1789000000, THEM, ME, 100000000)], links: { next: null } } },
    ]);
    const [sent, received] = (await hbarAdapter.getTransactionHistory(PUBKEY)).items;
    expect(sent.meta).toMatchObject({ ownAccountId: ME, from: [ME], to: [THEM] });
    expect(received.meta).toMatchObject({ ownAccountId: ME, from: [THEM], to: [ME] });
    expect(JSON.stringify(sent.meta)).not.toContain("0.0.802");
  });
});
