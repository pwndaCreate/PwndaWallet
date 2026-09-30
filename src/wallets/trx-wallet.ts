import { ethers } from "ethers";
import bs58check from "bs58check";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  TxParties,
  FeeEstimate,
} from "./types";
import { httpProxyCall, proxyGetJson } from "./_proxy";
import { fetchTrxHistory, fetchTrxParties, type TronHistorySources } from "./tron-history";
import { verifyTronTransaction } from "./tron-tx-verify";
import { SendOutcomeUnknownError } from "./send-outcome";

const TRON_API_URLS = [
  "https://api.trongrid.io",
  "https://api.tronstack.io",
];

/**
 * TronGrid lets a keyless client make 3 requests a second and suspends it for
 * 5 s past that (HTTP 429). The dashboard alone asks for a TRX balance, a
 * USDT balance and both histories at once, which tripped it in the sandbox
 * on 2026-09-29. Spacing TronGrid requests keeps the wallet under the limit
 * instead of relying on the fallback below.
 */
/** Mutable so tests need not wait out real spacing; nothing in the app writes it. */
export const TRONGRID_RATE = { minSpacingMs: 350 };
let trongridNextSlot = 0;

async function trongridSlot(): Promise<void> {
  const slot = Math.max(Date.now(), trongridNextSlot);
  trongridNextSlot = slot + TRONGRID_RATE.minSpacingMs;
  // Re-check after waking: a timer can fire a few ms EARLY against the wall
  // clock (libuv's cached loop time on Windows; measured 47 ms for a 60 ms
  // wait), and 350 ms is only 17 ms above TronGrid's 333 ms-per-request limit.
  for (let wait = slot - Date.now(); wait > 0; wait = slot - Date.now()) {
    await new Promise((r) => setTimeout(r, wait));
  }
}

function headerRecord(h: HeadersInit | undefined): Record<string, string> | undefined {
  if (!h) return undefined;
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...(h as Record<string, string>) };
}

/** Which TRON API host answered a `tronFetchFrom` call. */
export type TronSource = "trongrid" | "tronstack";

/**
 * GET/POST a TRON node API path: TronGrid first, TronStack second.
 *
 * TronGrid is fetched directly (it sends CORS headers). TronStack is reached
 * through the Rust HTTP proxy (`http_proxy_call`, which allowlists
 * `tronstack.io`): it sends NO CORS headers, so the direct fetch this used to
 * make could never succeed from the web view, and the fallback was dead code
 * — confirmed 2026-09-29 by a TronGrid 429 followed by "blocked by CORS
 * policy" on api.tronstack.io.
 *
 * `fallback` asks TronStack something else: it serves the full-node
 * `/wallet/*` API only, and answers 404 for TronGrid's indexed `/v1/*` paths
 * (verified 2026-09-29 for `/v1/accounts/<addr>` and `…/transactions/trc20`).
 */
export async function tronFetchFrom(
  path: string,
  init?: RequestInit,
  fallback?: { path: string; init?: RequestInit },
): Promise<{ resp: Response; source: TronSource }> {
  let lastError: unknown;
  await trongridSlot();
  try {
    const resp = await fetch(`${TRON_API_URLS[0]}${path}`, init);
    if (resp.ok) return { resp, source: "trongrid" };
    lastError = new Error(`HTTP ${resp.status} from ${TRON_API_URLS[0]}`);
  } catch (e) {
    lastError = e;
  }
  const fbPath = fallback?.path ?? path;
  const fbInit = fallback ? fallback.init : init;
  try {
    const method = (fbInit?.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
    const r = await httpProxyCall({
      method,
      url: `${TRON_API_URLS[1]}${fbPath}`,
      headers: headerRecord(fbInit?.headers),
      body: typeof fbInit?.body === "string" ? fbInit.body : undefined,
    });
    if (r.status >= 200 && r.status < 300) {
      return {
        resp: new Response(r.body, {
          status: r.status,
          headers: { "Content-Type": "application/json" },
        }),
        source: "tronstack",
      };
    }
    lastError = new Error(`HTTP ${r.status} from ${TRON_API_URLS[1]}`);
  } catch (e) {
    lastError = e;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** {@link tronFetchFrom} for callers that ask both hosts the same path. */
export async function tronFetch(path: string, init?: RequestInit): Promise<Response> {
  return (await tronFetchFrom(path, init)).resp;
}

const TRONSCAN_API = "https://apilist.tronscanapi.com";

/**
 * History sources for TRX and TRC-20 (`tron-history.ts`, operator report
 * 2026-09-30). TronGrid's indexed `/v1/*` paths, spaced like every other
 * TronGrid call; then TronScan's public API. Both through the backend proxy
 * (`trongrid.io` and `tronscanapi.com` are allowlisted). TronStack is not a
 * history source: it has no `/v1/*`, and the full-node API cannot list an
 * account's transactions.
 */
export const TRON_HISTORY_SOURCES: TronHistorySources = {
  tronGrid: async (path) => {
    await trongridSlot();
    return proxyGetJson(`${TRON_API_URLS[0]}${path}`);
  },
  tronScan: (path) => proxyGetJson(`${TRONSCAN_API}${path}`),
};

/** A sun amount from a TRON API number field; absent is zero. */
function sunOf(v: unknown): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  throw new Error("Unexpected TRX balance response");
}

/**
 * An account's TRX balance, in sun.
 *
 * TronGrid answers its indexed `/v1/accounts/<addr>`; TronStack has no `/v1/*`
 * (HTTP 404, 2026-09-29 send-safety audit), so its fallback read is the
 * full-node `/wallet/getaccount`, which both hosts serve. Before that the
 * fallback asked TronStack for `/v1/accounts` too: when TronGrid rate-limited
 * (429), the TRX balance and the USDT send's TRX check had no fallback at all,
 * and the check silently became "unknown".
 */
export async function readTronBalanceSun(address: string): Promise<bigint> {
  const { resp, source } = await tronFetchFrom(`/v1/accounts/${address}`, undefined, {
    path: "/wallet/getaccount",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, visible: true }),
    },
  });
  const data = await resp.json();
  if (source === "trongrid") {
    // An account that has never received anything is `data: []` — a real
    // zero. A body without a `data` array is not an answer at all, and the
    // adapter contract says to throw rather than show 0 for it.
    if (!Array.isArray(data?.data)) throw new Error("Unexpected TRX balance response");
    return sunOf(data.data[0]?.balance);
  }
  // `/wallet/getaccount` prints `{}` for an account that does not exist yet
  // (java-tron's GetAccountServlet, when the lookup finds nothing — a real
  // zero), `{ Error }` for a failure, and omits `balance` when it is zero.
  if (!data || typeof data !== "object" || Array.isArray(data) || data.Error) {
    const why = data && typeof data === "object" ? tronNodeMessage(data.Error) : "";
    throw new Error(`Unexpected TRX balance response${why ? `: ${why}` : ""}`);
  }
  return sunOf(data.balance);
}

const TRONGRID_API = TRON_API_URLS[0];

/**
 * Convert an Ethereum-style address to a TRON base58 address.
 * TRON addresses use 0x41 prefix + 20-byte address, then base58check encode.
 */
export function ethAddressToTron(ethAddress: string): string {
  const clean = ethAddress.replace(/^0x/, "");
  const addressBytes = new Uint8Array(21);
  addressBytes[0] = 0x41; // TRON mainnet prefix
  const hexBytes = hexToBytes(clean);
  addressBytes.set(hexBytes, 1);
  return bs58check.encode(addressBytes);
}

/**
 * True when `address` is a TRON mainnet address: base58check of exactly 21
 * bytes whose first byte is 0x41.
 *
 * The version byte is the part that matters. Bitcoin, Litecoin, Dogecoin and
 * Dash legacy addresses are base58check of 21 bytes too, and before
 * 2026-09-29 `tronAddressToHex` accepted them: a USDT send to a BTC `1…`
 * address produced a valid-looking TRC-20 transfer to a TRON account nobody
 * holds the key for.
 */
export function isTronAddress(address: string): boolean {
  try {
    const raw = bs58check.decode(address.trim());
    return raw.length === 21 && raw[0] === 0x41;
  } catch {
    return false;
  }
}

/**
 * Convert a TRON base58 address back to hex (with 41 prefix). Throws on
 * anything that is not a TRON address — see `isTronAddress`.
 */
export function tronAddressToHex(tronAddress: string): string {
  if (!isTronAddress(tronAddress)) {
    throw new Error(`"${tronAddress}" is not a TRON address (expected T…, 34 characters).`);
  }
  return bytesToHex(bs58check.decode(tronAddress.trim()));
}

/**
 * A TRON node's error text. Broadcast and trigger results carry `message` as
 * HEX-encoded UTF-8, and `createtransaction` refusals arrive as HTTP 200 with
 * an `Error` string wrapped in a Java exception class name. Both used to reach
 * the user verbatim (hex digits, or "Cannot read properties of undefined"
 * when the missing `txID` was signed anyway).
 */
export function tronNodeMessage(message: unknown): string {
  if (typeof message !== "string" || !message) return "";
  const text = /^[0-9a-fA-F]+$/.test(message) && message.length % 2 === 0
    ? new TextDecoder().decode(hexToBytes(message))
    : message;
  // "class org.tron.core.exception.ContractValidateException : Validate
  // TransferContract error, balance is not sufficient." → the sentence.
  return text.replace(/^class [\w.$]+ ?: ?/, "").trim();
}

/** Poll cadence for `waitForTronExecution`. Mutable so tests need not wait
 *  out real TRON block times; nothing in the app writes it. */
export const TRON_EXECUTION_POLL = { intervalMs: 3_000, timeoutMs: 30_000 };

/**
 * Wait for a broadcast transaction to EXECUTE, and report how it went.
 *
 * `broadcasttransaction` answering `result: true` means a node accepted the
 * transaction into its pool — not that it ran. A TRC-20 transfer can still
 * fail inside the block (`OUT_OF_ENERGY`, `REVERT`), burning the TRX spent on
 * energy and moving no tokens; the wallet reported those as sent. Polls
 * `gettransactioninfobyid` (blocks are ~3 s) and returns `"confirmed"`, throws
 * on a failed execution, or returns `"pending"` if nothing is known after
 * `timeoutMs` — which is not a failure, just not yet an answer.
 */
export async function waitForTronExecution(
  txID: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<"confirmed" | "pending"> {
  const timeoutMs = opts?.timeoutMs ?? TRON_EXECUTION_POLL.timeoutMs;
  const intervalMs = opts?.intervalMs ?? TRON_EXECUTION_POLL.intervalMs;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let info: any = null;
    try {
      const resp = await tronFetch(`/wallet/gettransactioninfobyid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: txID }),
      });
      info = await resp.json();
    } catch {
      /* transient: try again until the deadline */
    }
    if (info && typeof info === "object" && info.id) {
      const outcome = info.receipt?.result;
      if (info.result === "FAILED" || (outcome && outcome !== "SUCCESS")) {
        const why = tronNodeMessage(info.resMessage) || outcome || "FAILED";
        throw new Error(
          `The transaction was included but failed on chain: ${why}. No tokens moved; ` +
            `the TRX spent on energy and bandwidth is not refunded. Transaction ${txID}.`,
        );
      }
      return "confirmed";
    }
    if (Date.now() >= deadline) return "pending";
  }
}

/** One node's answer to `broadcasttransaction`, read. */
type BroadcastVerdict =
  /** The node holds the transaction now. */
  | { kind: "accepted" }
  /** The node refused THIS transaction; another node would say the same. */
  | { kind: "refused"; message: string }
  /** The node did not take it for a reason of its own; try the other one. */
  | { kind: "busy"; message: string }
  /** No telling whether it was taken. */
  | { kind: "uncertain"; message: string };

/** Codes that describe the node, not the transaction (`Return.response_code`). */
const NODE_LOCAL_CODES = new Set(["SERVER_BUSY", "NO_CONNECTION", "NOT_ENOUGH_EFFECTIVE_CONNECTION"]);

function readBroadcastAnswer(result: any, txID: string): BroadcastVerdict {
  if (result?.result === true) return { kind: "accepted" };
  const code = typeof result?.code === "string" ? result.code : "";
  const message = tronNodeMessage(result?.message) || code || "Broadcast failed";
  if (code === "DUP_TRANSACTION_ERROR") {
    // The node already holds a transaction with this id: an earlier attempt
    // of THIS send reached the network (TronGrid took it and then timed out,
    // say, and TronStack heard of it). That is acceptance. Reported as a
    // failure until 2026-09-29, so the Send form stayed filled and one more
    // press signed a new transaction and paid twice.
    const id = typeof result?.txid === "string" ? result.txid.toLowerCase() : "";
    if (!id || id === txID.toLowerCase()) return { kind: "accepted" };
    return { kind: "uncertain", message };
  }
  if (NODE_LOCAL_CODES.has(code)) return { kind: "busy", message };
  return { kind: "refused", message };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Broadcast ONE signed transaction, TronGrid first and TronStack second, and
 * say whether the network has it (2026-09-29 send-safety audit).
 *
 * `tronFetch` used to carry the broadcast, which hides WHY an attempt failed.
 * For a broadcast that matters: a 429 or a 4xx means the request was not
 * processed, while a timeout, a dropped connection or a 5xx can come after a
 * node took the transaction. Once any attempt may have reached a node, a
 * later refusal no longer proves nothing was sent — the transaction is looked
 * up by id instead, and if it is still unknown the send ends in
 * `SendOutcomeUnknownError`, never in "failed" (which kept the form filled
 * for a second, differently-signed payment).
 *
 * Only these bytes are ever re-sent: a TRON transaction is applied once per
 * id, so re-broadcasting it cannot pay twice.
 *
 * Returns `"accepted"` (a node holds it; execution not yet seen) or
 * `"confirmed"` (seen executed in a block, after an uncertain broadcast).
 * Throws an ordinary Error for a definite refusal — nothing reached the
 * network, so another attempt is safe — and whatever `waitForTronExecution`
 * throws for a transaction that was included and failed.
 */
export async function broadcastTronTransaction(
  txData: { txID: string },
  label: string,
): Promise<"accepted" | "confirmed"> {
  const txID = txData.txID;
  const body = JSON.stringify(txData);
  const headers = { "Content-Type": "application/json" };
  const attempts: Array<() => Promise<{ status: number; text: string }>> = [
    async () => {
      await trongridSlot();
      const r = await fetch(`${TRON_API_URLS[0]}/wallet/broadcasttransaction`, {
        method: "POST",
        headers,
        body,
      });
      return { status: r.status, text: await r.text() };
    },
    async () => {
      const r = await httpProxyCall({
        method: "POST",
        url: `${TRON_API_URLS[1]}/wallet/broadcasttransaction`,
        headers,
        body,
      });
      return { status: r.status, text: r.body };
    },
  ];

  // Why an attempt MAY have reached a node without saying so (first one wins).
  let uncertain: string | null = null;
  let refusal: string | null = null;
  for (const attempt of attempts) {
    let answer: { status: number; text: string };
    try {
      answer = await attempt();
    } catch (e) {
      uncertain ??= `no answer, ${errorText(e)}`;
      continue;
    }
    if (answer.status < 200 || answer.status >= 300) {
      // A gateway can answer 5xx after the node behind it took the request.
      if (answer.status >= 500) uncertain ??= `HTTP ${answer.status}`;
      else refusal ??= `HTTP ${answer.status}`;
      continue;
    }
    let result: unknown;
    try {
      result = JSON.parse(answer.text);
    } catch {
      uncertain ??= "an unreadable answer";
      continue;
    }
    const verdict = readBroadcastAnswer(result, txID);
    if (verdict.kind === "accepted") return "accepted";
    if (verdict.kind === "uncertain") {
      uncertain ??= verdict.message;
      continue;
    }
    refusal = verdict.message;
    if (verdict.kind === "refused") break;
  }

  if (uncertain === null) {
    // Every node answered, and none took it: nothing was sent.
    throw new Error(refusal ?? `${label} broadcast failed`);
  }
  // Look it up by id. Throws if it was included and failed on chain.
  if ((await waitForTronExecution(txID)) === "confirmed") return "confirmed";
  throw new SendOutcomeUnknownError(
    `TRON gave no clear answer to the ${label} broadcast: ${uncertain}. It is not in a block yet.`,
    txID,
  );
}

/**
 * Derive the TRON wallet at an ARBITRARY HD path. Pwnda's DEFAULT reuses the
 * EVM key (`m/44'/60'/0'/0/0`, via `ethers.Wallet.fromPhrase`); Exodus/Atomic
 * use TRX's own coin-type (`m/44'/195'/…`). This manually walks HDKey so any
 * path works, then reuses the EXACT same eth-address → `ethAddressToTron`
 * encoder, so the standard path is byte-identical to `deriveFromMnemonic`
 * (locked by a round-trip test). Exported for `derivePerChoice`.
 */
export function deriveTrxAtPath(mnemonic: string, path: string): WalletInfo {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  const wallet = new ethers.Wallet("0x" + bytesToHex(child.privateKey!));
  return {
    chain: "tron",
    address: ethAddressToTron(wallet.address),
    mnemonic: mnemonic.trim(),
    privateKey: wallet.privateKey,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const trxAdapter: ChainAdapter = {
  chain: "tron",
  displayName: "TRON",
  ticker: "TRX",
  color: "#eb0029",
  addressPlaceholder: "T...",
  derivation: {
    kind: "bip39",
    path: "m/44'/60'/0'/0/0",
    // Corrected 2026-09-29. This read "TronLink convention: ETH coin type 60",
    // which is backwards: TronLink and Ledger use TRX's own coin type, 195
    // (`wiki/concepts/derivation-paths.md` § TRX). Pwnda's default reuses the
    // EVM key; a TronLink seed shows a different address until switched.
    standard: "the EVM key (ETH coin type 60), which Pwnda reuses for TRON. TronLink and Ledger use TRX's own coin type 195, so their seeds show a different TRON address here",
    hasAlternatives: true,
  },
  /** Arbitrary-path derivation for the generic finder + balance sweep. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    return deriveTrxAtPath(mnemonic, path);
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const wallet = new ethers.Wallet(privateKey.trim());
    const tronAddress = ethAddressToTron(wallet.address);
    return {
      chain: "tron",
      address: tronAddress,
      mnemonic: "",
      privateKey: wallet.privateKey,
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const wallet = ethers.Wallet.fromPhrase(mnemonic.trim());
    const tronAddress = ethAddressToTron(wallet.address);
    return {
      chain: "tron",
      address: tronAddress,
      mnemonic: mnemonic.trim(),
      privateKey: wallet.privateKey,
    };
  },

  async getBalance(address: string): Promise<string> {
    // TronGrid → TronStack fallback, so a 429 / 5xx on the primary doesn't
    // fail the whole call. Previously used raw fetch on TRONGRID_API only —
    // surfaced as a "GET … 429 (Too Many Requests)" in the dev console under
    // load — and then a fallback that asked TronStack for a path it does not
    // serve (`readTronBalanceSun`).
    const sun = await readTronBalanceSun(address);
    // Six fixed decimals, as before, but without the float division.
    return `${sun / 1_000_000n}.${(sun % 1_000_000n).toString().padStart(6, "0")}`;
  },

  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    const wallet = new ethers.Wallet(privateKey.trim());
    const fromHex = tronAddressToHex(ethAddressToTron(wallet.address));
    const toHex = tronAddressToHex(to);
    // Exact decimal parsing (throws past 6 decimals) instead of the float
    // round trip `Math.round(parseFloat(amount) * 1e6)`.
    const sun = ethers.parseUnits(amount.trim(), 6);
    if (sun <= 0n) throw new Error("Amount must be greater than zero.");
    if (sun > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is too large.");

    // Create transaction via TronGrid (with TronStack fallback).
    const createResp = await tronFetch(`/wallet/createtransaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_address: fromHex,
        to_address: toHex,
        amount: Number(sun),
      }),
    });
    if (!createResp.ok) throw new Error("Failed to create TRX transaction");
    const txData = await createResp.json();
    // A refusal is HTTP 200 with an `Error` field and no transaction.
    if (txData?.Error) {
      throw new Error(`TRX transfer refused: ${tronNodeMessage(txData.Error)}`);
    }
    // Sign only what we asked for (see `tron-tx-verify.ts`).
    verifyTronTransaction(txData, { kind: "trx", ownerHex: fromHex, toHex, amountSun: sun });

    // Sign the transaction
    const txID = txData.txID;
    const signingKey = new ethers.SigningKey(privateKey.trim());
    const signature = signingKey.sign(hexToBytes(txID));
    const sigHex =
      signature.r.slice(2) +
      signature.s.slice(2) +
      (signature.v === 27 ? "00" : "01");

    txData.signature = [sigHex];

    // Broadcast (with fallback). Tron node propagation: regardless of
    // which API mirror accepts the broadcast, the tx fans out across
    // the actual Tron network within a block, so the first acceptance is
    // final. A node answering DUP_TRANSACTION_ERROR for this id, or an
    // answer that never came, is not a failure (`broadcastTronTransaction`).
    await broadcastTronTransaction(txData, "TRX");
    return { hash: txID };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const resp = await tronFetch(`/wallet/getnowblock`);
      const data = await resp.json();
      const blockNum = data.block_header?.raw_data?.number;
      return {
        label: "Block",
        value: blockNum ? blockNum.toLocaleString() : "N/A",
        unit: "",
      };
    } catch {
      return { label: "Network", value: "Mainnet", unit: "" };
    }
  },

  /**
   * TronGrid, then TronScan (`tron-history.ts`). Until 2026-09-30 the
   * fallback was TronStack's `/v1/*`, which is always 404: a TronGrid 429
   * surfaced as "HTTP 404 from https://api.tronstack.io/…" and TRX sat in
   * the Activity header's error list (operator report 2026-09-30).
   */
  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    return fetchTrxHistory(address, opts, TRON_HISTORY_SOURCES, hexToTronAddress);
  },

  /**
   * Who sent one transaction and who received it, by txid: TronGrid's
   * `/wallet/gettransactionbyid`, then TronScan (`tron-history.ts`).
   */
  async getTransactionParties(hash: string): Promise<TxParties | null> {
    return fetchTrxParties(hash, TRON_HISTORY_SOURCES, hexToTronAddress);
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // Standard TRX transfer is 268 bytes ≈ 268 bandwidth points. Free tier
    // covers most simple transfers; if exhausted, the network burns ~0.268 TRX
    // (1 sun/byte). Surface that ceiling as the practical fee — TronGrid
    // exposes the per-byte cost via `getchainparameters` (key
    // `getTransactionFee`, default 1000 sun/byte).
    let perByte = 1000; // default per Tron docs
    try {
      // Spaced like every other TronGrid call (2026-09-30): this one was not,
      // and it lands in the same burst as the balance and history reads.
      await trongridSlot();
      const params = await proxyGetJson<{ chainParameter: { key: string; value?: number }[] }>(
        `${TRONGRID_API}/wallet/getchainparameters`
      );
      const txFee = params.chainParameter.find(
        (p) => p.key === "getTransactionFee"
      );
      if (txFee?.value) perByte = txFee.value;
    } catch {
      /* keep default */
    }
    const standardSize = 268;
    const trxFee = ((perByte * standardSize) / 1_000_000).toFixed(6);
    return {
      normal: { value: trxFee, eta: "if no free bandwidth" },
      unit: "TRX",
      fetchedAt: Date.now(),
      raw: { perByte, size: standardSize },
    };
  },
};

/** `41…` hex (as TronGrid prints addresses) → a `T…` address; "" for anything else. */
export function hexToTronAddress(hex: string): string {
  if (!hex) return "";
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Tron addresses are 21-byte bs58check (0x41 prefix + 20-byte address).
  const b = hexToBytes(clean);
  if (b.length !== 21) return "";
  return bs58check.encode(b);
}
