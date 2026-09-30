/**
 * Dashboard **Send** for the three chains whose signer lives in Rust behind a
 * swap session: Stellar, NEAR and Sui.
 *
 * # Why these three were receive-only
 *
 * Their adapters' `sendTransaction` threw. Not because the crypto was missing —
 * `swap_sign_stellar_tx`, `swap_sign_near_tx` and `swap_sign_sui_tx` have all
 * existed in Rust for months — but because of two gaps:
 *
 * 1. **The signers are session-gated.** `state.with_session(&session_id, …)`
 *    holds the vault mnemonic inside Rust and hands out a short-lived id. That
 *    is the whole point of the design: the mnemonic never crosses the invoke
 *    boundary. A wallet adapter has no session and cannot open one (it would
 *    have to import the vault + swap layers, which `BOUNDARIES.md` forbids in
 *    that direction), so `sendTransaction` had nowhere to go.
 *
 * 2. **Rust only SIGNS; it never builds.** `SignStellarInput` takes a
 *    pre-built `tx_xdr_base64`, `SignSuiInput` a pre-built
 *    `tx_bytes_base64` — and nothing in TypeScript had ever produced either.
 *    A grep for `txXdrBase64` / `txBytesBase64` across the whole frontend
 *    returned zero hits: the Rust signers were reachable but unreached.
 *
 * This module closes both. It builds the transaction with each chain's own
 * SDK (hand-rolling XDR or BCS for money movement is not a risk worth taking),
 * signs it through the session, and submits it.
 *
 * # Where it is called from
 *
 * The app layer, through `useSend`'s existing `sendOverride` hook — the same
 * escape hatch `sharedCoinSendOverride` already uses for BTC/LTC. That keeps
 * the direction of dependency right: features may import wallets, wallets may
 * not import features.
 *
 * Since 2026-09-30 `executeStellarTransfer` and `executeSuiTransfer` are ALSO
 * the NEAR Intents deposit path for XLM and SUI (`swap-execute.ts`), so a
 * swap deposit and a dashboard send are one piece of code. The Stellar
 * deposit carries the quote's memo, and passes `destinationMustExist`.
 *
 * # 2026-09-29 send-safety audit
 *
 * Every function here now follows the wallet-wide rule: validate everything
 * that can be decided before signing (a plain error, safe to retry); sign
 * ONCE; submit those exact bytes; and settle an uncertain submit by looking
 * the transaction up by its hash. What cannot be settled is reported as
 * `SendOutcomeUnknownError` with the hash — never as "failed", which invited a
 * second press that signed a NEW transaction and paid twice.
 *
 * The Rust signers hold the key of the vault's recovery phrase at the standard
 * path. A wallet imported from a private key (or at another path) shows an
 * address those keys do not control; Stellar then failed with `tx_bad_auth`,
 * Sui with a signature mismatch, and NEAR built the transfer FROM the phrase's
 * account instead of the one on screen. Each send now checks the signer's
 * address against the wallet's before signing, and refuses on a mismatch.
 */
import { atomicToDecimal, decimalToAtomic } from "../../wallets/decimal-amount";
import { getNearAddress, lockSwap, unlockSwap } from "../../api/swap-rust";
import { invoke } from "../../lib/tauri";
import type { EncryptedData } from "../../crypto";
import type { SendMemo, TxResult } from "../../wallets/types";
import { SendOutcomeUnknownError } from "../../wallets/send-outcome";
import { SUI_RPC, suiAddressFromPublicKey } from "../../wallets/sui-wallet";
import { ed25519 } from "@noble/curves/ed25519.js";
import { executeNearNativeTransfer } from "./swap-sources";

/** Rust's `SignedStellar`. */
interface SignedStellar {
  publicKeyBase64: string;
  hintBase64: string;
  signatureBase64: string;
}

/** Rust's `SignedSui`. */
interface SignedSui {
  signatureBase64: string;
  publicKeyBase64: string;
}

const HORIZON = "https://horizon.stellar.org";

/**
 * Stellar's base reserve, 0.5 XLM in stroops. A network parameter; Horizon
 * reported `base_reserve_in_stroops: 5000000` on 2026-09-29, the value since
 * 2017.
 */
export const STELLAR_BASE_RESERVE_STROOPS = 5_000_000n;

/**
 * The fee bid on every Stellar send, 0.01 XLM in stroops. Only the network's
 * going rate (normally 100 stroops) is charged, but the account must be able
 * to cover the bid, so the spendable check reserves all of it.
 */
const STELLAR_FEE_BID_STROOPS = 100_000n;

/** The largest Stellar MEMO_ID, 2^64 - 1. */
const MAX_MEMO_ID = 18446744073709551615n;

/** Stellar's MEMO_TEXT limit, in UTF-8 bytes. */
const STELLAR_MEMO_TEXT_MAX_BYTES = 28;

/**
 * Timing. Mutable for tests only.
 *
 *  - `stellarTimeoutSecs`: the transaction's timebound. After the ledger's
 *    clock passes it, the transaction can never apply — which is what lets an
 *    uncertain submit be settled as "did not happen" rather than "unknown".
 *  - `stellarLedgerMarginSecs`: how far past the timebound Horizon's latest
 *    ledger must be before a missing transaction counts as expired.
 *    horizon.stellar.org is a pool of servers that can be a few ledgers apart.
 *  - `stellarGraceMs`: how long past the timebound to keep asking.
 *  - `suiLookupMs`: how long to look for a Sui transaction whose submit failed.
 */
export const SESSION_SEND_TIMING = {
  pollMs: 3_000,
  stellarTimeoutSecs: 180,
  stellarLedgerMarginSecs: 30,
  stellarGraceMs: 60_000,
  suiLookupMs: 30_000,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Open a signing session from the encrypted vault. Short-lived by
 * construction (Rust auto-relocks on TTL), and the caller should treat the id
 * as valid only for the operation it was opened for.
 */
export async function openSendSession(
  encrypted: EncryptedData,
  password: string,
): Promise<string> {
  const s = await unlockSwap(encrypted, password);
  return s.sessionId;
}

/**
 * Lock the signing session a send opened, once the send is over (2026-09-29
 * send-safety audit). It used to stay open until Rust's 5-minute TTL.
 *
 * Rust holds ONE session and `swap_lock` wipes whichever one is open, so this
 * locks only if `sessionId` is still that one: a swap that unlocked while the
 * send was being confirmed owns the session now, and wiping it would fail the
 * swap's next signature. The check is a session-gated read that fails for any
 * other id. Never throws.
 */
export async function closeSendSession(sessionId: string): Promise<void> {
  try {
    await invoke<string>("swap_get_sui_address", { sessionId });
  } catch {
    return; // expired, or no longer ours to close
  }
  try {
    await lockSwap();
  } catch {
    /* already locked, or no Tauri — nothing to recover */
  }
}

/** `G…ABCD` — enough of an address to tell two apart in a sentence. */
function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** The refusal for a wallet whose address the session's key does not control. */
function keyMismatchText(chain: string, shown: string, signer: string): string {
  return (
    `Sending from this ${chain} wallet isn't supported yet. It shows ${shortAddress(shown)}, ` +
    `but this wallet can only sign for ${shortAddress(signer)}, your recovery phrase's ` +
    `standard ${chain} account. A ${chain} wallet imported from a private key, or at ` +
    `another derivation path, cannot send from here yet. Nothing was signed.`
  );
}

// ─── Stellar ────────────────────────────────────────────────────────────

type StellarBaseModule = typeof import("@stellar/stellar-base");

/** A validated Stellar recipient. `base` is the G account behind an M address. */
interface StellarRecipient {
  address: string;
  base: string;
  muxed: boolean;
}

/**
 * Trimmed, then one of (2026-09-29 send-safety audit):
 *  - `G…`: an account;
 *  - `M…`: a muxed account (one account shared by many users, the user's id
 *    folded into the address). Horizon's account lookup answers 400 for an M
 *    address, which the send used to report as a cryptic HTTP error; the
 *    lookup now uses the base G account, and the payment still goes to the M
 *    address so the id arrives;
 *  - `name*domain` (federation) is refused with an explanation: resolving it
 *    means trusting that domain's server to say where the money goes.
 */
function parseStellarRecipient(input: string, sb: StellarBaseModule): StellarRecipient {
  const t = input.trim();
  if (t.includes("*")) {
    throw new Error(
      "Federation addresses (name*domain) are not supported. Ask the recipient for their Stellar " +
        "account address (it starts with G), and the memo if they use one.",
    );
  }
  if (sb.StrKey.isValidEd25519PublicKey(t)) return { address: t, base: t, muxed: false };
  if (sb.StrKey.isValidMed25519PublicKey(t)) {
    return { address: t, base: sb.extractBaseAddress(t), muxed: true };
  }
  throw new Error(
    "That is not a Stellar address. A Stellar address starts with G (or M, for a muxed account) " +
      "and is written in capital letters and digits. Check it and paste it again.",
  );
}

/** The memo, re-validated here: never trust that a caller checked it. */
function stellarMemo(memo: SendMemo | undefined, sb: StellarBaseModule) {
  if (!memo) return sb.Memo.none();
  if (memo.type === "id") {
    // `Memo.id` itself accepts "0x10" (as 16) and 2^64 (as 0), checked
    // 2026-09-29, so it is not the validator.
    if (!/^\d{1,20}$/.test(memo.value) || BigInt(memo.value) > MAX_MEMO_ID) {
      throw new Error("A memo ID is a whole number from 0 to 18446744073709551615. Nothing was sent.");
    }
    return sb.Memo.id(BigInt(memo.value).toString());
  }
  const bytes = new TextEncoder().encode(memo.value).length;
  if (bytes > STELLAR_MEMO_TEXT_MAX_BYTES) {
    throw new Error(
      `A text memo is at most ${STELLAR_MEMO_TEXT_MAX_BYTES} bytes; this one is ${bytes}. Nothing was sent.`,
    );
  }
  return sb.Memo.text(memo.value);
}

/**
 * SEP-29: an account that sets data entry `config.memo_required` to "1"
 * (base64 "MQ==") refuses payments without a memo — in practice an exchange.
 * The shape was checked against a mainnet account carrying it, 2026-09-29.
 */
function requiresMemo(account: { data?: Record<string, string> } | null): boolean {
  const v = account?.data?.["config.memo_required"];
  if (typeof v !== "string") return false;
  try {
    return atob(v) === "1";
  } catch {
    return false;
  }
}

interface HorizonAccountJson {
  sequence: string;
  subentry_count?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances?: Array<{ asset_type: string; balance: string; selling_liabilities?: string }>;
  data?: Record<string, string>;
}

/**
 * What the account may send, in stroops (2026-09-29 send-safety audit). The
 * displayed balance includes Stellar's minimum balance — (2 + entries) × 0.5
 * XLM, counting trustlines, offers, data entries and signers, adjusted for
 * sponsorships — which can never be sent; so a full-balance send failed on
 * chain and still cost a fee. Selling liabilities (XLM on open offers) and the
 * fee bid come out too.
 */
function stellarSpendable(acct: HorizonAccountJson): { spendable: bigint; minBalance: bigint } {
  const native = acct.balances?.find((b) => b.asset_type === "native");
  const balance = native ? decimalToAtomic(native.balance, 7, "XLM balance") : 0n;
  const selling = native?.selling_liabilities
    ? decimalToAtomic(native.selling_liabilities, 7, "XLM liabilities")
    : 0n;
  const entries =
    2n +
    BigInt(acct.subentry_count ?? 0) +
    BigInt(acct.num_sponsoring ?? 0) -
    BigInt(acct.num_sponsored ?? 0);
  const minBalance = (entries > 0n ? entries : 0n) * STELLAR_BASE_RESERVE_STROOPS;
  const spendable = balance - minBalance - selling - STELLAR_FEE_BID_STROOPS;
  return { spendable: spendable > 0n ? spendable : 0n, minBalance };
}

/**
 * A response body, parsed only when it says it is JSON (2026-09-29): a
 * gateway's HTML 502 used to reach `res.json()` and throw a SyntaxError that
 * read as "rejected".
 */
async function readJsonBody(res: Response): Promise<any | null> {
  const type = res.headers.get("content-type") ?? "";
  if (!/json/i.test(type)) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function horizonGet(path: string): Promise<{ status: number; ok: boolean; json: any | null }> {
  const r = await fetch(`${HORIZON}${path}`);
  return { status: r.status, ok: r.ok, json: await readJsonBody(r) };
}

/**
 * Native XLM payment.
 *
 * Two Stellar rules this deliberately does not paper over:
 *
 *  - **A destination that does not exist yet needs `createAccount`, not
 *    `payment`.** Sending a `payment` to an unfunded account fails with
 *    `op_no_destination`. Horizon tells us which case we are in, so we pick
 *    the right operation — and creating an account takes at least 1 XLM.
 *  - **The minimum balance is not spendable.** We do not silently deduct it
 *    from what the user typed; a send above what can leave the account is
 *    refused before signing, with the number that can.
 */
export async function executeStellarTransfer(args: {
  sessionId: string;
  fromAddress: string;
  to: string;
  /** Decimal XLM as typed by the user. */
  amount: string;
  memo?: SendMemo;
  /**
   * Refuse, before signing, when the destination account does not exist,
   * instead of creating it with the payment (2026-09-30). Set for a NEAR
   * Intents deposit: 1Click's deposit address is a live account, and it
   * matches deposits by PAYMENT and memo — a createAccount operation carrying
   * the funds is not a deposit it is known to credit.
   */
  destinationMustExist?: boolean;
}): Promise<{ txHash: string }> {
  const sb = await import("@stellar/stellar-base");
  const { Account, Asset, Networks, Operation, StrKey, TransactionBuilder, xdr } = sb;

  // ── Decided before anything is built: plain errors, safe to retry. ──
  const from = args.fromAddress.trim();
  const dest = parseStellarRecipient(args.to, sb);
  // Strict decimal first (2026-09-29): stellar-base's own amount check took
  // "0x10" as 16 XLM, "1e2" as 100 and "+5" as 5.
  const stroops = decimalToAtomic(args.amount, 7, "XLM amount");
  if (stroops <= 0n) throw new Error("Amount must be greater than zero.");
  const amount = atomicToDecimal(stroops, 7);
  const memo = stellarMemo(args.memo, sb);

  const signerAddress = await invoke<string>("swap_get_stellar_address", {
    sessionId: args.sessionId,
  });
  if (signerAddress !== from) throw new Error(keyMismatchText("Stellar", from, signerAddress));

  const src = await horizonGet(`/accounts/${from}`);
  if (src.status === 404) {
    throw new Error(
      "This Stellar account is not funded yet, so it cannot send. It needs at least the 1 XLM base reserve.",
    );
  }
  if (!src.ok || !src.json) {
    throw new Error(`Horizon returned HTTP ${src.status} for the source account.`);
  }
  const acct = src.json as HorizonAccountJson;

  // Does the destination exist? Decides createAccount vs payment. For a muxed
  // address it is the base account that exists or not.
  const dst = await horizonGet(`/accounts/${dest.base}`);
  if (dst.status !== 404 && (!dst.ok || !dst.json)) {
    throw new Error(`Horizon returned HTTP ${dst.status} for the destination.`);
  }
  const destExists = dst.ok;
  if (!destExists && args.destinationMustExist) {
    throw new Error(
      "The deposit address has no Stellar account, so it cannot be receiving deposits. " +
        "The wallet will not create an account with this payment. Nothing was sent.",
    );
  }
  if (!destExists && dest.muxed) {
    throw new Error(
      "The account behind this muxed (M…) address does not exist on Stellar, so it cannot receive. " +
        "Check the address. Nothing was sent.",
    );
  }
  // SEP-29. Skipped for a muxed address, as SEP-29 says: its id already says
  // whose deposit it is.
  if (destExists && !dest.muxed && !args.memo && requiresMemo(dst.json)) {
    throw new Error(
      "This Stellar account requires a memo — it is usually an exchange, which credits deposits by " +
        "memo. Enter the memo the recipient gave you. Nothing was sent.",
    );
  }
  if (!destExists && stroops < 2n * STELLAR_BASE_RESERVE_STROOPS) {
    throw new Error(
      "The recipient's Stellar account does not exist yet, and creating it takes at least 1 XLM. " +
        "Send 1 XLM or more. Nothing was sent.",
    );
  }
  const { spendable, minBalance } = stellarSpendable(acct);
  if (stroops > spendable) {
    throw new Error(
      `You can send at most ${atomicToDecimal(spendable, 7)} XLM from this account. Stellar keeps ` +
        `${atomicToDecimal(minBalance, 7)} XLM of it locked as the account's minimum balance (1 XLM, ` +
        `plus 0.5 XLM for each trustline, offer or other entry), and the network fee, up to 0.01 XLM, ` +
        `comes out of the same balance. Nothing was sent.`,
    );
  }

  const source = new Account(from, String(acct.sequence));
  const tx = new TransactionBuilder(source, {
    fee: STELLAR_FEE_BID_STROOPS.toString(), // a cap; Stellar charges the going rate
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      destExists
        ? Operation.payment({ destination: dest.address, asset: Asset.native(), amount })
        : Operation.createAccount({ destination: dest.base, startingBalance: amount }),
    )
    .addMemo(memo)
    .setTimeout(SESSION_SEND_TIMING.stellarTimeoutSecs)
    .build();
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  // The hash is fixed before signing (signatures are not part of it), so every
  // outcome after the submit can be looked up rather than guessed.
  const hash32 = tx.hash();
  const hash = hash32.toString("hex");

  // Rust signs the raw transaction; we assemble the envelope from the pieces
  // it returns (it deliberately does not know about envelopes).
  const signed = await invoke<SignedStellar>("swap_sign_stellar_tx", {
    sessionId: args.sessionId,
    input: { txXdrBase64: tx.toEnvelope().value().tx().toXDR("base64") },
  });
  const signerKey = Buffer.from(signed.publicKeyBase64, "base64");
  const signature = Buffer.from(signed.signatureBase64, "base64");
  if (StrKey.encodeEd25519PublicKey(signerKey) !== from) {
    throw new Error(
      keyMismatchText("Stellar", from, StrKey.encodeEd25519PublicKey(signerKey)),
    );
  }
  // Nothing leaves the machine unless Stellar would accept the signature.
  if (!ed25519.verify(signature, hash32, signerKey)) {
    throw new Error("The Stellar signature does not verify for this transaction. Nothing was sent.");
  }

  const envelope = tx.toEnvelope();
  envelope.v1().signatures([
    new xdr.DecoratedSignature({
      hint: Buffer.from(signed.hintBase64, "base64"),
      signature,
    }),
  ]);

  return submitStellar(envelope.toXDR("base64"), hash, maxTime);
}

/**
 * Submit once. Only a JSON 400 from Horizon is a decided rejection; anything
 * else after the request left — a 504 (Horizon's own "timed out waiting for a
 * ledger"), another 5xx, a non-JSON body, a dropped connection — may still
 * apply within the timebound, and is settled by hash (2026-09-29 send-safety
 * audit). It used to become "Stellar rejected the transaction" with no hash,
 * and a retry rebuilt the payment with the next sequence number.
 */
async function submitStellar(
  envelopeB64: string,
  hash: string,
  maxTime: number,
): Promise<{ txHash: string }> {
  let res: Response | null = null;
  let why = "";
  try {
    res = await fetch(`${HORIZON}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx: envelopeB64 }),
    });
  } catch (e) {
    why = `the submit did not complete: ${errText(e)}`;
  }
  if (res) {
    const body = await readJsonBody(res);
    if (res.ok && body && body.successful !== false) {
      if (typeof body.hash === "string" && body.hash !== hash) {
        console.warn(`[stellar] Horizon returned hash ${body.hash}, computed ${hash}`);
      }
      return { txHash: hash };
    }
    if (res.status === 400 && body) throw new Error(stellarRejectionText(body, hash));
    why = `Horizon answered HTTP ${res.status}${body ? "" : " without a JSON body"}`;
  }
  return settleStellarByHash(hash, maxTime, why);
}

function stellarRejectionText(body: any, hash: string): string {
  const codes = body?.extras?.result_codes;
  const txCode: string = codes?.transaction ?? "";
  const opCodes: string = Array.isArray(codes?.operations) ? codes.operations.join(",") : "";
  const detail = [txCode, opCodes].filter(Boolean).join(" ") || String(body?.title ?? "");
  if (txCode === "tx_failed") {
    // Included in a ledger and failed there: the sequence number and the fee
    // are spent, nothing else moved.
    return `Stellar included the transaction but it failed (${detail}). Only the network fee was spent. Hash: ${hash}`;
  }
  return `Stellar rejected the transaction${detail ? ` (${detail})` : ""}. Nothing was sent.`;
}

/** Horizon's latest ingested ledger close time, in seconds; null if unknown. */
async function horizonLatestLedgerSecs(): Promise<number | null> {
  try {
    const r = await horizonGet("/");
    const at = r.ok ? r.json?.history_latest_ledger_closed_at : undefined;
    const ms = typeof at === "string" ? Date.parse(at) : NaN;
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  } catch {
    return null;
  }
}

type StellarLookup = "success" | "failed" | "missing" | { error: string };

async function lookupStellarTx(hash: string): Promise<StellarLookup> {
  try {
    const r = await horizonGet(`/transactions/${hash}`);
    if (r.status === 404) return "missing";
    if (r.ok && r.json && typeof r.json.successful === "boolean") {
      return r.json.successful ? "success" : "failed";
    }
    return { error: `HTTP ${r.status} looking the transaction up` };
  } catch (e) {
    return { error: errText(e) };
  }
}

async function settleStellarByHash(
  hash: string,
  maxTime: number,
  why: string,
): Promise<{ txHash: string }> {
  const deadline = Math.max(Date.now(), maxTime * 1000) + SESSION_SEND_TIMING.stellarGraceMs;
  for (;;) {
    // Ledger clock FIRST, then the lookup: every ledger up to that close time
    // is already in Horizon, so a transaction applied in any of them would be
    // found by the lookup that follows.
    const closedAt = await horizonLatestLedgerSecs();
    const found = await lookupStellarTx(hash);
    if (found === "success") return { txHash: hash };
    if (found === "failed") {
      throw new Error(
        `Stellar included the transaction but it failed. Only the network fee was spent. Hash: ${hash}`,
      );
    }
    if (
      found === "missing" &&
      maxTime > 0 &&
      closedAt !== null &&
      closedAt > maxTime + SESSION_SEND_TIMING.stellarLedgerMarginSecs
    ) {
      throw new Error(
        "The Stellar transaction did not reach a ledger before its time limit, so it can no longer go " +
          `through. Nothing was sent; it is safe to send again. Hash: ${hash}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new SendOutcomeUnknownError(
        `Stellar has not confirmed the transaction (${why}). It could still go through until its time limit passes.`,
        hash,
      );
    }
    await sleep(SESSION_SEND_TIMING.pollMs);
  }
}

// ─── Sui ────────────────────────────────────────────────────────────────

/**
 * A Sui recipient: trimmed, lowercased, and exactly `0x` + 64 hex characters
 * (2026-09-29 send-safety audit). The SDK's `transferObjects` zero-pads a
 * short address, so an Ethereum address (0x + 40 hex) or a paste missing its
 * last character became a valid-looking address nobody controls.
 */
export function parseSuiRecipient(input: string): string {
  const t = input.trim().toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(t)) return t;
  const hex = t.replace(/^0x/, "");
  if (/^[0-9a-f]+$/.test(hex)) {
    if (hex.length === 40) {
      throw new Error(
        "That looks like an Ethereum address (40 hex characters). A Sui address has 64. " +
          "Sending to it would put the SUI where nobody can reach it. Nothing was sent.",
      );
    }
    if (hex.length === 64) {
      throw new Error("A Sui address starts with 0x: 0x followed by 64 hex characters.");
    }
    throw new Error(
      `A Sui address has 64 hex characters after 0x; this one has ${hex.length}. It may have been cut ` +
        "off — copy it again.",
    );
  }
  throw new Error(
    "That is not a Sui address. A Sui address is 0x followed by 64 hex characters (0-9, a-f).",
  );
}

/**
 * Native SUI transfer.
 *
 * Uses the SDK's `Transaction` so gas coin selection, budget and the BCS
 * encoding are the library's problem rather than ours. `build({ client })`
 * resolves the sender's coins and the reference gas price from the fullnode,
 * which is why this needs a network round-trip before signing.
 *
 * The fullnode is `SUI_RPC` from the wallet adapter (2026-09-29): this used
 * its own copy of the official host, whose JSON-RPC is shut down (-32601
 * "JSON-RPC on public fullnodes has been deprecated"), so every Sui send
 * failed at build time while balances read fine.
 */
export async function executeSuiTransfer(args: {
  sessionId: string;
  fromAddress: string;
  to: string;
  /** Decimal SUI as typed by the user. */
  amount: string;
}): Promise<{ txHash: string }> {
  // ── Decided before anything is built: plain errors, safe to retry. ──
  const from = args.fromAddress.trim().toLowerCase();
  const to = parseSuiRecipient(args.to);
  // SUI has 9 decimals (MIST). Parse as integer arithmetic — 1e9 * a decimal
  // string through Number() loses precision above ~9 SUI-with-9dp.
  const mist = decimalToAtomic(args.amount, 9, "SUI amount");
  if (mist <= 0n) throw new Error("Amount must be greater than zero.");

  const signerAddress = String(
    await invoke<string>("swap_get_sui_address", { sessionId: args.sessionId }),
  ).toLowerCase();
  if (signerAddress !== from) throw new Error(keyMismatchText("Sui", from, signerAddress));

  const { Transaction, TransactionDataBuilder } = await import("@mysten/sui/transactions");
  const { SuiClient } = await import("@mysten/sui/client");

  const client = new SuiClient({ url: SUI_RPC });

  const tx = new Transaction();
  tx.setSender(from);
  const [coin] = tx.splitCoins(tx.gas, [mist]);
  tx.transferObjects([coin], to);

  const bytes = await tx.build({ client });
  // Fixed by the bytes, so a failed submit can be looked up by it.
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);

  const signed = await invoke<SignedSui>("swap_sign_sui_tx", {
    sessionId: args.sessionId,
    input: { txBytesBase64: Buffer.from(bytes).toString("base64") },
  });
  const signedBy = suiAddressFromPublicKey(Buffer.from(signed.publicKeyBase64, "base64"));
  if (signedBy.toLowerCase() !== from) throw new Error(keyMismatchText("Sui", from, signedBy));

  let res: Awaited<ReturnType<typeof client.executeTransactionBlock>>;
  try {
    res = await client.executeTransactionBlock({
      transactionBlock: Buffer.from(bytes).toString("base64"),
      signature: signed.signatureBase64,
      options: { showEffects: true },
    });
  } catch (e) {
    // The node may have passed it on before failing to answer. Settled by
    // digest, never by building a second transaction.
    return settleSuiByDigest(client, digest, errText(e));
  }
  const status = res.effects?.status?.status;
  if (status && status !== "success") {
    throw new Error(
      `Sui ran the transaction and it failed (${res.effects?.status?.error ?? status}). ` +
        `The gas fee was spent; the amount was not sent. Digest: ${res.digest}`,
    );
  }
  return { txHash: res.digest || digest };
}

async function settleSuiByDigest(
  client: { getTransactionBlock(input: { digest: string; options?: { showEffects?: boolean } }): Promise<any> },
  digest: string,
  why: string,
): Promise<{ txHash: string }> {
  const deadline = Date.now() + SESSION_SEND_TIMING.suiLookupMs;
  for (;;) {
    let status: string | undefined;
    let error: string | undefined;
    try {
      const r = await client.getTransactionBlock({ digest, options: { showEffects: true } });
      status = r?.effects?.status?.status;
      error = r?.effects?.status?.error;
    } catch {
      // Not known to this node (yet), or the node is unreachable: ask again.
    }
    if (status === "success") return { txHash: digest };
    if (status) {
      throw new Error(
        `Sui ran the transaction and it failed (${error ?? status}). The gas fee was spent; ` +
          `the amount was not sent. Digest: ${digest}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new SendOutcomeUnknownError(
        `Sui has not confirmed the transaction (the node answered: ${why}).`,
        digest,
      );
    }
    await sleep(SESSION_SEND_TIMING.pollMs);
  }
}

// ─── NEAR ───────────────────────────────────────────────────────────────

/**
 * Native NEAR transfer from the dashboard (2026-09-29 send-safety audit).
 *
 * Moved out of `App.tsx` so it can be tested. The transfer itself is
 * `swap-sources.ts::executeNearNativeTransfer`, shared with NEAR Intents
 * deposits. This adds what a dashboard send needs on top:
 *  - the session's NEAR account must be the one on screen. The Rust signer
 *    holds the recovery phrase's key, and the old code built the transfer FROM
 *    that account whatever the dashboard showed;
 *  - an amount of 0 is refused;
 *  - a transfer NEAR has not confirmed within the wait is reported as an
 *    unknown outcome with its hash, never as sent or failed.
 */
export async function executeNearSend(args: {
  sessionId: string;
  fromAddress: string;
  to: string;
  /** Decimal NEAR as typed by the user. */
  amount: string;
  rpcUrl: string;
}): Promise<TxResult> {
  const yocto = decimalToAtomic(args.amount, 24, "NEAR amount");
  if (yocto <= 0n) throw new Error("Amount must be greater than zero.");

  const near = await getNearAddress(args.sessionId);
  const from = args.fromAddress.trim().toLowerCase();
  if (near.accountId.toLowerCase() !== from) {
    throw new Error(keyMismatchText("NEAR", from, near.accountId));
  }

  const r = await executeNearNativeTransfer({
    sessionId: args.sessionId,
    fromAccountId: near.accountId,
    fromPublicKey: near.publicKey,
    depositAddress: args.to,
    amountAtomic: yocto.toString(),
    rpcUrl: args.rpcUrl,
  });
  if (!r.confirmed) {
    throw new SendOutcomeUnknownError(
      "NEAR has not confirmed the transfer yet; it may still go through.",
      r.txHash,
    );
  }
  return { hash: r.txHash };
}
