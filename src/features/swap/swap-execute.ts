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
  type SwapChainKind,
} from "./swap-data";
import {
  effectiveModeForSource,
  isMockSwapKitResponse,
} from "./router-modes";
import {
  executeCardanoTransfer,
  executeNearNativeTransfer,
  executeSolanaTransfer,
  executeSplTransfer,
  executeUtxoTransfer,
} from "./swap-sources";
import { getNearAddress, getSolanaAddress, getUtxoAddress } from "../../api/swap-rust";
import {
  AllRpcsFailedError,
  jsonRpcCall,
  tryRpcUrls,
} from "../../wallets/chain-rpcs";
import {
  SafetyInvariantError,
  assertQuoteAmountMatchesUserIntent,
  assertSignedTxValueMatches,
  assertTxFundable,
  assertTxNotPlausibleOverspend,
  assertTxValueMatchesQuote,
  assertVerifiedHashMatches,
  logSafetyIncident,
} from "./safety-invariants";

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
async function runInvariant(
  fn: () => void,
  sessionContext: Record<string, string>
): Promise<void> {
  try {
    fn();
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

/* ─── NEAR Intents execution (ETH source only in v1) ─────────────── */

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
   * The vault's BIP-39 mnemonic, REQUIRED only when `fromAsset` is ADA.
   * Cardano is the one source chain signed in TS (not the Rust session) —
   * its deposit tx is built + signed + submitted by `executeCardanoTransfer`
   * via the same `cardano-tx.ts` stack the dashboard Send uses. The confirm
   * modal threads this from `walletsByChain.cardano.mnemonic` (the same
   * place ADA Send reads it). Unused for every other chain, which sign via
   * the Rust `sessionId`.
   */
  cardanoMnemonic?: string;
  onPhase?: (s: SwapExecutionStatus) => void;
}

/**
 * Execute a NEAR Intents quote: build → sign → broadcast a source-chain
 * deposit to `intentsQuote.depositAddress`, then notify 1Click and let
 * the solver-relay perform the cross-chain settlement.
 *
 * Source-chain coverage:
 *   - EVM (ETH / AVAX / POL / FLR / MON / BNB): inline below — query
 *     nonce/gasPrice from RPC, sign via `swap_sign_evm`.
 *   - SOL: `executeSolanaTransfer` — System.transfer + `swap_sign_solana`.
 *   - NEAR: `executeNearNativeTransfer` — borsh-encoded Transfer +
 *     `swap_sign_near_tx`. User must have ≥0.1 NEAR for fees.
 *   - BTC / LTC / DOGE / BCH: `executeUtxoTransfer` — UTXO fetch +
 *     bitcoinjs-lib PSBT build + `swap_sign_psbt`.
 *   - ADA: `executeCardanoTransfer` — the one TS-signed source. Builds +
 *     signs (BIP-32-Ed25519) + submits via Koios in `cardano-tx.ts`; no
 *     Rust signer. Needs `input.cardanoMnemonic`.
 *   - DASH / STELLAR / SUI: routed through their dedicated helpers in
 *     swap-sources.ts (not this generic dispatcher).
 */
export async function executeIntentsTrade(
  input: ExecuteIntentsInput
): Promise<{ sourceTxHash: string; depositAddress: string }> {
  const phase = (s: SwapExecutionStatus) => input.onPhase?.(s);
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

  // CARDANO signs + submits via the TS Koios path (no chain RPC); every
  // other source needs an RPC URL. Default to "" so the type stays
  // `string` for the existing branches while exempting CARDANO.
  const rpcUrl = input.rpcUrlOverride ?? fromMeta.defaultRpcUrl ?? "";
  if (!rpcUrl && fromMeta.chainKind !== "CARDANO") {
    throw new Error(`No RPC URL configured for ${input.fromAsset}`);
  }

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
    {
      stage: "post-quote",
      ticker: fromMeta.ticker,
      depositAddress,
    }
  );

  phase({ phase: "building" });

  let sourceTxHash: string;

  switch (fromMeta.chainKind) {
    case "EVM": {
      if (typeof fromMeta.evmChainId !== "number") {
        throw new Error(`No chain id configured for ${input.fromAsset}`);
      }
      // Resolve the RPC fallback list for this chain. If the user pinned
      // an `rpcUrlOverride` we honor it absolutely; otherwise we use the
      // chain's full audited fallback list (env-overridable via
      // VITE_<CHAIN>_RPC_URL — see wallets/chain-rpcs.ts).
      const rpcUrls: string[] = input.rpcUrlOverride
        ? [input.rpcUrlOverride]
        : (fromMeta.rpcFallbacks && fromMeta.rpcFallbacks.length > 0
            ? fromMeta.rpcFallbacks
            : [rpcUrl]);

      // ─── 1Click's `quote.amountIn` is atomic units (wei / 1e6 token / etc.) ──
      // Documented contract: do NOT re-convert via decimalToBaseUnits.
      // See post-mortem-amount-units for the 5-sextillion-ETH bug story.
      const transferAmountAtomic = quoteAmountAtomic;

      // ERC-20 source flow branches on `tokenContract`. For native gas
      // (ETH, MATIC, BNB, AVAX, MON, etc.) the `value` field carries the
      // amount and `data` is empty. For ERC-20 transfers, `to` is the
      // token contract, `value` is 0, and `data` is the encoded
      // transfer(recipient, amount) calldata.
      const isErc20 = !!fromMeta.tokenContract;

      // Fetch gas price first; nonce is fetched as the LAST step
      // before signing so it's as fresh as possible.
      const gasPriceHex = await jsonRpcCall(
        rpcUrls,
        "eth_gasPrice",
        [],
        { ticker: fromMeta.ticker },
      );

      // ─── pre-sign balance + value gates ───────────────────────────
      // Native gas balance is always required (every EVM tx pays in gas).
      const nativeBalanceHex = await jsonRpcCall(
        rpcUrls,
        "eth_getBalance",
        [input.sourceAddress, "latest"],
        { ticker: fromMeta.ticker },
      );
      const nativeBalanceWei = BigInt(nativeBalanceHex);
      const gasPriceWei = BigInt(gasPriceHex);
      // Native: 21000. ERC-20: ~50-65k for USDT/USDC, ~50k for DAI; pad
      // to 100k for safety (the user pays only what's actually consumed).
      const gasLimit = isErc20 ? 100_000n : 21_000n;
      const gasCostWei = gasLimit * gasPriceWei;

      // Token balance fetch (ERC-20 only) via balanceOf(address) eth_call.
      let tokenBalanceAtomic: bigint = 0n;
      if (isErc20 && fromMeta.tokenContract) {
        const { buildErc20BalanceOfCalldata } = await import("./erc20-calldata");
        const balanceOfData = buildErc20BalanceOfCalldata(input.sourceAddress);
        const tokenBalanceHex = await jsonRpcCall(
          rpcUrls,
          "eth_call",
          [{ to: fromMeta.tokenContract, data: balanceOfData }, "latest"],
          { ticker: fromMeta.ticker },
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
            ticker: fromMeta.ticker,
          }),
        { stage: "pre-sign", ticker: fromMeta.ticker, depositAddress }
      );
      if (isErc20) {
        // ERC-20: native pays only gas; token covers the transfer.
        await runInvariant(
          () =>
            assertTxFundable({
              valueAtomic: gasCostWei,
              gasCostAtomic: 0n, // already folded in
              balanceAtomic: nativeBalanceWei,
              ticker: fromMeta.ticker,
            }),
          { stage: "pre-sign", ticker: fromMeta.ticker, depositAddress }
        );
        await runInvariant(
          () =>
            assertTxFundable({
              valueAtomic: transferAmountAtomic,
              gasCostAtomic: 0n,
              balanceAtomic: tokenBalanceAtomic,
              ticker: fromMeta.ticker,
            }),
          { stage: "pre-sign", ticker: fromMeta.ticker, depositAddress }
        );
      } else {
        // Native: value + gas <= native balance (the historic check).
        await runInvariant(
          () =>
            assertTxFundable({
              valueAtomic: transferAmountAtomic,
              gasCostAtomic: gasCostWei,
              balanceAtomic: nativeBalanceWei,
              ticker: fromMeta.ticker,
            }),
          { stage: "pre-sign", ticker: fromMeta.ticker, depositAddress }
        );
      }

      // ─── Nonce: fetched LAST, immediately before signing ───────
      const nonceHex = await jsonRpcCall(
        rpcUrls,
        "eth_getTransactionCount",
        [input.sourceAddress, "pending"],
        { ticker: fromMeta.ticker },
      );

      // Build the unsigned tx — branches on isErc20.
      let unsignedTx: {
        chainId: number;
        to: string;
        value: string;
        data: string;
        gas: number;
        gasPrice: string;
        nonce: string;
      };
      if (isErc20 && fromMeta.tokenContract) {
        const { buildErc20TransferCalldata } = await import("./erc20-calldata");
        unsignedTx = {
          chainId: fromMeta.evmChainId,
          to: fromMeta.tokenContract,
          value: "0x0",
          data: buildErc20TransferCalldata(depositAddress, transferAmountAtomic),
          gas: Number(gasLimit),
          gasPrice: gasPriceHex,
          nonce: nonceHex,
        };
      } else {
        const valueHex = "0x" + transferAmountAtomic.toString(16);
        unsignedTx = {
          chainId: fromMeta.evmChainId,
          to: depositAddress,
          value: valueHex,
          data: "0x",
          gas: Number(gasLimit),
          gasPrice: gasPriceHex,
          nonce: nonceHex,
        };
      }

      // ─── INVARIANT #2 ─ built tx value/calldata === quote.amountIn ─
      // Native: value field === quote atomic. ERC-20: value=0 AND
      // calldata's parsed amount === quote atomic. Both layers prevent a
      // future bug from quietly putting the value somewhere it wouldn't
      // get spent.
      if (isErc20) {
        const { parseErc20TransferCalldata } = await import("./erc20-calldata");
        if (BigInt(unsignedTx.value) !== 0n) {
          throw new SafetyInvariantError({
            invariant: "ERC20_SOURCE_VALUE_DRIFT",
            message: `ERC-20 source tx must have value=0 but got ${unsignedTx.value}`,
            context: {
              value: unsignedTx.value,
              ticker: fromMeta.ticker,
              stage: "post-build",
            },
          });
        }
        const parsed = parseErc20TransferCalldata(unsignedTx.data);
        if (!parsed) {
          throw new SafetyInvariantError({
            invariant: "ERC20_SOURCE_CALLDATA_DRIFT",
            message: `ERC-20 source tx calldata is not transfer(address,uint256)`,
            context: {
              dataHead: unsignedTx.data.slice(0, 12),
              ticker: fromMeta.ticker,
              stage: "post-build",
            },
          });
        }
        await runInvariant(
          () =>
            assertTxValueMatchesQuote({
              txValueAtomic: parsed.amount,
              quoteAmountAtomic,
              ticker: fromMeta.ticker,
            }),
          { stage: "post-build", ticker: fromMeta.ticker, depositAddress }
        );
      } else {
        await runInvariant(
          () =>
            assertTxValueMatchesQuote({
              txValueAtomic: BigInt(unsignedTx.value),
              quoteAmountAtomic,
              ticker: fromMeta.ticker,
            }),
          { stage: "post-build", ticker: fromMeta.ticker, depositAddress }
        );
      }

      phase({ phase: "signing" });
      const signed = await signEvm(
        input.sessionId,
        unsignedTx,
        input.account ?? 0,
        input.index ?? 0
      );

      // ─── INVARIANT #5 ─ signed tx value + recipient unchanged ───
      // For native EVM the assertion compares value+to directly. For
      // ERC-20 the on-chain `to` is the token contract and `value=0`;
      // the *transfer recipient* lives in calldata. The existing
      // assertSignedTxValueMatches helper inspects the RLP `to`/`value`
      // fields, so for ERC-20 we adapt:
      //   - expectedRecipient = tokenContract (where the tx is sent)
      //   - expectedValueAtomic = 0
      // The transfer recipient is verified against calldata above.
      const expectedSignedRecipient = isErc20 && fromMeta.tokenContract
        ? fromMeta.tokenContract
        : depositAddress;
      const expectedSignedValue = isErc20 ? 0n : transferAmountAtomic;
      await runInvariant(
        () =>
          assertSignedTxValueMatches({
            rawSignedTxHex: signed.rawTx,
            expectedValueAtomic: expectedSignedValue,
            expectedRecipient: expectedSignedRecipient,
            ticker: fromMeta.ticker,
          }),
        { stage: "post-sign", ticker: fromMeta.ticker, depositAddress }
      );

      phase({ phase: "broadcasting" });
      const r = await broadcastEvmVerified(rpcUrls, signed.rawTx);

      // ─── INVARIANT #6 ─ verified hash === keccak256(signedTx) ──
      // The Rust verified-broadcast layer should have returned the same
      // hash a local keccak256 of the signed tx produces. If they
      // differ, an RPC misbehaved — surface the discrepancy rather
      // than blindly trusting the network's response.
      await runInvariant(
        () =>
          assertVerifiedHashMatches({
            rawSignedTxHex: signed.rawTx,
            verifiedHash: r.txHash,
          }),
        { stage: "post-broadcast", ticker: fromMeta.ticker, depositAddress }
      );

      sourceTxHash = r.txHash;
      break;
    }

    case "SOLANA": {
      // Source address must come from our derivation, not be passed in,
      // because the form may pre-fill `sourceAddress` from a non-SOL
      // wallet adapter when SOL has no first-party adapter.
      const fromAddress =
        input.sourceAddress && input.sourceAddress.length > 0
          ? input.sourceAddress
          : await getSolanaAddress(input.sessionId);
      phase({ phase: "signing" });
      // SPL token branch: when the source asset has a `tokenContract`
      // (= SPL mint address), route through executeSplTransfer which
      // builds a Token Program transfer instruction against the
      // source/destination ATAs. Otherwise route through the native
      // SOL helper.
      let r: { txHash: string };
      if (fromMeta.tokenContract) {
        r = await executeSplTransfer({
          sessionId: input.sessionId,
          fromAddress,
          depositAddress,
          mint: fromMeta.tokenContract,
          amountAtomic: amountIn,
          rpcUrl,
        });
      } else {
        // amountIn from 1Click is already in lamports (atomic) — pass
        // through the atomic-units field, NOT the now-removed amountSol.
        r = await executeSolanaTransfer({
          sessionId: input.sessionId,
          fromAddress,
          depositAddress,
          amountAtomic: amountIn,
          rpcUrl,
        });
      }
      phase({ phase: "broadcasting" });
      sourceTxHash = r.txHash;
      break;
    }

    case "NEAR": {
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
    case "BCH": {
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

    case "DASH":
    case "STELLAR":
    case "SUI":
      // Phase 5 / 6 / 7 routing is wired through the dedicated source
      // helpers in `swap-sources.ts`. Each chain has its own multi-step
      // build → fetch → sign → broadcast flow that doesn't fit the
      // generic EVM/SOL/NEAR/UTXO patterns above.
      throw new Error(
        `${fromMeta.ticker} source-tx routing is wired through executeDash/executeStellar/executeSui in swap-sources.ts — call those directly, not this generic dispatcher.`
      );

    case "CARDANO": {
      // ADA source — signed in the TS Cardano stack, NOT the Rust core.
      // See executeCardanoTransfer for the rationale. The mnemonic is
      // threaded in from walletsByChain.cardano (same as ADA Send); the
      // Rust swap session isn't used for this chain.
      if (!input.cardanoMnemonic) {
        throw new Error(
          "ADA source swap requires the Cardano mnemonic. Open the Cardano " +
            "chain in the dashboard so the wallet is derived, then retry."
        );
      }
      phase({ phase: "signing" });
      // amountIn = lovelace (6dp atomic) per 1Click's response shape.
      const r = await executeCardanoTransfer({
        mnemonic: input.cardanoMnemonic,
        fromAddress: input.sourceAddress,
        depositAddress,
        amountAtomic: amountIn,
      });
      phase({ phase: "broadcasting" });
      sourceTxHash = r.txHash;
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

  // Tell 1Click the deposit txhash so the solver-relay starts processing
  // immediately rather than waiting for the chain scanner to spot it.
  await notifyIntentsDeposit({
    depositAddress,
    txHash: sourceTxHash,
  });

  phase({ phase: "pending", sourceTxHash });
  return { sourceTxHash, depositAddress };
}

const INTENTS_TERMINAL: ReadonlySet<string> = new Set([
  "SUCCESS",
  "REFUNDED",
  "FAILED",
  "INCOMPLETE_DEPOSIT",
] as const);

/**
 * Poll `/api/intents/status?depositAddress=...` every `intervalMs` (default
 * 10 s) until terminal or `timeoutMs` (default 30 min). Calls `onUpdate` on
 * every tick.
 */
export async function pollIntentsToTerminal(args: {
  depositAddress: string;
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (s: IntentsStatusResponse) => void;
}): Promise<IntentsStatusResponse> {
  const interval = args.intervalMs ?? 10_000;
  const timeout = args.timeoutMs ?? 30 * 60_000;
  const start = Date.now();
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
}

/** Map an Intents status to the local history enum. */
export function intentsStatusToHistory(
  s: string | undefined
): "pending" | "success" | "refunded" | "failed" {
  if (s === "SUCCESS") return "success";
  if (s === "REFUNDED") return "refunded";
  if (s === "FAILED" || s === "INCOMPLETE_DEPOSIT") return "failed";
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

