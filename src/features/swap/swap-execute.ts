/**
 * Cross-chain swap execution glue. Wires the SwapKit confirm modal to the
 * Rust signing core + chain RPC.
 *
 * Flow:
 *   1. `swap_build_tx` (proxy)         → returns the unsigned source-chain tx
 *   2. `swap_sign_evm` / `swap_sign_psbt` (Rust) → signed-tx hex
 *   3. `swap_broadcast` (Rust)         → direct chain RPC, returns tx hash
 *   4. `pollSwapKitToTerminal` (proxy) → /track every 10 s up to 30 min
 *
 * Solana / NEAR_INTENT / COSMOS / UTXO_BUILDER are explicitly rejected with
 * "Coming in v2" — the v1 Rust core can sign but final tx assembly for those
 * cross-chains is not finished.
 */

/**
 * Pre-broadcast guard for value-field sanity. Thrown when the constructed
 * source-chain tx would spend wildly more than the user's balance — a
 * defence-in-depth catch for the units-conversion bug class (see the
 * 2026-05-06 "5 sextillion ETH" post-mortem). When this fires, the
 * value field is wrong; refusing to broadcast even if the user has a
 * balance large enough to cover gas alone.
 */
export class InsufficientFundsValidationError extends Error {
  readonly name = "InsufficientFundsValidationError";
  readonly valueWei: bigint;
  readonly balanceWei: bigint;
  readonly gasCostWei: bigint;
  constructor(args: {
    message: string;
    valueWei: bigint;
    balanceWei: bigint;
    gasCostWei: bigint;
  }) {
    super(args.message);
    this.valueWei = args.valueWei;
    this.balanceWei = args.balanceWei;
    this.gasCostWei = args.gasCostWei;
    Object.setPrototypeOf(this, InsufficientFundsValidationError.prototype);
  }
}

/**
 * Parse an atomic-units string from a quote response into a BigInt.
 *
 * 1Click's `quote.amountIn` is documented as the atomic-units (wei /
 * lamports / yocto / sat) representation of what the user is sending.
 * For `EXACT_INPUT` swaps it MATCHES what we sent in the request body
 * (in atomic units, also as a string). The wallet must NOT re-convert
 * via `decimalToBaseUnits` — doing so produces value-field overflows
 * by a factor of 10^decimals (e.g. 0.005 ETH → 5 sextillion wei, the
 * 2026-05-06 P0 bug).
 *
 * Tolerates a fractional tail (1Click sometimes returns oddly-formatted
 * integers like `"5000000000000000.0000022936575480"`); the on-chain
 * value MUST be an integer wei so we truncate the fraction.
 */
export function atomicStringToBigInt(s: string): bigint {
  const trimmed = s.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid atomic-units string: ${s}`);
  }
  const [intPart] = trimmed.split(".");
  return BigInt(intPart || "0");
}
import {
  buildSwapKitTx,
  getIntentsStatus,
  notifyIntentsDeposit,
  trackSwapKitSwap,
} from "../../api/proxy";
import {
  broadcastEvmVerified,
  broadcastTx,
  signEvm,
  signPsbt,
} from "../../api/swap-rust";
import type {
  IntentsQuote,
  IntentsStatusResponse,
  SwapKitRoute,
  SwapKitSwapResponse,
  SwapKitTrackResponse,
  SwapKitTrackStatus,
} from "../../lib/proxy-types";
import {
  SWAP_COIN_META,
  broadcastChainKind,
  getSwapCoinMeta,
  tickerToChain,
  type SwapChainKind,
  type SwapCoinMeta,
} from "./swap-data";
import {
  effectiveModeForSource,
  isMockSwapKitResponse,
} from "./router-modes";
// TYPE-ONLY on purpose. `sourceSecretFor` and `SourceSecret` live in
// `asset-capabilities.ts` and callers import them from there directly: a
// runtime `export ... from` here would pull the registry into this module's
// graph, and registry entries evaluate their RPC lists at module load. Three
// executor tests mock `./swap-data` precisely so the registry never loads, and
// a value re-export defeats that mock from a direction the mock cannot see.
import type { SourceSecret } from "./asset-capabilities";
import {
  accountSendAvailable,
  executeAccountUtxoTransfer,
  executeAdapterTransfer,
  executeCardanoTransfer,
  executeNearNativeTransfer,
  executeSolanaTransfer,
  executeSplTransfer,
  executeUtxoTransfer,
} from "./swap-sources";
import { getNearAddress, getSolanaAddress, getUtxoAddress } from "../../api/swap-rust";
import { jsonRpcCall } from "../../wallets/chain-rpcs";
import {
  SafetyInvariantError,
  assertEvmDepositShape,
  assertQuoteAmountMatchesUserIntent,
  assertSignedTxValueMatches,
  assertSourceMetaMatchesCatalog,
  assertTxFundable,
  assertTxNotPlausibleOverspend,
  assertTxValueMatchesQuote,
  assertVerifiedHashMatches,
  decodeEvmSignedTx,
  logSafetyIncident,
} from "./safety-invariants";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  isSendOutcomeUnknown,
  SendOutcomeUnknownError,
} from "../../wallets/send-outcome";
import { stablecoinNetworkFor } from "../../wallets/stablecoins";
import type { ChainType } from "../../wallets/types";
import { lookupByAssetId } from "./intents-dedup";
import { claimIntentsDeposit, recordIntentsDeposit } from "./intents-attempts";
import {
  assertDepositWindowOpen,
  assertQuoteBinding,
  echoMismatches,
  type IntentsQuoteRequestEcho,
} from "./intents-quote-binding";
import {
  buildErc20BalanceOfCalldata,
  buildErc20TransferCalldata,
  parseErc20TransferCalldata,
} from "./erc20-calldata";
import {
  errorText,
  evmBroadcastRefusedEverywhere,
  withTimeout,
} from "./broadcast-outcome";

// Re-export so consumers (UI banner, tests) can `instanceof` against it
// from the same module they already import the executor from.
export { SafetyInvariantError } from "./safety-invariants";

/**
 * Hard-stop error thrown by the SwapKit broadcast guard when the active
 * routing mode is mock (env-flagged or UUID-detected). Carries the
 * already-signed tx hex so the modal can render it for inspection — the
 * sign path is provably correct, only the chain interaction is blocked.
 *
 * Catch this specifically: it is not a failure, it's the safety contract
 * working as designed.
 */
export class MockSwapAttemptedError extends Error {
  readonly name = "MockSwapAttemptedError";
  readonly signedTxHex: string;
  readonly destinationAddress: string;
  readonly chainKind: string;
  readonly reason: "ENV_FLAG_MOCK" | "MOCK_UUID_DETECTED";

  constructor(args: {
    message: string;
    signedTxHex: string;
    destinationAddress: string;
    chainKind: string;
    reason: "ENV_FLAG_MOCK" | "MOCK_UUID_DETECTED";
  }) {
    super(args.message);
    this.signedTxHex = args.signedTxHex;
    this.destinationAddress = args.destinationAddress;
    this.chainKind = args.chainKind;
    this.reason = args.reason;
    // Required so `instanceof MockSwapAttemptedError` works after
    // transpile-down to ES5-style class extension.
    Object.setPrototypeOf(this, MockSwapAttemptedError.prototype);
  }
}

const MOCK_GUARD_MESSAGE =
  "Mock routing is enabled — broadcast is blocked by design. " +
  "No transaction will be sent to chain. " +
  "Switch routing to NEAR or wait for live SwapKit upstream.";

export type SwapExecutionPhase =
  | "idle"
  | "building"
  | "signing"
  // "broadcasting" covers both submit + on-chain verification — Rust
  // does both atomically via `broadcastEvmVerified` so the JS layer
  // sees a single phase. We never advance to "pending" until the
  // verification step has confirmed the tx exists on a node's pool.
  | "broadcasting"
  | "pending" // verified by network, waiting for solver-relay finalize
  | "done"
  | "error";

export interface SwapExecutionStatus {
  phase: SwapExecutionPhase;
  /** Source-chain tx hash once broadcast has succeeded. */
  sourceTxHash?: string;
  /** Destination-chain tx hash once status polling reveals it. */
  destTxHash?: string;
  /** Live status from `/track`, lower-cased per the live SwapKit docs. */
  trackStatus?: SwapKitTrackStatus;
  /** Latest /track response — for diagnostics. */
  rawTrack?: SwapKitTrackResponse;
  /** Human-readable error string when `phase === 'error'`. */
  error?: string;
}

export interface ExecuteSwapInput {
  /** Active swap session token from `unlockSwap`. */
  sessionId: string;
  /** Source asset ticker (e.g. "ETH"). Looked up in `SWAP_COIN_META`. */
  fromAsset: string;
  /** SwapKit route returned by the quote step. */
  route: SwapKitRoute;
  /** User's source-chain address (already known from unlocked session). */
  sourceAddress: string;
  /** User's destination-chain address. */
  destinationAddress: string;
  /** Override the broadcast RPC URL (defaults to the SWAP_COIN_META entry). */
  rpcUrlOverride?: string;
  /** Account/index for derivation (defaults to 0/0). */
  account?: number;
  index?: number;
  /** Phase callback so the modal can render Building → Signing → … as we go. */
  onPhase?: (s: SwapExecutionStatus) => void;
}

/**
 * Build → sign → broadcast a SwapKit route. Throws on any failure step.
 * On success, returns `{ sourceTxHash, builtTx }` and leaves status polling
 * to the caller (which usually wants to keep its modal open).
 *
 * **Mock-mode hard-stop.** If `effectiveModeForSource('swapkit', route)`
 * resolves to `isLive === false` (env-flag mock OR mock-UUID detected),
 * this function:
 *   1. still runs the sign step so the user gets confirmation that the
 *      signing path is correct, and
 *   2. then throws [`MockSwapAttemptedError`] *before* any chain-RPC call,
 *      carrying the signed-tx hex + destination address for inspection.
 *
 * Callers (the confirm modal in particular) MUST catch the typed error
 * and render an info-toned mock-stop view rather than treating it as a
 * failure — the safety contract is working as designed.
 *
 * This function does NOT poll status. Callers should follow up with
 * `pollSwapKitToTerminal` if they want a terminal status update.
 */
export async function executeSwapKitTrade(input: ExecuteSwapInput): Promise<{
  sourceTxHash: string;
  built: SwapKitSwapResponse;
}> {
  const phase = (s: SwapExecutionStatus) => input.onPhase?.(s);
  const fromMeta = SWAP_COIN_META[input.fromAsset.toUpperCase()];
  if (!fromMeta) {
    throw new Error(`Unknown source asset ${input.fromAsset}`);
  }

  // Resolve the routing mode upfront so the test surface is deterministic
  // and the guard is one boolean check away from the broadcast call.
  const routerMode = effectiveModeForSource("swapkit", input.route);
  const mockReason: "ENV_FLAG_MOCK" | "MOCK_UUID_DETECTED" =
    isMockSwapKitResponse(input.route) ? "MOCK_UUID_DETECTED" : "ENV_FLAG_MOCK";

  phase({ phase: "building" });
  const built = await buildSwapKitTx({
    routeId: input.route.routeId,
    sourceAddress: input.sourceAddress,
    destinationAddress: input.destinationAddress,
  });

  const txType = built.meta?.txType;

  // Run the sign step. Each branch returns the bundle the broadcast call
  // would consume; the broadcast itself is gated behind the mock check.
  let signedTxHex: string;
  let destinationAddress: string;
  let chainKind: SwapChainKind;

  switch (txType) {
    case "EVM": {
      if (!built.transaction) {
        throw new Error("EVM route returned no transaction object");
      }
      phase({ phase: "signing" });
      const signed = await signEvm(
        input.sessionId,
        built.transaction,
        input.account ?? 0,
        input.index ?? 0
      );
      signedTxHex = signed.rawTx;
      destinationAddress = built.transaction.to;
      chainKind = fromMeta.chainKind;
      break;
    }
    case "PSBT": {
      if (!built.tx) {
        throw new Error("PSBT route returned no tx hex");
      }
      phase({ phase: "signing" });
      const signed = await signPsbt(input.sessionId, built.tx);
      signedTxHex = signed.rawTx;
      // PSBT outputs are inside the binary; surface the user-known
      // destination from the swap request for the UI's warning badge.
      destinationAddress = input.destinationAddress;
      chainKind = fromMeta.chainKind;
      break;
    }
    case "SOLANA":
    case "NEAR_INTENT":
    case "COSMOS":
    case "UTXO_BUILDER":
      throw new Error(`${txType} swaps are coming in v2.`);
    default:
      throw new Error(`Unrecognized txType ${txType ?? "(missing)"} from SwapKit`);
  }

  // ─── HARD-STOP ────────────────────────────────────────────────────
  // Defence in depth: the UI labels mock mode in three places, but if the
  // user clicks through anyway, this is the *code-level* refusal to
  // produce a broadcast. The signed payload is kept in the thrown error
  // so the modal can render it for inspection.
  if (!routerMode.isLive) {
    throw new MockSwapAttemptedError({
      message: MOCK_GUARD_MESSAGE,
      signedTxHex,
      destinationAddress,
      chainKind: broadcastChainKind(chainKind),
      reason: mockReason,
    });
  }

  phase({ phase: "broadcasting" });
  // EVM goes through the verified-broadcast path (P0 fix 2026-05-06 —
  // see executeIntentsTrade EVM branch for the rationale). Non-EVM
  // chains fall through to the single-URL legacy broadcaster because
  // (a) PSBT chains don't have an `eth_getTransactionByHash`-shaped
  // verification primitive yet and (b) those paths don't share rate-
  // limit pressure with the EVM webview polling.
  let sourceTxHash: string;
  if (chainKind === "EVM") {
    const meta = SWAP_COIN_META[input.fromAsset.toUpperCase()];
    const rpcUrls =
      input.rpcUrlOverride
        ? [input.rpcUrlOverride]
        : meta?.rpcFallbacks && meta.rpcFallbacks.length > 0
          ? meta.rpcFallbacks
          : [resolveRpcUrl(input, chainKind)];
    const r = await broadcastEvmVerified(rpcUrls, signedTxHex);
    sourceTxHash = r.txHash;
  } else {
    const rpcUrl = resolveRpcUrl(input, chainKind);
    sourceTxHash = await broadcastTx(
      broadcastChainKind(chainKind),
      rpcUrl,
      signedTxHex
    );
  }
  phase({ phase: "pending", sourceTxHash });
  return { sourceTxHash, built };
}

/**
 * Wrap a synchronous safety-invariant assertion with best-effort
 * telemetry logging. If the assertion throws a `SafetyInvariantError`,
 * we fire-and-forget a `swap_log_safety_incident` call (writes JSONL
 * to %LOCALAPPDATA%) and re-throw. Other error classes pass through
 * unchanged — they're not invariant violations.
 *
 * The session context describes the swap stage at which the invariant
 * fired (post-quote / pre-sign / post-build / post-sign / post-broadcast)
 * plus the ticker + deposit address — useful diagnostic ground without
 * leaking key material.
 */
async function runInvariant<T>(
  fn: () => T,
  sessionContext: Record<string, string>
): Promise<T> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SafetyInvariantError) {
      // Fire-and-forget — never block the throw on telemetry I/O.
      void logSafetyIncident(e, sessionContext);
    }
    throw e;
  }
}

function resolveRpcUrl(
  input: ExecuteSwapInput,
  chainKind: SwapChainKind
): string {
  if (input.rpcUrlOverride) return input.rpcUrlOverride;
  const meta = SWAP_COIN_META[input.fromAsset.toUpperCase()];
  if (meta?.defaultRpcUrl) return meta.defaultRpcUrl;
  throw new Error(`No RPC URL configured for ${chainKind}`);
}

/* ─── status polling ───────────────────────────────────────────── */

const TERMINAL: ReadonlySet<SwapKitTrackStatus> = new Set([
  "completed",
  "refunded",
  "failed",
] as const);

/**
 * Poll `/api/swapkit/track` every `intervalMs` (default 10 s) up to
 * `timeoutMs` (default 30 min) for a terminal status. Calls `onUpdate` on
 * every tick so the modal can refresh.
 */
export async function pollSwapKitToTerminal(args: {
  hash: string;
  /** Source-chain id passed to /track (numeric for EVM, omitted for UTXO). */
  chainId?: string;
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (s: SwapKitTrackResponse) => void;
}): Promise<SwapKitTrackResponse> {
  const interval = args.intervalMs ?? 10_000;
  const timeout = args.timeoutMs ?? 30 * 60_000;
  const start = Date.now();
  // First-poll without delay so the modal updates immediately.
  while (true) {
    if (Date.now() - start > timeout) {
      throw new Error("Swap track polling timed out");
    }
    let resp: SwapKitTrackResponse;
    try {
      resp = await trackSwapKitSwap({ hash: args.hash, chainId: args.chainId });
    } catch (e) {
      // Network blip — wait and retry rather than aborting.
      await sleep(interval);
      continue;
    }
    args.onUpdate?.(resp);
    if (resp.status && TERMINAL.has(resp.status)) {
      return resp;
    }
    await sleep(interval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Map a SwapKit /track status to our local history-store status enum. */
export function trackToHistoryStatus(
  s: SwapKitTrackStatus | undefined
): "pending" | "success" | "refunded" | "failed" {
  if (s === "completed") return "success";
  if (s === "refunded") return "refunded";
  if (s === "failed") return "failed";
  return "pending";
}

/* ─── NEAR Intents execution ─────────────────────────────────────── */

export interface ExecuteIntentsInput {
  /** Active swap session token from `unlockSwap`. */
  sessionId: string;
  /** Source asset ticker (e.g. "ETH"). Looked up in `SWAP_COIN_META` or
   *  resolved via `getSwapCoinMeta(symbol, fromBlockchain)` when the user
   *  picked a multi-chain symbol. */
  fromAsset: string;
  /** NEAR Intents quote — `depositAddress` + `amountIn` are required. */
  intentsQuote: IntentsQuote;
  /** User's source-chain address. */
  sourceAddress: string;
  /**
   * What the user *intended* to send, in atomic units of the source
   * asset (e.g. wei for ETH, lamports for SOL). The caller MUST compute
   * this from the form input via `decimalToBaseUnitsBigInt(displayAmount,
   * fromMeta.decimals)` BEFORE invoking — that's the pre-quote shape we
   * sent to 1Click, and the post-quote `quote.amountIn` must match it
   * within ±1%. Required so the SAFETY-INVARIANT layer can detect a
   * malicious / buggy quote whose `amountIn` differs from the user's
   * intent. See `safety-invariants.ts::assertQuoteAmountMatchesUserIntent`.
   */
  userIntendedAtomic: bigint;
  /**
   * Source blockchain when `fromAsset` is a multi-chain symbol (USDC on
   * Base, ETH on Arbitrum, etc.). When set, executeIntentsTrade resolves
   * the right RPC URLs + EVM chain id via `getSwapCoinMeta(fromAsset,
   * fromBlockchain)` — the static SWAP_COIN_META[fromAsset] would
   * otherwise route the source tx to the canonical chain (Ethereum L1
   * for ETH, etc.), which is wrong when the user is sending USDC from Base.
   * Omit for single-chain symbols (BTC, NEAR).
   */
  fromBlockchain?: import("./near-intents-assets.generated").IntentsBlockchain;
  /** Override broadcast/RPC URL (defaults to `SWAP_COIN_META[from].defaultRpcUrl`). */
  rpcUrlOverride?: string;
  /** BIP-44 account/index for derivation (defaults to 0/0). */
  account?: number;
  index?: number;
  /**
   * The secret for a TS-SIGNED source chain, tagged with what kind it is.
   *
   * Most source chains sign inside the Rust swap session and need nothing
   * here. These do not:
   *
   *   - ADA rebuilds its whole key set from the vault's BIP-39 mnemonic
   *     (`{ kind: "mnemonic" }`), because Cardano's Icarus derivation needs
   *     the seed, not a single key.
   *   - BTC, LTC, DOGE, BCH and DASH (2026-09-29, F10) deposit from the whole
   *     account through the adapter, which derives every address it spends
   *     from — also `{ kind: "mnemonic" }`.
   *   - XRP and Tron sign with one chain private key
   *     (`{ kind: "privateKey" }`), which is what their adapters take.
   *
   * Same security posture as the mnemonic it replaces: held in memory for the
   * duration of the call, never logged, never persisted.
   */
  sourceSecret?: SourceSecret;
  /**
   * The request this quote answered — what 1Click minted the deposit address
   * for (2026-09-29 send-safety audit, F3). Compared with the asset, amount
   * and addresses about to be signed; any difference refuses before signing.
   */
  quoteRequest: IntentsQuoteRequestEcho;
  /** 1Click's own echo of the request (`quoteRequest` in its response), when
   *  the relay passes it through. Compared with `quoteRequest` (F3). */
  quoteEcho?: Partial<IntentsQuoteRequestEcho> | null;
  /** The destination asset id and address the confirm screen shows (F3). */
  destinationAsset: string;
  destinationAddress: string;
  /**
   * Called as soon as the deposit has a hash — BEFORE the 1Click notify —
   * so the caller can persist the swap before anything else can fail
   * (F2). Errors it throws are logged, never propagated: the money has moved.
   */
  onBroadcast?: (r: IntentsBroadcastInfo) => void | Promise<void>;
  onPhase?: (s: SwapExecutionStatus) => void;
  /** Clock, for tests (F4). */
  nowMs?: () => number;
}

export interface IntentsBroadcastInfo {
  sourceTxHash: string;
  depositAddress: string;
  /** The network accepted it; the wallet has not seen it confirmed. */
  pending: boolean;
}

/**
 * Source chain kinds whose deposit can be a TOKEN transfer. For every other
 * kind the executor only knows how to move the native coin, so a catalog
 * asset with a contract on one of them is refused (F1).
 */
const TOKEN_DEPOSIT_KINDS: ReadonlySet<SwapChainKind> = new Set<SwapChainKind>([
  "EVM",
  "SOLANA",
  "TRON",
]);

/**
 * Execute a NEAR Intents quote: build → sign → broadcast a source-chain
 * deposit to `intentsQuote.depositAddress`, then notify 1Click and let
 * the solver-relay perform the cross-chain settlement.
 *
 * Source-chain coverage:
 *   - EVM (ETH / AVAX / POL / MON / BNB, and the stablecoin legs): inline
 *     below — gas estimate, balance gates, `swap_sign_evm`, verified
 *     broadcast. Native coin or ERC-20 `transfer` per the 1Click catalog.
 *   - SOL: `executeSolanaTransfer`; SPL legs: `executeSplTransfer`.
 *   - NEAR: `executeNearNativeTransfer`.
 *   - BTC / LTC / DOGE / BCH / DASH: `executeAccountUtxoTransfer` — the
 *     adapter's account-wide send (F10). The single-address Rust PSBT path
 *     (`executeUtxoTransfer`) is the fallback for BTC/LTC/DOGE/BCH when the
 *     adapter's account scan does not cover the wallet.
 *   - ADA: `executeCardanoTransfer` (TS-signed).
 *   - XRP / TRX / USDT-TRON: `executeAdapterTransfer` (TS-signed).
 *
 * Before anything is built (2026-09-29 send-safety audit):
 *   - F1: the source asset is checked against the 1Click catalog entry the
 *     quote names — native or token, which contract, which decimals;
 *   - F3: the quote must have been made for THIS asset, amount, recipient
 *     and refund address;
 *   - F4: its deposit window must leave the origin chain time to land;
 *   - F2: the deposit address is claimed, and a second attempt for it is
 *     refused — one quote, one signature.
 *
 * After the broadcast: `onBroadcast` first, then a best-effort notify that
 * can no longer fail the call (F2). A broadcast whose outcome is unknown
 * throws `SendOutcomeUnknownError` with the hash.
 */
export async function executeIntentsTrade(
  input: ExecuteIntentsInput
): Promise<{ sourceTxHash: string; depositAddress: string; pending: boolean }> {
  const phase = (s: SwapExecutionStatus) => input.onPhase?.(s);
  const now = input.nowMs ?? (() => Date.now());
  // Effective source-chain metadata — when `fromBlockchain` is set, we
  // route through `getSwapCoinMeta(symbol, blockchain)` for synthetic
  // per-(symbol, blockchain) routing (USDC on Base, ETH on Arbitrum).
  // Without it, the canonical static SWAP_COIN_META entry is the
  // answer, which is the v1 path every existing call site uses.
  const fromMeta = input.fromBlockchain
    ? (getSwapCoinMeta(input.fromAsset, input.fromBlockchain) ??
       SWAP_COIN_META[input.fromAsset.toUpperCase()])
    : SWAP_COIN_META[input.fromAsset.toUpperCase()];
  if (!fromMeta) {
    throw new Error(`Unknown source asset ${input.fromAsset}`);
  }

  const { depositAddress, amountIn } = input.intentsQuote;
  if (!depositAddress) {
    throw new Error("NEAR Intents quote missing depositAddress");
  }
  if (!amountIn) {
    throw new Error("NEAR Intents quote missing amountIn");
  }
  const ctx = (stage: string) => ({ stage, ticker: fromMeta.ticker, depositAddress });

  // ─── F1 ─ the asset, per the 1Click catalog ───────────────────────
  // The contract (or its absence) the deposit must carry comes from the
  // CATALOG, and the registry must agree with it. Until 2026-09-29 the
  // registry had no contract for any stablecoin leg, and every check below
  // compared the built tx with that same registry — so 100 USDC-BSC was
  // built, checked and signed as a 100 BNB transfer.
  const { contract: catalogContract } = await runInvariant(
    () =>
      assertSourceMetaMatchesCatalog({
        ticker: fromMeta.ticker,
        nearIntentsAsset: fromMeta.nearIntentsAsset,
        decimals: fromMeta.decimals,
        tokenContract: fromMeta.tokenContract,
        catalogAsset: fromMeta.nearIntentsAsset
          ? lookupByAssetId(fromMeta.nearIntentsAsset)
          : null,
      }),
    ctx("pre-build"),
  );
  if (catalogContract && !TOKEN_DEPOSIT_KINDS.has(fromMeta.chainKind)) {
    await runInvariant(() => {
      throw new SafetyInvariantError({
        invariant: "SOURCE_ASSET_CATALOG_MISMATCH",
        message:
          `${fromMeta.ticker} is a token (${catalogContract}) on a ${fromMeta.chainKind} ` +
          `chain, and the wallet can only deposit that chain's native coin. Refusing to build it.`,
        context: { ticker: fromMeta.ticker, chainKind: fromMeta.chainKind, catalogContract },
      });
    }, ctx("pre-build"));
  }

  // ─── F3 ─ the quote answers THIS swap ─────────────────────────────
  assertQuoteBinding(input.quoteRequest, {
    originAsset: fromMeta.nearIntentsAsset,
    destinationAsset: input.destinationAsset,
    amountAtomic: input.userIntendedAtomic,
    recipient: input.destinationAddress,
    refundTo: input.sourceAddress,
  });
  const echoDiff = echoMismatches(input.quoteRequest, input.quoteEcho);
  if (echoDiff.length > 0) {
    await runInvariant(() => {
      throw new SafetyInvariantError({
        invariant: "QUOTE_ECHO_MISMATCH",
        message:
          `1Click says this quote answers a different request than the one the wallet ` +
          `sent (${echoDiff.join("; ")}). Refusing to sign.`,
        context: { ticker: fromMeta.ticker, differences: echoDiff.join(" | ") },
      });
    }, ctx("post-quote"));
  }

  // ─── F4 ─ the deposit window is still open for this chain ────────
  assertDepositWindowOpen({
    deadline: input.intentsQuote.deadline ?? input.quoteRequest.deadline,
    chainKind: fromMeta.chainKind,
    nowMs: now(),
    ticker: fromMeta.ticker,
  });

  // ─── INVARIANT #1 ─ post-quote, pre-build ─────────────────────────
  // `quote.amountIn` is what 1Click told us we'll spend. It must match
  // the user-intended atomic amount within ±1% — anything more is either
  // a quote-side bug, a malicious server, or a units-conversion bug
  // upstream. Run the assertion before any signing so a bad quote can
  // never escalate to a broadcast.
  const quoteAmountAtomic = atomicStringToBigInt(amountIn);
  await runInvariant(
    () =>
      assertQuoteAmountMatchesUserIntent({
        quoteAmountAtomic,
        userIntendedAtomic: input.userIntendedAtomic,
        ticker: fromMeta.ticker,
        decimals: fromMeta.decimals,
      }),
    ctx("post-quote"),
  );

  // ─── F2 ─ one quote, one signature ────────────────────────────────
  // Claimed synchronously, after every check that can refuse the quote and
  // before anything is built: two overlapping submits cannot both pass, and
  // a Retry, a re-opened modal or a second click on the same quote is
  // refused here instead of signing a second deposit to the same address.
  claimIntentsDeposit(depositAddress, now());

  phase({ phase: "building" });

  let sourceTxHash: string;
  let pending = false;
  try {
    switch (fromMeta.chainKind) {
      case "EVM": {
        sourceTxHash = await depositEvm({
          input,
          fromMeta,
          depositAddress,
          quoteAmountAtomic,
          contract: catalogContract,
          phase,
          ctx,
        });
        break;
      }

      case "SOLANA": {
        const rpcUrl = input.rpcUrlOverride ?? fromMeta.defaultRpcUrl;
        if (!rpcUrl) throw new Error(`No RPC URL configured for ${input.fromAsset}`);
        // Source address must come from our derivation, not be passed in,
        // because the form may pre-fill `sourceAddress` from a non-SOL
        // wallet adapter when SOL has no first-party adapter.
        const fromAddress =
          input.sourceAddress && input.sourceAddress.length > 0
            ? input.sourceAddress
            : await getSolanaAddress(input.sessionId);
        phase({ phase: "signing" });
        // Token or native per the CATALOG (F1). The mint is the catalog's,
        // which `assertSourceMetaMatchesCatalog` has checked is the wallet's.
        const r = catalogContract
          ? await executeSplTransfer({
              sessionId: input.sessionId,
              fromAddress,
              depositAddress,
              mint: catalogContract,
              amountAtomic: amountIn,
              rpcUrl,
            })
          : await executeSolanaTransfer({
              sessionId: input.sessionId,
              fromAddress,
              depositAddress,
              amountAtomic: amountIn,
              rpcUrl,
            });
        phase({ phase: "broadcasting" });
        sourceTxHash = r.txHash;
        break;
      }

      case "NEAR": {
        const rpcUrl = input.rpcUrlOverride ?? fromMeta.defaultRpcUrl;
        if (!rpcUrl) throw new Error(`No RPC URL configured for ${input.fromAsset}`);
        const near = await getNearAddress(input.sessionId);
        phase({ phase: "signing" });
        // amountIn = yoctoNEAR (atomic) per 1Click's response shape.
        const r = await executeNearNativeTransfer({
          sessionId: input.sessionId,
          fromAccountId:
            input.sourceAddress && input.sourceAddress.length > 0
              ? input.sourceAddress
              : near.accountId,
          fromPublicKey: near.publicKey,
          depositAddress,
          amountAtomic: amountIn,
          rpcUrl,
        });
        phase({ phase: "broadcasting" });
        sourceTxHash = r.txHash;
        break;
      }

      case "BTC":
      case "LTC":
      case "DOGE":
      case "BCH":
      case "DASH": {
        // ACCOUNT-WIDE first (2026-09-29, F10) — the same send the wallet's
        // Send button makes. The single-address Rust path read only the
        // primary address, which a UTXO wallet empties on its first spend:
        // the operator's LTC swap failed with "No UTXOs found at ltc1qty7…"
        // over a wallet showing 4.03 LTC.
        const chainKey =
          fromMeta.walletsByChainKey ?? (tickerToChain(input.fromAsset) as ChainType | null);
        const mnemonic =
          input.sourceSecret?.kind === "mnemonic" ? input.sourceSecret.value : undefined;
        if (
          fromMeta.tsSourceSigner === "utxo-account" &&
          chainKey &&
          (await accountSendAvailable({
            chainKey,
            mnemonic,
            fromAddress: input.sourceAddress,
          }))
        ) {
          phase({ phase: "signing" });
          const r = await executeAccountUtxoTransfer({
            chainKey,
            mnemonic: mnemonic!,
            fromAddress: input.sourceAddress,
            depositAddress,
            amountAtomic: amountIn,
            decimals: fromMeta.decimals,
            ticker: fromMeta.ticker,
          });
          phase({ phase: "broadcasting" });
          sourceTxHash = r.txHash;
          pending = r.pending === true;
          break;
        }
        // Fallback: the pre-F10 single-address path, ONLY when account send is
        // unavailable — never after it was tried (a failed account send must
        // not become a second attempt through another path).
        if (fromMeta.chainKind === "DASH") {
          throw new Error(
            `DASH swaps deposit from the whole wallet account, and this wallet's ` +
              `DASH address is not on the account the wallet can spend from ` +
              `(or its recovery phrase is not loaded). Nothing was sent.`,
          );
        }
        const rpcUrl = input.rpcUrlOverride ?? fromMeta.defaultRpcUrl;
        if (!rpcUrl) throw new Error(`No RPC URL configured for ${input.fromAsset}`);
        const chainMap: Record<string, "btc" | "ltc" | "doge" | "bch"> = {
          BTC: "btc",
          LTC: "ltc",
          DOGE: "doge",
          BCH: "bch",
        };
        const chain = chainMap[fromMeta.chainKind];
        const fromAddress =
          input.sourceAddress && input.sourceAddress.length > 0
            ? input.sourceAddress
            : await getUtxoAddress(input.sessionId, chain);
        phase({ phase: "signing" });
        // amountIn = atomic units (satoshi-equivalent: 1e8 atomic per coin
        // for BTC/LTC/DOGE/BCH) per 1Click's response shape.
        const r = await executeUtxoTransfer({
          sessionId: input.sessionId,
          chain,
          fromAddress,
          depositAddress,
          amountAtomic: amountIn,
          rpcUrl,
        });
        phase({ phase: "broadcasting" });
        sourceTxHash = r.txHash;
        break;
      }

      case "STELLAR":
      case "SUI":
        // No executor branch (F7). `isIntentsRoutableFromRegistry` no longer
        // quotes these as sources; this is the backstop.
        throw new Error(
          `${fromMeta.ticker} cannot be a NEAR Intents source in this build — ` +
            `the wallet has no deposit path for it. Nothing was sent.`,
        );

      case "CARDANO": {
        // ADA source — signed in the TS Cardano stack, NOT the Rust core.
        // See executeCardanoTransfer for the rationale. The mnemonic is
        // threaded in from walletsByChain.cardano (same as ADA Send); the
        // Rust swap session isn't used for this chain.
        if (input.sourceSecret?.kind !== "mnemonic" || !input.sourceSecret.value) {
          throw new Error(
            "ADA source swap requires the Cardano mnemonic. Open the Cardano " +
              "chain in the dashboard so the wallet is derived, then retry."
          );
        }
        phase({ phase: "signing" });
        // amountIn = lovelace (6dp atomic) per 1Click's response shape.
        const r = await executeCardanoTransfer({
          mnemonic: input.sourceSecret.value,
          fromAddress: input.sourceAddress,
          depositAddress,
          amountAtomic: amountIn,
        });
        phase({ phase: "broadcasting" });
        sourceTxHash = r.txHash;
        break;
      }

      case "XRP":
      case "TRON": {
        // XRP, native TRX and TRC-20 USDT — TS-signed sources (2026-09-09).
        // All three go through the wallet's own chain adapter, which is the
        // same call the dashboard Send button makes, so a swap deposit and a
        // manual send cannot drift apart. No RPC URL: these adapters reach
        // their networks themselves, which is why the generic "No RPC URL"
        // refusal that used to sit above this switch stopped XRP, TRX and
        // USDT-TRON before signing on every attempt (F6, 2026-09-29).
        //
        // `walletsByChainKey` is what picks the adapter, and it is the ONLY
        // thing separating native TRX from TRC-20 USDT: same chainKind, same
        // key, same signature, different transaction builder. Branching on
        // chainKind alone would send USDT as if it were TRX.
        if (
          input.sourceSecret?.kind !== "privateKey" ||
          !input.sourceSecret.value
        ) {
          throw new Error(
            `${fromMeta.ticker} source swap requires the ${fromMeta.ticker} ` +
              `private key. Open the ${fromMeta.ticker} chain in the dashboard ` +
              `so the wallet is derived, then retry.`
          );
        }
        const chainKey =
          fromMeta.walletsByChainKey ?? (tickerToChain(input.fromAsset) as ChainType | null);
        if (!chainKey) {
          throw new Error(
            `${input.fromAsset} has no wallet chain key, so the swap cannot ` +
              `pick a signer for it. This is a registry bug — please report it.`
          );
        }
        // F1 for the adapter-built chains: the adapter chosen must be the
        // token adapter for exactly the catalog's contract, or a native one.
        const leg = stablecoinNetworkFor(chainKey);
        if (catalogContract ? leg?.contract !== catalogContract : !!leg) {
          await runInvariant(() => {
            throw new SafetyInvariantError({
              invariant: "SOURCE_ASSET_CATALOG_MISMATCH",
              message:
                `${fromMeta.ticker}: the ${chainKey} wallet sends ` +
                `${leg ? `token ${leg.contract}` : "the native coin"}, but 1Click lists ` +
                `${catalogContract ? `token ${catalogContract}` : "the native coin"}. ` +
                `Refusing to build the deposit.`,
              context: {
                ticker: fromMeta.ticker,
                chainKey,
                walletContract: leg?.contract ?? "(native)",
                catalogContract: catalogContract ?? "(native)",
              },
            });
          }, ctx("pre-build"));
        }
        phase({ phase: "signing" });
        // amountIn is ATOMIC (drops / sun). executeAdapterTransfer converts to
        // the display units every adapter takes, with exact string math.
        const r = await executeAdapterTransfer({
          chainKey,
          privateKey: input.sourceSecret.value,
          depositAddress,
          amountAtomic: amountIn,
          decimals: fromMeta.decimals,
          ticker: fromMeta.ticker,
        });
        phase({ phase: "broadcasting" });
        sourceTxHash = r.txHash;
        pending = r.pending === true;
        break;
      }

      case "XMR":
      case "ZEPH":
      case "ZANO":
        // XMR routes through the atomic-swap modal; ZEPH through the Zephyr
        // ecosystem card; ZANO has no swap route at all yet (no atomicDesk,
        // no SwapKit/Intents entry — see asset-capabilities.ts). None of the
        // three is a NEAR Intents source. The exhaustive-switch guard matters
        // for type-soundness: without this branch, TS can't prove
        // `sourceTxHash` is always assigned post-switch.
        throw new Error(
          `${fromMeta.ticker} cannot be a NEAR Intents source — out of scope.`
        );
    }
  } catch (e) {
    if (isSendOutcomeUnknown(e)) {
      recordIntentsDeposit(depositAddress, { state: "unknown", txHash: e.hash });
    }
    throw e;
  }

  recordIntentsDeposit(depositAddress, { state: "broadcast", txHash: sourceTxHash });

  // Persist first (F2). The deposit is on its way; nothing after this line
  // may turn that into a rejection the UI would read as "failed".
  if (input.onBroadcast) {
    try {
      await input.onBroadcast({ sourceTxHash, depositAddress, pending });
    } catch (e) {
      console.warn("[swap] onBroadcast handler failed after the deposit went out:", e);
    }
  }

  // Tell 1Click the deposit txhash so the solver-relay starts processing
  // immediately rather than waiting for its chain scanner to spot it. BEST
  // EFFORT (2026-09-29, F2): this used to be awaited bare, so a relay 503
  // AFTER the broadcast rejected the whole call — no hash, no history row,
  // and a Retry button that signed a second deposit to the same address.
  // The scanner finds the deposit without it.
  try {
    await withTimeout(
      notifyIntentsDeposit({ depositAddress, txHash: sourceTxHash }),
      15_000,
      "notifyIntentsDeposit",
    );
  } catch (e) {
    console.warn(
      "[swap] notifyIntentsDeposit failed; 1Click will find the deposit on chain:",
      errorText(e),
    );
  }

  phase({ phase: "pending", sourceTxHash });
  return { sourceTxHash, depositAddress, pending };
}

/**
 * The EVM deposit: gas estimate, balance gates, build per the catalog's
 * shape, sign once, broadcast once. Returns the source tx hash.
 */
async function depositEvm(args: {
  input: ExecuteIntentsInput;
  fromMeta: SwapCoinMeta;
  depositAddress: string;
  quoteAmountAtomic: bigint;
  /** From the catalog (F1): token contract, or null for the native coin. */
  contract: string | null;
  phase: (s: SwapExecutionStatus) => void;
  ctx: (stage: string) => Record<string, string>;
}): Promise<string> {
  const { input, fromMeta, depositAddress, quoteAmountAtomic, contract, phase, ctx } = args;
  if (typeof fromMeta.evmChainId !== "number") {
    throw new Error(`No chain id configured for ${input.fromAsset}`);
  }
  // Resolve the RPC fallback list for this chain. If the user pinned
  // an `rpcUrlOverride` we honor it absolutely; otherwise we use the
  // chain's full audited fallback list (env-overridable via
  // VITE_<CHAIN>_RPC_URL — see wallets/chain-rpcs.ts).
  const rpcUrls: string[] = input.rpcUrlOverride
    ? [input.rpcUrlOverride]
    : fromMeta.rpcFallbacks && fromMeta.rpcFallbacks.length > 0
      ? fromMeta.rpcFallbacks
      : fromMeta.defaultRpcUrl
        ? [fromMeta.defaultRpcUrl]
        : [];
  if (rpcUrls.length === 0) {
    throw new Error(`No RPC URL configured for ${input.fromAsset}`);
  }
  const ticker = fromMeta.ticker;

  // ─── 1Click's `quote.amountIn` is atomic units (wei / 1e6 token / etc.) ──
  // Documented contract: do NOT re-convert via decimalToBaseUnits.
  // See post-mortem-amount-units for the 5-sextillion-ETH bug story.
  const transferAmountAtomic = quoteAmountAtomic;

  // Token or native per the CATALOG (F1). For native gas (ETH, BNB, AVAX,
  // POL, MON) the `value` field carries the amount and `data` is empty. For
  // an ERC-20, `to` is the token contract, `value` is 0, and `data` is the
  // encoded transfer(depositAddress, amount).
  const isErc20 = contract !== null;
  const txTo = isErc20 ? contract : depositAddress;
  const txValueHex = "0x" + (isErc20 ? 0n : transferAmountAtomic).toString(16);
  const txData = isErc20
    ? buildErc20TransferCalldata(depositAddress, transferAmountAtomic)
    : "0x";

  // Fetch gas price first; nonce is fetched as the LAST step
  // before signing so it's as fresh as possible.
  const gasPriceHex = await jsonRpcCall(rpcUrls, "eth_gasPrice", [], { ticker });

  // ─── pre-sign balance + value gates ───────────────────────────
  // Native gas balance is always required (every EVM tx pays in gas).
  const nativeBalanceHex = await jsonRpcCall(
    rpcUrls,
    "eth_getBalance",
    [input.sourceAddress, "latest"],
    { ticker },
  );
  const nativeBalanceWei = BigInt(nativeBalanceHex);
  const gasPriceWei = BigInt(gasPriceHex);
  // Gas limit from `eth_estimateGas` on the exact transaction plus a margin
  // (2026-09-29, EXTRA). It was a flat 21 000 / 100 000: Arbitrum's native
  // transfer alone estimates 21 595, and an L2 token transfer's L1 data
  // component can exceed 100 000 when L1 is busy — out of gas on chain.
  const gasLimit = await estimateDepositGasLimit({
    rpcUrls,
    from: input.sourceAddress,
    to: txTo,
    valueHex: txValueHex,
    data: txData,
    isErc20,
    ticker,
  });
  const gasCostWei = gasLimit * gasPriceWei;

  // Token balance fetch (ERC-20 only) via balanceOf(address) eth_call.
  let tokenBalanceAtomic: bigint = 0n;
  if (isErc20) {
    const tokenBalanceHex = await jsonRpcCall(
      rpcUrls,
      "eth_call",
      [{ to: contract, data: buildErc20BalanceOfCalldata(input.sourceAddress) }, "latest"],
      { ticker },
    );
    tokenBalanceAtomic = BigInt(tokenBalanceHex);
  }

  // Three layered guards on the moving asset's balance:
  //   #3 funded (native side): gas <= native balance (always)
  //   #3 funded (transfer): for native, value + gas <= native;
  //                         for ERC-20, transferAmount <= token balance
  //   #4 not overspend: transferAmount <= 2× moving-asset balance
  const movingAssetBalance = isErc20 ? tokenBalanceAtomic : nativeBalanceWei;
  await runInvariant(
    () =>
      assertTxNotPlausibleOverspend({
        valueAtomic: transferAmountAtomic,
        balanceAtomic: movingAssetBalance,
        ticker,
      }),
    ctx("pre-sign"),
  );
  if (isErc20) {
    // ERC-20: native pays only gas; token covers the transfer.
    await runInvariant(
      () =>
        assertTxFundable({
          valueAtomic: gasCostWei,
          gasCostAtomic: 0n, // already folded in
          balanceAtomic: nativeBalanceWei,
          ticker,
        }),
      ctx("pre-sign"),
    );
    await runInvariant(
      () =>
        assertTxFundable({
          valueAtomic: transferAmountAtomic,
          gasCostAtomic: 0n,
          balanceAtomic: tokenBalanceAtomic,
          ticker,
        }),
      ctx("pre-sign"),
    );
  } else {
    // Native: value + gas <= native balance (the historic check).
    await runInvariant(
      () =>
        assertTxFundable({
          valueAtomic: transferAmountAtomic,
          gasCostAtomic: gasCostWei,
          balanceAtomic: nativeBalanceWei,
          ticker,
        }),
      ctx("pre-sign"),
    );
  }

  // ─── Nonce: fetched LAST, immediately before signing ───────
  const nonceHex = await jsonRpcCall(
    rpcUrls,
    "eth_getTransactionCount",
    [input.sourceAddress, "pending"],
    { ticker },
  );

  const unsignedTx = {
    chainId: fromMeta.evmChainId,
    to: txTo,
    value: txValueHex,
    data: txData,
    gas: Number(gasLimit),
    gasPrice: gasPriceHex,
    nonce: nonceHex,
  };

  // ─── INVARIANT #2 ─ built tx moves exactly quote.amountIn ─────
  await runInvariant(
    () =>
      assertTxValueMatchesQuote({
        txValueAtomic: isErc20
          ? (parseErc20TransferCalldata(unsignedTx.data)?.amount ?? -1n)
          : BigInt(unsignedTx.value),
        quoteAmountAtomic,
        ticker,
      }),
    ctx("post-build"),
  );
  // ─── F1 ─ built tx has the catalog's shape ────────────────────
  await runInvariant(
    () =>
      assertEvmDepositShape({
        to: unsignedTx.to,
        value: BigInt(unsignedTx.value),
        data: unsignedTx.data,
        depositAddress,
        amountAtomic: transferAmountAtomic,
        contract,
        ticker,
        stage: "post-build",
      }),
    ctx("post-build"),
  );

  phase({ phase: "signing" });
  const signed = await signEvm(
    input.sessionId,
    unsignedTx,
    input.account ?? 0,
    input.index ?? 0
  );

  // ─── INVARIANT #5 + F1 on the SIGNED bytes ────────────────────
  // To, value AND calldata, decoded from the RLP the signer produced —
  // so a signer that changed the recipient inside the calldata is caught
  // too (the pre-2026-09-29 check read `to` and `value` only).
  await runInvariant(
    () =>
      assertSignedTxValueMatches({
        rawSignedTxHex: signed.rawTx,
        expectedValueAtomic: isErc20 ? 0n : transferAmountAtomic,
        expectedRecipient: txTo,
        ticker,
      }),
    ctx("post-sign"),
  );
  const decoded = await runInvariant(() => decodeEvmSignedTx(signed.rawTx), ctx("post-sign"));
  await runInvariant(
    () =>
      assertEvmDepositShape({
        to: decoded.to,
        value: decoded.value,
        data: decoded.data,
        depositAddress,
        amountAtomic: transferAmountAtomic,
        contract,
        ticker,
        stage: "post-sign",
      }),
    ctx("post-sign"),
  );

  phase({ phase: "broadcasting" });
  return broadcastEvmDepositOnce({
    rpcUrls,
    rawTx: signed.rawTx,
    ticker,
    depositAddress,
  });
}

/**
 * Gas limit for the deposit: `eth_estimateGas` on the exact transaction plus
 * 25 %, or the historic fixed limits (21 000 native / 100 000 ERC-20) when
 * estimation is unavailable or returns an implausible reading
 * (2026-09-29, EXTRA). The user pays only for gas used; the limit only has to
 * be enough.
 */
export async function estimateDepositGasLimit(args: {
  rpcUrls: string[];
  from: string;
  to: string;
  valueHex: string;
  data: string;
  isErc20: boolean;
  ticker: string;
}): Promise<bigint> {
  const fallback = args.isErc20 ? 100_000n : 21_000n;
  const call: Record<string, string> = {
    from: args.from,
    to: args.to,
    value: args.valueHex,
  };
  if (args.data && args.data !== "0x") call.data = args.data;
  try {
    const hex = await jsonRpcCall(args.rpcUrls, "eth_estimateGas", [call], {
      ticker: args.ticker,
    });
    const est = BigInt(hex);
    if (est < 21_000n || est > 10_000_000n) return fallback;
    return (est * 125n + 99n) / 100n;
  } catch (e) {
    console.warn(
      `[swap] eth_estimateGas unavailable for the ${args.ticker} deposit; using ${fallback}:`,
      errorText(e),
    );
    return fallback;
  }
}

/** keccak-256 of signed EVM bytes — the hash the network will give the tx. */
function evmTxHash(rawTxHex: string): string {
  const c = rawTxHex.startsWith("0x") ? rawTxHex.slice(2) : rawTxHex;
  const bytes = new Uint8Array(c.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return (
    "0x" +
    Array.from(keccak_256(bytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Does any of `rpcUrls` know `hash` (mempool or chain)? False on failure. */
async function evmTransactionKnown(rpcUrls: string[], hash: string): Promise<boolean> {
  for (const url of rpcUrls) {
    try {
      const resp = await withTimeout(
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getTransactionByHash",
            params: [hash],
          }),
        }),
        6_000,
        "eth_getTransactionByHash",
      );
      if (!resp.ok) continue;
      const json = (await resp.json()) as { result?: unknown };
      if (json && json.result) return true;
    } catch {
      /* next URL */
    }
  }
  return false;
}

/**
 * Broadcast signed EVM bytes ONCE (2026-09-29 send-safety audit, F2).
 *
 * The Rust verified broadcast re-sends the SAME bytes to each RPC in turn and
 * gives up when none can show the transaction afterwards. That can happen to
 * a transaction that is in a mempool — a node answered with its hash and a
 * lagging read replica returned null — and the modal used to call it
 * "Broadcast failed. Retry", whose retry signed a NEW transaction.
 *
 * Now: the hash of the signed bytes is computed locally; on a rejection it is
 * looked up; a transaction nobody refused outright is reported as UNKNOWN
 * with that hash (`SendOutcomeUnknownError`), and only a submission every RPC
 * refused at the broadcast stage is an ordinary failure. A verified hash that
 * disagrees with the local one (INVARIANT #6) is likewise an unknown outcome,
 * not a "safety check failed before broadcasting".
 */
async function broadcastEvmDepositOnce(args: {
  rpcUrls: string[];
  rawTx: string;
  ticker: string;
  depositAddress: string;
}): Promise<string> {
  const localHash = evmTxHash(args.rawTx);
  let verifiedHash: string;
  try {
    verifiedHash = (await broadcastEvmVerified(args.rpcUrls, args.rawTx)).txHash;
  } catch (e) {
    const msg = errorText(e);
    if (await evmTransactionKnown(args.rpcUrls, localHash)) return localHash;
    if (evmBroadcastRefusedEverywhere(msg)) {
      throw new Error(`Every RPC refused the ${args.ticker} deposit, so it was not sent. ${msg}`);
    }
    throw new SendOutcomeUnknownError(
      `The ${args.ticker} deposit may have been sent: an RPC accepted it or did not ` +
        `answer, and none can show it yet. Check ${localHash} on a block explorer ` +
        `before trying again.\n${msg}`,
      localHash,
    );
  }
  // ─── INVARIANT #6 ─ verified hash === keccak256(signedTx) ──
  try {
    assertVerifiedHashMatches({ rawSignedTxHex: args.rawTx, verifiedHash });
  } catch (e) {
    if (e instanceof SafetyInvariantError) {
      void logSafetyIncident(e, {
        stage: "post-broadcast",
        ticker: args.ticker,
        depositAddress: args.depositAddress,
      });
      throw new SendOutcomeUnknownError(
        `The ${args.ticker} deposit was broadcast, but the network answered with hash ` +
          `${verifiedHash} while the transaction the wallet signed is ${localHash} ` +
          `(safety check ${e.invariant}). It may or may not be on chain — check ` +
          `${localHash} on a block explorer before doing anything else.`,
        localHash,
      );
    }
    throw e;
  }
  return verifiedHash;
}

/**
 * Statuses after which 1Click will not change a swap again.
 *
 * `INCOMPLETE_DEPOSIT` was in this set until 2026-09-29 (send-safety audit,
 * F5) and was recorded as "failed". It is not terminal: it means the deposit
 * arrived short of the quote, and 1Click refunds it by the deadline (or
 * completes the swap if the rest arrives), so the swap still ends REFUNDED
 * or SUCCESS. Calling it "failed" stopped the tracking at the one moment the
 * user's funds were in flight back to them.
 */
const INTENTS_TERMINAL: ReadonlySet<string> = new Set([
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const);

/** Deposit addresses a poller in this session is already watching. */
const activeIntentsPolls = new Set<string>();

/** True while `pollIntentsToTerminal` is watching `depositAddress`. */
export function isIntentsPollActive(depositAddress: string): boolean {
  return activeIntentsPolls.has(depositAddress);
}

/**
 * Poll `/api/intents/status?depositAddress=...` every `intervalMs` (default
 * 10 s) until terminal or timeout. Calls `onUpdate` on every tick.
 *
 * The timeout is sized from the quote's `deadline` when one is given: the
 * swap cannot be decided before the deadline (a short or late deposit is
 * refunded BY it), so a flat 30 minutes gave up on every BTC swap and on
 * every refund (F5). Default: whichever is later of 30 minutes and the
 * deadline plus an hour.
 */
export async function pollIntentsToTerminal(args: {
  depositAddress: string;
  deadline?: string;
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (s: IntentsStatusResponse) => void;
}): Promise<IntentsStatusResponse> {
  const interval = args.intervalMs ?? 10_000;
  const deadlineMs = args.deadline ? Date.parse(args.deadline) : NaN;
  const timeout =
    args.timeoutMs ??
    Math.max(
      30 * 60_000,
      Number.isFinite(deadlineMs) ? deadlineMs - Date.now() + 60 * 60_000 : 0,
    );
  const start = Date.now();
  activeIntentsPolls.add(args.depositAddress);
  try {
    while (true) {
      if (Date.now() - start > timeout) {
        throw new Error("Intents status polling timed out");
      }
      let resp: IntentsStatusResponse;
      try {
        resp = await getIntentsStatus(args.depositAddress);
      } catch {
        await sleep(interval);
        continue;
      }
      args.onUpdate?.(resp);
      if (typeof resp.status === "string" && INTENTS_TERMINAL.has(resp.status)) {
        return resp;
      }
      await sleep(interval);
    }
  } finally {
    activeIntentsPolls.delete(args.depositAddress);
  }
}

/** Map an Intents status to the local history enum. `INCOMPLETE_DEPOSIT`
 *  is pending, not failed (F5). */
export function intentsStatusToHistory(
  s: string | undefined
): "pending" | "success" | "refunded" | "failed" {
  if (s === "SUCCESS") return "success";
  if (s === "REFUNDED") return "refunded";
  if (s === "FAILED") return "failed";
  return "pending";
}

// `decimalToBaseUnits(amount, decimals)` lived here until 2026-05-06
// to convert display-units strings into hex-encoded atomic units. It's
// gone because the only caller (the EVM branch of executeIntentsTrade)
// was misusing it on `amountIn` from 1Click — which is ALREADY atomic
// units. The misuse produced the 5-sextillion-ETH bug. Today's flow
// uses `atomicStringToBigInt` exclusively for source-tx values; if a
// caller ever needs display→atomic, import `decimalToBaseUnitsBigInt`
// from `swap-sources.ts`.
