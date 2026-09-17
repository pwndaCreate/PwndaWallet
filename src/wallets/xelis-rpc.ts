/**
 * Xelis wallet sidecar: lifecycle wrappers over the Rust commands in
 * `src-tauri/src/xelis_rpc.rs`, and typed calls to `xelis_wallet`'s JSON-RPC.
 *
 * Every request and response shape below was captured from the real
 * `xelis_wallet` v1.25.0 binary during the P0 spike; the captures live at
 * `wiki/queries/2026-09-15-xelis-wallet-binary-spike.md` (section A5 for the
 * method table, B4 for the verbatim samples). Fields are marked VERIFIED where a
 * live response was observed and SOURCE where only `xelis_common/src/api/wallet.rs`
 * describes them — Zano's history once showed "Sent -0" for a received transfer
 * because a response field was guessed, and that distinction is how this file
 * avoids repeating it.
 *
 * Amounts cross this module as `bigint` atomic units (8 decimals). Strings for
 * display come from `atomicToXelis`.
 */

import { invoke } from "../lib/tauri";
import type { XelisNetwork } from "./xelis-keys";

export const XELIS_DECIMALS = 8;

/** Hash of the native XEL asset: 32 zero bytes, hex. */
export const XELIS_NATIVE_ASSET = "0".repeat(64);

/** Tauri event carrying download progress for `downloadXelisWalletRpc`. */
export const XELIS_DOWNLOAD_PROGRESS_EVENT = "xelis-download-progress";

const ATOMIC_PER_XEL = BigInt("100000000");

/**
 * `FEE_PER_ACCOUNT_CREATION`: the one-off charge for paying an address that has
 * never appeared on chain. 100,000 atomic = 0.001 XEL, a consensus constant
 * (spike A6), observed live as the whole difference between a fee to a
 * registered destination (25,000) and the same send to a fresh one (125,000).
 */
export const XELIS_NEW_ACCOUNT_FEE_ATOMIC = BigInt(100_000);

// =========================================================================
// Sidecar lifecycle
// =========================================================================

/**
 * Stage A: make sure a wallet exists on disk for `walletFile`, restoring it
 * from `seedPhrase` when it does not. Idempotent unless `forceRecreate`.
 * Resolves `true` when a wallet was created.
 */
export async function ensureXelisWallet(args: {
  walletPassword: string;
  seedPhrase?: string;
  forceRecreate?: boolean;
  /** Per-wallet directory name (the `xelis` WalletEntry's `sidecarFile`). */
  walletFile?: string;
  network?: XelisNetwork;
}): Promise<boolean> {
  return invoke<boolean>("xelis_ensure_wallet", {
    walletPassword: args.walletPassword,
    seedPhrase: args.seedPhrase ?? null,
    forceRecreate: args.forceRecreate ?? false,
    walletFile: args.walletFile ?? null,
    network: args.network ?? null,
  });
}

/** Stage B: start the wallet in RPC mode against a daemon. */
export async function startXelisRpc(
  daemonAddress: string,
  walletPassword: string,
  walletFile?: string,
  network?: XelisNetwork
): Promise<void> {
  await invoke<void>("xelis_start_rpc", {
    daemonAddress,
    walletPassword,
    walletFile: walletFile ?? null,
    network: network ?? null,
  });
}

/** Save and stop the wallet process. */
export async function stopXelisRpc(): Promise<void> {
  await invoke<void>("xelis_stop_rpc");
}

export async function isXelisRpcRunning(): Promise<boolean> {
  return invoke<boolean>("xelis_rpc_is_running");
}

export async function checkXelisBinaryExists(): Promise<boolean> {
  return invoke<boolean>("xelis_binary_status");
}

/**
 * Download, SHA256-verify and extract `xelis_wallet`. Progress arrives on
 * `XELIS_DOWNLOAD_PROGRESS_EVENT`; subscribe before calling. Rejects with
 * distinguishable messages for a blocked host, a hash mismatch, and a
 * network or extraction failure.
 */
export async function downloadXelisWalletRpc(): Promise<void> {
  await invoke<void>("xelis_download_wallet_rpc");
}

// =========================================================================
// RPC plumbing
// =========================================================================

/**
 * One JSON-RPC call against the running wallet. The Rust command holds the
 * per-start Basic-auth credentials, so nothing here ever sees them; a JSON-RPC
 * error comes back as a rejected promise with `RPC error <code>: <message>`.
 */
async function rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
  return invoke<T>("xelis_rpc_call", { method, params: params ?? {} });
}

function errorMessage(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * `-32004 BALANCE_NOT_FOUND` — the wallet holds no balance in the asset, so a
 * transaction cannot be built. VERIFIED verbatim:
 * `Balance for asset 0000…0000 was not found`.
 */
export function isXelisBalanceNotFound(e: unknown): boolean {
  const m = errorMessage(e);
  return m.includes("BALANCE_NOT_FOUND") || /Balance for asset .* was not found/.test(m);
}

/**
 * `-32004 NOT_ONLINE_MODE` — the wallet is not connected to a daemon. VERIFIED
 * verbatim: `Wallet is not in online mode`. Returned by `network_info`,
 * `rescan`, and by `build_transaction` when `broadcast` is true.
 */
export function isXelisNotOnline(e: unknown): boolean {
  const m = errorMessage(e);
  return m.includes("NOT_ONLINE_MODE") || m.includes("Wallet is not in online mode");
}

/**
 * `get_topoheight` on a wallet that has not finished its first sync. VERIFIED
 * verbatim against v1.25.0 (Linux, 2026-09-16), right after a restore:
 * `-32004 UNSPECIFIED Error while loading data with hashed key TOPH from disk`.
 * The wallet stores its height when a scan completes, so until the first one
 * does there is no height to read. That is a state, not a failure, and not 0.
 */
export function isXelisHeightNotRecorded(e: unknown): boolean {
  return errorMessage(e).includes("hashed key TOPH");
}

/**
 * A u64 from JSON. Rejects anything that is not a non-negative integer instead
 * of coercing: `Number(undefined)` is `NaN`, `BigInt(NaN)` throws somewhere
 * further away, and `?? 0` would invent a balance nobody reported.
 */
function u64(value: unknown, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Xelis ${what}: expected a non-negative integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Xelis ${what}: expected a u64, got ${JSON.stringify(value)}`);
}

/** Optional u64: `null`/absent stays null rather than becoming 0. */
function optionalU64(value: unknown, what: string): bigint | null {
  if (value == null) return null;
  return u64(value, what);
}

// =========================================================================
// Typed wallet RPC
// =========================================================================

export interface XelisSyncStatus {
  /** The wallet is connected to its daemon. */
  online: boolean;
  /**
   * Topoheight the wallet has scanned to, or `null` while its first sync is
   * still running and it has not recorded one (`isXelisHeightNotRecorded`).
   */
  walletTopoheight: number | null;
  /** The daemon's topoheight, when known. */
  daemonTopoheight: number | null;
  /** Scanned to within the daemon's stable range. */
  synced: boolean;
}

export type XelisTransferKind = "incoming" | "outgoing" | "coinbase" | "burn" | "other";

export interface XelisTransferEntry {
  hash: string;
  kind: XelisTransferKind;
  /** Native XEL moved by this entry, always non-negative; `kind` gives direction. */
  amountAtomic: bigint;
  /** Fee paid, for outgoing entries when the wallet reports it. */
  feeAtomic: bigint | null;
  topoheight: number;
  /** Unix milliseconds, when known. */
  timestamp: number | null;
  /** Sender or first recipient, when the entry names one. */
  counterparty: string | null;
}

export interface XelisFeeEstimate {
  feeAtomic: bigint;
  /** The fee includes the one-off charge for a recipient account not yet on chain. */
  includesNewAccountFee: boolean;
}

/** VERIFIED: `get_address` `{}` -> `"xet:9m48nq…"`. */
export async function getAddress(): Promise<string> {
  const address = await rpc<string>("get_address", {});
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("The Xelis wallet returned no address.");
  }
  return address;
}

/**
 * Spendable native XEL balance.
 *
 * VERIFIED: `get_balance` `{}` -> a bare u64 (`{"result":0}`), NOT an object.
 *
 * **This number is only meaningful once the wallet has synced.** Before and
 * during sync the wallet answers 0 and `has_balance` false — not an error, and
 * indistinguishable from a genuinely empty wallet (spike A5/B4: `get_balance`
 * called at t=1.66 s returned 0). Callers must gate on `getSyncStatus().synced`;
 * `xelis-wallet.ts::getXelisBalanceDetailed` is where that gate lives.
 */
export async function getNativeBalanceAtomic(): Promise<bigint> {
  const raw = await rpc<unknown>("get_balance", { asset: XELIS_NATIVE_ASSET });
  return u64(raw, "get_balance");
}

/**
 * Where the wallet has scanned to, and whether that is the chain tip.
 *
 * Three calls because no single method answers it: `is_online` (bool),
 * `get_topoheight` (the wallet's own scan position) and `network_info` (the
 * daemon's view, which errors with NOT_ONLINE_MODE when offline).
 *
 * "Synced" compares against the daemon's STABLE topoheight rather than its tip:
 * the tip moves every ~5 s, so equality with it flickers, while the stable
 * height is the point past which the chain will not reorganise. VERIFIED shape:
 * `network_info` carried `topoheight: 383957` and `stable_topoheight: 383933`
 * on the same response.
 */
export async function getSyncStatus(): Promise<XelisSyncStatus> {
  const NOT_RECORDED = Symbol("not recorded");
  const [online, walletTopo] = await Promise.all([
    rpc<boolean>("is_online", {}),
    // A freshly restored wallet has no height until its first scan ends.
    // Until 2026-09-16 that rejection failed the whole status read, so the
    // sync card said "Sync status unavailable: RPC error -32004 …" for the
    // entire first sync, which looks like a wallet that never loads.
    rpc<unknown>("get_topoheight", {}).catch((e) => {
      if (isXelisHeightNotRecorded(e)) return NOT_RECORDED;
      throw e;
    }),
  ]);
  const walletTopoheight =
    walletTopo === NOT_RECORDED ? null : Number(u64(walletTopo, "get_topoheight"));

  if (online !== true) {
    return { online: false, walletTopoheight, daemonTopoheight: null, synced: false };
  }

  let daemonTopoheight: number | null = null;
  let stable: number | null = null;
  try {
    const info = await rpc<Record<string, unknown>>("network_info", {});
    const t = optionalU64(info?.topoheight, "network_info.topoheight");
    daemonTopoheight = t == null ? null : Number(t);
    const s = optionalU64(info?.stable_topoheight, "network_info.stable_topoheight");
    stable = s == null ? null : Number(s);
  } catch (e) {
    // Offline mid-call, or a daemon that stopped answering. The wallet's own
    // height is still known, so report that and say the tip is not.
    if (!isXelisNotOnline(e)) console.warn("[xelis-rpc] network_info failed:", errorMessage(e));
    return { online: true, walletTopoheight, daemonTopoheight: null, synced: false };
  }

  const target = stable ?? daemonTopoheight;
  return {
    online: true,
    walletTopoheight,
    daemonTopoheight,
    synced: target != null && walletTopoheight != null && walletTopoheight >= target,
  };
}

/**
 * Unix MILLISECONDS from an entry's `timestamp`.
 *
 * XELIS block timestamps are in milliseconds (`get_info` reports
 * `block_time_target: 5000` for 5-second blocks), and transaction entries carry
 * the same clock — but no live entry was ever captured, so this ACCEPTS either
 * unit rather than trusting that: a value below 1e12 cannot be a millisecond
 * epoch in this century, so it is read as seconds. A wrong unit here renders
 * every history row as 1970 or as the year 58000.
 */
function toMillis(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value : value * 1000;
}

/** Sum the native-XEL amounts out of a `transfers` array (SOURCE: api/wallet.rs). */
function sumNativeTransfers(transfers: unknown): bigint {
  if (!Array.isArray(transfers)) return BigInt(0);
  let total = BigInt(0);
  for (const t of transfers) {
    const asset = (t as Record<string, unknown>)?.asset;
    // An entry with no `asset` key is native by omission in some shapes; one
    // naming a DIFFERENT asset is not XEL and must not be added to an XEL total.
    if (asset != null && asset !== XELIS_NATIVE_ASSET) continue;
    const amount = (t as Record<string, unknown>)?.amount;
    if (amount == null) continue;
    total += u64(amount, "transfer.amount");
  }
  return total;
}

function firstDestination(transfers: unknown): string | null {
  if (!Array.isArray(transfers)) return null;
  for (const t of transfers) {
    const d = (t as Record<string, unknown>)?.destination;
    if (typeof d === "string" && d.length > 0) return d;
  }
  return null;
}

/**
 * One `list_transactions` entry -> `XelisTransferEntry`.
 *
 * The shape is `{hash, topoheight, timestamp, <variant>}` where the variant key
 * is flattened and snake_case (SOURCE: `api/wallet.rs`; the live captures only
 * ever showed `[]`, because no funded wallet existed and the public testnet was
 * stalled). All ten variants are handled by name so an unrecognised one is
 * visibly "other" rather than silently dropped from history.
 *
 * `multi_sig`, `deploy_contract`, `outgoing_blob` and `incoming_blob` move no
 * native XEL at all, so 0 is a FACT for them, not a default. The two contract
 * variants (`invoke_contract`, `incoming_contract`) carry asset-keyed maps whose
 * exact shape was never observed live; they are parsed on the documented shape
 * and warn loudly when that yields nothing, rather than printing a confident 0.
 */
function parseTransferEntry(raw: unknown): XelisTransferEntry {
  const e = (raw ?? {}) as Record<string, unknown>;
  const hash = typeof e.hash === "string" ? e.hash : "";
  const topoheight = Number(optionalU64(e.topoheight, "entry.topoheight") ?? BigInt(0));
  const timestamp = toMillis(e.timestamp);
  const base = { hash, topoheight, timestamp };

  if (e.incoming != null) {
    const v = e.incoming as Record<string, unknown>;
    return {
      ...base,
      kind: "incoming",
      amountAtomic: sumNativeTransfers(v.transfers),
      feeAtomic: null, // the sender paid it; the receiving entry has no fee field
      counterparty: typeof v.from === "string" ? v.from : null,
    };
  }

  if (e.outgoing != null) {
    const v = e.outgoing as Record<string, unknown>;
    return {
      ...base,
      kind: "outgoing",
      amountAtomic: sumNativeTransfers(v.transfers),
      feeAtomic: optionalU64(v.fee, "outgoing.fee"),
      counterparty: firstDestination(v.transfers),
    };
  }

  if (e.coinbase != null) {
    const v = e.coinbase as Record<string, unknown>;
    return {
      ...base,
      kind: "coinbase",
      amountAtomic: u64(v.reward, "coinbase.reward"),
      feeAtomic: null,
      counterparty: null,
    };
  }

  if (e.burn != null) {
    const v = e.burn as Record<string, unknown>;
    const isNative = v.asset == null || v.asset === XELIS_NATIVE_ASSET;
    return {
      ...base,
      kind: "burn",
      amountAtomic: isNative ? u64(v.amount, "burn.amount") : BigInt(0),
      feeAtomic: optionalU64(v.fee, "burn.fee"),
      counterparty: null,
    };
  }

  // Variants that provably move no native XEL: the 0 below is their real amount.
  for (const key of ["multi_sig", "deploy_contract", "outgoing_blob", "incoming_blob"]) {
    const v = e[key] as Record<string, unknown> | undefined;
    if (v != null) {
      return {
        ...base,
        kind: "other",
        amountAtomic: BigInt(0),
        feeAtomic: optionalU64(v.fee, `${key}.fee`),
        counterparty: typeof v.from === "string" ? v.from : null,
      };
    }
  }

  // Contract variants: documented shape, never observed live.
  const contract = (e.invoke_contract ?? e.incoming_contract) as
    | Record<string, unknown>
    | undefined;
  if (contract != null) {
    let amount = BigInt(0);
    let read = false;
    for (const bag of [contract.deposits, contract.received, contract.transfers]) {
      if (bag == null || typeof bag !== "object") continue;
      for (const inner of Object.values(bag as Record<string, unknown>)) {
        const map = inner != null && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
        const native = map?.[XELIS_NATIVE_ASSET];
        if (native != null) {
          amount += u64(native, "contract amount");
          read = true;
        }
      }
    }
    if (!read) {
      console.warn(
        "[xelis-rpc] contract entry",
        hash || "(no hash)",
        "carried no readable native amount — keys:",
        Object.keys(contract).join(",")
      );
    }
    return {
      ...base,
      kind: "other",
      amountAtomic: amount,
      feeAtomic: optionalU64(contract.fee, "contract.fee"),
      counterparty: null,
    };
  }

  console.warn(
    "[xelis-rpc] unrecognised transaction entry",
    hash || "(no hash)",
    "— keys:",
    Object.keys(e).join(",")
  );
  return { ...base, kind: "other", amountAtomic: BigInt(0), feeAtomic: null, counterparty: null };
}

/** VERIFIED empty: `list_transactions` `{}` -> `[]`. */
export async function listTransactions(opts?: { limit?: number }): Promise<XelisTransferEntry[]> {
  const params: Record<string, unknown> = { asset: XELIS_NATIVE_ASSET };
  if (opts?.limit != null) params.limit = opts.limit;
  const rows = await rpc<unknown[]>("list_transactions", params);
  if (!Array.isArray(rows)) return [];
  return rows.map(parseTransferEntry);
}

/**
 * What the network will charge for THIS transfer.
 *
 * VERIFIED live: `estimate_fees` with one native transfer returned 25,000 to a
 * registered destination and 125,000 to a fresh one — the wallet asks the
 * daemon `is_account_registered(dest, true)` and adds
 * `FEE_PER_ACCOUNT_CREATION` for every destination not already on chain.
 *
 * # Why `includesNewAccountFee` is measured, not inferred
 *
 * The fee is `ceil(size/1024)*base_fee_per_kb + outputs*5000 + new*100000`, so
 * the surcharge cannot be read back out of the total without knowing the built
 * size and the current dynamic base fee — neither of which this call returns.
 * Guessing from the magnitude ("125,000 looks like it has one") would break the
 * moment the dynamic base fee moved.
 *
 * So it is measured differentially: price the SAME amount to this wallet's own
 * address, which is registered whenever the wallet has ever received anything,
 * and compare. Identical output count and near-identical size, so the difference
 * isolates the account-creation charge.
 *
 * Known limitation, deliberately a FALSE NEGATIVE rather than a false positive:
 * if the wallet's own account is itself unregistered (it has never received on
 * chain) both estimates carry the charge and the difference is zero, so this
 * reports `false` while the fee does include it. A wallet in that state has no
 * balance to send from, so the case is unreachable from the Send flow. Offline
 * the wallet prices EVERY destination as new for the same reason, which is why
 * `xelis-wallet.ts` only quotes a send once the wallet is online and synced.
 */
export async function estimateTransferFee(
  to: string,
  amountAtomic: bigint
): Promise<XelisFeeEstimate> {
  const transfer = (destination: string) => ({
    transfers: [
      {
        amount: Number(amountAtomic),
        asset: XELIS_NATIVE_ASSET,
        destination,
      },
    ],
  });

  const feeAtomic = u64(await rpc<unknown>("estimate_fees", transfer(to)), "estimate_fees");

  let includesNewAccountFee = false;
  try {
    const self = await getAddress();
    if (self !== to) {
      const baseline = u64(
        await rpc<unknown>("estimate_fees", transfer(self)),
        "estimate_fees (self)"
      );
      includesNewAccountFee = feeAtomic - baseline >= XELIS_NEW_ACCOUNT_FEE_ATOMIC;
    }
  } catch (e) {
    // The fee itself is known and correct; only the EXPLANATION could not be
    // obtained. Say nothing rather than claim either answer.
    console.warn("[xelis-rpc] could not measure the new-account fee:", errorMessage(e));
  }

  return { feeAtomic, includesNewAccountFee };
}

/**
 * Build, sign and broadcast a native XEL transfer.
 *
 * `broadcast` is passed EXPLICITLY. `build_transaction` defaults it to **true**
 * (spike A5) — the one parameter in this API where omitting it moves money, so
 * it is never omitted anywhere in this codebase, including where the intent is
 * to broadcast.
 *
 * VERIFIED error path: an unfunded wallet answers
 * `-32004 BALANCE_NOT_FOUND "Balance for asset 0000…0000 was not found"`
 * (see {@link isXelisBalanceNotFound}), and `broadcast: true` while offline is
 * refused up front with NOT_ONLINE_MODE.
 */
export async function sendTransfer(
  to: string,
  amountAtomic: bigint
): Promise<{ hash: string; feeAtomic: bigint | null }> {
  const r = await rpc<Record<string, unknown>>("build_transaction", {
    transfers: [{ amount: Number(amountAtomic), asset: XELIS_NATIVE_ASSET, destination: to }],
    broadcast: true,
  });
  const hash = typeof r?.hash === "string" ? r.hash : "";
  if (!hash) {
    throw new Error("Xelis reported no transaction hash for the send.");
  }
  return { hash, feeAtomic: optionalU64(r?.fee, "build_transaction.fee") };
}

/**
 * Build the transaction WITHOUT broadcasting, to price it exactly.
 *
 * Returns the fee and the hash the transaction would have. Note that unlike
 * Monero's `do_not_relay` + `relay_tx`, XELIS exposes no "relay this prebuilt
 * blob" method on the wallet, so the quote cannot be broadcast as-is — see
 * `xelis-wallet.ts::sendQuoted`.
 */
export async function buildTransactionPreview(
  to: string,
  amountAtomic: bigint
): Promise<{ hash: string | null; feeAtomic: bigint | null }> {
  const r = await rpc<Record<string, unknown>>("build_transaction", {
    transfers: [{ amount: Number(amountAtomic), asset: XELIS_NATIVE_ASSET, destination: to }],
    broadcast: false,
  });
  return {
    hash: typeof r?.hash === "string" ? r.hash : null,
    feeAtomic: optionalU64(r?.fee, "build_transaction.fee"),
  };
}

/**
 * Point the running wallet at a different daemon without restarting it.
 *
 * VERIFIED: `set_offline_mode` then `set_online_mode {daemon_address,
 * auto_reconnect: true}` -> `true`. `daemon_address` must be a BASE url
 * (`https://node.xelis.io`); passing `…/json_rpc` fails with
 * `HTTP error: 404 Not Found`, because the wallet appends the path itself.
 */
export async function switchDaemon(daemonAddress: string): Promise<void> {
  try {
    await rpc<boolean>("set_offline_mode", {});
  } catch (e) {
    // Already offline is not a failure to go offline.
    if (!isXelisNotOnline(e)) throw e;
  }
  await rpc<boolean>("set_online_mode", {
    daemon_address: daemonAddress,
    auto_reconnect: true,
  });
}

// =========================================================================
// Units
// =========================================================================

/** Decimal XEL string to atomic units. Rejects more than 8 decimal places. */
export function xelisToAtomic(amount: string): bigint {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid XEL amount: "${amount}"`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > XELIS_DECIMALS) {
    throw new Error(`XEL amounts have at most ${XELIS_DECIMALS} decimal places.`);
  }
  return BigInt(whole) * ATOMIC_PER_XEL + BigInt(frac.padEnd(XELIS_DECIMALS, "0"));
}

/** Atomic units to a decimal XEL string with no trailing zeros. */
export function atomicToXelis(atomic: bigint | number | string): string {
  const v = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const negative = v < BigInt(0);
  const abs = negative ? -v : v;
  const whole = (abs / ATOMIC_PER_XEL).toString();
  const frac = (abs % ATOMIC_PER_XEL)
    .toString()
    .padStart(XELIS_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
