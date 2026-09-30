/**
 * Algorand canonical-msgpack encoder.
 *
 * These pin the RULES. They cannot prove the rules are the ones Algorand actually
 * uses — a unit test only ever proves the encoder matches my reading of the spec. The
 * authority is a node, so `scripts/verify-algo-tx.mjs` submits a real signed payment
 * from an unfunded account and checks that algod (a) decodes it, (b) verifies the
 * signature, and (c) echoes back the same transaction id we computed locally. Run that
 * after touching anything in `algo-tx.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  encodeCanonicalMap,
  addressToPublicKey,
  algoToMicro,
  encodePayTransaction,
  transactionId,
  ALGO_MIN_BALANCE_MICRO,
  sendAlgo,
} from "./algo-tx";
import { algoAddressFromPublicKey } from "./algo-wallet";
import { isSendOutcomeUnknown } from "./send-outcome";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("canonical msgpack — the three rules that silently break signatures", () => {
  it("omits zero, empty-string and empty-bytes fields entirely", () => {
    // Rule 2. Encoding `amt: 0` as an actual zero produces a transaction that
    // still submits and still fails, with no hint why — the signature covers
    // different bytes than the node hashes.
    const withZeros = encodeCanonicalMap({
      a: 0n,
      b: "",
      c: new Uint8Array(0),
      d: 1n,
    });
    const withoutZeros = encodeCanonicalMap({ d: 1n });
    expect(hex(withZeros)).toBe(hex(withoutZeros));
    // fixmap with exactly ONE entry
    expect(withZeros[0]).toBe(0x81);
  });

  it("sorts keys byte-wise, not in insertion order", () => {
    const a = encodeCanonicalMap({ snd: 1n, amt: 2n, fee: 3n });
    const b = encodeCanonicalMap({ fee: 3n, amt: 2n, snd: 1n });
    expect(hex(a)).toBe(hex(b));
    // "amt" must come first
    expect(hex(a).startsWith("83" + "a3" + Buffer.from("amt").toString("hex"))).toBe(true);
  });

  it("uses the shortest integer encoding for each width", () => {
    // positive fixint / uint8 / uint16 / uint32 / uint64
    expect(hex(encodeCanonicalMap({ v: 1n }))).toContain("01");
    expect(hex(encodeCanonicalMap({ v: 200n }))).toContain("ccc8");
    expect(hex(encodeCanonicalMap({ v: 1000n }))).toContain("cd03e8");
    expect(hex(encodeCanonicalMap({ v: 70000n }))).toContain("ce00011170");
    expect(hex(encodeCanonicalMap({ v: 5_000_000_000n }))).toContain("cf000000012a05f200");
  });

  it("encodes byte strings as bin and text as str", () => {
    // Rule 4 — addresses and the genesis hash are 32 RAW bytes, never base32 text.
    const asBin = encodeCanonicalMap({ k: new Uint8Array([1, 2, 3]) });
    expect(hex(asBin)).toContain("c403010203");
    const asStr = encodeCanonicalMap({ k: "pay" });
    expect(hex(asStr)).toContain("a3" + Buffer.from("pay").toString("hex"));
  });
});

describe("addresses", () => {
  // Algorand Foundation fee sink — a real mainnet address.
  const REAL = "Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA";

  it("decodes a real address to 32 bytes", () => {
    expect(addressToPublicKey(REAL).length).toBe(32);
  });

  it("rejects a wrong-length address", () => {
    expect(() => addressToPublicKey("TOOSHORT")).toThrow(/58 characters/);
  });

  it("rejects a corrupted checksum rather than sending into the void", () => {
    // Flip one character in the checksum region. Base32 keeps it decodable, so
    // only the checksum catches it — which is the entire point of having one.
    const broken = REAL.slice(0, 55) + (REAL[55] === "A" ? "B" : "A") + REAL.slice(56);
    expect(() => addressToPublicKey(broken)).toThrow(/checksum/);
  });
});

describe("amounts", () => {
  it("converts decimal ALGO to microAlgos exactly", () => {
    expect(algoToMicro("1")).toBe(1_000_000n);
    expect(algoToMicro("0.000001")).toBe(1n);
    expect(algoToMicro("14.9")).toBe(14_900_000n);
  });

  it("refuses more precision than the chain has", () => {
    expect(() => algoToMicro("1.0000001")).toThrow(/6 decimal places/);
  });

  it("refuses junk instead of coercing it to a number", () => {
    expect(() => algoToMicro("1.2.3")).toThrow(/Invalid/);
    expect(() => algoToMicro("abc")).toThrow(/Invalid/);
  });

  it("keeps precision a float would lose", () => {
    // 9007199254740993 microAlgos is 2^53+1 — not representable as a double.
    expect(algoToMicro("9007199254.740993")).toBe(9_007_199_254_740_993n);
  });
});

describe("payment transaction", () => {
  const params = {
    fee: 1000n,
    minFee: 1000n,
    firstValid: 50_000_000n,
    lastValid: 50_001_000n,
    genesisId: "mainnet-v1.0",
    genesisHash: new Uint8Array(32).fill(7),
  };
  const from = new Uint8Array(32).fill(1);
  const to = new Uint8Array(32).fill(2);

  it("produces a stable encoding for identical inputs", () => {
    const a = encodePayTransaction({ from, to, amountMicro: 100n, params });
    const b = encodePayTransaction({ from, to, amountMicro: 100n, params });
    expect(hex(a)).toBe(hex(b));
  });

  it("drops the note field when there is no note", () => {
    const withNote = encodePayTransaction({
      from, to, amountMicro: 100n, params,
      note: new TextEncoder().encode("hi"),
    });
    const without = encodePayTransaction({ from, to, amountMicro: 100n, params });
    expect(withNote.length).toBeGreaterThan(without.length);
    expect(hex(without)).not.toContain(Buffer.from("note").toString("hex"));
  });

  it("gives a different transaction id for a different amount", () => {
    const a = transactionId(encodePayTransaction({ from, to, amountMicro: 100n, params }));
    const b = transactionId(encodePayTransaction({ from, to, amountMicro: 101n, params }));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z2-7]{52}$/); // unpadded base32, 32-byte digest
  });
});

describe("minimum balance", () => {
  it("is 0.1 ALGO", () => {
    // Not cosmetic: spending into the reserve fails at the node, so `sendAlgo`
    // checks it up front and explains it rather than letting algod reject after
    // the user has confirmed.
    expect(ALGO_MIN_BALANCE_MICRO).toBe(100_000n);
  });
});

/**
 * 2026-09-29 send-safety audit: `sendAlgo` checked a hardcoded 0.1 ALGO
 * minimum, while algod reports each account's own `min-balance` (0.1 plus
 * 0.1 per asset opted into, more for apps and boxes). An account holding two
 * assets must keep 0.3 ALGO; the check let it try to spend down to 0.1.
 */
describe("sendAlgo keeps the account's own minimum balance (2026-09-29 send-safety audit)", () => {
  const seed = new Uint8Array(32).fill(9);
  const from = algoAddressFromPublicKey(ed25519.getPublicKey(seed));
  const to = algoAddressFromPublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(3)));
  let account: Record<string, unknown>;
  let submits: number;
  /** How algod answers POST /v2/transactions; the default accepts. */
  let answerSubmit: () => Response;
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

  beforeEach(() => {
    submits = 0;
    // 5 ALGO, two assets opted in: algod's own figure for the minimum.
    account = { address: from, amount: 5_000_000, "min-balance": 300_000 };
    answerSubmit = () => json({}); // no txId: the wallet reports its own
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/v2/transactions/params") {
          return json({
            "min-fee": 1000,
            fee: 0,
            "last-round": 50_000_000,
            "genesis-id": "mainnet-v1.0",
            "genesis-hash": Buffer.alloc(32, 7).toString("base64"),
          });
        }
        if (path.startsWith("/v2/accounts/")) return json(account);
        if (path === "/v2/transactions" && init?.method === "POST") {
          submits++;
          return answerSubmit();
        }
        return new Response("not scripted", { status: 500 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a send that would dip under algod's min-balance, before submitting", async () => {
    // 4.8 + 0.001 fee + 0.1 = 4.901 passed the old check; 4.8 + 0.001 + 0.3 does not fit in 5.
    await expect(sendAlgo({ privateKey: seed, fromAddress: from, to, amount: "4.8" })).rejects.toThrow(
      /must keep 0\.3 ALGO .* short by 0\.101 ALGO/,
    );
    expect(submits).toBe(0);
  });

  it("sends right up to it", async () => {
    await expect(
      sendAlgo({ privateKey: seed, fromAddress: from, to, amount: "4.699" }),
    ).resolves.toEqual({ hash: expect.stringMatching(/^[A-Z2-7]{52}$/) });
    expect(submits).toBe(1);
  });

  it("falls back to 0.1 ALGO only when algod does not report a minimum", async () => {
    delete account["min-balance"];
    await expect(sendAlgo({ privateKey: seed, fromAddress: from, to, amount: "4.95" })).rejects.toThrow(
      /must keep 0\.1 ALGO/,
    );
    await expect(sendAlgo({ privateKey: seed, fromAddress: from, to, amount: "4.8" })).resolves.toBeTruthy();
  });
  // Same class as the audit's six chains: an unanswered submission.
  it("a submission with no answer is 'may have been sent', with the transaction id", async () => {
    answerSubmit = () => {
      throw new TypeError("Failed to fetch");
    };
    const e: any = await sendAlgo({ privateKey: seed, fromAddress: from, to, amount: "1" }).catch((x) => x);
    expect(isSendOutcomeUnknown(e), String(e)).toBe(true);
    expect(e.hash).toMatch(/^[A-Z2-7]{52}$/);
  });

  it("a 5xx is 'may have been sent' too; a 4xx refusal stays an ordinary failure", async () => {
    answerSubmit = () => new Response("upstream timed out", { status: 504 });
    const unknown: any = await sendAlgo({ privateKey: seed, fromAddress: from, to, amount: "1" }).catch((x) => x);
    expect(isSendOutcomeUnknown(unknown), String(unknown)).toBe(true);

    answerSubmit = () => new Response(JSON.stringify({ message: "overspend" }), { status: 400 });
    const refused: any = await sendAlgo({ privateKey: seed, fromAddress: from, to, amount: "1" }).catch((x) => x);
    expect(isSendOutcomeUnknown(refused)).toBe(false);
    expect(refused.message).toBe("Algorand rejected the transaction: overspend");
  });
});
