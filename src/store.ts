import { load } from "@tauri-apps/plugin-store";
import { encrypt, decrypt, type EncryptedData } from "./crypto";
import {
  migrateV2ToV3,
  projectV3ToV2,
  mergeFlatIntoV3,
  type VaultPayload,
  type VaultPayloadV3,
} from "./vault-schema";

// Re-export the schema surface so existing importers keep resolving these
// from "./store" (e.g. `useVault` imports `type VaultPayload` from here).
export type {
  VaultPayload,
  VaultPayloadV3,
  WalletEntry,
  WalletKind,
} from "./vault-schema";
export { projectV3ToV2, mergeFlatIntoV3, migrateV2ToV3 } from "./vault-schema";

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

/**
 * Singleton accessor for the tauri-plugin-store backing file.
 * Exported so other modules (xmr-nodes.ts, etc.) can persist their own
 * keys against the same store rather than juggling multiple files.
 */
export async function getStore() {
  if (!storeInstance) {
    storeInstance = await load("wallet.dat", { defaults: {} });
  }
  return storeInstance;
}

/** Store key holding the encrypted vault (now v3 on disk). */
const WALLET_KEY = "wallet";
/**
 * One-time byte copy of the pre-v3 (v2 / legacy) ciphertext, written before
 * the first v3 overwrite so a botched migration can never lose the seed.
 * Pruning is deferred to a later phase (see multi-wallet-plan § 3).
 */
const WALLET_V2_BACKUP_KEY = "wallet.v2.backup";

interface RawVault {
  /** On-disk schema version before any in-memory migration (1 = pre-v2 string, 2, or 3). */
  onDiskVersion: number;
  v3: VaultPayloadV3;
  /** The encrypted blob exactly as read — used for the pre-migration backup. */
  rawEncrypted: EncryptedData;
}

/**
 * Read + decrypt + normalize the vault to v3 IN MEMORY. No writes. Returns
 * null if no vault is saved. Throws on wrong password (decrypt fails).
 */
async function readVaultRaw(password: string): Promise<RawVault | null> {
  const store = await getStore();
  const encrypted = await store.get<EncryptedData>(WALLET_KEY);
  if (!encrypted) return null;
  const plaintext = await decrypt(encrypted, password);
  const parsed = JSON.parse(plaintext);

  // Pre-v2 single-string vault (bip39 only) — shouldn't exist on this
  // greenfield project, but guard anyway (matches historical behavior).
  if (typeof parsed === "string") {
    const v2: VaultPayload = { v: 2, bip39: parsed, xmrSeed: null };
    return { onDiskVersion: 1, v3: migrateV2ToV3(v2), rawEncrypted: encrypted };
  }
  if (parsed && parsed.v === 3) {
    return { onDiskVersion: 3, v3: parsed as VaultPayloadV3, rawEncrypted: encrypted };
  }
  // v2 (or a legacy object missing `v` — treated as v2).
  return {
    onDiskVersion: 2,
    v3: migrateV2ToV3(parsed as VaultPayload),
    rawEncrypted: encrypted,
  };
}

/** Back up the pristine pre-v3 ciphertext ONCE, before it is overwritten. */
async function backupPreV3Once(raw: RawVault): Promise<void> {
  if (raw.onDiskVersion >= 3) return;
  const store = await getStore();
  if (await store.has(WALLET_V2_BACKUP_KEY)) return; // keep the earliest backup
  await store.set(WALLET_V2_BACKUP_KEY, raw.rawEncrypted);
}

/** Persist the migrated v3 (with a one-time pre-v3 ciphertext backup). */
async function persistMigration(raw: RawVault, password: string): Promise<void> {
  await backupPreV3Once(raw);
  await saveVaultV3(raw.v3, password);
}

/**
 * Load and decrypt the vault, returning the flat v2 working shape for ONE
 * wallet context.
 *
 * Pass `activeWalletId` whenever the caller has one. Omitting it projects the
 * primary group, which is right for first-unlock and wrong for every
 * post-unlock mutator — that omission is what let a derivation switch made on an
 * imported wallet rewrite Main's stored choice. Migrates v2→v3 on disk on first read (with a
 * ciphertext backup). Returns null-throw if no vault is saved; throws on
 * wrong password.
 */
export async function loadVault(
  password: string,
  activeWalletId?: string
): Promise<VaultPayload> {
  const raw = await readVaultRaw(password);
  if (!raw) throw new Error("No saved wallet found");
  if (raw.onDiskVersion < 3) await persistMigration(raw, password);
  return projectV3ToV2(raw.v3, activeWalletId);
}

/**
 * Load and decrypt the full v3 vault (all wallet entries). Used by the
 * unlock/create flow to populate the multi-wallet state spine. Same
 * migrate-on-read behavior as `loadVault`.
 */
export async function loadVaultV3(password: string): Promise<VaultPayloadV3> {
  const raw = await readVaultRaw(password);
  if (!raw) throw new Error("No saved wallet found");
  if (raw.onDiskVersion < 3) await persistMigration(raw, password);
  return raw.v3;
}

/**
 * Flat-shape write API. Projects the flat v2 payload into the on-disk v3
 * structure's target group (`activeWalletId`, else primary), preserving entry ids and any other wallets,
 * then persists. Callers (useVault's read-modify-write helpers) are unchanged.
 *
 * Invariant: an unlock (loadVault or loadVaultV3, which run persistMigration)
 * always precedes any save in real flows, so the pre-v3 backup is already
 * written by then. The `backupPreV3Once` call here is belt-and-suspenders.
 */
export async function saveVault(
  payload: VaultPayload,
  password: string,
  activeWalletId?: string
): Promise<void> {
  const existing = await readVaultRaw(password).catch(() => null);
  if (existing) await backupPreV3Once(existing);
  const v3 = mergeFlatIntoV3(payload, existing?.v3 ?? null, { activeWalletId });
  await saveVaultV3(v3, password);
}

/** Encrypt and persist the full v3 vault. */
export async function saveVaultV3(v3: VaultPayloadV3, password: string): Promise<void> {
  const plaintext = JSON.stringify(v3);
  const encrypted = await encrypt(plaintext, password);
  const store = await getStore();
  await store.set(WALLET_KEY, encrypted);
  await store.save();
}

export async function deleteWallet(): Promise<void> {
  const store = await getStore();
  await store.delete(WALLET_KEY);
  // Remove the migration backup too — a deliberate wallet wipe must not leave
  // an encrypted copy of the old seed behind.
  await store.delete(WALLET_V2_BACKUP_KEY);
  await store.save();
}

export async function hasSavedWallet(): Promise<boolean> {
  const store = await getStore();
  return await store.has(WALLET_KEY);
}
