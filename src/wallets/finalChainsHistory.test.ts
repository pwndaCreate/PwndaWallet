/**
 * Stellar and Sui history rows (2026-09-30), found while checking the new
 * transaction details on the chains that are final on inclusion.
 *
 *  - Both reported a committed row as `confirmations: 1`. The details read a
 *    count below 6 as "confirming (1)" with a "1 / 6 PENDING" bar, for a
 *    transaction that cannot change. A final row now carries no count and its
 *    block (Stellar: the ledger in the operation id; Sui: the checkpoint).
 *  - Both turned a failed read into an empty list, so a history that could not
 *    be fetched looked like a wallet with no transactions (the SPL fix, same
 *    day). Now errors — except Horizon's 404 for an account nobody has funded,
 *    which really is an empty history.
 *  - Stellar read an account's first funding (`create_account`) as a payment:
 *    "+0 XLM" from nobody. It carries `funder` / `account` /
 *    `starting_balance`.
 *
 * Addresses and hashes are invented; the shapes are Horizon's and Sui's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => ({
  handler: null as null | ((req: { method: string; url: string; body?: string }) => { status: number; body: string }),
}));

vi.mock("../lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args: { method: string; url: string; body?: string }) => {
    if (cmd !== "http_proxy_call" || !proxy.handler) throw new Error(`unexpected invoke ${cmd}`);
    return { ...proxy.handler(args), headers: [] };
  }),
}));

import { clearStellarMergeCache, ledgerOfOperationId, stellarAdapter } from "./stellar-wallet";
import { suiAdapter } from "./sui-wallet";

beforeEach(() => {
  proxy.handler = null;
});
afterEach(() => vi.clearAllMocks());

const ME = "GAMEINVENTEDSTELLARADDRESS000000000000000000000000000000";
const THEM = "GTHEMINVENTEDSTELLARADDRESS00000000000000000000000000000";

describe("Stellar history", () => {
  it("reads the ledger out of Horizon's operation id (a TOID)", () => {
    // ledger 3 << 32 | tx 1 << 12 | op 1
    expect(ledgerOfOperationId("12884905985")).toBe(3);
    expect(ledgerOfOperationId("not-a-toid")).toBeUndefined();
  });

  it("a final row has no count and its ledger; an account creation carries its amount and funder", async () => {
    proxy.handler = ({ url }) => {
      expect(url).toContain(`/accounts/${ME}/operations`);
      return {
        status: 200,
        body: JSON.stringify({
          _embedded: {
            records: [
              {
                id: "12884905985",
                type: "payment",
                type_i: 1,
                created_at: "2026-09-29T10:00:00Z",
                source_account: ME,
                asset_type: "native",
                from: ME,
                to: THEM,
                amount: "1.5000000",
                transaction_hash: "aa".repeat(32),
              },
              {
                id: "8589938689",
                type: "create_account",
                type_i: 0,
                created_at: "2026-09-01T10:00:00Z",
                source_account: THEM,
                funder: THEM,
                account: ME,
                starting_balance: "5.0000000",
                transaction_hash: "bb".repeat(32),
              },
            ],
          },
        }),
      };
    };
    const [sent, created] = (await stellarAdapter.getTransactionHistory!(ME)).items;
    expect(sent).toMatchObject({ direction: "out", amount: "1.5000000", height: 3, counterparty: THEM });
    expect(sent.confirmations).toBeUndefined();
    // Was "+0" from an undefined sender.
    expect(created).toMatchObject({ direction: "in", amount: "5.0000000", height: 2, counterparty: THEM });
    expect(created.meta).toMatchObject({ from: THEM, to: ME });
  });

  it("an unfunded account (Horizon 404) is an empty history; any other failure is an error", async () => {
    proxy.handler = () => ({ status: 404, body: '{"title":"Resource Missing"}' });
    expect((await stellarAdapter.getTransactionHistory!(ME)).items).toEqual([]);
    proxy.handler = () => ({ status: 503, body: "upstream unavailable" });
    await expect(stellarAdapter.getTransactionHistory!(ME)).rejects.toThrow(/HTTP 503/);
  });

  describe("account merges (2026-10-01)", () => {
    // The public test seed's own merge (94390a05…, operation
    // 275583690330103809), read live: the operation names the two accounts,
    // its effects the amount. Ids and accounts invented.
    const OP_ID = "275583690330103809";
    const merge = (account: string, into: string) => ({
      id: OP_ID,
      paging_token: OP_ID,
      transaction_successful: true,
      source_account: account,
      type: "account_merge",
      type_i: 8,
      created_at: "2026-08-28T13:59:04Z",
      transaction_hash: "94".repeat(32),
      account,
      into,
    });
    const effects = (account: string, into: string, amount = "0.9998310") => ({
      _embedded: {
        records: [
          { type: "account_debited", account, amount, asset_type: "native" },
          { type: "account_credited", account: into, amount, asset_type: "native" },
          { type: "account_removed", account },
          { type: "account_sponsorship_removed", account },
        ],
      },
    });
    const route = (ops: unknown[], fx: () => { status: number; body: string }) => {
      const asked: string[] = [];
      proxy.handler = ({ url }) => {
        asked.push(url);
        if (url.includes(`/operations/${OP_ID}/effects`)) return fx();
        expect(url).toContain(`/accounts/${ME}/operations`);
        return { status: 200, body: JSON.stringify({ _embedded: { records: ops } }) };
      };
      return asked;
    };
    afterEach(() => clearStellarMergeCache());

    it("this account merged into another: a send of its whole balance, the amount from the effects", async () => {
      // Was: skipped — the move that emptied the account was not in Activity.
      route([merge(ME, THEM)], () => ({ status: 200, body: JSON.stringify(effects(ME, THEM)) }));
      const [row] = (await stellarAdapter.getTransactionHistory!(ME)).items;
      expect(row).toMatchObject({
        direction: "out",
        amount: "0.9998310",
        counterparty: THEM,
        hash: "94".repeat(32),
        height: Number(BigInt(OP_ID) >> 32n),
        meta: { from: ME, to: THEM, method: "account merge" },
      });
      expect(row.confirmations).toBeUndefined();
    });

    it("another account merged into this one: a receipt", async () => {
      route([merge(THEM, ME)], () => ({ status: 200, body: JSON.stringify(effects(THEM, ME, "12.5000000")) }));
      const [row] = (await stellarAdapter.getTransactionHistory!(ME)).items;
      expect(row).toMatchObject({ direction: "in", amount: "12.5000000", counterparty: THEM, meta: { from: THEM, to: ME } });
    });

    it("effects that cannot be read leave the amount unknown, and are asked again; a read amount is kept", async () => {
      let asked = route([merge(ME, THEM)], () => ({ status: 503, body: "upstream unavailable" }));
      const [unknown] = (await stellarAdapter.getTransactionHistory!(ME)).items;
      expect(unknown).toMatchObject({ direction: "out", amount: "", counterparty: THEM });
      asked = route([merge(ME, THEM)], () => ({ status: 200, body: JSON.stringify(effects(ME, THEM)) }));
      expect((await stellarAdapter.getTransactionHistory!(ME)).items[0].amount).toBe("0.9998310");
      expect(asked.filter((u) => u.includes("/effects"))).toHaveLength(1);
      asked = route([merge(ME, THEM)], () => ({ status: 500, body: "must not be asked" }));
      expect((await stellarAdapter.getTransactionHistory!(ME)).items[0].amount).toBe("0.9998310");
      expect(asked.filter((u) => u.includes("/effects"))).toHaveLength(0);
    });
  });
});

describe("Sui history", () => {
  // Read through GraphQL since 2026-10-01 (`sui-wallet.test.ts` has why);
  // the node layout is the live query's.
  const ADDR = "0x" + "c3".repeat(32);
  const node = (digest: string, checkpoint: number | null, amount: string) => ({
    digest,
    sender: { address: ADDR },
    effects: {
      status: "SUCCESS",
      timestamp: "2026-09-21T12:26:40.000Z",
      checkpoint: checkpoint === null ? null : { sequenceNumber: checkpoint },
      executionError: null,
      balanceChangesJson: [
        { address: ADDR, coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI", amount },
      ],
    },
  });

  it("a checkpointed transaction has no count and its checkpoint; one without is unconfirmed", async () => {
    proxy.handler = ({ url, body }) => {
      expect(url).toContain("graphql");
      expect(JSON.parse(body ?? "{}").query).toContain("relation: AFFECTED");
      return {
        status: 200,
        body: JSON.stringify({
          data: {
            address: {
              transactions: {
                pageInfo: { hasPreviousPage: false, startCursor: "c" },
                nodes: [node("DigestIncoming", null, "2500000000"), node("DigestSent", 250000000, "-1000000000")],
              },
            },
          },
        }),
      };
    };
    const items = (await suiAdapter.getTransactionHistory!(ADDR)).items;
    const sent = items.find((t) => t.hash === "DigestSent")!;
    const incoming = items.find((t) => t.hash === "DigestIncoming")!;
    expect(sent).toMatchObject({ direction: "out", amount: "1.000000000", height: 250000000 });
    expect(sent.confirmations).toBeUndefined();
    expect(incoming).toMatchObject({ direction: "in", amount: "2.500000000", confirmations: 0 });
    expect(incoming.height).toBeUndefined();
  });

  it("a failed read is an error, not an empty history", async () => {
    proxy.handler = () => ({ status: 502, body: "bad gateway" });
    await expect(suiAdapter.getTransactionHistory!(ADDR)).rejects.toThrow(/Sui history could not be read: .*502/);
  });
});
