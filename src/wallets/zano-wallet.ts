/**
 * Zano (ZANO) ChainAdapter — sidecar-backed implementation.
 *
 * Structural parallel to `zph-wallet.ts`, with one lifecycle simplification:
 * Zano's Rust layer (`src-tauri/src/zano_rpc.rs`) already collapses
 * create-or-restore into a single idempotent Stage A command
 * (`zano_ensure_wallet`), because upstream has no RPC-level
 * `restore_deterministic_wallet` — restoration is CLI-only. So there is no
 * TS-side "try open, try open with blank password, fall back to restore"
 * dance the way Zephyr/Monero need; the self-heal here reduces to "did Stage
 * A + Stage B succeed, and does the resulting address match the seed."
 *
 * v1 scope, matching the plan's non-goals: display + send + receive for
 * native ZANO. No staking. No confidential-asset SEND UI yet (read-only via
 * `zano-rpc.ts::getAllBalances`) — that lands with Phase 5's
 * `ZanoAssetsCard`. No swap-route claims (no `ASSET_CAPABILITIES` entry —
 * Phase 7).
 */

import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
  SendableBalance,
  TxParties,
} from "./types";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { SendOutcomeUnknownError } from "./send-outcome";
import { errorText } from "../lib/errorText";
import { invoke } from "../lib/tauri";
import { uniqueAddresses } from "./parties-b-common";
import {
  generateZanoSeed,
  validateZanoSeed,
  normalizeZanoSeed,
  zanoAddressFromSeed,
  readZanoSeedMeta,
} from "./zano-keys";
import {
  ensureZanoWallet,
  startZanoRpc,
  stopZanoRpc,
  isZanoRpcRunning,
  checkZanoBinaryExists,
  getAddress,
  getNativeBalance,
  getAllBalances,
  getRecentTransfers,
  transfer,
  storeWallet,
  zanoToAtomic,
  atomicToZano,
  zanoSendMayHaveBroadcast,
  ZANO_TRANSFER_FEE_ATOMIC,
  ZANO_NATIVE_ASSET_ID,
  ZANO_NATIVE_DECIMALS,
  type ZanoAssetBalance,
  type ZanoTransferEntry,
} from "./zano-rpc";
import { pickZanoDaemon } from "./zano-nodes";

/**
 * Fallback used only if `pickZanoDaemon` itself throws (e.g. the pool is
 * somehow empty). `zano-nodes.ts` (Phase 4) owns the real pool + health loop
 * + user pin; this constant is not the pool — it exists purely so a probe
 * failure has something concrete to report rather than an empty string.
 */
const ZANO_DEFAULT_DAEMON = "http://37.27.100.59:10500";

interface ZanoSession {
  seed: string;
  seedPassphrase: string;
  daemonUrl: string;
  walletPassword: string;
  currentAddress: string;
  /** Per-wallet on-disk filename, or undefined for the migrated primary
   *  wallet (which keeps Zano's original fixed name). Held so
   *  `switchZanoDaemon` respawns against the SAME file — before Zano became a
   *  `WalletKind` there was only one file, so this could be left implicit. */
  walletFile?: string;
}

let session: ZanoSession | null = null;

// =========================================================================
// Wallet-file password
// =========================================================================

/**
 * PBKDF2 from the vault master password. Mirrors `zph-wallet.ts`'s
 * `deriveWalletPassword` exactly except for the salt string, so a
 * compromise of one chain's wallet-file password gives no leverage on
 * another's (per-chain salts are the whole point of that pattern).
 */
async function deriveWalletPassword(masterPassword: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode("pwnda-zano-wallet-file"),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// =========================================================================
// Session lifecycle
// =========================================================================

/**
 * Establish a Zano session: ensure a wallet file exists for `rawSeed`
 * (creating or restoring as needed), start the RPC sidecar against a
 * daemon, and verify the resulting address matches what the seed derives
 * offline.
 *
 * `seedPassphrase` is the Secured-Seed passphrase, required when
 * `readZanoSeedMeta(seed).passwordProtected` is true — see `zano-keys.ts`'s
 * header for why a wrong passphrase cannot be detected here and must be
 * caught by the caller confirming the resulting address.
 */
export async function initZanoSession(
  rawSeed: string,
  masterPassword: string,
  seedPassphrase = "",
  walletFile?: string
): Promise<void> {
  const seed = normalizeZanoSeed(rawSeed);
  if (!validateZanoSeed(seed)) {
    throw new Error("Invalid Zano seed phrase.");
  }
  const meta = readZanoSeedMeta(seed);
  if (meta.auditable) {
    throw new Error(
      "This is an auditable Zano seed. Auditable wallets are not supported yet."
    );
  }
  if (meta.passwordProtected && !seedPassphrase) {
    throw new Error(
      "This Zano seed is password-protected (Secured Seed) and needs its passphrase."
    );
  }

  const walletPassword = await deriveWalletPassword(masterPassword);

  // Fast path: same seed, already running.
  // Fast path requires the FILE to match too: two Zano wallets in different
  // contexts can share neither a file nor a running sidecar, and matching on
  // the seed alone would leave the previous wallet's RPC serving the new one.
  if (
    session &&
    session.seed === seed &&
    session.seedPassphrase === seedPassphrase &&
    session.walletFile === walletFile &&
    (await isZanoRpcRunning().catch(() => false))
  ) {
    return;
  }

  if (session) {
    try {
      await closeZanoWallet();
    } catch {
      /* ignore */
    }
  }

  const binaryExists = await checkZanoBinaryExists();
  if (!binaryExists) {
    // "Download it from Settings first" until 2026-09-16; no such control
    // existed. The Zano card's own button and Settings ▸ Wallet binaries both
    // install it now. Keep "binary" + "missing": ZanoSyncCard matches them.
    throw new Error(
      "The Zano wallet binary is missing. Use the download button below, or " +
        "Settings ▸ Wallet binaries."
    );
  }

  // Offline cross-check: what SHOULD the address be, independent of
  // anything the sidecar reports.
  const expectedAddress = zanoAddressFromSeed(seed, seedPassphrase);

  const daemonUrl = await pickZanoDaemon().catch(() => ZANO_DEFAULT_DAEMON);

  // Stage A: ensure the wallet file exists (idempotent — no-ops if present).
  await ensureZanoWallet({
    walletPassword,
    seedPhrase: seed,
    seedPassphrase: seedPassphrase || undefined,
    walletFile,
  });

  // Stage B: spawn the RPC server.
  try {
    await startZanoRpc(daemonUrl, walletPassword, walletFile);
  } catch (e: any) {
    throw new Error(`Failed to start Zano wallet: ${String(e?.message ?? e)}`);
  }

  // Cross-check the RPC-reported address against the offline derivation.
  // Since Zano's restore has no RPC-level "open with wrong password"
  // failure mode to distinguish from "file belongs to a different seed",
  // an address mismatch is the only signal available — and per the
  // Secured-Seed hazard, it is the ONLY thing that can catch a wrong
  // passphrase. Treat it exactly like Zephyr's address-mismatch self-heal:
  // delete and recreate from the (trusted) seed.
  let actualAddress = "";
  try {
    actualAddress = await getAddress();
  } catch {
    /* fall through — treated as a mismatch below */
  }

  if (actualAddress !== expectedAddress) {
    console.warn(
      "[zano-wallet] opened wallet address doesn't match the seed; " +
        "deleting stale file and restoring fresh. opened=" +
        actualAddress +
        " expected=" +
        expectedAddress
    );
    await stopZanoRpc().catch(() => {});
    await ensureZanoWallet({
      walletPassword,
      seedPhrase: seed,
      seedPassphrase: seedPassphrase || undefined,
      forceRecreate: true,
      walletFile,
    });
    await startZanoRpc(daemonUrl, walletPassword, walletFile);
    actualAddress = await getAddress();
    if (actualAddress !== expectedAddress) {
      // Not a corrupt-file case if it survives a forced recreate — this
      // means the RPC-reported address genuinely disagrees with our own
      // derivation. Refuse rather than silently using either one: the
      // discrepancy could be exactly the wrong-Secured-Seed-passphrase
      // hazard `zano-keys.ts` warns about, and guessing which address is
      // "right" here would be the same trap in different clothes.
      throw new Error(
        "Zano wallet address mismatch persists after recreating the wallet " +
          `file (sidecar reports ${actualAddress}, expected ${expectedAddress}). ` +
          "If this seed uses a Secured Seed passphrase, double-check it — a " +
          "wrong passphrase derives a different, equally valid-looking wallet."
      );
    }
  }

  session = {
    seed,
    seedPassphrase,
    daemonUrl,
    walletPassword,
    currentAddress: actualAddress,
    walletFile,
  };
}

export async function closeZanoWallet(): Promise<void> {
  try {
    await storeWallet();
  } catch {
    /* non-fatal — stop still proceeds */
  }
  await stopZanoRpc().catch(() => {});
  session = null;
}

/**
 * Lock: end this app's Zano session without taking the wallet away from the
 * swap node. While the node is using Main, Rust stores the wallet and leaves
 * it serving; otherwise this stops Main exactly as `closeZanoWallet` does.
 * A wallet switch and wallet removal still use `closeZanoWallet`.
 *
 * 2026-09-15: Lock used `closeZanoWallet`, which killed Main under any ZANO
 * swap in flight, and under any offer that took a bid after the lock.
 */
export async function lockZanoWallet(): Promise<void> {
  await stopZanoRpc({ lock: true }).catch(() => {});
  session = null;
}

export function getZanoReceiveAddress(): string | null {
  return session?.currentAddress ?? null;
}

export function getActiveZanoDaemon(): string | null {
  return session?.daemonUrl ?? null;
}

/**
 * Switch the active daemon. Unlike `zph-wallet.ts::switchZphDaemon`, this
 * does NOT use a hot `set_daemon` RPC call — no such Zano wallet-rpc method
 * was verified during this integration (only getbalance/getaddress/
 * assets_whitelist_get/store/get_recent_txs_and_info3 were confirmed live).
 * Rather than assume Zano's `set_daemon` (if it exists at all) behaves the
 * same as Monero's, this stops and respawns the sidecar against the new
 * daemon — a brief interruption, but built entirely from already-verified
 * primitives. Revisit if a live-verified hot-swap method is confirmed.
 */
export async function switchZanoDaemon(daemonUrl: string): Promise<void> {
  if (!session) return;
  await stopZanoRpc();
  await startZanoRpc(daemonUrl, session.walletPassword, session.walletFile);
  session.daemonUrl = daemonUrl;
}

export function isZanoSessionActive(): boolean {
  return session !== null;
}

export async function getZanoBalanceDetailed(): Promise<{
  total: string;
  unlocked: string;
  hasLocked: boolean;
}> {
  const bal = await getNativeBalance();
  if (!bal) {
    return { total: "0", unlocked: "0", hasLocked: false };
  }
  const total = atomicToZano(bal.total, bal.assetInfo.decimalPoint);
  const unlocked = atomicToZano(bal.unlocked, bal.assetInfo.decimalPoint);
  return { total, unlocked, hasLocked: bal.total !== bal.unlocked };
}

/** Every whitelisted asset the wallet currently holds, decimals included —
 *  feeds `ZanoAssetsCard` (Phase 5). Not part of the `ChainAdapter` contract
 *  since only native ZANO participates in the standard balance/send flow. */
export async function getZanoAllAssetBalances(): Promise<ZanoAssetBalance[]> {
  return getAllBalances();
}

/**
 * The last 50 transfers, THROWING on an RPC failure.
 *
 * The session's poll uses this so a failed read keeps the list it already
 * shows. `getZanoTransactionHistory` answers `[]` on failure, which is
 * indistinguishable from "no transfers" and would blank the history card
 * for one tick every time the sidecar hiccups.
 */
export async function readZanoTransactionHistory(): Promise<ZanoTransferEntry[]> {
  return getRecentTransfers(0, 50);
}

export async function getZanoTransactionHistory(): Promise<ZanoTransferEntry[]> {
  try {
    return await readZanoTransactionHistory();
  } catch {
    return [];
  }
}

/**
 * Zano transfers as the generic history rows Activity renders.
 *
 * One mapping for both paths: the adapter's `getTransactionHistory`, and
 * App.tsx, which since 2026-09-16 feeds Activity from the Zano session's own
 * read instead of polling the sidecar a second time through the adapter.
 */
export function zanoTransfersToChainTx(
  entries: readonly ZanoTransferEntry[],
  limit?: number,
): ChainTx[] {
  const rows = limit == null ? entries : entries.slice(0, limit);
  return rows.map((e) => ({
    chain: "zano",
    hash: e.txHash ?? "",
    direction: e.isIncome ? "in" : "out",
    amount: atomicToZano(
      e.amount,
      e.assetId === ZANO_NATIVE_ASSET_ID ? ZANO_NATIVE_DECIMALS : 12
    ),
    timestamp: e.timestamp,
    height: e.height,
    meta: { assetId: e.assetId },
  }));
}

// =========================================================================
// Transaction parties (2026-09-30)
// =========================================================================

/** A wallet_transfer_info that spent this wallet's coins. */
function zanoEntryIsOutgoing(e: Record<string, any>): boolean {
  const spent = e?.employed_entries?.spent;
  if (Array.isArray(spent) && spent.length > 0) return true;
  const subs: any[] = [
    ...(Array.isArray(e?.subtransfers_by_pid)
      ? e.subtransfers_by_pid.flatMap((p: any) => (Array.isArray(p?.subtransfers) ? p.subtransfers : []))
      : []),
    ...(Array.isArray(e?.subtransfers) ? e.subtransfers : []),
  ];
  return subs.some((s) => s?.is_income === false);
}

/**
 * A `search_for_transactions2` answer for `txid` as parties, from the wallet
 * whose address is `own`. Exported for tests. Read from the vendored
 * simplewallet source, v2.2.1.506 — the version the app runs
 * (`.swap-sidecar-work/zano-build`); no funded Zano wallet was available to
 * observe a live answer.
 *
 *  - The answer is `{ in, out, pool }` lists of `wallet_transfer_info`
 *    (`COMMAND_RPC_SEARCH_FOR_TRANSACTIONS`). The confirmed lists are
 *    filtered by `tx_id`; the POOL list is not (`on_search_for_transactions2`
 *    pushes every unconfirmed transfer), so entries are matched by
 *    `tx_hash` here.
 *  - `remote_addresses` holds "destination if it's outgoing transfer or
 *    sender if it's incoming" (its DOC_DSCR). A sender appears only when it
 *    attached itself to the transaction (`tx_payer`, `show_sender`); the
 *    RPC's own `push_payer` is refused as unsupported, so for most receipts
 *    the sender is hidden, as the protocol intends.
 *  - A sent transaction's recipients are known when this wallet sent it
 *    (kept from its unconfirmed record) or the transaction carries them.
 */
export function zanoTransferParties(
  result: unknown,
  txid: string,
  own: string,
  source?: string,
): TxParties | null {
  const r = (result ?? {}) as { in?: unknown; out?: unknown; pool?: unknown };
  const id = txid.trim().toLowerCase();
  const pick = (list: unknown) =>
    (Array.isArray(list) ? list : []).filter(
      (e: any) => typeof e?.tx_hash === "string" && e.tx_hash.toLowerCase() === id,
    ) as Array<Record<string, any>>;
  const sent = pick(r.out);
  const received = pick(r.in);
  const pooled = pick(r.pool);
  const entries = [...sent, ...received, ...pooled];
  if (entries.length === 0) return null;
  const src = source ? { source } : {};
  const remote = uniqueAddresses(
    entries.flatMap((e) => (Array.isArray(e.remote_addresses) ? e.remote_addresses : [])),
  );
  if (sent.length > 0 || pooled.some(zanoEntryIsOutgoing)) {
    return { from: uniqueAddresses([own]), to: remote, ...src };
  }
  if (remote.length > 0) return { from: remote, to: uniqueAddresses([own]), ...src };
  return { from: [], to: uniqueAddresses([own]), senderHidden: true, ...src };
}

// =========================================================================
// Recipient validation (2026-09-29 send-safety audit, finding 4)
// =========================================================================
//
// The send used to hand `to` to simplewallet untouched, not even trimmed, and
// simplewallet accepts more than addresses (vendored v2.2.1.506 source):
//  - `@name` is an ALIAS, resolved by asking the daemon (`alias_helper.h`,
//    `get_transfer_address_cb`). This app talks to public nodes, so the node,
//    not the user, would have decided who got paid.
//  - a 42-character `0x…` string is a WRAP: the funds go to the bridge's
//    custody wallet with an ERC-20 withdrawal request attached
//    (`fill_destination_helper.h`, `is_address_like_wrapped`). This app does
//    not bridge; a pasted Ethereum address must not become a bridge deposit.
// So a recipient must be a Zano address this code can check itself: CryptoNote
// base58, a known prefix, a matching keccak checksum, and a body of the size
// that prefix carries (`get_account_address_and_payment_id_from_str`).

const CN_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Encoded length of a 0..8-byte block (Monero/Zano block base58). */
const CN_B58_ENCODED_BLOCK = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function cnBase58DecodeBlock(chunk: string, size: number): Uint8Array | null {
  let n = 0n;
  for (const ch of chunk) {
    const digit = CN_B58.indexOf(ch);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  if (n >= 1n << BigInt(8 * size)) return null; // overflows the block
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** CryptoNote block base58 → bytes, or null when malformed. */
function cnBase58Decode(s: string): Uint8Array | null {
  const full = Math.floor(s.length / 11);
  const lastSize = CN_B58_ENCODED_BLOCK.indexOf(s.length % 11);
  if (lastSize < 0) return null;
  const out = new Uint8Array(full * 8 + lastSize);
  for (let i = 0; i < full; i++) {
    const block = cnBase58DecodeBlock(s.slice(i * 11, i * 11 + 11), 8);
    if (!block) return null;
    out.set(block, i * 8);
  }
  if (lastSize > 0) {
    const block = cnBase58DecodeBlock(s.slice(full * 11), lastSize);
    if (!block) return null;
    out.set(block, full * 8);
  }
  return out;
}

/** Varint (7 bits per byte, little-endian) at the start of `b`. */
function readVarint(b: Uint8Array): { value: number; length: number } | null {
  let value = 0;
  for (let i = 0; i < b.length && i < 8; i++) {
    value += (b[i] & 0x7f) * 2 ** (7 * i);
    if ((b[i] & 0x80) === 0) return { value, length: i + 1 };
  }
  return null;
}

/** Payment-id size limit, `BC_PAYMENT_ID_SERVICE_SIZE_MAX` (bc_payments_id_service.h:10). */
const ZANO_PAYMENT_ID_MAX = 128;

/**
 * Accepted prefixes (currency_config.h:29-33) and the body each carries:
 * spend key + view key (64 bytes), the newer layout adds a flags byte (65),
 * and an integrated address appends a payment id.
 */
const ZANO_ADDRESS_PREFIXES: ReadonlyMap<number, (bodyLength: number) => boolean> = new Map([
  // "Zx…": standard, old (64) or new (65) layout.
  [0xc5, (n: number) => n === 64 || n === 65],
  // "iZ…": integrated, old layout + payment id.
  [0x3678, (n: number) => n > 64 && n <= 64 + ZANO_PAYMENT_ID_MAX],
  // "iZ…": integrated, new layout + payment id.
  [0x36f8, (n: number) => n > 65 && n <= 65 + ZANO_PAYMENT_ID_MAX],
  // "aZx…": auditable; an ordinary destination for a sender.
  [0x98c8, (n: number) => n === 65],
  // "aiZX…": auditable integrated.
  [0x8a49, (n: number) => n > 65 && n <= 65 + ZANO_PAYMENT_ID_MAX],
]);

/** Gateway addresses ("gwZ…", "gwiZ…", currency_config.h:35-36): not supported here. */
const ZANO_GATEWAY_PREFIXES = new Set([0x656e, 0x14276e]);

/**
 * Why `to` cannot be sent to, or null for a Zano address this wallet accepts.
 * `to` is expected trimmed. Exported for tests.
 */
export function zanoRecipientProblem(to: string): string | null {
  if (!to) return "Enter a Zano address.";
  if (to.startsWith("@")) {
    return (
      "Zano aliases (@name) are not accepted here: the public node this wallet uses would decide " +
      "which address the alias means. Paste the recipient's Zano address (Zx… or iZ…) instead."
    );
  }
  if (/^0x/i.test(to)) {
    return (
      "That is an Ethereum-style address. Zano's wallet would turn it into a bridge withdrawal " +
      "through a custody wallet, which this app does not do. Paste a Zano address (Zx… or iZ…)."
    );
  }
  const invalid = "That is not a valid Zano address (Zx… or iZ…).";
  const raw = cnBase58Decode(to);
  if (!raw || raw.length <= 4) return invalid;
  const payload = raw.subarray(0, raw.length - 4);
  const sum = keccak_256(payload).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (sum[i] !== raw[raw.length - 4 + i]) return invalid;
  }
  const prefix = readVarint(payload);
  if (!prefix) return invalid;
  if (ZANO_GATEWAY_PREFIXES.has(prefix.value)) {
    return "Zano gateway addresses (gw…) are not supported by this wallet yet.";
  }
  const bodyFits = ZANO_ADDRESS_PREFIXES.get(prefix.value);
  if (!bodyFits || !bodyFits(payload.length - prefix.length)) return invalid;
  return null;
}

// =========================================================================
// ChainAdapter implementation
// =========================================================================

export const zanoAdapter: ChainAdapter = {
  chain: "zano",
  displayName: "Zano",
  ticker: "ZANO",
  color: "#3ba0f5",
  addressPlaceholder: "Zx...",
  derivation: {
    kind: "independent-seed",
    note:
      "Zano uses its own 24-word mnemonic, not the wallet's BIP-39 phrase. Import or generate a Zano seed to set this chain up.",
  },

  usesIndependentSeed: true,

  async generateOwnSeed(): Promise<string> {
    return generateZanoSeed();
  },

  async deriveFromOwnSeed(seed: string): Promise<WalletInfo> {
    const normalized = normalizeZanoSeed(seed);
    if (!validateZanoSeed(normalized)) {
      throw new Error("Invalid Zano seed phrase.");
    }
    const meta = readZanoSeedMeta(normalized);
    if (meta.auditable) {
      throw new Error("Auditable Zano wallets are not supported yet.");
    }
    if (meta.passwordProtected) {
      // Address cannot be derived here without the passphrase, and this
      // entry point has nowhere to collect one — the import UI must call
      // `initZanoSession` directly (which does accept a passphrase) for a
      // Secured Seed rather than going through this generic path.
      throw new Error(
        "This Zano seed is password-protected (Secured Seed). Import it " +
          "through the Zano panel, which prompts for the passphrase."
      );
    }
    const address = zanoAddressFromSeed(normalized);
    return { chain: "zano", address, mnemonic: normalized, privateKey: "" };
  },

  importFromMnemonic(_mnemonic: string): WalletInfo {
    throw new Error("Zano uses an independent seed, not a BIP39 phrase.");
  },
  deriveFromMnemonic(_mnemonic: string): WalletInfo {
    throw new Error("Zano uses an independent seed. Use deriveFromOwnSeed().");
  },
  importFromPrivateKey(_seed: string): WalletInfo {
    throw new Error("Zano import requires the seed phrase — use deriveFromOwnSeed().");
  },

  async getBalance(_address: string): Promise<string> {
    if (!session) return "Syncing…";
    const detail = await getZanoBalanceDetailed();
    return detail.total;
  },

  /**
   * Send native ZANO (2026-09-29 send-safety audit, findings 4 and 5).
   *
   * The recipient is checked here first (`zanoRecipientProblem`): no aliases,
   * no bridge wraps, a real Zano address. The fee is explicit
   * (`ZANO_TRANSFER_FEE_ATOMIC`): without it simplewallet refused every send.
   *
   * simplewallet's `transfer` builds and broadcasts in ONE call and cannot do
   * one without the other for a full wallet, so the txid exists only once it
   * succeeds. A failure that could have come after the broadcast
   * (`zanoSendMayHaveBroadcast`) is reported as `SendOutcomeUnknownError`,
   * which closes the form, rather than "failed" with the form still filled.
   */
  async sendTransaction(
    _seed: string,
    to: string,
    amount: string,
    _assetType?: string
  ): Promise<TxResult> {
    if (!session) {
      throw new Error("Zano session not initialized.");
    }
    // `_assetType` is intentionally unused in v1: send is native-ZANO-only
    // (see file header). Wiring confidential-asset sends is Phase 5 scope,
    // once ZanoAssetsCard exists to pick a specific asset_id.
    const recipient = to.trim();
    const problem = zanoRecipientProblem(recipient);
    if (problem) throw new Error(problem);
    const atomic = zanoToAtomic(amount, ZANO_NATIVE_DECIMALS);
    let result;
    try {
      result = await transfer({
        destinations: [{ address: recipient, amount: atomic }],
        fee: ZANO_TRANSFER_FEE_ATOMIC,
      });
    } catch (e) {
      const raw = errorText(e, "The Zano wallet returned no error message.");
      if (zanoSendMayHaveBroadcast(e)) {
        throw new SendOutcomeUnknownError(
          `The Zano wallet did not confirm the send (${raw}).`
        );
      }
      throw new Error(raw);
    }
    if (!result.txHash) {
      // It answered success; the transaction went out without an id we can show.
      throw new SendOutcomeUnknownError("The Zano wallet reported the send without a transaction id.");
    }
    return { hash: result.txHash };
  },

  /**
   * Unlocked and total native ZANO, so the Send modal shows what can be sent
   * now (finding 8). Zano's `getbalance` reports both per asset.
   */
  async getSendableBalance(): Promise<SendableBalance> {
    if (!session) throw new Error("Zano session not initialized.");
    const bal = await getNativeBalance();
    if (!bal) return { unlocked: "0", total: "0" };
    return {
      unlocked: atomicToZano(bal.unlocked, bal.assetInfo.decimalPoint),
      total: atomicToZano(bal.total, bal.assetInfo.decimalPoint),
    };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    return {
      label: "Network",
      value: session ? "Zano mainnet" : "Not connected",
      unit: "",
    };
  },

  async getTransactionHistory(
    _address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    const entries = await getZanoTransactionHistory();
    return { items: zanoTransfersToChainTx(entries, limit) };
  },

  /**
   * This wallet's own record of one transaction, from simplewallet's
   * `search_for_transactions2` by `tx_id` (2026-09-30), through the existing
   * `zano_rpc_call` passthrough; parsed by `zanoTransferParties`. `null`
   * when the wallet holds no transfer with that hash.
   */
  async getTransactionParties(hash: string, ownAddress: string): Promise<TxParties | null> {
    if (!session) {
      throw new Error("The Zano wallet is not open, so its transactions cannot be read.");
    }
    const txid = hash.trim();
    let result: unknown;
    try {
      result = await invoke("zano_rpc_call", {
        method: "search_for_transactions2",
        params: {
          tx_id: txid,
          in: true,
          out: true,
          pool: true,
          filter_by_height: false,
          min_height: 0,
          max_height: 0,
        },
      });
    } catch (e) {
      throw new Error(`Zano simplewallet (local) could not read transaction ${txid}: ${errorText(e)}`);
    }
    return zanoTransferParties(result, txid, session.currentAddress || ownAddress, "zano simplewallet (local)");
  },

  /**
   * The fee a send pays, exactly: this app sets it (`ZANO_TRANSFER_FEE_ATOMIC`,
   * 0.01 ZANO) since 2026-09-29. It used to report "network-determined" while
   * the send passed no fee at all, which simplewallet refused (finding 5).
   */
  async getFeeEstimate(): Promise<FeeEstimate> {
    return {
      normal: { value: atomicToZano(ZANO_TRANSFER_FEE_ATOMIC, ZANO_NATIVE_DECIMALS) },
      unit: "ZANO",
      fetchedAt: Date.now(),
    };
  },
};

export {
  ZANO_NATIVE_ASSET_ID,
  ZANO_NATIVE_DECIMALS,
  type ZanoAssetBalance,
  type ZanoTransferEntry,
};
