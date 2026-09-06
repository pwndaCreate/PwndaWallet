import { describe, expect, it } from "vitest";
import {
  derivePerChoice,
  DEFAULT_DERIVATION_CHOICE,
  detectProfilePaths,
  bruteForceFindCoinPath,
} from "./derivation-detector";
import { xrpAdapter, deriveXrpAtPath } from "../../wallets/xrp-wallet";
import { trxAdapter, deriveTrxAtPath } from "../../wallets/trx-wallet";
import { rvnAdapter, deriveRvnAtPath } from "../../wallets/rvn-wallet";
import { dashAdapter, deriveDashAtPath } from "../../wallets/dash-wallet";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * Phase 1 — funds-critical lock for profile per-coin derivation. The whole
 * design rests on one invariant: `deriveXxxAtPath` at the STANDARD path must
 * be byte-identical to the adapter's own `deriveFromMnemonic`. If it drifts,
 * `derivePerChoice` (run on every unlock) would silently change every user's
 * XRP / TRX / RVN / DASH address. These tests pin that equality.
 */
describe("Phase 1 — profile per-coin derivation (XRP / TRX / RVN / DASH)", () => {
  it("deriveXxxAtPath at the STANDARD path == the adapter default (no drift)", () => {
    expect(deriveXrpAtPath(ABANDON, "m/44'/144'/0'/0/0").address).toBe(xrpAdapter.deriveFromMnemonic(ABANDON).address);
    expect(deriveTrxAtPath(ABANDON, "m/44'/60'/0'/0/0").address).toBe(trxAdapter.deriveFromMnemonic(ABANDON).address);
    expect(deriveRvnAtPath(ABANDON, "m/44'/175'/0'/0/0").address).toBe(rvnAdapter.deriveFromMnemonic(ABANDON).address);
    expect(deriveDashAtPath(ABANDON, "m/44'/5'/0'/0/0").address).toBe(dashAdapter.deriveFromMnemonic(ABANDON).address);
  });

  it("private keys at the STANDARD path also match the adapter default", () => {
    expect(deriveXrpAtPath(ABANDON, "m/44'/144'/0'/0/0").privateKey).toBe(xrpAdapter.deriveFromMnemonic(ABANDON).privateKey);
    expect(deriveTrxAtPath(ABANDON, "m/44'/60'/0'/0/0").privateKey).toBe(trxAdapter.deriveFromMnemonic(ABANDON).privateKey);
    expect(deriveRvnAtPath(ABANDON, "m/44'/175'/0'/0/0").privateKey).toBe(rvnAdapter.deriveFromMnemonic(ABANDON).privateKey);
    expect(deriveDashAtPath(ABANDON, "m/44'/5'/0'/0/0").privateKey).toBe(dashAdapter.deriveFromMnemonic(ABANDON).privateKey);
  });

  it("an alternate (Exodus/Atomic) path produces a DIFFERENT address", () => {
    expect(deriveXrpAtPath(ABANDON, "m/44'/144'/0'/0'/0'").address).not.toBe(xrpAdapter.deriveFromMnemonic(ABANDON).address);
    expect(deriveTrxAtPath(ABANDON, "m/44'/195'/0'/0'/0'").address).not.toBe(trxAdapter.deriveFromMnemonic(ABANDON).address);
    expect(deriveRvnAtPath(ABANDON, "m/44'/175'/0'/0'/0'").address).not.toBe(rvnAdapter.deriveFromMnemonic(ABANDON).address);
    expect(deriveDashAtPath(ABANDON, "m/44'/5'/0'").address).not.toBe(dashAdapter.deriveFromMnemonic(ABANDON).address);
  });

  it("address formats stay correct on alternate paths (XRP r…, RVN R…, DASH X…, TRX T…)", () => {
    expect(deriveXrpAtPath(ABANDON, "m/44'/144'/0'/0'/0'").address.startsWith("r")).toBe(true);
    expect(deriveRvnAtPath(ABANDON, "m/44'/175'/0'/0'/0'").address.startsWith("R")).toBe(true);
    expect(deriveDashAtPath(ABANDON, "m/44'/5'/0'").address.startsWith("X")).toBe(true);
    expect(deriveTrxAtPath(ABANDON, "m/44'/195'/0'/0'/0'").address.startsWith("T")).toBe(true);
  });

  it("derivePerChoice with no overrides == standard addresses (unlock is a no-op)", () => {
    const w = derivePerChoice(ABANDON, DEFAULT_DERIVATION_CHOICE);
    expect(w.xrp.address).toBe(xrpAdapter.deriveFromMnemonic(ABANDON).address);
    expect(w.tron.address).toBe(trxAdapter.deriveFromMnemonic(ABANDON).address);
    expect(w.ravencoin.address).toBe(rvnAdapter.deriveFromMnemonic(ABANDON).address);
    expect(w.dash.address).toBe(dashAdapter.deriveFromMnemonic(ABANDON).address);
  });

  it("derivePerChoice applies a path override", () => {
    const w = derivePerChoice(ABANDON, { ...DEFAULT_DERIVATION_CHOICE, xrp: "m/44'/144'/0'/0'/0'" });
    expect(w.xrp.address).toBe(deriveXrpAtPath(ABANDON, "m/44'/144'/0'/0'/0'").address);
    expect(w.xrp.address).not.toBe(xrpAdapter.deriveFromMnemonic(ABANDON).address);
  });

  it("detectProfilePaths('standard') short-circuits to {} (no network)", async () => {
    // The standard profile diverges from nothing, so this must return early
    // WITHOUT any balance probe — keeps a non-Exodus import fast + offline.
    await expect(detectProfilePaths(ABANDON, "standard")).resolves.toEqual({});
  });
});

describe("Phase 3 — paste-to-find for the secp256k1 profile coins", () => {
  it("finds the STANDARD path from the standard address (all 4 coins)", () => {
    const cases = [
      ["xrp", xrpAdapter, "m/44'/144'/0'/0/0"],
      ["ravencoin", rvnAdapter, "m/44'/175'/0'/0/0"],
      ["dash", dashAdapter, "m/44'/5'/0'/0/0"],
      ["tron", trxAdapter, "m/44'/60'/0'/0/0"],
    ] as const;
    for (const [coin, adapter, stdPath] of cases) {
      const addr = adapter.deriveFromMnemonic(ABANDON).address;
      const m = bruteForceFindCoinPath(coin, ABANDON, addr);
      expect(m, coin).not.toBeNull();
      expect(m!.path).toBe(stdPath);
    }
  });

  it("finds the Exodus 5-hardened XRP path from its address (the find probe's job)", () => {
    const exo = deriveXrpAtPath(ABANDON, "m/44'/144'/0'/0'/0'").address;
    const m = bruteForceFindCoinPath("xrp", ABANDON, exo);
    expect(m).not.toBeNull();
    expect(m!.path).toBe("m/44'/144'/0'/0'/0'");
    expect(m!.id).toBe(m!.path); // id IS the path — used directly as the choice value
  });

  it("returns null for an address not derivable from the seed", () => {
    expect(bruteForceFindCoinPath("xrp", ABANDON, "rGarbageNotARealAddress11111")).toBeNull();
  });
});
