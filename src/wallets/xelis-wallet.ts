/**
 * Xelis (XEL) wallet: session lifecycle and the `ChainAdapter`.
 *
 * Structural parallel to `zano-wallet.ts` — same two-stage Rust lifecycle
 * (`ensure` then `start`), same per-chain PBKDF2 wallet-file password, same
 * address cross-check with a delete-and-restore self-heal. Four things differ,
 * each because the XELIS binary genuinely behaves differently (spike of
 * 2026-09-15, `wiki/queries/2026-09-15-xelis-wallet-binary-spike.md`):
 *
 *  1. **`getBalance` throws until the wallet has synced.** `get_balance` answers
 *     `0` — and `has_balance` answers `false` — on a wallet that has not
 *     finished scanning, which is indistinguishable from an empty wallet.
 *     Zano's adapter returns the string "Syncing…" in that situation; this one
 *     refuses, because "0" and "unknown" are different facts and only one of
 *     them is safe to put next to a Send button.
 *  2. **The daemon is switched in place**, with `set_offline_mode` +
 *     `set_online_mode`, both verified live. Zano respawns its sidecar because
 *     no hot-swap method was ever confirmed for it.
 *  3. **History failures propagate.** `getZanoTransactionHistory` catches and
 *     returns `[]`, which renders "no transactions" for "could not read".
 *     `useXelisSession` wants the throw so it can show `txError`.
 *  4. **Sends are priced per transfer** (`quoteSend`), following the Zephyr
 *     pattern in `send-quote.ts`, because XELIS charges a one-off 0.001 XEL
 *     when the recipient has never appeared on chain and the user should see
 *     that before they press Send, not after.
 */

import type {
  ChainAdapter,
  ChainTx,
  FeeEstimate,
  NetworkInfo,
  SendQuote,
  SendableBalance,
  TxHistoryPage,
  TxResult,
  WalletInfo,
} from "./types";
import { SEND_QUOTE_MAX_AGE_MS, SendQuoteError } from "./send-quote";
import {
  generateXelisSeed,
  isXelisAddressShape,
  normalizeXelisSeed,
  validateXelisSeed,
  verifyXelisSeedIntegrity,
  xelisAddressFromSeed,
  xelisNetworkFromEnv,
  type XelisNetwork,
} from "./xelis-keys";
import {
  atomicToXelis,
  checkXelisBinaryExists,
  downloadXelisWalletRpc,
  ensureXelisWallet,
  estimateTransferFee,
  getAddress,
  getNativeBalanceAtomic,
  getSyncStatus,
  isXelisBalanceNotFound,
  isXelisNotOnline,
  isXelisRpcRunning,
  listTransactions,
  sendTransfer,
  startXelisRpc,
  stopXelisRpc,
  switchDaemon,
  xelisToAtomic,
  type XelisSyncStatus,
  type XelisTransferEntry,
} from "./xelis-rpc";
import { pickXelisDaemon } from "./xelis-nodes";
import { XELIS_DEFAULT_NODES, XELIS_TESTNET_NODE } from "./xelis-nodes-default";

interface XelisSession {
  seed: string;
  daemonUrl: string;
  walletPassword: string;
  currentAddress: string;
  network: XelisNetwork;
  /** Per-wallet on-disk directory name (the `xelis` WalletEntry's `sidecarFile`). */
  walletFile?: string;
  /** Bumped per session, so a stale send quote cannot be broadcast. */
  epoch: number;
}

let session: XelisSession | null = null;
let epochCounter = 0;

export interface XelisBalanceDetail {
  /** Everything the wallet holds, as a decimal XEL string. */
  total: string;
  /** What a send can spend right now. */
  unlocked: string;
  /** `total` and `unlocked` differ (funds still settling). */
  hasLocked: boolean;
}

/** What a Xelis quote carries for `sendQuoted`. Never shown in the UI. */
interface XelisQuoteTicket {
  amountAtomic: string;
  feeAtomic: string;
  epoch: number;
}

// =========================================================================
// Wallet-file password
// =========================================================================

/**
 * PBKDF2 from the vault master password. Mirrors `zano-wallet.ts` exactly
 * except for the salt string, so a compromise of one chain's wallet-file
 * password gives no leverage on another's.
 *
 * This value matters more here than on the Monero-lineage chains: XELIS
 * encrypts the wallet with Argon2id at 128 MiB and stores the parameters IN the
 * wallet, so a wrong password is reported as
 * `Invalid password provided for this wallet` and there is no recovery except
 * restoring from the seed.
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
      salt: enc.encode("pwnda-xelis-wallet-file"),
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
 * Fallback when `pickXelisDaemon` itself throws. Not the pool —
 * `xelis-nodes.ts` owns that — it exists so a probe failure reports a concrete
 * URL rather than an empty string.
 */
function defaultDaemon(network: XelisNetwork): string {
  return network === "testnet" ? XELIS_TESTNET_NODE.url : XELIS_DEFAULT_NODES[0].url;
}

// =========================================================================
// Session lifecycle
// =========================================================================

/**
 * Open (creating or restoring as needed) the wallet for `rawSeed`, start the
 * wallet process against a daemon, and confirm the address it reports.
 *
 * The address cross-check is not ceremony. XELIS ignores `--seed` when the
 * target directory already holds a `db`, opening the EXISTING wallet instead
 * and reporting success — the same class of fault as Zano's "second wallet
 * opened the first wallet's file". Per-wallet directories make it unlikely;
 * comparing the reported address against the offline derivation is what makes
 * it impossible to miss.
 */
export async function initXelisSession(
  rawSeed: string,
  masterPassword: string,
  walletFile?: string
): Promise<void> {
  const seed = normalizeXelisSeed(rawSeed);
  const check = verifyXelisSeedIntegrity(seed);
  if (!check.ok) {
    // Provenance-neutral wording. This runs for a phrase the user just typed
    // AND for one read from a saved wallet entry at unlock
    // (`useVault`'s restore path), where "phrase" would blame the user for
    // words they never entered. `XelisSyncCard` matches on these words to
    // offer re-import instead of a Retry that re-reads the same entry.
    throw new Error(
      check.kind === "key"
        ? "These words are valid but they do not form a usable Xelis key."
        : "Not a valid Xelis seed."
    );
  }

  const network = xelisNetworkFromEnv();
  const walletPassword = await deriveWalletPassword(masterPassword);

  // Fast path: same seed AND same file, already serving. Matching on the seed
  // alone would leave the previous wallet's RPC answering for a new session.
  if (
    session &&
    session.seed === seed &&
    session.walletFile === walletFile &&
    session.network === network &&
    (await isXelisRpcRunning().catch(() => false))
  ) {
    return;
  }

  if (session) {
    try {
      await closeXelisWallet();
    } catch {
      /* ignore — we are replacing it either way */
    }
  }

  // Every build bundles `xelis_wallet`, and the status check unpacks it on
  // first use. A build without it (or a payload staged for the other
  // platform) falls back to the pinned download, as Monero and Zephyr do.
  // Until 2026-09-16 this threw "Download it from Settings first", pointing at
  // a control that never existed.
  if (!(await checkXelisBinaryExists())) {
    try {
      await downloadXelisWalletRpc();
    } catch (e: any) {
      // XelisSyncCard branches on these words: "binary" + "missing" for the
      // download button, "download failed" + the Rust error's "blocked" or
      // "SHA256" for the two hints.
      throw new Error(
        `The Xelis wallet binary is missing and the download failed: ${String(e?.message ?? e)}`
      );
    }
    if (!(await checkXelisBinaryExists())) {
      throw new Error(
        "The Xelis wallet binary is missing after downloading it. Antivirus software may have " +
          "removed it; allow the PwndaWallet data folder and retry."
      );
    }
  }

  // What the address SHOULD be, independent of anything the sidecar says.
  const expectedAddress = xelisAddressFromSeed(seed, network);

  const daemonUrl = await pickXelisDaemon().catch(() => defaultDaemon(network));

  await ensureXelisWallet({ walletPassword, seedPhrase: seed, walletFile, network });

  try {
    await startXelisRpc(daemonUrl, walletPassword, walletFile, network);
  } catch (e: any) {
    throw new Error(`Failed to start the Xelis wallet: ${String(e?.message ?? e)}`);
  }

  let actualAddress = "";
  try {
    actualAddress = await getAddress();
  } catch {
    /* falls through to the mismatch branch below */
  }

  if (expectedAddress == null) {
    // Cannot happen for a seed that passed the integrity check, but if it ever
    // did, trusting the running wallet silently is the wrong half to keep.
    console.warn("[xelis-wallet] no offline address to cross-check against");
  } else if (actualAddress !== expectedAddress) {
    console.warn(
      "[xelis-wallet] opened wallet address doesn't match the seed; deleting stale " +
        `directory and restoring fresh. opened=${actualAddress} expected=${expectedAddress}`
    );
    await stopXelisRpc().catch(() => {});
    await ensureXelisWallet({
      walletPassword,
      seedPhrase: seed,
      forceRecreate: true,
      walletFile,
      network,
    });
    await startXelisRpc(daemonUrl, walletPassword, walletFile, network);
    actualAddress = await getAddress();
    if (actualAddress !== expectedAddress) {
      throw new Error(
        "Xelis wallet address mismatch persists after recreating the wallet " +
          `(the wallet reports ${actualAddress}, the seed derives ${expectedAddress}). ` +
          "Refusing to use either: one of them is not your wallet."
      );
    }
  }

  session = {
    seed,
    daemonUrl,
    walletPassword,
    currentAddress: actualAddress,
    network,
    walletFile,
    epoch: ++epochCounter,
  };
}

/**
 * Save the wallet and stop its process. Used for wallet switch and removal.
 *
 * The saving is Rust's: `xelis_stop_rpc` goes offline, waits past sled's 500 ms
 * flush interval and then shuts the process down with a console CTRL+C, which
 * the spike measured exiting cleanly in about 0.5 s. There is no
 * `store`-equivalent RPC to call first the way Zano has.
 */
export async function closeXelisWallet(): Promise<void> {
  await stopXelisRpc().catch(() => {});
  session = null;
}

/**
 * End this app's session on Lock.
 *
 * Identical to {@link closeXelisWallet}: unlike Zano and Zephyr, no swap engine
 * shares the Xelis wallet, so there is nothing to keep it open for. If XEL ever
 * becomes a swap leg, this is the function that has to learn the difference —
 * see `zano_rpc.rs`'s engine claim for the shape that takes.
 */
export async function lockXelisWallet(): Promise<void> {
  await stopXelisRpc().catch(() => {});
  session = null;
}

export function getXelisReceiveAddress(): string | null {
  return session?.currentAddress ?? null;
}

export function getActiveXelisDaemon(): string | null {
  return session?.daemonUrl ?? null;
}

/**
 * Point the running wallet at another daemon, without restarting it.
 *
 * Verified live: `set_offline_mode` then
 * `set_online_mode {daemon_address, auto_reconnect: true}`. Zano has to respawn
 * its sidecar for this because no equivalent was ever confirmed there; XELIS's
 * was, so a node switch costs no rescan and no Argon2id re-open (~1 s).
 */
export async function switchXelisDaemon(daemonUrl: string): Promise<void> {
  if (!session) return;
  await switchDaemon(daemonUrl);
  session.daemonUrl = daemonUrl;
}

export function isXelisSessionActive(): boolean {
  return session !== null;
}

/**
 * The balance, or a throw.
 *
 * Never reports 0 for an unsynced wallet: `get_balance` answers 0 while
 * scanning and `has_balance` answers false, which is the same pair of answers a
 * genuinely empty wallet gives. The sync gate is what turns "0" back into a
 * fact. `useXelisSession` renders the throw as `balanceError` and leaves the
 * balance null.
 *
 * `hasLocked` is always false, and that is a property of the chain rather than
 * a default: XELIS holds ONE encrypted balance per asset and exposes no locked
 * or pending figure to separate out. There is no second number to compare
 * against, so there is nothing that could make it true.
 */
export async function getXelisBalanceDetailed(): Promise<XelisBalanceDetail> {
  if (!session) throw new Error("Xelis session not initialized.");

  const status = await getSyncStatus();
  if (!status.synced) {
    const tip = status.daemonTopoheight;
    throw new Error(
      status.online
        ? status.walletTopoheight == null
          ? "The Xelis wallet is still on its first scan, so its balance is not known yet."
          : `The Xelis wallet is still scanning (topoheight ${status.walletTopoheight}` +
            `${tip == null ? "" : ` of ${tip}`}), so its balance is not known yet.`
        : "The Xelis wallet is not connected to a node, so its balance is not known yet."
    );
  }

  const atomic = await getNativeBalanceAtomic();
  const amount = atomicToXelis(atomic);
  return { total: amount, unlocked: amount, hasLocked: false };
}

export async function getXelisSyncStatus(): Promise<XelisSyncStatus> {
  if (!session) throw new Error("Xelis session not initialized.");
  return getSyncStatus();
}

/**
 * Transaction history.
 *
 * Deliberately does NOT catch: a read that failed is not an empty history, and
 * `useXelisSession` distinguishes them (`txError` vs an empty list).
 */
export async function getXelisTransactionHistory(): Promise<XelisTransferEntry[]> {
  if (!session) throw new Error("Xelis session not initialized.");
  return listTransactions({ limit: 50 });
}

/**
 * Xelis transfers as the generic history rows Activity renders.
 *
 * One mapping for both paths: the adapter's `getTransactionHistory`, and
 * App.tsx, which since 2026-09-16 feeds Activity from the Xelis session's own
 * read instead of polling the wallet a second time through the adapter.
 */
export function xelisTransfersToChainTx(entries: readonly XelisTransferEntry[]): ChainTx[] {
  return entries.map((e) => ({
    chain: "xelis",
    hash: e.hash,
    // `other` covers the contract, multisig and blob variants. They move no
    // native XEL, so their amount is 0 — but the wallet paid a fee on the
    // ones it initiated, and that fee is what makes them outgoing.
    direction:
      e.kind === "incoming" || e.kind === "coinbase"
        ? "in"
        : e.kind === "other" && e.feeAtomic == null
          ? "in"
          : "out",
    amount: atomicToXelis(e.amountAtomic),
    ...(e.feeAtomic == null ? {} : { fee: atomicToXelis(e.feeAtomic) }),
    // `ChainTx.timestamp` is POSIX SECONDS; `XelisTransferEntry.timestamp` is
    // milliseconds. Converted, not passed through.
    ...(e.timestamp == null ? {} : { timestamp: Math.floor(e.timestamp / 1000) }),
    height: e.topoheight,
    ...(e.counterparty == null ? {} : { counterparty: e.counterparty }),
    meta: { kind: e.kind },
  }));
}

// =========================================================================
// Send quoting
// =========================================================================

/** Map a thrown RPC error onto a quote verdict the Send modal can act on. */
function classifyXelisSendError(e: unknown): SendQuoteError {
  if (e instanceof SendQuoteError) return e;
  if (isXelisBalanceNotFound(e)) {
    return new SendQuoteError(
      "insufficient-funds",
      "This wallet holds no XEL to send from."
    );
  }
  if (isXelisNotOnline(e)) {
    return new SendQuoteError(
      "not-ready",
      "The Xelis wallet is not connected to a node right now."
    );
  }
  const raw = e instanceof Error ? e.message : String(e);
  return new SendQuoteError("other", raw);
}

/** The sentence the Send modal shows under the fee, or undefined. */
function newAccountFeeNote(includes: boolean): string | undefined {
  if (!includes) return undefined;
  return (
    "Includes a one-off 0.001 XEL account-creation charge, because this address has " +
    "never been used on Xelis. Sending to it again later costs less."
  );
}

// =========================================================================
// ChainAdapter
// =========================================================================

export const xelisAdapter: ChainAdapter = {
  chain: "xelis",
  displayName: "Xelis",
  ticker: "XEL",
  color: "#02FFCF",
  addressPlaceholder: "xel:...",
  derivation: {
    kind: "independent-seed",
    note:
      "Xelis uses its own 25-word seed, not the wallet's BIP-39 phrase. Import or generate a Xelis seed to set this chain up.",
  },

  usesIndependentSeed: true,

  /**
   * The wallet builds and signs every transfer itself and derives the fee from
   * the transaction's size, its output count and the recipients' registration
   * state. Nothing here submits a fee, so a missing estimate must not gate Send
   * — see `networkComputesFee`'s own doc comment for the Monero incident that
   * flag exists to prevent.
   */
  networkComputesFee: true,

  async generateOwnSeed(): Promise<string> {
    return generateXelisSeed();
  },

  async deriveFromOwnSeed(seed: string): Promise<WalletInfo> {
    const normalized = normalizeXelisSeed(seed);
    if (!validateXelisSeed(normalized)) {
      throw new Error("Invalid Xelis seed phrase.");
    }
    return {
      chain: "xelis",
      address: xelisAddressFromSeed(normalized, xelisNetworkFromEnv()) ?? "",
      // Deliberately EMPTY, unlike `zanoAdapter`, which returns the seed here.
      // App code treats the first non-empty `mnemonic` in `walletsByChain` as
      // the vault's BIP-39 phrase, so a Xelis seed in this field would be shown
      // as "Mnemonic (all chains)" and fed to BIP-39 derivation. The seed lives
      // in its own vault entry; `features/xelis/xelisSeed.ts::xelisWalletInfo`
      // makes the same choice for the same reason.
      mnemonic: "",
      privateKey: "",
    };
  },

  importFromMnemonic(_mnemonic: string): WalletInfo {
    throw new Error("Xelis uses an independent seed, not a BIP39 phrase.");
  },
  deriveFromMnemonic(_mnemonic: string): WalletInfo {
    throw new Error("Xelis uses an independent seed. Use deriveFromOwnSeed().");
  },
  importFromPrivateKey(_seed: string): WalletInfo {
    throw new Error("Xelis import requires the seed phrase — use deriveFromOwnSeed().");
  },

  /** Throws until the wallet has synced — see `getXelisBalanceDetailed`. */
  async getBalance(_address: string): Promise<string> {
    const detail = await getXelisBalanceDetailed();
    return detail.total;
  },

  async sendTransaction(_seed: string, to: string, amount: string): Promise<TxResult> {
    if (!session) throw new Error("Xelis session not initialized.");
    const recipient = to.trim();
    if (!isXelisAddressShape(recipient, session.network)) {
      throw new Error(`That is not a valid Xelis ${session.network} address.`);
    }
    const result = await sendTransfer(recipient, xelisToAtomic(amount));
    return { hash: result.hash };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    if (!session) return { label: "Network", value: "Not connected", unit: "" };
    try {
      const status = await getSyncStatus();
      const scanned = status.walletTopoheight;
      if (status.synced && scanned != null) {
        return { label: "Topoheight", value: scanned.toLocaleString(), unit: "" };
      }
      const tip = status.daemonTopoheight;
      const at = scanned == null ? "first scan" : scanned.toLocaleString();
      return {
        label: "Syncing",
        value: tip == null ? at : `${at} / ${tip.toLocaleString()}`,
        unit: "",
      };
    } catch {
      return {
        label: "Network",
        value: session.network === "testnet" ? "Xelis testnet" : "Xelis mainnet",
        unit: "",
      };
    }
  },

  async getTransactionHistory(
    _address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    if (!session) return { items: [] };
    const limit = opts?.limit ?? 25;
    const entries = await listTransactions({ limit });
    return { items: xelisTransfersToChainTx(entries) };
  },

  /**
   * Informational only: the fee belongs to the transaction, not to a tier.
   * `SendModal` prices Xelis sends with `quoteSend` and never calls this, and
   * `networkComputesFee` stops a missing value here from gating Send.
   */
  async getFeeEstimate(): Promise<FeeEstimate> {
    return {
      normal: { value: "network-determined", label: "Normal" } as any,
      unit: "XEL",
      fetchedAt: Date.now(),
    };
  },

  /**
   * Price THIS send.
   *
   * Uses `estimate_fees`, NOT `build_transaction {broadcast:false}`. The latter
   * would give the exact fee of a really-built transaction, but the wallet
   * keeps a transaction cache (there is a `clear_tx_cache` method) and nothing
   * in the spike established whether an unbroadcast build reserves the nonce.
   * Pricing a send must not be able to wedge the next one, so the quote uses
   * the method whose only job is to answer the question.
   */
  async quoteSend({ to, amount, assetType }): Promise<SendQuote> {
    if (!session) {
      throw new SendQuoteError("not-ready", "The Xelis wallet is not open yet.");
    }
    const epoch = session.epoch;
    const recipient = to.trim();
    const priced = amount.trim();

    if (!isXelisAddressShape(recipient, session.network)) {
      throw new SendQuoteError(
        "invalid-address",
        `That is not a valid Xelis ${session.network} address.`
      );
    }

    // A wallet short of the tip can price a send against funds it has not
    // scanned yet, and offline it prices EVERY destination as new. Both make
    // the fee wrong in a way the user cannot see, so pricing waits for sync
    // exactly as reading the balance does.
    const status = await getSyncStatus();
    if (!status.synced) {
      throw new SendQuoteError(
        "not-ready",
        status.online
          ? "The Xelis wallet is still scanning the chain."
          : "The Xelis wallet is not connected to a node."
      );
    }

    let amountAtomic: bigint;
    try {
      amountAtomic = xelisToAtomic(priced);
    } catch (e) {
      throw new SendQuoteError("other", e instanceof Error ? e.message : String(e));
    }

    let estimate;
    try {
      estimate = await estimateTransferFee(recipient, amountAtomic);
    } catch (e) {
      throw classifyXelisSendError(e);
    }

    const balance = await getNativeBalanceAtomic().catch(() => null);
    if (balance != null && balance < amountAtomic + estimate.feeAtomic) {
      throw new SendQuoteError(
        "insufficient-funds",
        `This wallet holds ${atomicToXelis(balance)} XEL, and this send needs ` +
          `${atomicToXelis(amountAtomic + estimate.feeAtomic)} XEL including the fee.`
      );
    }

    const ticket: XelisQuoteTicket = {
      amountAtomic: amountAtomic.toString(),
      feeAtomic: estimate.feeAtomic.toString(),
      epoch,
    };

    const note = newAccountFeeNote(estimate.includesNewAccountFee);
    return {
      to: recipient,
      amount: priced,
      ...(assetType === undefined ? {} : { assetType }),
      fee: atomicToXelis(estimate.feeAtomic),
      feeTicker: "XEL",
      ...(note === undefined ? {} : { feeNote: note }),
      quotedAt: Date.now(),
      ticket,
    };
  },

  /**
   * Broadcast the send a quote priced.
   *
   * Unlike Zephyr's `sendQuoted`, this REBUILDS rather than relaying the quoted
   * transaction: XELIS's wallet RPC has no `relay_tx` equivalent, so a quote is
   * a price, not a signed blob waiting to be sent. (`build_transaction` can
   * return `tx_as_hex` for the DAEMON's `submit_transaction`, but that is a
   * daemon method this sidecar does not proxy, and routing a signed transfer
   * through a public node is a different trust decision than this change is
   * making.)
   *
   * The consequence is honest and small: the fee charged is the one computed at
   * broadcast, which can differ from the quoted one if the dynamic base fee
   * moved in between. That is the same property `networkComputesFee` already
   * declares for this adapter.
   */
  async sendQuoted(quote: SendQuote): Promise<TxResult> {
    if (!session) throw new Error("Xelis session not initialized.");
    const t = quote.ticket as Partial<XelisQuoteTicket> | null | undefined;
    const age = Date.now() - quote.quotedAt;
    if (!t || t.epoch !== session.epoch || age < 0 || age >= SEND_QUOTE_MAX_AGE_MS) {
      // A quote from an earlier wallet session, or one that aged out. Send it
      // as a fresh transfer rather than trusting a stale price.
      return xelisAdapter.sendTransaction("", quote.to, quote.amount);
    }
    return xelisAdapter.sendTransaction("", quote.to, quote.amount);
  },

  /**
   * What a send can draw on. Throws until synced, for the same reason
   * `getBalance` does — a Send modal that reads 0 while scanning would offer to
   * send nothing and call it a balance.
   */
  async getSendableBalance(_assetType?: string): Promise<SendableBalance> {
    const detail = await getXelisBalanceDetailed();
    return { unlocked: detail.unlocked, total: detail.total };
  },
};
