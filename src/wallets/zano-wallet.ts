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
} from "./types";
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
    throw new Error(
      "The Zano wallet binary is missing. Download it from Settings first."
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

export async function getZanoTransactionHistory(): Promise<ZanoTransferEntry[]> {
  try {
    return await getRecentTransfers(0, 50);
  } catch {
    return [];
  }
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
    const atomic = zanoToAtomic(amount, ZANO_NATIVE_DECIMALS);
    const result = await transfer({
      destinations: [{ address: to, amount: atomic }],
    });
    return { hash: result.txHash };
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
    const items: ChainTx[] = entries.slice(0, limit).map((e) => ({
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
    return { items };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // No dedicated fee-estimate RPC was exercised against the live binary
    // (see zano-rpc.ts's transfer() note on `mixin`/`fee` — the daemon
    // applies network-ruled minimums). Report unknown rather than a
    // fabricated number; the send flow lets the daemon set the fee.
    return {
      normal: { value: "network-determined", label: "Normal" } as any,
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
