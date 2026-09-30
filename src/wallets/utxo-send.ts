/**
 * Send-side helpers shared by the Bitcoin-family adapters — BTC, LTC, DOGE,
 * DASH, BCH and RVN (2026-09-29).
 *
 * # Why these live in one place
 *
 * The 2026-09-29 send-safety audit bundled the six adapters' real send code
 * against a fake explorer network, checked every signed input against
 * bitcoinjs-lib's own sighash and verified the signatures with tiny-secp256k1.
 * Signing was correct everywhere. What was wrong was everything around it, and
 * it was wrong the same way in every file, because each file had its own copy:
 *
 *  - a broadcast ladder that said "failed" after an endpoint may already have
 *    relayed the transaction — one more press then paid the recipient twice;
 *  - `parseFloat` on the amount, so "1,5" sent 1 and "0.9abc" sent 0.9;
 *  - a recipient output assumed to be 31 or 34 vB whatever its script was;
 *  - dust and fee limits that did not match the chain.
 *
 * One implementation of each, here, so the six cannot drift apart again. The
 * pure coin SELECTION stays in `utxo-account.ts` (`planAccountSpend`); what is
 * here is the part around it that decides what may be sent and what happened
 * to it.
 */
import * as bitcoin from "bitcoinjs-lib";
import { sha256 } from "@noble/hashes/sha2.js";
import { decimalToAtomic } from "./decimal-amount";
import { httpProxyCall } from "./_proxy";
import { SendOutcomeUnknownError } from "./send-outcome";
import { errorText } from "../lib/errorText";
import type { TxResult } from "./types";

// ── Amounts ────────────────────────────────────────────────────────────────

/**
 * The amount to send, in base units (1e-8 of the coin on all six chains).
 *
 * Strict, through `decimalToAtomic`: every one of these adapters used
 * `Math.round(parseFloat(amount) * 1e8)`, which reads "1,5" as 1, "1.000,50"
 * as 1 and "0.9abc" as 0.9 — and the send went out for that amount, reported
 * as a success. A number past 2^53 base units is refused rather than rounded,
 * because the shared planner works in `number`.
 */
export function parseSendAmountSat(amount: string, ticker: string): number {
  const atomic = decimalToAtomic(amount, 8, `${ticker} amount`);
  if (atomic <= 0n) throw new Error("Amount must be greater than zero.");
  if (atomic > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${String(amount).trim()} ${ticker} is more than this wallet can select safely ` +
        "(2^53 base units). Nothing was sent.",
    );
  }
  return Number(atomic);
}

// ── Recipients ─────────────────────────────────────────────────────────────

/** The standard output templates these adapters can pay. */
export type OutputKind = "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr";

/** Every template, for chains with SegWit and Taproot active (BTC, LTC). */
export const SEGWIT_CHAIN_OUTPUTS: readonly OutputKind[] = ["p2pkh", "p2sh", "p2wpkh", "p2wsh", "p2tr"];
/** Chains that never activated SegWit (DOGE, DASH, RVN). */
export const LEGACY_CHAIN_OUTPUTS: readonly OutputKind[] = ["p2pkh", "p2sh"];

/** Which standard template a locking script is, by its exact bytes; null for anything else. */
export function outputKind(script: Uint8Array): OutputKind | null {
  const s = script;
  const n = s.length;
  if (n === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac) {
    return "p2pkh";
  }
  if (n === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return "p2sh";
  if (n === 22 && s[0] === 0x00 && s[1] === 0x14) return "p2wpkh";
  if (n === 34 && s[0] === 0x00 && s[1] === 0x20) return "p2wsh";
  if (n === 34 && s[0] === 0x51 && s[1] === 0x20) return "p2tr";
  return null;
}

/**
 * The address inside what a person pasted: trimmed, and with a BIP-21-style
 * payment URI (`bitcoin:<addr>?amount=…`) cut down to the address. Only the
 * chain's own schemes are stripped — anything else is left for the decoder to
 * refuse. The URI's `amount` is ignored: the amount typed in the form is the
 * one that is sent.
 */
export function stripPaymentUri(input: string, schemes: readonly string[]): string {
  let s = String(input ?? "").trim();
  const colon = s.indexOf(":");
  if (colon > 0 && schemes.includes(s.slice(0, colon).toLowerCase())) s = s.slice(colon + 1);
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  return s.trim();
}

/**
 * Decode a recipient to the output script it will be paid with — or refuse.
 *
 * Refused, before anything is scanned or signed:
 *  - anything the chain's network parameters cannot decode;
 *  - any template outside `allowed`. That includes SegWit v2+ ("future
 *    SegWit") addresses, which bitcoinjs-lib would turn into an output
 *    anyone may be able to spend today, and — for DOGE/DASH/RVN — every
 *    bech32 form at all.
 */
export function recipientOutput(
  to: string,
  opts: {
    network: bitcoin.Network;
    ticker: string;
    uriSchemes: readonly string[];
    allowed: readonly OutputKind[];
  },
): { address: string; script: Uint8Array; kind: OutputKind } {
  const address = stripPaymentUri(to, opts.uriSchemes);
  // Screen bech32 versions first: bitcoinjs-lib turns a v2+ address into a
  // script (with a console warning) rather than refusing it.
  try {
    const b = bitcoin.address.fromBech32(address);
    if (b.version > 1) {
      throw new Error(
        `${address} is a SegWit version ${b.version} address. No wallet can safely pay that ` +
          "output type yet, so nothing was sent.",
      );
    }
  } catch (e) {
    if (e instanceof Error && /SegWit version/.test(e.message)) throw e;
    /* not bech32 — the base58 path below decides */
  }
  let script: Uint8Array;
  try {
    script = bitcoin.address.toOutputScript(address, opts.network);
  } catch {
    throw new Error(`${JSON.stringify(address)} is not a ${opts.ticker} address. Nothing was sent.`);
  }
  const kind = outputKind(script);
  if (!kind || !opts.allowed.includes(kind)) {
    throw new Error(
      `${address} decodes to a ${kind ?? "non-standard"} output, which this wallet does not ` +
        `pay on ${opts.ticker}. Nothing was sent.`,
    );
  }
  return { address, script, kind };
}

/**
 * `Network.bech32` for chains that never activated SegWit (DOGE, DASH).
 *
 * It used to be "doge" / "dash" — a real, matchable human-readable part, so a
 * checksum-valid `doge1q…` string decoded to a P2WPKH output: a script
 * Dogecoin nodes treat as anyone-can-spend (2026-09-29 send-safety audit). A
 * decoded bech32 prefix is always lower-case and never contains a space, so
 * this value can match no address, and encoding with it throws.
 */
export const NO_SEGWIT_BECH32 = "NO SEGWIT";

/**
 * Try read sources in order; the first answer wins. When all fail, the error
 * names EVERY source with what it said — the per-file copies kept only the
 * last one, which hid the reply that mattered (2026-09-29 send-safety audit).
 */
export async function trySources<T>(
  ticker: string,
  sources: ReadonlyArray<{ name: string; fn: () => Promise<T> }>,
): Promise<T> {
  const failures: string[] = [];
  for (const s of sources) {
    try {
      return await s.fn();
    } catch (e) {
      failures.push(`${s.name}: ${clip(errorText(e, "no reply"))}`);
    }
  }
  throw new Error(`All ${sources.length} ${ticker} source(s) failed — ${failures.join("; ")}`);
}

/** Serialized size of one output: 8-byte value, script-length varint, script. */
export function outputVBytes(scriptLength: number): number {
  const varint = scriptLength < 0xfd ? 1 : scriptLength <= 0xffff ? 3 : 5;
  return 8 + varint + scriptLength;
}

// ── Dust ───────────────────────────────────────────────────────────────────

/**
 * Relay dust fee rates, base units per kB — the `DUST_RELAY_TX_FEE` of each
 * chain's node. An output worth less than it costs to spend at this rate is
 * non-standard and every default node refuses to relay the transaction.
 *
 * LITECOIN IS 30,000, ten times Bitcoin's. `ltc-wallet.ts` used Bitcoin's 546
 * for years; a P2WPKH output's real threshold there is 2,940 lits, so change
 * of 547–2,939 lits was emitted and the whole transaction was refused at relay
 * (2026-09-29 send-safety audit). DOGE is not listed: its policy is a flat
 * soft-dust floor (see `DOGE_DUST_SAT` in `doge-wallet.ts`).
 */
export const DUST_RELAY_FEE_PER_KB = {
  bitcoin: 3_000,
  litecoin: 30_000,
  dash: 3_000,
  ravencoin: 3_000,
  // BCHN computes 3 × dustRelayFee(1,000/kB) × size — the same numbers.
  "bitcoin-cash": 3_000,
} as const;

/**
 * Bitcoin Core's `GetDustThreshold`: what it costs, at the dust relay rate, to
 * create this output and later spend it — 67 bytes of input for a witness
 * program, 148 for anything else.
 */
export function dustThresholdSat(script: Uint8Array, dustRelayFeePerKb: number): number {
  const kind = outputKind(script);
  const witness = kind === "p2wpkh" || kind === "p2wsh" || kind === "p2tr";
  const spend = witness ? 32 + 4 + 1 + Math.floor(107 / 4) + 4 : 32 + 4 + 1 + 107 + 4;
  return Math.floor((dustRelayFeePerKb * (outputVBytes(script.length) + spend)) / 1000);
}

/** Refuse a payment the network will not relay because the output is dust. */
export function assertNotDust(valueSat: number, minimumSat: number, ticker: string): void {
  if (valueSat < minimumSat) {
    throw new Error(
      `${(valueSat / 1e8).toFixed(8)} ${ticker} is below the network's dust limit for that ` +
        `address (${(minimumSat / 1e8).toFixed(8)} ${ticker}): nodes do not relay a payment ` +
        "that small. Nothing was sent.",
    );
  }
}

// ── Fee sanity ─────────────────────────────────────────────────────────────

/**
 * Refuse a signed transaction whose fee is out of all proportion, BEFORE it is
 * broadcast. The last line of defence against a unit mix-up or a runaway fee
 * oracle; the rate chosen upstream should never come near it.
 *
 * `foldAllowanceSat` is the change that may legitimately have been dropped
 * into the fee because it was below dust — on DOGE that is up to 0.01 DOGE,
 * which alone pushes a one-input send past bitcoinjs-lib's generic 5,000 sat/B
 * guard (2026-09-29 send-safety audit). Adapters that call this extract with
 * the generic guard off and rely on this chain-aware one instead; BCH, which
 * serializes by hand, had no guard at all.
 */
export function assertFeeWithinCap(args: {
  ticker: string;
  feeSat: number;
  vbytes: number;
  maxSatPerVByte: number;
  foldAllowanceSat: number;
}): void {
  const cap = Math.ceil(args.maxSatPerVByte * args.vbytes) + args.foldAllowanceSat;
  if (!Number.isFinite(args.feeSat) || args.feeSat < 0) {
    throw new Error(`${args.ticker}: the built transaction has an invalid fee (${args.feeSat}). Nothing was sent.`);
  }
  if (args.feeSat > cap) {
    throw new Error(
      `${args.ticker}: this transaction would pay ${(args.feeSat / 1e8).toFixed(8)} ${args.ticker} ` +
        `in fees (${(args.feeSat / args.vbytes).toFixed(1)} per vbyte), above the wallet's sanity ` +
        `cap of ${args.maxSatPerVByte} per vbyte. Nothing was sent.`,
    );
  }
}

// ── Transaction ids ────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * txid of a legacy-serialized (no witness) transaction: double SHA-256,
 * byte-reversed. For BCH, which is serialized by hand; the bitcoinjs-built
 * chains use `Transaction.getId()`.
 */
export function txidOfLegacyRawHex(rawHex: string): string {
  const h = sha256(sha256(hexToBytes(rawHex)));
  return Array.from(h)
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const TXID = /^[0-9a-f]{64}$/i;

// ── Broadcasting: once, and honestly ───────────────────────────────────────
//
// # The incident this closes (2026-09-29 send-safety audit, CRITICAL)
//
// Each adapter pushed its signed hex along a ladder of explorers and threw
// "All N source(s) failed" when none replied with a txid. A lost reply — a
// dropped connection, the proxy's 30 s timeout — on an endpoint that HAD
// relayed the transaction, followed by 429/430/403 from the rest, therefore
// read as a failure. The Send form stayed filled; a second press re-scanned the
// account, and the explorers no longer listed the inputs the first transaction
// had spent, so a NEW transaction was built from other coins: nothing in common
// with the first for the network to reject, and the recipient was paid twice.
// Reproduced offline on BTC, LTC, DOGE, DASH and BCH (DOGE and DASH have only
// two live endpoints, so a lost reply is not a remote case).
//
// # What happens now
//
//  1. The txid is computed locally before anything is sent.
//  2. Every endpoint gets those exact bytes. A signed transaction is never
//     rebuilt or re-signed within the send.
//  3. The first acceptance — or an "already in mempool / already exists" reply,
//     which means it is on the network — is success.
//  4. If every endpoint errors, the txid is looked up. Found → success.
//  5. Not found, and EVERY reply rules out that the transaction reached the
//     network (a node's validation reason, or a request refused before it was
//     processed) → an ordinary Error quoting every endpoint. Nothing was sent
//     and a retry is safe.
//  6. Otherwise → `SendOutcomeUnknownError(txid)`: the UI closes the form and
//     says "may have been sent", so the same press cannot be repeated.

/** An endpoint's reply that was not an acceptance, kept whole for classification. */
export class BroadcastReplyError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, reply?: { status?: number; body?: string }) {
    super(message);
    this.name = "BroadcastReplyError";
    this.status = reply?.status;
    this.body = reply?.body;
  }
}

export interface BroadcastEndpoint {
  name: string;
  /** Relay the hex. Resolve on acceptance (with the id the endpoint reported);
   *  throw — ideally a {@link BroadcastReplyError} — on anything else. */
  send(rawHex: string): Promise<string>;
}

export interface TxLookup {
  name: string;
  /** true only when the explorer positively knows this txid. */
  find(txid: string): Promise<boolean>;
}

/**
 * - `known`     — the node already has it: success.
 * - `rejected`  — a node evaluated it and refused it (its reason is in the
 *                 reply). It was not relayed through this endpoint.
 * - `refused`   — the request was turned away before anything processed it
 *                 (rate limit, blacklist, missing route, a web page instead of
 *                 an API, a host the proxy will not call).
 * - `ambiguous` — anything that does not rule out a relay: a lost or garbled
 *                 reply, a gateway or server error.
 */
export type BroadcastFailureKind = "known" | "rejected" | "refused" | "ambiguous";

/** "The node already has this transaction", as Core-family nodes and explorers word it. */
const ALREADY_KNOWN: RegExp[] = [
  /txn-already-in-mempool/i,
  /txn-already-known/i,
  /txn-same-nonwitness-data-in-mempool/i,
  /already in (?:the )?mempool/i,
  /already in (?:the )?block ?chain/i,
  /outputs already in utxo set/i,
  /already have transaction/i,
  /\b(?:transaction|tx)\b[^.\n]{0,120}\balready exists/i,
  /"code"\s*:\s*-27\b/,
];

/**
 * Validation reasons from a node that looked at the transaction and refused it
 * (Bitcoin Core family `sendrawtransaction`, codes -22/-25/-26). A node that
 * already holds the transaction answers "already …" instead, which is checked
 * first, so none of these can be our own transaction echoed back.
 */
const NODE_REJECTION: RegExp[] = [
  /bad-txns/i,
  /min relay fee not met/i,
  /mempool min fee not met/i,
  /insufficient (?:priority|fee)/i,
  /\bdust\b/i,
  /non-?standard/i,
  /mandatory-script-verify-flag/i,
  /scriptsig-(?:size|not-pushonly)/i,
  /\bscriptpubkey\b/i,
  /\btx-size\b/i,
  /non-(?:bip68-)?final/i,
  /bare-multisig/i,
  /multi-op-return/i,
  /too-long-mempool-chain/i,
  /txn-mempool-conflict/i,
  /absurdly-high-fee|max-fee-exceeded|fee exceeds maximum/i,
  /missing[- ]inputs/i,
  /tx decode failed/i,
  /"code"\s*:\s*-2[256]\b/,
];

/** Statuses a server answers WITHOUT processing the request. */
const NOT_PROCESSED = new Set([401, 402, 403, 404, 405, 429, 430]);

export function classifyBroadcastFailure(e: unknown): BroadcastFailureKind {
  const status = e instanceof BroadcastReplyError ? e.status : undefined;
  const body = e instanceof BroadcastReplyError ? (e.body ?? "") : "";
  const text = `${errorText(e, "")}\n${body}`;
  if (ALREADY_KNOWN.some((re) => re.test(text))) return "known";
  if (NODE_REJECTION.some((re) => re.test(text))) return "rejected";
  if (status !== undefined) {
    if (NOT_PROCESSED.has(status)) return "refused";
    // A web page (the dead FullStack host serves its marketing site for every
    // path, with HTTP 200) is not a broadcast API that could have relayed.
    if (status >= 200 && status < 300 && /^\s*</.test(body)) return "refused";
    return "ambiguous";
  }
  // Errors raised before the request left this machine.
  if (/not on the http_proxy allowlist|Refusing to proxy non-https|unsupported method/i.test(text)) {
    return "refused";
  }
  return "ambiguous";
}

function clip(s: string, n = 180): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * Interpret an endpoint's HTTP reply: the txid it reports, or a
 * {@link BroadcastReplyError} carrying status and body. A 2xx reply with no
 * recognisable txid is NOT an acceptance — it is classified like any other
 * reply (a web page is `refused`; anything else stays `ambiguous`).
 */
export function acceptPushReply(
  status: number,
  body: string,
  txidFrom: (body: string) => unknown,
): string {
  if (status >= 200 && status < 300) {
    let txid: unknown;
    try {
      txid = txidFrom(body);
    } catch {
      txid = undefined;
    }
    if (typeof txid === "string" && TXID.test(txid.trim())) return txid.trim().toLowerCase();
    throw new BroadcastReplyError(`HTTP ${status} without a transaction id: ${clip(body)}`, { status, body });
  }
  throw new BroadcastReplyError(`HTTP ${status}: ${clip(body)}`, { status, body });
}

/** A broadcast endpoint reached through the Rust proxy (every chain but BTC). */
export function proxyPushEndpoint(
  name: string,
  build: (rawHex: string) => { url: string; body: string; contentType: string },
  txidFrom: (body: string) => unknown,
): BroadcastEndpoint {
  return {
    name,
    async send(rawHex) {
      const req = build(rawHex);
      const r = await httpProxyCall({
        method: "POST",
        url: req.url,
        body: req.body,
        headers: { "Content-Type": req.contentType },
      });
      return acceptPushReply(r.status, r.body ?? "", txidFrom);
    },
  };
}

/** A txid lookup through the Rust proxy; `pick` names the field that must equal the txid. */
export function proxyTxLookup(
  name: string,
  url: (txid: string) => string,
  pick: (json: any, txid: string) => unknown,
): TxLookup {
  return {
    name,
    async find(txid) {
      const r = await httpProxyCall({ method: "GET", url: url(txid) });
      if (r.status < 200 || r.status >= 300) return false;
      return pickedTxid(r.body, txid, pick);
    },
  };
}

/** Same as {@link proxyTxLookup}, over `fetch` (BTC's Esplora hosts). */
export function fetchTxLookup(
  name: string,
  url: (txid: string) => string,
  pick: (json: any, txid: string) => unknown,
): TxLookup {
  return {
    name,
    async find(txid) {
      const resp = await fetch(url(txid));
      if (!resp.ok) return false;
      return pickedTxid(await resp.text(), txid, pick);
    },
  };
}

function pickedTxid(body: string, txid: string, pick: (json: any, txid: string) => unknown): boolean {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return false;
  }
  const v = pick(json, txid);
  return typeof v === "string" && v.toLowerCase() === txid.toLowerCase();
}

/**
 * Broadcast one signed transaction along `endpoints`, and say truthfully what
 * happened. See the section header above for the rules and the incident.
 *
 * Success resolves `{ hash: txid, pending: true }`: the network has it, and a
 * UTXO send is never confirmed at the moment it is accepted.
 */
export async function broadcastSignedTx(args: {
  ticker: string;
  /** Computed locally from the signed bytes, before anything is sent. */
  txid: string;
  rawHex: string;
  endpoints: ReadonlyArray<BroadcastEndpoint>;
  lookups: ReadonlyArray<TxLookup>;
}): Promise<TxResult> {
  const txid = args.txid.toLowerCase();
  if (!TXID.test(txid)) throw new Error(`${args.ticker}: invalid local txid ${args.txid}; nothing was sent.`);
  if (args.endpoints.length === 0) throw new Error(`${args.ticker}: no broadcast endpoint configured; nothing was sent.`);
  const ok: TxResult = { hash: txid, pending: true };

  const failures: Array<{ name: string; kind: BroadcastFailureKind; text: string }> = [];
  for (const ep of args.endpoints) {
    try {
      // The endpoint's own id is not needed: ours is computed from the bytes
      // it accepted, and an endpoint cannot have relayed anything else.
      await ep.send(args.rawHex);
      return ok;
    } catch (e) {
      const kind = classifyBroadcastFailure(e);
      if (kind === "known") return ok;
      failures.push({ name: ep.name, kind, text: clip(errorText(e, "no reply")) });
    }
  }

  for (const lk of args.lookups) {
    try {
      if (await lk.find(txid)) return ok;
    } catch {
      /* a lookup that cannot answer proves nothing either way */
    }
  }

  const detail = failures.map((f) => `${f.name}: ${f.text}`).join("; ");
  if (failures.length > 0 && failures.every((f) => f.kind === "rejected" || f.kind === "refused")) {
    throw new Error(
      `${args.ticker}: no broadcast endpoint accepted the transaction, and every reply rules ` +
        `out that it reached the network, so nothing was sent — ${detail}`,
    );
  }
  // Read standalone (the sweep and consolidation panels show it as-is) and as
  // the detail `useSend` appends to its own "check before sending again".
  throw new SendOutcomeUnknownError(
    `${args.ticker} transaction ${txid} may have been sent: no broadcast endpoint confirmed ` +
      `it, and not every reply rules that out (${detail}).`,
    txid,
  );
}
