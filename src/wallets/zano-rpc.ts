/**
 * Typed client for the Zano wallet-rpc sidecar.
 *
 * Structural mirror of `zph-rpc.ts`, but every method shape below was
 * confirmed against a REAL running `simplewallet v2.2.1.506[b76fa18]`
 * (offline, throwaway wallet) on 2026-08-27 — not copied from the docs. The
 * docs and the binary disagreed on one load-bearing point already this
 * integration (see `src-tauri/src/zano_rpc.rs`'s JWT header for the base64
 * alphabet bug that produced), so response shapes here are marked per-field
 * as VERIFIED or INFERRED.
 *
 * Differences from `zph-rpc.ts` / `xmr-rpc.ts`:
 *   - Loopback sidecar on port 18084 (XMR 18082, ZEPH 18083).
 *   - Auth is JWT (`zano_rpc_call` → Rust → `Zano-Access-Token` header), not
 *     HTTP Digest. Nothing here builds the token; the Rust layer owns that.
 *   - `getbalance` returns a per-asset array where EACH ASSET SELF-DESCRIBES
 *     its own `decimal_point` — unlike Zephyr, which hardcodes 12 for every
 *     asset. Never assume a fixed decimal count; read it from the response.
 *   - Wallet open/restore is NOT done via RPC (there is no
 *     `restore_deterministic_wallet` equivalent) — that lifecycle lives
 *     entirely in `zano_rpc.rs`'s two-stage Rust flow (`zano_ensure_wallet`
 *     then `zano_start_rpc`). This module only talks to an already-running
 *     sidecar.
 */

import { decimalToAtomic } from "./decimal-amount";
import { invoke } from "../lib/tauri";

/** `d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a` —
 *  VERIFIED live: this is the `asset_id` the sidecar itself reports for the
 *  native ZANO row in `getbalance`. */
export const ZANO_NATIVE_ASSET_ID =
  "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a";

/** VERIFIED live: native ZANO uses 12 decimal places (same magnitude as
 *  XMR's piconero / ZEPH's atomic unit, coincidentally — NOT assumed, read
 *  from a real `getbalance` response's `asset_info.decimal_point`). */
export const ZANO_NATIVE_DECIMALS = 12;

async function rpc<T = any>(
  method: string,
  params: Record<string, any> = {}
): Promise<T> {
  return (await invoke<T>("zano_rpc_call", { method, params })) as T;
}

// =========================================================================
// Sidecar process lifecycle — thin wrappers over the Rust commands
// =========================================================================

/**
 * Ensure a wallet file exists (create or restore), Stage A of the two-stage
 * lifecycle. Idempotent: returns `false` without touching anything if a
 * wallet file is already present, unless `forceRecreate` is set.
 */
export async function ensureZanoWallet(args: {
  walletPassword: string;
  seedPhrase?: string;
  seedPassphrase?: string;
  forceRecreate?: boolean;
  /** Per-wallet on-disk filename (a `zano` WalletEntry's `sidecarFile`).
   *  Omit for the migrated primary wallet, which keeps Zano's original fixed
   *  name so its existing file is reused with no rescan. */
  walletFile?: string;
}): Promise<boolean> {
  return invoke<boolean>("zano_ensure_wallet", {
    walletPassword: args.walletPassword,
    seedPhrase: args.seedPhrase ?? null,
    seedPassphrase: args.seedPassphrase ?? null,
    forceRecreate: args.forceRecreate ?? false,
    walletFile: args.walletFile ?? null,
  });
}

/** Stage B: spawn the long-lived RPC server against an existing wallet file. */
export async function startZanoRpc(
  daemonAddress: string,
  walletPassword: string,
  walletFile?: string
): Promise<void> {
  await invoke<void>("zano_start_rpc", {
    daemonAddress,
    walletPassword,
    walletFile: walletFile ?? null,
  });
}

export async function stopZanoRpc(): Promise<void> {
  await invoke<void>("zano_stop_rpc");
}

export async function isZanoRpcRunning(): Promise<boolean> {
  return invoke<boolean>("zano_rpc_is_running");
}

export async function checkZanoBinaryExists(): Promise<boolean> {
  return invoke<boolean>("zano_binary_status");
}

/**
 * Download, SHA256-verify, and extract `simplewallet.exe`. Progress arrives
 * via the `zano-download-progress` Tauri event, not this call's return value
 * — subscribe with `@tauri-apps/api/event`'s `listen()` before calling this
 * (see `useZanoSession.ts`). Resolves once extraction completes; rejects
 * with one of three distinguishable messages (`"Download blocked:"`,
 * `"SHA256 mismatch"`, or a generic HTTP/extraction failure) — see
 * `zano_download_wallet_rpc` in `zano_rpc.rs` for why those are kept
 * separate rather than collapsed into one generic error.
 */
export async function downloadZanoWalletRpc(): Promise<void> {
  await invoke<void>("zano_download_wallet_rpc");
}

// =========================================================================
// Balances — VERIFIED live 2026-08-27
// =========================================================================

export interface ZanoAssetInfo {
  assetId: string;
  ticker: string;
  fullName: string;
  /** Atomic-unit decimal places for THIS asset. Read it — do not assume 12. */
  decimalPoint: number;
  currentSupply: number;
  hiddenSupply: boolean;
}

export interface ZanoAssetBalance {
  assetInfo: ZanoAssetInfo;
  /** Atomic units, this asset's own `decimalPoint`. */
  total: number;
  unlocked: number;
  awaitingIn: number;
  awaitingOut: number;
}

interface RawAssetInfo {
  asset_id: string;
  ticker: string;
  full_name: string;
  decimal_point: number;
  current_supply: number;
  hidden_supply: boolean;
}

interface RawAssetBalance {
  asset_info: RawAssetInfo;
  total: number;
  unlocked: number;
  awaiting_in: number;
  awaiting_out: number;
}

function fromRawBalance(r: RawAssetBalance): ZanoAssetBalance {
  return {
    assetInfo: {
      assetId: r.asset_info.asset_id,
      ticker: r.asset_info.ticker,
      fullName: r.asset_info.full_name,
      decimalPoint: r.asset_info.decimal_point,
      currentSupply: r.asset_info.current_supply,
      hiddenSupply: r.asset_info.hidden_supply,
    },
    total: r.total,
    unlocked: r.unlocked,
    awaitingIn: r.awaiting_in,
    awaitingOut: r.awaiting_out,
  };
}

/**
 * Every whitelisted asset's balance in one call.
 *
 * VERIFIED response shape (real wallet, zero balance):
 * `{ balance, balances: [{asset_info:{...}, total, unlocked, awaiting_in,
 * awaiting_out, outs_amount_min, outs_amount_max, outs_count}], unlocked_balance }`.
 * `balance`/`unlocked_balance` at the top level mirror the native-asset row;
 * this function returns the full per-asset array, which is the useful shape
 * for a confidential-assets display.
 */
export async function getAllBalances(): Promise<ZanoAssetBalance[]> {
  const r = await rpc<{ balances?: RawAssetBalance[] }>("getbalance", {});
  return (r.balances ?? []).map(fromRawBalance);
}

/** The native ZANO row specifically, or `null` if absent (should not happen
 *  in practice — the wallet always reports its own native asset). */
export async function getNativeBalance(): Promise<ZanoAssetBalance | null> {
  const all = await getAllBalances();
  return all.find((b) => b.assetInfo.assetId === ZANO_NATIVE_ASSET_ID) ?? null;
}

// =========================================================================
// Address — VERIFIED live
// =========================================================================

/** VERIFIED: `getaddress` → `{ address: "Zx..." }`. */
export async function getAddress(): Promise<string> {
  const r = await rpc<{ address: string }>("getaddress", {});
  return r.address;
}

// =========================================================================
// Confidential-assets whitelist — VERIFIED live
// =========================================================================

export interface ZanoWhitelistAsset {
  assetId: string;
  ticker: string;
  fullName: string;
  decimalPoint: number;
}

/**
 * VERIFIED: `assets_whitelist_get` → `{ global_whitelist: [...] }`, each
 * entry shaped like `asset_info` above. This is the upstream-curated list of
 * known bridge-wrapped assets (observed live: ETHX, DAIX, BNBX, BTCX, each
 * with its OWN decimal count — 6, 6, 6, 8 respectively, confirming per-asset
 * decimals is the correct model, not a Zano-wide constant).
 *
 * Only whitelisted asset_ids show up in `getbalance`'s array — an asset the
 * wallet holds but hasn't whitelisted stays invisible until added via
 * `assets_whitelist_add` (not wired here; out of scope for v1's
 * display/send-only surface).
 */
export async function getAssetsWhitelist(): Promise<ZanoWhitelistAsset[]> {
  const r = await rpc<{ global_whitelist?: RawAssetInfo[] }>(
    "assets_whitelist_get",
    {}
  );
  return (r.global_whitelist ?? []).map((a) => ({
    assetId: a.asset_id,
    ticker: a.ticker,
    fullName: a.full_name,
    decimalPoint: a.decimal_point,
  }));
}

// =========================================================================
// Transfer — shape from docs (`transfer` RPC page), NOT independently
// broadcast-verified (would need a funded wallet + live daemon; out of scope
// for this pass — see the plan's "not yet proven" list).
// =========================================================================

export interface ZanoTransferDestination {
  address: string;
  /** Atomic units for the asset being sent. */
  amount: bigint;
  /** Omit for native ZANO. */
  assetId?: string;
}

export interface ZanoTransferResponse {
  txHash: string;
  txSize: number;
  /** Present only when the tx was built but not relayed (quote flow). */
  txUnsignedHex?: string;
  usedOutIds: number[];
}

/**
 * Build (and by default broadcast) a transfer. `mixin` is documented as
 * network-ruled at 15+ post-Zarcanum — omit it and let the daemon apply the
 * enforced minimum rather than hardcoding a number that could drift from a
 * future consensus change.
 */
export async function transfer(args: {
  destinations: ZanoTransferDestination[];
  fee?: bigint;
  comment?: string;
}): Promise<ZanoTransferResponse> {
  const r = await rpc<{
    tx_hash: string;
    tx_size: number;
    tx_unsigned_hex?: string;
    used_out_ids: number[];
  }>("transfer", {
    destinations: args.destinations.map((d) => ({
      address: d.address,
      amount: d.amount.toString(),
      ...(d.assetId ? { asset_id: d.assetId } : {}),
    })),
    ...(args.fee !== undefined ? { fee: args.fee.toString() } : {}),
    ...(args.comment ? { comment: args.comment } : {}),
  });
  return {
    txHash: r.tx_hash,
    txSize: r.tx_size,
    txUnsignedHex: r.tx_unsigned_hex,
    usedOutIds: r.used_out_ids,
  };
}

// =========================================================================
// Transaction history — VERIFIED shape only for the ZERO-TRANSACTION case;
// the per-transfer entry fields are INFERRED from the docs (`is_income`,
// `amount`, `asset_id`, `height`) and are UNVERIFIED against a real
// transaction. Flagged explicitly rather than guessed silently.
// =========================================================================

export interface ZanoTransferEntry {
  isIncome: boolean;
  amount: number;
  assetId: string;
  height: number;
  txHash?: string;
  timestamp?: number;
  /**
   * True when neither a subtransfer nor a top-level field yielded an amount.
   *
   * `amount` is 0 in that case because the type demands a number — NOT because
   * the transfer moved nothing. Renderers must not print a confident "0": that
   * is precisely the bug this flag exists to stop recurring (2026-09-04, a
   * received transfer displayed as "▲ Sent -0 ZANO").
   */
  amountUnknown?: boolean;
}

/**
 * `get_recent_txs_and_info3`. VERIFIED live with zero transactions:
 * `{ last_item_index, pi: {balance, curent_height, transfer_entries_count,
 * transfers_count, unlocked_balance}, total_transfers }` — note NO
 * `transfers` array key appears at all when there is nothing to list, which
 * is why this returns `[]` on that shape rather than throwing.
 *
 * The actual per-entry array (name and field casing) is UNVERIFIED — no
 * funded wallet was available to observe a real transaction. Treat the
 * `ZanoTransferEntry` mapping below as a best-effort placeholder to replace
 * once a real response can be captured.
 */
export async function getRecentTransfers(
  offset = 0,
  count = 25
): Promise<ZanoTransferEntry[]> {
  const r = await rpc<Record<string, any>>("get_recent_txs_and_info3", {
    offset,
    count,
    exclude_mining_txs: true,
  });
  const raw: any[] = r.transfers ?? r.transactions ?? [];
  return raw.map(parseTransferEntry);
}

/**
 * One `get_recent_txs_and_info3` entry → `ZanoTransferEntry`.
 *
 * # Why this is not `e.amount` / `e.is_income`
 *
 * It was, until 2026-09-04, and a received transfer rendered as
 * `▲ Sent  -0 ZANO`. Neither field exists at the top level of a transfer:
 * Zano is multi-asset, so a transfer carries a LIST of per-asset movements and
 * there is no single top-level amount to read. `e.amount` came back `undefined`
 * → `?? 0` → "0"; `e.is_income` came back `undefined` → `!!` → `false` →
 * "Sent". Two wrong answers, both produced silently by defaulting.
 *
 * The `?? 0` and `!!` are the actual defect. A missing field is "the daemon did
 * not tell me", which is not the same as zero or false, and coercing it into a
 * confident value is what put a wrong number in front of a user.
 *
 * # The shape this parses, and where each part is evidenced
 *
 * From our own engine's ZANO module (`basicswap/interface/zano/zano.py`, which
 * was written against a live daemon — see its `getSpendTxid`):
 *
 *   - `transfers[]`, each with `tx_hash`                        (verified)
 *   - `employed_entries: { spent: [...] }` — non-empty `spent`
 *     means this wallet spent inputs, i.e. OUTGOING               (verified)
 *   - `subtransfers_by_pid[]: [{ subtransfers: [{ is_income }] }]`
 *     — an `is_income === false` subtransfer also means outgoing  (verified)
 *
 * `asset_id` and `amount` as siblings of `is_income` inside a subtransfer are
 * the natural completion of that struct but were NOT observed live — no Zano
 * wallet-rpc was running when this was written (port 18084 unbound), which is
 * the same gap the previous mapping's own comment recorded. So a flat
 * `subtransfers[]` and the old top-level fields are BOTH still accepted, and
 * anything unresolved sets `amountUnknown` rather than reporting a number.
 * Replace this comment with an observed response when one can be captured.
 */
function parseTransferEntry(e: any): ZanoTransferEntry {
  const subs: any[] = [
    // Nested form (verified): subtransfers_by_pid[].subtransfers[]
    ...(Array.isArray(e?.subtransfers_by_pid)
      ? e.subtransfers_by_pid.flatMap((p: any) =>
          Array.isArray(p?.subtransfers) ? p.subtransfers : [],
        )
      : []),
    // Flat form, tolerated.
    ...(Array.isArray(e?.subtransfers) ? e.subtransfers : []),
  ];

  // Direction. `employed_entries.spent` is the authority when present; a
  // subtransfer explicitly marked not-income is the documented second signal.
  // Absent both, fall back to the top-level flag ONLY if it is really a
  // boolean — `undefined` must not read as "outgoing".
  const spent = e?.employed_entries?.spent;
  let isIncome: boolean;
  if (Array.isArray(spent) && spent.length > 0) {
    isIncome = false;
  } else if (subs.some((s) => s?.is_income === false)) {
    isIncome = false;
  } else if (subs.some((s) => s?.is_income === true)) {
    isIncome = true;
  } else {
    isIncome = typeof e?.is_income === "boolean" ? e.is_income : true;
  }

  // Amount: sum the subtransfers moving in the direction we settled on, so a
  // transfer that both spends and receives (change) reports the leg the row
  // claims to describe rather than a net figure the label would contradict.
  const matching = subs.filter(
    (s) => typeof s?.amount === "number" && s?.is_income === isIncome,
  );
  const pool = matching.length
    ? matching
    : subs.filter((s) => typeof s?.amount === "number");

  let amount = 0;
  let amountUnknown = false;
  if (pool.length) {
    amount = pool.reduce((n, s) => n + Number(s.amount), 0);
  } else if (typeof e?.amount === "number") {
    amount = e.amount;
  } else {
    amountUnknown = true;
  }

  const assetId =
    pool.find((s) => typeof s?.asset_id === "string")?.asset_id ??
    (typeof e?.asset_id === "string" ? e.asset_id : ZANO_NATIVE_ASSET_ID);

  if (amountUnknown) {
    console.warn(
      "[zano] no amount field in transfer",
      e?.tx_hash ?? "(no tx_hash)",
      "— entry keys:",
      Object.keys(e ?? {}).join(","),
    );
  }

  return {
    isIncome,
    amount,
    assetId,
    height: e?.height ?? 0,
    txHash: e?.tx_hash,
    timestamp: e?.timestamp,
    ...(amountUnknown ? { amountUnknown: true } : {}),
  };
}

// =========================================================================
// Wallet persistence
// =========================================================================

/** VERIFIED: `store` → `{ wallet_file_size }`. Call before a graceful
 *  shutdown — an abrupt kill mid-write is how wallet files get corrupted. */
export async function storeWallet(): Promise<number> {
  const r = await rpc<{ wallet_file_size: number }>("store", {});
  return r.wallet_file_size;
}

// =========================================================================
// Amount conversion — decimals-PARAMETERIZED, unlike Zephyr's fixed-12
// =========================================================================

/**
 * Decimal-string amount → atomic units, for a GIVEN asset's decimal count.
 * Never hardcode 12: confidential assets on Zano self-describe their own
 * `decimal_point` (observed live: 6 for ETHX/DAIX/BNBX, 8 for BTCX, 12 for
 * native ZANO) and using the wrong count silently sends the wrong amount.
 */
export function zanoToAtomic(amount: string, decimals: number): bigint {
  // See xmrToPiconero — same unvalidated shape. Decimals stay PARAMETERIZED
  // (Zano assets self-describe 6/8/12), only the parsing is now strict.
  return decimalToAtomic(amount, decimals, "Zano amount");
}

export function atomicToZano(atomic: number | bigint, decimals: number): string {
  const bn = typeof atomic === "bigint" ? atomic : BigInt(Math.trunc(atomic));
  const scale = 10n ** BigInt(decimals);
  const whole = bn / scale;
  const frac = bn % scale;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
}
