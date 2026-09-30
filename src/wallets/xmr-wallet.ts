/**
 * Monero (XMR) ChainAdapter — sidecar-backed implementation.
 *
 * All on-line operations (balance, send, sync status) go through the
 * monero-wallet-rpc sidecar managed by `src-tauri/src/xmr_rpc.rs`. The
 * frontend talks to it via `xmr-rpc.ts`.
 *
 * Offline operations (generate a new 25-word seed, derive an address from
 * a seed without network, validate a seed) live in `xmr-keys.ts` and are
 * implemented in pure JS via `@noble/curves` + `@noble/hashes`. Those
 * calls don't need the sidecar and must work at wallet creation / import
 * time before any daemon connection exists.
 *
 * Lifecycle:
 *   - App.tsx unlocks the vault and calls `initXmrSession(seed, masterPw)`
 *     which picks a daemon (in parallel), starts the sidecar with RPC auth,
 *     opens/restores the wallet file (encrypted with a key derived from the
 *     master password), enables auto-refresh, and returns.
 *   - `getBalance` / `sendTransaction` assume the session is already
 *     initialized. They just call the RPC.
 *   - App.tsx calls `closeXmrWallet()` on logout.
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
} from "./types";
import { errorText } from "../lib/errorText";
import {
  generateXmrSeed,
  xmrAddressFromSeed,
  validateXmrSeed,
  normalizeXmrSeed,
  xmrKeysFromRawSecret,
  bytesToHex,
} from "./xmr-keys";
import {
  generatePolyseed,
  polyseedToMoneroSpendKey,
  validatePolyseed,
  normalizePolyseed,
  birthdayToRestoreHeight,
  polyseedDecode,
} from "./polyseed";
import {
  getSelectedNode,
  raceBestNode,
  getBestNodeUrl,
  startHealthLoop,
  stopHealthLoop,
  onHealthUpdate,
  getHealthSnapshot,
  getActivePool,
  HOT_SWAP_SPEEDUP_THRESHOLD,
} from "./xmr-nodes";
import {
  startXmrRpc,
  stopXmrRpc,
  openWallet,
  restoreDeterministicWallet,
  closeWallet,
  autoRefresh,
  getBalance,
  piconeroToXmr,
  getHeight,
  getSyncStatus,
  setDaemon,
  buildTransfer,
  relayTransfer,
  lookupOwnTransfer,
  settleRelayFailure,
  validateAddress,
  createAddress,
  getTransfers,
  changeWalletPassword,
  fetchCurrentDaemonHeight,
  generateFromKeys,
  getAddress,
  deleteXmrWalletFiles,
  XMR_WALLET_FILENAME,
  checkWalletRpcExists,
  downloadWalletRpc,
  checkXmrDefenderExclusion,
  addXmrDefenderExclusion,
  type XmrTransfer,
  type XmrValidateAddressResult,
} from "./xmr-rpc";

/** Which on-disk seed format a given vault entry holds. */
export type XmrSeedFormat = "polyseed" | "legacy";

// =========================================================================
// Per-session state
// =========================================================================

interface XmrSession {
  seed: string;
  seedFormat: XmrSeedFormat;
  daemonUrl: string;
  walletOpen: boolean;
  /** Wallet-file encryption password (derived from vault master password). */
  walletPassword: string;
  /** Current receive subaddress (starts with "8"). Null until created. */
  currentReceiveAddress: string | null;
  /**
   * Restore height this session was initialized with. Used as a floor for
   * `getSyncStatus` so the UI doesn't render "block 1 / tip" while the
   * wallet-rpc is mid-first-refresh (get_height stays at 1 until that
   * first cycle completes — can be many minutes on a 500K-block gap).
   */
  restoreHeight: number;
  /** On-disk wallet filename this session opened (per-wallet, multi-wallet). */
  walletFilename: string;
  /**
   * Which session this is. A send records it between building and relaying,
   * so a transaction built by one wallet is never relayed through the next
   * one's wallet-rpc (2026-09-29, the same guard Zephyr's quotes carry).
   */
  epoch: number;
}

let session: XmrSession | null = null;
let sessionEpoch = 0;

// =========================================================================
// Helpers
// =========================================================================

/**
 * Derive a wallet-file encryption password from the vault master password.
 * Uses PBKDF2-SHA256 with a fixed salt so the same master password always
 * yields the same wallet-file password — enabling decryption across restarts
 * without prompting the user again.
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
      salt: enc.encode("pwnda-xmr-wallet-file"),
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

/**
 * Pick the daemon this session should bind to.
 *
 * Delegates to `raceBestNode` which applies the full priority chain:
 *   1. User pin (always honored, never replaced).
 *   2. Health-cache best node (lowest latency + caught-up height).
 *   3. Parallel race over the baked-in + runtime Feather pool.
 *   4. Community fallback (xmr.ditatompel.com) if every curated node is dead.
 */
async function pickDaemon(): Promise<string> {
  return raceBestNode();
}

/**
 * If the health loop has surfaced a node that's meaningfully faster than the
 * one the session is bound to, swap to it via wallet-rpc's `set_daemon`.
 * Swapping mid-sync is cheap — no wallet reopen — and Monero's chain is the
 * same on every honest node, so the scan resumes from the same height.
 *
 * Guarded by `HOT_SWAP_SPEEDUP_THRESHOLD` so we don't flap on small latency
 * variance. Never swaps away from a user-pinned node.
 */
async function maybeHotSwap(): Promise<void> {
  if (!session) return;
  if (await getSelectedNode()) return; // user pin: leave alone

  const current = session.daemonUrl;
  const snapshot = getHealthSnapshot();
  if (snapshot.length === 0) return;

  const curEntry = snapshot.find((h) => h.url === current);
  const best = snapshot.find((h) => h.ok);
  if (!best || best.url === current) return;

  const currentLatency =
    curEntry && curEntry.ok ? curEntry.latencyMs : Number.POSITIVE_INFINITY;
  if (currentLatency / best.latencyMs < HOT_SWAP_SPEEDUP_THRESHOLD) return;

  try {
    console.warn(
      `[xmr-wallet] hot-swapping daemon ${current} (${currentLatency}ms) → ${best.url} (${best.latencyMs}ms)`
    );
    await setDaemon(best.url);
    session.daemonUrl = best.url;
  } catch (e) {
    console.warn("[xmr-wallet] hot-swap failed:", e);
  }
}

/** Unsubscribe for the in-session health listener. Set when loop starts. */
let healthUnsubscribe: (() => void) | null = null;

// =========================================================================
// Public session management
// =========================================================================

/**
 * Hot-swap the running sidecar to a different daemon URL without
 * restarting the wallet. Used by Settings → Monero Nodes.
 */
export async function switchXmrDaemon(daemonUrl: string): Promise<void> {
  if (!session) return;
  await setDaemon(daemonUrl);
  session.daemonUrl = daemonUrl;
}

/** Returns the daemon URL the active session is currently bound to. */
export function getActiveXmrDaemon(): string | null {
  return session?.daemonUrl ?? null;
}

/**
 * Detect the format of a seed string based on its word count.
 * Polyseed = 16 words; legacy Electrum-style = 25 words. Anything else
 * is rejected — we don't support 12/13/14-word formats.
 */
export function detectXmrSeedFormat(seed: string): XmrSeedFormat | null {
  const words = seed.trim().split(/\s+/).filter(Boolean);
  if (words.length === 16) return "polyseed";
  if (words.length === 25) return "legacy";
  return null;
}

/**
 * Validate a seed (either format). Returns an error message for unknown
 * formats, failed checksums, or unknown words. Cheap enough to run on
 * every keystroke.
 */
export async function validateAnyXmrSeed(
  seed: string
): Promise<{ ok: true; format: XmrSeedFormat } | { ok: false; error: string }> {
  const format = detectXmrSeedFormat(seed);
  if (!format) {
    return {
      ok: false,
      error: "Expected 16 words (polyseed) or 25 words (legacy). Check for missing/extra words.",
    };
  }
  if (format === "polyseed") {
    const r = validatePolyseed(seed);
    return r.ok ? { ok: true, format } : r;
  }
  const r = await validateXmrSeed(seed);
  return r.ok ? { ok: true, format } : r;
}

/**
 * Derive the primary Monero address from any supported seed format.
 * For polyseed this runs the PBKDF2 keygen; for legacy it uses the
 * existing 25-word path. Both are pure JS / offline.
 */
export async function xmrAddressFromAnySeed(seed: string): Promise<string> {
  const format = detectXmrSeedFormat(seed);
  if (format === "polyseed") {
    const { spendKeyRaw } = polyseedToMoneroSpendKey(seed);
    const { address } = await xmrKeysFromRawSecret(spendKeyRaw);
    return address;
  }
  if (format === "legacy") {
    return xmrAddressFromSeed(seed);
  }
  throw new Error("Unrecognized Monero seed format (expected 16 or 25 words).");
}

/**
 * Convert a polyseed's embedded birthday into a Monero restore block
 * height, biased ~30 days back for safety. Returns 0 for seeds with
 * birthday=0 (pre-2021 or missing).
 */
export async function polyseedRestoreHeight(seed: string): Promise<number> {
  const decoded = polyseedDecode(seed);
  if (!decoded.ok) return 0;
  return birthdayToRestoreHeight(decoded.data.birthday);
}

/**
 * Probe trusted nodes (respecting the pinned selection) and return the current
 * chain tip height. Used at wallet creation/import to persist `xmrRestoreHeight`.
 * Returns 0 if no node reachable — caller decides whether to proceed.
 */
export async function probeCurrentXmrHeight(): Promise<number> {
  try {
    const pinned = await getSelectedNode();
    if (pinned) {
      const h = await fetchCurrentDaemonHeight(pinned);
      if (h > 0) return h;
    }
    // Prefer the health cache's best node when one is already known — one
    // round-trip instead of racing the whole pool.
    const best = getBestNodeUrl();
    if (best) {
      const h = await fetchCurrentDaemonHeight(best);
      if (h > 0) return h;
    }
    // Race the full (baked + runtime feather) pool; first non-zero height wins.
    const pool = await getActivePool();
    const probes = pool.map((n) => fetchCurrentDaemonHeight(n.url));
    const results = await Promise.all(probes);
    return Math.max(0, ...results);
  } catch {
    return 0;
  }
}

/**
 * Initialize the full Monero session: pick a daemon (parallel probe), start
 * the RPC sidecar with per-session authentication, open (or restore) the
 * wallet file encrypted with a key derived from `masterPassword`, and enable
 * background auto-refresh.
 *
 * Handles both seed formats:
 *   - "polyseed"  → we derive the spend/view keys in pure JS and hand them
 *                   to `generate_from_keys`. The wallet-rpc this ships with
 *                   (v0.18.4.6) has no polyseed-aware method, so the seed
 *                   never leaves the renderer — only derived keys do.
 *   - "legacy"    → the standard `restore_deterministic_wallet` path.
 *
 * Safe to call multiple times — subsequent calls with the same seed are a
 * no-op once `session.walletOpen` is true.
 *
 * @param rawSeed        16-word polyseed or 25-word legacy seed.
 * @param masterPassword Vault master password used to derive the wallet-file
 *                       encryption key.
 * @param restoreHeight  Block height to start scanning from. For polyseed
 *                       this defaults to the birthday-derived height if 0
 *                       is passed; for legacy, 0 means scan from genesis.
 */
export async function initXmrSession(
  rawSeed: string,
  masterPassword: string,
  restoreHeight: number = 0,
  // On-disk wallet filename. Defaults to the single legacy name so existing
  // (single-wallet) callers are byte-identical; multi-wallet callers pass the
  // entry's per-wallet `sidecarFile` (e.g. "pwnda-xmr-<id>"). The Rust sidecar
  // launches with --wallet-dir, so one process serves any filename in the dir.
  walletFilename: string = XMR_WALLET_FILENAME
): Promise<void> {
  const format = detectXmrSeedFormat(rawSeed);
  if (!format) {
    throw new Error("Unrecognized Monero seed format (expected 16 or 25 words).");
  }
  const seed =
    format === "polyseed" ? normalizePolyseed(rawSeed) : normalizeXmrSeed(rawSeed);
  const walletPassword = await deriveWalletPassword(masterPassword);

  // Polyseed: if the caller didn't pin a restore height, prefer the one
  // embedded in the seed itself. This keeps imports fast even when the
  // vault was written by an older version that didn't persist the field.
  if (format === "polyseed" && (restoreHeight === 0 || Number.isNaN(restoreHeight))) {
    restoreHeight = await polyseedRestoreHeight(seed);
  }

  // Fast path: same seed, already initialized.
  if (session && session.seed === seed && session.walletOpen) {
    return;
  }

  // Different seed — tear down the old session first.
  if (session) {
    try {
      await closeWallet();
    } catch {
      /* ignore */
    }
  }

  // 0. Ensure monero-wallet-rpc.exe is present.
  const rpcExists = await checkWalletRpcExists();
  if (!rpcExists) {
    await downloadWalletRpc();
    const existsAfter = await checkWalletRpcExists();
    if (!existsAfter) {
      throw new Error(
        "monero-wallet-rpc.exe was downloaded but is missing — " +
          "Windows Defender likely quarantined it. Please add a Defender " +
          "exclusion via Settings → Monero and try again."
      );
    }
  }

  // 1. Pick a live daemon from the trusted list (parallel probe).
  const daemonUrl = await pickDaemon();

  // 2. Start the sidecar. If the daemon changed, stop first so the new
  //    instance picks up the correct daemon URL.
  //
  // C9: both calls carry the "session" lease explicitly. If the swap engine
  // also holds "swap_engine" on this same process, releasing "session" here
  // does NOT stop it (the engine's lease keeps it alive) — but re-acquiring
  // "session" on the restart still correctly re-registers this caller's
  // claim. See `xmr_rpc.rs`'s `XmrLease` doc for the full reasoning.
  if (session && session.daemonUrl !== daemonUrl) {
    await stopXmrRpc("session");
  }

  try {
    await startXmrRpc(daemonUrl, "session");
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("os error 225") || msg.includes("virus")) {
      throw new Error(
        "Windows Defender blocked monero-wallet-rpc.exe (false positive — " +
          "this is a known issue with all Monero binaries). Please add a " +
          "Defender exclusion via Settings → Monero and try again."
      );
    }
    throw e;
  }

  // 3. Derive the expected primary address from the seed up-front so we
  //    can cross-check any opened wallet file against it. A mismatch means
  //    the on-disk wallet was created for a different seed (or with wrong
  //    parameters — e.g. restore_height=0 from a failed earlier import)
  //    and must be rebuilt from scratch.
  const expectedAddress = await xmrAddressFromAnySeed(seed);

  /**
   * Create the wallet file from the seed using the format-appropriate RPC:
   * `generate_from_keys` for polyseed (wallet-rpc v0.18.4.6 has no polyseed
   * method, so we derive keys in JS), `restore_deterministic_wallet` for
   * legacy 25-word. Both paths write a fresh file at XMR_WALLET_FILENAME
   * encrypted with `walletPassword` and start scanning at `restoreHeight`.
   */
  const restoreFromSeed = async (): Promise<void> => {
    if (format === "polyseed") {
      const { spendKeyRaw } = polyseedToMoneroSpendKey(seed);
      const keys = await xmrKeysFromRawSecret(spendKeyRaw);
      await generateFromKeys({
        filename: walletFilename,
        password: walletPassword,
        restoreHeight,
        address: keys.address,
        viewkey: bytesToHex(keys.viewSecret),
        spendkey: bytesToHex(keys.spendSecret),
      });
    } else {
      await restoreDeterministicWallet(
        seed,
        walletFilename,
        restoreHeight,
        walletPassword
      );
    }
  };

  // 4. Open or restore the wallet file. Cases, in order:
  //    a) File exists, our password works → open succeeds.
  //    b) File exists, opens with "" (pre-encryption wallet) → open, then
  //       rotate to the derived password.
  //    c) File doesn't exist, or exists but can't be opened for any reason
  //       → delete if present, restore from seed. Safe because the seed is
  //       authoritative: we can always rebuild the wallet file from it with
  //       no fund loss.
  //    d) File opened but its primary address doesn't match what the seed
  //       would derive (stale file from a pre-polyseed-support import, or
  //       a different seed on this profile) → close, delete, restore.
  let walletOpen = false;

  try {
    await openWallet(walletFilename, walletPassword);
    walletOpen = true;
  } catch {
    try {
      await openWallet(walletFilename, "");
      try {
        await changeWalletPassword("", walletPassword);
      } catch {
        /* non-fatal — still open and usable */
      }
      walletOpen = true;
    } catch (openErr: any) {
      // Both open attempts failed. Reaching here means the wallet file is
      // either missing, partial (interrupted restore from a previous session),
      // corrupt, encrypted with a password we no longer have, or belongs to
      // a different seed. In every case the recovery is the same: wipe the
      // on-disk file and regenerate from the seed. We never lose funds —
      // the seed is the source of truth and `restoreHeight` is persisted
      // in the vault, so only sync progress past that point is discarded.
      //
      // Before this fallback was automatic, the user saw
      // "RPC error -1: Wallet already exists" after an interrupted restore,
      // because `restoreFromSeed` tried to create a file that was already
      // half-written on disk. That error is now invisible — we delete first.
      // 2026-06-14 — NON-destructive recovery FIRST (mirrors zph-wallet).
      // After a mem_guard WebView2 reload the JS session cache is wiped but
      // the Rust wallet-rpc sidecar still has the wallet OPEN, locking the
      // .keys file → open_wallet fails (Windows system:32 /
      // is_keys_file_locked), and the destructive self-heal below ALSO fails
      // (delete is a no-op on a locked file → restore throws file_exists),
      // latching the titlebar red "error" forever (the auto-retry just
      // re-hits the same lock). close_wallet via RPC releases the sidecar's
      // own lock; reopening then succeeds with no re-scan.
      // See [[2026-06-13-titlebar-sync-error-latch]].
      let recovered = false;
      try {
        await closeWallet();
        await openWallet(walletFilename, walletPassword);
        walletOpen = true;
        recovered = true;
      } catch {
        /* fall through to the destructive self-heal below */
      }
      if (!recovered) {
        let deleted = false;
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            await deleteXmrWalletFiles(walletFilename);
            deleted = true;
            break;
          } catch {
            // File handle may still be held by a just-closed wallet-rpc on
            // Windows — back off and try again.
            await new Promise((r) => setTimeout(r, 300));
          }
        }

        try {
          await restoreFromSeed();
          walletOpen = true;
        } catch (restoreErr: any) {
          const openMsg = String(openErr?.message ?? openErr);
          const restoreMsg = String(restoreErr?.message ?? restoreErr);
          const suffix = deleted
            ? ""
            : " (on-disk wallet file could not be deleted — close any other " +
              "Monero wallet app and retry, or click \"Forget Monero Wallet\" " +
              "in Settings)";
          throw new Error(
            `Failed to restore Monero wallet: ${restoreMsg}${suffix} ` +
              `[open error: ${openMsg}]`
          );
        }
      }
    }
  }

  // 4d. Self-heal: if we opened an existing wallet file but it's for the
  //     wrong seed (or was created with a wrong restore_height by an older
  //     version), wipe it and restore cleanly. This is what prevents a
  //     pre-polyseed-support wallet file (`restore_height: 0`, ~3.4M blocks
  //     to scan) from surviving a re-login on the new code. Users used to
  //     have to manually "Forget Monero Wallet" — this now happens silently.
  if (walletOpen) {
    let openedAddress = "";
    try {
      openedAddress = await getAddress();
    } catch {
      /* non-fatal — if the address query fails we leave things alone */
    }
    if (openedAddress && openedAddress !== expectedAddress) {
      console.warn(
        "[xmr-wallet] opened wallet address doesn't match the seed; " +
          "deleting stale file and restoring fresh. opened=" +
          openedAddress +
          " expected=" +
          expectedAddress
      );
      try {
        await closeWallet();
      } catch {
        /* ignore */
      }
      // On Windows, `close_wallet` returns before wallet-rpc fully releases
      // the file handle. If we delete + generate_from_keys immediately, we
      // hit `error::file_exists` because the file is still there. Retry the
      // delete a few times with small backoffs so the handle has time to
      // close. Observed window: up to ~1.5s in practice.
      let deleted = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          await deleteXmrWalletFiles(walletFilename);
          deleted = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      if (!deleted) {
        console.warn(
          "[xmr-wallet] self-heal: delete kept failing; restoreFromSeed will likely error. " +
            "User should click 'Forget Monero Wallet' in Settings."
        );
      }
      await restoreFromSeed();
    }
  }

  void walletOpen;

  // 4. Enable background auto-refresh. This is the sole sync driver —
  //    we no longer fire a detached refresh(0) which would block for hours
  //    on a fresh wallet without giving us any cancellation path.
  try {
    await autoRefresh(true, 10);
  } catch {
    /* non-fatal */
  }

  // 5. Generate (or reuse) a receive subaddress.
  //    Subaddresses start with "8" and are unlinkable to the primary "4..." address.
  let currentReceiveAddress: string | null = null;
  try {
    const result = await createAddress(0, "receive");
    currentReceiveAddress = result.address;
  } catch {
    /* non-fatal — primary address will be used as fallback */
  }

  session = {
    seed,
    seedFormat: format,
    daemonUrl,
    walletOpen: true,
    walletPassword,
    currentReceiveAddress,
    restoreHeight,
    walletFilename,
    epoch: ++sessionEpoch,
  };

  // 6. Kick off the background health loop so the Settings UI always has
  //    fresh latency/height data and `maybeHotSwap` can upgrade us mid-sync
  //    if a faster node emerges. 60s cadence is cheap (one /get_info per
  //    node per minute) and well under the "stale" threshold.
  startHealthLoop(60_000);
  if (healthUnsubscribe) healthUnsubscribe();
  healthUnsubscribe = onHealthUpdate(() => {
    void maybeHotSwap();
  });
}

/** The on-disk filename the active session opened, or null if none is
 *  active. Read this BEFORE `closeXmrWallet()` — it nulls the session. Used
 *  by "Forget" to delete the file the CURRENT session actually has open,
 *  not always the primary wallet's. */
export function getActiveXmrWalletFilename(): string | null {
  return session?.walletFilename ?? null;
}

/** Tear down the XMR session: close the wallet, release this caller's claim
 *  on the sidecar (see {@link XmrLease} — under C9 the process itself may
 *  stay up for the swap engine even after this releases "session"). */
export async function closeXmrWallet(): Promise<void> {
  if (!session) return;
  session = null;
  if (healthUnsubscribe) {
    healthUnsubscribe();
    healthUnsubscribe = null;
  }
  stopHealthLoop();
  try {
    await stopXmrRpc("session");
  } catch {
    /* ignore */
  }
}

/** Returns the current receive subaddress (starts with "8"), or null if session not initialized. */
export function getXmrReceiveAddress(): string | null {
  return session?.currentReceiveAddress ?? null;
}

/**
 * Generate a fresh receive subaddress and update the session.
 * Call this when the user clicks "New Address" to get a fresh unused address.
 */
export async function refreshXmrReceiveAddress(): Promise<string> {
  if (!session) throw new Error("Monero session not initialized");
  const result = await createAddress(0, "receive");
  session.currentReceiveAddress = result.address;
  return result.address;
}

/**
 * Fetch full transaction history for the open wallet.
 * Merges incoming, outgoing, pending, and pool transactions sorted newest-first.
 * Only call when synced — history is incomplete during initial scan.
 */
export async function getXmrTransactionHistory(): Promise<XmrTransfer[]> {
  if (!session) return [];
  try {
    // `failed` too (2026-09-29): see the adapter's `getTransactionHistory`.
    const transfers = await getTransfers({
      in: true,
      out: true,
      pending: true,
      pool: true,
      failed: true,
    });
    return transfers.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

/**
 * Returns both total and unlocked (spendable) balance as formatted XMR strings.
 * Use this for the detailed balance display in the UI.
 */
export async function getXmrBalanceDetailed(): Promise<{
  total: string;
  unlocked: string;
  hasLocked: boolean;
}> {
  const bal = await getBalance();
  const total = piconeroToXmr(bal.balance);
  const unlocked = piconeroToXmr(bal.unlocked_balance);
  return {
    total,
    unlocked,
    hasLocked: bal.balance !== bal.unlocked_balance,
  };
}

/** No-op shim kept for App.tsx API compatibility. Session state lives in this module. */
export function setActiveXmrSeed(_seed: string): void {
  void _seed;
}

/** Current sync progress, or null if no session is initialized. */
export async function getXmrSyncProgress(): Promise<{
  walletHeight: number;
  daemonHeight: number;
  synced: boolean;
  percent: number;
  daemonOk: boolean;
} | null> {
  if (!session) return null;
  try {
    return await getSyncStatus(session.daemonUrl, session.restoreHeight);
  } catch {
    return null;
  }
}

// =========================================================================
// Send helpers (2026-09-29 send-safety audit)
// =========================================================================

interface XmrSyncStatus {
  walletHeight: number;
  daemonHeight: number;
  synced: boolean;
  percent: number;
  daemonOk: boolean;
}

/**
 * Why a send must wait, or `null` when the wallet is synced. Zephyr's
 * `zphSyncRefusal` wording, ported (finding 7).
 *
 * A failed daemon probe (`daemonOk: false`, `daemonHeight: 0`) used to read
 * "Monero wallet not fully synced (0.0% — N / 0)", blaming the wallet for a
 * node it could not reach; a busy `get_height` (no status at all) printed
 * "(?% — 0 / 0)".
 */
export function xmrSyncRefusal(status: XmrSyncStatus | null): string | null {
  if (!status) {
    return (
      "The Monero wallet did not report whether it is synced (it may be busy). " +
      "Please wait a moment and try again."
    );
  }
  if (status.synced) return null;
  if (!status.daemonOk) {
    return (
      `Could not reach a Monero node to confirm the wallet is synced (wallet at block ${status.walletHeight}). ` +
      "Check the Monero node in Settings, then try again."
    );
  }
  return (
    `Monero wallet not fully synced (${status.percent.toFixed(1)}% — ${status.walletHeight} / ${status.daemonHeight}). ` +
    "Please wait for sync to complete before sending."
  );
}

/**
 * A recipient that is not even shaped like an address, or null.
 *
 * Base58 only. `transfer` resolves anything that does not parse as an address
 * as an OpenAlias name through DNS (`validate_transfer` →
 * `get_account_address_from_str_or_url` in wallet_rpc_server.cpp), so when
 * `validate_address` (which this app calls with `allow_openalias: false`) is
 * unavailable, a name like `donate.example.org` would have been paid to
 * whatever address DNS returned, never shown to the user.
 */
export function xmrRecipientShapeProblem(to: string): string | null {
  if (!to) return "Enter a Monero address.";
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(to)) {
    return (
      "That is not a Monero address. Paste the address itself; this wallet does not " +
      "look up names (OpenAlias)."
    );
  }
  return null;
}

/** A `validate_address` answer that rules the recipient out, or null. */
export function xmrRecipientProblem(v: XmrValidateAddressResult): Error | null {
  if (!v.valid) return new Error("Invalid Monero address.");
  if (v.nettype !== "mainnet") return new Error(`Address is for ${v.nettype}, not mainnet.`);
  return null;
}

/**
 * Ask the wallet whether `to` is a mainnet Monero address (finding 6).
 *
 * A failing `validate_address` CALL is not a verdict: the build checks the
 * address again and fails with its own error. This catch used to read
 * `e.message.startsWith(...)`; Tauri rejects with a plain string, so the catch
 * itself threw "Cannot read properties of undefined (reading 'startsWith')"
 * and the send died on a TypeError. The pattern is Zephyr's `checkZphRecipient`.
 */
async function checkXmrRecipient(to: string): Promise<Error | null> {
  const shape = xmrRecipientShapeProblem(to);
  if (shape) return new Error(shape);
  let v: XmrValidateAddressResult;
  try {
    v = await validateAddress(to);
  } catch (e) {
    console.warn(
      "[xmr-wallet] validate_address failed; the build will check the address itself:",
      errorText(e)
    );
    return null;
  }
  return xmrRecipientProblem(v);
}

/**
 * A failed BUILD (`transfer` with `do_not_relay`), as a readable error.
 * Nothing was broadcast by a build, so every one of these is safe to retry.
 * Codes are wallet_rpc_server's, as `wallet_rpc_common.rs` formats them
 * (`RPC error <code>: <message>`); the raw text is kept in every message.
 */
export function classifyXmrBuildError(e: unknown): Error {
  const raw = errorText(e, "The Monero wallet returned no error message.");
  const m = /^RPC error (-?\d+):\s*([\s\S]*)$/.exec(raw.trim());
  const code = m ? Number(m[1]) : null;
  const msg = m ? m[2] : raw;
  if (code === -37 || /not enough unlocked money/i.test(msg)) {
    return new Error(
      "Not enough unlocked XMR for this amount plus the network fee. Received funds and change " +
        `unlock after 10 blocks (about 20 minutes). Nothing was sent. (${raw})`
    );
  }
  if (
    code === -17 ||
    /not enough money/i.test(msg) ||
    (code === -16 && /^Transaction not possible/i.test(msg))
  ) {
    return new Error(`Not enough XMR for this amount plus the network fee. Nothing was sent. (${raw})`);
  }
  if (code === -2 || /WALLET_RPC_ERROR_CODE_WRONG_ADDRESS/.test(msg)) {
    return new Error(`That is not a valid Monero address. Nothing was sent. (${raw})`);
  }
  if (code === -38 || code === -3) {
    return new Error(
      `The Monero wallet cannot reach its node, or the node is busy. Nothing was sent; try again shortly. (${raw})`
    );
  }
  if (/TCP connect|actively refused|Connection refused|RPC returned 401|No wallet file/i.test(raw)) {
    return new Error(
      `The Monero wallet is not running or has no wallet open yet. Nothing was sent. (${raw})`
    );
  }
  if (/timed out/i.test(raw)) {
    return new Error(
      `The Monero wallet took too long to build the transaction. Nothing was sent; try again in a moment. (${raw})`
    );
  }
  return new Error(`${raw} (Nothing was sent.)`);
}

/** A built, signed, unrelayed Monero transaction. */
interface XmrBuiltSend {
  txMetadata: string;
  txHash: string;
  /** The session that built it. */
  epoch: number;
}

/** Build `amount` to `recipient` without broadcasting it. Throws readable errors. */
async function buildXmrSend(recipient: string, amount: string, epoch: number): Promise<XmrBuiltSend> {
  let r;
  try {
    r = await buildTransfer(recipient, amount);
  } catch (e) {
    throw classifyXmrBuildError(e);
  }
  if (!r || typeof r.tx_metadata !== "string" || r.tx_metadata.length === 0 || !r.tx_hash) {
    throw new Error(
      "The Monero wallet built this send but returned no transaction to broadcast (no tx_metadata). " +
        "Nothing was sent."
    );
  }
  return { txMetadata: r.tx_metadata, txHash: r.tx_hash, epoch };
}

/**
 * Broadcast a built send (`relay_tx`). Once this starts the transaction may be
 * on the network, so a failure is settled by txid (`settleRelayFailure`):
 * found → the result; provably not relayed → a plain Error; anything else →
 * `SendOutcomeUnknownError(txid)`. Never "try again".
 */
async function relayXmrSend(built: XmrBuiltSend): Promise<TxResult> {
  if (!session || session.epoch !== built.epoch) {
    throw new Error(
      "The Monero wallet changed before this transaction was broadcast. Nothing was sent."
    );
  }
  let r: { tx_hash?: string } | null;
  try {
    r = await relayTransfer(built.txMetadata);
  } catch (e) {
    return settleRelayFailure({
      chain: "Monero",
      txHash: built.txHash,
      error: e,
      lookup: lookupOwnTransfer,
    });
  }
  return { hash: r?.tx_hash || built.txHash };
}

// =========================================================================
// ChainAdapter implementation
// =========================================================================

export const xmrAdapter: ChainAdapter = {
  chain: "monero",
  displayName: "Monero",
  ticker: "XMR",
  color: "#ff6600",
  addressPlaceholder: "4... or 8...",
  derivation: {
    kind: "independent-seed",
    note:
      "Monero uses its own 25-word or polyseed mnemonic, not the wallet's BIP-39 phrase. Import or generate an XMR seed to set this chain up.",
  },

  usesIndependentSeed: true,

  /**
   * Fresh wallets use polyseed by default — it encodes the creation date
   * so future re-imports skip the genesis-to-today scan. Callers that
   * specifically want a 25-word legacy seed (e.g. for compatibility with
   * older Monero wallets that don't speak polyseed) should call
   * `generateXmrSeed()` from `xmr-keys.ts` directly.
   */
  async generateOwnSeed(): Promise<string> {
    return (await generatePolyseed()).phrase;
  },

  async deriveFromOwnSeed(seed: string): Promise<WalletInfo> {
    const format = detectXmrSeedFormat(seed);
    if (!format) {
      throw new Error(
        "Monero seed must be 16 words (polyseed) or 25 words (legacy)."
      );
    }
    const normalized =
      format === "polyseed" ? normalizePolyseed(seed) : normalizeXmrSeed(seed);
    const address = await xmrAddressFromAnySeed(normalized);
    return {
      chain: "monero",
      address,
      mnemonic: normalized,
      privateKey: "",
    };
  },

  importFromMnemonic(_mnemonic: string): WalletInfo {
    throw new Error("Monero uses an independent 25-word seed, not a BIP39 phrase.");
  },
  deriveFromMnemonic(_mnemonic: string): WalletInfo {
    throw new Error("Monero uses an independent 25-word seed. Use deriveFromOwnSeed().");
  },
  importFromPrivateKey(_seed: string): WalletInfo {
    throw new Error("Monero import requires the 25-word seed — use deriveFromOwnSeed().");
  },

  async getBalance(_address: string): Promise<string> {
    if (!session) return "Syncing…";
    try {
      const bal = await getBalance();
      return piconeroToXmr(bal.balance);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (
        msg.includes("Connection refused") ||
        msg.includes("actively refused") || // Windows: os error 10061
        msg.includes("TCP connect failed") ||
        msg.includes("TCP connect timed out") ||
        msg.includes("RPC request failed") ||
        msg.includes("RPC returned 401")
      ) {
        return "Syncing…";
      }
      throw e;
    }
  },

  /**
   * Build, then relay (2026-09-29 send-safety audit, finding 1).
   *
   * Until then this was ONE `transfer` that built and broadcast together; a
   * timeout could leave it broadcast while the UI said "failed", and the retry
   * paid again. Now the build (`do_not_relay`) sends nothing whatever happens
   * to it, the txid is known before `relay_tx`, and a relay that does not
   * report success is settled by that txid (`relayXmrSend`).
   *
   * Everything refused here — sync, recipient, a failed build — is decided
   * before anything could reach the network, so it throws a plain Error.
   */
  async sendTransaction(_seed: string, to: string, amount: string): Promise<TxResult> {
    if (!session) {
      throw new Error("Monero session not initialized. Please wait for sync.");
    }
    const epoch = session.epoch;
    // Require sync to be within 2 blocks of the tip before sending.
    const refusal = xmrSyncRefusal(await getXmrSyncProgress());
    if (refusal) throw new Error(refusal);
    const recipient = to.trim();
    const badRecipient = await checkXmrRecipient(recipient);
    if (badRecipient) throw badRecipient;
    const built = await buildXmrSend(recipient, amount.trim(), epoch);
    return relayXmrSend(built);
  },

  /**
   * Unlocked and total XMR (finding 8), so the Send modal shows what can be
   * sent now: the displayed balance includes change that stays locked for 10
   * blocks, and sending it failed after the press with a raw wallet error.
   */
  async getSendableBalance(): Promise<SendableBalance> {
    if (!session) {
      throw new Error("Monero session not initialized");
    }
    const bal = await getBalance();
    return {
      unlocked: piconeroToXmr(bal.unlocked_balance),
      total: piconeroToXmr(bal.balance),
    };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    if (!session) return { label: "Network", value: "Mainnet", unit: "" };
    try {
      const status = await getXmrSyncProgress();
      if (status) {
        if (status.synced) {
          return { label: "Height", value: status.walletHeight.toLocaleString(), unit: "" };
        }
        return {
          label: "Syncing",
          value: `${status.percent.toFixed(1)}% (${status.walletHeight.toLocaleString()} / ${status.daemonHeight.toLocaleString()})`,
          unit: "",
        };
      }
      const h = await getHeight();
      return { label: "Height", value: h.toLocaleString(), unit: "" };
    } catch {
      return { label: "Network", value: "Mainnet", unit: "" };
    }
  },

  async getTransactionHistory(
    _address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    if (!session) return { items: [] };
    const limit = opts?.limit ?? 50;
    // `failed: true` since 2026-09-29 (finding 10). With `false`, a send the
    // pool later dropped vanished from Activity: no row, no hint, only a
    // balance that came back.
    const transfers = await getTransfers({
      in: true,
      out: true,
      pending: true,
      pool: true,
      failed: true,
    });
    transfers.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const items: ChainTx[] = transfers.slice(0, limit).map((t) => xmrTransferToChainTx(t));
    return { items };
  },

  /**
   * Monero fees are set by the NETWORK, not by this wallet: `transfer` takes
   * a `priority` and monero-wallet-rpc derives the fee. See the flag's doc on
   * `WalletAdapter` for the send-blocking bug this exists to prevent.
   */
  networkComputesFee: true,

  /**
   * No estimate exists without building the transaction.
   *
   * This called `get_fee_estimate`, a DAEMON method monero-wallet-rpc does not
   * have: `-32601 Method not found` on every call, on a healthy wallet, for
   * every Send modal open and every 30 s refresh — each one a request queued on
   * the single-threaded wallet-rpc. Since 2026-09-29 it throws a readable reason
   * without calling anything; `networkComputesFee` keeps the missing value from
   * blocking Send, as before.
   *
   * Not replaced by a `quoteSend` dry run the way Zephyr's is (finding 8): each
   * dry-run `transfer` asks the node for the real output alongside a fresh set
   * of decoys (`wallet2::get_outs`: "start with real one", then the request is
   * sorted "to ensure the daemon doesn't know which output is ours"), and a
   * quote is rebuilt on every edit and every 60 s. A remote node that sees two
   * such requests for the same spend can intersect them and find the real
   * input (inference from the source; the ring database that would reuse a
   * ring is filled only in `process_outgoing`, after a send). The fee is set
   * by the wallet at build time either way.
   */
  async getFeeEstimate(): Promise<FeeEstimate> {
    if (!session) {
      throw new Error("Monero session not initialized");
    }
    throw new Error("Not estimated in advance for Monero.");
  },
};

/**
 * One wallet-rpc transfer as a unified history row. Exported for tests.
 *
 * `pool` is INCOMING money seen in the mempool; `pending` is the OUTGOING
 * unconfirmed one (wallet-rpc `get_transfers` categories). Until 2026-09-29
 * `pool` mapped to "pending", which every renderer and the Sent filter treat
 * as outgoing, so an unconfirmed receipt read "▲ sent" (send-safety audit,
 * finding 12). It is now "in" with 0 confirmations, the way Zephyr's rows have
 * been since 2026-09-15. A `failed` row is an outgoing send the pool dropped,
 * so it names its recipient like any other send.
 */
export function xmrTransferToChainTx(t: XmrTransfer): ChainTx {
  let direction: ChainTx["direction"];
  switch (t.type) {
    case "in":
    case "pool":
      direction = "in";
      break;
    case "out":
      direction = "out";
      break;
    case "pending":
      direction = "pending";
      break;
    case "failed":
      direction = "failed";
      break;
  }
  // For incoming, the receiving address is ours; for outgoing, the first
  // destination is the counterparty (multi-out splits aren't surfaced in
  // the table — they live in `meta.destinations` for the detail drawer).
  const counterparty =
    direction === "out" || direction === "pending" || direction === "failed"
      ? t.destinations?.[0]?.address
      : undefined;
  return {
    chain: "monero",
    hash: t.txid,
    direction,
    amount: piconeroToXmr(t.amount),
    fee: t.fee ? piconeroToXmr(t.fee) : undefined,
    timestamp: t.timestamp || undefined,
    // A mempool receipt has no confirmations by definition; "0" is what marks
    // the row pending in the renderers.
    confirmations: t.type === "pool" ? 0 : t.confirmations,
    height: t.height || undefined,
    counterparty,
    meta: {
      payment_id: t.payment_id,
      subaddr_index: t.subaddr_index,
      destinations: t.destinations,
      locked: t.locked,
      raw_type: t.type,
    },
  };
}

// =========================================================================
// Re-exports for App.tsx convenience
// =========================================================================
export {
  validateXmrSeed,
  checkWalletRpcExists,
  downloadWalletRpc,
  checkXmrDefenderExclusion,
  addXmrDefenderExclusion,
  generateXmrSeed,
};
export type { XmrTransfer };

/**
 * Re-scan the chain from a different starting height.
 *
 * The restore height is the block the wallet begins scanning from. Anything
 * that arrived BEFORE it is never seen — the wallet reports a zero balance,
 * fully synced, with no error, because from its point of view there is
 * genuinely nothing there. Picking a date later than the first incoming
 * transaction is an easy mistake at import time and, until this existed,
 * an unrecoverable one short of removing and re-importing the wallet.
 *
 * Implemented as close → delete the local cache → restore at `newHeight`,
 * which is the same sequence the open-failure self-heal already uses. The
 * wallet FILE is disposable: it's a scan cache, and every key in it is
 * re-derived from the seed. The seed is untouched.
 *
 * Lower heights cost time, not safety — scanning from 0 is always correct,
 * just slower.
 */
export async function rescanXmrFromHeight(
  seed: string,
  masterPassword: string,
  newHeight: number,
  // REQUIRED, deliberately without the legacy default `initXmrSession` has:
  // this deletes the file before rebuilding it, and a caller that left the
  // name out deleted the PRIMARY wallet's file (`ScanDateCard`, until
  // 2026-09-16). Making it required lets the compiler catch the next one.
  walletFilename: string
): Promise<void> {
  try {
    await closeXmrWallet();
  } catch {
    /* not open — nothing to close */
  }
  // Retry: on Windows the just-closed wallet-rpc can still hold the handle.
  let deleted = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await deleteXmrWalletFiles(walletFilename);
      deleted = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!deleted) {
    throw new Error(
      "Could not clear the Monero scan cache — the wallet file is still in " +
        "use. Close any other Monero app and try again."
    );
  }
  await initXmrSession(seed, masterPassword, Math.max(0, Math.floor(newHeight)), walletFilename);
}
