import { describe, it, expect } from "vitest";
import {
  migrateV2ToV3,
  projectV3ToV2,
  mergeFlatIntoV3,
  addWalletEntry,
  renameWalletEntry,
  removeWalletEntry,
  findDuplicateSeed,
  normalizeSeed,
  sidecarFileForEntry,
  newSidecarFile,
  isPrimaryBip39,
  isSingleChainKind,
  findDuplicateAddress,
  groupIdForWallet,
  listContexts,
  contextForWallet,
  memberOfKind,
  shouldShowSwitcher,
  LEGACY_XMR_SIDECAR_FILE,
  LEGACY_ZPH_SIDECAR_FILE,
  LEGACY_ZANO_SIDECAR_FILE,
  type VaultPayload,
  type VaultPayloadV3,
  type WalletEntry,
  legacyZanoSeedFor,
} from "./vault-schema";

/** A full vault + a standalone "Trading" bip39 + a standalone "Cold" xmr.
 *  One shared id generator so ids never collide (mirrors crypto.randomUUID). */
function multiV3(): VaultPayloadV3 {
  const gen = idGen();
  let v3 = migrateV2ToV3(fullV2(), { now: NOW, genId: gen });
  v3 = addWalletEntry(v3, { kind: "bip39", seed: "trading seed", name: "Trading" }, { now: NOW + 10, genId: gen }).v3;
  v3 = addWalletEntry(v3, { kind: "xmr", seed: "cold seed", name: "Cold", xmrSeedFormat: "legacy" }, { now: NOW + 20, genId: gen }).v3;
  return v3;
}

/**
 * Phase 1 lock for the multi-wallet vault schema. The migration + projection
 * functions are the load-bearing safety surface: a bug here locks existing
 * users out of real funds. Everything is exercised with an injected clock +
 * deterministic id generator so the assertions are exact.
 */

const NOW = 1_700_000_000_000;
/** Deterministic id generator: "id-1", "id-2", ... */
function idGen(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}
/** Standard opts for a deterministic run. */
function det() {
  return { now: NOW, genId: idGen() };
}

/** A fully-populated v2 vault (bip39 + xmr + zph + zano). */
function fullV2(): VaultPayload {
  return {
    v: 2,
    bip39: "abandon abandon abandon about",
    xmrSeed: "sixteen word polyseed here …",
    xmrSeedFormat: "polyseed",
    xmrRestoreHeight: 3_100_000,
    zphSeed: "twenty five word zephyr seed …",
    zphRestoreHeight: 900_000,
    zanoSeed: "twenty six word zano seed …",
    zanoSeedPassphrase: "hunter2",
    derivationChoice: { bitcoin: "bip84", solana: "standard", cardano: "cip1852" },
  };
}

const xmrOf = (v3: VaultPayloadV3) => v3.wallets.find((w) => w.kind === "xmr");
const zphOf = (v3: VaultPayloadV3) => v3.wallets.find((w) => w.kind === "zph");
const bip39Of = (v3: VaultPayloadV3) => v3.wallets.find((w) => w.kind === "bip39");

describe("migrateV2ToV3", () => {
  it("maps a full v2 vault to four grouped entries", () => {
    const v3 = migrateV2ToV3(fullV2(), det());
    expect(v3.v).toBe(3);
    // bip39 + xmr + zph + zano (zano promoted to an entry 2026-09-02).
    expect(v3.wallets).toHaveLength(4);
    expect(v3.lastActiveWalletId).toBe("all");

    const bip39 = bip39Of(v3)!;
    const xmr = xmrOf(v3)!;
    const zph = zphOf(v3)!;

    expect(bip39).toMatchObject({
      name: "Main",
      kind: "bip39",
      seed: "abandon abandon abandon about",
      createdAt: NOW,
      derivationChoice: { bitcoin: "bip84", solana: "standard", cardano: "cip1852" },
    });
    expect(xmr).toMatchObject({
      name: "Main · Monero",
      kind: "xmr",
      seed: "sixteen word polyseed here …",
      xmrSeedFormat: "polyseed",
      restoreHeight: 3_100_000,
      sidecarFile: LEGACY_XMR_SIDECAR_FILE,
    });
    expect(zph).toMatchObject({
      name: "Main · Zephyr",
      kind: "zph",
      seed: "twenty five word zephyr seed …",
      restoreHeight: 900_000,
      sidecarFile: LEGACY_ZPH_SIDECAR_FILE,
    });

    // All four share one group id, and every id is unique.
    const gids = new Set(v3.wallets.map((w) => w.groupId));
    expect(gids.size).toBe(1);
    const ids = v3.wallets.map((w) => w.id);
    expect(new Set(ids).size).toBe(4);
  });

  // INVERTED 2026-09-02. This test used to be named "carries a zano seed as a
  // top-level field, NOT a fourth WalletEntry" and asserted exactly that. Zano
  // is a `WalletKind` now: as a vault-wide field it was shared by every
  // context, so switching wallet kept the same Zano wallet, `switchWallet` had
  // to carry it across by hand, and there was no removal path for it at all.
  it("promotes a zano seed to a fourth WalletEntry in the same group", () => {
    const v3 = migrateV2ToV3(fullV2(), det());
    expect(v3.wallets).toHaveLength(4);
    const zano = v3.wallets.find((w) => w.kind === "zano");
    expect(zano).toBeDefined();
    expect(zano!.seed).toBe("twenty six word zano seed …");
    expect(zano!.zanoSeedPassphrase).toBe("hunter2");
    // Same group as bip39/xmr/zph, so it travels with the context.
    expect(zano!.groupId).toBe(v3.wallets[0].groupId);
    // Keeps the single fixed filename Zano used before the promotion, so an
    // existing on-disk wallet is reused rather than resynced.
    expect(zano!.sidecarFile).toBe(LEGACY_ZANO_SIDECAR_FILE);
    // The top-level field is no longer written.
    expect(v3.zanoSeed).toBeUndefined();
  });

  it("omits a zano entry entirely when the v2 vault has no zano seed", () => {
    const v2: VaultPayload = { v: 2, bip39: "m", xmrSeed: null };
    const v3 = migrateV2ToV3(v2, det());
    expect(v3.wallets.find((w) => w.kind === "zano")).toBeUndefined();
    expect(v3.zanoSeed).toBeUndefined();
  });

  it("does not treat an empty-string zano seed as present", () => {
    const v2: VaultPayload = { v: 2, bip39: "m", xmrSeed: null, zanoSeed: "" };
    const v3 = migrateV2ToV3(v2, det());
    expect(v3.wallets.find((w) => w.kind === "zano")).toBeUndefined();
    expect(v3.zanoSeed).toBeUndefined();
  });

  it("migrates a bip39-only vault to a single entry", () => {
    const v2: VaultPayload = { v: 2, bip39: "just the mnemonic", xmrSeed: null };
    const v3 = migrateV2ToV3(v2, det());
    expect(v3.wallets).toHaveLength(1);
    expect(bip39Of(v3)!.seed).toBe("just the mnemonic");
    expect(xmrOf(v3)).toBeUndefined();
    expect(zphOf(v3)).toBeUndefined();
  });

  it("migrates bip39 + xmr but no zph", () => {
    const v2: VaultPayload = {
      v: 2,
      bip39: "m",
      xmrSeed: "x",
      xmrSeedFormat: "legacy",
      xmrRestoreHeight: 42,
    };
    const v3 = migrateV2ToV3(v2, det());
    expect(v3.wallets).toHaveLength(2);
    expect(xmrOf(v3)!.xmrSeedFormat).toBe("legacy");
    expect(zphOf(v3)).toBeUndefined();
  });

  it("carries the deprecated devFeeAcknowledgedAt through", () => {
    const v3 = migrateV2ToV3({ ...fullV2(), devFeeAcknowledgedAt: 12345 }, det());
    expect(v3.legacyDevFeeAcknowledgedAt).toBe(12345);
  });

  it("normalizes a missing xmr restore height to null", () => {
    const v2: VaultPayload = { v: 2, bip39: "m", xmrSeed: "x" };
    const v3 = migrateV2ToV3(v2, det());
    expect(xmrOf(v3)!.restoreHeight).toBeNull();
  });

  it("does not treat an empty-string xmr seed as an XMR wallet", () => {
    const v2: VaultPayload = { v: 2, bip39: "m", xmrSeed: "" };
    const v3 = migrateV2ToV3(v2, det());
    expect(v3.wallets).toHaveLength(1);
    expect(xmrOf(v3)).toBeUndefined();
  });
});

describe("projectV3ToV2 — round-trips the primary group", () => {
  it("recovers every flat field from a migrated full vault", () => {
    const original = fullV2();
    const flat = projectV3ToV2(migrateV2ToV3(original, det()));
    expect(flat.bip39).toBe(original.bip39);
    expect(flat.xmrSeed).toBe(original.xmrSeed);
    expect(flat.xmrSeedFormat).toBe(original.xmrSeedFormat);
    expect(flat.xmrRestoreHeight).toBe(original.xmrRestoreHeight);
    expect(flat.zphSeed).toBe(original.zphSeed);
    expect(flat.zphRestoreHeight).toBe(original.zphRestoreHeight);
    expect(flat.zanoSeed).toBe(original.zanoSeed);
    expect(flat.zanoSeedPassphrase).toBe(original.zanoSeedPassphrase);
    expect(flat.derivationChoice).toEqual(original.derivationChoice);
  });

  it("round-trips the devFee ack", () => {
    const flat = projectV3ToV2(
      migrateV2ToV3({ ...fullV2(), devFeeAcknowledgedAt: 999 }, det())
    );
    expect(flat.devFeeAcknowledgedAt).toBe(999);
  });

  it("projects a bip39-only vault with null xmr/zph/zano seeds", () => {
    const v3 = migrateV2ToV3({ v: 2, bip39: "solo", xmrSeed: null }, det());
    const flat = projectV3ToV2(v3);
    expect(flat.xmrSeed).toBeNull();
    expect(flat.zphSeed).toBeNull();
    expect(flat.zanoSeed).toBeNull();
    expect(flat.bip39).toBe("solo");
  });
});

describe("mergeFlatIntoV3 — the legacy write path", () => {
  it("creates a fresh v3 when there is no existing vault", () => {
    const v3 = mergeFlatIntoV3(fullV2(), null, det());
    expect(v3.v).toBe(3);
    expect(v3.wallets).toHaveLength(4); // bip39 + xmr + zph + zano
    expect(new Set(v3.wallets.map((w) => w.groupId)).size).toBe(1);
  });

  it("preserves entry ids + createdAt across a derivation-choice change", () => {
    const existing = migrateV2ToV3(fullV2(), det());
    const bip39Id = bip39Of(existing)!.id;
    const xmrId = xmrOf(existing)!.id;

    // Simulate handleChangeSolanaDerivation: project → tweak → merge back.
    const flat = projectV3ToV2(existing);
    flat.derivationChoice = { ...flat.derivationChoice!, solana: "exodus" };
    const next = mergeFlatIntoV3(flat, existing, { now: NOW + 1, genId: idGen() });

    expect(bip39Of(next)!.id).toBe(bip39Id); // id stable
    expect(bip39Of(next)!.createdAt).toBe(NOW); // createdAt stable (not NOW+1)
    expect(bip39Of(next)!.derivationChoice!.solana).toBe("exodus"); // change applied
    expect(xmrOf(next)!.id).toBe(xmrId); // xmr untouched
  });

  it("removes the xmr entry when the flat xmr seed is cleared (forget XMR)", () => {
    const existing = migrateV2ToV3(fullV2(), det());
    const flat = projectV3ToV2(existing);
    flat.xmrSeed = null;
    flat.xmrSeedFormat = undefined;
    flat.xmrRestoreHeight = null;
    const next = mergeFlatIntoV3(flat, existing, det());
    expect(xmrOf(next)).toBeUndefined();
    expect(zphOf(next)).toBeDefined(); // zph untouched
    expect(bip39Of(next)!.id).toBe(bip39Of(existing)!.id); // bip39 id preserved
  });

  it("adds an xmr entry when a seed is imported post-unlock (import XMR)", () => {
    const existing = migrateV2ToV3({ v: 2, bip39: "m", xmrSeed: null }, det());
    const bip39Id = bip39Of(existing)!.id;
    const flat = projectV3ToV2(existing);
    flat.xmrSeed = "freshly imported polyseed";
    flat.xmrSeedFormat = "polyseed";
    flat.xmrRestoreHeight = 3_200_000;
    const next = mergeFlatIntoV3(flat, existing, { now: NOW + 5, genId: idGen() });

    const xmr = xmrOf(next)!;
    expect(xmr.seed).toBe("freshly imported polyseed");
    expect(xmr.sidecarFile).toBe(LEGACY_XMR_SIDECAR_FILE);
    expect(xmr.createdAt).toBe(NOW + 5); // new entry → new clock
    expect(bip39Of(next)!.id).toBe(bip39Id); // existing bip39 preserved
  });

  it("clears zano when the flat seed is cleared (forget Zano)", () => {
    const existing = migrateV2ToV3(fullV2(), det());
    const flat = projectV3ToV2(existing);
    flat.zanoSeed = null;
    flat.zanoSeedPassphrase = undefined;
    const next = mergeFlatIntoV3(flat, existing, det());
    expect(next.zanoSeed).toBeUndefined();
    expect(next.zanoSeedPassphrase).toBeUndefined();
    expect(xmrOf(next)).toBeDefined(); // xmr/zph untouched
    expect(zphOf(next)).toBeDefined();
  });

  it("sets zano when a seed is imported post-unlock (import Zano)", () => {
    const existing = migrateV2ToV3({ v: 2, bip39: "m", xmrSeed: null }, det());
    const flat = projectV3ToV2(existing);
    flat.zanoSeed = "freshly imported zano seed";
    flat.zanoSeedPassphrase = "newpass";
    const next = mergeFlatIntoV3(flat, existing, det());
    // Lands as a real entry now, in the same group as the bip39 wallet, so it
    // belongs to THIS context rather than the whole vault.
    expect(next.wallets).toHaveLength(2);
    const zano = next.wallets.find((w) => w.kind === "zano")!;
    expect(zano.seed).toBe("freshly imported zano seed");
    expect(zano.zanoSeedPassphrase).toBe("newpass");
    expect(zano.groupId).toBe(next.wallets[0].groupId);
    // Still round-trips through the flat projection the rest of the app reads.
    expect(projectV3ToV2(next).zanoSeed).toBe("freshly imported zano seed");
    expect(projectV3ToV2(next).zanoSeedPassphrase).toBe("newpass");
  });

  it("does not persist an empty-string zano passphrase", () => {
    const existing = migrateV2ToV3({ v: 2, bip39: "m", xmrSeed: null }, det());
    const flat = projectV3ToV2(existing);
    flat.zanoSeed = "ordinary seed, no passphrase";
    flat.zanoSeedPassphrase = "";
    const next = mergeFlatIntoV3(flat, existing, det());
    expect(next.zanoSeed).toBe("ordinary seed, no passphrase");
    expect(next.zanoSeedPassphrase).toBeUndefined();
  });

  it("preserves wallets outside the primary group (Phase-2 forward-safety)", () => {
    const existing = migrateV2ToV3(fullV2(), det());
    const foreign: WalletEntry = {
      id: "foreign-1",
      name: "Trading",
      kind: "bip39",
      seed: "another wallet",
      createdAt: NOW,
      groupId: "other-group",
    };
    existing.wallets.push(foreign);

    const next = mergeFlatIntoV3(projectV3ToV2(existing), existing, det());
    expect(next.wallets.find((w) => w.id === "foreign-1")).toEqual(foreign);
  });

  it("preserves balanceCache, lastActiveWalletId, and legacy devFee ack", () => {
    const existing = migrateV2ToV3(fullV2(), det());
    existing.lastActiveWalletId = "id-2";
    existing.legacyDevFeeAcknowledgedAt = 777;
    existing.balanceCache = {
      "id-2:monero": { byChain: { monero: { balance: "1.5" } }, syncedAt: NOW },
    };
    const next = mergeFlatIntoV3(projectV3ToV2(existing), existing, det());
    expect(next.lastActiveWalletId).toBe("id-2");
    expect(next.legacyDevFeeAcknowledgedAt).toBe(777);
    expect(next.balanceCache).toEqual(existing.balanceCache);
  });
});

describe("multi-wallet CRUD helpers", () => {
  it("normalizeSeed trims, collapses whitespace, lowercases", () => {
    expect(normalizeSeed("  Abandon   ABANDON  about \n")).toBe("abandon abandon about");
  });

  it("findDuplicateSeed matches regardless of case/whitespace", () => {
    const v3 = migrateV2ToV3(fullV2(), det());
    expect(findDuplicateSeed(v3, "  ABANDON abandon   abandon ABOUT ")).toBeDefined();
    expect(findDuplicateSeed(v3, "totally different seed")).toBeUndefined();
  });

  it("addWalletEntry appends an independent bip39 wallet in its own group", () => {
    const v3 = migrateV2ToV3({ v: 2, bip39: "primary", xmrSeed: null }, det());
    const primaryGroup = v3.wallets[0].groupId;
    const { v3: next, entry } = addWalletEntry(
      v3,
      { kind: "bip39", seed: "second wallet seed", name: "Trading" },
      { now: NOW, genId: idGen() }
    );
    expect(next.wallets).toHaveLength(2);
    expect(entry.name).toBe("Trading");
    expect(entry.kind).toBe("bip39");
    expect(entry.groupId).not.toBe(primaryGroup); // standalone → new group
    expect(entry.sidecarFile).toBeUndefined(); // bip39 has no sidecar file
  });

  it("addWalletEntry gives a NEW xmr wallet a per-wallet sidecar file (not the legacy name)", () => {
    const v3 = migrateV2ToV3(fullV2(), det()); // primary xmr uses pwnda-active
    const { entry } = addWalletEntry(
      v3,
      { kind: "xmr", seed: "second monero seed", name: "Cold XMR", xmrSeedFormat: "legacy", restoreHeight: 3_300_000 },
      { now: NOW, genId: idGen() }
    );
    expect(entry.sidecarFile).toBe(`pwnda-xmr-${entry.id}`);
    expect(entry.sidecarFile).not.toBe(LEGACY_XMR_SIDECAR_FILE);
    expect(entry.xmrSeedFormat).toBe("legacy");
    expect(entry.restoreHeight).toBe(3_300_000);
  });

  it("renameWalletEntry updates only the target", () => {
    const v3 = migrateV2ToV3(fullV2(), det());
    const xmrId = v3.wallets.find((w) => w.kind === "xmr")!.id;
    const next = renameWalletEntry(v3, xmrId, "My Monero");
    expect(next.wallets.find((w) => w.id === xmrId)!.name).toBe("My Monero");
    expect(next.wallets.find((w) => w.kind === "bip39")!.name).toBe("Main");
  });

  it("removeWalletEntry drops the entry and returns it for cleanup", () => {
    const v3 = migrateV2ToV3(fullV2(), det());
    const xmr = v3.wallets.find((w) => w.kind === "xmr")!;
    const { v3: next, removed, wasLast } = removeWalletEntry(v3, xmr.id);
    expect(next.wallets).toHaveLength(3); // bip39 + zph + zano remain
    expect(removed).toEqual(xmr);
    expect(wasLast).toBe(false);
  });

  it("removeWalletEntry flags wasLast when the vault empties", () => {
    const v3 = migrateV2ToV3({ v: 2, bip39: "solo", xmrSeed: null }, det());
    const { wasLast } = removeWalletEntry(v3, v3.wallets[0].id);
    expect(wasLast).toBe(true);
  });

  it("removeWalletEntry resets active context to 'all' when removing the active wallet", () => {
    const v3 = migrateV2ToV3(fullV2(), det());
    const xmrId = v3.wallets.find((w) => w.kind === "xmr")!.id;
    v3.lastActiveWalletId = xmrId;
    const { v3: next } = removeWalletEntry(v3, xmrId);
    expect(next.lastActiveWalletId).toBe("all");
  });

  it("sidecarFileForEntry returns the stored file, deriving one if absent", () => {
    const migrated = migrateV2ToV3(fullV2(), det());
    const xmr = migrated.wallets.find((w) => w.kind === "xmr")!;
    expect(sidecarFileForEntry(xmr)).toBe(LEGACY_XMR_SIDECAR_FILE); // primary keeps legacy
    expect(sidecarFileForEntry({ ...xmr, sidecarFile: undefined })).toBe(
      newSidecarFile("xmr", xmr.id)
    );
    expect(sidecarFileForEntry(migrated.wallets[0])).toBeUndefined(); // bip39
  });

  it("isPrimaryBip39 identifies the first bip39 wallet", () => {
    const v3 = addWalletEntry(
      migrateV2ToV3(fullV2(), det()),
      { kind: "bip39", seed: "second", name: "Trading" },
      { now: NOW, genId: idGen() }
    ).v3;
    const primary = v3.wallets.find((w) => w.kind === "bip39" && w.name === "Main")!;
    const secondary = v3.wallets.find((w) => w.name === "Trading")!;
    expect(isPrimaryBip39(v3, primary.id)).toBe(true);
    expect(isPrimaryBip39(v3, secondary.id)).toBe(false);
  });
});

describe("single-chain kinds — privateKey + watch (Phantom-parity)", () => {
  it("addWalletEntry(privateKey) stores chain + address, no sidecar file", () => {
    const v3 = migrateV2ToV3({ v: 2, bip39: "m", xmrSeed: null }, det());
    const { entry } = addWalletEntry(
      v3,
      { kind: "privateKey", seed: "0xabc…rawkey", name: "SOL hot", chain: "solana", address: "SoLaddr111" },
      { now: NOW, genId: idGen() }
    );
    expect(entry.kind).toBe("privateKey");
    expect(entry.chain).toBe("solana");
    expect(entry.address).toBe("SoLaddr111");
    expect(entry.seed).toBe("0xabc…rawkey"); // key held in seed
    expect(sidecarFileForEntry(entry)).toBeUndefined();
  });

  it("addWalletEntry(watch) stores chain + address with an empty seed", () => {
    const v3 = migrateV2ToV3({ v: 2, bip39: "m", xmrSeed: null }, det());
    const { entry } = addWalletEntry(
      v3,
      { kind: "watch", seed: "", name: "Vitalik", chain: "ethereum", address: "0xd8dA6BF" },
      { now: NOW, genId: idGen() }
    );
    expect(entry.kind).toBe("watch");
    expect(entry.chain).toBe("ethereum");
    expect(entry.address).toBe("0xd8dA6BF");
    expect(entry.seed).toBe(""); // no key material
    expect(sidecarFileForEntry(entry)).toBeUndefined();
  });

  it("isSingleChainKind flags privateKey + watch (not bip39/xmr/zph)", () => {
    expect(isSingleChainKind("privateKey")).toBe(true);
    expect(isSingleChainKind("watch")).toBe(true);
    expect(isSingleChainKind("bip39")).toBe(false);
    expect(isSingleChainKind("xmr")).toBe(false);
    expect(isSingleChainKind("zph")).toBe(false);
  });

  it("findDuplicateAddress matches (chain,address) case-insensitively", () => {
    let v3 = migrateV2ToV3({ v: 2, bip39: "m", xmrSeed: null }, det());
    v3 = addWalletEntry(v3, { kind: "watch", seed: "", name: "W", chain: "ethereum", address: "0xABCdef" }, { now: NOW, genId: idGen() }).v3;
    expect(findDuplicateAddress(v3, "ethereum", "0xabcDEF")).toBeDefined(); // case-insensitive
    expect(findDuplicateAddress(v3, "bitcoin", "0xABCdef")).toBeUndefined(); // different chain
    expect(findDuplicateAddress(v3, "ethereum", "0xother")).toBeUndefined();
  });

  it("two watch entries don't collide as duplicate seeds (both empty)", () => {
    let v3 = migrateV2ToV3({ v: 2, bip39: "m", xmrSeed: null }, det());
    v3 = addWalletEntry(v3, { kind: "watch", seed: "", name: "A", chain: "ethereum", address: "0xa" }, { now: NOW, genId: idGen() }).v3;
    expect(findDuplicateSeed(v3, "")).toBeUndefined(); // empty seed is never a duplicate
  });

  it("a privateKey / watch wallet is its own switchable context", () => {
    const gen = idGen();
    let v3 = migrateV2ToV3(fullV2(), { now: NOW, genId: gen });
    v3 = addWalletEntry(v3, { kind: "privateKey", seed: "k", name: "PK", chain: "solana", address: "sol1" }, { now: NOW + 10, genId: gen }).v3;
    v3 = addWalletEntry(v3, { kind: "watch", seed: "", name: "Watched", chain: "bitcoin", address: "bc1watch" }, { now: NOW + 20, genId: gen }).v3;
    const contexts = listContexts(v3);
    expect(contexts.map((c) => c.name)).toEqual(["Main", "PK", "Watched"]);
    const pk = contexts.find((c) => c.name === "PK")!;
    expect(pk.members).toHaveLength(1);
    expect(pk.id).toBe(pk.members[0].id);
  });
});

describe("wallet contexts (Phase 3 switcher model)", () => {
  it("groups the primary bundle into ONE context, standalones separate", () => {
    const contexts = listContexts(multiV3());
    // Main (bip39+xmr+zph+zano) + Trading + Cold = 3 contexts.
    expect(contexts).toHaveLength(3);
    expect(contexts[0].name).toBe("Main"); // primary first
    expect(contexts[0].members).toHaveLength(4);
    expect(contexts.map((c) => c.name)).toEqual(["Main", "Trading", "Cold"]);
  });

  it("context representative is the bip39 member, and members are bip39-first", () => {
    const main = listContexts(multiV3())[0];
    const bip39 = main.members.find((m) => m.kind === "bip39")!;
    expect(main.id).toBe(bip39.id);
    expect(main.members[0].kind).toBe("bip39");
  });

  it("a standalone xmr wallet is its own context repped by the xmr entry", () => {
    const cold = listContexts(multiV3()).find((c) => c.name === "Cold")!;
    expect(cold.members).toHaveLength(1);
    expect(cold.members[0].kind).toBe("xmr");
    expect(cold.id).toBe(cold.members[0].id);
  });

  it("contextForWallet resolves any member to its context; 'all' → primary", () => {
    const v3 = multiV3();
    const zph = v3.wallets.find((w) => w.kind === "zph")!;
    expect(contextForWallet(v3, zph.id)!.name).toBe("Main");
    expect(contextForWallet(v3, "all")!.name).toBe("Main");
    expect(contextForWallet(v3, "nonexistent")!.name).toBe("Main"); // fallback
  });

  it("memberOfKind pulls the right seed out of a context", () => {
    const main = listContexts(multiV3())[0];
    expect(memberOfKind(main, "xmr")!.name).toBe("Main · Monero");
    expect(memberOfKind(main, "zph")!.name).toBe("Main · Zephyr");
    const trading = listContexts(multiV3()).find((c) => c.name === "Trading")!;
    expect(memberOfKind(trading, "xmr")).toBeUndefined();
  });

  it("shouldShowSwitcher: hidden for a lone bundle, shown once a 2nd context exists", () => {
    // Migrated bundle alone = 1 context → hidden.
    expect(shouldShowSwitcher(migrateV2ToV3(fullV2(), det()))).toBe(false);
    // bip39-only single wallet = 1 context → hidden.
    expect(shouldShowSwitcher(migrateV2ToV3({ v: 2, bip39: "x", xmrSeed: null }, det()))).toBe(false);
    // With a standalone added → 3 contexts → shown.
    expect(shouldShowSwitcher(multiV3())).toBe(true);
  });
});

describe("save→load stability (project ∘ merge is idempotent on ids)", () => {
  it("keeps ids stable across repeated projection round-trips", () => {
    const v0 = migrateV2ToV3(fullV2(), det());
    const ids0 = v0.wallets.map((w) => w.id).sort();

    let cur = v0;
    for (let i = 0; i < 3; i++) {
      cur = mergeFlatIntoV3(projectV3ToV2(cur), cur, {
        now: NOW + i,
        genId: idGen(),
      });
    }
    const idsN = cur.wallets.map((w) => w.id).sort();
    expect(idsN).toEqual(ids0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The bug this suite exists to prevent, reported 2026-08-29:
//
//   "I imported a new wallet seed phrase to see my LTC address, however the app
//    still was displaying the main LTC address."
//
// Cause: every vault read/write projected the PRIMARY group. The switcher set a
// label, `handleUnlock` restored that label, and then derived from Main's seed —
// so the chip said "Wallet" while every address was Main's. These tests pin the
// wallet dimension that fixes it.
// ═══════════════════════════════════════════════════════════════════════════
describe("wallet-scoped projection (the wrong-wallet-address bug)", () => {
  it("projects the ACTIVE wallet's seed, not the primary group's", () => {
    const v3 = multiV3();
    const trading = listContexts(v3).find((c) => c.name === "Trading")!;
    const tradingSeed = memberOfKind(trading, "bip39")!.seed;
    const mainSeed = projectV3ToV2(v3).bip39;

    expect(tradingSeed).not.toBe(mainSeed); // fixture sanity

    const projected = projectV3ToV2(v3, trading.id);
    expect(projected.bip39).toBe(tradingSeed);
    expect(projected.bip39).not.toBe(mainSeed);
  });

  it("omitting the id keeps the old behaviour exactly (primary group)", () => {
    const v3 = multiV3();
    expect(projectV3ToV2(v3)).toEqual(projectV3ToV2(v3, "all"));
    expect(projectV3ToV2(v3).bip39).toBe(
      memberOfKind(listContexts(v3)[0], "bip39")!.seed
    );
  });

  it("an unknown id falls back to primary rather than throwing or emptying", () => {
    const v3 = multiV3();
    expect(projectV3ToV2(v3, "no-such-wallet").bip39).toBe(projectV3ToV2(v3).bip39);
    expect(groupIdForWallet(v3, "no-such-wallet")).toBe(groupIdForWallet(v3));
  });

  it("groupIdForWallet resolves any member of a bundle to that bundle", () => {
    const v3 = multiV3();
    const main = listContexts(v3)[0];
    for (const m of main.members) {
      expect(groupIdForWallet(v3, m.id)).toBe(main.groupId);
    }
  });

  it("a write targets the ACTIVE wallet and leaves the others untouched", () => {
    const v3 = multiV3();
    const trading = listContexts(v3).find((c) => c.name === "Trading")!;
    const mainBefore = projectV3ToV2(v3);

    // Simulate a derivation change made while on the imported wallet.
    const edited = { ...projectV3ToV2(v3, trading.id), bip39: NEW_SEED };
    const after = mergeFlatIntoV3(edited, v3, { activeWalletId: trading.id });

    // The active wallet took the write...
    expect(projectV3ToV2(after, trading.id).bip39).toBe(NEW_SEED);
    // ...and Main is untouched. Before the fix this clobbered Main.
    expect(projectV3ToV2(after).bip39).toBe(mainBefore.bip39);
    // No wallet was lost.
    expect(after.wallets).toHaveLength(v3.wallets.length);
  });

  it("a write with no id still targets primary (legacy callers unchanged)", () => {
    const v3 = multiV3();
    const trading = listContexts(v3).find((c) => c.name === "Trading")!;
    const tradingBefore = projectV3ToV2(v3, trading.id).bip39;

    const edited = { ...projectV3ToV2(v3), bip39: NEW_SEED };
    const after = mergeFlatIntoV3(edited, v3);

    expect(projectV3ToV2(after).bip39).toBe(NEW_SEED);
    expect(projectV3ToV2(after, trading.id).bip39).toBe(tradingBefore);
  });
});

const NEW_SEED =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("zano as a WalletKind (2026-09-02 promotion)", () => {
  it("gives an ADDED zano wallet its own sidecar file, not the legacy one", () => {
    const gen = idGen();
    let v3 = migrateV2ToV3(fullV2(), { now: NOW, genId: gen });
    const migrated = v3.wallets.find((w) => w.kind === "zano")!;
    // The migrated one keeps the single fixed name Zano used before, so the
    // existing on-disk wallet is reused with no rescan.
    expect(sidecarFileForEntry(migrated)).toBe(LEGACY_ZANO_SIDECAR_FILE);

    const added = addWalletEntry(
      v3,
      { kind: "zano", seed: "a second zano seed", name: "Cold Zano" },
      { now: NOW + 5, genId: gen },
    );
    v3 = added.v3;
    const second = v3.wallets.find((w) => w.kind === "zano" && w.id !== migrated.id)!;
    const file = sidecarFileForEntry(second)!;
    expect(file).not.toBe(LEGACY_ZANO_SIDECAR_FILE);
    expect(file).toBe(newSidecarFile("zano", second.id));
    // Zano's sidecar opens the file by name and writes siblings beside it, so
    // the extension is part of the filename (xmr/zph are extensionless).
    expect(file.endsWith(".zan")).toBe(true);
  });

  it("two zano wallets in different groups never share a file", () => {
    const gen = idGen();
    let v3 = migrateV2ToV3(fullV2(), { now: NOW, genId: gen });
    v3 = addWalletEntry(
      v3,
      { kind: "zano", seed: "another zano seed", name: "Zano B" },
      { now: NOW + 5, genId: gen },
    ).v3;
    const files = v3.wallets
      .filter((w) => w.kind === "zano")
      .map((w) => sidecarFileForEntry(w));
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
  });

  it("a zano wallet is a switchable context member, not a vault-wide field", () => {
    const v3 = migrateV2ToV3(fullV2(), det());
    const ctx = listContexts(v3)[0];
    expect(memberOfKind(ctx, "zano")?.seed).toBe("twenty six word zano seed …");
    // The old top-level field is gone; nothing reads a vault-wide zano seed.
    expect(v3.zanoSeed).toBeUndefined();
  });
});

/**
 * The legacy vault-wide `zanoSeed` must reach the PRIMARY context and nothing
 * else.
 *
 * Zano was promoted to a `WalletEntry` on 2026-09-02 precisely so a second
 * context could not show the first one's Zano wallet. Both read paths kept
 * `?? v3.zanoSeed` for upgrade compatibility, unscoped — so a vault that still
 * carries the top-level field handed the same wallet to every profile, which is
 * the fault the promotion was for, through the other door. Reported live on
 * 2026-09-05: "why can I see my zano wallet when I selected a different
 * profile?"
 *
 * Fifty-three tests passed over that, because every one of them projected the
 * PRIMARY context — where the fallback is correct — and none projected a
 * second one. That is the gap this closes.
 */
describe("the legacy vault-wide zanoSeed is scoped to its own context", () => {
  /** A v3 vault with TWO contexts and the pre-promotion top-level Zano seed. */
  function legacyTopLevelZano(): VaultPayloadV3 {
    const gen = idGen();
    // Migrate WITHOUT a zano seed, so no zano entry exists...
    const v2 = { ...fullV2() };
    delete (v2 as { zanoSeed?: string | null }).zanoSeed;
    delete (v2 as { zanoSeedPassphrase?: string }).zanoSeedPassphrase;
    let v3 = migrateV2ToV3(v2, { now: NOW, genId: gen });
    v3 = addWalletEntry(
      v3,
      { kind: "bip39", seed: "trading seed", name: "Trading" },
      { now: NOW + 10, genId: gen },
    ).v3;
    // ...then put the seed back where a pre-promotion build left it.
    return { ...v3, zanoSeed: "twenty six word zano seed …", zanoSeedPassphrase: "hunter2" };
  }

  it("gives it to the primary context", () => {
    const v3 = legacyTopLevelZano();
    const main = listContexts(v3)[0];
    expect(legacyZanoSeedFor(v3, main.groupId)).toEqual({
      seed: "twenty six word zano seed …",
      passphrase: "hunter2",
    });
    expect(projectV3ToV2(v3, main.id).zanoSeed).toBe("twenty six word zano seed …");
  });

  it("does NOT give it to any other context", () => {
    const v3 = legacyTopLevelZano();
    const trading = listContexts(v3).find((c) => c.name === "Trading")!;
    expect(trading).toBeDefined();
    expect(legacyZanoSeedFor(v3, trading.groupId)).toBeNull();
    // The projection is what the app actually reads. Before 2026-09-05 this
    // returned the primary context's Zano seed.
    const flat = projectV3ToV2(v3, trading.id);
    expect(flat.zanoSeed).toBeNull();
    expect(flat.zanoSeedPassphrase).toBeUndefined();
    // ...while the OTHER coins still come from the context being projected,
    // so this is a scope fix and not a blanket "no zano anywhere".
    expect(flat.bip39).toBe("trading seed");
  });

  it("is inert once the seed has been promoted to an entry", () => {
    // A migrated vault carries the entry and no top-level field, so the
    // fallback must never fire — for any context.
    const v3 = multiV3();
    expect(v3.zanoSeed ?? null).toBeNull();
    for (const ctx of listContexts(v3)) {
      expect(legacyZanoSeedFor(v3, ctx.groupId)).toBeNull();
    }
    // ...and the promoted entry still reaches its own context.
    const main = listContexts(v3)[0];
    expect(projectV3ToV2(v3, main.id).zanoSeed).toBe("twenty six word zano seed …");
  });

  it("still answers for a whole-vault read, which is the primary view", () => {
    const v3 = legacyTopLevelZano();
    expect(legacyZanoSeedFor(v3, undefined)).not.toBeNull();
    expect(legacyZanoSeedFor({ ...v3, zanoSeed: null }, undefined)).toBeNull();
  });
});
