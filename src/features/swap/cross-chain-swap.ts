/**
 * High-level cross-chain swap orchestration.
 *
 * Wraps the proxy + Rust signing + broadcast layers into the canonical flow
 * from §3.2 of the integration plan:
 *
 *   1. quote   → proxy → SwapKit /v3/quote (or 1Click /v0/quote)
 *   2. build   → proxy → /v3/swap          (returns unsigned tx)
 *   3. sign    → Rust core (key never leaves)
 *   4. broadcast → Rust core → chain RPC   (proxy not involved)
 *   5. track   → proxy → /track or /v0/status
 *
 * The session must be unlocked (via `unlockSwap`) before calling any of the
 * sign-or-broadcast functions.
 */
import {
  buildSwapKitTx,
  getIntentsQuote,
  getIntentsStatus,
  getSwapKitQuote,
  notifyIntentsDeposit,
  trackSwapKitSwap,
} from "../../api/proxy";
import {
  broadcastTx,
  signEvm,
  signNearIntent,
  signPsbt,
  signSolanaMessage,
  type SignedHex,
} from "../../api/swap-rust";
import type {
  IntentsQuoteRequest,
  IntentsQuoteResponse,
  IntentsStatusResponse,
  SwapKitQuoteRequest,
  SwapKitQuoteResponse,
  SwapKitRoute,
  SwapKitSwapResponse,
  SwapKitTrackResponse,
} from "../../lib/proxy-types";

/** Quote for an arbitrary cross-chain pair via SwapKit's aggregated routing. */
export async function quoteSwapKit(
  req: SwapKitQuoteRequest
): Promise<SwapKitQuoteResponse> {
  return getSwapKitQuote(req);
}

/** Quote via NEAR Intents 1Click directly (for routes SwapKit can't reach). */
export async function quoteIntents(
  req: IntentsQuoteRequest
): Promise<IntentsQuoteResponse> {
  return getIntentsQuote(req);
}

/** "Best of both": fan out quote requests to SwapKit + 1Click in parallel. */
export async function quoteDual(
  swapkit: SwapKitQuoteRequest,
  intents: IntentsQuoteRequest
): Promise<{
  swapkit: SwapKitQuoteResponse | { error: string };
  intents: IntentsQuoteResponse | { error: string };
}> {
  const [a, b] = await Promise.allSettled([
    quoteSwapKit(swapkit),
    quoteIntents(intents),
  ]);
  return {
    swapkit: a.status === "fulfilled" ? a.value : { error: String(a.reason) },
    intents: b.status === "fulfilled" ? b.value : { error: String(b.reason) },
  };
}

export interface ExecuteSwapKitRoute {
  sessionId: string;
  route: SwapKitRoute;
  sourceAddress: string;
  destinationAddress: string;
  /** RPC URL the client uses to broadcast (EVM or UTXO chain). */
  broadcastRpcUrl: string;
  /** Account/index for derivation (defaults to 0/0). */
  account?: number;
  index?: number;
}

export interface ExecutionResult {
  txHash: string;
  rawTx?: string;
  built: SwapKitSwapResponse;
}

/**
 * Build → sign → broadcast a SwapKit route. Throws on any failure step;
 * returns the chain txHash on success.
 *
 * Quote freshness: SwapKit routeIds are valid for 60s. If the user hesitates
 * past that, the proxy returns a 4xx error mapped to "ROUTE_EXPIRED" — the
 * UI should re-quote and ask for confirmation again.
 */
export async function executeSwapKitRoute(
  args: ExecuteSwapKitRoute
): Promise<ExecutionResult> {
  const built = await buildSwapKitTx({
    routeId: args.route.routeId,
    sourceAddress: args.sourceAddress,
    destinationAddress: args.destinationAddress,
  });

  const txType = built.meta.txType;
  let signed: SignedHex;
  let chainKind: string;

  switch (txType) {
    case "EVM": {
      if (!built.transaction) throw new Error("EVM route returned no transaction");
      signed = await signEvm(args.sessionId, built.transaction, args.account, args.index);
      chainKind = "EVM";
      break;
    }
    case "PSBT": {
      if (!built.tx) throw new Error("PSBT route returned no tx hex");
      signed = await signPsbt(args.sessionId, built.tx);
      chainKind = "BTC";
      break;
    }
    case "SOLANA": {
      if (!built.tx) throw new Error("SOLANA route returned no tx blob");
      const sol = await signSolanaMessage(args.sessionId, built.tx);
      // Solana broadcast wants the full tx; the proxy is expected to return
      // a base64 message to which we prepend signatures and re-serialize.
      // For v1 we surface the signature + caller assembles. This is a known
      // gap — see SOURCES.md and IntegrationPlanV1 §1.4 (txType=SOLANA).
      throw new Error(
        `Solana swap signing returned signature ${sol.signature} but final tx assembly is v2 — fall back to a non-Solana route`
      );
    }
    case "NEAR_INTENT": {
      // The wallet doesn't sign anything here — it sends the source-chain
      // tx (handled by quoteIntents path) to the depositAddress and then
      // calls intents/deposit-submit. Caller should switch to the 1Click
      // flow for these.
      throw new Error("Use executeIntentsQuote for NEAR_INTENT-shaped responses");
    }
    case "COSMOS":
    case "UTXO_BUILDER":
      throw new Error(`txType ${txType} not yet supported in v1`);
  }

  const txHash = await broadcastTx(chainKind, args.broadcastRpcUrl, signed.rawTx);
  return { txHash, rawTx: signed.rawTx, built };
}

export interface ExecuteIntentsArgs {
  sessionId: string;
  /** quote.depositAddress from getIntentsQuote response. */
  depositAddress: string;
  /** Source chain — drives signing + broadcast. */
  sourceChain: "EVM" | "BTC" | "SOL" | "NEAR";
  /** Pre-built unsigned source-chain transaction (the wallet builds this with
   *  whatever existing chain logic the project has — see src/wallets/). */
  unsignedSourceTx: unknown;
  broadcastRpcUrl: string;
  account?: number;
  index?: number;
}

/**
 * Execute a NEAR Intents quote: sign + broadcast the source-chain transfer
 * to the depositAddress, then notify 1Click of the txHash so processing
 * starts immediately.
 *
 * Source-chain tx construction is left to the caller because it depends on
 * which chain (and the project already has rich chain-specific logic in
 * src/wallets/). For EVM source, build a {to: depositAddress, value: amount,
 * gas, gasPrice, ...} object and pass it as `unsignedSourceTx`.
 */
export async function executeIntentsQuote(
  args: ExecuteIntentsArgs
): Promise<{ txHash: string }> {
  let signed: SignedHex;
  let chainKind: string;
  switch (args.sourceChain) {
    case "EVM":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signed = await signEvm(args.sessionId, args.unsignedSourceTx as any, args.account, args.index);
      chainKind = "EVM";
      break;
    case "BTC":
      if (typeof args.unsignedSourceTx !== "string") {
        throw new Error("BTC source: unsignedSourceTx must be a hex PSBT string");
      }
      signed = await signPsbt(args.sessionId, args.unsignedSourceTx);
      chainKind = "BTC";
      break;
    default:
      throw new Error(`source chain ${args.sourceChain} not yet supported in v1`);
  }
  const txHash = await broadcastTx(chainKind, args.broadcastRpcUrl, signed.rawTx);
  await notifyIntentsDeposit({
    depositAddress: args.depositAddress,
    txHash,
  });
  return { txHash };
}

/** NEP-413 sign-only helper for raw solver-relay flows (asset already on intents.near). */
export async function signNep413Intent(
  sessionId: string,
  payload: { message: string; nonce: string; recipient: string; callbackUrl?: string }
) {
  return signNearIntent(sessionId, payload);
}

// ---------- status polling ----------

export async function trackSwapKit(
  hashOrDeposit: { hash?: string; chainId?: string; depositAddress?: string }
): Promise<SwapKitTrackResponse> {
  return trackSwapKitSwap(hashOrDeposit);
}

export async function trackIntents(
  depositAddress: string
): Promise<IntentsStatusResponse> {
  return getIntentsStatus(depositAddress);
}

/** Convenience: poll a NEAR Intents deposit until it reaches a terminal state. */
export async function pollIntentsToTerminal(
  depositAddress: string,
  opts?: { intervalMs?: number; timeoutMs?: number; onUpdate?: (s: IntentsStatusResponse) => void }
): Promise<IntentsStatusResponse> {
  const interval = opts?.intervalMs ?? 5_000;
  const timeout = opts?.timeoutMs ?? 600_000;
  const start = Date.now();
  const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeout) {
      throw new Error("intents poll timed out");
    }
    const s = await trackIntents(depositAddress);
    opts?.onUpdate?.(s);
    if (TERMINAL.has(s.status as string)) return s;
    await new Promise((r) => setTimeout(r, interval));
  }
}
