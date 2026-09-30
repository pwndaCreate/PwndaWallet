/**
 * Which forms of a Bitcoin Cash address the Send path accepts (2026-09-12).
 *
 * The `bitcoincash:` prefix is optional in practice — it participates in the
 * checksum, but wallets commonly display the bare form and the prefix is
 * implied as mainnet. Operator question: "can they be without it? … make sure
 * sending accepts both".
 *
 * CORRECTED 2026-09-29 (send-safety audit): this file used to pin the legacy
 * base58 form (`1…` / `3…`) as ACCEPTED, on the note that it "is also still in
 * use". It is refused now. Those strings are byte-for-byte Bitcoin addresses,
 * so a BTC address pasted into the BCH Send form passed silently — and a BTC
 * SegWit-wrapped `3…` deposit address makes the BCH output spendable by anyone
 * who learns the redeem script (BCH's SegWit-recovery rule; inference, not
 * observed). The legacy vectors below stay, as the refusal's inputs.
 *
 * Vectors: the CashAddr specification's conversion table
 * (github.com/bitcoincashorg/bitcoincash.org spec/cashaddr.md) — the same
 * 20-byte hash in legacy and CashAddr form, for P2PKH and P2SH. Every accepted
 * form must decode to that SAME hash; that agreement is the proof, since the
 * checksums are computed independently. The 32-byte vectors are the same
 * spec's "larger test vectors", reproduced by BasicSwap's independent
 * `contrib/cashaddress.py` before being written here.
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

  it("a legacy base58 address — the Bitcoin format — even for a hash the CashAddr form accepts (2026-09-29)", () => {
    for (const legacy of [P2PKH.legacy, P2SH.legacy]) {
      expect(() => parseRecipient(legacy), legacy).toThrow(/CashAddr/);
    }
  });

  it("a P2PKH CashAddr that carries a 32-byte hash — no standard script pays it (2026-09-29)", () => {
    // The spec's 32-byte, type-0 vector: a valid checksum, but a P2PKH output
    // is `OP_DUP OP_HASH160 <20 bytes> …`; there is no 32-byte form to build.
    expect(() => parseRecipient(SPEC_P2PKH_32)).toThrow(/20-byte/);
  });

  it("a token-aware (z…) address is not mistaken for a plain one", () => {
    expect(() => parseRecipient("bitcoincash:zpm2qsznhks23z7629mms6s4cwef74vcwvrqekrq9w")).toThrow();
  });
});

/** CashAddr spec, "larger test vectors": the 32-byte payload, type 0 and type 1. */
const SPEC_P2PKH_32 = "bitcoincash:qvch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxq5nlegake";
const SPEC_P2SH_32_TESTNET = "bchtest:pvch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxq7fqng6m6";

describe("P2SH32 — the 32-byte script hash BCH has carried since May 2023 (2026-09-29)", () => {
  it("a mainnet P2SH32 address decodes to its 32-byte hash", () => {
    // Encoded by BasicSwap's cashaddress.py: Address("P2SH32", h), version byte 11.
    const got = parseRecipient("bitcoincash:pvps5ygcrunz6dpmgfy4q467v4k8x75p3z8ed8dy4wetnsx8em2acv2t9lryf");
    expect(got.type).toBe("p2sh");
    expect(hex(got.hash)).toBe("030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc");
  });

  it("the spec's 32-byte vectors pass the checksum; the testnet one is still refused", () => {
    // Positive control for the 32-byte checksum path: the P2PKH vector the
    // refusal above uses must fail for its hash length, not its checksum.
    expect(() => parseRecipient(SPEC_P2PKH_32)).not.toThrow(/checksum/);
    expect(() => parseRecipient(SPEC_P2SH_32_TESTNET)).toThrow(/only mainnet/);
  });
});
