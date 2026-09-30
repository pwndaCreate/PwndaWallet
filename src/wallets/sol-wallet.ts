import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  type AccountInfo,
  type SignatureStatus,
  type TransactionError,
  type TransactionInstruction,
} from "@solana/web3.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { base58 } from "@scure/base";
import { derivePath } from "ed25519-hd-key";
import { Buffer } from "buffer";
import { invoke } from "../lib/tauri";
import { errorText } from "../lib/errorText";
import { atomicToDecimal, decimalToAtomic } from "./decimal-amount";
import { SendOutcomeUnknownError } from "./send-outcome";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
} from "./types";

/**
 * Solana public RPC endpoints, raced in parallel.
 *
 * Every entry — including `api.mainnet-beta.solana.com` — rejects POSTs that
 * carry a browser `Origin` header (Tauri's webview is `tauri://localhost`)
 * with HTTP 403 "Access forbidden". To get past that, all RPC traffic is
 * routed through the Rust backend's `sol_rpc_call` command (see
 * `src-tauri/src/sol_rpc.rs`), which uses reqwest and so presents as an
 * ordinary HTTP client with no browser origin attached.
 *
 * `runOnAnyRpc` races all entries in parallel and returns the first
 * success, so a slow endpoint at the head of the list doesn't gate the
 * others. The list was expanded twice: 4 → 7 → 11 after users reported
 * balance lookups timing out when the original endpoints were all
 * rate-limited or transiently down.
 *
 * Endpoint roster as of 2026-05-07. All public, no API key required.
 * Verified by inspection of each provider's published rate-limit /
 * authentication policy at the date listed.
 *
 *   solana-rpc.publicnode.com           — Allnodes, ~100 req/s free
 *   rpc.ankr.com/solana                 — Ankr free tier, ~30 req/s, often 429s under load
 *   solana.drpc.org                     — dRPC decentralized, free tier ~10k req/day
 *   api.mainnet-beta.solana.com         — Solana Foundation, very rate-limited but always there
 *   solana-mainnet.rpc.extrnode.com     — Everstake, generous free tier
 *   solana.api.onfinality.io/public     — OnFinality, ~500 req/min
 *   endpoints.omniatech.io/v1/sol/mainnet/public — Omnia, unlimited free reads
 *   solana.blockpi.network/v1/rpc/public  — BlockPI, ~100 req/min                 (added 2026-05-07)
 *   mainnet.helius-rpc.com              — Helius public tier (no key for read methods) (added 2026-05-07)
 *   solana-mainnet.g.alchemy.com/v2/demo — Alchemy demo, very rate-limited fallback (added 2026-05-07)
 *   api.tatum.io/v3/blockchain/node/solana-mainnet — Tatum free public mirror      (added 2026-05-07)
 *
 * If a future provider asks Pwnda to add an API-key-gated endpoint,
 * keep this list public-only and add the keyed endpoint as a
 * separately-configured option in Settings → RPC.
 */
const RPC_URLS = [
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
  "https://solana.drpc.org",
  "https://api.mainnet-beta.solana.com",
  "https://solana-mainnet.rpc.extrnode.com",
  "https://solana.api.onfinality.io/public",
  "https://endpoints.omniatech.io/v1/sol/mainnet/public",
  "https://solana.blockpi.network/v1/rpc/public",
  "https://mainnet.helius-rpc.com",
  "https://solana-mainnet.g.alchemy.com/v2/demo",
  "https://api.tatum.io/v3/blockchain/node/solana-mainnet",
];

/** Per-attempt RPC timeout. Sticky routing tries one endpoint at a time
 *  with this short cap so a slow endpoint can't hold the user. Successful
 *  Solana RPC calls usually return in <500ms; 4s rotates fast on a slow
 *  endpoint without false-failing healthy ones. */
const PER_RPC_TIMEOUT_MS = 4000;

const DERIVATION_PATH = "m/44'/501'/0'/0'";

/**
 * Custom fetch passed to `@solana/web3.js` `Connection`. Forwards the POST
 * body to the Rust proxy and rebuilds a `Response` from the (status, body)
 * pair so web3.js's existing 4xx/5xx handling works unchanged — a 403 still
 * surfaces as a thrown error, which `runOnAnyRpc` catches and rotates past.
 */
const tauriSolanaFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  const rawBody = init?.body ?? "";
  const bodyStr =
    typeof rawBody === "string"
      ? rawBody
      : rawBody instanceof ArrayBuffer
        ? new TextDecoder().decode(rawBody)
        : rawBody instanceof Uint8Array
          ? new TextDecoder().decode(rawBody)
          : String(rawBody);
  const { status, body } = await invoke<{ status: number; body: string }>(
    "sol_rpc_call",
    { url, body: bodyStr },
  );
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

/** Cache `Connection` objects by URL — web3.js's Connection holds an
 *  internal RPC client and caches behavior, so reusing the instance
 *  across calls is materially faster than rebuilding per attempt. */
const connectionCache = new Map<string, Connection>();
function makeConnection(url: string): Connection {
  let conn = connectionCache.get(url);
  if (!conn) {
    conn = new Connection(url, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 30000,
      fetch: tauriSolanaFetch,
      // CRITICAL: web3.js has a hardcoded internal 429-retry with
      // exponential backoff (500ms → 1s → 2s → 4s = ~7.5s total) per
      // failed call. With multiple endpoints under rate-limit pressure,
      // this multiplied requests by 4× and amplified the cascade. We
      // turn it off and let our own sticky-routing rotate to a new URL
      // immediately on 429, which is gentler on the RPC providers and
      // faster for the user. The flag is documented at:
      //   https://solana-labs.github.io/solana-web3.js/types/ConnectionConfig.html
      disableRetryOnRateLimit: true,
    });
    connectionCache.set(url, conn);
  }
  return conn;
}

/** What a Solana history row needs from a parsed transaction. */
export interface SolTxSummary {
  /** Lamport delta on the queried account (post - pre). */
  net: number;
  /** Lamports, when the transaction reports a fee. */
  fee?: number;
}

/**
 * Reduce a `getParsedTransaction` result to the two numbers a history row
 * uses. `null` when there is no transaction to read (not yet available, or the
 * lookup failed) - such a result must never be cached.
 */
export function summarizeParsedTx(tx: any, address: string): SolTxSummary | null {
  if (!tx) return null;
  const meta = tx.meta;
  // Net SOL delta on our account = postBalance - preBalance for the
  // index where account == us. `accountKeys` order matches `balances`.
  let net = 0;
  try {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const idx = keys.findIndex((k: any) => k.pubkey?.toBase58?.() === address);
    if (
      idx !== -1 &&
      meta?.preBalances?.[idx] !== undefined &&
      meta?.postBalances?.[idx] !== undefined
    ) {
      net = meta.postBalances[idx] - meta.preBalances[idx];
    }
  } catch {
    /* leave net=0 */
  }
  return { net, fee: typeof meta?.fee === "number" ? meta.fee : undefined };
}

/**
 * Bounded cache of parsed-transaction summaries for FINALIZED signatures,
 * keyed by (address, signature) because the net amount depends on which
 * account is asking. Insertion-ordered; the oldest entry is evicted past
 * `max`. RAM plan 3.6 - see `getTransactionHistory`.
 */
export function createSolParsedCache(max = 2_000) {
  const map = new Map<string, SolTxSummary>();
  const k = (address: string, signature: string) => `${address}|${signature}`;
  return {
    get(address: string, signature: string): SolTxSummary | undefined {
      return map.get(k(address, signature));
    },
    set(address: string, signature: string, v: SolTxSummary): void {
      const key = k(address, signature);
      map.delete(key);
      map.set(key, v);
      while (map.size > max) map.delete(map.keys().next().value as string);
    },
    get size() {
      return map.size;
    },
  };
}

const solParsedCache = createSolParsedCache();

/** Sticky-routing cache. The last URL that succeeded is tried first on
 *  the next call, so when one endpoint is reachable + healthy we stop
 *  hammering the others. Reset to `null` whenever the sticky URL fails
 *  so the next call starts fresh from the head of `RPC_URLS`.
 *
 *  This dramatically reduces the request rate hitting the RPC fleet:
 *  the previous parallel-race-of-11 fired 11 requests per call and
 *  triggered every endpoint's rate-limit simultaneously, then web3.js's
 *  internal retry doubled that. Sticky routing fires 1 request per call
 *  on the happy path. */
let stickyUrl: string | null = null;

/**
 * Wrap a promise with a timeout. Resolves the original on success;
 * rejects with a timeout error if `ms` elapses first. Used in
 * `runOnAnyRpc` so a slow endpoint can't gate the parallel race —
 * the runner moves on to whichever endpoint responds first.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout (${ms}ms) on ${label}`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Run an RPC operation against ALL endpoints in parallel and return
 * the first successful result. If every endpoint fails, throws an
 * aggregate Error listing each endpoint's failure for diagnostics.
 *
 * Why parallel race instead of sequential rotate-on-failure: when the
 * first endpoint hangs (e.g. publicnode rate-limiting silently for
 * tens of seconds), the sequential loop blocks for the full per-call
 * timeout × 4 ≈ 30+ seconds before trying the second. Racing fans
 * the request out so the slowest endpoint never gates the user.
 *
 * The downside is a small extra load on every RPC. For wallet-app
 * volumes (a few balance reads per session) this is negligible and
 * the public RPC providers expect this exact pattern from web3.js
 * users. If a future revision wants to reduce fan-out, switch back
 * to sequential with a much shorter per-attempt timeout (~3s).
 */
/**
 * Run an RPC operation through the sticky URL, falling back to sequential
 * rotation through the rest only on failure. Sticky-routing is much
 * gentler on rate-limited free RPCs than parallel racing: one request per
 * call on the happy path, ≤ N requests on the unhappy path where N is
 * the position of the next-healthy endpoint.
 *
 * Why we don't race:
 *   - Free RPC providers rate-limit per IP. A wallet that fans out 11
 *     requests for every balance read trips every provider's rate limit
 *     simultaneously, leaving the user with no working endpoint.
 *   - web3.js's `Connection` had its own internal 429-retry with
 *     exponential backoff. Combined with our parallel race that meant
 *     11 endpoints × 4 internal retries = 44 requests per call. The
 *     internal retry is now disabled (see `makeConnection`) but the
 *     parallel-race amplification was the bigger problem.
 *
 * Sequential ordering: sticky URL first, then the declared `RPC_URLS`
 * order. The first endpoint to succeed becomes the new sticky URL. On
 * any 429 / timeout / transport error, rotate to the next URL.
 */
/** Exported so the SPL token adapters share the SAME sticky routing, the
 *  same Tauri fetch shim and the same rate-limit handling as native SOL.
 *  A token leg that opened its own Connection would double the request rate
 *  against endpoints this file already documents as easy to trip. */
export { runOnAnyRpc as runOnAnySolanaRpc };

/** The try-order: sticky URL first (if known and still in the roster), then
 *  everything else in declared order. Shared by reads and by the send path. */
function rpcOrder(): string[] {
  return stickyUrl && RPC_URLS.includes(stickyUrl)
    ? [stickyUrl, ...RPC_URLS.filter((u) => u !== stickyUrl)]
    : [...RPC_URLS];
}

/**
 * For READS only. Each endpoint gets `PER_RPC_TIMEOUT_MS`, and a timed-out
 * attempt is abandoned, not cancelled — harmless for a read, and exactly why
 * nothing that signs or broadcasts may run inside it (2026-09-29 send-safety
 * audit; see `submitSolanaTransaction`).
 */
async function runOnAnyRpc<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
  const order = rpcOrder();

  const failures: { url: string; error: string }[] = [];
  for (const url of order) {
    try {
      const result = await withTimeout(
        fn(makeConnection(url)),
        PER_RPC_TIMEOUT_MS,
        url
      );
      // Successful — promote this URL to the sticky cache for the next
      // call. Subsequent calls in the same session will go to it first.
      stickyUrl = url;
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ url, error: msg });
      // If the sticky URL fails, demote it so the next call starts from
      // RPC_URLS[0] instead of repeatedly hitting the bad endpoint.
      if (url === stickyUrl) stickyUrl = null;
      // Continue to next endpoint.
    }
  }

  // eslint-disable-next-line no-console
  console.warn(
    "[sol-wallet] All Solana RPC endpoints failed:",
    failures
  );
  const lines = failures.map((f) => `  ${f.url}: ${f.error}`).join("\n");
  throw new Error(
    `All Solana RPC endpoints failed. Try again in a moment.\n${lines}`
  );
}

// ─── Sending (2026-09-29 send-safety audit) ──────────────────────────────
//
// # What was wrong
//
// `sendTransaction` here, and the SPL legs, ran blockhash → sign → broadcast
// → confirm INSIDE `runOnAnyRpc`, which gives an endpoint 4 s and then moves
// to the next one without cancelling the attempt it abandoned. web3.js's
// `sendAndConfirmTransaction` fetches its own blockhash and signs on every
// call, and confirms only through a WebSocket subscription (which
// api.mainnet-beta.solana.com refuses with 403 for the app's origins) or at
// block-height expiry 60-90 s later, never within 4 s. So every endpoint was
// handed a NEW transaction: new blockhash, new signature, nothing for the
// network to deduplicate. The audit drove the real adapters with only
// `lib/tauri` stubbed (nothing signed) and counted 11 independent builds per
// press, 4 s apart, all left running, ending in "All Solana RPC endpoints
// failed. Try again in a moment." Where several endpoints answer, each build
// is a real transfer.
//
// # What happens now
//
//  1. Everything decidable from the input or from a read is decided first —
//     recipient, amount, balances, rent — outside any rotation, so a typo is
//     reported as a typo and not as an outage.
//  2. `submitSolanaTransaction` fetches ONE blockhash and signs ONCE.
//  3. `deliverSignedTransaction` receives the serialized bytes and no key, so
//     it cannot sign anything, by construction. It may hand those same bytes
//     to every endpoint: a Solana transaction's identity is its signature,
//     and the network lands it at most once.
//  4. The outcome is read BY SIGNATURE over plain HTTP until the transaction
//     is confirmed, fails on chain, or provably can no longer land.

/** Solana's base fee: 5,000 lamports per signature. Every transaction this
 *  wallet signs has exactly one signature and no compute-budget (priority
 *  fee) instruction, so this is its whole fee. Used for the pre-checks and the
 *  fee display; the node's preflight simulation stays the final word. */
export const SOL_TX_FEE_LAMPORTS = 5_000n;

/** The SPL Token programs. An account either one owns is a token account or
 *  a mint — never a wallet. */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export function isTokenProgram(owner: PublicKey): boolean {
  return owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID);
}

/**
 * How long one send waits, and on what.
 *
 * `budgetMs` has to outlast a blockhash. `lastValidBlockHeight` is 150 blocks
 * past the blockhash (~60-70 s), and expiry is only proven once a FINALIZED
 * block is past it (~13 s later again). 120 s leaves room for slow reads, so a
 * transaction that never lands normally ends as "expired, safe to send again"
 * instead of "unknown". Reads keep the short read timeout: a slow read is
 * harmless, and a slow broadcast is never a reason to sign another.
 */
const SOL_SEND_TIMING = Object.freeze({
  /** One `sendTransaction` call. An answer later than this counts as maybe-sent. */
  broadcastTimeoutMs: 8_000,
  /** One status or block-height read while waiting. */
  readTimeoutMs: PER_RPC_TIMEOUT_MS,
  pollIntervalMs: 2_000,
  /** How often the SAME bytes are re-sent while no node reports them. */
  rebroadcastEveryMs: 6_000,
  /** From signing to giving up waiting. */
  budgetMs: 120_000,
});

/**
 * Without `searchTransactionHistory`, `getSignatureStatuses` consults only the
 * node's status cache, which covers the last 300 rooted blocks. A transaction
 * lands at most 150 blocks before `lastValidBlockHeight`, so a cache-only "not
 * found" proves absence only while the finalized height is less than ~150
 * blocks past it. 100 keeps a margin.
 */
const STATUS_CACHE_TRUSTED_BLOCKS = 100;

/** Lamports as a SOL decimal string, e.g. `890880n` → "0.00089088". */
export function lamportsToSol(lamports: bigint): string {
  return atomicToDecimal(lamports, 9);
}

/** The keypair behind a stored Solana key: hex of the 64-byte secret key, or of a 32-byte seed. */
export function solanaKeypairFromPrivateKey(privateKey: string): Keypair {
  const bytes = hexToBytes(privateKey.trim());
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error("Invalid Solana private key.");
}

/**
 * The recipient as a Solana address, trimmed, or an error saying it is not
 * one. A pasted address often carries a space or a newline. Until 2026-09-29
 * the SOL send parsed it inside the RPC rotation, so the parse error was
 * retried on all eleven endpoints and reported as an outage.
 */
export function parseSolanaAddress(to: string): PublicKey {
  const t = String(to ?? "").trim();
  try {
    if (t === "") throw new Error("empty");
    return new PublicKey(t);
  } catch {
    throw new Error(`${JSON.stringify(t)} is not a Solana address.`);
  }
}

const rentCache = new Map<number, bigint>();

/**
 * Lamports an account of `dataLength` bytes must hold to exist: the
 * rent-exempt minimum (890,880 for a plain wallet, 2,039,280 for a token
 * account, as of 2026-09). Read from the chain rather than hardcoded, since it
 * changes by feature gate; cached for the session.
 */
export async function rentExemptMinimum(dataLength: number): Promise<bigint> {
  const hit = rentCache.get(dataLength);
  if (hit !== undefined) return hit;
  const v = BigInt(await runOnAnyRpc((c) => c.getMinimumBalanceForRentExemption(dataLength)));
  rentCache.set(dataLength, v);
  return v;
}

/**
 * Would Solana let a system account holding `balance` lamports pay `fee` and
 * then spend `extra` more? `null` if it would; otherwise the rule that refuses.
 *
 * The runtime refuses to move a rent-exempt account to "rent-paying" (above
 * zero, below `rentMin`), and checks twice: once after taking the fee, once at
 * the end of the transaction. Emptying an account completely is allowed;
 * leaving dust is not. An account ALREADY below the minimum (a pre-2022
 * leftover) may only shrink, which any spend does.
 */
export function solSpendProblem(
  balance: bigint,
  fee: bigint,
  extra: bigint,
  rentMin: bigint,
): null | "insufficient" | "rent" {
  if (balance < fee + extra) return "insufficient";
  if (balance < rentMin) return null;
  const afterFee = balance - fee;
  if (afterFee !== 0n && afterFee < rentMin) return "rent";
  const left = afterFee - extra;
  if (left !== 0n && left < rentMin) return "rent";
  return null;
}

/**
 * What one `sendTransaction` answer says about whether the bytes went out.
 *
 * The line that matters runs between an endpoint that REFUSED the bytes (not
 * forwarded, so nothing can land because of this attempt) and one whose
 * answer cannot be trusted either way — a timeout, a 5xx, a body that is not
 * JSON-RPC — where the node may have forwarded the transaction before the
 * reply went missing. After one of those, only the signature can say.
 */
export type BroadcastOutcome =
  /** The node returned the signature: preflight passed and it forwarded the transaction. */
  | { kind: "accepted" }
  /** The node has already processed this exact transaction. */
  | { kind: "already-processed" }
  /** Preflight simulated it and refused. Deterministic; not forwarded. */
  | { kind: "rejected"; reason: string }
  /** Refused before forwarding: rate limit, lagging node, unknown blockhash. */
  | { kind: "unavailable"; reason: string }
  /** No trustworthy answer: the node may have forwarded it. */
  | { kind: "ambiguous"; reason: string };

const GATE_REFUSAL =
  /rate.?limit|too many requests|forbidden|unauthori[sz]ed|api.?key|not allowed|whitelist|method not found|not supported|quota|exceeded/i;

/** Classify one `sendTransaction` reply (HTTP status and body). */
export function classifyBroadcastResponse(httpStatus: number, body: string): BroadcastOutcome {
  const gate = httpStatus >= 400 && httpStatus < 500;
  let json: { result?: unknown; error?: { code?: unknown; message?: unknown; data?: { err?: unknown } } };
  try {
    json = JSON.parse(body);
  } catch {
    return gate
      ? { kind: "unavailable", reason: `HTTP ${httpStatus}` }
      : { kind: "ambiguous", reason: `HTTP ${httpStatus}, and the reply was not JSON` };
  }
  if (typeof json?.result === "string" && httpStatus >= 200 && httpStatus < 300) {
    return { kind: "accepted" };
  }
  const err = json?.error;
  if (!err || typeof err !== "object") {
    return gate
      ? { kind: "unavailable", reason: `HTTP ${httpStatus}` }
      : { kind: "ambiguous", reason: `HTTP ${httpStatus}, with neither a signature nor an error` };
  }
  const code = Number(err.code);
  const message = typeof err.message === "string" ? err.message : "";
  const simulated = err.data?.err;
  if (code === -32002) {
    // Preflight: the node simulated the transaction before forwarding it.
    if (simulated === "BlockhashNotFound" || /blockhash not found/i.test(message)) {
      return { kind: "unavailable", reason: "this node does not know the blockhash yet" };
    }
    if (simulated === "AlreadyProcessed" || /already been processed/i.test(message)) {
      return { kind: "already-processed" };
    }
    return { kind: "rejected", reason: preflightReason(simulated, message) };
  }
  const said = message || `JSON-RPC error ${String(err.code)}`;
  // Signature verification, signature count, malformed transaction.
  if (code === -32003 || code === -32013 || code === -32602) return { kind: "rejected", reason: said };
  // Node unhealthy (behind), method not offered, or a gateway refusal.
  if (code === -32005 || code === -32601 || code === 429 || code === -32429 || GATE_REFUSAL.test(message)) {
    return { kind: "unavailable", reason: said };
  }
  return gate ? { kind: "unavailable", reason: said } : { kind: "ambiguous", reason: said };
}

function preflightReason(simulated: unknown, message: string): string {
  if (simulated === "InsufficientFundsForFee" || simulated === "AccountNotFound") {
    return "this address does not hold enough SOL to pay the network fee";
  }
  if (simulated && typeof simulated === "object" && "InsufficientFundsForRent" in simulated) {
    return "it would leave an account holding less than Solana's rent-exempt minimum";
  }
  return message.replace(/^Transaction simulation failed:\s*/i, "").trim() || "the node gave no reason";
}

/** A failed transaction's error, in words. */
function txErrorText(err: TransactionError): string {
  if (typeof err === "string") return err;
  const ie = (err as { InstructionError?: unknown }).InstructionError;
  if (Array.isArray(ie)) {
    const [index, detail] = ie as [number, unknown];
    const what =
      typeof detail === "string"
        ? detail
        : detail && typeof detail === "object" && "Custom" in detail
          ? `custom program error ${String((detail as { Custom: unknown }).Custom)}`
          : JSON.stringify(detail);
    return `instruction ${index} failed: ${what}`;
  }
  if (err && typeof err === "object" && "InsufficientFundsForRent" in err) {
    return "an account would have been left below Solana's rent-exempt minimum";
  }
  return JSON.stringify(err);
}

/** Send the signed bytes to one endpoint, with preflight. Never signs anything. */
async function broadcastOnce(url: string, wire: string): Promise<BroadcastOutcome> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "sendTransaction",
    params: [wire, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }],
  });
  let res: { status: number; body: string };
  try {
    res = await withTimeout(
      invoke<{ status: number; body: string }>("sol_rpc_call", { url, body }),
      SOL_SEND_TIMING.broadcastTimeoutMs,
      url,
    );
  } catch (e) {
    // A timeout does not cancel the request (the Rust proxy holds it for up
    // to 30 s), and a transport error can come after the body left. Either
    // way the node may have forwarded the transaction.
    return { kind: "ambiguous", reason: errorText(e) };
  }
  return classifyBroadcastResponse(res.status, res.body);
}

type Verdict =
  /** Confirmed or finalized — `err` says whether it succeeded. */
  | { kind: "settled"; err: TransactionError | null }
  /** In a block, not yet confirmed. */
  | { kind: "in-block" }
  /** Not seen, and its blockhash is still valid. */
  | { kind: "pending" }
  /** Its blockhash expired and it is in no block: it can never land. */
  | { kind: "expired" }
  /** Past expiry, but this endpoint could not prove it absent. */
  | { kind: "inconclusive" };

function statusVerdict(s: SignatureStatus): Verdict {
  const settled =
    s.confirmationStatus === "confirmed" ||
    s.confirmationStatus === "finalized" ||
    // Nodes that predate `confirmationStatus` report a rooted slot as null.
    s.confirmations === null;
  return settled ? { kind: "settled", err: s.err } : { kind: "in-block" };
}

/** One look at the transaction through one endpoint. Throws if it does not answer. */
async function checkOnce(url: string, signature: string, lastValidBlockHeight: number): Promise<Verdict> {
  const conn = makeConnection(url);
  const ms = SOL_SEND_TIMING.readTimeoutMs;
  const status = (await withTimeout(conn.getSignatureStatuses([signature]), ms, url)).value[0];
  if (status) return statusVerdict(status);
  // Not seen. A transaction can only be included at a block height up to its
  // blockhash's lastValidBlockHeight. Measured on the FINALIZED chain, so a
  // fork cannot un-expire it.
  const epoch = await withTimeout(conn.getEpochInfo("finalized"), ms, url);
  if (typeof epoch.blockHeight !== "number") throw new Error(`${url} reported no block height`);
  if (epoch.blockHeight <= lastValidBlockHeight) return { kind: "pending" };
  return proveAbsent(conn, url, signature, epoch.absoluteSlot, epoch.blockHeight - lastValidBlockHeight);
}

/**
 * The finalized chain is past the last block that could include the
 * transaction. Look for it once more — after that observation, and only
 * believe "not found" from a node whose view reaches at least that far —
 * before declaring it gone and the send safe to repeat.
 */
async function proveAbsent(
  conn: Connection,
  url: string,
  signature: string,
  finalizedSlot: number,
  blocksPast: number,
): Promise<Verdict> {
  const ms = SOL_SEND_TIMING.readTimeoutMs;
  const decide = (r: { context: { slot: number }; value: (SignatureStatus | null)[] }): Verdict => {
    const s = r.value[0];
    if (s) return statusVerdict(s);
    // `context.slot` is the answering node's processed slot. Behind the
    // finalized slot just read (another backend behind the same URL), its
    // "not found" could predate the block that holds the transaction.
    return r.context.slot >= finalizedSlot ? { kind: "expired" } : { kind: "inconclusive" };
  };
  try {
    // A node that keeps transaction history answers for any age.
    return decide(
      await withTimeout(
        conn.getSignatureStatuses([signature], { searchTransactionHistory: true }),
        ms,
        url,
      ),
    );
  } catch {
    // This node keeps no history ("Transaction history is not available from
    // this node"), or did not answer. Fall back to its status cache.
  }
  if (blocksPast > STATUS_CACHE_TRUSTED_BLOCKS) return { kind: "inconclusive" };
  return decide(await withTimeout(conn.getSignatureStatuses([signature]), ms, url));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface SignedSolanaTransaction {
  /** base64 of the signed, serialized transaction — the only thing ever broadcast. */
  wire: string;
  /** The fee payer's signature, base58: the transaction's id on chain. */
  signature: string;
  lastValidBlockHeight: number;
}

/**
 * Deliver one signed transaction and find out what became of it.
 *
 * Takes bytes, not a key, so nothing in here can sign — which is the whole
 * fix (see the section header). Every broadcast, first or repeated, is these
 * exact bytes.
 */
async function deliverSignedTransaction(signed: SignedSolanaTransaction): Promise<TxResult> {
  const { wire, signature, lastValidBlockHeight } = signed;
  const deadline = Date.now() + SOL_SEND_TIMING.budgetMs;
  const order = rpcOrder();

  // ── 1. First delivery: the same bytes to each endpoint in turn. ──
  let accepted = false; // a node took it: preflight passed, forwarded
  let maybeSent = false; // an answer went missing: a node may have forwarded it
  let acceptedAt = -1;
  let lateRefusal: string | null = null;
  const unavailable: string[] = [];
  for (let i = 0; i < order.length && Date.now() < deadline; i++) {
    const url = order[i];
    const r = await broadcastOnce(url, wire);
    if (r.kind === "accepted" || r.kind === "already-processed") {
      accepted = true;
      acceptedAt = i;
      stickyUrl = url;
      break;
    }
    if (url === stickyUrl) stickyUrl = null;
    if (r.kind === "rejected") {
      // Refused by simulation. With nothing possibly out yet, that is an
      // ordinary failure and repeating the send is safe.
      if (!maybeSent) {
        throw new Error(`Solana refused this transaction before sending it: ${r.reason}. Nothing was sent.`);
      }
      // An earlier attempt may have delivered it, and this refusal may even
      // be BECAUSE it landed (the funds have moved). Only the signature can say.
      lateRefusal = r.reason;
      break;
    }
    if (r.kind === "unavailable") unavailable.push(`  ${url}: ${r.reason}`);
    else maybeSent = true;
  }
  if (!accepted && !maybeSent) {
    console.warn("[sol-wallet] no endpoint took the transaction:", unavailable);
    throw new Error(
      `No Solana endpoint would take the transaction right now. Nothing was sent; try again in a moment.\n${unavailable.join("\n")}`,
    );
  }

  // ── 2. The outcome, by signature. ──
  let seen = false; // a node has reported it in a block
  let cursor = acceptedAt >= 0 ? acceptedAt : 0;
  let resendCursor = cursor + 1;
  let resendAt = Date.now() + SOL_SEND_TIMING.rebroadcastEveryMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(SOL_SEND_TIMING.pollIntervalMs, deadline - Date.now()));
    let v: Verdict;
    try {
      v = await checkOnce(order[cursor % order.length], signature, lastValidBlockHeight);
    } catch {
      cursor++; // no answer from this endpoint; ask the next one next time
      continue;
    }
    if (v.kind === "settled") {
      if (v.err) {
        throw new Error(
          `The transaction was recorded on Solana but failed (${txErrorText(v.err)}). ` +
            `The network fee was charged; nothing was transferred. Signature: ${signature}`,
        );
      }
      return { hash: signature };
    }
    if (v.kind === "expired") {
      throw new Error(
        `Solana did not include this transaction before its blockhash expired, so it can no longer land. ` +
          `Nothing moved and no fee was charged; it is safe to send again. Signature: ${signature}` +
          (lateRefusal ? ` (An endpoint had refused it: ${lateRefusal}.)` : ""),
      );
    }
    if (v.kind === "in-block") {
      seen = true;
      continue;
    }
    if (v.kind === "inconclusive") {
      cursor++;
      continue;
    }
    // Pending: unseen, still valid. Keep the SAME bytes moving — a public node
    // may drop a transaction it accepted, and another may land it.
    if (!seen && Date.now() >= resendAt) {
      const r = await broadcastOnce(order[resendCursor++ % order.length], wire);
      if (r.kind === "accepted" || r.kind === "already-processed") accepted = true;
      resendAt = Date.now() + SOL_SEND_TIMING.rebroadcastEveryMs;
    }
  }

  // ── 3. Out of time with no verdict. ──
  // A node accepted it (or it is in a block): the network has it and it may
  // still confirm — "submitted", with the form closed all the same.
  if (accepted || seen) return { hash: signature, pending: true };
  // Nothing ever answered for it: it may or may not be out there.
  throw new SendOutcomeUnknownError(
    "No Solana endpoint confirmed receiving this transaction, and its status could not be read before the wallet stopped waiting.",
    signature,
  );
}

/**
 * Sign `instructions` ONCE, against one recent blockhash, and deliver that
 * single transaction (2026-09-29 send-safety audit).
 *
 * Resolves `{ hash }` once confirmed, or `{ hash, pending: true }` when a node
 * accepted it and the wait ran out. Throws an ordinary Error when it
 * definitely moved nothing — refused before sending, failed on chain, or
 * expired unseen — and `SendOutcomeUnknownError` (with the signature) when it
 * may have gone out and nothing more could be learned.
 */
export async function submitSolanaTransaction(
  keypair: Keypair,
  instructions: TransactionInstruction[],
): Promise<TxResult> {
  // A read, so rotating is harmless. Its lastValidBlockHeight is what later
  // proves the transaction can no longer land.
  const { blockhash, lastValidBlockHeight } = await runOnAnyRpc((c) =>
    c.getLatestBlockhash("confirmed"),
  );
  const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight });
  tx.add(...instructions);
  tx.sign(keypair);
  if (!tx.signature) throw new Error("Signing produced no signature.");
  return deliverSignedTransaction({
    wire: tx.serialize().toString("base64"),
    signature: base58.encode(tx.signature),
    lastValidBlockHeight,
  });
}

/** Why the runtime would refuse this SOL transfer, in words; `null` if it would not. */
function solTransferProblem(a: {
  to: string;
  self: boolean;
  lamports: bigint;
  balance: bigint;
  recipient: AccountInfo<Buffer> | null;
  rentMin: bigint;
}): string | null {
  const fee = SOL_TX_FEE_LAMPORTS;
  if (a.recipient && isTokenProgram(a.recipient.owner)) {
    // Lamports sent to a token account are not tokens: they come back only
    // when the token account's owner empties and closes it (and a mint's,
    // never). An inference from the Token program's CloseAccount rules; the
    // audit did not strand any to prove it.
    return (
      `${a.to} is a token account or token mint, not a wallet. SOL sent to it could at best be ` +
      `recovered by that account's owner closing it. Send to the recipient's wallet address instead.`
    );
  }
  if (a.balance < a.lamports + fee) {
    return (
      `This address holds ${lamportsToSol(a.balance)} SOL. Sending ${lamportsToSol(a.lamports)} SOL ` +
      `needs ${lamportsToSol(a.lamports + fee)} SOL, including the ${lamportsToSol(fee)} SOL network fee.`
    );
  }
  if (!a.self) {
    const has = BigInt(a.recipient?.lamports ?? 0);
    if (has + a.lamports < a.rentMin) {
      return has === 0n
        ? `The recipient address holds no SOL yet, and Solana will not open an account with less than ` +
            `${lamportsToSol(a.rentMin)} SOL (its rent-exempt minimum). Send at least that much.`
        : `The recipient account holds less than Solana's rent-exempt minimum of ${lamportsToSol(a.rentMin)} SOL ` +
            `and can only receive enough to reach it. Send at least ${lamportsToSol(a.rentMin - has)} SOL.`;
    }
  }
  if (solSpendProblem(a.balance, fee, a.self ? 0n : a.lamports, a.rentMin) === "rent") {
    const afterFee = a.balance - fee;
    if (afterFee < a.rentMin) {
      return (
        `This address holds ${lamportsToSol(a.balance)} SOL, too little above Solana's rent-exempt minimum ` +
        `(${lamportsToSol(a.rentMin)} SOL) to pay even the network fee. Add a little SOL first.`
      );
    }
    const keepOpen = afterFee - a.rentMin;
    return (
      `Sending ${lamportsToSol(a.lamports)} SOL would leave ${lamportsToSol(afterFee - a.lamports)} SOL here, ` +
      `less than Solana's rent-exempt minimum of ${lamportsToSol(a.rentMin)} SOL, and the network refuses that. ` +
      (keepOpen > 0n ? `Send at most ${lamportsToSol(keepOpen)} SOL, or exactly ` : `Send exactly `) +
      `${lamportsToSol(afterFee)} SOL to empty the address.`
    );
  }
  return null;
}

function deriveKeypairFromMnemonic(mnemonic: string): Keypair {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const derived = derivePath(DERIVATION_PATH, Buffer.from(seed).toString("hex"));
  return Keypair.fromSeed(Uint8Array.from(derived.key));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

export const solAdapter: ChainAdapter = {
  chain: "solana",
  displayName: "Solana",
  ticker: "SOL",
  color: "#9945ff",
  addressPlaceholder: "So1...",
  derivation: {
    kind: "bip39",
    path: "m/44'/501'/0'/0'",
    standard: "Phantom, Solflare, Trezor, Ledger Live",
    hasAlternatives: true,
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    // Solana private keys can be hex (64 bytes = 128 hex chars for full keypair, or 32 bytes = 64 hex chars for seed)
    const bytes = hexToBytes(privateKey);
    let keypair: Keypair;
    if (bytes.length === 64) {
      keypair = Keypair.fromSecretKey(bytes);
    } else if (bytes.length === 32) {
      keypair = Keypair.fromSeed(bytes);
    } else {
      // Try parsing as base58 JSON array (Phantom export format)
      try {
        const arr = JSON.parse(privateKey);
        keypair = Keypair.fromSecretKey(Uint8Array.from(arr));
      } catch {
        throw new Error("Invalid Solana private key. Provide 32 or 64 byte hex, or a JSON byte array.");
      }
    }
    return {
      chain: "solana",
      address: keypair.publicKey.toBase58(),
      mnemonic: "",
      privateKey: bytesToHex(keypair.secretKey),
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const keypair = deriveKeypairFromMnemonic(mnemonic);
    return {
      chain: "solana",
      address: keypair.publicKey.toBase58(),
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(keypair.secretKey),
    };
  },

  async getBalance(address: string): Promise<string> {
    const pubkey = new PublicKey(address);
    const balance = await runOnAnyRpc((c) => c.getBalance(pubkey));
    return (balance / LAMPORTS_PER_SOL).toFixed(9);
  },

  async sendTransaction(privateKey: string, to: string, amount: string): Promise<TxResult> {
    // The input first, outside any RPC rotation (2026-09-29 send-safety
    // audit). Until then `new PublicKey(to)` ran inside it, so a trailing
    // space was retried on eleven endpoints and reported as "All Solana RPC
    // endpoints failed", and the amount went through `parseFloat`: "1,5" sent
    // 1 SOL, "1e3" sent 1000, "0x10" sent 0.
    const keypair = solanaKeypairFromPrivateKey(privateKey);
    const from = keypair.publicKey;
    const recipient = parseSolanaAddress(to);
    const lamports = decimalToAtomic(amount, 9, "SOL amount");
    if (lamports <= 0n) throw new Error("Amount must be greater than zero.");

    // Then the checks the runtime would otherwise make after the press, in
    // words. Reads only — nothing is signed yet, so rotating is harmless.
    const [fromInfo, toInfo] = await runOnAnyRpc((c) =>
      c.getMultipleAccountsInfo([from, recipient], "confirmed"),
    );
    const problem = solTransferProblem({
      to: recipient.toBase58(),
      self: recipient.equals(from),
      lamports,
      balance: BigInt(fromInfo?.lamports ?? 0),
      recipient: toInfo,
      rentMin: await rentExemptMinimum(0),
    });
    if (problem) throw new Error(problem);

    return submitSolanaTransaction(keypair, [
      SystemProgram.transfer({ fromPubkey: from, toPubkey: recipient, lamports }),
    ]);
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const slot = await runOnAnyRpc((c) => c.getSlot());
      return { label: "Slot", value: slot.toLocaleString(), unit: "" };
    } catch {
      return { label: "Network", value: "Mainnet", unit: "" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    const pubkey = new PublicKey(address);
    // Two-step: list signatures, then fetch each tx in parallel. The
    // existing `runOnAnyRpc` (now reqwest-proxied) covers both calls.
    const sigs = await runOnAnyRpc((c) =>
      c.getSignaturesForAddress(pubkey, {
        limit,
        before: opts?.cursor,
      })
    );
    if (sigs.length === 0) return { items: [] };

    // RAM plan 3.6 (2026-09-25): only ask for the transactions we have not
    // already parsed. This used to fetch every signature's full parsed
    // transaction on every call - 1 + 50 RPCs per address per minute from the
    // 60 s history poll, each rotating up to 11 endpoints on a 429 - and was
    // the single biggest source of background traffic (~450-530 IPC calls a
    // minute on an idle Mine view, measured). A FINALIZED transaction cannot
    // change, so its parsed result is cached per (address, signature).
    const parsed = await Promise.allSettled(
      sigs.map((s) => {
        const hit = solParsedCache.get(address, s.signature);
        if (hit) return Promise.resolve(hit);
        return runOnAnyRpc((c) =>
          c.getParsedTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
          })
        ).then((tx) => {
          const summary = summarizeParsedTx(tx, address);
          if (summary && s.confirmationStatus === "finalized") {
            solParsedCache.set(address, s.signature, summary);
          }
          return summary;
        });
      })
    );

    const items: ChainTx[] = sigs.map((s, i) => {
      const r = parsed[i];
      const summary = r.status === "fulfilled" ? r.value : null;
      const net = summary?.net ?? 0;
      const meta = summary ? { fee: summary.fee } : undefined;
      const direction: ChainTx["direction"] = s.err
        ? "failed"
        : net > 0
          ? "in"
          : net < 0
            ? "out"
            : "self";
      const amount = (Math.abs(net) / LAMPORTS_PER_SOL).toFixed(9);
      const fee = meta?.fee ? (meta.fee / LAMPORTS_PER_SOL).toFixed(9) : undefined;
      return {
        chain: "solana",
        hash: s.signature,
        direction,
        amount,
        fee: direction === "out" ? fee : undefined,
        timestamp: s.blockTime ?? undefined,
        confirmations:
          s.confirmationStatus === "finalized"
            ? undefined
            : s.confirmationStatus === "confirmed"
              ? 1
              : 0,
        height: s.slot,
        meta: {
          memo: s.memo,
          confirmationStatus: s.confirmationStatus,
        },
      };
    });
    const cursor = sigs.length === limit ? sigs[sigs.length - 1].signature : undefined;
    return { items, cursor };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // The fee a send from here pays is fixed: one signature at 5,000 lamports,
    // with no priority fee (no compute-budget instruction is ever attached).
    // Until 2026-09-29 this read `getRecentPrioritizationFees` and offered
    // slow/normal/fast tiers from it — tiers no send used (the modal hands a
    // tier only to `sendFromAccount`, which Solana does not have), built by
    // adding micro-lamports per compute unit to lamports. When that read
    // failed, the Send modal disabled Send over a number the send does not
    // depend on (2026-09-29 send-safety audit).
    return {
      normal: { value: lamportsToSol(SOL_TX_FEE_LAMPORTS), eta: "≈ 1 slot" },
      unit: "SOL",
      fetchedAt: Date.now(),
    };
  },
};
