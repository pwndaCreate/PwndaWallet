/**
 * `findPathForAddress` must place ROTATED and CHANGE addresses.
 *
 * Reported 2026-09-04: a user pasted their Exodus BCH receive address into
 * "Find its derivation" and got *"No derivation of this seed produces that
 * address, within 20 candidates. Either it belongs to a different seed, or the
 * source wallet uses a scheme this search doesn't cover yet."*
 *
 * The seed was correct. The search covered `m/44'/145'/a'/0/i` for i <= 10,
 * receive chain only — so it could not place an address from any wallet that
 * rotates receive addresses, which is every modern HD wallet, including this
 * one now. "Wrong seed" is an alarming thing to tell someone about their own
 * money, and it was wrong.
 *
 * These tests derive addresses at paths the OLD search could not reach and
 * assert they are found, so the gap cannot quietly reopen.
 */
import { describe, it, expect } from "vitest";
import { findPathForAddress } from "./generic-path-finder";
import { getAdapter } from "../../wallets";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Derive at an explicit path so the expectation is independent of the search. */
function addressAt(chain: "bitcoin-cash", path: string): string {
  return getAdapter(chain).deriveAtPath!(MNEMONIC, path).address;
}

describe("finding rotated and change addresses", () => {
  it("finds a receive address well past the old index-10 ceiling", () => {
    const path = "m/44'/145'/0'/0/17";
    const hit = findPathForAddress("bitcoin-cash", MNEMONIC, addressAt("bitcoin-cash", path));
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe(path);
  });

  it("finds a CHANGE address — the chain the old search never varied", () => {
    const path = "m/44'/145'/0'/1/4";
    const hit = findPathForAddress("bitcoin-cash", MNEMONIC, addressAt("bitcoin-cash", path));
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe(path);
    expect(hit!.label).toMatch(/CHANGE/i);
  });

  it("still finds the plain default at index 0", () => {
    const hit = findPathForAddress(
      "bitcoin-cash",
      MNEMONIC,
      addressAt("bitcoin-cash", "m/44'/145'/0'/0/0"),
    );
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe("m/44'/145'/0'/0/0");
  });

  it("works for a second chain, so this is not BCH-specific plumbing", () => {
    // Guard on the METHOD, not just the path shape: `deriveAtPath` is optional
    // on ChainAdapter and bitcoin's adapter does not implement it, so the
    // first draft of this test threw on `deriveAtPath!` rather than skipping.
    const ltc = getAdapter("litecoin");
    if (typeof ltc.deriveAtPath !== "function" || ltc.derivation.kind !== "bip39") return;
    const path = `${ltc.derivation.path!.split("/").slice(0, 4).join("/")}/1/6`;
    const addr = ltc.deriveAtPath(MNEMONIC, path).address;
    const hit = findPathForAddress("litecoin", MNEMONIC, addr);
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe(path);
  });

  it("FALSIFICATION: an address from a DIFFERENT seed is still not found", () => {
    // Without this the tests above would pass on a search that returned
    // something for any input.
    const other =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const foreign = getAdapter("bitcoin-cash").deriveAtPath!(other, "m/44'/145'/0'/0/3").address;
    expect(findPathForAddress("bitcoin-cash", MNEMONIC, foreign)).toBeNull();
  });

  it("FALSIFICATION: nonsense input is still not found", () => {
    expect(findPathForAddress("bitcoin-cash", MNEMONIC, "bitcoincash:qnot-a-real-address")).toBeNull();
  });
});
