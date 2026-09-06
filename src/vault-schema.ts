/**
 * Vault schema + migration — PURE logic, zero I/O.
 *
 * This module deliberately imports nothing (no Tauri plugin-store, no
 * WebCrypto) so the migration functions can be unit-tested in a plain node
 * environment. `src/store.ts` is the thin encrypted-I/O layer that wraps
 * these functions against the tauri-plugin-store file.
 *
 * ── Two shapes, one disk format ────────────────────────────────────────
 *   - `VaultPayload`   (v2 flat): the *legacy working shape* the rest of the
 *                       app reads/writes. One bip39 + at most one xmr + at
 *                       most one zph seed. Every existing consumer still
 *                       speaks this shape.
 *   - `VaultPayloadV3` (on disk):  `wallets: WalletEntry[]` — the multi-wallet
 *                       format. One `WalletEntry` per seed phrase.
 *
 * During Phase 1 of the multi-wallet plan there is exactly ONE wallet group,
 * so the flat shape is a lossless projection of the primary group. `store.ts`
 * migrates v2→v3 on first unlock (with a ciphertext backup) and projects
 * v3→v2 on read, so the UI is byte-identical. See
 * `PwndaWalletVault/wiki/synthesis/multi-wallet-plan.md` § 3.
 */

// Type-only import — erased at compile time, so this module keeps its
// zero-runtime-dependency property and stays unit-testable in plain node.
import type { ChainType } from "./wallets";

/* ══════ Legacy flat shape (v2) — unchanged working type ═══════════════ */

/**
 * Versioned vault payload — the flat working shape consumed by `useVault`
 * and every read-modify-write helper. Kept byte-compatible with the v2
 * on-disk format that predates multi-wallet; it is now a *projection* of the
 * primary wallet group (see `projectV3ToV2`).
 */
export interface VaultPayload {
  v: 2;
  /** 12-word BIP39 mnemonic covering all non-XMR chains. */
  bip39: string;
  /** Monero seed (16-word polyseed or 25-word legacy). null if no XMR yet. */
  xmrSeed: string | null;
  /** Format of `xmrSeed`. Undefined for legacy vaults (always 25-word). */
  xmrSeedFormat?: "polyseed" | "legacy";
  /** Monero restore height (block to start scanning from). null = genesis. */
  xmrRestoreHeight?: number | null;
  /** Zephyr seed — 25-word Electrum-style only. null/undefined if no ZPH. */
  zphSeed?: string | null;
  /** Zephyr restore height. */
  zphRestoreHeight?: number | null;
  /** Zano seed — 26-word, own wordlist. null/undefined if no ZANO. No
   *  restore-height field: unlike XMR/ZPH, Zano's seed self-encodes its own
   *  creation date (word 25) — see zano-keys.ts. Not part of the `WalletKind`
   *  multi-wallet system yet (single vault-wide seed, like XMR/ZPH were
   *  before that system existed) — see zano-integration-plan.md's vault-
   *  persistence STATUS for the scope reasoning. */
  zanoSeed?: string | null;
  /** Zano Secured Seed passphrase, when the seed is password-protected.
   *  Undefined/empty for an ordinary seed. A wrong passphrase can't be
   *  detected at save time — see zano-keys.ts's header. */
  zanoSeedPassphrase?: string;
  /** Per-chain derivation-path choice from the import wizard. */
  derivationChoice?: {
    bitcoin: string;
    solana: string;
    cardano: string;
    algorand?: string;
    litecoin?: string;
    xrp?: string;
    tron?: string;
    ravencoin?: string;
    dash?: string;
  };
  /**
   * DEPRECATED — dev-fee acknowledgment timestamp. Mirrored to a plaintext
   * store key since M3; carried through migration for the one-shot copy in
   * `useVault.handleUnlock`. See `src/features/mining/devFeeAck.ts`.
   */
  devFeeAcknowledgedAt?: number;
}

/* ══════ Multi-wallet shape (v3) — the on-disk format ══════════════════ */

/**
 * A wallet's kind:
 *  - "bip39"      — a 12/24-word seed covering all HD chains (an index-0 account).
 *  - "xmr" / "zph"— an independent Monero / Zephyr seed (own sidecar file).
 *  - "privateKey" — a single-chain account imported from a raw key (holds the
 *                   key in `seed`; `chain` names its network). Can sign/send.
 *  - "watch"      — a single-chain VIEW-ONLY address (`address` + `chain`, no
 *                   key material; `seed` stays ""). Never signs. (2026-07-05)
 */
export type WalletKind =
  | "bip39"
  | "xmr"
  | "zph"
  // 2026-09-02: Zano promoted from a vault-wide `zanoSeed` field to a
  // first-class entry. As a top-level field it was shared by EVERY context —
  // switching wallet kept the same Zano wallet, `switchWallet` had to carry it
  // across by hand, and there was no `removeWallet` path for it at all. It now
  // behaves exactly like xmr/zph: one entry per context, its own sidecar file.
  | "zano"
  | "privateKey"
  | "watch";

/** Kinds backed by a single chain rather than a whole HD tree. */
export function isSingleChainKind(kind: WalletKind): boolean {
  return kind === "privateKey" || kind === "watch";
}

/**
 * One wallet = one seed phrase (or, for privateKey/watch, one single-chain
 * account). XMR/Zephyr are first-class entries, no longer subsections of the
 * bip39 wallet. Entries created together (a fresh create, or a migrated v2
 * vault) share a `groupId` so the UI can nest them.
 */
export interface WalletEntry {
  /** Stable unique id (never reused). */
  id: string;
  /** User-editable label ("Main", "Trading", "Cold XMR"). */
  name: string;
  kind: WalletKind;
  /**
   * Key material: the seed phrase (12/24 bip39 · 16 polyseed · 25 legacy) or,
   * for `privateKey`, the raw imported key. Empty ("") for `watch` — never
   * overload this field with non-secret data so "seed = key material" holds.
   */
  seed: string;
  /** Unix ms at creation/migration. */
  createdAt: number;
  /** Set when entries were created as one bundle. */
  groupId?: string;
  /** bip39 only — per-chain derivation-path choice. */
  derivationChoice?: VaultPayload["derivationChoice"];
  /** xmr only — seed format. */
  xmrSeedFormat?: "polyseed" | "legacy";
  /** xmr/zph — restore height. */
  restoreHeight?: number | null;
  /** xmr/zph/zano — on-disk sidecar wallet filename (see § 5). */
  sidecarFile?: string;
  /** zano only — Secured-Seed passphrase, when the seed is password-protected.
   *  Held per-entry (not vault-wide) because two Zano wallets can differ in
   *  whether they use one; see `zano-keys.ts` for why a wrong passphrase
   *  derives a different, equally valid-looking wallet rather than failing. */
  zanoSeedPassphrase?: string;
  /** privateKey/watch — the single chain this account lives on. */
  chain?: ChainType;
  /** watch — the watched public address (privateKey entries derive theirs). */
  address?: string;
}

export interface VaultPayloadV3 {
  v: 3;
  wallets: WalletEntry[];
  /** walletId or the sentinel "all" (unified view). Restored on unlock. */
  lastActiveWalletId?: string;
  /** Carried-through deprecated dev-fee ack (was `VaultPayload.devFeeAcknowledgedAt`). */
  legacyDevFeeAcknowledgedAt?: number;
  /**
   * Cached balance snapshots so inactive XMR/ZPH wallets can render in the
   * unified view without a live sidecar. Written in a later phase; preserved
   * through every save here. Encrypted with the rest of the vault.
   */
  balanceCache?: Record<
    string,
    {
      byChain: Record<string, { balance: string; usdAtSync?: number }>;
      syncedAt: number;
    }
  >;
  /**
   * Zano seed — a top-level vault-wide field, NOT a `WalletEntry` (Zano is
   * not a `WalletKind` yet). Single seed per vault, same shape XMR/ZPH used
   * before the multi-wallet `WalletEntry[]` system existed. Carried straight
   * through `projectV3ToV2`/`mergeFlatIntoV3` without touching `wallets[]`.
   */
  zanoSeed?: string | null;
  zanoSeedPassphrase?: string;
}

/**
 * Sidecar wallet-file names. The FIRST (primary/migrated) XMR/ZPH wallet
 * keeps the single fixed names the Rust sidecar has always used
 * (`src/wallets/xmr-rpc.ts`, `zph-rpc.ts`) so existing users' scan state is
 * reused with zero rescan. ADDITIONAL wallets added in Phase 2 get
 * per-wallet filenames (`pwnda-xmr-<id>` / `pwnda-zph-<id>`) so their files
 * coexist on disk. See `sidecarFileForKind`.
 */
export const LEGACY_XMR_SIDECAR_FILE = "pwnda-active";
export const LEGACY_ZPH_SIDECAR_FILE = "pwnda-zph-active";
/** The single fixed filename Zano used before it became a `WalletKind`
 *  (`ZANO_WALLET_FILE_NAME` in `src-tauri/src/zano_rpc.rs`). The migrated
 *  entry keeps it, so an existing Zano wallet is reused with no rescan. */
export const LEGACY_ZANO_SIDECAR_FILE = "pwnda.zan";

/** Per-wallet sidecar filename for a NEW (non-primary) xmr/zph wallet. */
export function newSidecarFile(kind: WalletKind, id: string): string | undefined {
  if (kind === "xmr") return `pwnda-xmr-${id}`;
  if (kind === "zph") return `pwnda-zph-${id}`;
  // Zano's sidecar opens the file by name and writes siblings beside it, so
  // the extension is part of the name (unlike xmr/zph, which are extensionless).
  if (kind === "zano") return `pwnda-zano-${id}.zan`;
  return undefined;
}

/**
 * Resolve the on-disk sidecar filename for an entry: the stored `sidecarFile`
 * if present (migrated primary → legacy name; added wallet → per-wallet name),
 * else derive a per-wallet name. bip39 entries have no sidecar file.
 */
export function sidecarFileForEntry(entry: WalletEntry): string | undefined {
  if (entry.kind !== "xmr" && entry.kind !== "zph" && entry.kind !== "zano") {
    return undefined;
  }
  return entry.sidecarFile ?? newSidecarFile(entry.kind, entry.id);
}

export interface SchemaOpts {
  /** Injectable clock (defaults to Date.now) — keeps migration testable. */
  now?: number;
  /** Injectable id generator (defaults to crypto.randomUUID). */
  genId?: () => string;
}

function defaults(opts: SchemaOpts): { now: number; genId: () => string } {
  return {
    now: opts.now ?? Date.now(),
    genId: opts.genId ?? (() => crypto.randomUUID()),
  };
}

/* ══════ v2 → v3 migration ═════════════════════════════════════════════ */

/**
 * Migrate a flat v2 payload to the v3 multi-wallet shape. Pure — inject
 * `now`/`genId` for deterministic tests. The three seeds become three
 * entries in one group ("Main" / "Main · Monero" / "Main · Zephyr").
 */
export function migrateV2ToV3(v2: VaultPayload, opts: SchemaOpts = {}): VaultPayloadV3 {
  const { now, genId } = defaults(opts);
  const groupId = genId();
  const wallets: WalletEntry[] = [];

  // BIP39 entry — always present in a v2 vault.
  wallets.push({
    id: genId(),
    name: "Main",
    kind: "bip39",
    seed: v2.bip39,
    createdAt: now,
    groupId,
    derivationChoice: v2.derivationChoice,
  });

  if (v2.xmrSeed) {
    wallets.push({
      id: genId(),
      name: "Main · Monero",
      kind: "xmr",
      seed: v2.xmrSeed,
      createdAt: now,
      groupId,
      xmrSeedFormat: v2.xmrSeedFormat,
      restoreHeight: v2.xmrRestoreHeight ?? null,
      sidecarFile: LEGACY_XMR_SIDECAR_FILE,
    });
  }

  if (v2.zphSeed) {
    wallets.push({
      id: genId(),
      name: "Main · Zephyr",
      kind: "zph",
      seed: v2.zphSeed,
      createdAt: now,
      groupId,
      restoreHeight: v2.zphRestoreHeight ?? null,
      sidecarFile: LEGACY_ZPH_SIDECAR_FILE,
    });
  }

  // Zano is a first-class entry as of 2026-09-02. A v2 vault predates Zano
  // entirely, so this branch is unreachable for a genuine on-disk v2 payload —
  // it exists so the function stays total, and because `mergeFlatIntoV3` funnels
  // in-memory flat payloads through the same shape.
  if (v2.zanoSeed) {
    wallets.push({
      id: genId(),
      name: "Main · Zano",
      kind: "zano",
      seed: v2.zanoSeed,
      createdAt: now,
      groupId,
      sidecarFile: LEGACY_ZANO_SIDECAR_FILE,
      ...(v2.zanoSeedPassphrase
        ? { zanoSeedPassphrase: v2.zanoSeedPassphrase }
        : {}),
    });
  }

  const v3: VaultPayloadV3 = { v: 3, wallets, lastActiveWalletId: "all" };
  if (typeof v2.devFeeAcknowledgedAt === "number") {
    v3.legacyDevFeeAcknowledgedAt = v2.devFeeAcknowledgedAt;
  }
  return v3;
}

/* ══════ Primary-group helpers ═════════════════════════════════════════ */

/**
 * The "primary group" is the group containing the first bip39 wallet. In
 * Phase 1 there is exactly one group, so this is the whole vault. Defensive
 * fallbacks (no bip39 entry / no group ids) keep projection total.
 */
/**
 * The key an entry groups under.
 *
 * `listContexts` has always used `groupId ?? id`, so an UNGROUPED wallet is its
 * own context keyed by its own id. `projectV3ToV2` and `mergeFlatIntoV3`
 * compared the raw `groupId` field instead — which is `undefined` for exactly
 * those wallets, so a standalone context matched nothing, the merge invented a
 * fresh "Main" entry, and the write landed on a NEW group while the old one
 * survived alongside it. Caught by
 * "a write targets the ACTIVE wallet and leaves the others untouched".
 *
 * Two functions disagreeing about what a group IS is the same class of fault as
 * the applier/checker directory mismatch in `grove-id.mjs`. One key function,
 * used by all three.
 */
function groupKey(w: WalletEntry): string {
  return w.groupId ?? w.id;
}

function primaryGroupId(v3: VaultPayloadV3): string | undefined {
  const bip39 = v3.wallets.find((w) => w.kind === "bip39");
  const rep = bip39 ?? v3.wallets[0];
  return rep ? groupKey(rep) : undefined;
}

/**
 * The legacy vault-WIDE Zano seed, but only for the context it belongs to.
 *
 * # The bug this exists to stop
 *
 * Zano was promoted from `VaultPayloadV3.zanoSeed` to a `WalletEntry` on
 * 2026-09-02, and both read paths kept `?? v3.zanoSeed` so an existing wallet
 * would not vanish on the first unlock after the upgrade. That fallback was
 * written unscoped, and unscoped it hands the SAME Zano wallet to every
 * context: a vault that still carries the top-level field shows one profile's
 * Zano wallet under every other profile's name.
 *
 * Which is the exact fault the promotion was for. Its own log entry names it —
 * *"the moment a second Zano wallet could exist it would have shown the
 * PREVIOUS context's Zano wallet under the new context's name"* — and the
 * compatibility shim added in the same change reintroduced it through the
 * other door. Reported by the operator on 2026-09-05: *"why can I see my zano
 * wallet when I selected a different profile? This should've been addressed
 * and resolved in a previous session."* It had been, for the promoted path.
 *
 * A vault-wide seed predates contexts, so there is exactly one context it can
 * honestly belong to: the primary group — the one `migrateV2ToV3` would have
 * put it in, and the one holding `LEGACY_ZANO_SIDECAR_FILE`. Every other
 * context has no Zano wallet, and must be told so.
 *
 * Returns `null` when there is no legacy seed, or when `groupId` is not the
 * primary group.
 */
export function legacyZanoSeedFor(
  v3: VaultPayloadV3,
  groupId: string | undefined
): { seed: string; passphrase?: string } | null {
  if (!v3.zanoSeed) return null;
  const primary = primaryGroupId(v3);
  // `undefined` means "no group selected" — the whole-vault read, which is the
  // primary group's view by `groupIdForWallet`'s own rule.
  if (groupId !== undefined && groupId !== primary) return null;
  return {
    seed: v3.zanoSeed,
    ...(v3.zanoSeedPassphrase ? { passphrase: v3.zanoSeedPassphrase } : {}),
  };
}

/**
 * The group a given `activeWalletId` belongs to — the missing piece that made
 * multi-wallet half-wired.
 *
 * `primaryGroupId` answers "which group is Main"; this answers "which group is
 * the user actually looking at". Everything that reads or writes the vault needs
 * the second question, and until 2026-08-29 every path except `switchWallet`
 * asked the first — so the switcher changed the label while every address,
 * balance and seed stayed Main's.
 *
 * Falls back to the primary group for `"all"`, for an unknown id, and for an
 * empty vault, so callers that pass nothing keep their old behaviour exactly.
 */
export function groupIdForWallet(
  v3: VaultPayloadV3,
  activeWalletId?: string
): string | undefined {
  if (!activeWalletId || activeWalletId === "all") return primaryGroupId(v3);
  const ctx = contextForWallet(v3, activeWalletId);
  return ctx?.groupId ?? primaryGroupId(v3);
}

/* ══════ v3 → v2 projection (read path) ════════════════════════════════ */

/**
 * Project ONE group back to the flat v2 shape the app consumes.
 * Inverse of `migrateV2ToV3` for that group.
 *
 * `activeWalletId` selects the group; omitting it projects the primary group,
 * which is the pre-2026-08-29 behaviour and what every legacy caller wants.
 */
export function projectV3ToV2(
  v3: VaultPayloadV3,
  activeWalletId?: string
): VaultPayload {
  const gid = groupIdForWallet(v3, activeWalletId);
  const inPrimary = (w: WalletEntry) => gid === undefined || groupKey(w) === gid;

  const bip39 = v3.wallets.find((w) => w.kind === "bip39" && inPrimary(w));
  const xmr = v3.wallets.find((w) => w.kind === "xmr" && inPrimary(w));
  const zph = v3.wallets.find((w) => w.kind === "zph" && inPrimary(w));
  // Zano is group-scoped now. The legacy top-level seed reads through
  // `legacyZanoSeedFor`, which is SCOPED to the primary group — unscoped, it
  // showed one profile's Zano wallet under every other profile's name. See
  // that function for the full account.
  const zano = v3.wallets.find((w) => w.kind === "zano" && inPrimary(w));
  const legacyZano = zano ? null : legacyZanoSeedFor(v3, gid);

  const flat: VaultPayload = {
    v: 2,
    bip39: bip39?.seed ?? "",
    xmrSeed: xmr?.seed ?? null,
    xmrSeedFormat: xmr?.xmrSeedFormat,
    xmrRestoreHeight: xmr?.restoreHeight ?? null,
    zphSeed: zph?.seed ?? null,
    zphRestoreHeight: zph?.restoreHeight ?? null,
    derivationChoice: bip39?.derivationChoice,
    zanoSeed: zano?.seed ?? legacyZano?.seed ?? null,
    zanoSeedPassphrase: zano?.zanoSeedPassphrase ?? legacyZano?.passphrase,
  };
  if (typeof v3.legacyDevFeeAcknowledgedAt === "number") {
    flat.devFeeAcknowledgedAt = v3.legacyDevFeeAcknowledgedAt;
  }
  return flat;
}

/* ══════ Flat → v3 merge (write path) ══════════════════════════════════ */

/**
 * Fold a flat v2 payload back into the on-disk v3 structure's primary group,
 * preserving entry ids / createdAt / names / sidecar files and any wallets
 * outside the primary group (forward-safety for Phase 2). This is what the
 * legacy `saveVault` write API projects through.
 *
 * Presence rules mirror the flat shape exactly:
 *   - `flat.xmrSeed` falsy  → no xmr entry  (this is how "forget XMR" works)
 *   - `flat.xmrSeed` truthy → xmr entry created/updated
 *   (same for zph)
 */
export function mergeFlatIntoV3(
  flat: VaultPayload,
  existing: VaultPayloadV3 | null,
  opts: SchemaOpts & { activeWalletId?: string } = {}
): VaultPayloadV3 {
  const { now, genId } = defaults(opts);

  // Write into the group the user is ACTUALLY on. Omitting `activeWalletId`
  // targets the primary group — the old behaviour, kept so legacy callers are
  // unchanged. Getting this wrong is not a display bug: a derivation switch made
  // while on an imported wallet used to rewrite MAIN's stored choice.
  const gid =
    (existing && groupIdForWallet(existing, opts.activeWalletId)) ?? genId();
  const inTarget = (w: WalletEntry) => groupKey(w) === gid;
  const prevBip39 = existing?.wallets.find((w) => w.kind === "bip39" && inTarget(w));
  const prevXmr = existing?.wallets.find((w) => w.kind === "xmr" && inTarget(w));
  const prevZph = existing?.wallets.find((w) => w.kind === "zph" && inTarget(w));
  const prevZano = existing?.wallets.find((w) => w.kind === "zano" && inTarget(w));

  const wallets: WalletEntry[] = [];

  // BIP39 — always present.
  wallets.push({
    id: prevBip39?.id ?? genId(),
    name: prevBip39?.name ?? "Main",
    kind: "bip39",
    seed: flat.bip39,
    createdAt: prevBip39?.createdAt ?? now,
    groupId: gid,
    derivationChoice: flat.derivationChoice,
  });

  if (flat.xmrSeed) {
    wallets.push({
      id: prevXmr?.id ?? genId(),
      name: prevXmr?.name ?? "Main · Monero",
      kind: "xmr",
      seed: flat.xmrSeed,
      createdAt: prevXmr?.createdAt ?? now,
      groupId: gid,
      xmrSeedFormat: flat.xmrSeedFormat,
      restoreHeight: flat.xmrRestoreHeight ?? null,
      sidecarFile: prevXmr?.sidecarFile ?? LEGACY_XMR_SIDECAR_FILE,
    });
  }

  if (flat.zphSeed) {
    wallets.push({
      id: prevZph?.id ?? genId(),
      name: prevZph?.name ?? "Main · Zephyr",
      kind: "zph",
      seed: flat.zphSeed,
      createdAt: prevZph?.createdAt ?? now,
      groupId: gid,
      restoreHeight: flat.zphRestoreHeight ?? null,
      sidecarFile: prevZph?.sidecarFile ?? LEGACY_ZPH_SIDECAR_FILE,
    });
  }

  if (flat.zanoSeed) {
    wallets.push({
      id: prevZano?.id ?? genId(),
      name: prevZano?.name ?? "Main · Zano",
      kind: "zano",
      seed: flat.zanoSeed,
      createdAt: prevZano?.createdAt ?? now,
      groupId: gid,
      // A vault upgraded in place has exactly one Zano wallet, already on
      // disk under the legacy name — claim that name so it is reused rather
      // than resynced. Only wallets ADDED after the promotion get a
      // per-wallet file.
      sidecarFile:
        prevZano?.sidecarFile ??
        (existing?.zanoSeed || !existing
          ? LEGACY_ZANO_SIDECAR_FILE
          : newSidecarFile("zano", prevZano?.id ?? gid)),
      ...(flat.zanoSeedPassphrase
        ? { zanoSeedPassphrase: flat.zanoSeedPassphrase }
        : {}),
    });
  }

  // Preserve every wallet outside the target group untouched.
  const others = (existing?.wallets ?? []).filter((w) => !inTarget(w));

  // ORDER MATTERS. `primaryGroupId` picks the FIRST bip39 entry, so emitting
  // the rebuilt target group at the front would silently PROMOTE whichever
  // wallet was just written to — saving a derivation change while on an
  // imported wallet would make that wallet "Main". Restore the original
  // ordering; entries that did not exist before keep their position at the end.
  const merged = [...wallets, ...others];
  if (existing) {
    const orderOf = new Map(existing.wallets.map((w, i) => [w.id, i]));
    merged.sort(
      (a, b) =>
        (orderOf.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (orderOf.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  const v3: VaultPayloadV3 = {
    v: 3,
    wallets: merged,
    lastActiveWalletId: existing?.lastActiveWalletId ?? "all",
  };

  const legacyAck =
    typeof flat.devFeeAcknowledgedAt === "number"
      ? flat.devFeeAcknowledgedAt
      : existing?.legacyDevFeeAcknowledgedAt;
  if (typeof legacyAck === "number") v3.legacyDevFeeAcknowledgedAt = legacyAck;
  if (existing?.balanceCache) v3.balanceCache = existing.balanceCache;
  // Zano — top-level field, not a WalletEntry (see the VaultPayloadV3 doc
  // comment). `flat.zanoSeed` falsy clears it, same presence rule as xmr/zph.
  if (flat.zanoSeed) {
    v3.zanoSeed = flat.zanoSeed;
    if (flat.zanoSeedPassphrase) v3.zanoSeedPassphrase = flat.zanoSeedPassphrase;
  }

  return v3;
}

/* ══════ Multi-wallet CRUD (Phase 2) — pure v3 transforms ═══════════════ */

/** Normalize a seed for duplicate comparison: trim, collapse whitespace, lowercase. */
export function normalizeSeed(seed: string): string {
  return seed.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Find an existing entry whose seed matches `seed` (normalized). Used to warn
 * before adding a wallet the user already has — two entries with the same
 * seed would double-count balances and confuse the switcher.
 */
export function findDuplicateSeed(
  v3: VaultPayloadV3,
  seed: string
): WalletEntry | undefined {
  const norm = normalizeSeed(seed);
  if (!norm) return undefined; // watch entries have empty seeds — not "duplicates"
  return v3.wallets.find((w) => normalizeSeed(w.seed) === norm);
}

/** Case-insensitive address compare (EVM checksums differ only by case). */
function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Find an existing single-chain (privateKey/watch) entry on the same
 * `(chain, address)`. Used to dedupe PK imports (by DERIVED address) and watch
 * adds — the seed-text dedupe can't catch a re-encoded key or an empty-seed
 * watch entry.
 */
export function findDuplicateAddress(
  v3: VaultPayloadV3,
  chain: ChainType,
  address: string
): WalletEntry | undefined {
  return v3.wallets.find((w) => w.chain === chain && sameAddress(w.address, address));
}

/** Spec for a wallet being added post-unlock. */
export interface NewWalletSpec {
  kind: WalletKind;
  /** Key material — the seed / private key. "" for watch. */
  seed: string;
  name: string;
  /** bip39 only. */
  derivationChoice?: VaultPayload["derivationChoice"];
  /** xmr only. */
  xmrSeedFormat?: "polyseed" | "legacy";
  /** xmr/zph. */
  restoreHeight?: number | null;
  /** privateKey/watch — the single chain. */
  chain?: ChainType;
  /** privateKey (derived) / watch (entered) — the public address. */
  address?: string;
}

/**
 * Append a new INDEPENDENT wallet (its own group). Returns the next v3 and the
 * created entry. The entry's `id` is fresh; xmr/zph get a per-wallet
 * `sidecarFile`; privateKey/watch carry `chain` + `address`.
 */
export function addWalletEntry(
  v3: VaultPayloadV3,
  spec: NewWalletSpec,
  opts: SchemaOpts = {}
): { v3: VaultPayloadV3; entry: WalletEntry } {
  const { now, genId } = defaults(opts);
  const id = genId();
  const entry: WalletEntry = {
    id,
    name: spec.name,
    kind: spec.kind,
    seed: spec.seed,
    createdAt: now,
    groupId: genId(), // a standalone wallet is its own group
  };
  if (spec.kind === "bip39") {
    entry.derivationChoice = spec.derivationChoice;
  } else if (spec.kind === "xmr" || spec.kind === "zph") {
    entry.restoreHeight = spec.restoreHeight ?? null;
    entry.sidecarFile = newSidecarFile(spec.kind, id);
    if (spec.kind === "xmr") entry.xmrSeedFormat = spec.xmrSeedFormat;
  } else {
    // privateKey / watch — single-chain accounts.
    entry.chain = spec.chain;
    entry.address = spec.address;
  }
  return { v3: { ...v3, wallets: [...v3.wallets, entry] }, entry };
}

/** Rename an entry by id (no-op if not found). */
export function renameWalletEntry(
  v3: VaultPayloadV3,
  id: string,
  name: string
): VaultPayloadV3 {
  return {
    ...v3,
    wallets: v3.wallets.map((w) => (w.id === id ? { ...w, name } : w)),
  };
}

/**
 * Remove an entry by id. Returns the next v3, the removed entry (for sidecar
 * cleanup), and `wasLast` when the vault is now empty (caller should wipe).
 * If the removed entry was `lastActiveWalletId`, the active context resets to
 * the unified "all" view.
 */
export function removeWalletEntry(
  v3: VaultPayloadV3,
  id: string
): { v3: VaultPayloadV3; removed: WalletEntry | undefined; wasLast: boolean } {
  const removed = v3.wallets.find((w) => w.id === id);
  const wallets = v3.wallets.filter((w) => w.id !== id);
  const next: VaultPayloadV3 = { ...v3, wallets };
  if (next.lastActiveWalletId === id) next.lastActiveWalletId = "all";
  return { v3: next, removed, wasLast: removed !== undefined && wallets.length === 0 };
}

/** True if `id` is the primary group's bip39 wallet (the current active context in Phase 2). */
export function isPrimaryBip39(v3: VaultPayloadV3, id: string): boolean {
  const primary = v3.wallets.find((w) => w.kind === "bip39");
  return !!primary && primary.id === id;
}

/* ══════ Wallet contexts (Phase 3) — switcher + active-context model ════ */

/**
 * A switchable "context" — one groupId bundle presented as a single unit in
 * the switcher. `id` is the context's representative wallet (its bip39 entry
 * if any, else its first member), which is what `activeWalletId` stores.
 */
export interface WalletContext {
  /** Representative wallet id (== activeWalletId when this context is active). */
  id: string;
  /** Shared groupId (or the lone wallet's id when ungrouped). */
  groupId: string;
  /** Display name — the bip39 member's name, else the first member's. */
  name: string;
  /** All entries in this context, bip39 first. */
  members: WalletEntry[];
}

/**
 * Group entries into switchable contexts, primary group first, then by the
 * earliest createdAt in each group. A `groupId` bundle (e.g. Main + Monero +
 * Zephyr) is ONE context; a standalone wallet is its own context.
 */
export function listContexts(v3: VaultPayloadV3): WalletContext[] {
  const primaryGid = primaryGroupId(v3);
  const byGroup = new Map<string, WalletEntry[]>();
  for (const w of v3.wallets) {
    const key = groupKey(w); // ungrouped wallet keys on its own id
    const arr = byGroup.get(key);
    if (arr) arr.push(w);
    else byGroup.set(key, [w]);
  }
  const contexts: WalletContext[] = [];
  for (const [groupId, members] of byGroup) {
    const sorted = [...members].sort((a, b) => {
      if (a.kind === "bip39" && b.kind !== "bip39") return -1;
      if (b.kind === "bip39" && a.kind !== "bip39") return 1;
      return a.createdAt - b.createdAt;
    });
    const rep = sorted[0];
    contexts.push({ id: rep.id, groupId, name: rep.name, members: sorted });
  }
  return contexts.sort((a, b) => {
    const ap = a.groupId === primaryGid ? 0 : 1;
    const bp = b.groupId === primaryGid ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const at = Math.min(...a.members.map((m) => m.createdAt));
    const bt = Math.min(...b.members.map((m) => m.createdAt));
    return at - bt;
  });
}

/** The context containing wallet `id` (or the primary context for "all"/unknown). */
export function contextForWallet(
  v3: VaultPayloadV3,
  activeWalletId: string
): WalletContext | undefined {
  const contexts = listContexts(v3);
  if (activeWalletId === "all") return contexts[0];
  return (
    contexts.find((c) => c.members.some((m) => m.id === activeWalletId)) ??
    contexts[0]
  );
}

/** Convenience: the bip39 / xmr / zph member of a context (if present). */
export function memberOfKind(
  ctx: WalletContext | undefined,
  kind: WalletKind
): WalletEntry | undefined {
  return ctx?.members.find((m) => m.kind === kind);
}

/**
 * Switcher visibility rule (locked decision 2): show only when there are ≥ 2
 * top-level contexts — a groupId bundle counts as ONE. A fresh three-seed
 * create and a migrated v2 vault both stay hidden (one context).
 */
export function shouldShowSwitcher(v3: VaultPayloadV3): boolean {
  return listContexts(v3).length >= 2;
}
