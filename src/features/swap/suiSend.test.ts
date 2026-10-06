/**
 * The Sui send on `@mysten/sui` 2.x (operator request; the upgrade approved
 * 2026-10-06): SUI held as an ADDRESS BALANCE (no coin object; on mainnet
 * since release 1.72, May 2026) is spendable, and nothing asks publicnode's
 * JSON-RPC any more.
 *
 * Until then (base `522503b`) the wallet built with 1.45.2. An address
 * balance could be spent only through JSON-RPC's compatibility coin
 * reservation, on publicnode, and was refused before signing once that host
 * failed; Sui is removing JSON-RPC from full nodes. On the bare upgrade every
 * Sui send failed before signing: 2.x will not build the dry run's empty gas
 * payment offline without an expiration ("No sui client passed to
 * Transaction#build, but transaction data was not sufficient to build
 * offline.").
 *
 * What these tests hold:
 *  - an account whose SUI is all in coin objects signs the bytes 1.45.2
 *    signed from the same chain state, and dry-runs the same bytes;
 *  - an address balance pays: a `FundsWithdrawal` redeemed by
 *    `0x2::coin::redeem_funds`, gas from the address balance, a `ValidDuring`
 *    expiration; with coins as well, the coins first, then the address
 *    balance alone, then both (the coins paying the gas, the address balance
 *    topping them up); each transaction decoded and checked;
 *  - the refusals before signing, which say where the SUI is;
 *  - the Rust signer's scheme signs 2.x's bytes exactly as the SDK's own
 *    ed25519 signer does;
 *  - the send-safety rules of 2026-09-29: recipient and key checks before
 *    anything is read, sign once, settle an uncertain submit by digest.
 *
 * The 1.45.2 bytes below were made by the old test's `oldBuild` (base
 * `suiSend.test.ts:262-272`: the 1.x SDK's own JSON-RPC resolver against
 * that test's fake publicnode), run on 2026-10-06 with 1.45.2 installed
 * outside the repo (`gen-v1-reference.mjs`, kept with the session's fix log).
 * The fake chain states are the old test's.
 *
 * Fakes: the Rust commands (the signer is emulated exactly as `swap/sui.rs`
 * signs: BLAKE2b-256 of intent [0,0,0] || bytes, ed25519 with the public
 * abandon seed's Sui key) and the proxy's GraphQL answers, in the layouts a
 * live, read-only request returned for the public test seed (2026-10-01 and
 * 2026-10-06: its address, its coin 0xb3103ee5… as it stood before its send
 * of 2026-05-11, a dry run of a transfer from it, the chain id, epoch 1272).
 * The fake dry run refuses a withdrawal larger than the address balance with
 * the words mainnet used that day. Other ids and digests are invented.
 * `fetch` fails every call: nothing here may reach a network directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { toBase58 } from "@mysten/sui/utils";
import { messageWithIntent } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { verifyTransactionSignature } from "@mysten/sui/verify";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));

import { invoke } from "../../lib/tauri";
import { SESSION_SEND_TIMING, executeSuiTransfer } from "./session-send";
import { suiAdapter } from "../../wallets/sui-wallet";
import { isSendOutcomeUnknown } from "../../wallets/send-outcome";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const me = suiAdapter.deriveFromMnemonic(ABANDON);
const ME = me.address; // 0x5e93a736d04f…61f1
const MY_SECRET = Uint8Array.from(Buffer.from(me.privateKey, "hex"));
const OTHER_SECRET = new Uint8Array(32).fill(7);
const TO = "0x" + "ab".repeat(32);
const GRAPHQL = "https://graphql.mainnet.sui.io/graphql";
/** Mainnet's chain id, as `chainIdentifier` answered live on 2026-10-06. */
const MAINNET = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
const SUI_FULL = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const FRAMEWORK = "0x0000000000000000000000000000000000000000000000000000000000000002";

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
 * What 1.45.2 built from the old test's chain states (see the header):
 * `live` is the live gas with SEED, TIE and BIG paying 1.5 SUI; `rebate` a
 * dry run whose rebate exceeds its storage; `tie` TIE and SEED paying 0.1.
 */
const V1_BUILT = {
  live: {
    bytes:
      "AAACAAgAL2hZAAAAAAAgq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6sCAgABAQAAAQEDAAAAAAEBAF6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxA///////////////////////////////////////////BQAAAAAAAAAgCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkREREREREREREREREREREREREREREREREREREREREREegDAAAAAAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHsxA+5Ws+Cuo8PblAPj8GL1EwJryL8/rFPHg+pXGj7xUlnwU0AAAAACA00GAXvk4hn1vkt8jRdS9tfeRA4wiPS87dvZki5FbptV6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxZAAAAAAAAAAANCEAAAAAAAA=",
    dryRun:
      "AAACAAgAL2hZAAAAAAAgq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6sCAgABAQAAAQEDAAAAAAEBAF6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxAF6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxZAAAAAAAAAAAdDukCwAAAAA=",
    digest: "2qcLe7Y3Yw293k11pAwvDPVdEUDXM1D7qc8inFuU5vue",
  },
  rebate: {
    bytes:
      "AAACAAgAL2hZAAAAAAAgq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6sCAgABAQAAAQEDAAAAAAEBAF6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxA///////////////////////////////////////////BQAAAAAAAAAgCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkREREREREREREREREREREREREREREREREREREREREREegDAAAAAAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHsxA+5Ws+Cuo8PblAPj8GL1EwJryL8/rFPHg+pXGj7xUlnwU0AAAAACA00GAXvk4hn1vkt8jRdS9tfeRA4wiPS87dvZki5FbptV6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxZAAAAAAAAABQ+AwAAAAAAAA=",
    dryRun:
      "AAACAAgAL2hZAAAAAAAgq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6sCAgABAQAAAQEDAAAAAAEBAF6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxAF6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxZAAAAAAAAAAAdDukCwAAAAA=",
    digest: "9CLdaQJGCg9A35SJ1BfL6fabq26yMgs3Q6RqHovwEarB",
  },
  tie: {
    bytes:
      "AAACAAgA4fUFAAAAAAAgq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6sCAgABAQAAAQEDAAAAAAEBAF6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxAhERERERERERERERERERERERERERERERERERERERERER6AMAAAAAAAAgBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwezED7laz4K6jw9uUA+PwYvUTAmvIvz+sU8eD6lcaPvFSWfBTQAAAAAIDTQYBe+TiGfW+S3yNF1L2195EDjCI9Lzt29mSLkVum1XpOnNtBPuyVzeqQL7kAXHvefZfroM3SePAif58whYfFkAAAAAAAAAAA0IQAAAAAAAA==",
    dryRun:
      "AAACAAgA4fUFAAAAAAAgq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6sCAgABAQAAAQEDAAAAAAEBAF6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxAF6TpzbQT7slc3qkC+5AFx73n2X66DN0njwIn+fMIWHxZAAAAAAAAAAAdDukCwAAAAA=",
    digest: "B5YyKsJjkfMJC5KjT96cM2hruqFwXGTgiL2jWrTLCkxk",
  },
};

interface Chain {
  price: string;
  epoch: number;
  /** The dry run's gas, as `simulateTransaction` reported it live (UInt53 numbers). */
  dry: { computationCost: number; storageCost: number; storageRebate: number };
  coins: Coin[];
  addressBalance: string;
  /**
   * What the address balance is when the dry run reaches the network, if it
   * moved since the state read.
   */
  addressBalanceAtDryRun?: string;
  /** SUI in coins past the one page the state read lists. */
  coinsBeyondPage?: string;
  graphql: "up" | "down";
  simulate: "ok" | "fail";
  execute: "ok" | "fail" | "unreachable" | "no-outcome" | { digest: string };
  effects: "success" | "failure" | "missing" | "unreachable";
  signWith: "mine" | "other";
}
let chain: Chain;

const rec = {
  gql: [] as Array<{ url: string; query: string; variables: any }>,
  signed: [] as string[],
};

/** 2,176,000 MIST: the budget the live gas gives at a price of 100. */
const LIVE_BUDGET = 100_000n + 1_000n * 100n + 1_976_000n;

/** A GraphQL error, in the layout mainnet answered a refused dry run with on 2026-10-06. */
const gqlError = (message: string) => ({
  status: 200,
  body: JSON.stringify({
    data: null,
    errors: [{ message, locations: [{ line: 2, column: 3 }], path: ["simulateTransaction"], extensions: { code: "BAD_USER_INPUT" } }],
  }),
  headers: [],
});

/** The proxy's GraphQL answers (graphql.mainnet.sui.io). */
function graphql(args: { url: string; body: string }) {
  const { query, variables } = JSON.parse(args.body);
  rec.gql.push({ url: args.url, query, variables });
  if (chain.graphql === "down") return { status: 503, body: "unavailable", headers: [] };
  const data = (d: unknown) => ({ status: 200, body: JSON.stringify({ data: d }), headers: [] });
  if (query.includes("simulateTransaction")) {
    // Mainnet checks a withdrawal against the address balance before running
    // anything (live, the test seed, 2026-10-06).
    const tx = bcs.TransactionData.parse(Buffer.from(variables.tx.bcs.value, "base64")).V1!;
    const available = BigInt(chain.addressBalanceAtDryRun ?? chain.addressBalance);
    for (const input of tx.kind.ProgrammableTransaction!.inputs) {
      const want = input.FundsWithdrawal ? BigInt(input.FundsWithdrawal.reservation.MaxAmountU64!) : null;
      if (want === 0n) {
        return gqlError(
          "Invalid argument: Error checking transaction input objects: Invalid withdraw reservation: Balance withdraw reservation amount must be non-zero",
        );
      }
      if (want !== null && want > available) {
        return gqlError(
          `Invalid argument: Error checking transaction input objects: Invalid withdraw reservation: Insufficient address balance of coin type 0x2::sui::SUI for address ${tx.sender}: the transaction requires ${want} but only ${available} is available. Note that the address balance does not include funds held in Coin objects owned by the address; to spend those funds, use the Coin objects directly as transaction inputs.`,
        );
      }
    }
    return data({
      simulateTransaction: {
        effects:
          chain.simulate === "ok"
            ? { status: "SUCCESS", executionError: null, gasEffects: { gasSummary: chain.dry } }
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
    const listed = chain.coins.reduce((s, c) => s + BigInt(c.balance), 0n);
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
      chainIdentifier: MAINNET,
      epoch: { epochId: chain.epoch, referenceGasPrice: chain.price },
      address: {
        balance: {
          coinBalance: String(listed + BigInt(chain.coinsBeyondPage ?? "0")),
          addressBalance: chain.addressBalance,
        },
        objects: { nodes },
      },
    });
  }
  throw new Error(`unscripted GraphQL ${query.slice(0, 80)}`);
}

/** `swap/sui.rs::sign_tx`: BLAKE2b-256 of the intent [0,0,0] and the bytes, ed25519; flag || sig || key. */
function rustSign(txBytesBase64: string, secret: Uint8Array) {
  const pub = ed25519.getPublicKey(secret);
  const tx = Buffer.from(txBytesBase64, "base64");
  const digest = blake2b(Buffer.concat([Buffer.from([0, 0, 0]), tx]), { dkLen: 32 });
  const sig = ed25519.sign(digest, secret);
  return {
    signatureBase64: Buffer.from([0, ...sig, ...pub]).toString("base64"),
    publicKeyBase64: Buffer.from(pub).toString("base64"),
  };
}

/** The Rust core: the session's address, and the signer. */
async function fakeInvoke(cmd: string, args: any): Promise<unknown> {
  switch (cmd) {
    case "http_proxy_call":
      return graphql(args);
    case "swap_get_sui_address":
      return ME;
    case "swap_sign_sui_tx":
      rec.signed.push(args.input.txBytesBase64);
      return rustSign(args.input.txBytesBase64, chain.signWith === "mine" ? MY_SECRET : OTHER_SECRET);
    default:
      throw new Error(`unscripted invoke ${cmd}`);
  }
}

const send = (over: Partial<Parameters<typeof executeSuiTransfer>[0]> = {}) =>
  executeSuiTransfer({ sessionId: "s", fromAddress: ME, to: TO, amount: "1.5", ...over });

/** The decoded transaction, without the decoder's `$kind` tags. */
const decode = (b64: string) => {
  const v1 = bcs.TransactionData.parse(Buffer.from(b64, "base64")).V1!;
  return JSON.parse(JSON.stringify(v1, (k, v) => (k === "$kind" ? undefined : v)));
};
/** What was handed to the signer, decoded. */
const signedTx = (i = 0) => decode(rec.signed[i]);
/** The dry runs' bytes, base64, in the order they were asked. */
const dryRuns = () => rec.gql.filter(({ query }) => query.includes("simulateTransaction")).map((g) => g.variables.tx.bcs.value as string);
const u64 = (b64: string) => bcs.u64().parse(Buffer.from(b64, "base64"));
const address = (b64: string) => bcs.Address.parse(Buffer.from(b64, "base64"));
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
const coinRef = (c: Coin) => ({ objectId: c.objectId, version: String(c.version), digest: c.digest });
/** The `redeem_funds` call that turns a withdrawal into a coin. */
const redeemFunds = (input: number) => ({
  MoveCall: {
    package: FRAMEWORK,
    module: "coin",
    function: "redeem_funds",
    typeArguments: [SUI_FULL],
    arguments: [{ Input: input }],
  },
});
const withdrawal = (mist: bigint) => ({
  FundsWithdrawal: {
    reservation: { MaxAmountU64: String(mist) },
    typeArg: { Balance: SUI_FULL },
    withdrawFrom: { Sender: true },
  },
});

const savedTiming = { ...SESSION_SEND_TIMING };
beforeEach(() => {
  chain = {
    price: "100",
    epoch: 1272,
    dry: { computationCost: 100000, storageCost: 1976000, storageRebate: 0 },
    coins: [SEED_COIN, TIE_COIN, BIG_COIN],
    addressBalance: "0",
    graphql: "up",
    simulate: "ok",
    execute: "ok",
    effects: "missing",
    signWith: "mine",
  };
  rec.gql = [];
  rec.signed = [];
  Object.assign(SESSION_SEND_TIMING, { pollMs: 2, suiLookupMs: 30 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      throw new Error(`no direct network call expected: ${String(input)}`);
    }),
  );
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(fakeInvoke as any);
});
afterEach(() => {
  Object.assign(SESSION_SEND_TIMING, savedTiming);
  vi.unstubAllGlobals();
});

describe("an account whose SUI is all in coin objects: the bytes 1.45.2 signed (2026-10-06)", () => {
  it.each([
    ["the live gas", "live", () => {}, "1.5"],
    ["a rebate larger than the storage cost (the budget's other branch)", "rebate", () => {
      chain.dry = { computationCost: 750000, storageCost: 988000, storageRebate: 1978120 };
    }, "1.5"],
    ["two coins of the same balance: the object id orders them", "tie", () => {
      chain.coins = [TIE_COIN, SEED_COIN];
    }, "0.1"],
  ] as const)("%s", async (_name, key, setUp, amount) => {
    setUp();
    const r = await send({ amount });
    expect(rec.signed).toEqual([V1_BUILT[key].bytes]);
    // The dry run is the same transaction too.
    expect(dryRuns()).toEqual([V1_BUILT[key].dryRun]);
    expect(r.txHash).toBe(V1_BUILT[key].digest);
  });

  it("the transfer, decoded: the amount, the recipient, the largest coins first, no expiration", async () => {
    await send({ amount: " 1.5 ", to: `  0X${"AB".repeat(32)} ` });
    const tx = signedTx();
    expect(tx.sender).toBe(ME);
    const { inputs, commands } = tx.kind.ProgrammableTransaction;
    expect(inputs).toHaveLength(2);
    expect(u64(inputs[0].Pure.bytes)).toBe("1500000000");
    // Trimmed and lowercased (2026-09-29 audit).
    expect(address(inputs[1].Pure.bytes)).toBe(TO);
    expect(commands).toEqual([
      { SplitCoins: { coin: { GasCoin: true }, amounts: [{ Input: 0 }] } },
      { TransferObjects: { objects: [{ NestedResult: [0, 0] }], address: { Input: 1 } } },
    ]);
    expect(tx.gasData).toEqual({
      payment: [coinRef(BIG_COIN), coinRef(TIE_COIN), coinRef(SEED_COIN)],
      owner: ME,
      price: "100",
      // 100,000 + 1,000 x 100 + 1,976,000 - 0, as the resolver computes it.
      budget: String(LIVE_BUDGET),
    });
    expect(tx.expiration).toEqual({ None: true });
  });

  it("an address balance beside coins that cover the transfer is left alone: the same bytes", async () => {
    chain.addressBalance = "3000000000";
    await send();
    // Before 2026-10-06 an address balance sent the build to publicnode's
    // JSON-RPC, whose compatibility reservation joined the gas payment.
    expect(rec.signed).toEqual([V1_BUILT.live.bytes]);
    expect(dryRuns()).toEqual([V1_BUILT.live.dryRun]);
  });
});

describe("an address balance and no coin object (2026-10-06)", () => {
  beforeEach(() => {
    chain.coins = [];
    chain.addressBalance = "3000000000";
  });

  it("is spent: a withdrawal redeemed into a coin, the gas from the address balance, a ValidDuring expiration", async () => {
    const r = await send();
    expect(rec.signed).toHaveLength(1);
    const tx = signedTx();
    expect(tx.sender).toBe(ME);
    const { inputs, commands } = tx.kind.ProgrammableTransaction;
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toEqual(withdrawal(1_500_000_000n));
    expect(address(inputs[1].Pure.bytes)).toBe(TO);
    expect(commands).toEqual([
      redeemFunds(0),
      { TransferObjects: { objects: [{ NestedResult: [0, 0] }], address: { Input: 1 } } },
    ]);
    // No gas coins: the address balance pays.
    expect(tx.gasData).toEqual({ payment: [], owner: ME, price: "100", budget: String(LIVE_BUDGET) });
    const { nonce, ...validDuring } = tx.expiration.ValidDuring;
    expect(validDuring).toEqual({ minEpoch: "1272", maxEpoch: "1273", minTimestamp: null, maxTimestamp: null, chain: MAINNET });
    expect(Number.isInteger(nonce) && nonce >= 0 && nonce <= 0xffffffff).toBe(true);
    expect(r.txHash).toBe(TransactionDataBuilder.getDigestFromBytes(Buffer.from(rec.signed[0], "base64")));
    // One read, one dry run, one submit; nothing to publicnode.
    expect(gqlKinds()).toEqual(["state", "simulate", "execute"]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("the dry run is the same transaction at the 50 SUI budget, nonce and all", async () => {
    await send();
    const [dry] = dryRuns();
    const priced = decode(dry);
    const signed = signedTx();
    expect(priced.gasData.budget).toBe("50000000000");
    expect({ ...priced, gasData: { ...priced.gasData, budget: signed.gasData.budget } }).toEqual(signed);
  });

  it("covers the amount and the gas to the MIST: sent", async () => {
    chain.addressBalance = String(1_500_000_000n + LIVE_BUDGET);
    await send();
    expect(rec.signed).toHaveLength(1);
    expect(signedTx().kind.ProgrammableTransaction.inputs[0]).toEqual(withdrawal(1_500_000_000n));
  });

  it("one MIST short: refused before signing, saying where the SUI is", async () => {
    chain.addressBalance = String(1_500_000_000n + LIVE_BUDGET - 1n);
    const err = await send().catch((e) => e);
    expect(err.message).toBe(
      "This Sui account holds 1.502175999 SUI (0 in coin objects, 1.502175999 in its address balance), not enough " +
        "to send 1.5 SUI and pay the network fee (up to 0.002176 SUI). Nothing was sent.",
    );
    expect(rec.signed).toEqual([]);
    expect(gqlKinds()).not.toContain("execute");
  });

  it("each transfer draws its own nonce", async () => {
    await send();
    await send();
    const [a, b] = [signedTx(0), signedTx(1)];
    expect(a.expiration.ValidDuring.nonce).not.toBe(b.expiration.ValidDuring.nonce);
  });

  it("a dry run Sui refuses (the address balance moved since it was read): refused before signing", async () => {
    chain.addressBalanceAtDryRun = "1000000000";
    await expect(send()).rejects.toThrow(/Insufficient address balance of coin type 0x2::sui::SUI/);
    expect(rec.signed).toEqual([]);
  });
});

describe("coins and an address balance (2026-10-06)", () => {
  it("the coins short, the address balance enough alone: paid from the address balance, no coin touched", async () => {
    chain.coins = [SEED_COIN]; // 0.5 SUI
    chain.addressBalance = "3000000000";
    await send();
    const tx = signedTx();
    expect(tx.kind.ProgrammableTransaction.inputs[0]).toEqual(withdrawal(1_500_000_000n));
    expect(tx.kind.ProgrammableTransaction.inputs.some((i: any) => i.Object)).toBe(false);
    expect(tx.gasData.payment).toEqual([]);
    expect(tx.expiration.ValidDuring.chain).toBe(MAINNET);
    // The coins were not priced: 0.5 SUI cannot carry 1.5.
    expect(gqlKinds()).toEqual(["state", "simulate", "execute"]);
  });

  it("neither alone, both together: the coins pay the gas, the address balance tops them up by what they lack", async () => {
    // 3 SUI in coins, 1 SUI in the address balance, 3.5 SUI sent.
    chain.addressBalance = "1000000000";
    await send({ amount: "3.5" });
    const tx = signedTx();
    const { inputs, commands } = tx.kind.ProgrammableTransaction;
    // 3.5 SUI + the budget - the 3 SUI the coins hold.
    expect(inputs[0]).toEqual(withdrawal(3_500_000_000n + LIVE_BUDGET - 3_000_000_000n));
    expect(u64(inputs[1].Pure.bytes)).toBe("3500000000");
    expect(address(inputs[2].Pure.bytes)).toBe(TO);
    expect(commands).toEqual([
      redeemFunds(0),
      { MergeCoins: { destination: { GasCoin: true }, sources: [{ NestedResult: [0, 0] }] } },
      { SplitCoins: { coin: { GasCoin: true }, amounts: [{ Input: 1 }] } },
      { TransferObjects: { objects: [{ NestedResult: [2, 0] }], address: { Input: 2 } } },
    ]);
    expect(tx.gasData).toEqual({
      payment: [coinRef(BIG_COIN), coinRef(TIE_COIN), coinRef(SEED_COIN)],
      owner: ME,
      price: "100",
      budget: String(LIVE_BUDGET),
    });
    // The gas coins' versions protect it from a replay.
    expect(tx.expiration).toEqual({ None: true });
    // Its dry run withdrew what it could (the budget unknown yet), with no gas coins.
    const priced = decode(dryRuns()[0]);
    expect(priced.kind.ProgrammableTransaction.inputs[0]).toEqual(withdrawal(1_000_000_000n));
    expect(priced.gasData).toMatchObject({ payment: [], budget: "50000000000" });
    expect(priced.kind.ProgrammableTransaction.commands).toEqual(commands);
  });

  it("tried in order, each priced by its own dry run: the coins, the address balance, then both", async () => {
    // Each side holds the amount but not the gas on top; together they do.
    chain.coins = [{ ...BIG_COIN, balance: "1501000000" }];
    chain.addressBalance = "1501000000";
    await send();
    expect(gqlKinds()).toEqual(["state", "simulate", "simulate", "simulate", "execute"]);
    const [coins, balance, both] = dryRuns().map(decode);
    expect(coins.kind.ProgrammableTransaction.commands[0]).toHaveProperty("SplitCoins");
    expect(balance.gasData.payment).toEqual([]);
    expect(balance.expiration).toHaveProperty("ValidDuring");
    expect(both.kind.ProgrammableTransaction.commands[1]).toHaveProperty("MergeCoins");
    expect(signedTx().kind.ProgrammableTransaction.inputs[0]).toEqual(
      withdrawal(1_500_000_000n + LIVE_BUDGET - 1_501_000_000n),
    );
  });

  it("the fee fits neither side alone: refused before signing, with the most that can be sent", async () => {
    // 1.501 SUI covers 1.498 SUI and the gas, but a 0.001 SUI coin cannot
    // carry the gas and the address balance cannot carry 1.498 SUI and the gas.
    chain.coins = [{ ...SEED_COIN, balance: "1000000" }];
    chain.addressBalance = "1500000000";
    const err = await send({ amount: "1.498" }).catch((e) => e);
    expect(err.message).toBe(
      "This Sui account holds 1.501 SUI (0.001 in coin objects, 1.5 in its address balance). The network fee " +
        "(up to 0.002176 SUI) is paid from its coin objects or from its address balance, and with this amount " +
        "neither can pay it. You can send at most 1.497824 SUI. Nothing was sent.",
    );
    expect(rec.signed).toEqual([]);
  });

  it("not enough in all: refused before anything is priced, saying where the SUI is", async () => {
    chain.coins = [SEED_COIN];
    chain.addressBalance = "500000000";
    const err = await send().catch((e) => e);
    expect(err.message).toBe(
      "This Sui account holds 1 SUI (0.5 in coin objects, 0.5 in its address balance), not enough to send 1.5 SUI " +
        "and pay the network fee. Nothing was sent.",
    );
    expect(gqlKinds()).toEqual(["state"]);
    expect(rec.signed).toEqual([]);
  });

  it("coins that cover the amount but not the gas, and no address balance: refused, no longer signed to fail", async () => {
    // Before 2026-10-06 this was signed and submitted. Its split of 2.999 SUI
    // from a 3 SUI gas coin would fail on chain, the gas spent (inference:
    // Sui sets the budget aside in the gas coin before the commands run).
    const err = await send({ amount: "2.999" }).catch((e) => e);
    expect(err.message).toBe(
      "This Sui account holds 3 SUI, not enough to send 2.999 SUI and pay the network fee (up to 0.002176 SUI). " +
        "Nothing was sent.",
    );
    expect(rec.signed).toEqual([]);
  });

  it("more SUI than one page of coins holds: refused, saying a transfer spends at most 50 coin objects", async () => {
    chain.coinsBeyondPage = "2000000000";
    const err = await send({ amount: "3.5" }).catch((e) => e);
    expect(err.message).toBe(
      "This Sui account holds 5 SUI, but one transfer can spend at most 50 of its coin objects, which hold 3 SUI " +
        "here: not enough to send 3.5 SUI and pay the network fee. Send a smaller amount. Nothing was sent.",
    );
    expect(rec.signed).toEqual([]);
  });
});

describe("GraphQL only: nothing goes to publicnode or anywhere else directly", () => {
  it.each([
    ["coins", () => {}],
    ["the address balance", () => {
      chain.coins = [];
      chain.addressBalance = "3000000000";
    }],
    ["both", () => {
      chain.addressBalance = "1000000000";
    }],
  ] as const)("paid from %s: every request is the proxy's GraphQL", async (_name, setUp) => {
    setUp();
    await send({ amount: _name === "both" ? "3.5" : "1.5" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(new Set(rec.gql.map((g) => g.url))).toEqual(new Set([GRAPHQL]));
    // One read: the chain, the epoch and gas price, both halves of the balance, a page of coins.
    const state = rec.gql[0];
    expect(state.variables).toEqual({ address: ME });
    expect(state.query).toContain("chainIdentifier");
    expect(state.query).toContain("epoch { epochId referenceGasPrice }");
    expect(state.query).toContain('balance(coinType: "0x2::sui::SUI") { coinBalance addressBalance }');
    expect(state.query).toContain('objects(first: 50, filter: { type: "0x2::coin::Coin<0x2::sui::SUI>" })');
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
  });
});

describe("the Rust signer signs 2.x's bytes as the SDK does (2026-10-06)", () => {
  it.each([
    ["coins", () => {}, "1.5"],
    ["the address balance", () => {
      chain.coins = [];
      chain.addressBalance = "3000000000";
    }, "1.5"],
    ["both", () => {
      chain.addressBalance = "1000000000";
    }, "3.5"],
  ] as const)("paid from %s: the same signature as Ed25519Keypair.signTransaction, verified for this address", async (_name, setUp, amount) => {
    setUp();
    await send({ amount });
    const ex = rec.gql.find(({ query }) => query.includes("executeTransaction"))!;
    const bytes = Buffer.from(rec.signed[0], "base64");
    // Submitted exactly as signed, with one signature.
    expect(ex.variables.tx).toBe(rec.signed[0]);
    expect(ex.variables.signatures).toEqual([rustSign(rec.signed[0], MY_SECRET).signatureBase64]);
    // The intent `sui.rs` prepends is the SDK's TransactionData intent.
    expect(Buffer.from(messageWithIntent("TransactionData", bytes))).toEqual(Buffer.concat([Buffer.from([0, 0, 0]), bytes]));
    // ed25519 is deterministic: the SDK's own signer gives the same signature.
    const sdk = await Ed25519Keypair.fromSecretKey(MY_SECRET).signTransaction(bytes);
    expect(ex.variables.signatures[0]).toBe(sdk.signature);
    const key = await verifyTransactionSignature(bytes, ex.variables.signatures[0], { address: ME });
    expect(key.toSuiAddress()).toBe(ME);
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

  it("an address-balance transfer is signed once, like any other", async () => {
    chain.coins = [];
    chain.addressBalance = "3000000000";
    chain.execute = "unreachable";
    chain.effects = "missing";
    expect(isSendOutcomeUnknown(await send().catch((e) => e))).toBe(true);
    expect(rec.signed).toHaveLength(1);
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
