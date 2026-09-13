/**
 * Which forms of a Bitcoin Cash address the Send path accepts (2026-09-12).
 *
 * The `bitcoincash:` prefix is optional in practice — it participates in the
 * checksum, but wallets commonly display the bare form and the prefix is
 * implied as mainnet. The legacy base58 form is also still in use. Operator
 * question: "can they be without it? … make sure sending accepts both".
 *
 * Vectors: the CashAddr specification's conversion table
 * (github.com/bitcoincashorg/bitcoincash.org spec/cashaddr.md) — the same
 * 20-byte hash in legacy and CashAddr form, for P2PKH and P2SH. Every accepted
 * form must decode to that SAME hash; that agreement is the proof, since the
 * legacy and CashAddr checksums are computed independently.
 */
import { describe, it, expect } from "vitest";
import { encodeCashAddr, parseRecipient } from "./bch-wallet";

const HASH = "76a04053bda0a88bda5177b86a15c3b29f559873";
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const P2PKH = {
  legacy: "1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu",
  cashaddr: "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
};
const P2SH = {
  legacy: "3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC",
  cashaddr: "bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq",
};

describe("parseRecipient accepts every mainnet form of one address", () => {
  for (const [kind, v] of [["p2pkh", P2PKH], ["p2sh", P2SH]] as const) {
    const bare = v.cashaddr.slice("bitcoincash:".length);
    const forms: Array<[string, string]> = [
      ["prefixed CashAddr", v.cashaddr],
      ["bare CashAddr (no prefix)", bare],
      ["UPPERCASE prefixed (QR form)", v.cashaddr.toUpperCase()],
      ["UPPERCASE bare — failed before 2026-09-12", bare.toUpperCase()],
      ["payment URI with amount", `${v.cashaddr}?amount=0.1&label=test`],
      ["surrounding whitespace", `  ${bare}\n`],
      ["legacy base58", v.legacy],
    ];
    for (const [label, input] of forms) {
      it(`${kind}: ${label}`, () => {
        const got = parseRecipient(input);
        expect(got.type).toBe(kind);
        expect(hex(got.hash)).toBe(HASH);
      });
    }
  }

  it("the encoder emits the spec's prefixed form (positive control)", () => {
    const hash = Uint8Array.from(HASH.match(/../g)!.map((h) => parseInt(h, 16)));
    expect(encodeCashAddr(hash, "p2pkh")).toBe(P2PKH.cashaddr);
  });
});

describe("parseRecipient still refuses what must not be sent to", () => {
  it("another network's prefix", () => {
    expect(() => parseRecipient("bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a")).toThrow(
      /only mainnet/,
    );
  });

  it("a one-character typo (checksum)", () => {
    const typo = P2PKH.cashaddr.slice(0, -1) + (P2PKH.cashaddr.endsWith("a") ? "q" : "a");
    expect(() => parseRecipient(typo)).toThrow(/checksum/);
    expect(() => parseRecipient(typo.slice("bitcoincash:".length))).toThrow(/checksum/);
  });

  it("garbage", () => {
    expect(() => parseRecipient("not-an-address")).toThrow();
  });
});
