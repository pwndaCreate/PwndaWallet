/**
 * What one Activity poll of an idle Hedera account costs (operator request,
 * 2026-10-01: "an idle account costs up to five mirror requests per read …
 * about ten requests per poll", 10.9 s live for the public test seed).
 *
 * Two faults made the ten. The adapter read up to five ~60-day windows on
 * every read, and the history hook (`readPairHistory`, the fetch step of
 * `useTxHistory`) followed an empty small page over an empty list with a full
 * page, so each poll read the history twice. Now the adapter remembers what
 * the mirror said (`hederaHistoryMemo.test.ts`) and an empty poll of an empty
 * list is not read again (`txHistorySchedule.test.ts`).
 *
 * The mirror is a fake that windows the way the live one does (an empty
 * window links to the one before it, `timestamp=lt:<start>`) and answers with
 * `Date`. The account has no transfers, like the test seed's 0.0.1458271.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => ({ urls: [] as string[], now: 1_790_869_247_000 }));

vi.mock("../../lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args: { url: string }) => {
    if (cmd !== "http_proxy_call") throw new Error(`unexpected invoke ${cmd}`);
    proxy.urls.push(args.url);
    const headers: Array<[string, string]> = [["date", new Date(proxy.now).toUTCString()]];
    if (args.url.includes("account.publickey")) {
      return { status: 200, body: JSON.stringify({ accounts: [{ account: "0.0.3229" }], links: { next: null } }), headers };
    }
    // An empty account: each answer is one window, linked to the one before.
    const u = new URL(args.url);
    const bounds = u.searchParams.getAll("timestamp");
    const lt = bounds.find((b) => b.startsWith("lt:"));
    const gt = bounds.find((b) => b.startsWith("gt:"));
    const end = lt ? Number(lt.slice(3).split(".")[0]) : Math.floor(proxy.now / 1000);
    const start = end - 5_184_000;
    const windowed = !gt || Number(gt.slice(3).split(".")[0]) < start;
    const next = windowed
      ? `${u.pathname}?account.id=0.0.3229&order=desc&limit=${u.searchParams.get("limit")}${gt ? `&timestamp=${gt}` : ""}&timestamp=lt:${start}.000000001`
      : null;
    return { status: 200, body: JSON.stringify({ transactions: [], links: { next } }), headers };
  }),
}));

import * as hbarWallet from "../../wallets/hbar-wallet";
import { hbarAdapter } from "../../wallets/hbar-wallet";
import { readPairHistory } from "./txHistorySchedule";

const PUBKEY = "0x" + "2e".repeat(32);
/** The hook's page sizes (`useTxHistory`: DEFAULT_LIMIT, DEFAULT_POLL_LIMIT). */
const FULL = { limit: 50, pollLimit: 10 };
const read = async (n: number) => (await hbarAdapter.getTransactionHistory(PUBKEY, { limit: n })).items;

beforeEach(() => {
  (hbarWallet as { clearHederaHistoryCache?: () => void }).clearHederaHistoryCache?.();
  proxy.urls = [];
  proxy.now = 1_790_869_247_000;
});

describe("an idle Hedera account in Activity", () => {
  it("the first fetch reads the windows once; each poll after it is one mirror request (was about ten)", async () => {
    const held = await readPairHistory(read, undefined, { full: true, ...FULL });
    expect(held).toEqual([]);
    // The account lookup and five windows.
    expect(proxy.urls).toHaveLength(6);

    for (let poll = 1; poll <= 3; poll++) {
      proxy.now += 60_000;
      const before = proxy.urls.length;
      expect(await readPairHistory(read, held, { full: false, ...FULL })).toEqual([]);
      // Was 12: a small page and a full page, each the lookup and five windows.
      expect(proxy.urls.length - before).toBe(1);
    }
  });
});
