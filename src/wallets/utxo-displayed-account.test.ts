/**
 * The dashboard scans the account the wallet DISPLAYS — for every UTXO chain,
 * not `utxoAccounts[0]` (2026-09-29 send-safety audit).
 *
 * `resolveUtxoAccountBalance` summed the adapter's FIRST account whatever
 * address was on screen. Beyond Bitcoin's BIP-49/BIP-44 wallets (see
 * btc-bip49-bip44-accounts.test.ts), that made three more wallets read 0
 * while funded:
 *
 *  - LTC on its BIP-44 legacy derivation (Exodus/Atomic `L…`): the BIP-84
 *    account was summed instead of `ltcUtxoAccounts[1]`, which already existed;
 *  - DASH on Atomic's three-step path `m/44'/5'/0'`;
 *  - RVN on Exodus's fully hardened `m/44'/175'/0'/0'/0'`.
 *
 * The last two have no account spec, and none is invented: those wallets derive
 * one address, not a receive/change account. `utxoAccountSpecFor` says so
 * (`null`), the resolver refuses rather than sum a different account, and the
 * dashboard reads the displayed address alone.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";

vi.mock("../lib/tauri", () => ({
  invoke: (cmd: string, args: unknown) => (globalThis as any).__utxoFakeInvoke(cmd, args),
}));

const memory = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: async () => ({
      get: async (k: string) => memory.get(k) ?? null,
      set: async (k: string, v: unknown) => {
        memory.set(k, v);
      },
      save: async () => {},
    }),
  },
}));

import { FakeExplorer, h160 } from "./utxo-fake-explorer.testkit";
import { getAdapter } from "./index";
import { btcUtxoAccounts } from "./btc-wallet";
import { ltcUtxoAccounts, deriveLtcLegacyFromMnemonic } from "./ltc-wallet";
import { dashAdapter, dashUtxoAccounts, deriveDashAtPath } from "./dash-wallet";
import { rvnAdapter, rvnUtxoAccounts, deriveRvnAtPath } from "./rvn-wallet";
import { resolveUtxoAccountBalance } from "./utxo-account-balance";
import { utxoAccountSpecFor, deriveUtxoAddresses } from "./utxo-account";
import type { ChainType } from "./types";

const M =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(M, ""));
const p2pkh = (pub: Uint8Array) => bitcoin.payments.p2pkh({ hash: Buffer.from(h160(pub)) }).output!;
const p2wpkh = (pub: Uint8Array) => bitcoin.payments.p2wpkh({ hash: Buffer.from(h160(pub)) }).output!;

beforeEach(() => memory.clear());
afterEach(() => vi.unstubAllGlobals());

function newFake(): FakeExplorer {
  const fake = new FakeExplorer();
  vi.stubGlobal("__utxoFakeInvoke", fake.invokeImpl);
  vi.stubGlobal("fetch", fake.fetchImpl);
  return fake;
}

describe("every UTXO adapter's default wallet is its first account's receive/0", () => {
  // The contract `utxoAccountSpecFor` rests on: the address the wallet shows
  // is byte-for-byte what the account spec derives (CashAddr prefix included).
  // `utxoAccountCoverage.test.ts` claimed to check this and only checked the
  // path's shape.
  for (const chain of ["bitcoin", "litecoin", "dogecoin", "dash", "bitcoin-cash", "ravencoin"] as ChainType[]) {
    it(`${chain}`, () => {
      const a = getAdapter(chain);
      const shown = a.deriveFromMnemonic(M).address;
      expect(utxoAccountSpecFor(M, a.utxoAccounts!, shown)).toBe(a.utxoAccounts![0]);
    });
  }
});

describe("LTC's BIP-44 legacy wallet scans its legacy account (2026-09-29 send-safety audit)", () => {
  const legacy = ltcUtxoAccounts[1];
  const shown = deriveLtcLegacyFromMnemonic(M).address;

  it("the legacy address is the legacy spec's receive/0", () => {
    expect(legacy.accountPath).toBe("m/44'/2'/0'");
    expect(utxoAccountSpecFor(M, ltcUtxoAccounts, shown)).toBe(legacy);
  });

  it("finds funds on the legacy receive AND change chains (the old code summed BIP-84: 0)", async () => {
    const fake = newFake();
    const [r0] = deriveUtxoAddresses(M, legacy, 0, 0, 1);
    const [c2] = deriveUtxoAddresses(M, legacy, 1, 2, 1);
    fake.fund(r0.address, p2pkh(root.derive(r0.path).publicKey!), 150_000_000);
    fake.fund(c2.address, p2pkh(root.derive(c2.path).publicKey!), 25_000_000);

    const s = await resolveUtxoAccountBalance("litecoin", ltcUtxoAccounts, M, shown);

    expect(s.complete).toBe(true);
    expect(s.totalSat).toBe(175_000_000);
    expect(s.account?.accountPath).toBe("m/44'/2'/0'");
    expect(s.entries.filter((e) => e.balanceSat > 0).map((e) => e.path)).toEqual([r0.path, c2.path]);
  });
});

describe("DASH on Atomic's path and RVN on Exodus's have no account — none is invented", () => {
  const dashAtomic = deriveDashAtPath(M, "m/44'/5'/0'").address;
  const rvnExodus = deriveRvnAtPath(M, "m/44'/175'/0'/0'/0'").address;

  it("no spec derives either address", () => {
    expect(utxoAccountSpecFor(M, dashUtxoAccounts, dashAtomic)).toBeNull();
    expect(utxoAccountSpecFor(M, rvnUtxoAccounts, rvnExodus)).toBeNull();
  });

  it("the resolver refuses rather than sum the standard account under that address (the old code returned 0, complete)", async () => {
    newFake();
    await expect(resolveUtxoAccountBalance("dash", dashUtxoAccounts, M, dashAtomic)).rejects.toThrow(
      /not the first address of any account/,
    );
    await expect(resolveUtxoAccountBalance("ravencoin", rvnUtxoAccounts, M, rvnExodus)).rejects.toThrow(
      /not the first address of any account/,
    );
    expect(memory.size, "nothing is persisted for an address with no account").toBe(0);
  });

  it("the address alone reads the funded balance — what the dashboard falls back to", async () => {
    const fake = newFake();
    const dashNode = root.derive("m/44'/5'/0'");
    fake.fund(dashAtomic, p2pkh(dashNode.publicKey!), 312_000_000);
    const rvnNode = root.derive("m/44'/175'/0'/0'/0'");
    fake.fund(rvnExodus, p2pkh(rvnNode.publicKey!), 5_000_000_000);
    expect(await dashAdapter.getBalance(dashAtomic)).toBe("3.12000000");
    expect(Number(await rvnAdapter.getBalance(rvnExodus))).toBe(50);
  });

  it("'Scan all derivations' still searches every account, and persists nothing", async () => {
    const fake = newFake();
    const [std0] = deriveUtxoAddresses(M, dashUtxoAccounts[0], 0, 0, 1);
    fake.fund(std0.address, p2pkh(root.derive(std0.path).publicKey!), 1_000_000);
    const s = await resolveUtxoAccountBalance("dash", dashUtxoAccounts, M, dashAtomic, {
      force: true,
      allAccounts: true,
    });
    expect(s.account).toBeNull();
    expect(s.totalSat).toBe(1_000_000);
    expect(memory.size).toBe(0);
  });
});

describe("persisted scan records follow the displayed account (2026-09-29 send-safety audit)", () => {
  const legacyShown = deriveLtcLegacyFromMnemonic(M).address;

  it("a pre-fix record for a legacy-LTC address (it lists BIP-84 addresses) is not trusted", async () => {
    const fake = newFake();
    // What the old code stored for this wallet: fingerprint = the displayed
    // legacy address, entries = the BIP-84 account's, no `account`.
    const [bip84c1] = deriveUtxoAddresses(M, ltcUtxoAccounts[0], 1, 1, 1);
    fake.fund(bip84c1.address, p2wpkh(root.derive(bip84c1.path).publicKey!), 900_000_000);
    memory.set("litecoin", {
      fingerprint: legacyShown,
      deepScannedAt: Date.now(),
      entries: [{ path: bip84c1.path, address: bip84c1.address, chainIndex: 1, index: 1 }],
    });
    const [r0] = deriveUtxoAddresses(M, ltcUtxoAccounts[1], 0, 0, 1);
    fake.fund(r0.address, p2pkh(root.derive(r0.path).publicKey!), 40_000_000);

    const s = await resolveUtxoAccountBalance("litecoin", ltcUtxoAccounts, M, legacyShown);

    // Trusting it, the cheap path re-probed the BIP-84 address and added its
    // 9 LTC to the legacy wallet's number.
    expect(s.totalSat).toBe(40_000_000);
    expect((memory.get("litecoin") as { account?: string }).account).toMatch(/^m\/44'\/2'\/0' /);
  });

  it("a pre-fix record for a DEFAULT wallet stays trusted — the upgrade costs it no re-walk", async () => {
    const fake = newFake();
    const bip84Shown = getAdapter("litecoin").deriveFromMnemonic(M).address;
    const [r0] = deriveUtxoAddresses(M, ltcUtxoAccounts[0], 0, 0, 1);
    fake.fund(r0.address, p2wpkh(root.derive(r0.path).publicKey!), 5_000_000);
    memory.set("litecoin", {
      fingerprint: bip84Shown,
      deepScannedAt: Date.now(),
      entries: [{ path: r0.path, address: r0.address, chainIndex: 0, index: 0 }],
    });
    const s = await resolveUtxoAccountBalance("litecoin", ltcUtxoAccounts, M, bip84Shown);
    expect(s.deep).toBe(false);
    expect(s.totalSat).toBe(5_000_000);
  });

  it("'Scan all derivations' persists only the displayed account's addresses", async () => {
    const fake = newFake();
    const shown = btcUtxoAccounts[0].deriveAddress(root.derive("m/84'/0'/0'/0/0"));
    fake.fund(shown, p2wpkh(root.derive("m/84'/0'/0'/0/0").publicKey!), 1_000_000);
    const bip49 = btcUtxoAccounts.find((s) => s.accountPath === "m/49'/0'/0'")!;
    const [b49] = deriveUtxoAddresses(M, bip49, 0, 0, 1);
    fake.fund(
      b49.address,
      bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(root.derive(b49.path).publicKey!) }) }).output!,
      2_000_000,
    );

    const s = await resolveUtxoAccountBalance("bitcoin", btcUtxoAccounts, M, shown, { force: true, allAccounts: true });

    // The search reports both accounts…
    expect(s.totalSat).toBe(3_000_000);
    // …but the record the cheap path re-probes (and sums as THIS account) is
    // BIP-84's alone.
    const stored = memory.get("bitcoin") as { entries: Array<{ address: string }> };
    expect(stored.entries.map((e) => e.address)).toEqual([shown]);
  });
});
