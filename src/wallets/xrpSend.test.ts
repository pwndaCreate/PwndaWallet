/**
 * XRP sends and history against a scripted XRP Ledger (2026-09-29).
 *
 * The fake is the `Client` alone: addresses, amounts, X-addresses and the
 * signature are the real xrpl.js code, signing with the abandon seed's key.
 * Every test pins a way the adapter used to report something untrue:
 *
 *  - a payment that FAILED on the ledger (`tec…`) came back as sent, because
 *    `submitAndWait` throws only for malformed (`tem…`) transactions;
 *  - `withClient` re-ran the WHOLE send — a fresh autofill, a fresh signature
 *    — on the next server when waiting failed, so a payment that had already
 *    gone through could be paid again;
 *  - no reserve, no unfunded-recipient check, no destination tags;
 *  - Activity read `tx.Amount`, which rippled API v2 (xrpl.js 4.x's default)
 *    renames `DeliverMax`, so every amount read 0.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** One scripted rippled. `requests` records what the wallet asked it. */
interface FakeServer {
  accounts: Record<string, { Balance: string; OwnerCount?: number; Flags?: number }>;
  reserve?: { base: number; inc: number };
  /** Answer to `submit` (the preliminary engine result). */
  prelim?: string;
  /** The ledger's final result for the submitted hash; `null` = never found. */
  final?: string | null;
  /** Throw a connection error on the Nth `tx` lookup (1-based). */
  dropOnLookup?: number;
  ledgerIndex?: number;
  accountTx?: unknown[];
  requests: Array<{ command: string; tx_blob?: string }>;
}

let servers: Record<string, FakeServer>;
let nextSequence = 6;

function server(partial: Partial<FakeServer>): FakeServer {
  return { accounts: {}, requests: [], ...partial };
}

vi.mock("xrpl", async (importOriginal) => {
  const actual: any = await importOriginal();
  class FakeClient {
    private s: FakeServer;
    private lookups = 0;
    constructor(url: string) {
      this.s = servers[url] ?? server({});
    }
    async connect() {
      if ((this.s as any).down) throw new Error("connect failed");
    }
    async disconnect() {}
    async getLedgerIndex() {
      return this.s.ledgerIndex ?? 90;
    }
    // xrpl.js's own implementation, running against this fake: the adapter
    // before 2026-09-29 sent through it, and that is how these tests were
    // shown to fail there for the reasons they name.
    submitAndWait = actual.Client.prototype.submitAndWait;
    async autofill(tx: any) {
      // Each prepare takes the next Sequence, as the ledger's would once the
      // previous payment had been applied: a re-prepared payment is a NEW one.
      nextSequence++;
      return { ...tx, Fee: "12", Sequence: nextSequence, LastLedgerSequence: 100, SigningPubKey: "" };
    }
    async request(req: any) {
      this.s.requests.push({ command: req.command, tx_blob: req.tx_blob });
      switch (req.command) {
        case "server_info": {
          const r = this.s.reserve ?? { base: 1, inc: 0.2 };
          return {
            result: {
              info: {
                load_factor: 1,
                validated_ledger: { base_fee_xrp: 0.00001, reserve_base_xrp: r.base, reserve_inc_xrp: r.inc },
              },
            },
          };
        }
        case "account_info": {
          const a = this.s.accounts[req.account];
          if (!a) throw Object.assign(new Error("Account not found."), { data: { error: "actNotFound" } });
          return { result: { account_data: { OwnerCount: 0, Flags: 0, ...a } } };
        }
        case "submit":
          return { result: { engine_result: this.s.prelim ?? "tesSUCCESS", engine_result_message: "" } };
        case "tx": {
          this.lookups++;
          if (this.s.dropOnLookup === this.lookups) throw new Error("websocket closed");
          if (this.s.final === null || this.s.final === undefined) {
            throw Object.assign(new Error("txnNotFound"), { data: { error: "txnNotFound" } });
          }
          return { result: { validated: true, meta: { TransactionResult: this.s.final } } };
        }
        case "account_tx":
          return {
            result: { transactions: this.s.accountTx ?? [], ledger_index_max: (this.s as any).ledgerMax },
          };
        default:
          throw new Error(`unscripted ${req.command}`);
      }
    }
  }
  return { ...actual, Client: FakeClient };
});

const { xrpAdapter, XRP_CONFIRM_POLL_MS, parseXrpRecipient } = await import("./xrp-wallet");
const xrpl: any = await import("xrpl");

const me = xrpAdapter.deriveFromMnemonic(ABANDON);
// A second, real account to pay: the same seed one index along.
const other = (await import("./xrp-wallet")).deriveXrpAtPath(ABANDON, "m/44'/144'/0'/0/1").address;

const [S1, S2, S3] = ["wss://xrplcluster.com", "wss://s1.ripple.com", "wss://s2.ripple.com"];

beforeEach(() => {
  nextSequence = 6;
  // Guarded so this file can also be pointed at the pre-2026-09-29 adapter,
  // which is how its assertions were shown to fail there.
  if (XRP_CONFIRM_POLL_MS) XRP_CONFIRM_POLL_MS.value = 1;
  const accounts = {
    [me.address]: { Balance: "25000000" }, // 25 XRP
    [other]: { Balance: "5000000" },
  };
  servers = {
    [S1]: server({ accounts, final: "tesSUCCESS" }),
    [S2]: server({ accounts, final: "tesSUCCESS" }),
    [S3]: server({ accounts, final: "tesSUCCESS" }),
  };
});

const submits = () =>
  Object.values(servers).flatMap((s) => s.requests.filter((r) => r.command === "submit"));

describe("the ledger's verdict", () => {
  it("returns the hash only for tesSUCCESS", async () => {
    const r = await xrpAdapter.sendTransaction(me.privateKey, other, "2");
    expect(r.hash).toMatch(/^[0-9A-F]{64}$/);
  });

  it("reports a tec result as a failure, not as sent", async () => {
    servers[S1].final = "tecUNFUNDED_PAYMENT";
    await expect(xrpAdapter.sendTransaction(me.privateKey, other, "2")).rejects.toThrow(
      /refused the payment: tecUNFUNDED_PAYMENT — .* Only the network fee was spent/,
    );
  });

  it("does not pay twice when the connection drops while waiting", async () => {
    // Server 1 accepts the submission, then the socket dies mid-wait. The
    // retry on server 2 must resubmit the SAME signed bytes: never a second
    // autofill (a new Sequence) or a second signature.
    servers[S1].dropOnLookup = 1;
    await xrpAdapter.sendTransaction(me.privateKey, other, "2");
    const blobs = submits().map((r) => r.tx_blob);
    expect(blobs).toHaveLength(2);
    expect(blobs[1]).toBe(blobs[0]);
    expect(nextSequence).toBe(7); // prepared exactly once
  });

  it("treats a payment validated before its expiry as done, even when checked late", async () => {
    // xrpl.js's submitAndWait compares ledgers BEFORE looking the hash up, so
    // this exact case read as "expired". The hash lookup comes first here.
    for (const s of Object.values(servers)) s.ledgerIndex = 150; // past LastLedgerSequence 100
    await expect(xrpAdapter.sendTransaction(me.privateKey, other, "2")).resolves.toBeTruthy();
  });

  it("says nothing was sent when the payment expired unincluded", async () => {
    servers[S1].final = null;
    servers[S1].ledgerIndex = 150;
    await expect(xrpAdapter.sendTransaction(me.privateKey, other, "2")).rejects.toThrow(
      /expired before any ledger included it .* Nothing was sent/,
    );
    // A final answer is not retried on the other servers.
    expect(submits()).toHaveLength(1);
  });
});

describe("refused before signing", () => {
  it("keeps the reserve: 25 XRP can send at most 23.999988", async () => {
    await expect(xrpAdapter.sendTransaction(me.privateKey, other, "24.5")).rejects.toThrow(
      "You can send at most 23.999988 XRP. 1 XRP stays locked as this account's reserve on the XRP Ledger, and the fee is 0.000012 XRP.",
    );
    expect(submits()).toHaveLength(0);
  });

  it("counts owned objects into the reserve", async () => {
    servers[S1].accounts[me.address] = { Balance: "25000000", OwnerCount: 5 };
    await expect(xrpAdapter.sendTransaction(me.privateKey, other, "23.5")).rejects.toThrow(
      /at most 22\.999988 XRP\. 2 XRP stays locked/,
    );
  });

  it("refuses less than the reserve to an account that does not exist yet", async () => {
    const fresh = (await import("./xrp-wallet")).deriveXrpAtPath(ABANDON, "m/44'/144'/0'/0/9").address;
    await expect(xrpAdapter.sendTransaction(me.privateKey, fresh, "0.5")).rejects.toThrow(
      /is not an activated XRP account yet.*at least 1 XRP/,
    );
    await expect(xrpAdapter.sendTransaction(me.privateKey, fresh, "1")).resolves.toBeTruthy();
  });

  it("requires a tag when the recipient's account demands one", async () => {
    servers[S1].accounts[other] = { Balance: "5000000", Flags: 0x00020000 };
    await expect(xrpAdapter.sendTransaction(me.privateKey, other, "2")).rejects.toThrow(
      /requires a destination tag/,
    );
    await expect(
      xrpAdapter.sendTransaction(me.privateKey, other, "2", undefined, { destinationTag: 12345 }),
    ).resolves.toBeTruthy();
    const signed = xrpl.decode(submits()[0].tx_blob);
    expect(signed.DestinationTag).toBe(12345);
    expect(signed.Destination).toBe(other);
  });

  it("refuses a tag outside 32 bits and an unreadable amount", async () => {
    await expect(
      xrpAdapter.sendTransaction(me.privateKey, other, "2", undefined, { destinationTag: 2 ** 32 }),
    ).rejects.toThrow(/whole number from 0 to 4294967295/);
    await expect(xrpAdapter.sendTransaction(me.privateKey, other, "1.0000001")).rejects.toThrow(
      /at most 6 decimal places/,
    );
    expect(submits()).toHaveLength(0);
  });
});

describe("X-addresses", () => {
  it("unpacks the embedded tag into Destination + DestinationTag", () => {
    const x = xrpl.classicAddressToXAddress(other, 777, false);
    expect(parseXrpRecipient(x)).toEqual({ destination: other, tag: 777 });
  });

  it("refuses a typed tag that disagrees with the X-address", () => {
    const x = xrpl.classicAddressToXAddress(other, 777, false);
    expect(() => parseXrpRecipient(x, 778)).toThrow(/carries destination tag 777/);
  });

  it("refuses a testnet X-address", () => {
    const x = xrpl.classicAddressToXAddress(other, 1, true);
    expect(() => parseXrpRecipient(x)).toThrow(/TESTNET/);
  });
});

describe("the Send modal's budget", () => {
  it("names the reserve, not the fee, as what the balance must cover", async () => {
    const b = await xrpAdapter.getGasBudget!(me.address, { amount: "24.5" });
    expect(b).toMatchObject({ ticker: "XRP", includesAmount: true, available: "25", sufficient: false });
    expect(b.note).toBe(
      "The XRP Ledger keeps 1 XRP of this balance locked as the account reserve, so at most 23.99999 XRP can be sent.",
    );
  });

  it("says an unactivated account has nothing to send", async () => {
    const fresh = (await import("./xrp-wallet")).deriveXrpAtPath(ABANDON, "m/44'/144'/0'/0/8").address;
    const b = await xrpAdapter.getGasBudget!(fresh, {});
    expect(b.sufficient).toBe(false);
    expect(b.note).toMatch(/not activated yet.*at least 1 XRP/);
  });
});

describe("Activity amounts", () => {
  const row = (tx: Record<string, unknown>, meta: Record<string, unknown>) => ({
    hash: "AB".repeat(32),
    validated: true,
    ledger_index: 106870623,
    tx_json: { TransactionType: "Payment", date: 842283740, Fee: "12", ...tx },
    meta: { TransactionResult: "tesSUCCESS", ...meta },
  });

  it("reads rippled API v2's DeliverMax / delivered_amount, not a missing Amount", async () => {
    // The live shape, 2026-09-29: no `Amount` on a Payment at all.
    servers[S1].accountTx = [
      row({ Account: other, Destination: me.address, DeliverMax: "10000000" }, { delivered_amount: "10000000" }),
    ];
    const page = await xrpAdapter.getTransactionHistory(me.address);
    expect(page.items[0]).toMatchObject({ direction: "in", amount: "10.000000" });
  });

  it("counts a validated payment's confirmations in ledgers, never 'unconfirmed'", async () => {
    // Landscape read `confirmations: undefined` as 0 and printed
    // "unconfirmed" under every final XRP payment. A validated ledger is final;
    // the count is the ledgers closed since, including its own.
    (servers[S1] as any).ledgerMax = 106870632;
    servers[S1].accountTx = [
      row({ Account: other, Destination: me.address, DeliverMax: "10" }, { delivered_amount: "10" }),
    ];
    const page = await xrpAdapter.getTransactionHistory(me.address);
    expect(page.items[0].confirmations).toBe(10); // 106870632 - 106870623 + 1
  });

  it("shows what a partial payment delivered, not what it claimed", async () => {
    // tfPartialPayment: DeliverMax is an upper bound. The classic spoof sets it
    // to a million and delivers one drop.
    servers[S1].accountTx = [
      row(
        { Account: other, Destination: me.address, DeliverMax: "1000000000000", Flags: 0x00020000 },
        { delivered_amount: "1" },
      ),
    ];
    const page = await xrpAdapter.getTransactionHistory(me.address);
    expect(page.items[0].amount).toBe("0.000001");
  });
});
