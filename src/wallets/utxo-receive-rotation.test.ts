/**
 * `firstUnusedReceiveAddress` — the address rotation Exodus calls "Multiple
 * Addresses".
 *
 * The interesting cases are all the ones where it must REFUSE to answer.
 * Handing out a stale address while implying it is fresh is worse than showing
 * nothing, because the user acts on it: they publish it, and every deposit is
 * publicly linked to every previous one. So the tests below are mostly about
 * silence being correct.
 */
import { describe, it, expect } from "vitest";
import { firstUnusedReceiveAddress, type UtxoAddressEntry } from "./utxo-account";
import { bchUtxoAccounts } from "./bch-wallet";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SPEC = bchUtxoAccounts[0];

function entry(index: number, opts: Partial<UtxoAddressEntry> = {}): UtxoAddressEntry {
  return {
    path: `m/44'/145'/0'/0/${index}`,
    address: `addr-${index}`,
    chainIndex: 0,
    index,
    balanceSat: 0,
    used: true,
    ...opts,
  };
}

describe("firstUnusedReceiveAddress", () => {
  it("returns the address one past the highest touched receive index", () => {
    const r = firstUnusedReceiveAddress(MNEMONIC, SPEC, {
      complete: true,
      entries: [entry(0), entry(1), entry(2)],
    });
    expect(r?.index).toBe(3);
    expect(r?.path).toBe("m/44'/145'/0'/0/3");
    expect(r?.address).toMatch(/^bitcoincash:/);
  });

  it("does NOT fill a gap inside the used range", () => {
    // Index 1 is unused, but some other wallet may have handed it out and be
    // waiting on it. MAX+1 is also what the swap engine's WalletManager does —
    // the two disagreeing is what stranded funds in the 2026-08-22 LTC incident.
    const r = firstUnusedReceiveAddress(MNEMONIC, SPEC, {
      complete: true,
      entries: [entry(0), entry(2)],
    });
    expect(r?.index).toBe(3);
  });

  it("treats a funded-but-unflagged address as touched", () => {
    // A source that forgot `used` but reported a balance must not get that
    // address handed out again.
    const r = firstUnusedReceiveAddress(MNEMONIC, SPEC, {
      complete: true,
      entries: [entry(0), entry(5, { used: false, balanceSat: 1000 })],
    });
    expect(r?.index).toBe(6);
  });

  it("ignores the CHANGE chain when picking a receive address", () => {
    const r = firstUnusedReceiveAddress(MNEMONIC, SPEC, {
      complete: true,
      entries: [entry(0), { ...entry(40), chainIndex: 1 }],
    });
    expect(r?.index).toBe(1);
  });

  it("returns index 0 for a genuinely untouched account", () => {
    const r = firstUnusedReceiveAddress(MNEMONIC, SPEC, { complete: true, entries: [] });
    expect(r?.index).toBe(0);
  });

  it("REFUSES when no scan has run — absence is not index 0", () => {
    // Returning index 0 here would hand out the most-reused address in the
    // account while implying it is fresh.
    expect(firstUnusedReceiveAddress(MNEMONIC, SPEC, null)).toBeNull();
    expect(firstUnusedReceiveAddress(MNEMONIC, SPEC, undefined)).toBeNull();
  });

  it("REFUSES an incomplete scan — 'unused' is indistinguishable from 'unknown'", () => {
    expect(
      firstUnusedReceiveAddress(MNEMONIC, SPEC, {
        complete: false,
        entries: [entry(0), entry(1)],
      }),
    ).toBeNull();
  });

  it("REFUSES without a mnemonic", () => {
    expect(
      firstUnusedReceiveAddress("", SPEC, { complete: true, entries: [] }),
    ).toBeNull();
  });

  it("produces a DIFFERENT address than the wallet's primary — the whole point", () => {
    const primary = firstUnusedReceiveAddress(MNEMONIC, SPEC, {
      complete: true,
      entries: [],
    });
    const rotated = firstUnusedReceiveAddress(MNEMONIC, SPEC, {
      complete: true,
      entries: [entry(0)],
    });
    expect(primary?.address).toBeTruthy();
    expect(rotated?.address).toBeTruthy();
    expect(rotated!.address).not.toBe(primary!.address);
  });
});
