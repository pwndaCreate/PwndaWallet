/**
 * TRX and USDT-on-TRON sends, end to end against a scripted node (2026-09-29).
 *
 * Each test is one way the send used to go wrong, reproduced at the network
 * boundary: `fetch` is the only fake. Signing, address encoding and the
 * transaction check are the real code, and the success-path transactions are
 * byte-for-byte what TronGrid built for these exact requests.
 *
 *  - a USDT send to a Bitcoin address encoded into a TRON transfer nobody can
 *    spend (the ABI word drops the version byte);
 *  - an account with USDT and too little TRX built, broadcast and burned
 *    energy on a transfer that could never finish;
 *  - whatever transaction the node returned was signed, unchecked;
 *  - `broadcast: result true` was reported as sent even when the transfer
 *    then failed in its block (OUT_OF_ENERGY).
 *
 * The 2026-09-29 send-safety audit added TronStack, reached through the Rust
 * proxy (`_proxy.httpProxyCall`, the second fake): it serves the full-node
 * `/wallet/*` API and answers 404 for TronGrid's `/v1/*`, as the live host
 * does. Its tests pin the fallback's account read, the check that must not be
 * skipped when that read fails, and a broadcast whose answer is DUP or never
 * comes.
 */
import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSendOutcomeUnknown } from "./send-outcome";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// The abandon seed's TRON account (41 9858…da94) sends; the recipient is an
// arbitrary account id (41 cbc9…1c79) that was typed into the request that
// built the USDT vector. It is NOT derived from the seed — an earlier draft of
// this file said it was, and the derivation test below is what caught that.
const OWNER_HEX = "419858effd232b4033e47d90003d41ec34ecaeda94";
const RECIPIENT_HEX = "41cbc9f1a9e6da62d2fd6283aa51f4dea2c0fc1c79";

// TronGrid `triggersmartcontract`, 2026-09-29: USDT transfer(recipient,
// 1.234567) from OWNER, fee limit 100 TRX. Never signed or broadcast.
const USDT_TX = {
  txID: "efe5cd71c441ce4d56c10a2b926919b48ce15f1edbc3de923e5e4febcb4f91ca",
  raw_data_hex:
    "0a02bb66220896b95c21f21f646840b894daff8e345aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a15419858effd232b4033e47d90003d41ec34ecaeda94121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb000000000000000000000000cbc9f1a9e6da62d2fd6283aa51f4dea2c0fc1c79000000000000000000000000000000000000000000000000000000000012d68770f7c6d6ff8e34900180c2d72f",
};

// TronGrid `createtransaction` (1.234567 TRX, 2026-09-29) with its owner and
// recipient fields re-pointed at OWNER → RECIPIENT and the id re-hashed: the
// transaction an honest node builds for that request.
const TRX_RAW = "0a02bb6e2208c57d351194bd00b940f8cfdbff8e345a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541320c3166e1162250bef6595f2c52cc0f2be78ecc1215419858effd232b4033e47d90003d41ec34ecaeda941887ad4b70908ed8ff8e34"
  .replace("0a1541320c3166e1162250bef6595f2c52cc0f2be78ecc", "0a15" + OWNER_HEX)
  .replace("1215419858effd232b4033e47d90003d41ec34ecaeda94", "1215" + RECIPIENT_HEX);
const TRX_TX = { txID: ethers.sha256("0x" + TRX_RAW).slice(2), raw_data_hex: TRX_RAW };

// A Bitcoin P2PKH address: 21-byte base58check like TRON's, version 0x00.
const BTC_ADDRESS = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

type Route = (body: any) => unknown;
let routes: Record<string, Route>;
let calls: string[];
/** TronGrid failures by path ("*" = every path): an HTTP status, or "throw" for no answer. */
let gridFail: Record<string, number | "throw">;
/** TronStack's `/wallet/*` routes. A route returning an Error makes the proxy call throw. */
let stack: Record<string, Route>;
let stackCalls: string[];

vi.mock("./_proxy", () => ({
  httpProxyCall: async (opts: { url: string; body?: string }) => {
    const path = new URL(opts.url).pathname;
    stackCalls.push(path);
    // The live host: no `/v1/*` at all (verified 2026-09-29).
    if (path.startsWith("/v1/")) return { status: 404, body: "404 page not found", headers: [] };
    const route = stack[path];
    if (!route) return { status: 500, body: "not scripted", headers: [] };
    const out = route(opts.body ? JSON.parse(opts.body) : undefined);
    if (out instanceof Error) throw out;
    return { status: 200, body: JSON.stringify(out), headers: [] };
  },
  proxyGetJson: async () => {
    throw new Error("proxyGetJson is not scripted here");
  },
}));

function install() {
  calls = [];
  stackCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(path);
      const fail = gridFail[path] ?? gridFail["*"];
      if (fail === "throw") throw new TypeError("Failed to fetch");
      if (fail !== undefined) return new Response("scripted failure", { status: fail });
      const route = routes[path] ?? routes[path.replace(/\/v1\/accounts\/[^/]+$/, "/v1/accounts/*")];
      if (!route) return new Response("not scripted", { status: 500 });
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify(route(body)), { status: 200 });
    }),
  );
}

async function load() {
  vi.resetModules();
  const trx = await import("./trx-wallet");
  // Guarded so this file can also be pointed at the pre-2026-09-29 adapters.
  if (trx.TRON_EXECUTION_POLL) {
    trx.TRON_EXECUTION_POLL.intervalMs = 1;
    trx.TRON_EXECUTION_POLL.timeoutMs = 200;
  }
  if (trx.TRONGRID_RATE) trx.TRONGRID_RATE.minSpacingMs = 0;
  const trc20 = await import("./trc20-wallet");
  const key = trx.trxAdapter.deriveFromMnemonic(ABANDON).privateKey;
  const recipient = trx.ethAddressToTron("0x" + RECIPIENT_HEX.slice(2));
  return { trx, usdt: trc20.usdtTronAdapter, key, recipient };
}

/** A node for an account holding `trxSun` TRX and no staked resources. */
function baseRoutes(trxSun: number): Record<string, Route> {
  return {
    "/v1/accounts/*": () => ({ success: true, data: [{ balance: trxSun }] }),
    "/wallet/getaccountresource": () => ({ freeNetLimit: 600, freeNetUsed: 0 }),
    "/wallet/getchainparameters": () => ({
      chainParameter: [
        { key: "getEnergyFee", value: 100 },
        { key: "getTransactionFee", value: 1000 },
      ],
    }),
    // What a live USDT holder's transfer to an existing holder costs.
    "/wallet/triggerconstantcontract": () => ({
      result: { result: true },
      energy_used: 64285,
      transaction: { ret: [{}] },
    }),
    "/wallet/triggersmartcontract": () => ({ result: { result: true }, transaction: { ...USDT_TX } }),
    "/wallet/createtransaction": () => ({ ...TRX_TX }),
    "/wallet/broadcasttransaction": (b) => ({ result: true, txid: b?.txID }),
    "/wallet/gettransactioninfobyid": (b) => ({ id: b?.value, receipt: { result: "SUCCESS" } }),
  };
}

/** TronStack answering like the TronGrid routes, through its own paths. */
function stackRoutes(trxSun: number): Record<string, Route> {
  const grid = baseRoutes(trxSun);
  return {
    ...grid,
    // `/wallet/getaccount` omits `balance` at zero and prints `{}` for an
    // account that does not exist yet.
    "/wallet/getaccount": () => (trxSun > 0 ? { address: "T", balance: trxSun } : {}),
  };
}

beforeEach(() => {
  routes = baseRoutes(50_000_000);
  gridFail = {};
  stack = {};
  install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the vectors", () => {
  it("are sent from the account the wallet derives for the abandon seed", async () => {
    const { trx, recipient } = await load();
    expect(trx.tronAddressToHex(trx.trxAdapter.deriveFromMnemonic(ABANDON).address)).toBe(OWNER_HEX);
    expect(trx.tronAddressToHex(recipient)).toBe(RECIPIENT_HEX);
    // Pinned so nobody re-labels the recipient as the seed's 195' sibling:
    // that account is 41 c859…d78a.
    expect(trx.tronAddressToHex(trx.deriveTrxAtPath(ABANDON, "m/44'/195'/0'/0/0").address)).toBe(
      "41c8599111f29c1e1e061265b4af93ea1f274ad78a",
    );
  });
});

describe("USDT on TRON", () => {
  it("refuses a Bitcoin address before touching the network", async () => {
    const { usdt, key } = await load();
    await expect(usdt.sendTransaction(key, BTC_ADDRESS, "1")).rejects.toThrow(/not a TRON address/);
    expect(calls).toEqual([]);
  });

  it("refuses when the account cannot pay the energy, before building anything", async () => {
    routes = baseRoutes(5_000_000); // 5 TRX; the transfer burns ~6.43
    const { usdt, key, recipient } = await load();
    await expect(usdt.sendTransaction(key, recipient, "1.234567")).rejects.toThrow(
      /burns about 6\.43 TRX .* this address has 5\.0 TRX/,
    );
    expect(calls).not.toContain("/wallet/triggersmartcontract");
    expect(calls).not.toContain("/wallet/broadcasttransaction");
  });

  it("refuses to sign a transaction the node changed", async () => {
    const forgedRaw = USDT_TX.raw_data_hex.replace(RECIPIENT_HEX.slice(2), "ab".repeat(20));
    routes["/wallet/triggersmartcontract"] = () => ({
      result: { result: true },
      transaction: { raw_data_hex: forgedRaw, txID: ethers.sha256("0x" + forgedRaw).slice(2) },
    });
    const { usdt, key, recipient } = await load();
    await expect(usdt.sendTransaction(key, recipient, "1.234567")).rejects.toThrow(
      /different recipient or amount/,
    );
    expect(calls).not.toContain("/wallet/broadcasttransaction");
  });

  it("reports a transfer that failed in its block as failed, not sent", async () => {
    routes["/wallet/gettransactioninfobyid"] = (b) => ({
      id: b?.value,
      result: "FAILED",
      receipt: { result: "OUT_OF_ENERGY" },
    });
    const { usdt, key, recipient } = await load();
    await expect(usdt.sendTransaction(key, recipient, "1.234567")).rejects.toThrow(
      /failed on chain: OUT_OF_ENERGY/,
    );
  });

  it("sends when every check passes, and waits for the block", async () => {
    const { usdt, key, recipient } = await load();
    await expect(usdt.sendTransaction(key, recipient, "1.234567")).resolves.toEqual({
      hash: USDT_TX.txID,
    });
    expect(calls).toContain("/wallet/broadcasttransaction");
    expect(calls.at(-1)).toBe("/wallet/gettransactioninfobyid");
  });

  it("warns in the Send modal before the press, in TRX on TRON", async () => {
    routes = baseRoutes(5_000_000);
    const { usdt, recipient, trx } = await load();
    const owner = trx.trxAdapter.deriveFromMnemonic(ABANDON).address;
    expect(usdt.gasToken).toEqual({ ticker: "TRX", chainName: "TRON" });
    const budget = await usdt.getGasBudget!(owner, { to: recipient, amount: "1" });
    expect(budget).toMatchObject({
      ticker: "TRX",
      includesAmount: false,
      required: "6.43",
      available: "5.0",
      sufficient: false,
    });
  });

  it("with no recipient yet, assumes the dearer new-holder transfer", async () => {
    routes = baseRoutes(10_000_000);
    const { usdt, trx } = await load();
    const owner = trx.trxAdapter.deriveFromMnemonic(ABANDON).address;
    const budget = await usdt.getGasBudget!(owner, {});
    expect(budget.required).toBe("13.1");
    expect(budget.sufficient).toBe(false);
  });
});

describe("native TRX", () => {
  it("refuses a Bitcoin address before touching the network", async () => {
    const { trx, key } = await load();
    await expect(trx.trxAdapter.sendTransaction(key, BTC_ADDRESS, "1")).rejects.toThrow(
      /not a TRON address/,
    );
    expect(calls).toEqual([]);
  });

  it("surfaces the node's refusal instead of signing nothing", async () => {
    routes["/wallet/createtransaction"] = () => ({
      Error:
        "class org.tron.core.exception.ContractValidateException : Validate TransferContract error, balance is not sufficient.",
    });
    const { trx, key, recipient } = await load();
    await expect(trx.trxAdapter.sendTransaction(key, recipient, "1.234567")).rejects.toThrow(
      "TRX transfer refused: Validate TransferContract error, balance is not sufficient.",
    );
    expect(calls).not.toContain("/wallet/broadcasttransaction");
  });

  it("refuses to sign a transfer to someone else", async () => {
    const forged = TRX_RAW.replace(RECIPIENT_HEX, "41" + "ab".repeat(20));
    routes["/wallet/createtransaction"] = () => ({
      raw_data_hex: forged,
      txID: ethers.sha256("0x" + forged).slice(2),
    });
    const { trx, key, recipient } = await load();
    await expect(trx.trxAdapter.sendTransaction(key, recipient, "1.234567")).rejects.toThrow(
      /different recipient/,
    );
    expect(calls).not.toContain("/wallet/broadcasttransaction");
  });

  it("sends exactly the requested sun, parsed without floats", async () => {
    let asked: any = null;
    routes["/wallet/createtransaction"] = (b) => {
      asked = b;
      return { ...TRX_TX };
    };
    const { trx, key, recipient } = await load();
    await expect(trx.trxAdapter.sendTransaction(key, recipient, "1.234567")).resolves.toEqual({
      hash: TRX_TX.txID,
    });
    expect(asked.amount).toBe(1_234_567);
  });

  it("decodes a hex broadcast error instead of printing hex", async () => {
    routes["/wallet/broadcasttransaction"] = () => ({
      result: false,
      code: "BANDWITH_ERROR",
      message: Buffer.from("Account resource insufficient error.").toString("hex"),
    });
    const { trx, key, recipient } = await load();
    await expect(trx.trxAdapter.sendTransaction(key, recipient, "1.234567")).rejects.toThrow(
      "Account resource insufficient error.",
    );
  });
});

/** The error a promise rejects with (for assertions `toThrow` cannot make). */
async function rejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the send to be rejected");
}

const dup = (b: any) => ({
  result: false,
  code: "DUP_TRANSACTION_ERROR",
  txid: b?.txID,
  message: Buffer.from("dup transaction").toString("hex"),
});

describe("the TronStack fallback reads accounts through /wallet/getaccount (2026-09-29 send-safety audit)", () => {
  it("reads the TRX balance when TronGrid rate-limits", async () => {
    // TronStack answers `/v1/accounts` 404, so this read had no fallback.
    gridFail["*"] = 429;
    stack = stackRoutes(12_345_678);
    const { trx } = await load();
    const owner = trx.trxAdapter.deriveFromMnemonic(ABANDON).address;
    await expect(trx.trxAdapter.getBalance(owner)).resolves.toBe("12.345678");
    expect(stackCalls).toContain("/wallet/getaccount");
  });

  it("reads an account that does not exist yet as zero, and a node error as a failure", async () => {
    gridFail["*"] = 429;
    stack = stackRoutes(0);
    const { trx } = await load();
    const owner = trx.trxAdapter.deriveFromMnemonic(ABANDON).address;
    await expect(trx.trxAdapter.getBalance(owner)).resolves.toBe("0.000000");
    stack["/wallet/getaccount"] = () => ({ Error: "class java.lang.NullPointerException : null" });
    await expect(trx.trxAdapter.getBalance(owner)).rejects.toThrow(/Unexpected TRX balance response/);
  });

  it("keeps the USDT send's TRX check working while TronGrid rate-limits", async () => {
    // The check used to become "unknown" here, and the send went ahead.
    gridFail["*"] = 429;
    stack = stackRoutes(5_000_000); // 5 TRX; the transfer burns ~6.43
    const { usdt, key, recipient } = await load();
    await expect(usdt.sendTransaction(key, recipient, "1.234567")).rejects.toThrow(
      /burns about 6\.43 TRX .* this address has 5\.0 TRX/,
    );
    expect(stackCalls).not.toContain("/wallet/triggersmartcontract");
  });

  it("refuses the USDT send when the TRX check cannot be made at all", async () => {
    gridFail["*"] = 429;
    stack = stackRoutes(50_000_000);
    stack["/wallet/getaccount"] = () => new Error("tronstack unreachable");
    const { usdt, key, recipient } = await load();
    await expect(usdt.sendTransaction(key, recipient, "1.234567")).rejects.toThrow(
      /Could not check .* Nothing was sent/,
    );
    expect([...calls, ...stackCalls]).not.toContain("/wallet/triggersmartcontract");
    expect([...calls, ...stackCalls]).not.toContain("/wallet/broadcasttransaction");
  });
});

describe("a broadcast whose answer is DUP or never comes (2026-09-29 send-safety audit)", () => {
  it("TRX: TronGrid takes it and times out, TronStack says DUP for our id — that is sent", async () => {
    gridFail["/wallet/broadcasttransaction"] = "throw";
    stack = { "/wallet/broadcasttransaction": dup };
    const { trx, key, recipient } = await load();
    await expect(trx.trxAdapter.sendTransaction(key, recipient, "1.234567")).resolves.toEqual({
      hash: TRX_TX.txID,
    });
  });

  it("USDT: a DUP for our id still waits for the transfer to execute", async () => {
    gridFail["/wallet/broadcasttransaction"] = 504;
    stack = { "/wallet/broadcasttransaction": dup };
    const { usdt, key, recipient } = await load();
    await expect(usdt.sendTransaction(key, recipient, "1.234567")).resolves.toEqual({
      hash: USDT_TX.txID,
    });
    expect(calls.at(-1)).toBe("/wallet/gettransactioninfobyid");
  });

  it("USDT: a DUP followed by an on-chain failure is reported as that failure", async () => {
    gridFail["/wallet/broadcasttransaction"] = "throw";
    stack = { "/wallet/broadcasttransaction": dup };
    routes["/wallet/gettransactioninfobyid"] = (b) => ({
      id: b?.value,
      result: "FAILED",
      receipt: { result: "OUT_OF_ENERGY" },
    });
    const { usdt, key, recipient } = await load();
    await expect(usdt.sendTransaction(key, recipient, "1.234567")).rejects.toThrow(
      /failed on chain: OUT_OF_ENERGY/,
    );
  });

  it("no answer from either node, and not in a block: 'may have been sent', with the hash", async () => {
    gridFail["/wallet/broadcasttransaction"] = "throw";
    stack = { "/wallet/broadcasttransaction": () => new Error("proxy: operation timed out") };
    routes["/wallet/gettransactioninfobyid"] = () => ({});
    const { trx, key, recipient } = await load();
    const e = await rejection(trx.trxAdapter.sendTransaction(key, recipient, "1.234567"));
    expect(isSendOutcomeUnknown(e), String(e)).toBe(true);
    expect(e.hash).toBe(TRX_TX.txID);
  });

  it("an unanswered broadcast found executed by id is a success", async () => {
    gridFail["/wallet/broadcasttransaction"] = 502;
    stack = { "/wallet/broadcasttransaction": () => new Error("proxy: connection reset") };
    const { usdt, key, recipient } = await load();
    await expect(usdt.sendTransaction(key, recipient, "1.234567")).resolves.toEqual({
      hash: USDT_TX.txID,
    });
  });

  it("a node that answers with a refusal, nothing uncertain before it, is an ordinary failure", async () => {
    // 429: TronGrid did not process the request, so TronStack's answer decides.
    gridFail["/wallet/broadcasttransaction"] = 429;
    stack = {
      "/wallet/broadcasttransaction": () => ({
        result: false,
        code: "SIGERROR",
        message: Buffer.from("validate signature error").toString("hex"),
      }),
    };
    const { trx, key, recipient } = await load();
    const e = await rejection(trx.trxAdapter.sendTransaction(key, recipient, "1.234567"));
    expect(isSendOutcomeUnknown(e)).toBe(false);
    expect(String(e.message)).toContain("validate signature error");
  });

  it("USDT: accepted but not executed within the wait is 'submitted', not 'sent'", async () => {
    routes["/wallet/gettransactioninfobyid"] = () => ({});
    const { usdt, key, recipient } = await load();
    await expect(usdt.sendTransaction(key, recipient, "1.234567")).resolves.toEqual({
      hash: USDT_TX.txID,
      pending: true,
    });
  });
});
