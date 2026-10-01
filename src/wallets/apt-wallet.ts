/**
 * Aptos (APT) ChainAdapter.
 *
 * # Derivation — verified two ways, not assumed
 *
 * Path `m/44'/637'/0'/0'/0'` (SLIP-0010 ed25519, every segment hardened), address =
 * `sha3_256(publicKey || 0x00)`. The trailing `0x00` is Aptos's single-ed25519 scheme
 * byte; other schemes (multi-ed25519 `0x01`, single-key `0x02`) hash differently, so
 * it is load-bearing, not padding.
 *
 * Both facts were confirmed on 2026-09-02 by deriving the standard BIP39 test
 * mnemonic through `@aptos-labs/ts-sdk` AND independently through the libraries this
 * repo already uses (`ed25519-hd-key` + `@noble/hashes` sha3), and checking the two
 * agree byte-for-byte:
 *
 *   both -> 0xeb663b681209e7087d681c5d3eed12aaa8e1915e7c87794542c3f96e94b3d3bf
 *
 * That agreement is why derivation here does NOT use the SDK: it needs nothing the
 * repo lacks, and keeping it dependency-free means `deriveAllChains` — which runs on
 * every unlock — never pulls 6.35 MB into the main bundle. The SDK is `await import`ed
 * only inside `sendTransaction`.
 *
 * # An Aptos account does not exist until it is funded
 *
 * Like Hedera, an address is derivable offline but has no on-chain account until it
 * receives something. `getBalance` reports `0` for that case rather than erroring —
 * the address is valid and can receive; there is simply nothing there yet.
 */
import { derivePath } from "ed25519-hd-key";
import { mnemonicToSeedSync } from "@scure/bip39";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { decimalToAtomic, atomicToDecimal } from "./decimal-amount";
import { SendOutcomeUnknownError } from "./send-outcome";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
  TxParties,
} from "./types";
import { errorText } from "../lib/errorText";
import { uniqueAddresses, urlHost } from "./parties-b-common";

const APTOS_API = "https://api.mainnet.aptoslabs.com/v1";

/**
 * The Aptos indexer, on the same host (Hasura GraphQL; answers CORS for the
 * webview's origins, checked live 2026-10-01). The history reads from it which
 * transactions touched the account — receipts included — see
 * `getTransactionHistory`.
 */
const APTOS_INDEXER = `${APTOS_API}/graphql`;

/**
 * The archive node for transactions the fullnode no longer keeps. The API
 * names it itself, in its answer for a pruned version (live 2026-10-01):
 * `410 {"error_code":"version_pruned","message":"Ledger version(7255244540)
 * has been pruned",…,"archival_endpoint":"https://archive.mainnet.aptoslabs.com/v1"}`.
 * The fullnode kept about the last 150 million versions (~two weeks).
 */
const APTOS_ARCHIVE_API = "https://archive.mainnet.aptoslabs.com/v1";

/** APT has 8 decimal places; the atomic unit is the octa. */
export const APT_DECIMALS = 8;

/** Petra / Pontem / Martian all use this path for account 0. */
export const APT_DEFAULT_PATH = "m/44'/637'/0'/0'/0'";

/**
 * Balance comes from a VIEW FUNCTION, not from reading a resource.
 *
 * The obvious implementation — GET the `0x1::coin::CoinStore<...AptosCoin>`
 * resource — is wrong on today's mainnet and would have reported **0 for
 * essentially every real account**. APT migrated to the Fungible Asset standard:
 * the balance now lives in an object-owned `FungibleStore` at a derived address,
 * which does not appear under `/accounts/{addr}/resources` at all. Checked
 * 2026-09-02 against four active mainnet senders: every one of them had exactly
 * one resource (`0x1::account::Account`) and no CoinStore, while
 * `0x1::coin::balance` returned 15570.50, 9595.41, 12745.98 and 31.53 APT.
 *
 * `0x1::coin::balance` is FA-aware and reports the UNION of any residual legacy
 * CoinStore and the migrated store, so it is correct across the migration in
 * both directions. `0x1::primary_fungible_store::balance` returns only the FA
 * half and read slightly LOW on two of the four accounts.
 */
const APT_BALANCE_VIEW = "0x1::coin::balance";

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Aptos account address for an ed25519 public key.
 *
 * `sha3_256(pubkey || 0x00)` — the scheme byte identifies single-ed25519. Aptos
 * addresses are 32 bytes rendered as `0x` + 64 hex characters; a "short" form with
 * leading zeros trimmed also exists on explorers, which is why comparisons here
 * always use the padded form.
 */
export function aptosAddressFromPublicKey(publicKey: Uint8Array): string {
  const authKey = sha3_256(Uint8Array.from([...publicKey, 0x00]));
  return "0x" + bytesToHex(authKey);
}

export function deriveAptFromMnemonic(
  mnemonic: string,
  path: string = APT_DEFAULT_PATH,
): { privateKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const { key } = derivePath(path, Buffer.from(seed).toString("hex"));
  const privateKey = new Uint8Array(key);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey, address: aptosAddressFromPublicKey(publicKey) };
}

/**
 * Normalise an address to the padded 0x + 64-hex form, FOR READS ONLY: the
 * wallet's own address and the addresses in its history. Never for a
 * recipient — see {@link parseAptosRecipient}.
 */
export function normalizeAptosAddress(address: string): string {
  const raw = address.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,64}$/.test(raw)) {
    throw new Error(`Invalid Aptos address: ${address}`);
  }
  return "0x" + raw.padStart(64, "0");
}

/** {@link normalizeAptosAddress}, or the input when it is not an address. */
function readAptosAddress(address: string): string {
  try {
    return normalizeAptosAddress(address);
  } catch {
    return address;
  }
}

/** Two Move types name the same type (`0x1::…` and its padded form compare equal). */
function sameMoveType(a: string, b: string): boolean {
  const [addrA, ...restA] = a.trim().split("::");
  const [addrB, ...restB] = b.trim().split("::");
  return (
    restA.length > 0 &&
    restA.join("::") === restB.join("::") &&
    readAptosAddress(addrA) === readAptosAddress(addrB)
  );
}

/** APT as a legacy coin type, and as a fungible asset (its metadata object is `0xa`). */
const APT_COIN_TYPE = "0x1::aptos_coin::AptosCoin";
const APT_FA_METADATA = normalizeAptosAddress("0xa");

/** One recipient of a transfer payload, and the base units it was sent. */
export interface AptosTransferLeg {
  to: string;
  units: bigint;
}

/**
 * What a framework transfer payload moves: its recipients, and whether the
 * asset is APT. `null` for any other payload, or a transfer whose arguments
 * do not read. Exported for tests; the history and `getTransactionParties`
 * both read payloads through it.
 *
 * # Why not `const [dest, value] = payload.arguments` (corrected 2026-09-30)
 *
 * That is the shape of `aptos_account::transfer`, `transfer_coins` and
 * `coin::transfer` only. `primary_fungible_store::transfer` — the fungible-
 * asset transfer, and what APT itself moved to — is `(metadata, recipient,
 * amount)` (`@aptos-labs/ts-sdk`'s `transferFungibleAsset` builds exactly
 * that), with the metadata rendered as `{ "inner": "0x…" }`. The history read
 * the metadata object as the recipient ("[object Object]") and the recipient
 * address as the amount (`BigInt("0x…")` parses hex), and it listed every
 * coin and fungible asset sent this way as APT.
 */
export function aptosTransferOf(payload: unknown): { legs: AptosTransferLeg[]; apt: boolean } | null {
  const p = (payload ?? {}) as { function?: unknown; type_arguments?: unknown; arguments?: unknown };
  const m = /^(0x[0-9a-fA-F]{1,64})::(\w+)::(\w+)$/.exec(typeof p.function === "string" ? p.function : "");
  if (!m || readAptosAddress(m[1]) !== readAptosAddress("0x1")) return null;
  const args: unknown[] = Array.isArray(p.arguments) ? p.arguments : [];
  const typeArg = Array.isArray(p.type_arguments) ? String(p.type_arguments[0] ?? "") : "";
  const coinIsApt = () => sameMoveType(typeArg, APT_COIN_TYPE);
  const metadataIsApt = (v: unknown) => {
    const inner = v && typeof v === "object" ? (v as { inner?: unknown }).inner : v;
    return typeof inner === "string" && readAptosAddress(inner) === APT_FA_METADATA;
  };
  const leg = (to: unknown, units: unknown): AptosTransferLeg | null =>
    typeof to === "string" && /^\d+$/.test(String(units)) ? { to, units: BigInt(String(units)) } : null;
  const one = (l: AptosTransferLeg | null, apt: boolean) => (l ? { legs: [l], apt } : null);
  const many = (tos: unknown, amounts: unknown, apt: boolean) => {
    if (!Array.isArray(tos) || !Array.isArray(amounts) || tos.length !== amounts.length) return null;
    const legs = tos.map((to, i) => leg(to, amounts[i]));
    return legs.every((l): l is AptosTransferLeg => l !== null) ? { legs, apt } : null;
  };
  switch (`${m[2]}::${m[3]}`) {
    case "aptos_account::transfer":
      return one(leg(args[0], args[1]), true);
    case "aptos_account::transfer_coins":
    case "coin::transfer":
      return one(leg(args[0], args[1]), coinIsApt());
    case "aptos_account::transfer_fungible_assets":
    case "primary_fungible_store::transfer":
      return one(leg(args[1], args[2]), metadataIsApt(args[0]));
    case "aptos_account::batch_transfer":
      return many(args[0], args[1], true);
    case "aptos_account::batch_transfer_coins":
      return many(args[0], args[1], coinIsApt());
    case "aptos_account::batch_transfer_fungible_assets":
      return many(args[1], args[2], metadataIsApt(args[0]));
    default:
      return null;
  }
}

/**
 * The framework functions `aptosTransferOf` reads, as `module::function`.
 * Kept beside its switch; `aptHistory.test.ts` checks each one is read.
 */
export const APTOS_TRANSFER_FUNCTIONS: readonly string[] = [
  "aptos_account::transfer",
  "aptos_account::transfer_coins",
  "coin::transfer",
  "aptos_account::transfer_fungible_assets",
  "primary_fungible_store::transfer",
  "aptos_account::batch_transfer",
  "aptos_account::batch_transfer_coins",
  "aptos_account::batch_transfer_fungible_assets",
];

/** `0x1::module::function` (any spelling of `0x1`) is one of {@link APTOS_TRANSFER_FUNCTIONS}. */
function isAptosTransferFunction(id: unknown): boolean {
  const m = /^(0x[0-9a-fA-F]{1,64})::(\w+)::(\w+)$/.exec(typeof id === "string" ? id.trim() : "");
  return !!m && readAptosAddress(m[1]) === readAptosAddress("0x1") && APTOS_TRANSFER_FUNCTIONS.includes(`${m[2]}::${m[3]}`);
}

/** An indexer `asset_type` that is APT: the legacy coin, or the fungible asset `0xa`. */
function isAptAssetType(assetType: unknown): boolean {
  if (typeof assetType !== "string") return false;
  return sameMoveType(assetType, APT_COIN_TYPE) || readAptosAddress(assetType) === APT_FA_METADATA;
}

/**
 * One transaction (`/transactions/by_hash`) as parties. Exported for tests.
 * `from` is the sender; `to`, the recipients of a framework transfer, or
 * nobody for any other call (a DEX call's counterparties are contract state,
 * not arguments). Addresses come back padded, as the wallet's own is.
 */
export function aptosTxParties(tx: unknown, source?: string): TxParties | null {
  if (!tx || typeof tx !== "object") return null;
  const t = tx as { sender?: unknown; payload?: unknown };
  const xfer = aptosTransferOf(t.payload);
  return {
    from: uniqueAddresses([typeof t.sender === "string" ? readAptosAddress(t.sender) : undefined]),
    to: uniqueAddresses((xfer?.legs ?? []).map((l) => readAptosAddress(l.to))),
    ...(source ? { source } : {}),
  };
}

/**
 * A SEND recipient: exactly 64 hex characters (the `0x` is optional), and
 * nothing is ever padded (2026-09-29 send-safety audit).
 *
 * The send used `normalizeAptosAddress`, which accepts 1–64 hex characters and
 * zero-pads them. So an Ethereum address (0x + 40 hex) or a paste that lost
 * its last character became a valid-looking 64-character address, and
 * `aptos_account::transfer` CREATED an account there that nobody holds a key
 * for. Short forms are refused too, even the legitimate special ones (0x1 is
 * the framework): no person's wallet lives there, so a user typing one is a
 * mistake, and refusing costs nothing.
 */
export function parseAptosRecipient(input: string): string {
  const t = input.trim();
  const hex = t.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      "That is not an Aptos address. An Aptos address is 0x followed by 64 hex characters (0-9, a-f).",
    );
  }
  if (hex.length === 40) {
    throw new Error(
      "That looks like an Ethereum address (40 hex characters). An Aptos address has 64. " +
        "Sending to it would create an Aptos account nobody controls. Nothing was sent.",
    );
  }
  if (hex.length !== 64) {
    throw new Error(
      `An Aptos address has 64 hex characters after 0x; this one has ${hex.length}. ` +
        "It may have been cut off — copy it again. Shorter forms are not accepted, because " +
        "they are filled out with zeros into a different address that nobody owns.",
    );
  }
  return "0x" + hex.toLowerCase();
}

/**
 * Timing for confirming a send. Mutable for tests only.
 *
 *  - `expirySecs`: the signed transaction's own expiry. After the chain's
 *    clock passes it, the transaction can never be committed — which is what
 *    lets an uncertain send be settled as "did not happen" instead of
 *    "unknown".
 *  - `ledgerMarginSecs`: how far past the expiry the node's ledger must be
 *    before a missing transaction counts as expired. The public endpoint is a
 *    pool of fullnodes that can be a few seconds apart.
 *  - `graceMs`: how long past the expiry to keep asking before giving up.
 */
export const APT_CONFIRM = {
  pollMs: 1_000,
  expirySecs: 30,
  ledgerMarginSecs: 10,
  graceMs: 30_000,
};

/**
 * The floor for `maxGasAmount`: the SDK's own `MIN_MAX_GAS_AMOUNT`, below which
 * it raises the value anyway (checked in @aptos-labs/ts-sdk 7.3.0).
 */
export const APT_MIN_MAX_GAS = 2_000n;

/**
 * `maxGasAmount` for a send whose simulation used `gasUsed` units: 1.5× that,
 * never below {@link APT_MIN_MAX_GAS} (2026-09-29 send-safety audit).
 *
 * Why not the SDK default: `DEFAULT_MAX_GAS_AMOUNT` is 2,000,000 units, and
 * the chain requires the sender to hold `maxGasAmount × gasUnitPrice` up front
 * — 2 APT at the usual price of 100 octas. A wallet with less than about 2 APT
 * could not send at all (INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE) while the
 * modal quoted a fee of about 0.001 APT. Only gas actually used is charged, so
 * the headroom costs nothing when it is not needed.
 */
export function aptMaxGasFor(gasUsed: bigint): bigint {
  const withHeadroom = (gasUsed * 3n + 1n) / 2n; // ceil(1.5 × used)
  return withHeadroom > APT_MIN_MAX_GAS ? withHeadroom : APT_MIN_MAX_GAS;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The node's ledger clock, in whole seconds; null when it cannot be read. */
async function aptosLedgerSecs(): Promise<number | null> {
  try {
    const r = await fetch(APTOS_API);
    if (!r.ok) return null;
    const d = await r.json();
    const us = d?.ledger_timestamp;
    return us == null ? null : Number(BigInt(String(us)) / 1_000_000n);
  } catch {
    return null;
  }
}

type AptosLookup =
  | { state: "committed"; success: boolean; vmStatus: string }
  | { state: "pending" }
  | { state: "missing" }
  | { state: "error"; detail: string };

async function lookupAptosTx(hash: string): Promise<AptosLookup> {
  try {
    const r = await fetch(`${APTOS_API}/transactions/by_hash/${hash}`);
    if (r.status === 404) return { state: "missing" };
    if (!r.ok) return { state: "error", detail: `HTTP ${r.status} looking the transaction up` };
    const t = await r.json();
    if (t?.type === "pending_transaction") return { state: "pending" };
    if (typeof t?.success === "boolean") {
      return { state: "committed", success: t.success, vmStatus: String(t.vm_status ?? "") };
    }
    return { state: "error", detail: `unexpected lookup answer (type ${String(t?.type)})` };
  } catch (e) {
    return { state: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Settle a submitted (or possibly-submitted) send by its hash.
 *
 * `accepted` says whether the node answered the submit with the transaction
 * accepted. It decides only the case nothing else settles — still not
 * committed and not provably expired when the time runs out: an accepted
 * transaction is reported as submitted-not-confirmed (`pending`), one whose
 * submit failed ambiguously as {@link SendOutcomeUnknownError}. Both close the
 * Send form; neither invites a second press.
 */
async function settleAptosSend(
  hash: string,
  expireSecs: number,
  accepted: boolean,
  submitProblem: string,
): Promise<TxResult> {
  const deadline = Math.max(Date.now(), expireSecs * 1000) + APT_CONFIRM.graceMs;
  let lastProblem = submitProblem;
  for (;;) {
    // The ledger clock FIRST, then the lookup: a node that had already passed
    // the expiry before we asked would have shown a committed transaction.
    const ledgerSecs = await aptosLedgerSecs();
    const found = await lookupAptosTx(hash);
    if (found.state === "committed") {
      if (found.success) return { hash };
      throw new Error(
        `Aptos committed the transaction but it failed (${found.vmStatus || "no reason given"}). ` +
          `The network fee was charged; the amount was not sent. Hash: ${hash}`,
      );
    }
    if (
      found.state === "missing" &&
      ledgerSecs !== null &&
      ledgerSecs > expireSecs + APT_CONFIRM.ledgerMarginSecs
    ) {
      throw new Error(
        "The Aptos transaction expired before it was committed, so it can no longer go through. " +
          `Nothing was sent; it is safe to send again. Hash: ${hash}`,
      );
    }
    if (found.state === "error") lastProblem = found.detail;
    if (Date.now() >= deadline) break;
    await sleep(APT_CONFIRM.pollMs);
  }
  if (accepted) return { hash, pending: true };
  throw new SendOutcomeUnknownError(
    `Aptos did not confirm the transaction${lastProblem ? ` (${lastProblem})` : ""}.`,
    hash,
  );
}

/** A plain sentence for a simulation that says the transfer would fail. */
function aptosRefusalText(vmStatus: string): string {
  const s = vmStatus || "no reason given";
  if (/INSUFFICIENT_BALANCE/i.test(s)) {
    return `Not enough APT for this amount plus the network fee (Aptos: ${s}). Nothing was sent.`;
  }
  return `Aptos would refuse this transfer (${s}). Nothing was sent.`;
}

// =========================================================================
// History: what the account sent AND received (2026-10-01)
// =========================================================================
//
// Operator request, 2026-10-01 (the 2026-09-30 parties work found it): Aptos
// Activity never showed a receipt. The history read
// `/accounts/{addr}/transactions`, which lists the transactions the account
// SENT, by sequence number; a transfer TO it is another account's.
//
// Found on the way, live for the public test seed (0xeb663b…): that list
// is ALSO cut to what the fullnode keeps. The account has sent 16
// transactions (`sequence_number: "16"`); the list returned 2, because
// `oldest_ledger_version` was 7,285,429,912 and the other 14 are older.
// Asking for one of them by version answers `410 version_pruned`.
//
// So the indexer (GraphQL, same host) says which transactions touched the
// account and what they did to its APT, and each one is then read whole by
// version — the fullnode for recent ones, the archive node the API names for
// older ones — and mapped by the same rules as the sent list. The indexer has
// no transaction hash, and a row needs one (explorer links, the details'
// by-hash read, matching a swap's own record), hence the per-version reads.
// Transactions never change, so each is read once per session (`aptosTxCache`).

/** The fields of a committed transaction the rows use. */
interface AptosTxRecord {
  type?: unknown;
  version: string;
  hash?: unknown;
  sender?: unknown;
  success?: unknown;
  vm_status?: unknown;
  gas_used?: unknown;
  gas_unit_price?: unknown;
  timestamp?: unknown;
  payload?: unknown;
}

function slimAptosTx(t: any): AptosTxRecord {
  const p = t?.payload;
  return {
    type: t?.type,
    version: String(t?.version ?? ""),
    hash: t?.hash,
    sender: t?.sender,
    success: t?.success,
    vm_status: t?.vm_status,
    gas_used: t?.gas_used,
    gas_unit_price: t?.gas_unit_price,
    timestamp: t?.timestamp,
    payload: p && typeof p === "object"
      ? { function: p.function, type_arguments: p.type_arguments, arguments: p.arguments }
      : undefined,
  };
}

/** Committed transactions read this session, by version. Bounded: oldest out. */
const aptosTxCache = new Map<string, AptosTxRecord>();
const APTOS_TX_CACHE_MAX = 1000;
/** Below this version the fullnode answers 410; learned from that answer. */
let aptosOldestKept: bigint | null = null;

function cacheAptosTx(t: AptosTxRecord): void {
  if (!/^\d+$/.test(t.version)) return;
  aptosTxCache.delete(t.version);
  aptosTxCache.set(t.version, t);
  while (aptosTxCache.size > APTOS_TX_CACHE_MAX) {
    const oldest = aptosTxCache.keys().next().value;
    if (oldest === undefined) break;
    aptosTxCache.delete(oldest);
  }
}

/** For tests: forget what this session has read. */
export function clearAptosHistoryCache(): void {
  aptosTxCache.clear();
  aptosOldestKept = null;
}

/** One committed transaction by version: the fullnode, else (410) the archive. */
async function aptosTxByVersion(version: string): Promise<AptosTxRecord> {
  const cached = aptosTxCache.get(version);
  if (cached) return cached;
  const pruned = aptosOldestKept !== null && BigInt(version) < aptosOldestKept;
  let base = pruned ? APTOS_ARCHIVE_API : APTOS_API;
  let r = await fetch(`${base}/transactions/by_version/${version}`);
  if (!pruned && r.status === 410) {
    const body = await r.json().catch(() => null);
    const oldest = body?.oldest_ledger_version;
    if (typeof oldest === "string" && /^\d+$/.test(oldest)) aptosOldestKept = BigInt(oldest);
    base = APTOS_ARCHIVE_API;
    r = await fetch(`${base}/transactions/by_version/${version}`);
  }
  if (!r.ok) throw new Error(`${urlHost(base)} answered HTTP ${r.status} for version ${version}`);
  const t = slimAptosTx(await r.json());
  if (t.version !== version) throw new Error(`${urlHost(base)} answered another version for ${version}`);
  cacheAptosTx(t);
  return t;
}

/** The account's sent list (`/accounts/{addr}/transactions`): recent sends, whole. */
async function aptosSentTransactions(addr: string, limit: number): Promise<AptosTxRecord[]> {
  const r = await fetch(`${APTOS_API}/accounts/${addr}/transactions?limit=${limit}`);
  // An account that was never funded does not exist yet: nothing sent.
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`Aptos node HTTP ${r.status}`);
  const rows: unknown = await r.json();
  const out = (Array.isArray(rows) ? rows : []).map(slimAptosTx);
  for (const t of out) cacheAptosTx(t);
  return out;
}

/** What the indexer says one transaction did to the account. */
export interface AptosIndexerEntry {
  version: string;
  /** APT (octas) deposited to the account, gas aside. */
  deposited: bigint;
  /** Worth reading whole: it moved the account's APT, or it is a framework
   *  transfer the account sent that failed (only its gas moved). */
  wanted: boolean;
}

const APTOS_ACCOUNT_TXS_QUERY = `query ($address: String!, $limit: Int!) {
  account_transactions(
    where: { account_address: { _eq: $address } }
    order_by: { transaction_version: desc }
    limit: $limit
  ) {
    transaction_version
    fungible_asset_activities(where: { owner_address: { _eq: $address } }) {
      type
      amount
      asset_type
      is_gas_fee
      is_transaction_success
      entry_function_id_str
    }
  }
}`;

/**
 * The indexer's `account_transactions` answer as entries, newest first.
 * Exported for tests. Throws on anything that is not that answer.
 *
 * The activity layout read live for the public test seed (2026-10-01): a
 * send is `0x1::fungible_asset::Withdraw` of `0x…0a` plus a
 * `0x1::aptos_coin::GasFeeEvent` (`is_gas_fee: true`); a receipt, a
 * `0x1::fungible_asset::Deposit`; from before APT moved to the fungible-asset
 * standard, `0x1::coin::DepositEvent` of `0x1::aptos_coin::AptosCoin`; a
 * failed send, only its gas event, with `is_transaction_success: false`.
 */
export function aptosIndexerEntries(answer: unknown): AptosIndexerEntry[] {
  const rows = (answer as { account_transactions?: unknown } | null)?.account_transactions;
  if (!Array.isArray(rows)) throw new Error("the indexer's answer has no account_transactions");
  const out: AptosIndexerEntry[] = [];
  for (const row of rows) {
    const v = row?.transaction_version;
    const version = typeof v === "number" || typeof v === "string" ? String(v) : "";
    if (!/^\d+$/.test(version)) continue;
    let deposited = 0n;
    let moved = false;
    let failedTransfer = false;
    for (const a of Array.isArray(row?.fungible_asset_activities) ? row.fungible_asset_activities : []) {
      if (a?.is_transaction_success === false && isAptosTransferFunction(a?.entry_function_id_str)) {
        failedTransfer = true;
      }
      if (a?.is_gas_fee === true || !isAptAssetType(a?.asset_type)) continue;
      const kind = String(a?.type ?? "").split("::").pop() ?? "";
      const units = /^\d+$/.test(String(a?.amount ?? "")) ? BigInt(String(a.amount)) : 0n;
      if (/deposit/i.test(kind)) {
        moved = true;
        deposited += units;
      } else if (/withdraw/i.test(kind)) {
        moved = true;
      }
    }
    out.push({ version, deposited, wanted: moved || failedTransfer });
  }
  return out;
}

async function aptosIndexedTransactions(addr: string, limit: number): Promise<AptosIndexerEntry[]> {
  const r = await fetch(APTOS_INDEXER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: APTOS_ACCOUNT_TXS_QUERY, variables: { address: addr, limit } }),
  });
  if (!r.ok) throw new Error(`${urlHost(APTOS_API)} indexer HTTP ${r.status}`);
  const j = await r.json();
  if (Array.isArray(j?.errors) && j.errors.length) {
    throw new Error(`${urlHost(APTOS_API)} indexer: ${j.errors.map((e: any) => e?.message).join("; ")}`);
  }
  return aptosIndexerEntries(j?.data);
}

/** `fn` over `items`, at most `size` at a time, results in order. */
async function inPool<T, R>(items: readonly T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/**
 * One committed transaction as this account's APT row, or `null` when it
 * moved no APT for it. Exported for tests. The rules of the sent list, with
 * receipts added:
 *
 *  - A framework transfer of APT (`aptosTransferOf`): sent by the account, it
 *    is a send of every leg paid to someone else ("self" when every leg comes
 *    back), with the gas as its fee; sent by another account, a receipt of
 *    the legs paid to this one.
 *  - Any other call that paid this account APT (a swap, a bridge): a receipt
 *    of what the indexer saw deposited (`deposited`), from the transaction's
 *    sender. Other calls the account sent are left out, as before.
 *  - An aborted transaction is `failed`, committed, its gas still the
 *    sender's (2026-09-30).
 */
export function aptosHistoryRow(tx: unknown, addr: string, deposited = 0n): ChainTx | null {
  const t = (tx ?? {}) as AptosTxRecord & Record<string, unknown>;
  if (t.type !== "user_transaction") return null;
  const sender = typeof t.sender === "string" ? readAptosAddress(t.sender) : "";
  const outgoing = sender === addr;
  // Covers the legacy coin path AND the post-migration fungible-asset one,
  // each read with its own argument order (`aptosTransferOf`). A transfer
  // of another coin or fungible asset is not listed as APT (2026-09-30).
  const xfer = aptosTransferOf(t.payload);
  let intended: "in" | "out" | "self";
  let units: bigint;
  let counterparty: string;
  if (xfer?.apt && outgoing) {
    const toOthers = xfer.legs.filter((l) => readAptosAddress(l.to) !== addr);
    intended = toOthers.length === 0 ? "self" : "out";
    units = (toOthers.length ? toOthers : xfer.legs).reduce((sum, l) => sum + l.units, 0n);
    counterparty = toOthers[0]?.to ?? xfer.legs[0]?.to ?? "";
  } else if (xfer?.apt && xfer.legs.some((l) => readAptosAddress(l.to) === addr)) {
    intended = "in";
    units = xfer.legs.filter((l) => readAptosAddress(l.to) === addr).reduce((sum, l) => sum + l.units, 0n);
    counterparty = String(t.sender ?? "");
  } else if (!outgoing && deposited > 0n && t.success !== false) {
    intended = "in";
    units = deposited;
    counterparty = String(t.sender ?? "");
  } else {
    return null;
  }
  // A transaction that aborted is committed too — it paid gas — but it
  // moved nothing. Corrected 2026-09-30: it was listed as a send of its
  // full amount with `confirmations: 0`, which reads "unconfirmed" (0
  // means waiting for a block, `ChainTx`), so the Activity details said
  // "▲ sent … unconfirmed" for a week-old failure and the list pinned
  // it above newer rows. Now `failed`, as XRP and the EVM chains do.
  const failed = t.success === false;
  const version = /^\d+$/.test(String(t.version ?? "")) ? Number(t.version) : undefined;
  let fee: string | undefined;
  if (outgoing) {
    try {
      // The gas is this wallet's only when it sent the transaction.
      fee = atomicToDecimal(BigInt(String(t.gas_used ?? 0)) * BigInt(String(t.gas_unit_price ?? 0)), APT_DECIMALS);
    } catch {
      fee = undefined;
    }
  }
  return {
    chain: "aptos",
    hash: String(t.hash ?? ""),
    direction: failed ? "failed" : intended,
    amount: atomicToDecimal(units, APT_DECIMALS),
    fee,
    // Aptos timestamps are MICROseconds since epoch, not milliseconds.
    timestamp: t.timestamp ? Math.floor(Number(t.timestamp) / 1_000_000) : undefined,
    height: version,
    // The chain is final on inclusion: a transaction listed here is
    // committed, whether it succeeded or not. No count (`undefined`) with
    // its version as the block reads "confirmed"; a count of 1 read
    // "confirming (1)" and "1 / 6 pending" in the details.
    confirmations: undefined,
    counterparty,
    meta: {
      intended,
      ...(failed ? { failure: String(t.vm_status ?? "aborted") } : {}),
    },
  };
}

export const aptAdapter: ChainAdapter = {
  chain: "aptos",
  displayName: "Aptos",
  ticker: "APT",
  color: "#4ad4c4",
  addressPlaceholder: "0x...",
  derivation: {
    kind: "bip39",
    path: APT_DEFAULT_PATH,
    standard: "SLIP-0010 ed25519, every segment hardened — Petra/Martian form",
    hasAlternatives: false,
  },

  deriveFromMnemonic(mnemonic: string, choice?: string): WalletInfo {
    const { privateKey, address } = deriveAptFromMnemonic(
      mnemonic,
      choice && choice.startsWith("m/") ? choice : APT_DEFAULT_PATH,
    );
    return {
      chain: "aptos",
      address,
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(privateKey),
    };
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const key = Uint8Array.from(
      Buffer.from(privateKey.trim().replace(/^0x/, ""), "hex"),
    );
    if (key.length !== 32) {
      throw new Error("An Aptos private key is 32 bytes (64 hex characters).");
    }
    const publicKey = ed25519.getPublicKey(key);
    return {
      chain: "aptos",
      address: aptosAddressFromPublicKey(publicKey),
      mnemonic: "",
      privateKey: bytesToHex(key),
    };
  },

  async getBalance(address: string): Promise<string> {
    const r = await fetch(`${APTOS_API}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        function: APT_BALANCE_VIEW,
        type_arguments: ["0x1::aptos_coin::AptosCoin"],
        arguments: [normalizeAptosAddress(address)],
      }),
    });
    // An account that has never been funded does not exist on-chain, and the
    // view aborts rather than returning zero. That is a genuine 0 — the address
    // is still valid to receive on. Any OTHER failure throws, so a node outage
    // is never rendered as an empty wallet.
    if (r.status === 400 || r.status === 404) return "0";
    if (!r.ok) throw new Error(`Aptos node HTTP ${r.status}`);
    const out = await r.json();
    return atomicToDecimal(BigInt(out?.[0] ?? 0), APT_DECIMALS);
  },

  /**
   * Build, price, sign ONCE, submit once, then settle by hash (2026-09-29
   * send-safety audit).
   *
   * What changed, and why:
   *  - The recipient must be exactly 64 hex characters ({@link
   *    parseAptosRecipient}); it used to be zero-padded into an unowned address.
   *  - The gas limit comes from a simulation ({@link aptMaxGasFor}); the SDK
   *    default of 2,000,000 units made anyone holding under ~2 APT unable to
   *    send.
   *  - The SDK's `waitForTransaction` is gone. It throws on its own 20 s timeout
   *    and on any non-404 4xx (a 429 included) even after the node accepted
   *    the transaction, and that throw was reported as "Transaction failed" for
   *    a transfer that had gone through — one more press paid twice. The hash
   *    is now computed before the submit and the outcome looked up by it.
   */
  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string,
  ): Promise<TxResult> {
    // Decided before anything is built or signed: a plain error, safe to retry.
    const recipient = parseAptosRecipient(to);
    const octas = decimalToAtomic(amount, APT_DECIMALS, "APT amount");
    if (octas <= 0n) throw new Error("Amount must be greater than zero.");

    // Lazy — keeps 6.35 MB out of the bundle for every user who never sends APT.
    const {
      Account,
      Aptos,
      AptosConfig,
      Ed25519PrivateKey,
      Network,
      generateUserTransactionHash,
    } = await import("@aptos-labs/ts-sdk");

    const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }));
    const signer = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey("0x" + privateKey.replace(/^0x/, "")),
    });

    // `0x1::aptos_account::transfer` (not `0x1::coin::transfer`) because it
    // CREATES the destination account if it does not exist yet. `coin::transfer`
    // aborts on an unfunded destination, which is the common case for a first
    // send to a fresh wallet.
    const data = {
      function: "0x1::aptos_account::transfer" as const,
      functionArguments: [recipient, octas],
    };

    // 1. Price it. The draft is only simulated, never signed. With
    //    `estimateMaxGasAmount` the node simulates at what the account can
    //    afford, so the SDK's 2-APT default cannot fail the simulation itself.
    const draft = await aptos.transaction.build.simple({ sender: signer.accountAddress, data });
    const [sim] = await aptos.transaction.simulate.simple({
      signerPublicKey: signer.publicKey,
      transaction: draft,
      options: { estimateMaxGasAmount: true, estimateGasUnitPrice: true },
    });
    if (!sim) throw new Error("Aptos returned no simulation for this transfer. Nothing was sent.");
    if (sim.success !== true) throw new Error(aptosRefusalText(String(sim.vm_status ?? "")));
    const maxGasAmount = aptMaxGasFor(BigInt(sim.gas_used));
    const gasUnitPrice = BigInt(sim.gas_unit_price);

    // 2. The one transaction that is signed: the draft's sequence number, the
    //    simulated price, and an expiry this code knows (see APT_CONFIRM).
    const expireSecs = Math.floor(Date.now() / 1000) + APT_CONFIRM.expirySecs;
    const transaction = await aptos.transaction.build.simple({
      sender: signer.accountAddress,
      data,
      options: {
        maxGasAmount: Number(maxGasAmount),
        gasUnitPrice: Number(gasUnitPrice),
        accountSequenceNumber: draft.rawTransaction.sequence_number,
        expireTimestamp: expireSecs,
      },
    });

    // 3. Sign once. The hash is known before anything leaves the machine, so
    //    every outcome after this point can be looked up rather than guessed.
    const senderAuthenticator = aptos.transaction.sign({ signer, transaction });
    const hash = generateUserTransactionHash({ transaction, senderAuthenticator });

    // 4. Submit once. Only a 4xx that is the node REFUSING the transaction is
    //    a failure; a timeout, 408/409/429, a 5xx or a dropped connection may
    //    have reached the mempool and is settled by hash like a success.
    let accepted = false;
    let submitProblem = "";
    try {
      const pending = await aptos.transaction.submit.simple({ transaction, senderAuthenticator });
      accepted = true;
      if (pending?.hash && pending.hash.toLowerCase() !== hash.toLowerCase()) {
        // Inference: cannot happen for a correctly hashed transaction. Logged
        // rather than trusted, and the locally computed hash is kept.
        console.warn(`[aptos] node returned hash ${pending.hash}, computed ${hash}`);
      }
    } catch (e) {
      const status = (e as { status?: unknown })?.status;
      const detail = e instanceof Error ? e.message : String(e);
      if (
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 409 &&
        status !== 429
      ) {
        throw new Error(`Aptos refused the transaction: ${detail}. Nothing was sent.`);
      }
      submitProblem = detail;
    }

    // 5. Settle by hash.
    return settleAptosSend(hash, expireSecs, accepted, submitProblem);
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const r = await fetch(APTOS_API);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      return {
        label: "Ledger version",
        value: String(d.ledger_version ?? "—"),
        unit: "",
      };
    } catch {
      return { label: "Ledger version", value: "—", unit: "" };
    }
  },

  /**
   * What the account sent AND received, newest first (2026-10-01; see the
   * "History" section above for why).
   *
   *  1. In parallel: the indexer's transactions for the account
   *     (`aptosIndexedTransactions`) and the fullnode's sent list
   *     (`aptosSentTransactions`, which also covers an indexer that lags
   *     behind a send made a moment ago).
   *  2. Each indexed transaction that moved the account's APT, and is not in
   *     the sent list, is read whole by version (`aptosTxByVersion`, four at
   *     a time, once per session).
   *  3. One row per transaction (`aptosHistoryRow`), newest first, `limit`
   *     of them.
   *
   * Throws only when nothing could be read. Without the indexer, the sent
   * list is the answer (what this showed before 2026-10-01), with a warning;
   * a transaction that could not be read by version is left out this time and
   * read on the next poll.
   */
  async getTransactionHistory(
    address: string,
    opts?: { limit?: number },
  ): Promise<TxHistoryPage> {
    const limit = Math.max(1, Math.floor(opts?.limit ?? 25));
    const addr = normalizeAptosAddress(address);
    const [sent, indexed] = await Promise.allSettled([
      aptosSentTransactions(addr, limit),
      aptosIndexedTransactions(addr, limit),
    ]);
    if (sent.status === "rejected" && indexed.status === "rejected") {
      throw new Error(
        `Aptos history could not be read: ${errorText(sent.reason)}; the indexer: ${errorText(indexed.reason)}`,
      );
    }

    const txs = new Map<string, AptosTxRecord>();
    if (sent.status === "fulfilled") for (const t of sent.value) txs.set(t.version, t);
    const deposited = new Map<string, bigint>();
    const failures: string[] = [];
    if (indexed.status === "fulfilled") {
      const wanted = indexed.value.filter((e) => e.wanted);
      for (const e of wanted) deposited.set(e.version, e.deposited);
      await inPool(
        wanted.map((e) => e.version).filter((v) => !txs.has(v)),
        4,
        async (v) => {
          try {
            txs.set(v, await aptosTxByVersion(v));
          } catch (e) {
            failures.push(`version ${v}: ${errorText(e)}`);
          }
        },
      );
    } else {
      console.warn(`[aptos] the indexer could not be read, so receipts are missing this time: ${errorText(indexed.reason)}`);
    }

    const items = [...txs.values()]
      .map((t) => aptosHistoryRow(t, addr, deposited.get(t.version) ?? 0n))
      .filter((row): row is ChainTx => row !== null)
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
      .slice(0, limit);
    if (failures.length > 0) {
      if (items.length === 0) throw new Error(`Aptos history could not be read: ${failures.slice(0, 3).join("; ")}`);
      console.warn(`[aptos] ${failures.length} transaction(s) could not be read this time; first: ${failures[0]}`);
    }
    return { items };
  },

  /**
   * `/transactions/by_hash`, the lookup the send already settles by, fetched
   * directly like every Aptos read (2026-09-30). The node answers 404
   * `transaction_not_found` for a hash it does not know; a pending
   * transaction has its sender and payload already, so it reads the same.
   *
   * Then the archive node (2026-10-01). The fullnode answers that SAME 404
   * for a transaction it has pruned — read live for the public test seed's
   * receipt of 2026-09-18 (0x608724a4…), which the archive returned whole —
   * so its "not found" said "not shown yet" in the details of anything older
   * than about two weeks. `null` when both say 404; throws when neither
   * answered.
   */
  async getTransactionParties(hash: string): Promise<TxParties | null> {
    const id = hash.trim();
    const failures: string[] = [];
    let unknown = false;
    for (const base of [APTOS_API, APTOS_ARCHIVE_API]) {
      let r: Response;
      try {
        r = await fetch(`${base}/transactions/by_hash/${encodeURIComponent(id)}`);
      } catch (e) {
        failures.push(`${urlHost(base)} could not be reached: ${errorText(e)}`);
        continue;
      }
      if (r.status === 404) {
        unknown = true;
        continue;
      }
      if (!r.ok) {
        failures.push(`${urlHost(base)} answered HTTP ${r.status} for transaction ${id}`);
        continue;
      }
      return aptosTxParties(await r.json(), urlHost(base));
    }
    if (unknown) return null;
    throw new Error(failures.join("; "));
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    try {
      const r = await fetch(`${APTOS_API}/estimate_gas_price`);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      const price = BigInt(d.gas_estimate ?? 100);
      // A simple transfer costs on the order of 1000 gas units.
      return {
        normal: {
          value: atomicToDecimal(price * 1000n, APT_DECIMALS),
          eta: "≈ 1 s",
        },
        unit: "APT",
        fetchedAt: Date.now(),
      };
    } catch {
      return {
        normal: { value: "—", label: "Normal" } as any,
        unit: "APT",
        fetchedAt: Date.now(),
      };
    }
  },
};
