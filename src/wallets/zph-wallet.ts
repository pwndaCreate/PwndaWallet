/**
 * Zephyr Protocol (ZEPH) ChainAdapter — sidecar-backed implementation.
 *
 * Structural parallel to `xmr-wallet.ts`. Differences for the
 * functional-minimum v1:
 *   - 25-word seeds only (Zephyr doesn't support polyseed).
 *   - Single-asset UI surface: `getBalance` returns the ZPH balance only.
 *     The other three assets (ZSD/ZRS/ZYS) are readable through
 *     `zph-rpc.ts::getAllBalances` but not shown in v1 — add Exchange panel
 *     later.
 *   - Separate sidecar on loopback port 18083, separate wallet-dir,
 *     separate node pool (`zph-nodes.ts`).
 *
 * The open/restore/self-heal machinery mirrors Monero's — both of the
 * self-heal paths (open-failure auto-delete+restore, address-mismatch
 * auto-delete+restore) carry over directly.
 */

import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
} from "./types";
import {
  generateZephyrSeed,
  validateZephyrSeed,
  normalizeZephyrSeed,
  zephyrAddressFromSeed,
} from "./zph-keys";
import {
  getSelectedNode,
  raceBestNode,
  getHealthSnapshot,
  startHealthLoop,
  stopHealthLoop,
  onHealthUpdate,
  HOT_SWAP_SPEEDUP_THRESHOLD,
} from "./zph-nodes";
import {
  startZphRpc,
  stopZphRpc,
  openWallet,
  restoreDeterministicWallet,
  closeWallet,
  autoRefresh,
  getBalanceForAsset,
  atomicToZph,
  zphToAtomic,
  getHeight,
  getSyncStatus,
  setDaemon,
  transferAsset,
  validateAddress,
  createAddress,
  getTransfers,
  changeWalletPassword,
  fetchCurrentDaemonHeight,
  getAddress,
  deleteZphWalletFiles,
  ZPH_WALLET_FILENAME,
  checkZphWalletRpcExists,
  downloadZphWalletRpc,
  checkZphDefenderExclusion,
  addZphDefenderExclusion,
  getZphFeeEstimate,
  type ZphTransfer,
  type ZphAssetType,
} from "./zph-rpc";

// =========================================================================
// Per-session state
// =========================================================================

interface ZphSession {
  seed: string;
  daemonUrl: string;
  walletOpen: boolean;
  walletPassword: string;
  currentReceiveAddress: string | null;
  restoreHeight: number;
  /** On-disk wallet filename this session opened (per-wallet, multi-wallet). */
  walletFilename: string;
}

let session: ZphSession | null = null;
let healthUnsubscribe: (() => void) | null = null;

// =========================================================================
// Helpers
// =========================================================================

/**
 * Derive the wallet-file encryption password from the vault master
 * password. Same PBKDF2 parameters as Monero's
 * `deriveWalletPassword` but with a Zephyr-specific salt so the two
 * wallet files never share a derived key.
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
      salt: enc.encode("pwnda-zph-wallet-file"),
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

async function pickDaemon(): Promise<string> {
  return raceBestNode();
}

async function maybeHotSwap(): Promise<void> {
  if (!session) return;
  if (await getSelectedNode()) return; // user pin

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
      `[zph-wallet] hot-swap ${current} (${currentLatency}ms) → ${best.url} (${best.latencyMs}ms)`
    );
    await setDaemon(best.url);
    session.daemonUrl = best.url;
  } catch (e) {
    console.warn("[zph-wallet] hot-swap failed:", e);
  }
}

// =========================================================================
// Public session management
// =========================================================================

export async function switchZphDaemon(daemonUrl: string): Promise<void> {
  if (!session) return;
  await setDaemon(daemonUrl);
  session.daemonUrl = daemonUrl;
}

export function getActiveZphDaemon(): string | null {
  return session?.daemonUrl ?? null;
}

/**
 * Initialize the Zephyr session: pick a daemon, start the sidecar with
 * per-session authentication, open (or restore) the wallet file encrypted
 * with a key derived from `masterPassword`, and enable auto-refresh.
 *
 * Idempotent-by-seed: subsequent calls with the same seed are a no-op
 * once the session is open. A different seed tears down the existing
 * session first.
 *
 * @param rawSeed        25-word Zephyr seed.
 * @param masterPassword Vault master password for wallet-file encryption.
 * @param restoreHeight  Block height to start scanning from. 0 = genesis.
 */
export async function initZphSession(
  rawSeed: string,
  masterPassword: string,
  restoreHeight: number = 0,
  // On-disk wallet filename. Defaults to the single legacy name so existing
  // (single-wallet) callers are byte-identical; multi-wallet callers pass the
  // entry's per-wallet `sidecarFile` (e.g. "pwnda-zph-<id>"). The Rust sidecar
  // launches with --wallet-dir, so one process serves any filename in the dir.
  walletFilename: string = ZPH_WALLET_FILENAME
): Promise<void> {
  const seed = normalizeZephyrSeed(rawSeed);
  if (seed.split(/\s+/).filter(Boolean).length !== 25) {
    throw new Error("Zephyr seed must be exactly 25 words.");
  }
  const walletPassword = await deriveWalletPassword(masterPassword);

  // Fast path: same seed, already initialized.
  if (session && session.seed === seed && session.walletOpen) {
    return;
  }

  // Different seed — tear down the old session first.
  if (session) {
    try {
      await closeZphWallet();
    } catch {
      /* ignore */
    }
  }

  // 0. Binary presence check.
  //
  // Until 2026-08-12 the failure here was a hardcoded Windows string: it named
  // `zephyr-wallet-rpc.exe`, pointed at `%APPDATA%\...`, and told the user to
  // go download and place the file by hand. Two things wrong with that on
  // Linux/macOS — neither the filename nor the path exists there, AND the
  // manual instructions were unnecessary on every platform, because
  // `zph_download_wallet_rpc` fetches the right per-OS bundle in-app (Zephyr
  // publishes both `zephyr-cli-windows-*.zip` and `zephyr-cli-linux-*.zip`;
  // see ZPH_WIN_URL / ZPH_LINUX_URL in zph_rpc.rs).
  //
  // Keep the literal "wasn't found" — `ZphSyncCard` keys its Download button
  // off that substring (errorIsMissingBinary), so changing it silently removes
  // the user's one-click way out.
  const rpcExists = await checkZphWalletRpcExists();
  if (!rpcExists) {
    // Fetch it, exactly as `xmr-wallet.ts::initXmrSession` does. Zephyr used to
    // throw here instead — with a hardcoded Windows string naming
    // `zephyr-wallet-rpc.exe` and `%APPDATA%\...`, telling the user to download
    // and place the file by hand. That was wrong twice over: neither the
    // filename nor the path exists off Windows, and the manual step was never
    // needed on ANY platform, because `zph_download_wallet_rpc` already fetches
    // the right per-OS bundle (Zephyr ships zephyr-cli-windows-*.zip and
    // zephyr-cli-linux-*.zip; see ZPH_WIN_URL / ZPH_LINUX_URL in zph_rpc.rs).
    //
    // Only Monero had this auto-fetch, which is why Monero came up on a fresh
    // Linux box and Zephyr dead-ended.
    await downloadZphWalletRpc();
    const existsAfter = await checkZphWalletRpcExists();
    if (!existsAfter) {
      // Keep the literal "wasn't found" — `ZphSyncCard` keys its Download
      // button off that substring (errorIsMissingBinary).
      throw new Error(
        "The Zephyr wallet-rpc sidecar wasn't found after downloading it. " +
          "On Windows, Defender may have quarantined it — add an exclusion " +
          "via Settings → Zephyr and retry."
      );
    }
  }

  // 1. Pick a daemon (parallel probe).
  const daemonUrl = await pickDaemon();

  // 2. Start the sidecar. If the daemon URL changed, stop first so the new
  //    instance picks up the correct --daemon-address.
  if (session && (session as ZphSession).daemonUrl !== daemonUrl) {
    await stopZphRpc();
  }

  try {
    await startZphRpc(daemonUrl);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("os error 225") || msg.includes("virus")) {
      throw new Error(
        "Windows Defender blocked zephyr-wallet-rpc.exe (known false positive — " +
          "same heuristic that trips on every Monero binary). Add the zephyr folder " +
          "to Defender exclusions and retry."
      );
    }
    throw e;
  }

  // 3. Derive the expected primary address offline so we can cross-check
  //    any opened file. Mismatch triggers the address self-heal below.
  const expectedAddress = await zephyrAddressFromSeed(seed);

  /** Restore wallet file from the 25-word seed. */
  const restoreFromSeed = async (): Promise<void> => {
    await restoreDeterministicWallet(
      seed,
      walletFilename,
      restoreHeight,
      walletPassword
    );
  };

  // 4. Open or restore. Cases:
  //   a) File exists, our password works → open.
  //   b) File exists, opens with "" → open, rotate password.
  //   c) Both open attempts fail → delete + restore (open-failure self-heal,
  //      safe because seed is authoritative).
  //   d) File opens but address doesn't match seed → delete + restore
  //      (address-mismatch self-heal).
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
        /* non-fatal */
      }
      walletOpen = true;
    } catch (openErr: any) {
      // 2026-06-14 — BEFORE the destructive delete+restore, try a
      // NON-destructive recovery. After a mem_guard WebView2 reload the JS
      // session cache is wiped but the Rust wallet-rpc sidecar still has the
      // wallet OPEN, holding an OS lock on the .keys file. open_wallet then
      // fails with a sharing violation (Windows system:32 /
      // is_keys_file_locked), and the old code went straight to
      // delete+restore — which ALSO failed (file locked → delete no-op →
      // restore throws file_exists) and latched the titlebar red "error"
      // PERMANENTLY (the auto-retry just re-hit the same lock). Closing the
      // wallet via RPC releases the sidecar's own lock; re-opening then
      // succeeds, with zero data loss / no re-scan. Only if that also fails
      // do we fall through to the self-heal.
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
        // Open-failure self-heal: delete + restore. Seed is authoritative;
        // worst case is losing scan progress past restoreHeight (still
        // recoverable, no fund loss).
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            await deleteZphWalletFiles(walletFilename);
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        try {
          await restoreFromSeed();
          walletOpen = true;
        } catch (restoreErr: any) {
          const openMsg = String(openErr?.message ?? openErr);
          const restoreMsg = String(restoreErr?.message ?? restoreErr);
          throw new Error(
            `Failed to restore Zephyr wallet: ${restoreMsg} [open error: ${openMsg}]`
          );
        }
      }
    }
  }

  // Address-mismatch self-heal.
  if (walletOpen) {
    let openedAddress = "";
    try {
      openedAddress = await getAddress();
    } catch {
      /* non-fatal */
    }
    if (openedAddress && openedAddress !== expectedAddress) {
      console.warn(
        "[zph-wallet] opened wallet address doesn't match the seed; " +
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
      let deleted = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          await deleteZphWalletFiles(walletFilename);
          deleted = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      if (!deleted) {
        console.warn(
          "[zph-wallet] self-heal: delete kept failing; restoreFromSeed will likely error. " +
            "User should click 'Forget Zephyr Wallet' in Settings."
        );
      }
      await restoreFromSeed();
    }
  }

  void walletOpen;

  // 5. Enable background auto-refresh — the sole sync driver.
  try {
    await autoRefresh(true, 10);
  } catch {
    /* non-fatal */
  }

  // 6. Generate a receive subaddress (begins with "ZEPHi", Zephyr's
  //    subaddress prefix). Fallback to primary address if this fails.
  let currentReceiveAddress: string | null = null;
  try {
    const result = await createAddress(0, "receive");
    currentReceiveAddress = result.address;
  } catch {
    /* fallback = primary */
  }

  session = {
    seed,
    daemonUrl,
    walletOpen: true,
    walletPassword,
    currentReceiveAddress,
    restoreHeight,
    walletFilename,
  };

  // 7. Kick off the health loop for hot-swap + settings UI freshness.
  startHealthLoop(60_000);
  if (healthUnsubscribe) healthUnsubscribe();
  healthUnsubscribe = onHealthUpdate(() => {
    void maybeHotSwap();
  });
}

export async function closeZphWallet(): Promise<void> {
  if (!session) return;
  session = null;
  if (healthUnsubscribe) {
    healthUnsubscribe();
    healthUnsubscribe = null;
  }
  stopHealthLoop();
  try {
    await closeWallet();
  } catch {
    /* ignore */
  }
  try {
    await stopZphRpc();
  } catch {
    /* ignore */
  }
}

/** Current Zephyr receive subaddress if a session is active. */
export function getZphReceiveAddress(): string | null {
  return session?.currentReceiveAddress ?? null;
}

/** Fetch the seed from the vault-persisted state via the session. */
export function getZphActiveSeed(): string | null {
  return session?.seed ?? null;
}

/** Is there a live Zephyr session? */
export function isZphSessionActive(): boolean {
  return session != null && session.walletOpen;
}

/** Total + unlocked ZPH balance, formatted as decimal strings. */
export async function getZphBalanceDetailed(): Promise<{
  total: string;
  unlocked: string;
  hasLocked: boolean;
}> {
  const bal = await getBalanceForAsset("ZPH");
  if (!bal) {
    return { total: "0", unlocked: "0", hasLocked: false };
  }
  const total = atomicToZph(bal.balance);
  const unlocked = atomicToZph(bal.unlocked_balance);
  return {
    total,
    unlocked,
    hasLocked: bal.balance !== bal.unlocked_balance,
  };
}

/** Current sync progress, or null if no session. */
export async function getZphSyncProgress(): Promise<{
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

/** Fetch the current daemon tip height from the active node. */
export async function getZphDaemonTipHeight(): Promise<number> {
  if (!session) return 0;
  return fetchCurrentDaemonHeight(session.daemonUrl);
}

/**
 * Transaction history — sorted newest-first, first N entries typically
 * enough for the UI's history card.
 */
export async function getZphTransactionHistory(): Promise<ZphTransfer[]> {
  try {
    const transfers = await getTransfers({ in: true, out: true, pending: true, pool: true });
    return transfers.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

// =========================================================================
// ChainAdapter implementation
// =========================================================================

export const zphAdapter: ChainAdapter = {
  chain: "zephyr",
  displayName: "Zephyr",
  ticker: "ZEPH",
  color: "#3ab0ff",
  addressPlaceholder: "ZEPHYR... or ZEPHi...",
  derivation: {
    kind: "independent-seed",
    note:
      "Zephyr is Monero-lineage and uses its own 25-word seed, not the wallet's BIP-39 phrase.",
  },

  usesIndependentSeed: true,

  /**
   * Generate a fresh 25-word Zephyr seed. Zephyr doesn't support
   * polyseed — always 25-word.
   */
  async generateOwnSeed(): Promise<string> {
    return generateZephyrSeed();
  },

  async deriveFromOwnSeed(seed: string): Promise<WalletInfo> {
    const v = await validateZephyrSeed(seed);
    if (!v.ok) throw new Error(v.error);
    const normalized = normalizeZephyrSeed(seed);
    const address = await zephyrAddressFromSeed(normalized);
    return {
      chain: "zephyr",
      address,
      mnemonic: normalized,
      privateKey: "",
    };
  },

  importFromMnemonic(_mnemonic: string): WalletInfo {
    throw new Error("Zephyr uses an independent 25-word seed, not a BIP39 phrase.");
  },
  deriveFromMnemonic(_mnemonic: string): WalletInfo {
    throw new Error("Zephyr uses an independent 25-word seed. Use deriveFromOwnSeed().");
  },
  importFromPrivateKey(_seed: string): WalletInfo {
    throw new Error("Zephyr import requires the 25-word seed — use deriveFromOwnSeed().");
  },

  async getBalance(_address: string): Promise<string> {
    // Gate on the session being established so we don't fire RPC against
    // a sidecar that may not be up yet (or against a wallet that isn't
    // open). Returning a friendly "Syncing…" instead of "Not initialized"
    // matches what the error handler below would say once the sidecar
    // becomes reachable but the wallet isn't open. The follow-up
    // `refreshAllBalances` triggered by `useEffect([zphSyncState ===
    // "synced"])` in `App.tsx` replaces this cached value once sync
    // actually completes.
    if (!session) return "Syncing…";
    try {
      const detail = await getZphBalanceDetailed();
      return detail.total;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (
        msg.includes("Connection refused") ||
        msg.includes("actively refused") || // Windows: os error 10061
        msg.includes("TCP connect failed") ||
        msg.includes("TCP connect timed out") ||
        msg.includes("RPC request failed") ||
        msg.includes("RPC returned 401") ||
        msg.includes("No wallet file")
      ) {
        return "Syncing…";
      }
      throw e;
    }
  },

  async sendTransaction(
    _seed: string,
    to: string,
    amount: string,
    assetType?: string
  ): Promise<TxResult> {
    if (!session) {
      throw new Error("Zephyr session not initialized. Please wait for sync.");
    }
    // Require sync to be within 2 blocks of tip before sending.
    const status = await getZphSyncProgress();
    if (!status || !status.synced) {
      const pct = status?.percent.toFixed(1) ?? "?";
      throw new Error(
        `Zephyr wallet not fully synced (${pct}% — ${status?.walletHeight ?? 0} / ${
          status?.daemonHeight ?? 0
        }). Please wait for sync to complete before sending.`
      );
    }
    // Validate address via sidecar before attempting the transfer.
    try {
      const validation = await validateAddress(to);
      if (!validation.valid) {
        throw new Error("Invalid Zephyr address.");
      }
      if (validation.nettype !== "mainnet") {
        throw new Error(`Address is for ${validation.nettype}, not mainnet.`);
      }
    } catch (e: any) {
      if (e.message.startsWith("Invalid") || e.message.startsWith("Address is"))
        throw e;
      // If validate_address itself fails (RPC error), proceed without
      // client-side validation — don't block sends on a transient RPC issue.
    }
    // Plain send of a single asset: source === destination so wallet-rpc does a
    // normal transfer, NOT a protocol mint/redeem (those go through the Zephyr
    // swap modal). `assetType` selects which held asset to send — ZPH for the
    // focal ZEPH panel, or ZSD/ZRS/ZYS when sending one of the ecosystem assets
    // surfaced as their own rows. `amount` is in the SOURCE asset's units
    // (12 decimals, same for every Zephyr asset).
    const asset: ZphAssetType =
      assetType === "ZSD" || assetType === "ZRS" || assetType === "ZYS"
        ? assetType
        : "ZPH";
    const result = await transferAsset({
      destination: to,
      amountZph: amount,
      sourceAsset: asset,
      destinationAsset: asset,
    });
    return { hash: result.tx_hash };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    if (!session) return { label: "Network", value: "Mainnet", unit: "" };
    try {
      const status = await getZphSyncProgress();
      if (status) {
        if (status.synced) {
          return {
            label: "Height",
            value: status.walletHeight.toLocaleString(),
            unit: "",
          };
        }
        return {
          label: "Syncing",
          value: `${status.percent.toFixed(1)}% (${status.walletHeight.toLocaleString()} / ${status.daemonHeight.toLocaleString()})`,
          unit: "",
        };
      }
    } catch {
      /* fallthrough */
    }
    return { label: "Network", value: "Mainnet", unit: "" };
  },

  async getTransactionHistory(
    _address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    if (!session) return { items: [] };
    const limit = opts?.limit ?? 50;
    const transfers = await getTransfers({
      in: true,
      out: true,
      pending: true,
      pool: true,
      failed: false,
    });
    transfers.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const items: ChainTx[] = transfers.slice(0, limit).map(zphTransferToChainTx);
    return { items };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    if (!session) {
      throw new Error("Zephyr session not initialized");
    }
    const r = await getZphFeeEstimate(10);
    const fees = r.fees && r.fees.length > 0 ? r.fees : [r.fee];
    const tier = (i: number) =>
      fees[i] !== undefined ? { value: atomicToZph(fees[i] * 1024) } : undefined;
    const slow = tier(0);
    const normal = tier(1) ?? tier(0)!;
    const fast = tier(2) ?? tier(1) ?? normal;
    return {
      slow,
      normal,
      fast,
      unit: "ZEPH/kB",
      fetchedAt: Date.now(),
      raw: r,
    };
  },
};

function zphTransferToChainTx(t: ZphTransfer): ChainTx {
  let direction: ChainTx["direction"];
  switch (t.type) {
    case "in":
      direction = "in";
      break;
    case "pool":
      direction = "pending";
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
  const counterparty =
    direction === "out" || direction === "pending"
      ? t.destinations?.[0]?.address
      : undefined;
  return {
    chain: "zephyr",
    hash: t.txid,
    direction,
    amount: atomicToZph(t.amount),
    fee: t.fee ? atomicToZph(t.fee) : undefined,
    timestamp: t.timestamp || undefined,
    confirmations: t.confirmations,
    height: t.height || undefined,
    counterparty,
    meta: {
      payment_id: t.payment_id,
      subaddr_index: t.subaddr_index,
      destinations: t.destinations,
      locked: t.locked,
      asset_type: t.asset_type,
      raw_type: t.type,
    },
  };
}

// Re-exports convenient for App.tsx
export {
  getBalanceForAsset,
  atomicToZph,
  zphToAtomic,
  getHeight as getZphLocalHeight,
  checkZphWalletRpcExists,
  downloadZphWalletRpc,
  checkZphDefenderExclusion,
  addZphDefenderExclusion,
  type ZphTransfer,
};

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
export async function rescanZphFromHeight(
  seed: string,
  masterPassword: string,
  newHeight: number,
  walletFilename: string = ZPH_WALLET_FILENAME
): Promise<void> {
  try {
    await closeZphWallet();
  } catch {
    /* not open — nothing to close */
  }
  // Retry: on Windows the just-closed wallet-rpc can still hold the handle.
  let deleted = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await deleteZphWalletFiles(walletFilename);
      deleted = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!deleted) {
    throw new Error(
      "Could not clear the Zephyr scan cache — the wallet file is still in " +
        "use. Close any other Zephyr app and try again."
    );
  }
  await initZphSession(seed, masterPassword, Math.max(0, Math.floor(newHeight)), walletFilename);
}
