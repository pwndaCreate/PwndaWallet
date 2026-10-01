/**
 * Hedera history remembers what the mirror already said (operator request,
 * 2026-10-01).
 *
 * An account idle for more than one window cost up to five mirror requests
 * per history read (`HEDERA_HISTORY_MAX_PAGES`), 10.9 s live for the public
 * test seed, plus the account lookup, and every poll paid it again. Now a
 * read is remembered for the session: the next one asks only what is newer
 * than the mirror's clock at the last read, less a margin, and the account id
 * is looked up once.
 *
 * The mirror here is a fake that windows `/transactions?account.id=` the way
 * the live one does (read 2026-10-01 on the test seed's account 0.0.1458271):
 * a range longer than 5,184,000 s is cut to its newest 60 days, with a
 * `links.next` of `timestamp=lt:<window start>` that keeps a `gt:` bound; a
 * range inside one window answers `next: null`; a full page links on from
 * its last row. Answers carry `Date`, as the live ones do. Account ids,
 * timestamps and transaction ids are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProxyReq = { method: string; url: string; body?: string };
const proxy = vi.hoisted(() => ({
  handler: null as null | ((req: ProxyReq) => { status: number; body: string; headers?: Array<[string, string]> }),
  calls: [] as ProxyReq[],
}));

vi.mock("../lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args: ProxyReq) => {
    if (cmd !== "http_proxy_call" || !proxy.handler) throw new Error(`unexpected invoke ${cmd}`);
    proxy.calls.push(args);
    const r = proxy.handler(args);
    return { headers: [], ...r };
  }),
}));

import * as hbarWallet from "./hbar-wallet";
import { HEDERA_HISTORY_MAX_PAGES, hbarAdapter } from "./hbar-wallet";

const PUBKEY = "0x" + "2e".repeat(32);
const ME = "0.0.3229";
const THEM = "0.0.3230";
const S = 1_000_000_000n;
const WINDOW = 5_184_000n * S;
const DAY = 86_400n * S;

const tsStr = (ns: bigint) => `${ns / S}.${(ns % S).toString().padStart(9, "0")}`;
const parseTs = (s: string) => {
  const [a, b = ""] = s.split(".");
  return BigInt(a) * S + BigInt(b.padEnd(9, "0"));
};

/** The fake mirror's state: its clock, the account's transactions, whether answers carry `Date`. */
const mirror = {
  now: 1_790_869_247n * S,
  txs: [] as Array<{ ts: bigint; tx: Record<string, unknown> }>,
  date: true,
  lookup: "found" as "found" | "none" | "fail",
};

/** A transfer of `tinybars` at `ts`, the fee (88,996) to 0.0.802 (the live layout). */
function transfer(ts: bigint, from: string, to: string, tinybars: number, id: string) {
  return {
    ts,
    tx: {
      charged_tx_fee: 88996,
      consensus_timestamp: tsStr(ts),
      name: "CRYPTOTRANSFER",
      node: "0.0.21",
      nonce: 0,
      result: "SUCCESS",
      scheduled: false,
      transaction_id: `${from}-${ts / S - 1n}-${id}`,
      transfers: [
        { account: "0.0.802", amount: 88996, is_approval: false },
        { account: from, amount: -(tinybars + 88996), is_approval: false },
        { account: to, amount: tinybars, is_approval: false },
      ],
    },
  };
}

function transactionsAnswer(url: string) {
  const u = new URL(url);
  const limit = Number(u.searchParams.get("limit"));
  const bounds = u.searchParams.getAll("timestamp");
  let lo = 0n;
  let hi = mirror.now;
  for (const b of bounds) {
    const [op, v] = b.split(":");
    const n = parseTs(v);
    if (op === "lt") hi = n - 1n;
    else if (op === "lte") hi = n;
    else if (op === "gt") lo = n + 1n;
    else if (op === "gte") lo = n;
  }
  let windowed = false;
  if (hi - lo + 1n > WINDOW) {
    lo = hi - WINDOW + 1n;
    windowed = true;
  }
  const rows = mirror.txs
    .filter((r) => r.ts >= lo && r.ts <= hi)
    .sort((a, b) => (b.ts > a.ts ? 1 : -1))
    .slice(0, limit);
  const kept = bounds.filter((b) => b.startsWith("gt") ).map((b) => `&timestamp=${b}`).join("");
  const link = (lt: bigint) =>
    `/api/v1/transactions?account.id=${ME}&order=desc&limit=${limit}${kept}&timestamp=lt:${tsStr(lt)}`;
  const next = rows.length === limit ? link(rows[rows.length - 1].ts) : windowed ? link(lo) : null;
  return { transactions: rows.map((r) => r.tx), links: { next } };
}

beforeEach(() => {
  (hbarWallet as { clearHederaHistoryCache?: () => void }).clearHederaHistoryCache?.();
  proxy.calls = [];
  mirror.now = 1_790_869_247n * S;
  mirror.txs = [];
  mirror.date = true;
  mirror.lookup = "found";
  proxy.handler = ({ url }) => {
    const headers: Array<[string, string]> = mirror.date
      ? [["date", new Date(Number(mirror.now / 1_000_000n)).toUTCString()]]
      : [];
    if (url.includes("/accounts?account.publickey=")) {
      if (mirror.lookup === "fail") return { status: 503, body: "upstream connect error", headers };
      return { status: 200, body: JSON.stringify({ accounts: mirror.lookup === "found" ? [{ account: ME }] : [], links: { next: null } }), headers };
    }
    return { status: 200, body: JSON.stringify(transactionsAnswer(url)), headers };
  };
});
afterEach(() => vi.clearAllMocks());

/** The requests made since `from`, as paths. */
const requests = (from = 0) => proxy.calls.slice(from).map((c) => c.url.replace("https://mainnet-public.mirrornode.hedera.com", ""));
const lookups = (from = 0) => requests(from).filter((p) => p.includes("account.publickey"));
const windows = (from = 0) => requests(from).filter((p) => p.startsWith("/api/v1/transactions?"));

describe("Hedera history: later reads ask only what is newer", () => {
  it("an idle account: the first read walks five windows, a later read asks once", async () => {
    expect((await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 50 })).items).toEqual([]);
    expect(lookups()).toHaveLength(1);
    expect(windows()).toHaveLength(HEDERA_HISTORY_MAX_PAGES);

    mirror.now += 60n * S; // the next poll, a minute later
    const mark = proxy.calls.length;
    const page = await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 10 });
    expect(page.items).toEqual([]);
    // Was: the lookup and five windows again, every poll.
    expect(lookups(mark)).toHaveLength(0);
    expect(windows(mark)).toEqual([
      `/api/v1/transactions?account.id=${ME}&order=desc&limit=10&timestamp=gt:${tsStr(1_790_869_247n * S - 3600n * S)}`,
    ]);
    // The cursor still points below the windows the first read covered.
    expect(page.cursor).toBe(tsStr(1_790_869_247n * S - 5n * WINDOW + 1n));
  });

  it("rows the first read found are kept, and a new transaction is listed on top", async () => {
    const t0 = mirror.now;
    mirror.txs = [transfer(t0 - 100n * DAY, THEM, ME, 100_000_000, "000000001")];
    const first = await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 50 });
    expect(first.items.map((r) => [r.direction, r.amount])).toEqual([["in", "1.00000000"]]);
    expect(windows()).toHaveLength(HEDERA_HISTORY_MAX_PAGES);

    mirror.txs.push(transfer(t0 + 30n * S, ME, THEM, 25_000_000, "000000002"));
    mirror.now = t0 + 60n * S;
    const mark = proxy.calls.length;
    const later = await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 10 });
    expect(later.items.map((r) => [r.direction, r.amount, r.meta?.ownAccountId])).toEqual([
      ["out", "0.25000000", ME],
      ["in", "1.00000000", ME],
    ]);
    expect(windows(mark)).toHaveLength(1);
  });

  it("a transaction that reached the mirror after a read, timed before it, is still found (the margin)", async () => {
    const t0 = mirror.now;
    await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 50 });
    // Consensus 10 s before the first read's answer, ingested after it.
    mirror.txs.push(transfer(t0 - 10n * S, THEM, ME, 5_000_000, "000000003"));
    mirror.now = t0 + 60n * S;
    const later = await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 10 });
    expect(later.items.map((r) => [r.direction, r.amount])).toEqual([["in", "0.05000000"]]);
  });

  it("more new rows than a page holds start over from them; nothing older is assumed", async () => {
    const t0 = mirror.now;
    mirror.txs = [transfer(t0 - 200n * DAY, THEM, ME, 1, "000000010")];
    await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 50 });
    for (let i = 1; i <= 12; i++) mirror.txs.push(transfer(t0 + BigInt(i) * S, ME, THEM, i, `0000001${String(i).padStart(2, "0")}`));
    mirror.now = t0 + 60n * S;
    const mark = proxy.calls.length;
    const page = await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.items[0].amount).toBe("0.00000012");
    expect(windows(mark)).toHaveLength(1);
    expect(page.cursor).toBe(tsStr(t0 + 3n * S));
    // A larger read next reads on below those ten, and finds the rest.
    const mark2 = proxy.calls.length;
    const full = await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 50 });
    expect(full.items.map((r) => r.amount)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `0.000000${String(12 - i).padStart(2, "0")}`),
      "0.00000001",
    ]);
    expect(windows(mark2).length).toBeLessThanOrEqual(HEDERA_HISTORY_MAX_PAGES);
  });

  it("an answer without `Date` (the browser sandbox's mock) remembers nothing: each read walks, as before", async () => {
    mirror.date = false;
    await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 50 });
    const mark = proxy.calls.length;
    await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 10 });
    expect(windows(mark)).toHaveLength(HEDERA_HISTORY_MAX_PAGES);
  });

  it("paging older with a cursor walks from the cursor and leaves what was remembered", async () => {
    await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 50 });
    const mark = proxy.calls.length;
    await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 10, cursor: "1700000000.000000001" });
    expect(windows(mark)[0]).toBe(
      `/api/v1/transactions?account.id=${ME}&order=desc&limit=10&timestamp=lt:1700000000.000000001`,
    );
    const mark2 = proxy.calls.length;
    await hbarAdapter.getTransactionHistory(PUBKEY, { limit: 10 });
    expect(windows(mark2)).toHaveLength(1);
  });
});

describe("Hedera history: the account lookup", () => {
  it("is asked once per session once found; a key with no account is asked again", async () => {
    mirror.lookup = "none";
    expect((await hbarAdapter.getTransactionHistory(PUBKEY)).items).toEqual([]);
    expect(windows()).toHaveLength(0);
    mirror.lookup = "found";
    await hbarAdapter.getTransactionHistory(PUBKEY);
    await hbarAdapter.getTransactionHistory(PUBKEY);
    expect(lookups()).toHaveLength(2);
  });

  it("a lookup that fails throws: it is not an account without history", async () => {
    // Was `{ items: [] }`: the catch read a failed lookup as "no account
    // on the network yet", an empty history built from a failure.
    mirror.lookup = "fail";
    await expect(hbarAdapter.getTransactionHistory(PUBKEY)).rejects.toThrow(
      /mainnet-public\.mirrornode\.hedera\.com could not look up this key's account: HTTP 503/,
    );
  });
});
