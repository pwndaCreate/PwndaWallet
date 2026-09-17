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
  primaryGroupSlotFor,
  isInActiveContext,
  LEGACY_XMR_SIDECAR_FILE,
  LEGACY_ZPH_SIDECAR_FILE,
  LEGACY_ZANO_SIDECAR_FILE,
  type VaultPayload,
  type VaultPayloadV3,
  type WalletEntry,
  legacyZanoSeedFor,
  addXelisWalletToContext,
  flatSeedRefusal,
  repairSharedSidecarFiles,
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

  // 2026-09-13: Settings ▸ Wallets could not add a Zano wallet. addWalletEntry
  // gave xmr/zph a per-wallet sidecar file and dropped zano into the
  // single-chain branch (chain/address, no file) — so a second Zano wallet
  // would have opened the legacy fixed-name file, i.e. the FIRST wallet's.
  it("addWalletEntry gives a NEW zano wallet its own sidecar file and keeps its passphrase", () => {
    const v3 = migrateV2ToV3(fullV2(), det());
    const { entry } = addWalletEntry(
      v3,
      { kind: "zano", seed: "second zano seed", name: "Cold ZANO", zanoSeedPassphrase: "pw" },
      { now: NOW, genId: idGen() }
    );
    expect(entry.sidecarFile).toBe(`pwnda-zano-${entry.id}.zan`);
    expect(entry.sidecarFile).not.toBe(LEGACY_ZANO_SIDECAR_FILE);
    expect(entry.zanoSeedPassphrase).toBe("pw");
    expect(entry.chain).toBeUndefined();
    expect(entry.address).toBeUndefined();

    // No passphrase → the field is absent, not "" (an ordinary seed).
    const plain = addWalletEntry(v3, { kind: "zano", seed: "third zano seed", name: "Z" }, { now: NOW, genId: idGen() }).entry;
    expect(plain.zanoSeedPassphrase).toBeUndefined();
  });

  // 2026-09-13 (operator, Linux): Main's Monero wallet was removed and the seed
  // re-added in Settings ▸ Wallets. It became a standalone wallet in its own
  // group, unlock opened the primary group (no Monero), nothing was open in the
  // wallet-rpc the swap node shares, and the node's XMR dot read
  // "'NoneType' object has no attribute 'update'".
  describe("a re-added Monero / Zephyr / Zano wallet fills the primary group's empty slot", () => {
    function withoutMainXmr(): VaultPayloadV3 {
      const v3 = migrateV2ToV3(fullV2(), det());
      const mainXmr = v3.wallets.find((w) => w.kind === "xmr")!;
      return removeWalletEntry(v3, mainXmr.id).v3;
    }

    it("positive control: a primary group that still has Monero offers no slot", () => {
      const v3 = migrateV2ToV3(fullV2(), det());
      expect(primaryGroupSlotFor(v3, "xmr")).toBeUndefined();
      expect(primaryGroupSlotFor(v3, "zph")).toBeUndefined();
    });

    it("the empty slot is the primary group, and only for the missing kind", () => {
      const v3 = withoutMainXmr();
      const primaryGid = v3.wallets.find((w) => w.kind === "bip39")!.groupId;
      expect(primaryGroupSlotFor(v3, "xmr")).toBe(primaryGid);
      expect(primaryGroupSlotFor(v3, "zph")).toBeUndefined();
      expect(primaryGroupSlotFor(v3, "bip39")).toBeUndefined();
    });

    it("an entry added into the slot is what unlock projects, with its own file", () => {
      let v3 = withoutMainXmr();
      expect(projectV3ToV2(v3, "all").xmrSeed).toBeNull();
      const { v3: next, entry } = addWalletEntry(
        v3,
        { kind: "xmr", seed: "re-added seed", name: "Monero wallet", xmrSeedFormat: "legacy", groupId: primaryGroupSlotFor(v3, "xmr") },
        { now: NOW + 1, genId: idGen() }
      );
      v3 = next;
      expect(projectV3ToV2(v3, "all").xmrSeed).toBe("re-added seed");
      const ctx = contextForWallet(v3, "all");
      expect(memberOfKind(ctx, "xmr")?.id).toBe(entry.id);
      // Its OWN file, not the removed wallet's legacy name, whose files may
      // still be on disk.
      expect(sidecarFileForEntry(entry)).toBe(`pwnda-xmr-${entry.id}`);
      expect(isInActiveContext(v3, entry)).toBe(true);
    });

    it("a wallet in another context is not the open session", () => {
      const v3 = multiV3(); // Cold XMR is standalone; the active context is Main
      const cold = v3.wallets.find((w) => w.name === "Cold")!;
      const mainXmr = v3.wallets.find((w) => w.kind === "xmr" && w.name !== "Cold")!;
      expect(isInActiveContext(v3, cold)).toBe(false);
      expect(isInActiveContext(v3, mainXmr)).toBe(true);
      expect(isInActiveContext({ ...v3, lastActiveWalletId: cold.id }, cold)).toBe(true);
    });
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

/**
 * Xelis as a WalletKind (2026-09-15).
 *
 * Xelis is an entry from its first release, so it has none of Zano's history:
 * no vault-wide seed field, no legacy fixed filename, nothing to migrate. It
 * meets one hazard Zano never did, because Zano is in the flat projection and
 * Xelis is not: `saveVault(flat)` rebuilds the open context's group from
 * bip39/xmr/zph/zano, so an entry the flat shape cannot describe would be
 * dropped by the next unrelated save (a Solana derivation change, a Monero
 * import). The first test failed against `mergeFlatIntoV3` as it stood before
 * this change.
 */
const XELIS_SEED = "a twenty-five word xelis seed …";

/** Counter-based ids with a prefix, so two generators in one test never collide. */
function prefixedGen(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe("xelis as a WalletKind (2026-09-15)", () => {
  /**
   * Main (bip39 + xmr + zph + zano) with a Xelis wallet in the same group.
   *
   * The group is named explicitly, NOT taken from `primaryGroupSlotFor`. The
   * first version of this helper used the slot, which returned undefined for
   * `xelis` before this change, so the entry landed in a group of its own and
   * the flat-save test below passed against the very merge that drops it.
   */
  function mainWithXelis(): { v3: VaultPayloadV3; xelis: WalletEntry } {
    const gen = idGen();
    const base = migrateV2ToV3(fullV2(), { now: NOW, genId: gen });
    const primaryGid = base.wallets.find((w) => w.kind === "bip39")!.groupId;
    const { v3, entry } = addWalletEntry(
      base,
      { kind: "xelis", seed: XELIS_SEED, name: "Main · Xelis", groupId: primaryGid },
      { now: NOW + 1, genId: gen },
    );
    return { v3, xelis: entry };
  }

  it("a flat save keeps the open context's Xelis wallet in the vault", () => {
    const { v3, xelis } = mainWithXelis();
    // Precondition: the Xelis wallet is in the group the save rebuilds.
    expect(isInActiveContext(v3, xelis)).toBe(true);
    // A derivation change: the kind of save that knows nothing about Xelis.
    const flat: VaultPayload = {
      ...projectV3ToV2(v3),
      derivationChoice: { bitcoin: "bip44", solana: "standard", cardano: "cip1852" },
    };
    const after = mergeFlatIntoV3(flat, v3, { now: NOW + 2, genId: idGen() });
    expect(after.wallets.find((w) => w.id === xelis.id)).toEqual(xelis);
    expect(after.wallets).toHaveLength(v3.wallets.length);
  });

  it("the same holds for a save into a context that is not primary", () => {
    const gen = prefixedGen("t");
    let v3 = multiV3();
    const trading = listContexts(v3).find((c) => c.name === "Trading")!;
    const added = addWalletEntry(
      v3,
      { kind: "xelis", seed: XELIS_SEED, name: "Trading · Xelis", groupId: trading.groupId },
      { now: NOW + 40, genId: gen },
    );
    v3 = added.v3;
    const flat = { ...projectV3ToV2(v3, trading.id), bip39: NEW_SEED };
    const after = mergeFlatIntoV3(flat, v3, { activeWalletId: trading.id, genId: gen });
    expect(after.wallets.find((w) => w.id === added.entry.id)).toEqual(added.entry);
    expect(after.wallets).toHaveLength(v3.wallets.length);
  });

  it("adding Xelis needs no migration: v stays 3 and nothing else changes", () => {
    const before = migrateV2ToV3(fullV2(), det());
    const { v3: after } = addWalletEntry(
      before,
      { kind: "xelis", seed: XELIS_SEED, name: "Xelis wallet" },
      { now: NOW + 1, genId: prefixedGen("x") },
    );
    expect(after.v).toBe(3);
    expect(after.wallets.slice(0, before.wallets.length)).toEqual(before.wallets);
    // The flat working shape has no Xelis field, so every existing reader of
    // it sees exactly what it saw before.
    expect(projectV3ToV2(after)).toEqual(projectV3ToV2(before));
    expect(Object.keys(projectV3ToV2(after)).some((k) => /xelis/i.test(k))).toBe(false);
    // The store persists `JSON.stringify(v3)`; the entry survives that as-is.
    expect(JSON.parse(JSON.stringify(after))).toEqual(after);
    // No top-level seed field was introduced for it.
    expect(Object.keys(after).some((k) => /xelis/i.test(k))).toBe(false);
  });

  it("every Xelis wallet gets its own wallet directory, and two never share one", () => {
    const gen = idGen();
    const v3 = migrateV2ToV3(fullV2(), { now: NOW, genId: gen });
    const a = addWalletEntry(v3, { kind: "xelis", seed: "xelis seed a", name: "A" }, { now: NOW + 1, genId: gen });
    const b = addWalletEntry(a.v3, { kind: "xelis", seed: "xelis seed b", name: "B" }, { now: NOW + 2, genId: gen });
    expect(a.entry.sidecarFile).toBe(`pwnda-xelis-${a.entry.id}`);
    expect(b.entry.sidecarFile).toBe(`pwnda-xelis-${b.entry.id}`);
    expect(a.entry.sidecarFile).not.toBe(b.entry.sidecarFile);
    // A directory name, so no extension (Zano's is a `.zan` file).
    expect(a.entry.sidecarFile).not.toContain(".");
    expect(sidecarFileForEntry(a.entry)).toBe(a.entry.sidecarFile);
    expect(sidecarFileForEntry({ ...a.entry, sidecarFile: undefined })).toBe(
      newSidecarFile("xelis", a.entry.id),
    );
    // A seed wallet, not the single-chain branch.
    expect(a.entry.chain).toBeUndefined();
    expect(a.entry.address).toBeUndefined();
  });

  it("offers the primary group's empty Xelis slot, and no slot once it is filled", () => {
    const base = migrateV2ToV3(fullV2(), det());
    const primaryGid = base.wallets.find((w) => w.kind === "bip39")!.groupId;
    expect(primaryGroupSlotFor(base, "xelis")).toBe(primaryGid);
    const { v3, xelis } = mainWithXelis();
    expect(xelis.groupId).toBe(v3.wallets.find((w) => w.kind === "bip39")!.groupId);
    expect(primaryGroupSlotFor(v3, "xelis")).toBeUndefined();
  });

  it("switch: the Xelis wallet belongs to its own context only", () => {
    const { v3: withMain, xelis } = mainWithXelis();
    const v3 = addWalletEntry(
      withMain,
      { kind: "bip39", seed: "trading seed", name: "Trading" },
      { now: NOW + 3, genId: prefixedGen("t") },
    ).v3;
    expect(memberOfKind(contextForWallet(v3, "all"), "xelis")?.id).toBe(xelis.id);
    const trading = listContexts(v3).find((c) => c.name === "Trading")!;
    expect(memberOfKind(trading, "xelis")).toBeUndefined();
  });

  it("remove: drops the entry, returns it for teardown, and says whether it was open", () => {
    const { v3, xelis } = mainWithXelis();
    expect(isInActiveContext(v3, xelis)).toBe(true);
    const { v3: next, removed, wasLast } = removeWalletEntry(v3, xelis.id);
    expect(removed).toEqual(xelis);
    expect(wasLast).toBe(false);
    expect(next.wallets.some((w) => w.kind === "xelis")).toBe(false);
    expect(next.wallets).toHaveLength(v3.wallets.length - 1);
  });

  describe("addXelisWalletToContext (the dashboard import panel's write)", () => {
    it("adds into the context the user is on, with its own directory", () => {
      const v3 = multiV3();
      const trading = listContexts(v3).find((c) => c.name === "Trading")!;
      const { v3: next, entry, created } = addXelisWalletToContext(v3, XELIS_SEED, {
        activeWalletId: trading.id,
        now: NOW + 30,
        genId: prefixedGen("x"),
      });
      expect(created).toBe(true);
      expect(entry.kind).toBe("xelis");
      expect(entry.groupId).toBe(trading.groupId);
      expect(entry.name).toBe("Trading · Xelis");
      expect(entry.sidecarFile).toBe(`pwnda-xelis-${entry.id}`);
      const tradingAfter = listContexts(next).find((c) => c.name === "Trading")!;
      expect(memberOfKind(tradingAfter, "xelis")?.id).toBe(entry.id);
      // Main is untouched.
      expect(memberOfKind(listContexts(next)[0], "xelis")).toBeUndefined();
    });

    it("with no context selected, adds to Main", () => {
      const v3 = migrateV2ToV3(fullV2(), det());
      const { entry } = addXelisWalletToContext(v3, XELIS_SEED, { genId: prefixedGen("x") });
      expect(entry.groupId).toBe(listContexts(v3)[0].groupId);
      expect(entry.name).toBe("Main · Xelis");
    });

    it("saving the same seed again changes nothing (a double click saves once)", () => {
      const { v3, xelis } = mainWithXelis();
      const again = addXelisWalletToContext(v3, `  ${XELIS_SEED.toUpperCase()} `, {
        genId: prefixedGen("x"),
      });
      expect(again.created).toBe(false);
      expect(again.entry).toEqual(xelis);
      expect(again.v3).toBe(v3);
    });

    it("refuses to replace a different Xelis seed in that context", () => {
      const { v3 } = mainWithXelis();
      expect(() =>
        addXelisWalletToContext(v3, "a different xelis seed", { genId: prefixedGen("x") }),
      ).toThrow(/already has a Xelis wallet/);
    });

    it("refuses words already saved as another wallet, such as a Monero seed", () => {
      // A Xelis seed and a Monero legacy seed use the same English list and
      // checksum, so the words alone cannot say which coin they are for.
      const v3 = multiV3();
      expect(() =>
        addXelisWalletToContext(v3, "cold seed", { genId: prefixedGen("x") }),
      ).toThrow(/already saved as "Cold"/);
    });
  });
});

/**
 * A Monero or Zephyr wallet imported from the dashboard of a SECOND wallet
 * context (2026-09-16).
 *
 * `mergeFlatIntoV3` named every new flat xmr/zph entry after the legacy fixed
 * file, so an import into "Trading" was stored as `pwnda-active` /
 * `pwnda-zph-active` — Main's files. Both entries then opened one wallet, and
 * the address-mismatch self-heal in xmr-wallet.ts / zph-wallet.ts deletes the
 * file it opened. The first two tests failed against the merge as it stood.
 */
describe("flat xmr/zph import into a second context (2026-09-16)", () => {
  /** Main (upgraded, so it holds the legacy names) plus a bip39-only
   *  "Trading" context, then an XMR + ZPH import written into Trading through
   *  the flat path, the way `XmrImportPanel` / `ZphImportPanel` save. */
  function importIntoTrading() {
    const gen = prefixedGen("m");
    const base = migrateV2ToV3(fullV2(), { now: NOW, genId: gen });
    const trading = addWalletEntry(
      base,
      { kind: "bip39", seed: "trading seed", name: "Trading" },
      { now: NOW + 10, genId: gen },
    );
    const before = trading.v3;
    const flat: VaultPayload = {
      ...projectV3ToV2(before, trading.entry.id),
      xmrSeed: "trading xmr seed",
      zphSeed: "trading zph seed",
    };
    const after = mergeFlatIntoV3(flat, before, {
      activeWalletId: trading.entry.id,
      now: NOW + 20,
      genId: gen,
    });
    return {
      before,
      after,
      main: contextForWallet(after, "all"),
      trading: contextForWallet(after, trading.entry.id),
    };
  }

  it("gives the imported wallets their own files, not Main's", () => {
    const { main, trading } = importIntoTrading();
    // Positive control: both contexts really hold both kinds, and they are
    // two different contexts.
    expect(main?.groupId).not.toBe(trading?.groupId);
    for (const kind of ["xmr", "zph"] as const) {
      expect(memberOfKind(main, kind)).toBeDefined();
      expect(memberOfKind(trading, kind)).toBeDefined();
    }
    expect(sidecarFileForEntry(memberOfKind(main, "xmr")!)).toBe(LEGACY_XMR_SIDECAR_FILE);
    expect(sidecarFileForEntry(memberOfKind(main, "zph")!)).toBe(LEGACY_ZPH_SIDECAR_FILE);
    const tXmr = memberOfKind(trading, "xmr")!;
    const tZph = memberOfKind(trading, "zph")!;
    expect(tXmr.sidecarFile).toBe(newSidecarFile("xmr", tXmr.id));
    expect(tZph.sidecarFile).toBe(newSidecarFile("zph", tZph.id));
  });

  it("leaves no two wallets of one kind on the same file", () => {
    const { after } = importIntoTrading();
    for (const kind of ["xmr", "zph"] as const) {
      const files = after.wallets
        .filter((w) => w.kind === kind)
        .map((w) => sidecarFileForEntry(w));
      expect(files.length).toBe(2); // Main's and Trading's
      expect(new Set(files).size).toBe(files.length);
    }
  });

  it("leaves Main's entries exactly as they were", () => {
    const { before, after } = importIntoTrading();
    const mainMembers = contextForWallet(before, "all")!.members;
    expect(mainMembers.length).toBeGreaterThan(0);
    for (const w of mainMembers) {
      expect(after.wallets.find((x) => x.id === w.id)).toEqual(w);
    }
  });

  it("a first-ever import still claims the legacy names, so nobody rescans", () => {
    const existing = migrateV2ToV3({ v: 2, bip39: "m", xmrSeed: null }, det());
    const flat: VaultPayload = {
      ...projectV3ToV2(existing),
      xmrSeed: "first xmr",
      zphSeed: "first zph",
    };
    const next = mergeFlatIntoV3(flat, existing, { now: NOW + 1, genId: idGen() });
    expect(xmrOf(next)!.sidecarFile).toBe(LEGACY_XMR_SIDECAR_FILE);
    expect(zphOf(next)!.sidecarFile).toBe(LEGACY_ZPH_SIDECAR_FILE);
  });

  it("an entry that already exists keeps the name it stores, even a colliding one", () => {
    // What a vault written before this fix can already hold: Trading's XMR
    // stored under Main's name. Renaming it here would quietly point that
    // wallet at another file; repairing such a vault is a separate decision.
    const { after, trading } = importIntoTrading();
    const xmrId = memberOfKind(trading, "xmr")!.id;
    const collided: VaultPayloadV3 = {
      ...after,
      wallets: after.wallets.map((w) =>
        w.id === xmrId ? { ...w, sidecarFile: LEGACY_XMR_SIDECAR_FILE } : w,
      ),
    };
    const flat: VaultPayload = {
      ...projectV3ToV2(collided, xmrId),
      xmrRestoreHeight: 3_000_000,
    };
    const next = mergeFlatIntoV3(flat, collided, {
      activeWalletId: xmrId,
      now: NOW + 30,
      genId: prefixedGen("n"),
    });
    const xmr = next.wallets.find((w) => w.id === xmrId)!;
    expect(xmr.restoreHeight).toBe(3_000_000); // the save really landed
    expect(xmr.sidecarFile).toBe(LEGACY_XMR_SIDECAR_FILE);
  });
});

/**
 * The flat import saves' guard (2026-09-16).
 *
 * Found by the verification of the naming fix above: in the sandbox, an import
 * into a context that already held Monero kept the entry's id and file and
 * REPLACED its seed — the only stored copy. `flatSeedRefusal` is what
 * `saveXmrSeedToVault` / `saveZphSeedToVault` / `saveZanoSeedToVault` now ask
 * before they write (their wiring is pinned in
 * `src/features/vault/walletFileGuardAndRepair.test.ts`).
 */
describe("flatSeedRefusal (2026-09-16)", () => {
  const flatWith = (over: Partial<VaultPayload>): VaultPayload =>
    ({ v: 2, bip39: "m", xmrSeed: null, ...over }) as VaultPayload;

  it("lets a first import through: there is nothing to replace", () => {
    expect(flatSeedRefusal(flatWith({}), "xmr", "new words")).toBeNull();
    expect(flatSeedRefusal(flatWith({ xmrSeed: null }), "xmr", "new words")).toBeNull();
    expect(flatSeedRefusal(flatWith({ zphSeed: "  " }), "zph", "new words")).toBeNull();
    expect(flatSeedRefusal(flatWith({ zanoSeed: null }), "zano", "new words")).toBeNull();
  });

  it("lets the SAME seed through however it is spaced or cased (the scan-date re-save)", () => {
    expect(flatSeedRefusal(flatWith({ xmrSeed: "alpha beta gamma" }), "xmr", "  Alpha  beta\ngamma ")).toBeNull();
    expect(flatSeedRefusal(flatWith({ zphSeed: "alpha beta" }), "zph", "alpha beta")).toBeNull();
    expect(flatSeedRefusal(flatWith({ zanoSeed: "alpha beta" }), "zano", "alpha beta")).toBeNull();
  });

  it("refuses a different seed, for each kind", () => {
    expect(flatSeedRefusal(flatWith({ xmrSeed: "old words" }), "xmr", "new words")).toBe("different-seed");
    expect(flatSeedRefusal(flatWith({ zphSeed: "old words" }), "zph", "new words")).toBe("different-seed");
    expect(flatSeedRefusal(flatWith({ zanoSeed: "old words" }), "zano", "new words")).toBe("different-seed");
  });

  it("reads only the kind it is asked about", () => {
    const current = flatWith({ xmrSeed: "monero words" });
    expect(flatSeedRefusal(current, "zph", "zephyr words")).toBeNull();
    expect(flatSeedRefusal(current, "zano", "zano words")).toBeNull();
  });

  it("treats a Zano seed under another passphrase as another wallet", () => {
    const current = flatWith({ zanoSeed: "zano words", zanoSeedPassphrase: "pass-a" });
    expect(flatSeedRefusal(current, "zano", "zano words", "pass-b")).toBe("different-passphrase");
    expect(flatSeedRefusal(current, "zano", "zano words", "")).toBe("different-passphrase");
    expect(flatSeedRefusal(current, "zano", "zano words", "pass-a")).toBeNull();
    // Stored with no passphrase: the save leaves the field out when it is empty.
    expect(flatSeedRefusal(flatWith({ zanoSeed: "zano words" }), "zano", "zano words")).toBeNull();
    expect(flatSeedRefusal(flatWith({ zanoSeed: "zano words" }), "zano", "zano words", "p")).toBe(
      "different-passphrase",
    );
  });

  it("answers for the context being written, not for Main", () => {
    const v3 = multiV3(); // Main holds Monero; Trading holds none
    const trading = listContexts(v3).find((c) => c.name === "Trading")!;
    expect(flatSeedRefusal(projectV3ToV2(v3, trading.id), "xmr", "new words")).toBeNull();
    expect(flatSeedRefusal(projectV3ToV2(v3), "xmr", "new words")).toBe("different-seed");
  });

  it("guards a real hazard: the flat merge swaps the seed and keeps the id and file", () => {
    // Why the guard exists, pinned so a future merge that stops doing this
    // can revisit whether the guard is still the right place.
    const v3 = migrateV2ToV3(fullV2(), det());
    const before = xmrOf(v3)!;
    const flat: VaultPayload = { ...projectV3ToV2(v3), xmrSeed: "a different wallet" };
    const merged = mergeFlatIntoV3(flat, v3, { now: NOW + 1, genId: idGen() });
    const after = xmrOf(merged)!;
    expect(after.id).toBe(before.id);
    expect(after.sidecarFile).toBe(before.sidecarFile);
    expect(after.seed).toBe("a different wallet");
    expect(findDuplicateSeed(merged, before.seed)).toBeUndefined(); // the old seed is gone
  });
});

/**
 * The repair for vaults written before the naming fix (2026-09-16).
 *
 * Such a vault can hold a second context's Monero/Zephyr entry stored under
 * Main's file name. `useVault` runs this at unlock (persisting the result) and
 * again on every wallet switch, before any session opens a file.
 */
describe("repairSharedSidecarFiles (2026-09-16)", () => {
  const filesOf = (v3: VaultPayloadV3, kind: string) =>
    v3.wallets.filter((w) => w.kind === kind).map((w) => sidecarFileForEntry(w));

  /** Main (legacy names) plus "Trading", whose Monero and Zephyr came in
   *  through its dashboard and were stored under Main's names — what the
   *  pre-fix merge wrote. Built from today's import and then collided by hand,
   *  because the fixed merge no longer produces it. */
  function collidedVault() {
    const gen = prefixedGen("c");
    const base = migrateV2ToV3(fullV2(), { now: NOW, genId: gen });
    const trading = addWalletEntry(
      base,
      { kind: "bip39", seed: "trading seed", name: "Trading" },
      { now: NOW + 10, genId: gen },
    );
    const flat: VaultPayload = {
      ...projectV3ToV2(trading.v3, trading.entry.id),
      xmrSeed: "trading xmr",
      zphSeed: "trading zph",
    };
    const imported = mergeFlatIntoV3(flat, trading.v3, {
      activeWalletId: trading.entry.id,
      now: NOW + 20,
      genId: gen,
    });
    const legacy: Record<string, string> = {
      xmr: LEGACY_XMR_SIDECAR_FILE,
      zph: LEGACY_ZPH_SIDECAR_FILE,
    };
    const movedIds = new Set(
      contextForWallet(imported, trading.entry.id)!
        .members.filter((m) => m.kind === "xmr" || m.kind === "zph")
        .map((m) => m.id),
    );
    const v3: VaultPayloadV3 = {
      ...imported,
      wallets: imported.wallets.map((w) =>
        movedIds.has(w.id) ? { ...w, sidecarFile: legacy[w.kind] } : w,
      ),
    };
    return { v3, tradingId: trading.entry.id, movedIds };
  }

  it("positive control: the fixture really puts two wallets on each file", () => {
    const { v3, movedIds } = collidedVault();
    expect(movedIds.size).toBe(2);
    expect(filesOf(v3, "xmr")).toEqual([LEGACY_XMR_SIDECAR_FILE, LEGACY_XMR_SIDECAR_FILE]);
    expect(filesOf(v3, "zph")).toEqual([LEGACY_ZPH_SIDECAR_FILE, LEGACY_ZPH_SIDECAR_FILE]);
  });

  it("Main keeps the legacy names; the second context's wallets get their own", () => {
    const { v3, tradingId } = collidedVault();
    const { v3: fixed, repairs } = repairSharedSidecarFiles(v3);
    const main = contextForWallet(fixed, "all");
    const trading = contextForWallet(fixed, tradingId);
    expect(sidecarFileForEntry(memberOfKind(main, "xmr")!)).toBe(LEGACY_XMR_SIDECAR_FILE);
    expect(sidecarFileForEntry(memberOfKind(main, "zph")!)).toBe(LEGACY_ZPH_SIDECAR_FILE);
    const tXmr = memberOfKind(trading, "xmr")!;
    const tZph = memberOfKind(trading, "zph")!;
    expect(tXmr.sidecarFile).toBe(newSidecarFile("xmr", tXmr.id));
    expect(tZph.sidecarFile).toBe(newSidecarFile("zph", tZph.id));
    expect(repairs).toEqual([
      { id: tXmr.id, name: tXmr.name, kind: "xmr", from: LEGACY_XMR_SIDECAR_FILE, to: tXmr.sidecarFile },
      { id: tZph.id, name: tZph.name, kind: "zph", from: LEGACY_ZPH_SIDECAR_FILE, to: tZph.sidecarFile },
    ]);
  });

  it("changes nothing else: no seed, id, height or other entry moves", () => {
    const { v3, movedIds } = collidedVault();
    const { v3: fixed } = repairSharedSidecarFiles(v3);
    expect(fixed.wallets).toHaveLength(v3.wallets.length);
    v3.wallets.forEach((w, i) => {
      const f = fixed.wallets[i];
      if (movedIds.has(w.id)) expect({ ...f, sidecarFile: w.sidecarFile }).toEqual(w);
      else expect(f).toBe(w);
    });
    expect({ ...fixed, wallets: v3.wallets }).toEqual(v3);
  });

  it("is idempotent, and hands back the same object when nothing is shared", () => {
    const { v3 } = collidedVault();
    const once = repairSharedSidecarFiles(v3).v3;
    const twice = repairSharedSidecarFiles(once);
    expect(twice.repairs).toEqual([]);
    expect(twice.v3).toBe(once);
    const clean = multiV3();
    expect(repairSharedSidecarFiles(clean).v3).toBe(clean);
    expect(repairSharedSidecarFiles(migrateV2ToV3(fullV2(), det())).repairs).toEqual([]);
  });

  it("finds nothing to repair in a vault the fixed import wrote", () => {
    const gen = prefixedGen("f");
    const base = migrateV2ToV3(fullV2(), { now: NOW, genId: gen });
    const trading = addWalletEntry(
      base,
      { kind: "bip39", seed: "trading seed", name: "Trading" },
      { now: NOW + 10, genId: gen },
    );
    const flat: VaultPayload = {
      ...projectV3ToV2(trading.v3, trading.entry.id),
      xmrSeed: "trading xmr",
      zphSeed: "trading zph",
    };
    const imported = mergeFlatIntoV3(flat, trading.v3, {
      activeWalletId: trading.entry.id,
      now: NOW + 20,
      genId: gen,
    });
    expect(repairSharedSidecarFiles(imported).repairs).toEqual([]);
  });

  it("with no primary wallet in the pair, the older one keeps the file", () => {
    const gen = prefixedGen("s");
    const base = migrateV2ToV3({ v: 2, bip39: "m", xmrSeed: null }, { now: NOW, genId: gen });
    const older = addWalletEntry(
      base,
      { kind: "xmr", seed: "older seed", name: "Older", xmrSeedFormat: "legacy" },
      { now: NOW + 1, genId: gen },
    );
    const newer = addWalletEntry(
      older.v3,
      { kind: "xmr", seed: "newer seed", name: "Newer", xmrSeedFormat: "legacy" },
      { now: NOW + 2, genId: gen },
    );
    // Hand-shaped: the newer wallet stored under the older one's file.
    const v3: VaultPayloadV3 = {
      ...newer.v3,
      wallets: newer.v3.wallets.map((w) =>
        w.id === newer.entry.id ? { ...w, sidecarFile: older.entry.sidecarFile } : w,
      ),
    };
    expect(filesOf(v3, "xmr")).toEqual([older.entry.sidecarFile, older.entry.sidecarFile]); // control
    const { v3: fixed, repairs } = repairSharedSidecarFiles(v3);
    expect(fixed.wallets.find((w) => w.id === older.entry.id)!.sidecarFile).toBe(older.entry.sidecarFile);
    expect(repairs.map((r) => r.id)).toEqual([newer.entry.id]);
    expect(fixed.wallets.find((w) => w.id === newer.entry.id)!.sidecarFile).toBe(
      newSidecarFile("xmr", newer.entry.id),
    );
  });

  it("covers Zano too, with three wallets on one file", () => {
    const gen = prefixedGen("z");
    const base = migrateV2ToV3(fullV2(), { now: NOW, genId: gen });
    const second = addWalletEntry(
      base,
      { kind: "zano", seed: "second zano", name: "Second Zano" },
      { now: NOW + 5, genId: gen },
    );
    const third = addWalletEntry(
      second.v3,
      { kind: "zano", seed: "third zano", name: "Third Zano" },
      { now: NOW + 6, genId: gen },
    );
    const shared = new Set([second.entry.id, third.entry.id]);
    const v3: VaultPayloadV3 = {
      ...third.v3,
      wallets: third.v3.wallets.map((w) =>
        shared.has(w.id) ? { ...w, sidecarFile: LEGACY_ZANO_SIDECAR_FILE } : w,
      ),
    };
    expect(filesOf(v3, "zano")).toEqual([
      LEGACY_ZANO_SIDECAR_FILE,
      LEGACY_ZANO_SIDECAR_FILE,
      LEGACY_ZANO_SIDECAR_FILE,
    ]); // control
    const { v3: fixed, repairs } = repairSharedSidecarFiles(v3);
    const mainZano = memberOfKind(contextForWallet(fixed, "all"), "zano")!;
    expect(sidecarFileForEntry(mainZano)).toBe(LEGACY_ZANO_SIDECAR_FILE);
    expect(repairs.map((r) => r.id).sort()).toEqual([...shared].sort());
    expect(new Set(filesOf(fixed, "zano")).size).toBe(3);
  });
});
