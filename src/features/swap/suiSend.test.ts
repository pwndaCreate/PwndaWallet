/**
 * The Sui send on GraphQL (operator request, 2026-10-01: "Does the sui wallet
 * need to be changed?"). Sui's published timeline ends JSON-RPC on full nodes,
 * code included, in mid-October 2026, and until this change every Sui send
 * read its gas price, its dry run and its coins from publicnode's JSON-RPC
 * through `@mysten/sui`'s `build({ client })`, submitted there and looked a
 * failed submit up there.
 *
 * What these tests hold:
 *  - the bytes handed to the Rust signer are the bytes the old JSON-RPC build
 *    produced from the same chain state (the old build runs here, on the real
 *    SDK, against a fake publicnode);
 *  - with no address balance, nothing is asked of publicnode at all;
 *  - an address balance is still spent the old way while JSON-RPC answers
 *    (its compatibility coin reservation is the only way the 1.x SDK can), and
 *    refused before signing when that route is gone and the coins fall short;
 *  - the send-safety rules of 2026-09-29: recipient and key checks before
 *    anything is read, sign once, settle an uncertain submit by digest.
 *
 * Fakes: the Rust commands (the signer is emulated exactly: BLAKE2b-256 of
 * intent [0,0,0] || bytes, ed25519 with the public abandon seed's Sui key),
 * the proxy's GraphQL answers and publicnode's JSON-RPC answers. Every answer
 * keeps the layout a live, read-only request returned on 2026-10-01 for the
 * public test seed (its address, its coin 0xb3103ee5… as it stood before its
 * send of 2026-05-11, a dry run of a transfer from it); other ids and digests
 * are invented. Nothing reaches a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { bcs } from "@mysten/sui/bcs";
import { toBase58 } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));

import { invoke } from "../../lib/tauri";
import { SESSION_SEND_TIMING, executeSuiTransfer } from "./session-send";
import { SUI_RPC, suiAdapter } from "../../wallets/sui-wallet";
import { isSendOutcomeUnknown } from "../../wallets/send-outcome";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const me = suiAdapter.deriveFromMnemonic(ABANDON);
const ME = me.address; // 0x5e93a736d04f…61f1
const MY_SECRET = Uint8Array.from(Buffer.from(me.privateKey, "hex"));
const MY_PUB = ed25519.getPublicKey(MY_SECRET);
const OTHER_SECRET = new Uint8Array(32).fill(7);
const TO = "0x" + "ab".repeat(32);
const GRAPHQL = "https://graphql.mainnet.sui.io/graphql";

/** An invented, well-formed object digest. */
const objDigest = (n: number) => toBase58(new Uint8Array(32).fill(n));

interface Coin {
  objectId: string;
  version: number;
  digest: string;
  balance: string;
}

/** The test seed's coin before its 2026-05-11 send (`objectChanges.inputState`, live). */
const SEED_COIN: Coin = {
  objectId: "0xb3103ee56b3e0aea3c3db9403e3f062f513026bc8bf3fac53c783ea571a3ef15",
  version: 872783653,
  digest: "4ZAVLMEE62Aa8gm41JKUfzSQW4wdp5T62vDkdYgN1g4U",
  balance: "500000000",
};
/** Ties SEED_COIN's balance, so the object id orders them. */
const TIE_COIN: Coin = { objectId: "0x" + "11".repeat(32), version: 1000, digest: objDigest(7), balance: "500000000" };
const BIG_COIN: Coin = { objectId: "0x" + "ff".repeat(32), version: 5, digest: objDigest(9), balance: "2000000000" };

/**
 * A compatibility coin reservation as `suix_getCoins` lists it: an ordinary
 * coin entry, second in the list, whose id, version and digest encode the
 * reservation (sui-json-rpc `get_owned_coins`, mainnet-v1.80.1). Invented.
 */
const RESERVATION: Coin = { objectId: "0x" + "5a".repeat(32), version: 77, digest: objDigest(3), balance: "3000000000" };

interface Chain {
  price: string;
  /** The dry run's gas, as `simulateTransaction` reported it live (UInt53 numbers). */
  dry: { computationCost: number; storageCost: number; storageRebate: number };
  coins: Coin[];
  addressBalance: string;
  jsonRpc: "up" | "gone";
  graphql: "up" | "down";
  simulate: "ok" | "fail";
  execute: "ok" | "fail" | "unreachable" | "no-outcome" | { digest: string };
  effects: "success" | "failure" | "missing" | "unreachable";
  signWith: "mine" | "other";
}
let chain: Chain;

const rec = {
  gql: [] as Array<{ url: string; query: string; variables: any }>,
  rpc: [] as Array<{ method: string; params: any[] }>,
  signed: [] as string[],
};

const byBalanceThenId = (a: Coin, b: Coin) =>
  BigInt(a.balance) !== BigInt(b.balance)
    ? BigInt(a.balance) > BigInt(b.balance)
      ? -1
      : 1
    : a.objectId < b.objectId
      ? -1
      : 1;

/** The proxy's GraphQL answers (graphql.mainnet.sui.io). */
function graphql(args: { url: string; body: string }) {
  const { query, variables } = JSON.parse(args.body);
  rec.gql.push({ url: args.url, query, variables });
  if (chain.graphql === "down") return { status: 503, body: "unavailable", headers: [] };
  const data = (d: unknown) => ({ status: 200, body: JSON.stringify({ data: d }), headers: [] });
  if (query.includes("simulateTransaction")) {
    return data({
      simulateTransaction: {
        effects:
          chain.simulate === "ok"
            ? {
                status: "SUCCESS",
                executionError: null,
                gasEffects: { gasSummary: chain.dry },
              }
            : {
                status: "FAILURE",
                executionError: { message: "InsufficientCoinBalance in command 0" },
                gasEffects: { gasSummary: chain.dry },
              },
      },
    });
  }
  if (query.includes("executeTransaction")) {
    const ex = chain.execute;
    if (ex === "unreachable") return { status: 502, body: "bad gateway", headers: [] };
    const digest = TransactionDataBuilder.getDigestFromBytes(Buffer.from(variables.tx, "base64"));
    if (ex === "no-outcome") return data({ executeTransaction: { effects: null } });
    return data({
      executeTransaction: {
        effects: {
          digest: typeof ex === "object" ? ex.digest : digest,
          status: ex === "fail" ? "FAILURE" : "SUCCESS",
          executionError: ex === "fail" ? { message: "InsufficientCoinBalance in command 0" } : null,
        },
      },
    });
  }
  if (query.includes("transactionEffects")) {
    if (chain.effects === "unreachable") return { status: 503, body: "unavailable", headers: [] };
    if (chain.effects === "missing") return data({ transactionEffects: null });
    return data({
      transactionEffects:
        chain.effects === "success"
          ? { status: "SUCCESS", executionError: null }
          : { status: "FAILURE", executionError: { message: "InsufficientGas" } },
    });
  }
  if (query.includes("objects(")) {
    const inCoins = chain.coins.reduce((s, c) => s + BigInt(c.balance), 0n);
    // GraphQL is answered in object-id order here, not balance order, so the
    // wallet's own sort is what the bytes depend on.
    const nodes = [...chain.coins]
      .sort((a, b) => (a.objectId < b.objectId ? -1 : 1))
      .map((c) => ({
        address: c.objectId,
        version: c.version,
        digest: c.digest,
        contents: { json: { id: c.objectId, balance: c.balance } },
      }));
    return data({
      epoch: { referenceGasPrice: chain.price },
      address: {
        balance: { coinBalance: String(inCoins), addressBalance: chain.addressBalance },
        objects: { nodes },
      },
    });
  }
  throw new Error(`unscripted GraphQL ${query.slice(0, 80)}`);
}

/** publicnode's JSON-RPC (the old build), answered in the fullnode's layouts. */
async function publicnode(_input: unknown, init?: { body?: unknown }) {
  const req = JSON.parse(String(init?.body));
  rec.rpc.push({ method: req.method, params: req.params });
  const reply = (body: object) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (chain.jsonRpc === "gone") {
    return reply({ error: { code: -32601, message: "Method not found" } });
  }
  switch (req.method) {
    case "suix_getReferenceGasPrice":
      return reply({ result: chain.price });
    case "sui_dryRunTransactionBlock":
      return reply({
        result: {
          effects: {
            status: { status: "success" },
            gasUsed: {
              computationCost: String(chain.dry.computationCost),
              storageCost: String(chain.dry.storageCost),
              storageRebate: String(chain.dry.storageRebate),
              nonRefundableStorageFee: "0",
            },
          },
        },
      });
    case "suix_getCoins": {
      // The fullnode's order (CoinIndexKey2), with an address balance's
      // reservation second when there is one.
      const list = [...chain.coins].sort(byBalanceThenId);
      if (BigInt(chain.addressBalance) > 0n) list.splice(1, 0, RESERVATION);
      return reply({
        result: {
          data: list.map((c) => ({
            coinType: "0x2::sui::SUI",
            coinObjectId: c.objectId,
            version: String(c.version),
            digest: c.digest,
            balance: c.balance,
            previousTransaction: objDigest(1),
          })),
          nextCursor: null,
          hasNextPage: false,
        },
      });
    }
    default:
      throw new Error(`unscripted JSON-RPC ${req.method}`);
  }
}

/** The Rust core: the session's address, and `swap/sui.rs::sign_tx`. */
async function fakeInvoke(cmd: string, args: any): Promise<unknown> {
  switch (cmd) {
    case "http_proxy_call":
      return graphql(args);
    case "swap_get_sui_address":
      return ME;
    case "swap_sign_sui_tx": {
      rec.signed.push(args.input.txBytesBase64);
      const secret = chain.signWith === "mine" ? MY_SECRET : OTHER_SECRET;
      const pub = ed25519.getPublicKey(secret);
      const tx = Buffer.from(args.input.txBytesBase64, "base64");
      const digest = blake2b(Buffer.concat([Buffer.from([0, 0, 0]), tx]), { dkLen: 32 });
      const sig = ed25519.sign(digest, secret);
      return {
        signatureBase64: Buffer.from([0, ...sig, ...pub]).toString("base64"),
        publicKeyBase64: Buffer.from(pub).toString("base64"),
      };
    }
    default:
      throw new Error(`unscripted invoke ${cmd}`);
  }
}

/** The transfer as the code before 2026-10-01 built it: the SDK's JSON-RPC resolver. */
async function oldBuild(to: string, mist: bigint): Promise<{ bytes: Uint8Array; dryRun: string }> {
  const from = rec.rpc.length;
  const tx = new Transaction();
  tx.setSender(ME);
  const [coin] = tx.splitCoins(tx.gas, [mist]);
  tx.transferObjects([coin], to);
  const bytes = await tx.build({ client: new SuiClient({ url: SUI_RPC }) });
  const dry = rec.rpc.slice(from).find((r) => r.method === "sui_dryRunTransactionBlock");
  return { bytes, dryRun: dry!.params[0] };
}

const send = (over: Partial<Parameters<typeof executeSuiTransfer>[0]> = {}) =>
  executeSuiTransfer({ sessionId: "s", fromAddress: ME, to: TO, amount: "1.5", ...over });

/** What was handed to the signer, decoded. */
function signedTx(i = 0) {
  return bcs.TransactionData.parse(Buffer.from(rec.signed[i], "base64")).V1!;
}
const gqlKinds = () =>
  rec.gql.map(({ query }) =>
    query.includes("simulateTransaction")
      ? "simulate"
      : query.includes("executeTransaction")
        ? "execute"
        : query.includes("transactionEffects")
          ? "effects"
          : "state",
  );

const savedTiming = { ...SESSION_SEND_TIMING };
beforeEach(() => {
  chain = {
    price: "100",
    dry: { computationCost: 100000, storageCost: 1976000, storageRebate: 0 },
    coins: [SEED_COIN, TIE_COIN, BIG_COIN],
    addressBalance: "0",
    jsonRpc: "up",
    graphql: "up",
    simulate: "ok",
    execute: "ok",
    effects: "missing",
    signWith: "mine",
  };
  rec.gql = [];
  rec.rpc = [];
  rec.signed = [];
  Object.assign(SESSION_SEND_TIMING, { pollMs: 2, suiLookupMs: 30 });
  vi.stubGlobal("fetch", vi.fn(publicnode));
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(fakeInvoke as any);
});
afterEach(() => {
  Object.assign(SESSION_SEND_TIMING, savedTiming);
  vi.unstubAllGlobals();
});

describe("the bytes signed do not change (operator request, 2026-10-01)", () => {
  it("signs the bytes the JSON-RPC build signed, from the same chain state", async () => {
    const before = await oldBuild(TO, 1_500_000_000n);
    rec.rpc = [];
    const r = await send();
    expect(rec.signed).toHaveLength(1);
    expect(rec.signed[0]).toBe(Buffer.from(before.bytes).toString("base64"));
    // The dry run is the same transaction too.
    const sim = rec.gql.find(({ query }) => query.includes("simulateTransaction"))!;
    expect(sim.variables).toEqual({ tx: { bcs: { value: before.dryRun } } });
    expect(r.txHash).toBe(TransactionDataBuilder.getDigestFromBytes(before.bytes));
  });

  it("holds for a dry run whose storage rebate exceeds its storage cost (the budget's other branch)", async () => {
    chain.dry = { computationCost: 750000, storageCost: 988000, storageRebate: 1978120 };
    const before = await oldBuild(TO, 1_500_000_000n);
    await send();
    expect(rec.signed[0]).toBe(Buffer.from(before.bytes).toString("base64"));
    // computation + 1,000 x the gas price.
    expect(signedTx().gasData.budget).toBe(String(750000 + 1000 * 100));
  });

  it("holds when the coins' balances tie: the object id orders them, as suix_getCoins does", async () => {
    chain.coins = [TIE_COIN, SEED_COIN];
    const before = await oldBuild(TO, 100_000_000n);
    await send({ amount: "0.1" });
    expect(rec.signed[0]).toBe(Buffer.from(before.bytes).toString("base64"));
    expect(signedTx().gasData.payment.map((p) => p.objectId)).toEqual([TIE_COIN.objectId, SEED_COIN.objectId]);
  });
});

describe("GraphQL only, when the address has no address balance", () => {
  it("reads, dry-runs, submits through GraphQL; publicnode is never asked", async () => {
    await send();
    expect(rec.rpc).toEqual([]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(gqlKinds()).toEqual(["state", "simulate", "execute"]);
    expect(new Set(rec.gql.map((g) => g.url))).toEqual(new Set([GRAPHQL]));
    // One read: the gas price, both halves of the balance, a page of coins.
    const state = rec.gql[0];
    expect(state.variables).toEqual({ address: ME });
    expect(state.query).toContain("epoch { referenceGasPrice }");
    expect(state.query).toContain('balance(coinType: "0x2::sui::SUI") { coinBalance addressBalance }');
    expect(state.query).toContain('objects(first: 50, filter: { type: "0x2::coin::Coin<0x2::sui::SUI>" })');
  });

  it("submits the signed bytes with a signature that verifies for them and for this address", async () => {
    await send();
    const ex = rec.gql.find(({ query }) => query.includes("executeTransaction"))!;
    expect(ex.variables.tx).toBe(rec.signed[0]);
    expect(ex.variables.signatures).toHaveLength(1);
    const key = await verifyTransactionSignature(Buffer.from(ex.variables.tx, "base64"), ex.variables.signatures[0], {
      address: ME,
    });
    expect(key.toSuiAddress()).toBe(ME);
  });

  it("the transfer: the amount, the recipient, the largest coins first, the gas price", async () => {
    await send({ amount: " 1.5 ", to: `  0X${"AB".repeat(32)} ` });
    const tx = signedTx();
    expect(tx.sender).toBe(ME);
    const [amount, recipient] = tx.kind.ProgrammableTransaction!.inputs;
    expect(bcs.u64().parse(Buffer.from(amount.Pure!.bytes, "base64"))).toBe("1500000000");
    // Trimmed and lowercased (2026-09-29 audit).
    expect(bcs.Address.parse(Buffer.from(recipient.Pure!.bytes, "base64"))).toBe(TO);
    expect(tx.gasData.payment.map((p) => [p.objectId, p.version])).toEqual([
      [BIG_COIN.objectId, "5"],
      [TIE_COIN.objectId, "1000"],
      [SEED_COIN.objectId, "872783653"],
    ]);
    expect(tx.gasData.price).toBe("100");
    expect(tx.gasData.owner).toBe(ME);
    // 100,000 + 1,000 x 100 + 1,976,000 - 0, as the resolver computes it.
    expect(tx.gasData.budget).toBe("2176000");
  });

  it("a dry run that fails is refused before signing", async () => {
    chain.simulate = "fail";
    await expect(send()).rejects.toThrow(
      /Dry run failed, could not automatically determine a budget: InsufficientCoinBalance/,
    );
    expect(rec.signed).toEqual([]);
    expect(gqlKinds()).not.toContain("execute");
  });

  it("no coins and no address balance: refused before signing", async () => {
    chain.coins = [];
    await expect(send()).rejects.toThrow(/no SUI to pay the network fee\. Nothing was sent/);
    expect(rec.signed).toEqual([]);
  });

  it("GraphQL unreachable: refused before anything is built or signed", async () => {
    chain.graphql = "down";
    await expect(send()).rejects.toThrow(/Sui could not be read to prepare the transfer \(.*503.*\)\. Nothing was sent/);
    expect(rec.signed).toEqual([]);
    expect(rec.rpc).toEqual([]);
  });
});

describe("an address balance (no coin object; on mainnet since release 1.72)", () => {
  beforeEach(() => {
    chain.addressBalance = RESERVATION.balance;
  });

  it("is spent the old way while publicnode's JSON-RPC answers: its coin reservation pays", async () => {
    const before = await oldBuild(TO, 1_500_000_000n);
    rec.rpc = [];
    await send();
    expect(rec.signed[0]).toBe(Buffer.from(before.bytes).toString("base64"));
    expect(signedTx().gasData.payment.map((p) => p.objectId)).toEqual([
      BIG_COIN.objectId,
      RESERVATION.objectId,
      TIE_COIN.objectId,
      SEED_COIN.objectId,
    ]);
    expect(rec.rpc.map((r) => r.method)).toEqual([
      "suix_getReferenceGasPrice",
      "sui_dryRunTransactionBlock",
      "suix_getCoins",
    ]);
    // Submitted through GraphQL all the same.
    expect(gqlKinds()).toEqual(["state", "execute"]);
  });

  it("JSON-RPC gone, coins enough: built from the coins alone", async () => {
    chain.jsonRpc = "gone";
    await send();
    expect(signedTx().gasData.payment.map((p) => p.objectId)).toEqual([
      BIG_COIN.objectId,
      TIE_COIN.objectId,
      SEED_COIN.objectId,
    ]);
    expect(gqlKinds()).toEqual(["state", "simulate", "execute"]);
  });

  it("JSON-RPC gone, coins short: refused before signing, saying where the SUI is", async () => {
    chain.jsonRpc = "gone";
    // 3 SUI in coins: 3.5 SUI and the gas do not fit.
    const err = await send({ amount: "3.5" }).catch((e) => e);
    expect(err.message).toMatch(
      /^3 SUI of this wallet is held as a Sui address balance\. This wallet can spend it only through Sui's JSON-RPC, which did not work \(.*Method not found.*\)\. Its coin objects hold 3 SUI, which has to cover the amount and the network fee\. Nothing was sent\.$/,
    );
    expect(rec.signed).toEqual([]);
  });

  it("JSON-RPC gone and no coins at all: refused before signing", async () => {
    chain.jsonRpc = "gone";
    chain.coins = [];
    await expect(send({ amount: "1" })).rejects.toThrow(/held as a Sui address balance[\s\S]*hold 0 SUI/);
    expect(rec.signed).toEqual([]);
  });
});

describe("the send-safety rules of 2026-09-29 still hold", () => {
  it.each([
    ["0x" + "ab".repeat(20), /Ethereum address/],
    ["0x" + "a".repeat(63), /has 63/],
    ["0x2", /has 1/],
    ["ab".repeat(32), /starts with 0x/],
    ["0x" + "zz".repeat(32), /not a Sui address/],
  ])("refuses %s before anything is read", async (to, why) => {
    await expect(send({ to })).rejects.toThrow(why);
    expect(rec.gql).toEqual([]);
    expect(rec.signed).toEqual([]);
  });

  it("refuses a wallet whose address is not the session's, before anything is read", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string, args: any) =>
      cmd === "swap_get_sui_address" ? "0x" + "cd".repeat(32) : fakeInvoke(cmd, args)) as any);
    await expect(send()).rejects.toThrow(/isn't supported yet/);
    expect(rec.gql).toEqual([]);
    expect(rec.signed).toEqual([]);
  });

  it("a signature from another key is not submitted", async () => {
    chain.signWith = "other";
    await expect(send()).rejects.toThrow(/isn't supported yet/);
    expect(gqlKinds()).not.toContain("execute");
  });
});

describe("an uncertain submit is settled by digest, through GraphQL", () => {
  it("a submit that does not answer, found run: sent", async () => {
    chain.execute = "unreachable";
    chain.effects = "success";
    const r = await send();
    expect(r.txHash).toBe(TransactionDataBuilder.getDigestFromBytes(Buffer.from(rec.signed[0], "base64")));
    const look = rec.gql.find(({ query }) => query.includes("transactionEffects"))!;
    expect(look.variables).toEqual({ digest: r.txHash });
    expect(rec.signed).toHaveLength(1);
  });

  it("never found: an unknown outcome with the digest, never 'failed'", async () => {
    chain.execute = "unreachable";
    chain.effects = "missing";
    const err = await send().catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
    expect(err.hash).toBe(TransactionDataBuilder.getDigestFromBytes(Buffer.from(rec.signed[0], "base64")));
    expect(err.message).toMatch(/HTTP 502/);
  });

  it("the lookup itself unreachable: unknown too", async () => {
    chain.execute = "unreachable";
    chain.effects = "unreachable";
    expect(isSendOutcomeUnknown(await send().catch((e) => e))).toBe(true);
  });

  it("found failed: the gas was spent, the amount was not sent", async () => {
    chain.execute = "unreachable";
    chain.effects = "failure";
    await expect(send()).rejects.toThrow(/Sui ran the transaction and it failed \(InsufficientGas\)\. The gas fee was spent/);
  });

  it("executeTransaction answers FAILURE: said at once, with the digest; nothing is looked up", async () => {
    chain.execute = "fail";
    const err = await send().catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(err.message).toMatch(/failed \(InsufficientCoinBalance in command 0\)[\s\S]*Digest: \w+/);
    expect(gqlKinds()).not.toContain("effects");
  });

  it("an answer that names no outcome is looked up, not taken as sent", async () => {
    chain.execute = "no-outcome";
    chain.effects = "success";
    await send();
    expect(gqlKinds()).toEqual(["state", "simulate", "execute", "effects"]);
  });

  it("the digest reported is the hash of the signed bytes, whatever the answer says", async () => {
    chain.execute = { digest: "NotTheDigestOfTheseBytes1111111111111111111" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await send();
    expect(r.txHash).toBe(TransactionDataBuilder.getDigestFromBytes(Buffer.from(rec.signed[0], "base64")));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NotTheDigestOfTheseBytes"));
    warn.mockRestore();
  });
});
