import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { derivePath } from "ed25519-hd-key";
import { Buffer } from "buffer";
import { invoke } from "../lib/tauri";
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

async function runOnAnyRpc<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
  // Build the try-order: sticky URL first (if known and still in the
  // roster), then everything else in declared order.
  const order = stickyUrl && RPC_URLS.includes(stickyUrl)
    ? [stickyUrl, ...RPC_URLS.filter((u) => u !== stickyUrl)]
    : [...RPC_URLS];

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
    const secretKey = hexToBytes(privateKey);
    let keypair: Keypair;
    if (secretKey.length === 64) {
      keypair = Keypair.fromSecretKey(secretKey);
    } else {
      keypair = Keypair.fromSeed(secretKey);
    }
    const lamports = Math.round(parseFloat(amount) * LAMPORTS_PER_SOL);

    const signature = await runOnAnyRpc(async (connection) => {
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(to),
          lamports,
        })
      );
      return sendAndConfirmTransaction(connection, transaction, [keypair]);
    });

    return { hash: signature };
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

    const parsed = await Promise.allSettled(
      sigs.map((s) =>
        runOnAnyRpc((c) =>
          c.getParsedTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
          })
        )
      )
    );

    const items: ChainTx[] = sigs.map((s, i) => {
      const r = parsed[i];
      const tx = r.status === "fulfilled" ? r.value : null;
      const meta = tx?.meta;
      // Net SOL delta on our account = postBalance - preBalance for the
      // index where account == us. `accountKeys` order matches `balances`.
      let net = 0;
      try {
        const keys = tx?.transaction.message.accountKeys ?? [];
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
    // Solana base fee is a flat 5000 lamports per signature; the variable
    // part is the priority fee. `getRecentPrioritizationFees` returns up
    // to 150 recent samples. We use median for "normal" and p75/p90 for
    // "fast"; "slow" is just the base fee (zero priority).
    const samples = await runOnAnyRpc((c) =>
      c.getRecentPrioritizationFees()
    );
    const fees = samples
      .map((s) => s.prioritizationFee || 0)
      .sort((a, b) => a - b);
    const pick = (p: number) =>
      fees.length === 0 ? 0 : fees[Math.min(fees.length - 1, Math.floor(fees.length * p))];
    const baseFee = 5000; // micro-lamports per signature, in lamports
    const slow = baseFee;
    const normal = baseFee + pick(0.5);
    const fast = baseFee + pick(0.9);
    return {
      slow: { value: String(slow), eta: "best effort" },
      normal: { value: String(normal), eta: "~ next block" },
      fast: { value: String(fast), eta: "priority" },
      unit: "lamports/sig",
      fetchedAt: Date.now(),
      raw: { samples },
    };
  },
};
