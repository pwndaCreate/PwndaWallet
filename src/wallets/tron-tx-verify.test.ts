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
