/**
 * `verifyTronTransaction` against transactions TronGrid actually built
 * (2026-09-29, `createtransaction` and `triggersmartcontract`, never signed,
 * never broadcast). The attacker these tests play is the node: the one party
 * that chooses the bytes the wallet signs.
 */
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";

import { TronTxMismatchError, verifyTronTransaction } from "./tron-tx-verify";

// createtransaction: 1.234567 TRX from a funded public account to the abandon
// seed's TRON address (41 9858…da94).
const TRX_TX = {
  txID: "73b5d68411370422f9e7e89969231293894e9e7828a4d93c78f877a7a3f7649a",
  raw_data_hex:
    "0a02bb6e2208c57d351194bd00b940f8cfdbff8e345a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541320c3166e1162250bef6595f2c52cc0f2be78ecc1215419858effd232b4033e47d90003d41ec34ecaeda941887ad4b70908ed8ff8e34",
};
const TRX_EXPECTED = {
  kind: "trx" as const,
  ownerHex: "41320c3166e1162250bef6595f2c52cc0f2be78ecc",
  toHex: "419858effd232b4033e47d90003d41ec34ecaeda94",
  amountSun: 1_234_567n,
};

// triggersmartcontract: USDT transfer(1.234567) from the abandon seed's TRON
// address to an arbitrary account id (41 cbc9…1c79 — typed into the request,
// not derived from anything), fee limit 100 TRX.
const USDT_TX = {
  txID: "efe5cd71c441ce4d56c10a2b926919b48ce15f1edbc3de923e5e4febcb4f91ca",
  raw_data_hex:
    "0a02bb66220896b95c21f21f646840b894daff8e345aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a15419858effd232b4033e47d90003d41ec34ecaeda94121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb000000000000000000000000cbc9f1a9e6da62d2fd6283aa51f4dea2c0fc1c79000000000000000000000000000000000000000000000000000000000012d68770f7c6d6ff8e34900180c2d72f",
};
const USDT_DATA =
  "a9059cbb000000000000000000000000cbc9f1a9e6da62d2fd6283aa51f4dea2c0fc1c79000000000000000000000000000000000000000000000000000000000012d687";
const USDT_EXPECTED = {
  kind: "trc20" as const,
  ownerHex: "419858effd232b4033e47d90003d41ec34ecaeda94",
  contractHex: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
  data: USDT_DATA,
  maxFeeLimitSun: 100_000_000n,
};

/** A node that re-hashes its own forgery: self-consistent, different payee. */
function forged(raw: string, from: string, to: string) {
  const forgedRaw = raw.replace(from, to);
  expect(forgedRaw).not.toBe(raw);
  return { raw_data_hex: forgedRaw, txID: ethers.sha256("0x" + forgedRaw).slice(2) };
}

const ATTACKER = "41" + "ab".repeat(20);

describe("a native TRX transfer", () => {
  it("passes when it is exactly the transfer requested", () => {
    expect(() => verifyTronTransaction(TRX_TX, TRX_EXPECTED)).not.toThrow();
  });

  it("rejects a self-consistent forgery paying someone else", () => {
    const tx = forged(TRX_TX.raw_data_hex, TRX_EXPECTED.toHex, ATTACKER);
    expect(() => verifyTronTransaction(tx, TRX_EXPECTED)).toThrow(/different recipient/);
  });

  it("rejects a different amount or sender", () => {
    expect(() => verifyTronTransaction(TRX_TX, { ...TRX_EXPECTED, amountSun: 1_234_568n })).toThrow(
      /different amount/,
    );
    expect(() => verifyTronTransaction(TRX_TX, { ...TRX_EXPECTED, ownerHex: ATTACKER })).toThrow(
      /different sender/,
    );
  });

  it("rejects bytes whose hash is not the id we would sign", () => {
    const tampered = { ...TRX_TX, raw_data_hex: TRX_TX.raw_data_hex.replace(/34$/, "35") };
    expect(() => verifyTronTransaction(tampered, TRX_EXPECTED)).toThrow(/not the hash/);
  });

  it("rejects a token call where a plain transfer was asked for", () => {
    expect(() =>
      verifyTronTransaction(USDT_TX, { ...TRX_EXPECTED, ownerHex: USDT_EXPECTED.ownerHex }),
    ).toThrow(/different contract type/);
  });

  it("rejects an answer with nothing to sign", () => {
    // The shape `createtransaction` returns on a node-side refusal: HTTP 200
    // and an `Error` string. Before this, signing it crashed on `txID`.
    expect(() =>
      verifyTronTransaction({ Error: "balance is not sufficient" } as never, TRX_EXPECTED),
    ).toThrow(TronTxMismatchError);
  });
});

describe("a USDT (TRC-20) transfer", () => {
  it("passes when it is exactly the call requested", () => {
    expect(() => verifyTronTransaction(USDT_TX, USDT_EXPECTED)).not.toThrow();
  });

  it("rejects a forged recipient inside the call data", () => {
    const tx = forged(USDT_TX.raw_data_hex, "cbc9f1a9e6da62d2fd6283aa51f4dea2c0fc1c79", "ab".repeat(20));
    expect(() => verifyTronTransaction(tx, USDT_EXPECTED)).toThrow(/different recipient or amount/);
  });

  it("rejects a different token contract", () => {
    const tx = forged(USDT_TX.raw_data_hex, USDT_EXPECTED.contractHex, ATTACKER);
    expect(() => verifyTronTransaction(tx, USDT_EXPECTED)).toThrow(/different token contract/);
  });

  it("rejects a fee limit above the one requested", () => {
    expect(() =>
      verifyTronTransaction(USDT_TX, { ...USDT_EXPECTED, maxFeeLimitSun: 50_000_000n }),
    ).toThrow(/different fee limit/);
  });
});

// ── Repeated fields (2026-09-29 send-safety audit) ─────────────────────────
//
// A protobuf parser — java-tron's included — keeps the LAST copy of a
// singular field; the verifier read the FIRST. The audit's proof-of-concept
// had a node return `to_address` twice (requested, then its own), `amount`
// twice and TRC-20 `data` twice, each with a correct txID, and every one
// passed. Inside `Any.value` a duplicate survives java-tron re-serialising
// `raw`, so the signature would still have verified on chain.
//
// The transactions are built here, field by field, and self-hashed: the
// attacker is the node, which controls both the bytes and their id.

const pbVarint = (n: bigint | number): number[] => {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const pbInt = (no: number, n: bigint | number) => [...pbVarint((no << 3) | 0), ...pbVarint(n)];
const pbBytes = (no: number, b: number[]) => [...pbVarint((no << 3) | 2), ...pbVarint(b.length), ...b];
const hexBytes = (h: string) => Array.from(Buffer.from(h, "hex"));
const utf8 = (s: string) => Array.from(Buffer.from(s, "utf8"));

const TRANSFER_URL = "type.googleapis.com/protocol.TransferContract";
const TRIGGER_URL = "type.googleapis.com/protocol.TriggerSmartContract";

/** A self-consistent node answer: `raw_data_hex` and its own sha256 id. */
function built(opts: {
  type: number;
  typeUrl: string;
  value: number[];
  /** Extra bytes appended inside `Any` / `Contract` / `raw`. */
  anyExtra?: number[];
  contractExtra?: number[];
  rawExtra?: number[];
}) {
  const any = [...pbBytes(1, utf8(opts.typeUrl)), ...pbBytes(2, opts.value), ...(opts.anyExtra ?? [])];
  const contract = [...pbInt(1, opts.type), ...pbBytes(2, any), ...(opts.contractExtra ?? [])];
  const raw = [
    ...pbBytes(1, hexBytes("bb6e")),
    ...pbBytes(4, hexBytes("c57d351194bd00b9")),
    ...pbInt(8, 1_900_000_000_000n),
    ...pbBytes(11, contract),
    ...pbInt(14, 1_899_999_000_000n),
    ...(opts.rawExtra ?? []),
  ];
  const rawHex = Buffer.from(raw).toString("hex");
  return { raw_data_hex: rawHex, txID: ethers.sha256("0x" + rawHex).slice(2) };
}

const OWNER = TRX_EXPECTED.ownerHex;
const PAYEE = TRX_EXPECTED.toHex;
const transferValue = (to = PAYEE, amount: bigint = TRX_EXPECTED.amountSun) => [
  ...pbBytes(1, hexBytes(OWNER)),
  ...pbBytes(2, hexBytes(to)),
  ...pbInt(3, amount),
];

const TOKEN = USDT_EXPECTED.contractHex;
const callData = (payee: string) =>
  "a9059cbb" + payee.slice(2).padStart(64, "0") + (1_234_567).toString(16).padStart(64, "0");
const GOOD_CALL = callData(PAYEE);
const EVIL_CALL = callData(ATTACKER);
const TRC20_SYNTH = {
  kind: "trc20" as const,
  ownerHex: OWNER,
  contractHex: TOKEN,
  data: GOOD_CALL,
  maxFeeLimitSun: 100_000_000n,
};
const triggerValue = (...datas: string[]) => [
  ...pbBytes(1, hexBytes(OWNER)),
  ...pbBytes(2, hexBytes(TOKEN)),
  ...datas.flatMap((d) => pbBytes(4, hexBytes(d))),
];

describe("repeated fields are refused, not read first-wins (2026-09-29 send-safety audit)", () => {
  it("control: the canonical forms built here pass, so the refusals below are about the repeats", () => {
    expect(() =>
      verifyTronTransaction(built({ type: 1, typeUrl: TRANSFER_URL, value: transferValue() }), TRX_EXPECTED),
    ).not.toThrow();
    expect(() =>
      verifyTronTransaction(
        built({ type: 31, typeUrl: TRIGGER_URL, value: triggerValue(GOOD_CALL), rawExtra: pbInt(18, 100_000_000n) }),
        TRC20_SYNTH,
      ),
    ).not.toThrow();
  });

  it("refuses to_address twice: the requested payee, then the node's", () => {
    const value = [...transferValue(), ...pbBytes(2, hexBytes(ATTACKER))];
    const tx = built({ type: 1, typeUrl: TRANSFER_URL, value });
    expect(() => verifyTronTransaction(tx, TRX_EXPECTED)).toThrow(TronTxMismatchError);
    expect(() => verifyTronTransaction(tx, TRX_EXPECTED)).toThrow(/repeats field 2 of its transfer/);
  });

  it("refuses amount twice: the requested amount, then a larger one", () => {
    const value = [...transferValue(), ...pbInt(3, 999_000_000n)];
    const tx = built({ type: 1, typeUrl: TRANSFER_URL, value });
    expect(() => verifyTronTransaction(tx, TRX_EXPECTED)).toThrow(/repeats field 3 of its transfer/);
  });

  it("refuses TRC-20 call data twice: a transfer to the payee, then to the node", () => {
    const tx = built({ type: 31, typeUrl: TRIGGER_URL, value: triggerValue(GOOD_CALL, EVIL_CALL) });
    expect(() => verifyTronTransaction(tx, TRC20_SYNTH)).toThrow(/repeats field 4 of its contract call/);
  });

  it("refuses the parameter bytes twice inside Any (the whole transfer repeated)", () => {
    const anyExtra = pbBytes(2, transferValue(ATTACKER));
    const tx = built({ type: 1, typeUrl: TRANSFER_URL, value: transferValue(), anyExtra });
    expect(() => verifyTronTransaction(tx, TRX_EXPECTED)).toThrow(/repeats field 2 of its contract parameters/);
  });

  it("refuses the contract type twice", () => {
    const tx = built({ type: 1, typeUrl: TRANSFER_URL, value: transferValue(), contractExtra: pbInt(1, 31) });
    expect(() => verifyTronTransaction(tx, TRX_EXPECTED)).toThrow(/repeats field 1 of its contract/);
  });

  it("refuses fee_limit twice: one within the cap, then one above it", () => {
    const tx = built({
      type: 31,
      typeUrl: TRIGGER_URL,
      value: triggerValue(GOOD_CALL),
      rawExtra: [...pbInt(18, 50_000_000n), ...pbInt(18, 15_000_000_000n)],
    });
    expect(() => verifyTronTransaction(tx, TRC20_SYNTH)).toThrow(/repeats field 18 of its transaction/);
  });

  it("refuses parameters whose type_url names another contract than the type", () => {
    // java-tron unpacks the parameter by its type_url; a TRC-10 transfer
    // wearing TransferContract's type number is not the transfer checked.
    const tx = built({
      type: 1,
      typeUrl: "type.googleapis.com/protocol.TransferAssetContract",
      value: transferValue(),
    });
    expect(() => verifyTronTransaction(tx, TRX_EXPECTED)).toThrow(/different contract type/);
  });

  it("refuses a checked field sent in another wire type than its .proto declares", () => {
    // java-tron would skip a length-delimited `amount` as unknown.
    const value = [
      ...pbBytes(1, hexBytes(OWNER)),
      ...pbBytes(2, hexBytes(PAYEE)),
      ...pbBytes(3, pbVarint(TRX_EXPECTED.amountSun)),
    ];
    const tx = built({ type: 1, typeUrl: TRANSFER_URL, value });
    expect(() => verifyTronTransaction(tx, TRX_EXPECTED)).toThrow(/amount in an unexpected form/);
  });
});
