/**
 * XRP `getTransactionParties` (2026-09-30): who sent a transaction and who
 * received it, read with rippled's `tx` through the same three servers as
 * every other XRP read.
 *
 * The fake is the xrpl.js `Client` alone. Result shapes are rippled's, as
 * xrplcluster.com answered `tx` with `api_version: 2` on 2026-09-30 (a
 * payment to the public test seed): the transaction under `tx_json`,
 * `DeliverMax` instead of `Amount`, the balances in `meta.AffectedNodes`.
 * Addresses and hashes are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeServer {
  down?: boolean;
  /** `tx` answer by hash; absent = rippled's `txnNotFound`. */
  txs: Record<string, unknown>;
  lookups: number;
}

let servers: Record<string, FakeServer>;

vi.mock("xrpl", async (importOriginal) => {
  const actual: any = await importOriginal();
  class FakeClient {
    private s: FakeServer;
    constructor(url: string) {
      this.s = servers[url] ?? { txs: {}, lookups: 0 };
    }
    async connect() {
      if (this.s.down) throw new Error("connect failed");
    }
    async disconnect() {}
    async request(req: any) {
      if (req.command !== "tx") throw new Error(`unscripted ${req.command}`);
      this.s.lookups++;
      const found = this.s.txs[req.transaction];
      if (!found) {
        // xrpl.js raises a RippledError whose `data` is rippled's error answer.
        throw Object.assign(new Error("Transaction not found."), {
          data: { error: "txnNotFound", error_code: 29, error_message: "Transaction not found.", status: "error" },
        });
      }
      return { result: found };
    }
  }
  return { ...actual, Client: FakeClient };
});

const { xrpAdapter, xrpTxParties } = await import("./xrp-wallet");

const [S1, S2, S3] = ["wss://xrplcluster.com", "wss://s1.ripple.com", "wss://s2.ripple.com"];
const ME = "rMeInventedXrpAddressAAAAAAAAAAAAAA";
const THEM = "rThemInventedXrpAddressBBBBBBBBBBBB";
const HASH = "AB".repeat(32);

/** A validated Payment in the API v2 layout captured live. */
function payment(from: string, to: string) {
  return {
    close_time_iso: "2026-09-09T15:42:20Z",
    hash: HASH,
    ledger_index: 106870623,
    meta: {
      AffectedNodes: [
        {
          ModifiedNode: {
            FinalFields: { Account: to, Balance: "2268996827", Flags: 0, OwnerCount: 2, Sequence: 210 },
            LedgerEntryType: "AccountRoot",
            PreviousFields: { Balance: "2268996817" },
          },
        },
        {
          ModifiedNode: {
            FinalFields: { Account: from, Balance: "14973562", Flags: 0, OwnerCount: 0, Sequence: 98243420 },
            LedgerEntryType: "AccountRoot",
            PreviousFields: { Balance: "14973583", Sequence: 98243419 },
          },
        },
      ],
      TransactionIndex: 67,
      TransactionResult: "tesSUCCESS",
      delivered_amount: "10",
    },
    tx_json: {
      Account: from,
      DeliverMax: "10",
      Destination: to,
      DestinationTag: 12345,
      Fee: "11",
      Flags: 0,
      Sequence: 98243419,
      TransactionType: "Payment",
      date: 842283740,
      ledger_index: 106870623,
    },
    validated: true,
    status: "success",
  };
}

beforeEach(() => {
  servers = {
    [S1]: { txs: {}, lookups: 0 },
    [S2]: { txs: {}, lookups: 0 },
    [S3]: { txs: {}, lookups: 0 },
  };
});

describe("XRP transaction parties", () => {
  it("a payment received: its Account → its Destination, the tag kept out of the address", async () => {
    servers[S1].txs[HASH] = payment(THEM, ME);
    const p = await xrpAdapter.getTransactionParties!(HASH, ME);
    expect(p).toEqual({ from: [THEM], to: [ME], source: "xrplcluster.com" });
  });

  it("a payment sent reads the same way round", async () => {
    servers[S1].txs[HASH] = payment(ME, THEM);
    expect(await xrpAdapter.getTransactionParties!(HASH, ME)).toMatchObject({ from: [ME], to: [THEM] });
  });

  it("reads rippled API v1 too, where the fields sit on the result itself", () => {
    const { tx_json, ...rest } = payment(THEM, ME);
    expect(xrpTxParties({ ...rest, ...tx_json })).toEqual({ from: [THEM], to: [ME] });
  });

  it("another transaction type: the accounts whose XRP fell and rose", () => {
    const MAKER = "rMakerInventedXrpAddressCCCCCCCCCCC";
    const offer = {
      tx_json: { Account: ME, TransactionType: "OfferCreate", Fee: "12" },
      meta: {
        AffectedNodes: [
          {
            ModifiedNode: {
              LedgerEntryType: "AccountRoot",
              FinalFields: { Account: MAKER, Balance: "5000000" },
              PreviousFields: { Balance: "4000000" },
            },
          },
          {
            ModifiedNode: {
              LedgerEntryType: "AccountRoot",
              FinalFields: { Account: ME, Balance: "8999988" },
              PreviousFields: { Balance: "9999988" },
            },
          },
          // A trust line is not an XRP balance.
          { ModifiedNode: { LedgerEntryType: "RippleState", FinalFields: { Balance: { value: "5" } } } },
        ],
      },
    };
    expect(xrpTxParties(offer)).toEqual({ from: [ME], to: [MAKER] });
  });

  it("asks the next server when one does not have it: s1 keeps no full history", async () => {
    servers[S2].txs[HASH] = payment(THEM, ME);
    const p = await xrpAdapter.getTransactionParties!(HASH, ME);
    expect(p).toMatchObject({ from: [THEM], to: [ME], source: "s1.ripple.com" });
    expect(servers[S1].lookups).toBe(1);
  });

  it("not found anywhere: null", async () => {
    await expect(xrpAdapter.getTransactionParties!(HASH, ME)).resolves.toBeNull();
    expect(servers[S3].lookups).toBe(1);
  });

  it("not found on one server, the others unreachable: still null", async () => {
    servers[S2].down = true;
    servers[S3].down = true;
    await expect(xrpAdapter.getTransactionParties!(HASH, ME)).resolves.toBeNull();
  });

  it("no server reachable: throws, naming the servers", async () => {
    for (const s of Object.values(servers)) s.down = true;
    await expect(xrpAdapter.getTransactionParties!(HASH, ME)).rejects.toThrow(
      /No XRP Ledger server could read transaction .*\(xrplcluster\.com, s1\.ripple\.com, s2\.ripple\.com\): connect failed/,
    );
  });
});
