/**
 * Typed client for the Zephyr wallet-rpc sidecar.
 *
 * Structural mirror of `xmr-rpc.ts`. Differences:
 *   - Loopback sidecar is on port 18083 (Monero uses 18082).
 *   - `get_balance` returns an array of per-asset balances, not a scalar.
 *   - `transfer` takes `source_asset` and `destination_asset`; setting
 *     them to different values performs a protocol-level conversion
 *     (mint/redeem) under a single RPC.
 *
 * All calls go through the `zph_rpc_call` Tauri command which proxies to
 * 127.0.0.1:18083/json_rpc with per-session HTTP Digest auth. The Rust
 * layer (`src-tauri/src/zph_rpc.rs`) owns process lifecycle; this module
 * just wraps the RPC methods into TypeScript-friendly helpers.
 *
 * Asset naming — IMPORTANT:
 *   At the RPC layer, asset types are `"ZPH" | "ZSD" | "ZRS" | "ZYS"`.
 *   At the UI layer, they're displayed as `"ZEPH" | "ZEPHUSD" | "ZEPHRSV" | "ZEPHYRS"`.
 *   Translate at the presentation boundary only; RPC calls use the RPC values.
 */

import { decimalToAtomic } from "./decimal-amount";
import { invoke } from "../lib/tauri";

export const ZPH_WALLET_FILENAME = "pwnda-zph-active";

/** Asset identifiers used at the RPC layer. */
export type ZphAssetType = "ZPH" | "ZSD" | "ZRS" | "ZYS";

export const ZPH_ASSETS: ZphAssetType[] = ["ZPH", "ZSD", "ZRS", "ZYS"];

/** Map RPC asset type to the ticker shown in the UI. */
export const ZPH_UI_TICKER: Record<ZphAssetType, string> = {
  ZPH: "ZEPH",
  ZSD: "ZEPHUSD",
  ZRS: "ZEPHRSV",
  ZYS: "ZEPHYRS",
};

/** Human-friendly long name per asset. */
export const ZPH_ASSET_NAME: Record<ZphAssetType, string> = {
  ZPH: "Zephyr",
  ZSD: "Zephyr Stable Dollar",
  ZRS: "Zephyr Reserve Share",
  ZYS: "Zephyr Yield",
};

/**
 * Accent color per Zephyr ecosystem asset — taken from the project's own
 * asset marks (green dollar / red reserve share / blue yield share) so the
 * app agrees with what a user sees on zephyrprotocol.com.
 *
 * ONE definition. Until 2026-09-02 there were THREE local copies
 * (`WalletLandscapeView`, `ZephyrAssetsCard`, `ZephyrSwapModal`) and they had
 * already drifted: ZPH was `#4ad97a` (green) in two of them and `#3ab0ff`
 * (blue) in the third, so the same asset glowed a different color depending
 * on which surface you were looking at. Each copy's comment claimed it
 * "matches" the others.
 */
export const ZPH_ASSET_COLOR: Record<ZphAssetType, string> = {
  ZPH: "#7d81f0",
  ZSD: "#22c05e",
  ZRS: "#ee4b2b",
  ZYS: "#2b9fe0",
};

// =========================================================================
// Core RPC call
// =========================================================================

async function rpc<T = any>(
  method: string,
  params: Record<string, any> = {}
): Promise<T> {
  return (await invoke<T>("zph_rpc_call", { method, params })) as T;
}

// =========================================================================
// Sidecar lifecycle
// =========================================================================

export async function startZphRpc(daemonAddress: string): Promise<void> {
  await invoke("zph_start_rpc", { daemonAddress });
}

export async function stopZphRpc(): Promise<void> {
  await invoke("zph_stop_rpc");
}

export async function isZphRpcRunning(): Promise<boolean> {
  return invoke<boolean>("zph_rpc_is_running");
}

export async function deleteZphWalletFiles(
  filename: string = ZPH_WALLET_FILENAME
): Promise<void> {
  await invoke("zph_delete_wallet_files", { filename });
}

export async function checkZphWalletRpcExists(): Promise<boolean> {
  return invoke<boolean>("zph_check_wallet_rpc");
}

// =========================================================================
// Wallet lifecycle
// =========================================================================

export async function openWallet(
  filename: string = ZPH_WALLET_FILENAME,
  password: string = ""
): Promise<void> {
  await rpc("open_wallet", { filename, password });
}

export async function closeWallet(): Promise<void> {
  await rpc("close_wallet", {});
}

export async function restoreDeterministicWallet(
  seed: string,
  filename: string = ZPH_WALLET_FILENAME,
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

export async function changeWalletPassword(
  oldPassword: string,
  newPassword: string
): Promise<void> {
  await rpc("change_wallet_password", {
    old_password: oldPassword,
    new_password: newPassword,
  });
}

// =========================================================================
// Status / sync
// =========================================================================

export async function getHeight(): Promise<number> {
  const r = await rpc<{ height: number }>("get_height", {});
  return r.height;
}

export async function autoRefresh(
  enable: boolean,
  period: number = 10
): Promise<void> {
  await rpc("auto_refresh", { enable, period });
}

/**
 * Force the wallet-rpc to flush its in-memory scan state to the on-disk
 * wallet file. Defense-in-depth against hard-kill scenarios — see the
 * identical helper in `xmr-rpc.ts::storeWallet` for the full rationale.
 * The UI calls this every ~60s while syncing so a crash loses at most
 * one minute of progress instead of the entire scan back to
 * `restoreHeight`.
 */
export async function storeWallet(): Promise<void> {
  await rpc("store", {});
}

export async function refresh(startHeight: number = 0): Promise<{
  blocks_fetched: number;
  received_money: boolean;
}> {
  return rpc("refresh", { start_height: startHeight });
}

export async function setDaemon(address: string): Promise<void> {
  const isLocal = address.includes("127.0.0.1") || address.includes("localhost");
  await rpc("set_daemon", {
    address,
    trusted: isLocal,
    ssl_support: "autodetect",
  });
}

/**
 * Higher-level sync status — composes local `get_height` with a raw
 * daemon `/get_info` probe via the Rust side (CORS-safe).
 */
export async function getSyncStatus(
  daemonAddress: string,
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
  if (walletHeight <= 1 && minHeightFloor > 1) {
    walletHeight = minHeightFloor;
  }

  let daemonHeight = 0;
  let daemonOk = false;
  try {
    const r = await invoke<{
      url: string;
      ok: boolean;
      latency_ms: number | null;
      height: number | null;
      error: string | null;
    }>("zph_probe_node", { url: daemonAddress, timeoutMs: 5000 });
    if (r.ok && r.height != null && r.height > 0) {
      daemonHeight = r.height;
      daemonOk = true;
    }
  } catch {
    // daemonOk stays false
  }

  const synced = daemonOk && walletHeight >= daemonHeight - 2;
  const percent =
    daemonHeight > 0 ? Math.min(100, (walletHeight / daemonHeight) * 100) : 0;
  return { walletHeight, daemonHeight, synced, percent, daemonOk };
}

export async function fetchCurrentDaemonHeight(
  daemonUrl: string
): Promise<number> {
  try {
    const r = await invoke<{
      url: string;
      ok: boolean;
      latency_ms: number | null;
      height: number | null;
      error: string | null;
    }>("zph_probe_node", { url: daemonUrl, timeoutMs: 5000 });
    return r.ok && r.height != null ? r.height : 0;
  } catch {
    return 0;
  }
}

// =========================================================================
// Balance / address — MULTI-ASSET
// =========================================================================

export interface ZphAssetBalance {
  asset_type: ZphAssetType;
  balance: number; // atomic units (12 decimals, same as XMR piconero)
  unlocked_balance: number;
  blocks_to_unlock?: number;
  time_to_unlock?: number;
  multisig_import_needed?: boolean;
}

/**
 * Fetch all four asset balances in one RPC call.
 *
 * Request: `get_balance { account_index: 0, all_assets: true }`.
 * Response shape differs from Monero's — `balances` is an array keyed
 * by `asset_type`, not a single `{balance, unlocked_balance}`.
 */
export async function getAllBalances(): Promise<ZphAssetBalance[]> {
  const r = await rpc<{ balances?: ZphAssetBalance[] }>("get_balance", {
    account_index: 0,
    all_assets: true,
  });
  return r.balances ?? [];
}

/** Fetch a single asset's balance. */
export async function getBalanceForAsset(
  asset: ZphAssetType
): Promise<ZphAssetBalance | null> {
  const r = await rpc<{ balances?: ZphAssetBalance[] }>("get_balance", {
    account_index: 0,
    asset_type: asset,
  });
  const list = r.balances ?? [];
  return list[0] ?? null;
}

export async function getAddress(): Promise<string> {
  const r = await rpc<{ address: string }>("get_address", { account_index: 0 });
  return r.address;
}

export interface ZphAddressEntry {
  address: string;
  address_index: number;
  label: string;
  used: boolean;
}

export async function createAddress(
  accountIndex: number = 0,
  label: string = ""
): Promise<{ address: string; address_index: number }> {
  return rpc("create_address", { account_index: accountIndex, label });
}

export async function getAddresses(
  accountIndex: number = 0
): Promise<{ address: string; addresses: ZphAddressEntry[] }> {
  return rpc("get_address", { account_index: accountIndex });
}

export interface ZphValidateAddressResult {
  valid: boolean;
  integrated: boolean;
  subaddress: boolean;
  nettype: string;
  openalias_address: string;
}

export async function validateAddress(
  address: string
): Promise<ZphValidateAddressResult> {
  return rpc<ZphValidateAddressResult>("validate_address", {
    address,
    any_net_type: false,
    allow_openalias: false,
  });
}

// =========================================================================
// Amount conversion (12 decimals, same as XMR piconero)
// =========================================================================

export function zphToAtomic(amount: string): bigint {
  // See xmrToPiconero — same unvalidated shape, same fix.
  return decimalToAtomic(amount, 12, "ZEPH amount");
}

export function atomicToZph(atomic: number | bigint): string {
  const bn = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const whole = bn / 1_000_000_000_000n;
  const frac = bn % 1_000_000_000_000n;
  const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
}

/**
 * Clamp a decimal-string amount to at most `maxDecimals` places, rounding
 * DOWN (truncate). Zephyr mint/redeem (cross-asset `transfer`) only permits
 * ≤4 decimal places — the daemon rejects more with `RPC error -4:
 * Mint/redeem TX amounts permit at most 4 decimal places`. Truncating
 * (never rounding up) guarantees we never try to spend more than the user
 * has. A no-op for amounts already within the limit.
 */
export function clampZphDisplayDecimals(amount: string, maxDecimals = 4): string {
  const trimmed = amount.trim();
  const dot = trimmed.indexOf(".");
  if (dot < 0) return trimmed;
  const frac = trimmed.slice(dot + 1);
  if (frac.length <= maxDecimals) return trimmed;
  const clampedFrac = frac.slice(0, maxDecimals).replace(/0+$/, "");
  return clampedFrac.length > 0
    ? `${trimmed.slice(0, dot)}.${clampedFrac}`
    : trimmed.slice(0, dot);
}

// =========================================================================
// Send / exchange — single RPC overloads both
// =========================================================================

/**
 * Raw shape of `transfer` RPC response. Field semantics are well-defined
 * for same-asset sends; for cross-asset conversions some fields take on
 * Zephyr-specific meanings that differ between wallet-rpc versions.
 *
 * `amount` semantics for cross-asset conversions: requires live smoke
 * test on mainnet to confirm whether this is the source amount in
 * source-asset atomic OR the destination amount in destination-asset
 * atomic. The Zephyr swap UI treats it conservatively as the source
 * amount and computes the destination via oracle-rate inference. See
 * `[[zephyr-ecosystem-swap-plan]]` open question #1.
 */
export interface ZphTransferResponse {
  tx_hash: string;
  tx_key: string;
  amount: number;
  fee: number;
  /** Present only if `get_tx_metadata: true` was set on the request. */
  tx_metadata?: string;
  /** Present only if `get_tx_hex: true` was set on the request. */
  tx_blob?: string;
  multisig_txset?: string;
  unsigned_txset?: string;
  weight?: number;
}

/**
 * Transfer `amountZph` of `sourceAsset` to `destination`.
 *
 * If `sourceAsset === destinationAsset`, this is a plain send.
 * If they differ, this is a protocol-level conversion (mint / redeem)
 * under the same `transfer` RPC. The fee + effective destination amount
 * are returned by wallet-rpc based on Zephyr's oracle pricing.
 *
 * The two `getTxMetadata` / `doNotRelay` flags are paired by typical use:
 * the swap UI's quote step sets BOTH true so it can show the user a
 * binding fee and then `relayTransfer(metadata)` only after confirmation.
 * Plain sends leave both as default (relay immediately, no metadata).
 *
 * Returns tx hash, key, amount, fee, and (optionally) tx_metadata blob.
 */
export async function transferAsset(args: {
  destination: string;
  amountZph: string; // decimal string in source asset
  sourceAsset: ZphAssetType;
  destinationAsset: ZphAssetType;
  doNotRelay?: boolean;
  getTxMetadata?: boolean;
}): Promise<ZphTransferResponse> {
  // Mint/redeem (cross-asset conversion) amounts must have ≤4 decimal
  // places — the daemon rejects more with `RPC error -4`. Clamp (round
  // down) here so EVERY entry point (portrait modal, landscape card,
  // quote + relay) is covered. Same-asset sends keep full precision.
  const amountZph =
    args.sourceAsset !== args.destinationAsset
      ? clampZphDisplayDecimals(args.amountZph, 4)
      : args.amountZph;
  const atomic = zphToAtomic(amountZph);
  return rpc<ZphTransferResponse>("transfer", {
    destinations: [{ address: args.destination, amount: Number(atomic) }],
    account_index: 0,
    priority: 1,
    ring_size: 16,
    get_tx_key: true,
    do_not_relay: args.doNotRelay ?? false,
    get_tx_metadata: args.getTxMetadata ?? false,
    source_asset: args.sourceAsset,
    destination_asset: args.destinationAsset,
  });
}

/**
 * Quote a transfer / conversion without broadcasting. Always sets
 * `do_not_relay: true` and `get_tx_metadata: true` so the UI can show
 * the user a binding fee + amount and then `relayTransfer(metadata)`
 * only after confirmation.
 *
 * For cross-asset conversions, the returned `amount` and `fee` are the
 * amounts the protocol *will* commit if relayed — the dual-oracle
 * worst-of pricing rule has already been applied. The transaction is
 * fully built and signed; the metadata blob is just held back from
 * broadcast until the user confirms.
 *
 * Quote staleness window: pricing record updates per block (~120s).
 * Treat quotes older than ~90s as stale and re-quote.
 */
export async function quoteAssetTransfer(args: {
  destination: string;
  amountZph: string;
  sourceAsset: ZphAssetType;
  destinationAsset: ZphAssetType;
}): Promise<ZphTransferResponse> {
  return transferAsset({
    ...args,
    doNotRelay: true,
    getTxMetadata: true,
  });
}

/**
 * Broadcast a transaction previously built with `quoteAssetTransfer`
 * (i.e. `do_not_relay: true` + `get_tx_metadata: true`). Pass the
 * `tx_metadata` blob from the quote response.
 *
 * Returns the tx hash post-broadcast — should match the quote's
 * tx_hash, since the metadata blob is the same fully-signed tx.
 */
export async function relayTransfer(txMetadata: string): Promise<{ tx_hash: string }> {
  return rpc<{ tx_hash: string }>("relay_tx", { hex: txMetadata });
}

// =========================================================================
// Tx detail lookup — used by swap UI to confirm conversion landed
// =========================================================================

/**
 * Single-transfer detail by txid, with Zephyr's `asset_type` field.
 * Used by the swap UI's success state to read the destination-asset
 * amount that actually landed (handy when the quote response's `amount`
 * field semantics for cross-asset conversions is ambiguous).
 *
 * Wraps `get_transfer_by_txid`. Returns `null` if the tx isn't found
 * in this wallet's history (e.g. just-broadcast and not yet scanned).
 */
export interface ZphTransferDetail {
  txid: string;
  amount: number;
  fee: number;
  asset_type?: ZphAssetType;
  height: number;
  confirmations: number;
  timestamp: number;
  type: string;
  address: string;
  destinations?: { address: string; amount: number }[];
  locked: boolean;
  unlock_time?: number;
  note?: string;
}

export async function getTransferByTxid(
  txid: string,
  accountIndex: number = 0
): Promise<ZphTransferDetail | null> {
  try {
    const r = await rpc<{ transfer?: ZphTransferDetail; transfers?: ZphTransferDetail[] }>(
      "get_transfer_by_txid",
      { txid, account_index: accountIndex }
    );
    // wallet-rpc may return either `transfer` (single) or `transfers` (array).
    if (r.transfer) return r.transfer;
    if (r.transfers && r.transfers.length > 0) return r.transfers[0];
    return null;
  } catch {
    // -8 / "Transaction not found" surfaces as an RPC error string. Treat
    // as null so callers can poll without try/catch noise.
    return null;
  }
}

// =========================================================================
// Transaction history
// =========================================================================

export interface ZphTransfer {
  txid: string;
  amount: number;
  fee: number;
  height: number;
  timestamp: number;
  confirmations: number;
  type: "in" | "out" | "pending" | "failed" | "pool";
  address: string;
  destinations?: { address: string; amount: number }[];
  locked: boolean;
  payment_id: string;
  subaddr_index: { major: number; minor: number };
  /** Asset type — Zephyr-specific field. May be absent on older wallet-rpc. */
  asset_type?: ZphAssetType;
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
 * `get_fee_estimate` raw response — same shape as Monero's. `fees` is per
 * priority (slow/normal/fast/fastest) atomic-units per byte for a typical
 * transaction; older builds only return `fee`.
 */
export interface ZphFeeEstimate {
  fee: number;
  quantization_mask?: number;
  fees?: number[];
}

export async function getZphFeeEstimate(graceBlocks: number = 10): Promise<ZphFeeEstimate> {
  return rpc<ZphFeeEstimate>("get_fee_estimate", { grace_blocks: graceBlocks });
}

export async function getTransfers(
  opts: GetTransfersOpts = {}
): Promise<ZphTransfer[]> {
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
  const all: ZphTransfer[] = [];
  for (const category of ["in", "out", "pending", "failed", "pool"] as const) {
    const entries: any[] = raw[category] ?? [];
    for (const entry of entries) {
      all.push({ ...entry, type: category === "in" ? "in" : category });
    }
  }
  return all;
}

// =========================================================================
// Seed query
// =========================================================================

export async function queryMnemonic(): Promise<string> {
  const r = await rpc<{ key: string }>("query_key", { key_type: "mnemonic" });
  return r.key;
}

// =========================================================================
// Auto-download + Defender exclusion (Windows-only in practice)
// =========================================================================

/**
 * Download zephyr-wallet-rpc.exe from the Zephyr GitHub release pinned in
 * `src-tauri/src/zph_rpc.rs` (currently v2.3.0). Emits
 * `zph-download-progress` Tauri events for the frontend progress bar.
 *
 * Integrity: HTTPS + GitHub release immutability + a compile-time pinned
 * SHA256 constant. No PGP path — Zephyr doesn't publish a signed
 * hashes file.
 */
export async function downloadZphWalletRpc(): Promise<void> {
  await invoke("zph_download_wallet_rpc");
}

/**
 * Check if Windows Defender has an exclusion covering either the Zephyr
 * binary dir or the `zephyr-wallet-rpc` process. Returns `true` if either
 * is present — both are equally effective against the false-positive
 * quarantine.
 *
 * On non-Windows platforms returns `true` unconditionally (no Defender).
 */
export async function checkZphDefenderExclusion(): Promise<boolean> {
  return invoke<boolean>("zph_check_defender_exclusion");
}

/**
 * Add a Windows Defender ExclusionPath for the Zephyr binary dir plus an
 * ExclusionProcess for `zephyr-wallet-rpc.exe`. Triggers a UAC elevation
 * prompt (`Start-Process -Verb RunAs`). Returns true iff the path
 * exclusion was verifiable post-run.
 */
export async function addZphDefenderExclusion(): Promise<boolean> {
  return invoke<boolean>("zph_add_defender_exclusion");
}
