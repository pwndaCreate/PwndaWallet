/**
 * Aptos sends (2026-09-29 send-safety audit).
 *
 * The fake is the SDK's `Aptos` client and the hash helper; keys and accounts
 * are the real SDK. Lookups by hash go to a scripted Aptos REST API (fetch).
 * The fake also implements the SDK calls the adapter used before 2026-09-29
 * (`signAndSubmitTransaction`, `waitForTransaction`, scripted the way the real
 * SDK behaves for the same network answers), so these tests can be pointed at
 * the old adapter — that is how they were shown to fail there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apt = vi.hoisted(() => ({
  HASH: "0x" + "5e".repeat(32),
  builds: [] as any[],
  sims: [] as any[],
  signed: 0,
  simResult: {} as any,
  submit: (async () => ({})) as () => Promise<any>,
  /** The real SDK's waitForTransaction, for the old adapter. */
  wait: (async () => ({})) as () => Promise<any>,
}));

vi.mock("@aptos-labs/ts-sdk", async (importOriginal) => {
  const actual: any = await importOriginal();
  class FakeAptos {
    transaction = {
      build: {
        simple: async (args: any) => {
          apt.builds.push(args);
          return { rawTransaction: { sequence_number: 7n }, built: args };
        },
      },
      simulate: {
        simple: async (args: any) => {
          apt.sims.push(args);
          return [apt.simResult];
        },
      },
      sign: () => {
        apt.signed++;
        return { authenticator: true };
      },
      submit: { simple: () => apt.submit() },
    };
    async signAndSubmitTransaction() {
      apt.signed++;
      return apt.submit();
    }
    async waitForTransaction() {
      return apt.wait();
    }
  }
  return { ...actual, Aptos: FakeAptos, generateUserTransactionHash: () => apt.HASH };
});

import { APT_CONFIRM, aptAdapter, aptMaxGasFor } from "./apt-wallet";
import { isSendOutcomeUnknown } from "./send-outcome";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const me = aptAdapter.deriveFromMnemonic(ABANDON);
const TO = "0x" + "ab".repeat(32);
const API = "https://api.mainnet.aptoslabs.com/v1";

/** What `/transactions/by_hash` answers. */
let byHash: "ok" | "failed" | "pending" | "missing" | 429;
/** The node's ledger clock, seconds. */
let ledgerSecs: () => number;
let lookups: number;

async function aptosFetch(input: unknown) {
  const url = String(input);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === API) return json(200, { ledger_timestamp: String(BigInt(ledgerSecs()) * 1_000_000n) });
  if (url === `${API}/transactions/by_hash/${apt.HASH}`) {
    lookups++;
    if (byHash === 429) return json(429, { message: "rate limited" });
    if (byHash === "missing") return json(404, { error_code: "transaction_not_found" });
    if (byHash === "pending") return json(200, { type: "pending_transaction", hash: apt.HASH });
    return json(200, {
      type: "user_transaction",
      hash: apt.HASH,
      success: byHash === "ok",
      vm_status: byHash === "ok" ? "Executed successfully" : "Move abort in 0x1::coin: EINSUFFICIENT_BALANCE(0x10006)",
    });
  }
  throw new Error(`unscripted fetch ${url}`);
}

/** An error shaped like the SDK's AptosApiError. */
const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

const savedConfirm = APT_CONFIRM ? { ...APT_CONFIRM } : null;
beforeEach(() => {
  apt.builds = [];
  apt.sims = [];
  apt.signed = 0;
  apt.simResult = {
    success: true,
    vm_status: "Executed successfully",
    gas_used: "12",
    gas_unit_price: "100",
    max_gas_amount: "40000",
  };
  apt.submit = async () => ({ hash: apt.HASH });
  apt.wait = async () => ({ success: true, vm_status: "Executed successfully" });
  byHash = "ok";
  lookups = 0;
  ledgerSecs = () => Math.floor(Date.now() / 1000);
  // Guarded so this file can be pointed at the pre-2026-09-29 adapter.
  if (APT_CONFIRM) Object.assign(APT_CONFIRM, { pollMs: 2, expirySecs: 1, ledgerMarginSecs: 0, graceMs: 30 });
  vi.stubGlobal("fetch", vi.fn(aptosFetch));
});
afterEach(() => {
  if (APT_CONFIRM && savedConfirm) Object.assign(APT_CONFIRM, savedConfirm);
  vi.unstubAllGlobals();
});

describe("Aptos recipients are never padded (#1)", () => {
  it.each([
    ["0x" + "ab".repeat(20), /Ethereum address/],
    ["0x" + "a".repeat(63), /this one has 63/],
    ["0x1", /this one has 1/],
    ["0x" + "zz".repeat(32), /not an Aptos address/],
  ])("refuses %s before anything is built", async (to, why) => {
    await expect(aptAdapter.sendTransaction(me.privateKey, to, "1")).rejects.toThrow(why);
    expect(apt.builds).toEqual([]);
    expect(apt.signed).toBe(0);
  });

  it("takes 64 hex characters with or without 0x, in any case, and sends the canonical form", async () => {
    await aptAdapter.sendTransaction(me.privateKey, "  " + "AB".repeat(32) + " ", "1");
    for (const b of apt.builds) expect(b.data.functionArguments[0]).toBe(TO);
  });
});

describe("the gas limit comes from a simulation (#10)", () => {
  it("is 1.5x the simulated use, never below the SDK's floor", () => {
    expect(aptMaxGasFor(12n)).toBe(2_000n);
    expect(aptMaxGasFor(5_000n)).toBe(7_500n);
    expect(aptMaxGasFor(5_001n)).toBe(7_502n);
  });

  it("the signed transaction carries that limit, the simulated price and the draft's sequence number", async () => {
    apt.simResult.gas_used = "5000";
    await aptAdapter.sendTransaction(me.privateKey, TO, "1");
    expect(apt.sims.length).toBe(1);
    expect(apt.sims[0].options).toMatchObject({ estimateMaxGasAmount: true });
    const signedBuild = apt.builds[1];
    expect(signedBuild?.options).toMatchObject({
      maxGasAmount: 7_500,
      gasUnitPrice: 100,
      accountSequenceNumber: 7n,
    });
    // Nowhere near the SDK default of 2,000,000 units (2 APT at 100 octas).
    expect(signedBuild.options.maxGasAmount).toBeLessThan(2_000_000);
  });

  it("a simulation that fails is refused before anything is signed", async () => {
    apt.simResult = { success: false, vm_status: "INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE", gas_used: "0", gas_unit_price: "100" };
    await expect(aptAdapter.sendTransaction(me.privateKey, TO, "1")).rejects.toThrow(/Not enough APT/);
    expect(apt.signed).toBe(0);
  });
});

describe("a submitted Aptos send is settled by hash, never reported failed (#7)", () => {
  it("committed: sent", async () => {
    await expect(aptAdapter.sendTransaction(me.privateKey, TO, "1")).resolves.toEqual({ hash: apt.HASH });
  });

  it("accepted, but the lookups are rate-limited until the wait ends: submitted, not confirmed", async () => {
    byHash = 429;
    // What the SDK's waitForTransaction does with a 429: throws.
    apt.wait = async () => {
      throw apiError(429, "Too Many Requests");
    };
    await expect(aptAdapter.sendTransaction(me.privateKey, TO, "1")).resolves.toEqual({
      hash: apt.HASH,
      pending: true,
    });
    expect(apt.signed).toBe(1);
  });

  it("the submit answered 503, and the transaction did go through: sent", async () => {
    apt.submit = async () => {
      throw apiError(503, "Service Unavailable");
    };
    await expect(aptAdapter.sendTransaction(me.privateKey, TO, "1")).resolves.toEqual({ hash: apt.HASH });
    expect(apt.signed).toBe(1);
  });

  it("the submit connection dropped and nothing settles it: unknown, with the hash", async () => {
    apt.submit = async () => {
      throw new TypeError("fetch failed");
    };
    byHash = 429;
    const err = await aptAdapter.sendTransaction(me.privateKey, TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
    expect(err.hash).toBe(apt.HASH);
    expect(apt.signed).toBe(1);
  });

  it("the submit answered 503 and the transaction expired unseen: a plain failure, safe to send again", async () => {
    apt.submit = async () => {
      throw apiError(503, "Service Unavailable");
    };
    byHash = "missing";
    ledgerSecs = () => Math.floor(Date.now() / 1000) + 3_600;
    const err = await aptAdapter.sendTransaction(me.privateKey, TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(err.message).toMatch(/expired before it was committed[\s\S]*safe to send again/);
  });

  it("committed and failed: an error naming the hash", async () => {
    byHash = "failed";
    const err = await aptAdapter.sendTransaction(me.privateKey, TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(err.message).toMatch(/committed the transaction but it failed/);
    expect(err.message).toContain(apt.HASH);
  });

  it("a node refusing the transaction outright (400) is a plain failure and is not looked up", async () => {
    apt.submit = async () => {
      throw apiError(400, "Invalid transaction: SEQUENCE_NUMBER_TOO_OLD");
    };
    await expect(aptAdapter.sendTransaction(me.privateKey, TO, "1")).rejects.toThrow(
      /refused the transaction[\s\S]*Nothing was sent/,
    );
    expect(lookups).toBe(0);
  });
});
