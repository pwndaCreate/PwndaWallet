/**
 * The UTXO swap-deposit helpers in `swap-sources.ts` (2026-09-29 send-safety
 * audit, F7 and F10). Network and signer are stubbed; the PSBT construction,
 * address handling and amount conversion are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  proxyGets: [] as string[],
  signed: [] as Array<{ psbtHex: string; chain: string }>,
  accountSends: [] as any[],
  feeUnit: "sat/vB",
  accountHash: "acct-hash" as string | undefined,
  getJson: null as null | ((url: string) => unknown),
}));

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../../wallets/_proxy", () => ({
  proxyGetJson: vi.fn(async (url: string) => {
    S.proxyGets.push(url);
    if (!S.getJson) throw new Error("no stub for " + url);
    return S.getJson(url);
  }),
  proxyPostJson: vi.fn(),
  httpProxyCall: vi.fn(async () => ({
    status: 200,
    body: JSON.stringify({ data: { transaction_hash: "bch-broadcast-hash" } }),
  })),
}));
vi.mock("../../api/swap-rust", () => ({
  signPsbt: vi.fn(async (_sid: string, psbtHex: string, chain: string) => {
    S.signed.push({ psbtHex, chain });
    return { rawTx: "00" };
  }),
  broadcastTx: vi.fn(),
  signEvm: vi.fn(),
}));
vi.mock("../../wallets", () => ({
  getAdapter: vi.fn((chain: string) => ({
    chain,
    supportsAccountSend: () => true,
    async sendFromAccount(m: string, to: string, amount: string, from?: string, opts?: unknown) {
      S.accountSends.push({ chain, m, to, amount, from, opts });
      return S.accountHash ? { hash: S.accountHash } : ({} as any);
    },
    async getFeeEstimate() {
      return { normal: { value: "0.2" }, unit: S.feeUnit, fetchedAt: 0 };
    },
  })),
}));

const {
  accountSendAvailable,
  canonicalBchAddress,
  executeAccountUtxoTransfer,
  executeUtxoTransfer,
  singleAddressEmptyMessage,
} = await import("./swap-sources");
const { encodeCashAddr } = await import("../../wallets/bch-wallet");
const { isSendOutcomeUnknown } = await import("../../wallets/send-outcome");
const bitcoin = await import("bitcoinjs-lib");

beforeEach(() => {
  S.proxyGets.length = 0;
  S.signed.length = 0;
  S.accountSends.length = 0;
  S.feeUnit = "sat/vB";
  S.accountHash = "acct-hash";
  S.getJson = null;
  vi.unstubAllGlobals();
});

const p2pkh = (hash: Uint8Array) =>
  Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), Buffer.from(hash), Buffer.from([0x88, 0xac])]);

describe("F7: a BCH deposit builds and reaches the signer (2026-09-29 send-safety audit)", () => {
  const userHash = new Uint8Array(20).fill(0x11);
  const depositHash = new Uint8Array(20).fill(0x22);
  const USER = encodeCashAddr(userHash, "p2pkh");
  const DEPOSIT = encodeCashAddr(depositHash, "p2pkh");

  function stubChain() {
    const prev = new bitcoin.Transaction();
    prev.version = 1;
    prev.addInput(Buffer.alloc(32, 7), 0);
    prev.addOutput(p2pkh(userHash), 1_000_000n);
    const prevId = prev.getId();
    const prevHex = prev.toHex();
    S.getJson = (url) => {
      if (url.includes("/dashboards/address/")) {
        return { data: { [USER]: { utxo: [{ transaction_hash: prevId, index: 0, value: 1_000_000 }] } } };
      }
      if (url.includes("/raw/transaction/")) {
        return { data: { [prevId]: { raw_transaction: prevHex } } };
      }
      throw new Error("unexpected " + url);
    };
  }

  for (const [label, deposit] of [
    ["prefixed CashAddr", DEPOSIT],
    ["bare CashAddr", DEPOSIT.replace(/^bitcoincash:/, "")],
  ] as const) {
    it(`builds the PSBT for a ${label} deposit address and hands it to the signer`, async () => {
      stubChain();
      // Before: `require("../../wallets/bch-wallet")` inside the ESM module
      // threw before the PSBT reached the signer — every BCH deposit failed.
      const r = await executeUtxoTransfer({
        sessionId: "s",
        chain: "bch",
        fromAddress: USER,
        depositAddress: deposit,
        amountAtomic: "500000",
        rpcUrl: "unused",
      });
      expect(r.txHash).toBe("bch-broadcast-hash");
      expect(S.signed).toHaveLength(1);
      expect(S.signed[0].chain).toBe("bch");
      const psbt = bitcoin.Psbt.fromHex(S.signed[0].psbtHex);
      expect(Buffer.from(psbt.txOutputs[0].script).equals(p2pkh(depositHash))).toBe(true);
      expect(psbt.txOutputs[0].value).toBe(500_000n);
      // Change returns to the user's own address.
      expect(Buffer.from(psbt.txOutputs[1].script).equals(p2pkh(userHash))).toBe(true);
    });
  }

  it("canonicalizes every BCH form of the same address to one string", () => {
    const legacy = bitcoin.address.toBase58Check(Buffer.from(depositHash), 0x00);
    expect(canonicalBchAddress(bitcoin, DEPOSIT)).toBe(DEPOSIT);
    expect(canonicalBchAddress(bitcoin, DEPOSIT.slice("bitcoincash:".length))).toBe(DEPOSIT);
    expect(canonicalBchAddress(bitcoin, legacy)).toBe(DEPOSIT);
  });
});

describe("F10: an empty single address says so plainly (2026-09-29 live incident)", () => {
  it("does not ask whether a funding transaction confirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
    const err = await executeUtxoTransfer({
      sessionId: "s",
      chain: "ltc",
      fromAddress: "ltc1qty7jwkskqt8m82w73hxcsrh7gxkf90x27pxjn3",
      depositAddress: "ltc1qdep",
      amountAtomic: "31324582",
      rpcUrl: "https://litecoinspace.org/api",
    }).catch((e) => e);
    const msg = String(err?.message);
    // The incident's verbatim error was:
    //   No UTXOs found at ltc1qty7jwkskqt8m82w73hxcsrh7gxkf90x27pxjn3. Did the funding tx confirm?
    expect(msg).not.toMatch(/Did the funding tx confirm/);
    expect(msg).toBe(singleAddressEmptyMessage("ltc1qty7jwkskqt8m82w73hxcsrh7gxkf90x27pxjn3", "ltc"));
    expect(msg).toMatch(/other addresses of the same wallet/);
    expect(msg).toMatch(/Nothing was sent/);
  });
});

describe("F10: the account-wide deposit hands the adapter the exact amount (2026-09-29 live incident)", () => {
  const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  it("converts satoshis to the adapter's decimal string exactly", async () => {
    await executeAccountUtxoTransfer({
      chainKey: "litecoin",
      mnemonic: M,
      fromAddress: "ltc1qprimary",
      depositAddress: "ltc1qdep",
      amountAtomic: "31324582",
      decimals: 8,
      ticker: "LTC",
    });
    await executeAccountUtxoTransfer({
      chainKey: "litecoin", mnemonic: M, fromAddress: "p", depositAddress: "d",
      amountAtomic: "1", decimals: 8, ticker: "LTC",
    });
    expect(S.accountSends.map((c) => c.amount)).toEqual(["0.31324582", "0.00000001"]);
    // The adapter's own parse gives the same satoshis back.
    for (const c of S.accountSends) {
      expect(Math.round(parseFloat(c.amount) * 1e8)).toBe(c.amount === "0.31324582" ? 31324582 : 1);
    }
    expect(S.accountSends[0]).toMatchObject({ to: "ltc1qdep", from: "ltc1qprimary" });
  });

  it("refuses an amount the adapter's float parse could not return exactly", async () => {
    const err = await executeAccountUtxoTransfer({
      chainKey: "dogecoin", mnemonic: M, fromAddress: "p", depositAddress: "d",
      amountAtomic: "9007199254740993", decimals: 8, ticker: "DOGE",
    }).catch((e) => e);
    expect(String(err?.message)).toMatch(/exactly/);
    expect(S.accountSends).toHaveLength(0);
  });

  it("passes a per-byte fee rate, and none for a total-denominated estimate", async () => {
    S.feeUnit = "sat/vB";
    await executeAccountUtxoTransfer({
      chainKey: "bitcoin", mnemonic: M, fromAddress: "p", depositAddress: "d",
      amountAtomic: "100000", decimals: 8, ticker: "BTC",
    });
    S.feeUnit = "DOGE";
    await executeAccountUtxoTransfer({
      chainKey: "dogecoin", mnemonic: M, fromAddress: "p", depositAddress: "d",
      amountAtomic: "100000000", decimals: 8, ticker: "DOGE",
    });
    expect(S.accountSends[0].opts).toEqual({ feeRate: 1 });
    expect(S.accountSends[1].opts).toBeUndefined();
  });

  it("an adapter that returns without an id is an unknown outcome, not a failure", async () => {
    S.accountHash = undefined;
    const err = await executeAccountUtxoTransfer({
      chainKey: "litecoin", mnemonic: M, fromAddress: "p", depositAddress: "d",
      amountAtomic: "100000", decimals: 8, ticker: "LTC",
    }).catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
  });

  it("is unavailable without a mnemonic", async () => {
    expect(await accountSendAvailable({ chainKey: "litecoin", mnemonic: undefined, fromAddress: "p" })).toBe(false);
    expect(await accountSendAvailable({ chainKey: "litecoin", mnemonic: M, fromAddress: "p" })).toBe(true);
  });
});
