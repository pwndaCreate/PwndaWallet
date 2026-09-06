/**
 * Typed client for the monero-wallet-rpc sidecar managed by the Rust
 * backend (see `src-tauri/src/xmr_rpc.rs`).
 *
 * All calls go through the `xmr_rpc_call` Tauri command, which proxies to
 * 127.0.0.1:18082/json_rpc on the loopback interface. The Rust layer owns
 * process lifecycle (start/stop/ready check); this module just wraps the
 * individual wallet-rpc methods into TypeScript-friendly helpers.
 *
 * Reference for the underlying wallet-rpc API:
 *   https://www.getmonero.org/resources/developer-guides/wallet-rpc.html
 */

import { decimalToAtomic } from "./decimal-amount";
import { invoke } from "../lib/tauri";

/**
 * PWNDA-LEASE (C9): who wants the wallet-rpc process alive. Mirrors the Rust
 * `XmrLease` enum (`xmr_rpc.rs`) — the process starts on the first lease and
 * stops only once the last one releases, so the user's own Monero session
 * and the swap engine can each depend on it without one's stop killing the
 * other's dependency. Every call site before C9 passes `"session"`
 * (the default), so this is behaviour-preserving on its own.
 */
export type XmrLease = "session" | "swap_engine";

/**
 * Constant filename we use for the active Monero wallet file on disk.
 * PwndaWallet is a single-wallet app — there's only ever one active
 * Monero wallet at a time, so we don't need to juggle multiple names.
 * Stored under `<app_data>/xmr-wallets/` by the RPC.
 */
export const XMR_WALLET_FILENAME = "pwnda-active";

/** Generic RPC call — delegates to the Rust proxy. */
async function rpc<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
  return (await invoke<T>("xmr_rpc_call", { method, params })) as T;
}

/**
 * Launch the monero-wallet-rpc sidecar, wiring it to `daemonAddress`.
 * Returns when the RPC is responsive (ready to accept wallet commands).
 * No-op if the sidecar is already running.
 */
export async function startXmrRpc(
  daemonAddress: string,
  lease: XmrLease = "session"
): Promise<void> {
  await invoke("xmr_start_rpc", { daemonAddress, lease });
}

/** Release `lease`'s claim. Only actually stops the sidecar (and closes any
 *  open wallet) once no lease remains — see {@link XmrLease}. */
export async function stopXmrRpc(lease: XmrLease = "session"): Promise<void> {
  await invoke("xmr_stop_rpc", { lease });
}

/** Is the sidecar child process currently alive? */
export async function isXmrRpcRunning(): Promise<boolean> {
  return invoke<boolean>("xmr_rpc_is_running");
}

/** Delete the on-disk wallet files for a given name. Used by "Forget Monero". */
export async function deleteXmrWalletFiles(
  filename: string = XMR_WALLET_FILENAME
): Promise<void> {
  await invoke("xmr_delete_wallet_files", { filename });
}

// ---------- Wallet lifecycle ----------

/**
 * Open an existing wallet file from the wallet directory.
 * Fails with an RPC error if the file doesn't exist — the caller should
 * catch that and fall back to `restoreDeterministicWallet`.
 */
export async function openWallet(
  filename: string = XMR_WALLET_FILENAME,
  password: string = ""
): Promise<void> {
  await rpc("open_wallet", { filename, password });
}

/**
 * Create a wallet file from a 25-word Monero seed.
 * `restoreHeight: 0` means "scan from genesis" — the safe worst-case that
 * guarantees we find every incoming transaction ever made to this wallet,
 * at the cost of a long first sync.
 */
export async function restoreDeterministicWallet(
  seed: string,
  filename: string = XMR_WALLET_FILENAME,
  restoreHeight: number = 0,
  password: string = ""
): Promise<{ address: string; info: string }> {
  return rpc("restore_deterministic_wallet", {
    filename,
    password,
    seed,
    restore_height: restoreHeight,
    language: "English",
    autosave_current: true,
  });
}

/** Close the currently open wallet (does NOT stop the RPC). */
export async function closeWallet(): Promise<void> {
  await rpc("close_wallet", {});
}

/**
 * Create a wallet file from a primary address + viewkey + spendkey triple.
 *
 * Used by the polyseed flow: we derive the Monero spend/view keys in pure
 * JS from the polyseed, then hand them to wallet-rpc via this method.
 * Unlike `restore_deterministic_wallet`, this does not require the
 * sidecar to understand any particular seed format — it just takes the
 * raw keys directly.
 *
 * All three hex inputs are 64 chars (32 bytes each) except `address`
 * which is the base58-encoded primary address.
 */
export async function generateFromKeys(args: {
  filename: string;
  password: string;
  restoreHeight: number;
  address: string;
  viewkey: string;
  spendkey: string;
}): Promise<{ address: string; info: string }> {
  return rpc("generate_from_keys", {
    filename: args.filename,
    password: args.password,
    restore_height: args.restoreHeight,
    address: args.address,
    viewkey: args.viewkey,
    spendkey: args.spendkey,
    language: "English",
    autosave_current: true,
  });
}

// ---------- Status / sync ----------

export interface XmrHeight {
  /** Local block height this wallet has scanned up to. */
  height: number;
}

/** Block height the wallet has scanned up to locally. */
export async function getHeight(): Promise<number> {
  const result = await rpc<XmrHeight>("get_height", {});
  return result.height;
}

export interface XmrGetInfo {
  daemon_connected: boolean;
  daemon_height?: number;
  height: number;
  is_synchronized?: boolean;
  mainnet?: boolean;
  was_bootstrap_ever_used?: boolean;
  /** Some wallet-rpc versions return height_without_bootstrap here too. */
  target_height?: number;
}

/**
 * Higher-level status query combining local height, daemon height, and
 * sync state. Used for the sync progress bar in the UI.
 *
 * wallet-rpc doesn't have a single "tell me if I'm synced" RPC, so we
 * compose the answer from `get_height` + a raw daemon call to the node.
 */
export async function getSyncStatus(
  daemonAddress: string,
  /**
   * Floor for the reported wallet height. Pass the session's restore height
   * so the progress bar doesn't start at "block 1" just because wallet-rpc's
   * `get_height` hasn't completed its first refresh cycle yet.
   *
   * Rationale: when `generate_from_keys` runs with `restore_height: N`, the
   * wallet's *scanned* height stays at 1 until the first refresh cycle
   * completes. On a remote node scanning 500K+ blocks, that initial cycle
   * can take many minutes to hours. During that window the UI would
   * otherwise render "block 1 / 3,658,000" — indistinguishable from "not
   * syncing". Clamping to restore_height shows honest progress: we know
   * the wallet is working from block N upward.
   */
  minHeightFloor: number = 0
): Promise<{
  walletHeight: number;
  daemonHeight: number;
  synced: boolean;
  percent: number;
  daemonOk: boolean;
}> {
  const rawWalletHeight = await getHeight();
  let walletHeight = rawWalletHeight;
  // Wallet-rpc's get_height stays at 1 until the first refresh cycle lands.
  // Clamping to the restore floor gives the user real progress info.
  if (walletHeight <= 1 && minHeightFloor > 1) {
    walletHeight = minHeightFloor;
  }

  let daemonHeight = 0;
  let daemonOk = false;
  try {
    // Go through the Rust backend to sidestep the webview's CORS
    // enforcement — most public Monero nodes don't send the headers
    // the browser would need to allow a renderer `fetch()`, and
    // silently dropping here would make the progress bar freeze on
    // any non-CORS-friendly daemon.
    const r = await invoke<{
      url: string;
      ok: boolean;
      latency_ms: number | null;
      height: number | null;
      error: string | null;
    }>("xmr_probe_node", { url: daemonAddress, timeoutMs: 5000 });
    if (r.ok && r.height != null && r.height > 0) {
      daemonHeight = r.height;
      daemonOk = true;
    }
  } catch {
    // daemonOk stays false; caller can detect connection loss.
  }

  const synced = daemonOk && walletHeight >= daemonHeight - 2; // small slack
  const percent =
    daemonHeight > 0 ? Math.min(100, (walletHeight / daemonHeight) * 100) : 0;
  return { walletHeight, daemonHeight, synced, percent, daemonOk };
}

/**
 * Fetch the current chain tip height from any reachable node.
 * Used at wallet creation/import time to record `xmrRestoreHeight` so future
 * restores skip straight to the creation block instead of scanning from genesis.
 * Returns 0 if no node reachable — caller decides whether to proceed.
 */
export async function fetchCurrentDaemonHeight(daemonUrl: string): Promise<number> {
  try {
    // Rust-backed probe for the same CORS-bypass reasons as `getSyncStatus`.
    const r = await invoke<{
      url: string;
      ok: boolean;
      latency_ms: number | null;
      height: number | null;
      error: string | null;
    }>("xmr_probe_node", { url: daemonUrl, timeoutMs: 5000 });
    return r.ok && r.height != null ? r.height : 0;
  } catch {
    return 0;
  }
}

/**
 * Trigger a foreground refresh cycle. For a freshly restored wallet with
 * `restoreHeight: 0`, this starts scanning from genesis and can take many
 * hours. Returns when one refresh cycle completes.
 *
 * IMPORTANT: do NOT `await` this in UI code — fire it and let it run, and
 * poll `getSyncStatus` on a timer for progress updates instead.
 */
export async function refresh(startHeight: number = 0): Promise<{
  blocks_fetched: number;
  received_money: boolean;
}> {
  return rpc("refresh", { start_height: startHeight });
}

/**
 * Configure the RPC to auto-refresh every `period` seconds in the
 * background. This is the preferred way to keep sync state current after
 * the initial scan: fire it once at wallet open, then the sidecar keeps
 * itself in sync without further work from us.
 */
export async function autoRefresh(enable: boolean, period: number = 10): Promise<void> {
  await rpc("auto_refresh", { enable, period });
}

/**
 * Force the wallet-rpc to flush its in-memory scan state to the on-disk
 * wallet file. Defense-in-depth against hard-kill scenarios: wallet-rpc's
 * built-in autosave timer (default ~5 min) + `close_wallet` normally cover
 * this, but if the process is force-killed mid-scan (power loss, app
 * crash, taskkill) any unwritten progress reverts to the last autosave —
 * worst case all the way back to `restoreHeight`, forcing a fresh scan
 * from the creation block.
 *
 * Call from the UI polling loop every ~60s while syncing so a hard-kill
 * loses at most one minute of progress.
 */
export async function storeWallet(): Promise<void> {
  await rpc("store", {});
}

/**
 * Switch the running sidecar to a different daemon URL without
 * restarting the child process. Used by the manual node-selection UI.
 *
 * `address` is the full URL ("http://node.xmr.ru:18081"). The wallet
 * stays open across the swap; only the upstream daemon connection is
 * replaced.
 *
 * `trusted` defaults to false for remote nodes — only set true for
 * localhost/127.0.0.1 (prevents view key leakage to remote node operators).
 */
export async function setDaemon(address: string): Promise<void> {
  const isLocal = address.includes("127.0.0.1") || address.includes("localhost");
  await rpc("set_daemon", {
    address,
    trusted: isLocal,
    ssl_support: "autodetect",
  });
}

// ---------- Balance / address ----------

export interface XmrBalance {
  /** Total balance in piconero (1 XMR = 1e12 piconero). */
  balance: number;
  /** Unlocked (spendable) balance in piconero. */
  unlocked_balance: number;
  multisig_import_needed?: boolean;
  time_to_unlock?: number;
  blocks_to_unlock?: number;
}

/** Current balance of the open wallet, in piconero. */
export async function getBalance(): Promise<XmrBalance> {
  return rpc<XmrBalance>("get_balance", { account_index: 0 });
}

/** Convert piconero (BigInt/number) to a human XMR string. */
export function piconeroToXmr(piconero: number | bigint): string {
  const bn = typeof piconero === "bigint" ? piconero : BigInt(piconero);
  const whole = bn / 1000000000000n;
  const frac = bn % 1000000000000n;
  const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
}

/** Primary receive address of the open wallet. */
export async function getAddress(): Promise<string> {
  const result = await rpc<{ address: string }>("get_address", { account_index: 0 });
  return result.address;
}

// ---------- Send ----------

/**
 * Convert an XMR amount string to piconero (BigInt).
 * Parses the decimal string directly to avoid floating-point precision loss.
 * e.g. "0.1" → 100000000000n  (not the broken 100000000000.00002 from parseFloat)
 */
export function xmrToPiconero(amount: string): bigint {
  // Was: split(".") + slice(0,12) with NO validation — "1.2.3" silently became
  // 1.2 XMR, and a 13th decimal place was truncated away. See decimal-amount.ts.
  return decimalToAtomic(amount, 12, "XMR amount");
}

/**
 * Send `amountXmr` XMR to `destination`.
 *
 * If `doNotRelay` is true the transaction is constructed and signed but NOT
 * broadcast — use this to preview the fee before confirming. Call `transfer`
 * again with `doNotRelay: false` (or omit it) to actually broadcast.
 *
 * Returns the transaction hash, key, amount, and fee.
 */
export async function transfer(
  destination: string,
  amountXmr: string,
  doNotRelay = false
): Promise<{ tx_hash: string; tx_key: string; amount: number; fee: number }> {
  const piconero = xmrToPiconero(amountXmr);
  return rpc("transfer", {
    destinations: [{ address: destination, amount: Number(piconero) }],
    account_index: 0,
    priority: 1, // 1 = default / normal
    ring_size: 16, // current consensus default
    get_tx_key: true,
    do_not_relay: doNotRelay,
  });
}

// ---------- Seed / keys ----------

/**
 * Retrieve the 25-word mnemonic for the currently open wallet.
 * Used when we create a wallet via `create_wallet` (no seed input) and
 * need to harvest the generated seed for the backup view. For the normal
 * restore-from-seed flow, the frontend already has the seed and doesn't
 * need this.
 */
export async function queryMnemonic(): Promise<string> {
  const result = await rpc<{ key: string }>("query_key", { key_type: "mnemonic" });
  return result.key;
}

// ---------- Address management ----------

export interface XmrValidateAddressResult {
  valid: boolean;
  integrated: boolean;
  subaddress: boolean;
  nettype: string; // "mainnet" | "testnet" | "stagenet"
  openalias_address: string;
}

/**
 * Validate any Monero address (standard, subaddress, or integrated).
 * Delegates to the wallet-rpc which handles Monero's non-standard base58
 * block encoding natively — no risk of client-side mis-implementation.
 */
export async function validateAddress(address: string): Promise<XmrValidateAddressResult> {
  return rpc<XmrValidateAddressResult>("validate_address", {
    address,
    any_net_type: false,
    allow_openalias: false,
  });
}

export interface XmrAddressEntry {
  address: string;
  address_index: number;
  label: string;
  used: boolean;
}

/**
 * Generate a new subaddress for the given account.
 * Subaddresses start with "8" (mainnet byte 42) and are unlinkable to the
 * primary address — they should be the default receive address.
 */
export async function createAddress(
  accountIndex: number = 0,
  label: string = ""
): Promise<{ address: string; address_index: number }> {
  return rpc("create_address", { account_index: accountIndex, label });
}

/** List all addresses for an account (primary + all subaddresses). */
export async function getAddresses(accountIndex: number = 0): Promise<{
  address: string;
  addresses: XmrAddressEntry[];
}> {
  return rpc("get_address", { account_index: accountIndex });
}

// ---------- Wallet password ----------

/**
 * Change the wallet file encryption password.
 * Used to encrypt wallet files at rest using a key derived from the vault
 * master password.
 */
export async function changeWalletPassword(
  oldPassword: string,
  newPassword: string
): Promise<void> {
  await rpc("change_wallet_password", {
    old_password: oldPassword,
    new_password: newPassword,
  });
}

// ---------- Transaction history ----------

export interface XmrTransfer {
  txid: string;
  /** Amount in piconero. */
  amount: number;
  /** Fee in piconero (0 for incoming). */
  fee: number;
  /** Block height, or 0 if unconfirmed. */
  height: number;
  /** POSIX timestamp in seconds. */
  timestamp: number;
  confirmations: number;
  type: "in" | "out" | "pending" | "failed" | "pool";
  /** Receiving subaddress (incoming transactions). */
  address: string;
  /** Destination(s) for outgoing transactions. */
  destinations?: { address: string; amount: number }[];
  locked: boolean;
  payment_id: string;
  subaddr_index: { major: number; minor: number };
}

export interface GetTransfersOpts {
  in?: boolean;
  out?: boolean;
  pending?: boolean;
  failed?: boolean;
  pool?: boolean;
  minHeight?: number;
  maxHeight?: number;
  accountIndex?: number;
}

/**
 * Fetch transaction history from the wallet.
 * Returns a merged, typed array of all requested transfer categories.
 */
export async function getTransfers(opts: GetTransfersOpts = {}): Promise<XmrTransfer[]> {
  const params: Record<string, any> = {
    in: opts.in ?? true,
    out: opts.out ?? true,
    pending: opts.pending ?? true,
    failed: opts.failed ?? false,
    pool: opts.pool ?? true,
    account_index: opts.accountIndex ?? 0,
  };
  if (opts.minHeight !== undefined) {
    params.filter_by_height = true;
    params.min_height = opts.minHeight;
  }
  if (opts.maxHeight !== undefined) {
    params.filter_by_height = true;
    params.max_height = opts.maxHeight;
  }

  const raw = await rpc<Record<string, any>>("get_transfers", params);

  const all: XmrTransfer[] = [];
  for (const category of ["in", "out", "pending", "failed", "pool"] as const) {
    const entries: any[] = raw[category] ?? [];
    for (const entry of entries) {
      all.push({ ...entry, type: category === "in" ? "in" : category });
    }
  }
  return all;
}

/**
 * `get_fee_estimate` raw response. `fees` is per-priority (slow/normal/fast/
 * fastest) atomic-units per byte for a typical transaction, when present.
 * Older wallet-rpc builds only return `fee`; we treat that as the single
 * "normal" tier.
 */
export interface XmrFeeEstimate {
  fee: number;
  quantization_mask?: number;
  fees?: number[];
}

/**
 * Ask wallet-rpc for the current network fee estimate. Optionally pass a
 * `grace_blocks` hint (default 10 — same as Monero CLI's default).
 */
export async function getXmrFeeEstimate(graceBlocks: number = 10): Promise<XmrFeeEstimate> {
  return rpc<XmrFeeEstimate>("get_fee_estimate", { grace_blocks: graceBlocks });
}

/** Fetch a single transaction by its txid. */
export async function getTransferByTxid(txid: string): Promise<XmrTransfer | null> {
  try {
    const result = await rpc<{ transfer: any }>("get_transfer_by_txid", { txid });
    return result.transfer ?? null;
  } catch {
    return null;
  }
}

// ---------- Binary management (auto-download + defender) ----------

/** Check if monero-wallet-rpc.exe is present and real (not a placeholder). */
export async function checkWalletRpcExists(): Promise<boolean> {
  return invoke<boolean>("xmr_check_wallet_rpc");
}

/**
 * Download monero-wallet-rpc.exe from the official Monero GitHub releases.
 * Emits `xmr-download-progress` Tauri events for the frontend progress bar.
 */
export async function downloadWalletRpc(): Promise<void> {
  await invoke("xmr_download_wallet_rpc");
}

/** Check if Windows Defender has an exclusion for the monero binary directory. */
export async function checkXmrDefenderExclusion(): Promise<boolean> {
  return invoke<boolean>("xmr_check_defender_exclusion");
}

/**
 * Add Windows Defender exclusion for the monero directory + wallet-rpc exe.
 * Triggers a UAC elevation prompt. Returns true if the exclusion was verified.
 */
export async function addXmrDefenderExclusion(): Promise<boolean> {
  return invoke<boolean>("xmr_add_defender_exclusion");
}
