/**
 * Zephyr Protocol (ZEPH) ChainAdapter — sidecar-backed implementation.
 *
 * Structural parallel to `xmr-wallet.ts`. Differences:
 *   - 25-word seeds only (Zephyr doesn't support polyseed).
 *   - Four assets at one address. `getBalance` is the ZPH total (the
 *     `zephyr` chain row); ZSD/ZRS/ZYS come from `zph-rpc.ts::getAllBalances`
 *     via `useZphSession.assetBalances` (landscape asset rows, the portrait
 *     ZEPHYR ECOSYSTEM card) and are sent with `sendTransaction`'s `assetType`.
 *     (Corrected 2026-09-15: this said the other three were "not shown in v1".)
 *   - Every asset is received at the same addresses: the asset is a tag on
 *     each OUTPUT (`txout_zephyr_tagged_key`, cryptonote_basic.h:80-93 at
 *     Zephyr v2.3.0) and there is no per-asset address prefix
 *     (cryptonote_config.h:226-228).
 *   - A same-asset send pays its network fee in the SENT asset, not ZEPH
 *     (rctSigs.cpp:1861-1862, wallet2.cpp:9593/9673-9674, tx_pool.cpp:367).
 *     While the user edits, the fee is an ESTIMATE that builds nothing: the
 *     node's `get_fee_estimate` rate (read by Rust; the wallet-rpc has no such
 *     method) times a typical send's weight. The exact fee comes from ONE
 *     dry-run `transfer` (`quoteSend`), made when the user reviews the send,
 *     and Confirm relays that build (operator request, 2026-10-01; until then
 *     the dry run was rebuilt on every edit and every 60 s).
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
  SendQuote,
  SendableBalance,
  TxParties,
} from "./types";
import { SendQuoteError } from "./send-quote";
import { isSendOutcomeUnknown } from "./send-outcome";
import { settleRelayFailure } from "./xmr-rpc";
import {
  TYPICAL_SEND_DESCRIPTION,
  ZEPHYR_TYPICAL_CONVERSION_WEIGHT,
  ZEPHYR_TYPICAL_SEND_WEIGHT,
  typicalFee,
  type DaemonFeeRate,
  type TypicalFee,
} from "./cryptonote-fee";
import type { ZphLiveStats } from "./zph-scanner-api";
import { readWalletRpcTransferParties } from "./parties-b-walletrpc";
import { errorText } from "../lib/errorText";
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
  buildAssetTransfer,
  lookupOwnZphTransfer,
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
  relayTransfer,
  getZphDaemonFeeRate,
  parseZphAssetSelector,
  ZPH_UI_TICKER,
  type ZphTransfer,
  type ZphAssetType,
  type ZphValidateAddressResult,
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
  /**
   * Which session this is. A quote's ticket records it, so a transaction built
   * by one session is never relayed by a later one (2026-09-15). A number
   * rather than the session object: the object holds the seed and wallet
   * password, and tickets live in React state.
   */
  epoch: number;
}

let session: ZphSession | null = null;
let sessionEpoch = 0;
let healthUnsubscribe: (() => void) | null = null;

// =========================================================================
// Send helpers (2026-09-15)
// =========================================================================

/** What a Zephyr quote carries for `sendQuoted`. Never shown in the UI. */
interface ZphQuoteTicket {
  /** `transfer`'s `tx_metadata`: the signed transaction, not yet relayed. */
  txMetadata: string;
  txHash: string;
  epoch: number;
}

const sentListeners = new Set<() => void>();

/**
 * Subscribe to "this app just broadcast a Zephyr transaction".
 * `useZphSession` refreshes the ZSD/ZRS/ZYS balances on it; before 2026-09-15
 * they refreshed only on swap success, so an asset row kept showing what had
 * just been sent.
 */
export function onZphSent(listener: () => void): () => void {
  sentListeners.add(listener);
  return () => {
    sentListeners.delete(listener);
  };
}

function notifyZphSent(): void {
  for (const l of sentListeners) {
    try {
      l();
    } catch (e) {
      console.warn("[zph-wallet] send listener failed:", e);
    }
  }
}

interface ZphSyncStatus {
  walletHeight: number;
  daemonHeight: number;
  synced: boolean;
  percent: number;
  daemonOk: boolean;
}

/**
 * Why a send must wait, or `null` when the wallet is synced.
 *
 * 2026-09-15: a failed daemon probe (`zph-rpc.ts::getSyncStatus` sets
 * `daemonOk: false`, `daemonHeight: 0`) used to read "Zephyr wallet not fully
 * synced (0.0% — N / 0)", blaming the wallet for a node it could not reach.
 */
export function zphSyncRefusal(status: ZphSyncStatus | null): string | null {
  if (!status) {
    return "The Zephyr wallet is not ready yet. Please wait for it to finish opening.";
  }
  if (status.synced) return null;
  if (!status.daemonOk) {
    return (
      `Could not reach a Zephyr node to confirm the wallet is synced (wallet at block ${status.walletHeight}). ` +
      "Check the Zephyr node in Settings, then try again."
    );
  }
  return (
    `Zephyr wallet not fully synced (${status.percent.toFixed(1)}% — ${status.walletHeight} / ${status.daemonHeight}). ` +
    "Please wait for sync to complete before sending."
  );
}

/** A `validate_address` answer that rules the recipient out, or null. */
export function zphRecipientProblem(v: ZphValidateAddressResult): SendQuoteError | null {
  if (!v.valid) return new SendQuoteError("invalid-address", "Invalid Zephyr address.");
  if (v.nettype !== "mainnet") {
    return new SendQuoteError("invalid-address", `Address is for ${v.nettype}, not mainnet.`);
  }
  return null;
}

/**
 * A recipient that is not even shaped like an address, or null.
 *
 * Base58 only (2026-09-29). Zephyr's wallet-rpc is a Monero fork, and
 * Monero's `transfer` resolves anything that does not parse as an address as an
 * OpenAlias name through DNS (`validate_transfer` in wallet_rpc_server.cpp;
 * that Zephyr kept it is inference). `validate_address` is called with
 * `allow_openalias: false`, but when that call fails the send goes ahead, so
 * a name would have been paid to whatever address DNS returned.
 */
export function zphRecipientShapeProblem(to: string): SendQuoteError | null {
  if (!to) return new SendQuoteError("invalid-address", "Enter a Zephyr address.");
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(to)) {
    return new SendQuoteError(
      "invalid-address",
      "That is not a Zephyr address. Paste the address itself; this wallet does not look up names (OpenAlias)."
    );
  }
  return null;
}

/**
 * Ask the wallet whether `to` is a mainnet Zephyr address.
 *
 * A failing `validate_address` CALL is not a verdict: the transfer checks the
 * address again and fails with its own error. Until 2026-09-15 this catch read
 * `e.message.startsWith(...)`; Tauri rejects with a plain string, so the catch
 * itself threw a TypeError and replaced the RPC error with
 * "Cannot read properties of undefined (reading 'startsWith')".
 */
async function checkZphRecipient(to: string): Promise<SendQuoteError | null> {
  const shape = zphRecipientShapeProblem(to);
  if (shape) return shape;
  let v: ZphValidateAddressResult;
  try {
    v = await validateAddress(to);
  } catch (e) {
    console.warn(
      "[zph-wallet] validate_address failed; the transfer will check the address itself:",
      errorText(e)
    );
    return null;
  }
  return zphRecipientProblem(v);
}

/**
 * A zephyr-wallet-rpc `transfer` failure, classified for the Send modal.
 *
 * Codes and messages are zephyr v2.3.0's (`wallet_rpc_server.cpp`
 * `handle_rpc_exception` 3588-3672, `wallet_errors.h`), as
 * `wallet_rpc_common.rs` formats them: `RPC error <code>: <message>`. Only the
 * two definitive kinds block a send; the raw text is kept in every message so
 * the exact string stays searchable.
 *
 * Applies to BUILDS only (`do_not_relay`), which broadcast nothing, so "try
 * again" is safe here. Until 2026-09-29 it also classified the one-call send
 * that built AND relayed, where -38/-3 could come from `commit_tx` after the
 * node had the transaction, and "Try again shortly" invited a second payment.
 * Relay failures are settled by txid instead (`relayZphTransaction`).
 */
export function classifyZphTransferError(e: unknown, asset: ZphAssetType): SendQuoteError {
  if (e instanceof SendQuoteError) return e;
  const raw = errorText(e, "The Zephyr wallet returned no error message.");
  const m = /^RPC error (-?\d+):\s*([\s\S]*)$/.exec(raw.trim());
  const code = m ? Number(m[1]) : null;
  const msg = m ? m[2] : raw;
  const ticker = ZPH_UI_TICKER[asset];
  if (code === -37 || /not enough unlocked money/i.test(msg)) {
    return new SendQuoteError(
      "insufficient-funds",
      `Not enough unlocked ${ticker} for this amount plus the network fee. Received funds and ` +
        `change unlock after 10 blocks (about 20 minutes). (${raw})`
    );
  }
  if (
    code === -17 ||
    /not enough money/i.test(msg) ||
    (code === -16 && /^Transaction not possible/i.test(msg))
  ) {
    return new SendQuoteError(
      "insufficient-funds",
      `Not enough ${ticker} for this amount plus the network fee. (${raw})`
    );
  }
  if (code === -2 || /WALLET_RPC_ERROR_CODE_WRONG_ADDRESS/.test(msg)) {
    return new SendQuoteError("invalid-address", `That is not a valid Zephyr address. (${raw})`);
  }
  if (
    code === -38 ||
    code === -3 ||
    /TCP connect|actively refused|Connection refused|RPC request failed|RPC returned 401|No wallet file/i.test(raw)
  ) {
    return new SendQuoteError(
      "not-ready",
      `The Zephyr wallet cannot reach its node, or the node is busy. Nothing was sent; try again shortly. (${raw})`
    );
  }
  return new SendQuoteError("other", raw);
}

/** A built, signed, not yet relayed Zephyr transaction (a send or a conversion). */
export interface ZphBuiltTransaction {
  /** `transfer`'s `tx_metadata`, for `relay_tx`. */
  txMetadata: string;
  txHash: string;
  /** The wallet session that built it (`getZphSessionEpoch`). */
  epoch: number | null;
}

/** The open session's epoch, or null. A build records it; the relay checks it. */
export function getZphSessionEpoch(): number | null {
  return session?.epoch ?? null;
}

/**
 * Broadcast a built transaction (`relay_tx`), for the Send modal and the
 * conversion modal alike (2026-09-29 send-safety audit, findings 1 and 2).
 *
 * Refuses (plain Error, nothing sent) a transaction built by another wallet
 * session: relaying it would broadcast one wallet's transaction through the
 * next one's wallet-rpc, and mark that wallet's outputs spent.
 *
 * A relay that does not report success is settled by txid
 * (`settleRelayFailure`): the wallet lists it → the result; provably not
 * relayed → a plain Error; otherwise `SendOutcomeUnknownError` with the txid.
 * `-4 Failed to commit tx.` is the common case: it drops the daemon's reason
 * (`wallet_rpc_server.cpp:1817-1821`) and can be raised after the broadcast.
 * Until 2026-09-29 that surfaced as an ordinary error with the form still
 * filled, and the Zephyr swap modal offered "◄ Back" to confirm again.
 */
export async function relayZphTransaction(built: ZphBuiltTransaction): Promise<TxResult> {
  if (!session || built.epoch == null || session.epoch !== built.epoch) {
    throw new Error(
      "This transaction was built by a Zephyr wallet session that is no longer open. " +
        "Nothing was sent; review it again."
    );
  }
  let r: { tx_hash?: string } | null;
  try {
    r = await relayTransfer(built.txMetadata);
  } catch (e) {
    let settled: TxResult;
    try {
      settled = await settleRelayFailure({
        chain: "Zephyr",
        txHash: built.txHash,
        error: e,
        lookup: lookupOwnZphTransfer,
      });
    } catch (outcome) {
      // Balances may have moved if it went out.
      if (isSendOutcomeUnknown(outcome)) notifyZphSent();
      throw outcome;
    }
    notifyZphSent();
    return settled;
  }
  notifyZphSent();
  return { hash: r?.tx_hash || built.txHash };
}

/**
 * Build a send of one asset to itself without relaying it. Throws a classified
 * `SendQuoteError` (nothing was broadcast), or an Error when the wallet built
 * nothing relayable.
 */
async function buildZphSend(recipient: string, amount: string, asset: ZphAssetType) {
  let r;
  try {
    r = await buildAssetTransfer({
      destination: recipient,
      amountZph: amount,
      sourceAsset: asset,
      destinationAsset: asset,
    });
  } catch (e) {
    throw classifyZphTransferError(e, asset);
  }
  if (!r || typeof r.tx_metadata !== "string" || r.tx_metadata.length === 0 || !r.tx_hash) {
    throw new SendQuoteError(
      "other",
      "The wallet priced this send but returned no transaction to broadcast (no tx_metadata). Nothing was sent."
    );
  }
  return r as typeof r & { tx_metadata: string };
}

/**
 * The session node's fee rate (`get_fee_estimate`, read by Rust), for an
 * estimate that builds nothing (operator request, 2026-10-01). Throws when no
 * session is open or the node gave no usable rate.
 */
export async function getZphFeeRate(): Promise<DaemonFeeRate> {
  if (!session) {
    throw new Error("Zephyr session not initialized");
  }
  return getZphDaemonFeeRate(session.daemonUrl);
}

/** The oracle rates a non-ZEPH conversion fee is converted with (scanner `livestats`). */
export type ZphFeeConversionRates = Pick<ZphLiveStats, "zsd_rate" | "zrs_rate" | "zys_price" | "zsd_price">;

/**
 * A CONVERSION's fee estimated without building it, in the SOURCE asset's
 * atomic units (operator request, 2026-10-01; the conversion modal used to
 * rebuild the conversion every 60 s to show its fee).
 *
 * wallet2 prices a conversion in ZEPH (weight × rate, rounded up) and, for a
 * source other than ZEPH, converts that into the source asset at the pricing
 * record's moving-average rates (`get_fee_in_asset_equivalent`,
 * cryptonote_tx_utils.cpp:1388-1402 at v2.3.0): ZSD at `stable_ma`, ZRS at
 * `reserve_ma`, ZYS at `stable_ma` and then `yield_price`. On chain, most
 * conversions show exactly that: ZSD-source ones paid about 1/2.9 of the ZEPH
 * rate per byte, ZRS-source ones about 1/1.23 (read-only sample, 2026-10-06;
 * a few paid the ZEPH figure unconverted, from another client - inference).
 *
 * The estimate converts at the oracle rates the modal already shows (scanner
 * `livestats`): `zsd_rate` (ZEPH per ZSD), `zrs_rate` (ZEPH per ZRS), and ZYS's
 * price in ZSD (`zys_price / zsd_price`). Those are spot rates; the record's
 * MA rates differ by a few percent and need a daemon call, which an estimate
 * does not justify. A non-ZEPH source with no usable rate gives `null`: no
 * number rather than a guess.
 */
export function zphConversionFeeEstimate(
  rate: DaemonFeeRate,
  source: ZphAssetType,
  stats: ZphFeeConversionRates | null | undefined,
): TypicalFee | null {
  const zeph = typicalFee(rate, ZEPHYR_TYPICAL_CONVERSION_WEIGHT);
  if (source === "ZPH") return zeph;
  const usable = (n: number | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  let zephPerUnit: number | null = null;
  if (source === "ZSD" && usable(stats?.zsd_rate)) {
    zephPerUnit = stats!.zsd_rate!;
  } else if (source === "ZRS" && usable(stats?.zrs_rate)) {
    zephPerUnit = stats!.zrs_rate!;
  } else if (
    source === "ZYS" &&
    usable(stats?.zsd_rate) &&
    usable(stats?.zys_price) &&
    usable(stats?.zsd_price)
  ) {
    zephPerUnit = stats!.zsd_rate! * (stats!.zys_price / stats!.zsd_price);
  }
  if (zephPerUnit == null) return null;
  const convert = (atomicZeph: bigint) => BigInt(Math.ceil(Number(atomicZeph) / zephPerUnit!));
  return {
    usual: convert(zeph.usual),
    busy: zeph.busy != null ? convert(zeph.busy) : null,
  };
}

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

  // 6. Generate a receive subaddress. Fallback to primary address if this fails.
  //    Not displayed today: receive panels show the primary address, which
  //    receives all four assets (the asset is a tag on each output).
  //    (Corrected 2026-09-15: this called "ZEPHi" the subaddress prefix; see
  //    the subaddress prefix note in the adapter's `addressPlaceholder`.)
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
    epoch: ++sessionEpoch,
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

/**
 * Lock: end this app's Zephyr session without closing the wallet under the
 * swap node. Releases only the app's `Session` lease. While the node holds its
 * `SwapEngine` lease the process keeps the wallet open; when no other lease is
 * held, Rust closes the wallet and stops the process itself
 * (`zph_rpc.rs::zph_stop_rpc_internal`), so nothing is left open by accident.
 * An unlock reopens the same file in the running process (`initZphSession`).
 *
 * 2026-09-15: Lock used `closeZphWallet`, which sends `close_wallet` before
 * releasing the lease, so the process the node keeps served no wallet and the
 * engine's main-wallet calls failed under any swap in flight. A wallet switch
 * and wallet removal still use `closeZphWallet`.
 */
export async function lockZphWallet(): Promise<void> {
  if (!session) return;
  session = null;
  if (healthUnsubscribe) {
    healthUnsubscribe();
    healthUnsubscribe = null;
  }
  stopHealthLoop();
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

// =========================================================================
// ChainAdapter implementation
// =========================================================================

export const zphAdapter: ChainAdapter = {
  chain: "zephyr",
  displayName: "Zephyr",
  ticker: "ZEPH",
  color: "#3ab0ff",
  // Mainnet prefixes at Zephyr v2.3.0 (cryptonote_config.h:226-228), checked
  // 2026-09-15 by base58-encoding each varint prefix: standard "ZEPHYR",
  // subaddress "ZEPHs", integrated "ZEPHii". This used to offer "ZEPHi...".
  addressPlaceholder: "ZEPHYR..., ZEPHs... or ZEPHii...",
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
    // Plain send of a single asset: source === destination so wallet-rpc does a
    // normal transfer, NOT a protocol mint/redeem (those go through the Zephyr
    // swap modal). `assetType` selects which held asset to send — ZPH for the
    // focal ZEPH panel, or ZSD/ZRS/ZYS when sending one of the ecosystem assets
    // surfaced as their own rows. `amount` is in the SOURCE asset's units
    // (12 decimals, same for every Zephyr asset), and so is the network fee.
    // An unknown selector throws here, before anything reaches the wallet.
    const asset = parseZphAssetSelector(assetType);
    const epoch = session.epoch;
    // Require sync to be within 2 blocks of tip before sending.
    const refusal = zphSyncRefusal(await getZphSyncProgress());
    if (refusal) throw new Error(refusal);
    const recipient = to.trim();
    const badRecipient = await checkZphRecipient(recipient);
    if (badRecipient) throw badRecipient;
    // Build, then relay (2026-09-29 send-safety audit, finding 1). This was one
    // relaying `transfer`: a timeout or a -38/-3 from its broadcast step read
    // "...Try again shortly." while the transaction could be on the network.
    const built = await buildZphSend(recipient, amount.trim(), asset);
    return relayZphTransaction({ txMetadata: built.tx_metadata, txHash: built.tx_hash, epoch });
  },

  /**
   * Price this exact send by building it without broadcasting (2026-09-15).
   *
   * `transfer` with `do_not_relay` + `get_tx_metadata` never reaches
   * `commit_tx` (wallet_rpc_server.cpp:1093-1094 at v2.3.0), and `commit_tx`
   * is the only place wallet2 marks outputs spent or records a pending tx
   * (wallet2.cpp:7187-7273): a quote spends, locks and lists nothing. The
   * returned `fee` is in the SENT asset's atomic units
   * (wallet_rpc_server.cpp:1051), so `feeTicker` is that asset's ticker.
   *
   * Since 2026-10-01 this is the Review step, built ONCE when the user asks
   * ({@link quoteBuildsSpend}). It was called 600 ms after every edit and
   * every 60 s while the Send modal was open, and every build asks the node
   * for the coins it spends with a fresh set of decoys: several builds of one
   * spend can show a node which coins are the wallet's.
   */
  async quoteSend({ to, amount, assetType }): Promise<SendQuote> {
    if (!session) {
      throw new SendQuoteError("not-ready", "The Zephyr wallet is not open yet.");
    }
    const epoch = session.epoch;
    const asset = parseZphAssetSelector(assetType);
    // A wallet short of the tip can answer "not enough money" for funds it has
    // not scanned yet. That must never become a Send-blocking verdict, so
    // pricing waits for sync exactly as sending does.
    const refusal = zphSyncRefusal(await getZphSyncProgress());
    if (refusal) throw new SendQuoteError("not-ready", refusal);
    const recipient = to.trim();
    const priced = amount.trim();
    const badRecipient = await checkZphRecipient(recipient);
    if (badRecipient) throw badRecipient;
    const r = await buildZphSend(recipient, priced, asset);
    if (!Number.isSafeInteger(r.fee) || r.fee < 0) {
      throw new SendQuoteError("other", "The wallet returned no usable fee for this send.");
    }
    const ticket: ZphQuoteTicket = { txMetadata: r.tx_metadata, txHash: r.tx_hash, epoch };
    return {
      to: recipient,
      amount: priced,
      ...(assetType === undefined ? {} : { assetType }),
      fee: atomicToZph(r.fee),
      feeTicker: ZPH_UI_TICKER[asset],
      quotedAt: Date.now(),
      ticket,
    };
  },

  /**
   * Confirm: broadcast the transaction the review built (`relay_tx`, param
   * `hex`) — exactly that one, whose fee the modal showed.
   *
   * It NEVER builds again (operator request, 2026-10-01). Until then a ticket
   * from an earlier wallet session, or one 90 s old, was replaced by a fresh
   * build relayed on the spot: a second build of the same spend, with a fee
   * nobody had been shown. Now such a ticket is refused with "Nothing was
   * sent" (`relayZphTransaction` checks the session) and the user reviews
   * again. Age is no reason to rebuild a same-asset send: it carries no
   * pricing record (`pricing_record_height` must be 0 for a transfer,
   * tx_pool.cpp:301-305 at v2.3.0) and does not expire; the 90 s rule came
   * from conversions, whose record must be one of the last 10 blocks. A ticket
   * without its txid is not relayed either: a relay that fails ambiguously is
   * settled by that txid.
   */
  async sendQuoted(quote: SendQuote): Promise<TxResult> {
    if (!session) {
      throw new Error("Zephyr session not initialized. Please wait for sync.");
    }
    const t = quote.ticket as Partial<ZphQuoteTicket> | null | undefined;
    if (
      !t ||
      typeof t.txMetadata !== "string" ||
      t.txMetadata.length === 0 ||
      typeof t.txHash !== "string" ||
      t.txHash.length === 0 ||
      typeof t.epoch !== "number"
    ) {
      throw new Error(
        "This Zephyr send has no reviewed transaction to broadcast. Nothing was sent; review it again."
      );
    }
    return relayZphTransaction({ txMetadata: t.txMetadata, txHash: t.txHash, epoch: t.epoch });
  },

  /** Unlocked and total balance of the asset a send draws on (2026-09-15). */
  async getSendableBalance(assetType?: string): Promise<SendableBalance> {
    if (!session) {
      throw new Error("Zephyr session not initialized");
    }
    const asset = parseZphAssetSelector(assetType);
    // No entry means none held: wallet-rpc omits zero balances
    // (wallet_rpc_server.cpp:483-484).
    const bal = await getBalanceForAsset(asset);
    return {
      unlocked: atomicToZph(bal?.unlocked_balance ?? 0),
      total: atomicToZph(bal?.balance ?? 0),
    };
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
    // `failed: true` since 2026-09-29 (send-safety audit, finding 10): with
    // `false`, a send the pool later dropped vanished from Activity.
    const transfers = await getTransfers({
      in: true,
      out: true,
      pending: true,
      pool: true,
      failed: true,
    });
    transfers.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const items: ChainTx[] = transfers.slice(0, limit).map(zphTransferToChainTx);
    return { items };
  },

  /**
   * This wallet's own record of one of its transactions, from
   * zephyr-wallet-rpc's `get_transfer_by_txid` (2026-09-30), read exactly as
   * Monero's (`parties-b-walletrpc.ts`): zephyr-wallet-rpc is a
   * monero-wallet-rpc fork with the same method, and the send path already
   * settles relays with it (`lookupOwnZphTransfer`). A receipt's sender is
   * hidden by the protocol.
   */
  async getTransactionParties(hash: string): Promise<TxParties | null> {
    if (!session) {
      throw new Error("The Zephyr wallet is not open, so its transactions cannot be read.");
    }
    return readWalletRpcTransferParties({
      command: "zph_rpc_call",
      sidecar: "zephyr-wallet-rpc",
      txid: hash.trim(),
    });
  },

  /**
   * zephyr-wallet-rpc sets the fee itself from `priority`, exactly as
   * monero-wallet-rpc does, so a missing estimate must not block Send.
   *
   * 2026-09-15 (operator): "RPC error -32601: Method not found Send is disabled
   * until a fee is available." on Send ZEPH. The Monero half of this was fixed
   * 2026-08-29 (see `WalletAdapter.networkComputesFee`); Zephyr is a Monero fork
   * with the same wallet-rpc surface and the same `get_fee_estimate` call below,
   * which is a DAEMON method the wallet-rpc does not have — and only Monero's
   * adapter got the flag.
   */
  networkComputesFee: true,

  /**
   * An ESTIMATE that builds nothing, in the asset being sent (operator
   * request, 2026-10-01): the session node's fee rate (`get_fee_estimate`, read
   * by Rust) times the weight of a typical send, 2,231 (two inputs, two
   * outputs; `cryptonote-fee.ts`). `normal` is the low rate the wallet's
   * priority 0 pays unless the network is busy, `fast` the normal rate it pays
   * then. A same-asset send pays the same number of atomic units per byte in
   * any asset: the pool converts a transfer's fee with no pricing record, i.e.
   * not at all (`check_fee` → `get_fee_in_zeph_equivalent`, inference from
   * blockchain.cpp:3946-3986 at v2.3.0), and ZEPHUSD / ZEPHYRS sends on chain
   * paid 210,000 or 820,000 per byte like ZEPH ones (read-only sample,
   * 2026-10-06). The exact fee comes from the one build `quoteSend` makes when
   * the user reviews.
   *
   * History: this called the WALLET-rpc's `get_fee_estimate`, a daemon method
   * it does not have (absent from wallet_rpc_server.h:70-162 at v2.3.0):
   * `-32601 Method not found`. From 2026-09-15 it threw without a call and the
   * Send modal priced every send by building it, on every edit and every 60 s.
   *
   * Throws when the session is not open or the node gave no usable rate; the
   * Send modal then says the fee is shown at confirmation.
   */
  async getFeeEstimate(assetType?: string): Promise<FeeEstimate> {
    if (!session) {
      throw new Error("Zephyr session not initialized");
    }
    const asset = parseZphAssetSelector(assetType);
    const rate = await getZphDaemonFeeRate(session.daemonUrl);
    const fee = typicalFee(rate, ZEPHYR_TYPICAL_SEND_WEIGHT);
    return {
      normal: { value: atomicToZph(fee.usual) },
      ...(fee.busy != null ? { fast: { value: atomicToZph(fee.busy) } } : {}),
      unit: ZPH_UI_TICKER[asset],
      typicalShape: TYPICAL_SEND_DESCRIPTION,
      fetchedAt: Date.now(),
      raw: {
        perByte: rate.perByte.map(String),
        quantizationMask: String(rate.quantizationMask),
        weight: ZEPHYR_TYPICAL_SEND_WEIGHT,
      },
    };
  },

  /** `quoteSend` builds the spend itself: review once, never preview (2026-10-01). */
  quoteBuildsSpend: true,
};

/**
 * One wallet-rpc transfer as a unified history row. Exported for tests.
 *
 * `pool` is INCOMING money seen in the mempool; `pending` is the OUTGOING
 * unconfirmed one (wallet-rpc `get_transfers` categories). Until 2026-09-15
 * `pool` mapped to direction "pending", which every renderer and the Sent
 * filter treat as outgoing, so an unconfirmed receipt read "▲ sent". It is now
 * "in" with 0 confirmations, which the renderers already show as a pending
 * receipt. (`xmr-wallet.ts` maps Monero's `pool` the same way since
 * 2026-09-29.) A `failed` row is an outgoing send the pool dropped, so it names
 * its recipient like any other send.
 */
export function zphTransferToChainTx(t: ZphTransfer): ChainTx {
  let direction: ChainTx["direction"];
  switch (t.type) {
    case "in":
      direction = "in";
      break;
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
  const counterparty =
    direction === "out" || direction === "pending" || direction === "failed"
      ? t.destinations?.[0]?.address
      : undefined;
  return {
    chain: "zephyr",
    hash: t.txid,
    direction,
    amount: atomicToZph(t.amount),
    fee: t.fee ? atomicToZph(t.fee) : undefined,
    timestamp: t.timestamp || undefined,
    // A mempool receipt has no confirmations by definition; set it explicitly
    // rather than trusting the field, since "0" is what marks the row pending.
    confirmations: t.type === "pool" ? 0 : t.confirmations,
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
  // REQUIRED — see `rescanXmrFromHeight`: this deletes the file first, and an
  // omitted name deleted the primary wallet's `pwnda-zph-active` (2026-09-16).
  walletFilename: string
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
