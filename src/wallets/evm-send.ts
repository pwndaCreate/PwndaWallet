/**
 * EVM sends from the Send button: validate, sign ONCE, broadcast the same
 * bytes, settle by hash (2026-09-29 send-safety audit).
 *
 * # Why this exists
 *
 * `createEvmAdapter().sendTransaction` used to run build + sign + broadcast +
 * `tx.wait()` inside the adapter's `withFallback`, which reruns the whole
 * closure on the next RPC after ANY error. Several errors arrive only after a
 * node has already taken the transfer:
 *
 *  - ethers' `broadcastTransaction` batches `eth_blockNumber` with
 *    `eth_sendRawTransaction` and fails the send when that read fails;
 *  - `wait()` opens with an unguarded receipt lookup, and its replacement
 *    check reads the block number and nonce, also unguarded;
 *  - `TRANSACTION_REPLACED`, and a 5xx or timeout on the broadcast reply.
 *
 * The rerun opened a new provider, read `getNonce("pending")` again, signed a
 * NEW transaction and broadcast it. When the next RPC already counted the first
 * one (nonce N+1), that was a second, independent transfer. The audit
 * reproduced it offline against the real adapter: one transient receipt error,
 * two transfers, for native ETH and for USDC, and the UI showed only the second
 * hash. The same loop reported a send that had landed as "Transaction failed"
 * with the form still filled, so one more click paid again; and `wait()` had no
 * timeout, so a dropped transaction left "Sending…" on screen for good.
 *
 * # The rule this module keeps
 *
 *  1. Everything typed is validated before any network call.
 *  2. Nonce, fees and gas limit come from the first node that answers.
 *  3. The transaction is signed exactly once.
 *  4. The SAME bytes go to nodes in turn until one takes them. A node that says
 *     it already has them is checked by hash, never answered with a new
 *     transaction.
 *  5. The receipt is polled within a bounded budget ({@link EVM_SEND_TIMING}).
 *
 * Nothing after step 3 reads a nonce or signs. An outcome that cannot be
 * settled is a `SendOutcomeUnknownError` carrying the hash (`useSend` closes
 * the form on it), never an ordinary failure the user would retry.
 *
 * JSON-RPC goes over `fetch` directly rather than through an ethers provider:
 * the provider's batching and `wait()` internals are where the errors above
 * came from, and a send needs to know exactly which request failed and how.
 * In the webview ethers' own transport is the same `fetch` POST, so CORS and
 * the sandbox's fetch shim see identical traffic.
 */
import { ethers } from "ethers";
import { errorText } from "../lib/errorText";
import { withGasMargin } from "./evm-gas";
import { SendOutcomeUnknownError } from "./send-outcome";
import { STABLECOIN_NETWORKS } from "./stablecoins";
import type { TxResult } from "./types";

/**
 * Timing for one send. Mutable so tests can shrink it, the same pattern as
 * `TRON_EXECUTION_POLL`; production code never writes it.
 */
export const EVM_SEND_TIMING = {
  /** One JSON-RPC request, from `fetch` to a parsed body. */
  requestTimeoutMs: 15_000,
  /** How long to wait for a receipt once a node has taken the transaction. */
  receiptBudgetMs: 90_000,
  /** Pause between receipt polls. */
  pollIntervalMs: 3_000,
};

export type EvmSendTiming = typeof EVM_SEND_TIMING;

/** What the adapter hands over for one send. */
export interface EvmTransferArgs {
  privateKey: string;
  /** The recipient exactly as typed. */
  to: string;
  /** The amount exactly as typed, in display units. */
  amount: string;
  /** RPC endpoints, in priority order. */
  urls: readonly string[];
  /** Expected chain id. A node answering for another chain is skipped. */
  chainId?: number;
  /** Network name for messages ("Arbitrum", not "USDC (Arbitrum)"). */
  chainName: string;
  /** What is being sent ("USDC", "ETH"). */
  ticker: string;
  /** The coin that pays the fee on this network ("ETH" on Arbitrum). */
  gasTicker: string;
  /** ERC-20 contract when sending a token; absent for the native coin. */
  tokenContract?: string;
  /** Decimals of what is being sent (18 for a native coin). */
  decimals: number;
}

// ── 1. Input, before any network call ──────────────────────────────────────

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The recipient as a checksummed address, or a plain-language refusal.
 *
 * Before 2026-09-29 the typed text went straight to ethers. A trailing space,
 * a missing `0x` or a non-EVM address was taken for an ENS name and failed with
 * `network does not support ENS`; the zero address and token contracts were
 * accepted. USDT on Ethereum takes a transfer to 0x0 and to its own contract,
 * USDT/USDC on BNB Chain and USDT on Optimism to their own contracts, and a
 * native coin sent to 0x0 is burned. Every contract in the stablecoin registry
 * is refused on every chain: none is ever a sensible destination.
 */
export function parseEvmRecipient(
  raw: string,
  ctx: { chainName: string; ticker: string; tokenContract?: string },
): string {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("Enter the recipient's address.");
  if (!HEX_ADDRESS.test(s)) {
    if (/^[0-9a-fA-F]{40}$/.test(s)) {
      throw new Error(
        "That address is missing its 0x prefix. Paste the full address, starting with 0x.",
      );
    }
    if (s.includes(".")) {
      throw new Error(
        "Names like example.eth are not supported. Paste the recipient's 0x address.",
      );
    }
    throw new Error(
      `That is not a valid address on ${ctx.chainName}. It should be 0x followed by 40 hexadecimal characters (0-9, a-f).`,
    );
  }
  let address: string;
  try {
    address = ethers.getAddress(s);
  } catch {
    // Mixed case is an EIP-55 checksum, and this one does not match: a
    // character changed somewhere between the source and this field.
    throw new Error(
      "That address fails its checksum, so at least one character is wrong. Copy it again from the source.",
    );
  }
  if (address === ethers.ZeroAddress) {
    throw new Error(
      "That is the zero address. Anything sent to it is burned: nobody can ever spend it.",
    );
  }
  const lower = address.toLowerCase();
  if (ctx.tokenContract && lower === ctx.tokenContract.toLowerCase()) {
    throw new Error(
      `That address is the ${ctx.ticker} token contract itself, not a wallet. Tokens sent to it are lost. Paste the recipient's own address.`,
    );
  }
  const row = STABLECOIN_NETWORKS.find((n) => n.contract.toLowerCase() === lower);
  if (row) {
    throw new Error(
      `That address is the ${row.symbol} token contract on ${row.network}, not a wallet. A send to it is lost or refused. Paste the recipient's own address.`,
    );
  }
  return address;
}

/**
 * The amount in base units, exactly, or a plain-language refusal.
 *
 * Replaces raw ethers text (`invalid FixedNumber string value` for "1,5",
 * `too many decimals for format`) and refuses zero, which was accepted and
 * spent a fee to move nothing.
 */
export function parseEvmAmount(raw: string, decimals: number, ticker: string): bigint {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("Enter an amount.");
  if (s.includes(",")) {
    throw new Error("Use a dot for decimals and no thousands separators: 1.5, not 1,5.");
  }
  if (s.startsWith("-")) throw new Error("The amount must be greater than zero.");
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) {
    throw new Error("Enter the amount as a plain number, like 0.25.");
  }
  // Trailing zeros past the precision are harmless (ethers accepts them);
  // any other digit there would be silently dropped, so it is refused.
  const fraction = s.split(".")[1] ?? "";
  if (/[1-9]/.test(fraction.slice(decimals))) {
    throw new Error(`${ticker} has at most ${decimals} decimal places.`);
  }
  let units: bigint;
  try {
    units = ethers.parseUnits(s, decimals);
  } catch {
    throw new Error("Enter the amount as a plain number, like 0.25.");
  }
  if (units <= 0n) throw new Error("The amount must be greater than zero.");
  return units;
}

// ── JSON-RPC over fetch ────────────────────────────────────────────────────

/** A node answered with a JSON-RPC error: it read the request and said no. */
class EvmRpcError extends Error {
  readonly host: string;
  readonly code: number | undefined;
  readonly data: unknown;
  readonly httpStatus: number;
  constructor(host: string, code: number | undefined, message: string, data: unknown, httpStatus: number) {
    super(message || `JSON-RPC error ${code ?? "(no code)"}`);
    this.name = "EvmRpcError";
    this.host = host;
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}

/**
 * No JSON-RPC answer at all: a network failure, a timeout, an HTTP error, or a
 * body that is not JSON-RPC. `httpStatus` is set when a status arrived.
 */
class EvmTransportError extends Error {
  readonly host: string;
  readonly httpStatus: number | undefined;
  constructor(host: string, message: string, httpStatus?: number) {
    super(message);
    this.name = "EvmTransportError";
    this.host = host;
    this.httpStatus = httpStatus;
  }
}

/** A refusal every node would repeat: the send stops, nothing was signed. */
class TransferRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferRefusedError";
  }
}

/** Host only: an env-override RPC URL can carry an API key in its path. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

function clip(s: string, max = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

let rpcId = 0;

async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<unknown> {
  const host = hostOf(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new EvmTransportError(
        host,
        ctrl.signal.aborted
          ? `no answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`
          : `request failed (${clip(errorText(e), 80)})`,
      );
    }
    let text: string;
    try {
      text = await resp.text();
    } catch (e) {
      throw new EvmTransportError(
        host,
        ctrl.signal.aborted ? "the answer did not arrive in time" : "the answer was cut off",
        resp.status,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const err = (body as { error?: unknown }).error;
      if (err && typeof err === "object") {
        const { code, message, data } = err as { code?: unknown; message?: unknown; data?: unknown };
        throw new EvmRpcError(
          host,
          typeof code === "number" ? code : undefined,
          typeof message === "string" ? message : "",
          data,
          resp.status,
        );
      }
    }
    if (!resp.ok) throw new EvmTransportError(host, `HTTP ${resp.status}`, resp.status);
    if (!body || typeof body !== "object" || Array.isArray(body) || !("result" in body)) {
      throw new EvmTransportError(host, "the answer is not JSON-RPC", resp.status);
    }
    return (body as { result: unknown }).result;
  } finally {
    clearTimeout(timer);
  }
}

function quantity(v: unknown, host: string, what: string): bigint {
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  throw new EvmTransportError(host, `${what} answered ${clip(JSON.stringify(v) ?? String(v), 60)}`);
}

function settled<T>(r: PromiseSettledResult<T>): T {
  if (r.status === "fulfilled") return r.value;
  throw r.reason;
}

function optionalQuantity(r: PromiseSettledResult<unknown>): bigint | null {
  if (r.status !== "fulfilled") return null;
  const v = r.value;
  return typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null;
}

function rpcErrorText(e: EvmRpcError): string {
  let data = "";
  if (typeof e.data === "string") data = e.data;
  else if (e.data != null) {
    try {
      data = JSON.stringify(e.data);
    } catch {
      data = "";
    }
  }
  return `${e.message} ${data}`.toLowerCase();
}

// ── Classifying a node's answer ────────────────────────────────────────────

/**
 * What a failed `eth_sendRawTransaction` says about THIS node and our bytes.
 *
 *  - `known`: the node already has a transaction with this hash, or its nonce
 *    is spent. Ours may be out there; the hash lookup decides.
 *  - `rejected`: the transaction fails a check every node applies to the same
 *    chain state. This node did not take it, and no other would.
 *  - `refused`: this endpoint declined the request without taking it: auth,
 *    rate limit, a disabled method, local fee policy, another chain.
 *  - `ambiguous`: anything else, including every transport failure. The node
 *    may have taken it.
 */
type Verdict = "known" | "rejected" | "refused" | "ambiguous";

interface Attempt {
  host: string;
  verdict: Verdict;
  detail: string;
}

const KNOWN_RE =
  /already known|known transaction|already imported|alreadyknown|already exists|already in (?:the )?(?:mempool|pool|txpool)|nonce too low|nonce has already been used|oldnonce|replacement transaction underpriced|replacement fee too low|replacement_underpriced/;

// `insufficient ?funds`: geth says "insufficient funds", Nethermind-style
// clients "InsufficientFunds". Missing the second would turn a plain refusal
// into "may have been sent".
const INSUFFICIENT_RE = /insufficient ?funds|insufficient balance/i;

const REJECTED_RE =
  /insufficient ?funds|insufficient balance|intrinsic gas|exceeds block gas limit|invalid signature|nonce too high/;

const REFUSED_RE =
  /unauthori[sz]ed|api key|forbidden|rate limit|too many requests|limit exceeded|quota|cannot fulfill request|tenant disabled|method not found|does not exist|not available|not supported|not allowed|whitelist|payment required|underpriced|fee too low|gas price too low|base fee|fee cap|priority fee|configured cap|pool is full|chain ?id|replay-protected|eip-?155|invalid sender|oversized|too large/;

/** Cloudflare's "could not reach the origin" statuses: the node never saw it. */
const ORIGIN_UNREACHABLE = new Set([521, 522, 523, 525, 526]);

function refusedStatus(s: number | undefined): boolean {
  if (s == null) return false;
  return (s >= 400 && s < 500 && s !== 408) || ORIGIN_UNREACHABLE.has(s);
}

function classifyBroadcastError(e: unknown): { verdict: Verdict; detail: string } {
  if (e instanceof EvmRpcError) {
    const text = rpcErrorText(e);
    const detail = clip(e.message);
    if (KNOWN_RE.test(text)) return { verdict: "known", detail };
    if (REJECTED_RE.test(text)) return { verdict: "rejected", detail };
    if (REFUSED_RE.test(text) || e.code === -32601 || e.code === -32005 || e.code === 429) {
      return { verdict: "refused", detail };
    }
    if (refusedStatus(e.httpStatus)) return { verdict: "refused", detail };
    return { verdict: "ambiguous", detail };
  }
  if (e instanceof EvmTransportError) {
    return { verdict: refusedStatus(e.httpStatus) ? "refused" : "ambiguous", detail: e.message };
  }
  return { verdict: "ambiguous", detail: clip(errorText(e)) };
}

function isDefinitive(a: Attempt): boolean {
  return a.verdict === "rejected" || a.verdict === "refused";
}

function insufficientFundsText(args: EvmTransferArgs): string {
  return args.tokenContract
    ? `Not enough ${args.gasTicker} on ${args.chainName} to pay the network fee for this transfer. Nothing was sent.`
    : `Not enough ${args.gasTicker} on ${args.chainName} to cover this amount plus the network fee. Nothing was sent.`;
}

function definitiveText(a: Attempt, args: EvmTransferArgs): string {
  if (a.verdict === "rejected") {
    return INSUFFICIENT_RE.test(a.detail)
      ? insufficientFundsText(args)
      : `The ${args.chainName} network refused this transaction (${a.host}: ${a.detail}). Nothing was sent.`;
  }
  return `No ${args.chainName} node would take this transaction (${a.host}: ${a.detail}). Nothing was sent.`;
}

/** Revert data, wherever this node put it. */
function revertData(d: unknown): string | null {
  if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d)) return d;
  if (d && typeof d === "object") {
    const inner = (d as { data?: unknown }).data;
    if (typeof inner === "string" && /^0x[0-9a-fA-F]*$/.test(inner)) return inner;
  }
  return null;
}

function revertReason(e: EvmRpcError): string | null {
  const data = revertData(e.data);
  if (data) {
    const selector = data.slice(0, 10).toLowerCase();
    if (selector === "0x08c379a0") {
      // Error(string)
      try {
        const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10));
        if (typeof reason === "string" && reason.trim()) return clip(reason, 120);
      } catch {
        /* undecodable: fall back to the message */
      }
    }
    // OpenZeppelin 5's ERC20InsufficientBalance(address,uint256,uint256).
    if (selector === "0xe450d38c") return "insufficient token balance";
  }
  const m = /reverted:\s*(.+)$/i.exec(e.message);
  return m && m[1].trim() ? clip(m[1], 120) : null;
}

/**
 * An `eth_estimateGas` failure every honest node would repeat: the transfer
 * itself cannot succeed. `null` for anything else (the next node is asked).
 */
function estimateRefusal(e: unknown, args: EvmTransferArgs): string | null {
  if (!(e instanceof EvmRpcError)) return null;
  const text = rpcErrorText(e);
  if (INSUFFICIENT_RE.test(text)) {
    return args.tokenContract
      ? insufficientFundsText(args)
      : `Not enough ${args.ticker} on ${args.chainName} for this amount and its network fee. Nothing was sent.`;
  }
  if (
    e.code === 3 ||
    /revert|invalid opcode|out of gas|gas required exceeds allowance|always failing/.test(text)
  ) {
    if (args.tokenContract) {
      // The reason text comes from the token contract this adapter is
      // configured with, so it is shown ("ERC20: transfer amount exceeds
      // balance").
      const reason = revertReason(e);
      return `The ${args.ticker} contract refused this transfer${reason ? ` (${reason})` : ""}. Nothing was sent.`;
    }
    // A native send reverts only in a contract at the recipient address. Its
    // revert text is whatever that contract chose to say, so it is not shown.
    return `The recipient address is a contract that refused this ${args.ticker} transfer. Nothing was sent.`;
  }
  return null;
}

// ── 2. Nonce, fees and gas from the first node that answers ────────────────

type Fee =
  | { type: 2; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { type: 0; gasPrice: bigint };

interface Prepared {
  chainId: bigint;
  nonce: number;
  gasLimit: bigint;
  fee: Fee;
}

interface Transfer {
  to: string;
  value: bigint;
  data: string;
}

async function prepareOn(
  url: string,
  from: string,
  tx: Transfer,
  args: EvmTransferArgs,
  timing: EvmSendTiming,
): Promise<Prepared> {
  const host = hostOf(url);
  const t = timing.requestTimeoutMs;
  const call: Record<string, string> = { from, to: tx.to };
  if (tx.value > 0n) call.value = ethers.toQuantity(tx.value);
  if (tx.data !== "0x") call.data = tx.data;

  const [chainIdR, nonceR, blockR, gasPriceR, tipR, estimateR] = await Promise.allSettled([
    rpcCall(url, "eth_chainId", [], t),
    rpcCall(url, "eth_getTransactionCount", [from, "pending"], t),
    rpcCall(url, "eth_getBlockByNumber", ["latest", false], t),
    rpcCall(url, "eth_gasPrice", [], t),
    rpcCall(url, "eth_maxPriorityFeePerGas", [], t),
    rpcCall(url, "eth_estimateGas", [call], t),
  ]);

  // Chain first: a node on another chain is a wrong source for everything,
  // including a refusal.
  const chainId = quantity(settled(chainIdR), host, "eth_chainId");
  if (args.chainId != null && chainId !== BigInt(args.chainId)) {
    throw new EvmTransportError(host, `answers for chain ${chainId}, not ${args.chainId}`);
  }
  if (estimateR.status === "rejected") {
    const refusal = estimateRefusal(estimateR.reason, args);
    if (refusal) throw new TransferRefusedError(refusal);
    throw estimateR.reason;
  }
  const gasLimit = withGasMargin(quantity(estimateR.value, host, "eth_estimateGas"));
  const nonce = quantity(settled(nonceR), host, "eth_getTransactionCount");

  // The fee rule ethers' getFeeData + populateTransaction applied before this
  // change, kept as it was: EIP-1559 when the latest block has a non-zero base
  // fee (max fee = 2 x base + tip, tip defaulting to 1 gwei when the node has
  // no eth_maxPriorityFeePerGas), otherwise a legacy gas price. A zero base
  // fee (BNB Chain) is legacy, as it was.
  const block = settled(blockR) as { baseFeePerGas?: unknown } | null;
  const baseFee =
    block && typeof block === "object" && block.baseFeePerGas != null
      ? quantity(block.baseFeePerGas, host, "baseFeePerGas")
      : null;
  const gasPrice = optionalQuantity(gasPriceR);
  const tip = optionalQuantity(tipR);
  let fee: Fee;
  if (baseFee != null && baseFee > 0n) {
    const maxPriorityFeePerGas = tip ?? 1_000_000_000n;
    fee = { type: 2, maxPriorityFeePerGas, maxFeePerGas: baseFee * 2n + maxPriorityFeePerGas };
  } else if (gasPrice != null) {
    fee = { type: 0, gasPrice };
  } else {
    throw new EvmTransportError(host, "gave no fee data");
  }
  return { chainId, nonce: Number(nonce), gasLimit, fee };
}

async function prepare(
  args: EvmTransferArgs,
  from: string,
  tx: Transfer,
  timing: EvmSendTiming,
): Promise<Prepared> {
  const failures: string[] = [];
  for (const url of args.urls) {
    try {
      return await prepareOn(url, from, tx, args, timing);
    } catch (e) {
      // Deterministic: another node would say the same, and shopping for one
      // that disagrees is how a real refusal turns into a transport error.
      if (e instanceof TransferRefusedError) throw e;
      failures.push(`${hostOf(url)}: ${clip(errorText(e), 100)}`);
      console.warn(`[evm-send] ${args.chainName}: could not prepare on ${hostOf(url)}:`, errorText(e));
    }
  }
  throw new Error(
    `Could not reach any ${args.chainName} node to prepare this transaction (${failures[0] ?? "no endpoint configured"}). Nothing was sent.`,
  );
}

// ── 4. The same bytes, node by node ────────────────────────────────────────

/** The first endpoint that has the transaction, or null. */
async function findTransaction(
  hash: string,
  urls: readonly string[],
  timing: EvmSendTiming,
): Promise<string | null> {
  for (const url of urls) {
    try {
      const tx = await rpcCall(url, "eth_getTransactionByHash", [hash], timing.requestTimeoutMs);
      if (
        tx &&
        typeof tx === "object" &&
        typeof (tx as { hash?: unknown }).hash === "string" &&
        (tx as { hash: string }).hash.toLowerCase() === hash.toLowerCase()
      ) {
        return url;
      }
    } catch {
      /* a lookup that fails proves nothing either way */
    }
  }
  return null;
}

/**
 * Hand the signed bytes to nodes in turn until one takes them. Returns the URL
 * that did; throws an ordinary Error only when nothing can have gone out.
 */
async function broadcast(
  raw: string,
  hash: string,
  args: EvmTransferArgs,
  timing: EvmSendTiming,
): Promise<string> {
  const attempts: Attempt[] = [];
  for (const url of args.urls) {
    const host = hostOf(url);
    let attempt: Attempt;
    try {
      const result = await rpcCall(url, "eth_sendRawTransaction", [raw], timing.requestTimeoutMs);
      if (typeof result === "string" && result.toLowerCase() === hash.toLowerCase()) return url;
      // A success that names another transaction. Whatever this node did with
      // our bytes, it cannot be read as "taken": ask the next one.
      attempt = {
        host,
        verdict: "ambiguous",
        detail: `answered with a different hash (${clip(String(result), 70)})`,
      };
    } catch (e) {
      attempt = { host, ...classifyBroadcastError(e) };
    }
    attempts.push(attempt);
    console.warn(`[evm-send] ${args.chainName}: broadcast via ${host}: ${attempt.verdict}: ${attempt.detail}`);

    if (attempt.verdict === "known" && (await findTransaction(hash, [url], timing))) return url;

    // Stop at the first rejection while every earlier node also declined
    // outright: nothing can have gone out, and a flaky node further down the
    // list would otherwise turn "not enough ETH" into "may have been sent".
    if (attempt.verdict === "rejected" && attempts.every(isDefinitive)) {
      throw new Error(definitiveText(attempt, args));
    }
  }

  // No node took it outright.
  if (attempts.every(isDefinitive)) {
    const first = attempts.find((a) => a.verdict === "rejected") ?? attempts[0];
    throw new Error(definitiveText(first, args));
  }
  const via = await findTransaction(hash, args.urls, timing);
  if (via) return via;
  // `useSend` shows this inside parentheses after its own "may have been
  // sent" sentence, so it is one flat clause.
  const summary = attempts
    .slice(0, 3)
    .map((a) => `${a.host}: ${a.detail}`)
    .join("; ");
  throw new SendOutcomeUnknownError(
    `no ${args.chainName} node confirmed it, and at least one may have taken it: ${summary}`,
    hash,
  );
}

// ── 5. The receipt, within the budget ──────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A settled result for a receipt, `null` while there is none. */
function settleReceipt(r: unknown, hash: string, args: EvmTransferArgs): TxResult | null {
  if (r == null || typeof r !== "object") return null;
  const rec = r as { status?: unknown; blockNumber?: unknown; transactionHash?: unknown };
  if (typeof rec.transactionHash === "string" && rec.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    return null;
  }
  if (rec.blockNumber == null) return null;
  const status =
    typeof rec.status === "number"
      ? BigInt(rec.status)
      : typeof rec.status === "string" && /^0x[0-9a-fA-F]+$/.test(rec.status)
        ? BigInt(rec.status)
        : null;
  if (status === 1n) return { hash };
  if (status === 0n) {
    // Decided and final, so an ordinary Error; it names the hash so the user
    // can see the fee was spent.
    throw new Error(
      `Transaction ${hash} was included in a block but reverted: the ${args.amount.trim()} ${args.ticker} was not sent, and the network fee was spent.`,
    );
  }
  // Included, outcome not stated. Not called "sent".
  return { hash, pending: true };
}

async function awaitReceipt(
  hash: string,
  via: string,
  args: EvmTransferArgs,
  timing: EvmSendTiming,
): Promise<TxResult> {
  const order = [via, ...args.urls.filter((u) => u !== via)];
  const deadline = Date.now() + timing.receiptBudgetMs;
  for (let round = 0; ; round++) {
    // One answer per round, rotating the starting node so a lagging node
    // cannot hide the receipt for the whole budget. A node that errors hands
    // the round to the next one. Nothing here signs or broadcasts.
    for (let i = 0; i < order.length; i++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { hash, pending: true };
      const url = order[(round + i) % order.length];
      let receipt: unknown;
      try {
        receipt = await rpcCall(
          url,
          "eth_getTransactionReceipt",
          [hash],
          Math.min(timing.requestTimeoutMs, remaining),
        );
      } catch (e) {
        console.warn(`[evm-send] ${args.chainName}: receipt poll via ${hostOf(url)} failed:`, errorText(e));
        continue;
      }
      const result = settleReceipt(receipt, hash, args);
      if (result) return result;
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { hash, pending: true };
    await sleep(Math.min(timing.pollIntervalMs, remaining));
  }
}

// ── The send ───────────────────────────────────────────────────────────────

const ERC20_TRANSFER = new ethers.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/**
 * Send `args.amount` of the native coin or of `args.tokenContract` to
 * `args.to`. Resolves `{ hash }` once a receipt shows success, or
 * `{ hash, pending: true }` when a node took the transaction and the budget
 * ran out first. Throws an ordinary Error when nothing was sent (or when the
 * transaction reverted, naming its hash), and `SendOutcomeUnknownError` when
 * it may have been sent.
 */
export async function sendEvmTransfer(
  args: EvmTransferArgs,
  timing: EvmSendTiming = EVM_SEND_TIMING,
): Promise<TxResult> {
  // 1. Everything typed, before any network call.
  const recipient = parseEvmRecipient(args.to, args);
  const units = parseEvmAmount(args.amount, args.decimals, args.ticker);
  if (args.urls.length === 0) {
    throw new Error(`No ${args.chainName} RPC endpoint is configured. Nothing was sent.`);
  }
  const wallet = new ethers.Wallet(args.privateKey);
  const tx: Transfer = args.tokenContract
    ? {
        to: ethers.getAddress(args.tokenContract),
        value: 0n,
        data: ERC20_TRANSFER.encodeFunctionData("transfer", [recipient, units]),
      }
    : { to: recipient, value: units, data: "0x" };

  // 2. Nonce, fees and gas limit. Read-only, so trying another node is safe.
  const prepared = await prepare(args, wallet.address, tx, timing);

  // 3. Sign ONCE. Every broadcast below sends these exact bytes.
  const raw = await wallet.signTransaction({
    chainId: prepared.chainId,
    nonce: prepared.nonce,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gasLimit: prepared.gasLimit,
    ...(prepared.fee.type === 2
      ? {
          type: 2,
          maxFeePerGas: prepared.fee.maxFeePerGas,
          maxPriorityFeePerGas: prepared.fee.maxPriorityFeePerGas,
        }
      : { type: 0, gasPrice: prepared.fee.gasPrice }),
  });
  const hash = ethers.keccak256(raw);

  // 4. Broadcast the same bytes until a node takes them.
  const via = await broadcast(raw, hash, args, timing);

  // 5. Wait for the receipt, bounded. Never re-read the nonce, never re-sign.
  return awaitReceipt(hash, via, args, timing);
}
