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
import { errorText } from "../lib/errorText";
import { SendOutcomeUnknownError } from "./send-outcome";
import type { TxResult } from "./types";

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
 * An atomic amount as the wallet-rpc's JSON `amount` (2026-09-29 send-safety
 * audit, finding 11). Shared with `zph-rpc.ts`: Zephyr's wallet-rpc is a
 * Monero fork with the same JSON layer.
 *
 * A JSON number is exact only up to 2^53 (about 9,007 XMR in piconero), and
 * `Number(piconero)` above that silently asked the wallet for the nearest
 * representable double instead of the amount typed. Up to the limit the amount
 * still goes out as a number, exactly as before; above it, as a decimal string,
 * which carries every digit. That monero-wallet-rpc (and Zephyr's fork) reads a
 * digit string into its u64 is inference (epee's string-to-uint64 converter;
 * not tested against the shipped binary). If it does not, the wallet rejects
 * the request before building anything, so nothing can be sent.
 */
export function atomicForRpc(atomic: bigint): number | string {
  if (atomic < 0n) throw new Error("A negative amount cannot be sent.");
  return atomic <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(atomic) : atomic.toString();
}

/**
 * `transfer` fee priority: 0, the wallet's own default (2026-09-29 send-safety
 * audit, finding 10).
 *
 * It was 1, commented "default / normal". In wallet2 1 is "unimportant", the
 * LOWEST multiplier; 0 is "default" (read in a Monero source snapshot on the
 * audit machine: `wallet2::get_fee_multiplier` and `adjust_priority`, with
 * `m_default_priority = Default` and `m_auto_low_priority = true`). Default
 * pays the low fee while the pool has no backlog at that fee and the last 10
 * blocks are under 80% full, and the normal fee otherwise. Always-lowest could
 * leave a send waiting behind a backlog until the pool dropped it (see the
 * `failed` history rows `xmr-wallet.ts` now shows); always-normal (2) would
 * overpay five-fold whenever the network is quiet. That the shipped v0.18
 * build behaves like the snapshot is inference.
 */
export const XMR_TRANSFER_PRIORITY = 0;

/** `transfer` built with `do_not_relay` + `get_tx_metadata`: signed, not sent. */
export interface XmrBuiltTransfer {
  tx_hash: string;
  tx_key?: string;
  amount: number;
  fee: number;
  /** The signed transaction for `relay_tx`'s `hex`. */
  tx_metadata?: string;
}

/**
 * Build and sign a transfer of `amountXmr` to `destination` WITHOUT
 * broadcasting it (2026-09-29 send-safety audit, finding 1).
 *
 * The send used to be one `transfer` with `do_not_relay: false`: build and
 * broadcast in a single call, under the Rust proxy's 30 s timeout, on a
 * single-threaded wallet-rpc that also serves the 3 s sync polls and runs
 * auto-refresh in the same thread. A call that timed out at the client could
 * still broadcast (inference: epee does not cancel a request whose client went
 * away); the UI said "Transaction failed", and the retry, queued behind the
 * first, picked other outputs once the first had marked its inputs spent and
 * paid a second time.
 *
 * With `do_not_relay` the wallet never reaches `commit_tx`, the only place it
 * broadcasts or marks outputs spent (`fill_response` in wallet_rpc_server.cpp),
 * so a build that fails or times out sent nothing and is safe to retry. The
 * txid is known before {@link relayTransfer} can put anything on the network.
 */
export async function buildTransfer(
  destination: string,
  amountXmr: string
): Promise<XmrBuiltTransfer> {
  const piconero = xmrToPiconero(amountXmr);
  return rpc<XmrBuiltTransfer>("transfer", {
    destinations: [{ address: destination, amount: atomicForRpc(piconero) }],
    account_index: 0,
    priority: XMR_TRANSFER_PRIORITY,
    ring_size: 16, // current consensus default
    get_tx_key: true,
    do_not_relay: true,
    get_tx_metadata: true,
  });
}

/**
 * Broadcast a transaction {@link buildTransfer} built (`relay_tx`, param `hex`).
 * A failure here is not proof that nothing was sent: settle it with
 * {@link settleRelayFailure}.
 */
export async function relayTransfer(txMetadata: string): Promise<{ tx_hash?: string } | null> {
  return rpc<{ tx_hash?: string } | null>("relay_tx", { hex: txMetadata });
}

// ---------- Relay outcome (shared with Zephyr) ----------

/**
 * What the wallet says about one of its own transactions, by txid.
 *  - `confirmed`: listed as mined (`out`/`in`).
 *  - `pending`:   listed as unconfirmed (`pending`/`pool`).
 *  - `failed`:    listed only as failed (dropped from the pool).
 *  - `absent`:    the wallet does not know it ("Transaction not found.").
 *  - `unknown`:   the lookup itself failed; no answer.
 */
export type OwnTxState = "confirmed" | "pending" | "failed" | "absent" | "unknown";

/** A `get_transfer_by_txid` answer as an {@link OwnTxState}. Exported for tests. */
export function ownTxState(result: unknown): OwnTxState {
  const r = (result ?? {}) as { transfer?: { type?: unknown }; transfers?: { type?: unknown }[] };
  const types = [
    ...(Array.isArray(r.transfers) ? r.transfers : []),
    ...(r.transfer ? [r.transfer] : []),
  ].map((t) => t?.type);
  if (types.includes("out") || types.includes("in")) return "confirmed";
  if (types.includes("pending") || types.includes("pool")) return "pending";
  if (types.includes("failed")) return "failed";
  return "unknown";
}

/** `get_transfer_by_txid`'s not-found answer (`-8 WRONG_TXID`, "Transaction not found."). */
export function isTxNotFound(e: unknown): boolean {
  const raw = errorText(e, "").trim();
  return /^RPC error -8:/.test(raw) || /Transaction not found/i.test(raw);
}

/** Look one of this wallet's transactions up by txid. Never throws. */
export async function lookupOwnTransfer(txid: string): Promise<OwnTxState> {
  let r: unknown;
  try {
    r = await rpc("get_transfer_by_txid", { txid });
  } catch (e) {
    return isTxNotFound(e) ? "absent" : "unknown";
  }
  return ownTxState(r);
}

/**
 * Rust proxy failures raised before the wallet-rpc could run the method
 * (`wallet_rpc_common.rs` / `xmr_rpc.rs::do_rpc_call_at`): no connection, a
 * request that was never built, or an authentication step that failed, so the
 * authenticated request never went out or was refused unread.
 */
const NOT_SENT_TRANSPORT =
  /^(TCP connect (failed|timed out)|Only http:\/\/ URLs are supported|Bad port in URL|Body serialization failed|RPC returned 401|RPC HTTP 401\b|WWW-Authenticate missing|Unsupported Digest algorithm|Unsupported qop|Lock error)/;

/**
 * wallet-rpc errors `relay_tx` raises BEFORE `commit_tx` (`on_relay_tx`):
 * restricted mode (-7), no wallet open (-13), unparseable hex (-26) or tx
 * metadata (-27), and the JSON-RPC protocol errors. `-4 Failed to commit tx.`
 * is deliberately absent: `commit_tx` throws it for a daemon's rejection and
 * for a lost daemon connection alike, and the second can come after the node
 * received the transaction. The daemon's reason is dropped either way.
 */
const NOT_RELAYED_CODES = new Set([-7, -13, -26, -27, -32600, -32601, -32602, -32700]);

/**
 * True when a failed `relay_tx` provably broadcast nothing. Everything else —
 * a timeout, a dropped or truncated reply, `-4 Failed to commit tx.`, an
 * unrecognised code — MAY have reached the network.
 */
export function relayFailureIsDefinitive(e: unknown): boolean {
  const raw = errorText(e, "").trim();
  if (NOT_SENT_TRANSPORT.test(raw)) return true;
  const m = /^RPC error (-?\d+):/.exec(raw);
  return m != null && NOT_RELAYED_CODES.has(Number(m[1]));
}

/**
 * Settle a `relay_tx` that did not report success (2026-09-29 send-safety
 * audit, finding 1). Used by Monero and by Zephyr, whose v2.3.0 wallet-rpc is a
 * Monero fork with the same `relay_tx` / `get_transfer_by_txid` (inference for
 * Zephyr: its source was not read).
 *
 * - A definitive failure ({@link relayFailureIsDefinitive}) throws a plain
 *   Error: nothing was broadcast, and building the send again is safe.
 * - Otherwise the wallet is asked about the txid. `commit_tx` lists a
 *   transaction only after the daemon accepted it, so finding it is success.
 *   A lookup that itself failed is asked once more: on the single-threaded
 *   wallet-rpc it queues behind a relay that may still be running.
 * - Anything else throws `SendOutcomeUnknownError` with the txid. Not finding
 *   it is NOT proof of failure: a daemon connection lost after the node
 *   received the transaction fails `commit_tx` before it records anything.
 *
 * Never "try again": the send hook closes the form on the unknown outcome, so
 * one more press cannot build a second transaction.
 */
export async function settleRelayFailure(args: {
  /** "Monero" / "Zephyr", for the messages. */
  chain: string;
  txHash: string;
  error: unknown;
  lookup: (txid: string) => Promise<OwnTxState>;
}): Promise<TxResult> {
  const raw = errorText(args.error, `The ${args.chain} wallet returned no error message.`);
  if (relayFailureIsDefinitive(args.error)) {
    throw new Error(
      `The ${args.chain} wallet did not broadcast the transaction (${raw}). Nothing was sent.`
    );
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await args.lookup(args.txHash);
    if (state === "confirmed") return { hash: args.txHash };
    if (state === "pending") return { hash: args.txHash, pending: true };
    if (state !== "unknown") break;
  }
  throw new SendOutcomeUnknownError(
    `The ${args.chain} wallet did not confirm the broadcast (${raw}).`,
    args.txHash
  );
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

// `getXmrFeeEstimate` was removed 2026-09-29: `get_fee_estimate` is a DAEMON
// method monero-wallet-rpc does not have, so it answered `-32601 Method not
// found` on every call (see `xmrAdapter.getFeeEstimate`). Nothing called it
// successfully, ever.

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
