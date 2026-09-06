import { describe, expect, it, vi } from "vitest";
import { derivePerChoice, DEFAULT_DERIVATION_CHOICE, detectLtc } from "./derivation-detector";

// Real derivation, mocked network: `getBalance` is the only thing each test
// below controls. `importActual` keeps `deriveFromMnemonic` and every other
// real method intact, so `detectLtc`'s own address derivation is untouched.
const getBalanceMock = vi.fn<(address: string) => Promise<string>>();
vi.mock("../../wallets/ltc-wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../wallets/ltc-wallet")>();
  return {
    ...actual,
    ltcAdapter: { ...actual.ltcAdapter, getBalance: (a: string) => getBalanceMock(a) },
  };
});

/**
 * Regression lock for the 2026-06-21 "auto-detect Exodus on import" change.
 *
 * `detectSol` / `detectAda` / `detectLtc` / `detectAlgo` now probe the
 * account-0/index-0 Exodus candidates and recommend their choice ids
 * ("exodus", "exodus-cardano", "exodus-cardano-split", "bip44-legacy") when
 * those addresses have a balance. This is funds-critical: the address the
 * detector probes MUST equal the address `derivePerChoice` re-derives on
 * unlock — otherwise the user sees "funds detected" then gets a different
 * address. These tests pin that round-trip on the ABANDON vector (pure, no
 * network — `derivePerChoice` only derives addresses).
 */
const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// HeptaSean canonical Exodus-Cardano same-key address for ABANDON (also
// pinned in cardano-cip1852.test.ts + the bruteForceFindCardano comment).
const EXODUS_ADA_SAMEKEY =
  "addr1q9av2w6nz9tzv8rc3vfqs95av844gkcqxm0qeezvlf07p3r6c5a4xy2kycw83zcjpqtf6c0t23dsqdk7pnjye7jlurzqm0pqxa";

describe("Exodus auto-detect — derivation-choice round-trip", () => {
  it("re-derives every Exodus choice id without throwing", () => {
    const w = derivePerChoice(ABANDON, {
      bitcoin: "bip84",
      solana: "exodus",
      cardano: "exodus-cardano",
      litecoin: "bip44-legacy",
      algorand: "exodus",
    });
    expect(w.solana.address.length).toBeGreaterThan(30); // base58 pubkey
    expect(w.cardano.address.startsWith("addr1")).toBe(true);
    expect(w.litecoin.address.startsWith("L")).toBe(true); // BIP-44 legacy P2PKH
    expect(w.algorand.address.length).toBe(58);
  });

  it("'exodus-cardano' produces the canonical HeptaSean address", () => {
    const w = derivePerChoice(ABANDON, {
      ...DEFAULT_DERIVATION_CHOICE,
      cardano: "exodus-cardano",
    });
    expect(w.cardano.address).toBe(EXODUS_ADA_SAMEKEY);
  });

  it("Exodus SOL / ADA / LTC differ from their standard defaults", () => {
    const std = derivePerChoice(ABANDON, DEFAULT_DERIVATION_CHOICE);
    const exo = derivePerChoice(ABANDON, {
      bitcoin: "bip84",
      solana: "exodus",
      cardano: "exodus-cardano",
      litecoin: "bip44-legacy",
      algorand: "exodus",
    });
    expect(exo.solana.address).not.toBe(std.solana.address); // phantom vs exodus
    expect(exo.cardano.address).not.toBe(std.cardano.address); // cip1852 vs exodus
    expect(exo.litecoin.address).not.toBe(std.litecoin.address); // bip84 vs bip44-legacy
  });

  it("the split-stake Exodus-Cardano choice re-derives to a distinct base address", () => {
    const split = derivePerChoice(ABANDON, {
      ...DEFAULT_DERIVATION_CHOICE,
      cardano: "exodus-cardano-split",
    });
    const sameKey = derivePerChoice(ABANDON, {
      ...DEFAULT_DERIVATION_CHOICE,
      cardano: "exodus-cardano",
    });
    expect(split.cardano.address.startsWith("addr1")).toBe(true);
    expect(split.cardano.address).not.toBe(sameKey.cardano.address);
  });

  it("the default choice still produces the standard CIP-1852 / Phantom / ltc1q paths", () => {
    const w = derivePerChoice(ABANDON, DEFAULT_DERIVATION_CHOICE);
    expect(w.cardano.address.startsWith("addr1")).toBe(true);
    expect(w.litecoin.address.startsWith("ltc1")).toBe(true); // BIP-84 native segwit
  });
});

/**
 * Bug fix, 2026-08-22: `ltcAddressActivity` used to catch `getBalance`'s
 * failure and silently return 0 — a real, funded address (the swap node's
 * own C8-shared LTC wallet showed 4.02888049 LTC) rendered as "0 LTC
 * probed", indistinguishable from a genuinely empty address, because every
 * one of the three public explorer sources happened to be unreachable at
 * that moment. `getBalance` (`ltc-wallet.ts::tryEach`) already throws on
 * total failure rather than returning a false zero; these pin that the
 * distinction survives all the way to `DerivationCandidate.probeFailed`.
 */
describe("detectLtc — probeFailed distinguishes a failed probe from a genuine zero", () => {
  it("a confirmed zero balance: hasActivity false, probeFailed false", async () => {
    getBalanceMock.mockResolvedValue("0.00000000");
    const result = await detectLtc(ABANDON);
    for (const c of result.candidates) {
      expect(c.hasActivity).toBe(false);
      expect(c.balance).toBe(0);
      expect(c.probeFailed).toBe(false);
    }
  });

  it("a confirmed positive balance: hasActivity true, probeFailed false", async () => {
    getBalanceMock.mockResolvedValue("4.02888049");
    const result = await detectLtc(ABANDON);
    const bip84 = result.candidates.find((c) => c.id === "bip84")!;
    expect(bip84.hasActivity).toBe(true);
    expect(bip84.balance).toBeCloseTo(4.02888049);
    expect(bip84.probeFailed).toBe(false);
  });

  it("every source failing: probeFailed true, NOT read as a confirmed zero", async () => {
    getBalanceMock.mockRejectedValue(
      new Error("All 3 LTC source(s) failed [blockcypher, blockchair, litecoinspace]: timeout"),
    );
    const result = await detectLtc(ABANDON);
    for (const c of result.candidates) {
      expect(c.hasActivity).toBe(false);
      expect(c.probeFailed).toBe(true);
    }
  });
});
