/**
 * TypeScript types for the wallet-proxy contract (§7.3 of IntegrationPlan).
 *
 * These mirror the OpenAPI spec at the field level. They are intentionally
 * hand-written rather than generated so they read cleanly here; if the spec
 * drifts, regenerate via `npx openapi-typescript wallet-proxy.yaml`.
 *
 * The shape on the Rust side (src-tauri/src/swap/proxy.rs) is kept in sync
 * with this file by virtue of both being derived from the same OpenAPI doc.
 */

// ---------- SwapKit ----------

export interface SwapKitQuoteRequest {
  sellAsset: string;
  buyAsset: string;
  sellAmount: string;
  slippage?: number;
  providers?: string[];
  sourceAddress?: string;
  destinationAddress?: string;
  /** Chainflip boost flag — opt in for tighter spreads, may add latency. */
  cfBoost?: boolean;
  /** Cap the total cross-chain settlement window in seconds. */
  maxExecutionTime?: number;
}

/**
 * SwapKit fee block. Two shapes are observed in the wild:
 *
 *   - **Legacy object map** — emitted by the mock-mode proxy (pre-2026-05-25)
 *     and some older SwapKit endpoints. Named keys, optional, string-encoded.
 *   - **Live array of typed entries** — emitted by the post-2026-05-25 live
 *     proxy. Each entry has `{type, amount}` and optionally `amountBps`.
 *     `type` is one of "inbound" | "network" | "outbound" | "service" |
 *     "affiliate" (case-sensitive).
 *
 * The TS union here is intentional — `normalizeSwapKit` detects which shape
 * it's looking at via `Array.isArray(fees)` and parses accordingly. The mock
 * defense-in-depth (`MOCK_SWAPKIT_ROUTE_ID`) is independent and fires on
 * either shape.
 */
export interface SwapKitFeeMap {
  inbound?: string;
  network?: string;
  affiliate?: string;
  service?: string;
  outbound?: string;
}

export interface SwapKitFeeEntry {
  type: string;
  amount: string;
  amountBps?: number;
}

export type SwapKitFee = SwapKitFeeMap | SwapKitFeeEntry[];

export interface SwapKitTimeEst {
  inbound?: number;
  swap?: number;
  outbound?: number;
  total?: number;
}

export interface SwapKitRoute {
  routeId: string;
  providers: string[];
  expectedBuyAmount: string;
  fees?: SwapKitFee;
  estimatedTime?: SwapKitTimeEst;
  warnings?: string[];
  meta?: Record<string, unknown>;
}

export interface SwapKitQuoteResponse {
  quoteId: string;
  routes: SwapKitRoute[];
  nextActions?: { method: string; url: string }[];
  providerErrors?: { provider: string; error: string }[];
}

export interface SwapKitSwapRequest {
  routeId: string;
  sourceAddress: string;
  destinationAddress: string;
}

export type SwapKitTxType =
  | "EVM"
  | "PSBT"
  | "COSMOS"
  | "NEAR_INTENT"
  | "SOLANA"
  | "UTXO_BUILDER";

export interface SwapKitEvmTransaction {
  from?: string;
  to: string;
  value?: string;
  data?: string;
  gas?: number | string;
  gasPrice?: number | string;
  maxFeePerGas?: number | string;
  maxPriorityFeePerGas?: number | string;
  chainId: number;
  nonce?: number | string;
}

export interface SwapKitSwapResponse {
  meta: { txType: SwapKitTxType };
  transaction?: SwapKitEvmTransaction;
  evmTransactionDetails?: {
    contractAddress?: string;
    contractMethod?: string;
    contractParams?: unknown[];
  };
  /** Hex PSBT for UTXO, base64 message for Cosmos/Solana, etc. */
  tx?: string;
  /** NEAR Intents flow only. */
  depositAddress?: string;
  depositMemo?: string;
  targetAddress?: string;
  inboundAddress?: string;
  expectedBuyAmount?: string;
  expiresAt?: string;
}

/** SwapKit /track response — status enum per live docs (lower-case). */
export type SwapKitTrackStatus =
  | "not_started"
  | "pending"
  | "swapping"
  | "completed"
  | "refunded"
  | "unknown"
  | "failed";

export interface SwapKitTrackRequest {
  hash?: string;
  txHash?: string; // legacy alias accepted by the proxy
  chainId?: string;
  depositAddress?: string;
}

export interface SwapKitTrackResponse {
  status: SwapKitTrackStatus;
  legs?: unknown[];
  [k: string]: unknown;
}

// ---------- NEAR Intents 1Click ----------

export type IntentsSwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "ANY_INPUT";
export type IntentsDepositType = "ORIGIN_CHAIN" | "INTENTS";
export type IntentsRecipientType = "DESTINATION_CHAIN" | "INTENTS";
export type IntentsRefundType = "ORIGIN_CHAIN" | "INTENTS";

export interface IntentsQuoteRequest {
  swapType?: IntentsSwapType;
  slippageTolerance?: number; // bps
  originAsset: string;
  depositType?: IntentsDepositType;
  destinationAsset: string;
  recipientType?: IntentsRecipientType;
  amount: string;
  recipient: string;
  refundTo: string;
  refundType?: IntentsRefundType;
  deadline: string; // ISO8601
  quoteWaitingTimeMs?: number;
  /** When true, 1Click simulates the quote without generating a deposit
   *  address. Used by `intents-pair-min-probe.ts` to discover per-pair
   *  minimums without committing solver liquidity. The response in dry
   *  mode omits `depositAddress`, `timeWhenInactive`, and `deadline`. */
  dry?: boolean;
}

export interface IntentsQuote {
  /** Optional in dry-mode responses. Required when the user is actually
   *  going to deposit. Used by the form to validate the quote response
   *  shape before broadcasting. */
  depositAddress?: string;
  depositMemo?: string | null;
  amountIn?: string;
  minAmountIn?: string;
  amountOut?: string;
  minAmountOut?: string;
  amountInUsd?: string;
  amountOutUsd?: string;
  deadline?: string;
  timeEstimate?: number;
}

export interface IntentsQuoteResponse {
  quote: IntentsQuote;
  timestamp?: string;
}

export interface IntentsDepositSubmit {
  depositAddress: string;
  txHash: string;
}

/**
 * Live NEAR Intents status enum — superset of what the plan listed.
 * `KNOWN_DEPOSIT_TX` is intermediate (deposit txhash known, not yet processing);
 * `INCOMPLETE_DEPOSIT` is when the deposit landed but didn't meet quote terms.
 */
export type IntentsStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED";

export interface IntentsStatusResponse {
  status: IntentsStatus;
  [k: string]: unknown;
}

// ---------- Errors ----------

export interface ProxyError {
  error: string;
  message?: string;
  upstreamStatus?: number;
  requestId?: string;
}
