import {
  Wallet as XrplWallet,
  Client,
  isValidClassicAddress,
  isValidXAddress,
  xAddressToClassicAddress,
  xrpToDrops,
  type Payment,
} from "xrpl";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import * as tinysecp from "tiny-secp256k1";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
  GasBudget,
  SendOptions,
} from "./types";
import { SendOutcomeUnknownError, isSendOutcomeUnknown } from "./send-outcome";

const XRP_RPC_URLS = [
  "wss://xrplcluster.com",
  "wss://s1.ripple.com",
  "wss://s2.ripple.com",
];
const DERIVATION_PATH = "m/44'/144'/0'/0/0";

/** `lsfRequireDestTag`: the account refuses payments without a destination
 *  tag. Exchanges and custodians set it. */
const LSF_REQUIRE_DEST_TAG = 0x00020000;
const MAX_DESTINATION_TAG = 0xffffffff;

/**
 * An answer from the ledger (or about the request) that another server would
 * repeat. `withClient` rethrows it at once instead of trying the next server,
 * which for a payment would only resubmit the same signed bytes — harmless,
 * but it turns one clear refusal into three slow ones.
 */
class XrpFinalError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, XrpFinalError.prototype);
  }
}

/** Drops as XRP with six fixed decimals ("1.000000"), for balances and history. */
function xrpFixed6(drops: bigint): string {
  const sign = drops < 0n ? "-" : "";
  const d = drops < 0n ? -drops : drops;
  return `${sign}${d / 1_000_000n}.${(d % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Drops as XRP with trailing zeros dropped ("1", "0.2"), for sentences. */
function xrpText(drops: bigint): string {
  return xrpFixed6(drops).replace(/\.?0+$/, "");
}

/** Plain meanings of the `tec` results a payment realistically meets. A
 *  `tec` result is applied to the ledger: the fee is spent, nothing moves. */
const TEC_MEANING: Record<string, string> = {
  tecNO_DST_INSUF_XRP:
    "the destination account does not exist yet, and a first payment must be at least the account reserve",
  tecNO_DST: "the destination account does not exist",
  tecUNFUNDED_PAYMENT: "the balance above the account reserve does not cover the amount and fee",
  tecDST_TAG_NEEDED: "the destination requires a destination tag",
  tecNO_PERMISSION: "the destination does not accept this payment",
  tecPATH_DRY: "the payment could not be delivered",
};

/**
 * Read a recipient: a classic `r…` address, or an X-address, which carries
 * its own destination tag. A typed tag that disagrees with the X-address's
 * is refused rather than silently preferring one.
 */
export function parseXrpRecipient(
  to: string,
  typedTag?: number,
): { destination: string; tag?: number } {
  const t = to.trim();
  if (isValidXAddress(t)) {
    const { classicAddress, tag, test } = xAddressToClassicAddress(t);
    if (test) throw new XrpFinalError(`"${t}" is a TESTNET X-address.`);
    const embedded = tag === false ? undefined : tag;
    if (embedded !== undefined && typedTag !== undefined && embedded !== typedTag) {
      throw new XrpFinalError(
        `This X-address carries destination tag ${embedded}, which differs from the tag entered (${typedTag}).`,
      );
    }
    return { destination: classicAddress, tag: embedded ?? typedTag };
  }
  if (!isValidClassicAddress(t)) {
    throw new XrpFinalError(`"${t}" is not an XRP Ledger address (expected r… or X…).`);
  }
  return { destination: t, tag: typedTag };
}

interface XrpAccount {
  balanceDrops: bigint;
  ownerCount: number;
  flags: number;
}

/** `account_info`, or `null` for an account that does not exist (never funded). */
async function readAccount(client: Client, account: string): Promise<XrpAccount | null> {
  try {
    const r: any = await client.request({
      command: "account_info",
      account,
      ledger_index: "validated",
    });
    const d = r.result.account_data;
    return {
      balanceDrops: BigInt(d.Balance),
      ownerCount: Number(d.OwnerCount ?? 0),
      flags: Number(d.Flags ?? 0),
    };
  } catch (e: any) {
    if (e?.data?.error === "actNotFound") return null;
    throw e;
  }
}

interface XrpLedgerCosts {
  /** Locked in every account for as long as it exists. */
  reserveBaseDrops: bigint;
  /** Locked per object the account owns (trust line, offer, …). */
  reserveIncDrops: bigint;
  /** The fee a payment from this wallet pays — see `paymentFeeDrops`. */
  feeDrops: bigint;
}

/** xrpl.js `Client` defaults: fee cushion 1.2, fee cap 2 XRP. */
const FEE_CUSHION_TENTHS = 12n;
const MAX_FEE_DROPS = 2_000_000n;

/**
 * The fee a payment from this wallet pays, in drops: the open-ledger cost at
 * the current load, times xrpl.js's 1.2 cushion (so a rise in load between
 * pricing and submitting does not strand it), rounded to a drop, capped at
 * 2 XRP — the formula `client.autofill` uses.
 *
 * ONE function, and the send passes its result as the payment's `Fee`
 * (2026-09-29 send-safety audit). The Send modal's note computed the fee
 * without the cushion while autofill added it, so a 25 XRP account was told
 * "at most 23.99999 XRP can be sent" and then refused at 23.99999 with "you
 * can send at most 23.999988".
 */
function paymentFeeDrops(info: any): bigint {
  const base = BigInt(xrpToDrops(String(info?.validated_ledger?.base_fee_xrp ?? 0.00001)));
  const loadMilli = BigInt(Math.max(1000, Math.round(Number(info?.load_factor ?? 1) * 1000)));
  // base × (loadMilli / 1000) × (12 / 10), rounded half up to a whole drop.
  const denom = 1000n * 10n;
  const fee = (base * loadMilli * FEE_CUSHION_TENTHS + denom / 2n) / denom;
  return fee < MAX_FEE_DROPS ? fee : MAX_FEE_DROPS;
}

async function readLedgerCosts(client: Client): Promise<XrpLedgerCosts> {
  const r: any = await client.request({ command: "server_info" });
  const info = r.result.info;
  const v = info.validated_ledger;
  if (v?.reserve_base_xrp == null || v?.reserve_inc_xrp == null) {
    throw new Error("The XRP Ledger reserve is unavailable right now");
  }
  return {
    reserveBaseDrops: BigInt(xrpToDrops(String(v.reserve_base_xrp))),
    reserveIncDrops: BigInt(xrpToDrops(String(v.reserve_inc_xrp))),
    feeDrops: paymentFeeDrops(info),
  };
}

const budgetCache = new Map<
  string,
  { v: { account: XrpAccount | null; costs: XrpLedgerCosts }; at: number }
>();

/**
 * Submit ONE signed payment and wait for the ledger's final word on it.
 *
 * Every attempt, on every server, submits the SAME signed bytes. A payment is
 * applied at most once — its `Sequence` is spent by the first application —
 * so resubmitting after a dropped connection cannot pay twice. Re-signing on
 * retry could, and did: `withClient` used to rerun the whole send (autofill,
 * a fresh `Sequence`, a new signature) on the next server whenever the wait
 * failed, including after the first payment had already gone through.
 *
 * Looks the transaction up BY HASH before deciding it expired: xrpl.js's own
 * `submitAndWait` checks "ledger past LastLedgerSequence" first, which after a
 * late reconnect reads a validated payment as a lost one.
 *
 * Resolves with the final `TransactionResult` (`tesSUCCESS`, `tec…`).
 *
 * Once a `submit` has been SENT to any server, the payment may be on the
 * ledger, so no later failure is reported as an ordinary one (2026-09-29
 * send-safety audit). Server 1 could accept the payment and every server then
 * drop: `withClient` threw the last connection error, the wallet said
 * "Transaction failed" with the form still filled, and one more press
 * autofilled a NEW Sequence and paid again. Such an ending is now
 * `SendOutcomeUnknownError` with the hash, as is the 120 s wait running out.
 * A failure before any submit was sent stays ordinary: nothing left the
 * wallet, and trying again is safe.
 */
async function submitAndConfirm(
  blob: string,
  hash: string,
  /** Validated ledger seen just before signing: no ledger before it can hold the payment. */
  firstLedger: number,
  lastLedger: number,
): Promise<string> {
  // Set as a submit request is SENT: one that errors may still have arrived.
  let submitted = false;
  try {
    return await withClient((client) => confirmOn(client));
  } catch (e) {
    if (e instanceof XrpFinalError || isSendOutcomeUnknown(e) || !submitted) throw e;
    throw new SendOutcomeUnknownError(
      `The payment was submitted, then no XRP Ledger server could be asked how it ended ` +
        `(${e instanceof Error ? e.message : String(e)}).`,
      hash,
    );
  }

  async function confirmOn(client: Client): Promise<string> {
    submitted = true;
    const sub: any = await client.request({ command: "submit", tx_blob: blob });
    const prelim: string = sub?.result?.engine_result ?? "";
    // `tem`: malformed, never applies anywhere. Everything else — including
    // `tefPAST_SEQ`, which is what a resubmission of an already-applied
    // payment gets — is decided by looking the hash up.
    if (prelim.startsWith("tem")) {
      throw new XrpFinalError(
        `The XRP Ledger rejected the payment as malformed: ${prelim} (${sub?.result?.engine_result_message ?? ""}). Nothing was sent.`,
      );
    }
    const lookup = async (): Promise<any | null> => {
      try {
        const r: any = await client.request({ command: "tx", transaction: hash });
        return r.result;
      } catch (e: any) {
        if (e?.data?.error === "txnNotFound") return null;
        throw e;
      }
    };
    /**
     * The lookup that may conclude "never included": over the payment's whole
     * window, so the server can say whether it holds every ledger in it.
     * "Not found" from a server missing some of them proves nothing.
     */
    const windowLookup = async (): Promise<{ found: any | null; searchedAll: boolean }> => {
      try {
        const r: any = await client.request({
          command: "tx",
          transaction: hash,
          min_ledger: firstLedger,
          max_ledger: lastLedger,
        } as any);
        return { found: r.result ?? null, searchedAll: true };
      } catch (e: any) {
        if (e?.data?.error === "txnNotFound") {
          return { found: null, searchedAll: e?.data?.searched_all === true };
        }
        throw e;
      }
    };
    const deadline = Date.now() + 120_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, XRP_CONFIRM_POLL_MS.value));
      const found = await lookup();
      if (found?.validated) return String(found.meta?.TransactionResult ?? "");
      const latest = await client.getLedgerIndex();
      if (latest > lastLedger) {
        const last = await windowLookup();
        if (last.found?.validated) return String(last.found.meta?.TransactionResult ?? "");
        // Say "nothing was sent" only when the server vouches that it
        // searched every ledger the payment could be in (2026-09-29).
        if (!last.searchedAll) {
          throw new SendOutcomeUnknownError(
            `The XRP Ledger server could not confirm it holds every ledger this payment could be in.`,
            hash,
          );
        }
        throw new XrpFinalError(
          `The payment expired before any ledger included it (last allowed ledger ${lastLedger}). ` +
            `Nothing was sent. Preliminary result: ${prelim}.`,
        );
      }
      if (Date.now() > deadline) {
        // Not a failure: the payment can still be validated until its last
        // ledger. Unknown, with the hash, and the form closed.
        throw new SendOutcomeUnknownError(`No final result from the XRP Ledger yet.`, hash);
      }
    }
  }
}

/** Poll interval for `submitAndConfirm`. Mutable for tests only. */
export const XRP_CONFIRM_POLL_MS = { value: 1_000 };

/**
 * Does `address` exist on the XRP Ledger yet, and what is the base reserve?
 * `null` when no server could be asked — which callers must treat as
 * "unknown", never as "not activated".
 *
 * For the NEAR swap confirm modal (2026-09-29): a payout to an account that
 * does not exist yet is refused by the ledger (`tecNO_DST_INSUF_XRP`) unless
 * it is at least the base reserve.
 */
export async function xrpAccountActivation(
  address: string,
): Promise<{ activated: boolean; reserveBaseXrp: number } | null> {
  try {
    return await withClient(async (client) => {
      const [account, costs] = await Promise.all([
        readAccount(client, address),
        readLedgerCosts(client),
      ]);
      return {
        activated: account !== null,
        reserveBaseXrp: Number(costs.reserveBaseDrops) / 1_000_000,
      };
    });
  } catch (e) {
    console.warn("[xrp] activation lookup failed:", e);
    return null;
  }
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

function privateKeyToWallet(privateKeyHex: string): XrplWallet {
  const privBytes = hexToBytes(privateKeyHex);
  const pubBytes = tinysecp.pointFromScalar(privBytes)!;
  const publicKeyHex = bytesToHex(pubBytes);
  return new XrplWallet(publicKeyHex, privateKeyHex);
}

function deriveFromSeed(mnemonic: string): { address: string; privateKey: string } {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(DERIVATION_PATH);
  const privateKeyHex = bytesToHex(child.privateKey!);
  const wallet = privateKeyToWallet(privateKeyHex);
  return { address: wallet.classicAddress, privateKey: privateKeyHex };
}

/**
 * Derive the XRP wallet at an ARBITRARY HD path (not just the standard
 * `m/44'/144'/0'/0/0`). The derivation-profile system uses this so an
 * Exodus seed (Exodus fully-hardens the last two steps →
 * `m/44'/144'/0'/0'/0'`) resolves without changing the default. Reuses the
 * EXACT same secp256k1 → XrplWallet encoder as `deriveFromMnemonic`, so the
 * standard path is byte-identical (locked by a round-trip test). Exported
 * for `derivePerChoice`.
 */
export function deriveXrpAtPath(mnemonic: string, path: string): WalletInfo {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  const privateKeyHex = bytesToHex(child.privateKey!);
  const wallet = privateKeyToWallet(privateKeyHex);
  return {
    chain: "xrp",
    address: wallet.classicAddress,
    mnemonic: mnemonic.trim(),
    privateKey: privateKeyHex,
  };
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  let lastError: any;
  for (const url of XRP_RPC_URLS) {
    try {
      const client = new Client(url);
      await client.connect();
      try {
        return await fn(client);
      } finally {
        await client.disconnect();
      }
    } catch (e) {
      // A final answer is the same from any server; say it once. So is an
      // unknown outcome: another server would only resubmit and wait again.
      if (e instanceof XrpFinalError || isSendOutcomeUnknown(e)) throw e;
      lastError = e;
      continue;
    }
  }
  throw lastError;
}

export const xrpAdapter: ChainAdapter = {
  chain: "xrp",
  displayName: "XRP",
  ticker: "XRP",
  color: "#bac6d4",
  addressPlaceholder: "r...",
  derivation: {
    kind: "bip39",
    path: "m/44'/144'/0'/0/0",
    standard: "BIP-44 coin type 144 — XUMM",
    hasAlternatives: true,
  },
  destinationTag: {
    label: "Destination tag",
    hint:
      "Required by most exchanges and custodians: use the tag they gave you, or the XRP is " +
      "credited to nobody. Leave empty for a personal wallet.",
  },
  /** Arbitrary-path derivation for the generic finder + balance sweep. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    return deriveXrpAtPath(mnemonic, path);
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const clean = privateKey.trim().replace(/^0x/, "");
    const wallet = privateKeyToWallet(clean);
    return {
      chain: "xrp",
      address: wallet.classicAddress,
      mnemonic: "",
      privateKey: clean,
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const { address, privateKey } = deriveFromSeed(mnemonic);
    return {
      chain: "xrp",
      address,
      mnemonic: mnemonic.trim(),
      privateKey,
    };
  },

  async getBalance(address: string): Promise<string> {
    return withClient(async (client) => {
      // An account that was never funded does not exist on the ledger; its
      // balance is a real zero.
      const account = await readAccount(client, address);
      return xrpFixed6(account?.balanceDrops ?? 0n);
    });
  },

  /**
   * Send XRP (rewritten 2026-09-29). What changed, and why each matters:
   *
   *  - The ledger's verdict is checked. `submitAndWait` throws only for
   *    malformed (`tem`) transactions; a payment that FAILED on the ledger
   *    (`tec…`: fee spent, nothing moved) came back as a normal result and the
   *    wallet reported it as sent.
   *  - It signs once. A retry resubmits the same signed bytes (see
   *    `submitAndConfirm`) instead of re-signing, which could pay twice.
   *  - The reserve is honoured. 1 XRP (plus 0.2 per owned object) stays locked
   *    in every account; a send that would dip into it is refused with the
   *    real maximum rather than failing on the ledger.
   *  - A first payment to an account that does not exist must be at least the
   *    base reserve, or the ledger refuses it (`tecNO_DST_INSUF_XRP`) — after
   *    charging the fee. Refused here, before signing.
   *  - Destination tags: from `opts.destinationTag` or an X-address, and
   *    required when the recipient's account demands one (exchanges).
   *  - Exact amounts: `xrpToDrops` on the string, not `parseFloat × 1e6`.
   */
  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string,
    _assetType?: string,
    opts?: SendOptions,
  ): Promise<TxResult> {
    const wallet = privateKeyToWallet(privateKey.trim().replace(/^0x/, ""));
    const typedTag = opts?.destinationTag;
    if (
      typedTag !== undefined &&
      !(Number.isInteger(typedTag) && typedTag >= 0 && typedTag <= MAX_DESTINATION_TAG)
    ) {
      throw new Error("A destination tag is a whole number from 0 to 4294967295.");
    }
    const { destination, tag } = parseXrpRecipient(to, typedTag);
    if (destination === wallet.classicAddress) {
      throw new Error("That is this wallet's own XRP address.");
    }
    let drops: bigint;
    try {
      drops = BigInt(xrpToDrops(amount.trim()));
    } catch {
      throw new Error(`"${amount}" is not a valid XRP amount (at most 6 decimal places).`);
    }
    if (drops <= 0n) throw new Error("Amount must be greater than zero.");

    // 1. Check, prepare and sign — once. Nothing is submitted in this phase,
    //    so a server failure here can retry safely.
    const signed = await withClient(async (client) => {
      const [costs, sender, recipient] = await Promise.all([
        readLedgerCosts(client),
        readAccount(client, wallet.classicAddress),
        readAccount(client, destination),
      ]);
      if (!sender) {
        throw new XrpFinalError(
          "This XRP account is not activated yet: it has never received the 1 XRP minimum, so there is nothing to send.",
        );
      }
      const payment: Payment = {
        TransactionType: "Payment",
        Account: wallet.classicAddress,
        Destination: destination,
        Amount: drops.toString(),
        // The same fee the Send modal's note subtracts (`paymentFeeDrops`).
        // autofill keeps a Fee that is set; left unset, it computed its own.
        Fee: costs.feeDrops.toString(),
        ...(tag !== undefined ? { DestinationTag: tag } : {}),
      };
      // No ledger before this one can hold the payment: the lower end of the
      // window `submitAndConfirm` searches before it says "nothing was sent".
      const firstLedger = await client.getLedgerIndex();
      const prepared = await client.autofill(payment);
      const fee = BigInt(prepared.Fee ?? "0");
      const locked = costs.reserveBaseDrops + costs.reserveIncDrops * BigInt(sender.ownerCount);
      const spendable = sender.balanceDrops - locked - fee;
      if (drops > spendable) {
        throw new XrpFinalError(
          `You can send at most ${xrpText(spendable > 0n ? spendable : 0n)} XRP. ` +
            `${xrpText(locked)} XRP stays locked as this account's reserve on the XRP Ledger, ` +
            `and the fee is ${xrpText(fee)} XRP.`,
        );
      }
      if (!recipient && drops < costs.reserveBaseDrops) {
        throw new XrpFinalError(
          `${destination} is not an activated XRP account yet. The XRP Ledger only creates an ` +
            `account with a first payment of at least ${xrpText(costs.reserveBaseDrops)} XRP — ` +
            `send at least that, or ask the recipient to activate it first.`,
        );
      }
      if (recipient && (recipient.flags & LSF_REQUIRE_DEST_TAG) !== 0 && tag === undefined) {
        throw new XrpFinalError(
          `${destination} requires a destination tag. Exchanges use it to credit your account — ` +
            `enter the tag they gave you.`,
        );
      }
      const lastLedger = prepared.LastLedgerSequence;
      if (typeof lastLedger !== "number") {
        throw new XrpFinalError("Could not set the payment's expiry ledger; nothing was sent.");
      }
      const s = wallet.sign(prepared);
      return { blob: s.tx_blob, hash: s.hash, firstLedger, lastLedger };
    });

    // 2. Submit those bytes and wait for the verdict.
    const result = await submitAndConfirm(
      signed.blob,
      signed.hash,
      signed.firstLedger,
      signed.lastLedger,
    );
    budgetCache.delete(wallet.classicAddress);
    if (result !== "tesSUCCESS") {
      const meaning = TEC_MEANING[result];
      throw new Error(
        `The XRP Ledger refused the payment: ${result}${meaning ? ` — ${meaning}` : ""}. ` +
          `Only the network fee was spent. Transaction ${signed.hash}.`,
      );
    }
    return { hash: signed.hash };
  },

  /**
   * What this balance can actually send (2026-09-29). XRP's binding limit is
   * the account reserve, not the fee, so the Send modal gets a `note` saying
   * so instead of its generic "lower the amount by the fee".
   */
  async getGasBudget(
    address: string,
    opts?: { to?: string; amount?: string },
  ): Promise<GasBudget> {
    const base = { ticker: "XRP", chainName: "XRP Ledger", includesAmount: true };
    let state: { account: XrpAccount | null; costs: XrpLedgerCosts };
    const hit = budgetCache.get(address);
    try {
      if (hit && Date.now() - hit.at < 15_000) {
        state = hit.v;
      } else {
        state = await withClient(async (client) => ({
          account: await readAccount(client, address),
          costs: await readLedgerCosts(client),
        }));
        budgetCache.set(address, { v: state, at: Date.now() });
      }
    } catch (e) {
      console.warn("[xrp] budget read failed:", e);
      return { ...base, available: "0", required: null, sufficient: null };
    }
    const { account, costs } = state;
    if (!account) {
      return {
        ...base,
        available: "0",
        required: null,
        sufficient: false,
        note:
          `This XRP account is not activated yet. The XRP Ledger creates it with a first ` +
          `deposit of at least ${xrpText(costs.reserveBaseDrops)} XRP.`,
      };
    }
    const locked = costs.reserveBaseDrops + costs.reserveIncDrops * BigInt(account.ownerCount);
    const floor = locked + costs.feeDrops;
    const spendable = account.balanceDrops > floor ? account.balanceDrops - floor : 0n;
    let amountDrops: bigint | null = null;
    try {
      if (opts?.amount?.trim()) amountDrops = BigInt(xrpToDrops(opts.amount.trim()));
    } catch {
      amountDrops = null;
    }
    const requiredDrops = amountDrops !== null ? amountDrops + floor : null;
    return {
      ...base,
      available: xrpText(account.balanceDrops),
      required: requiredDrops !== null ? xrpText(requiredDrops) : null,
      sufficient:
        requiredDrops !== null
          ? account.balanceDrops >= requiredDrops
          : spendable === 0n
            ? false
            : null,
      note:
        `The XRP Ledger keeps ${xrpText(locked)} XRP of this balance locked as the account ` +
        `reserve, so at most ${xrpText(spendable)} XRP can be sent.`,
    };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      return await withClient(async (client) => {
        const response = await client.request({
          command: "server_info",
        });
        const ledger =
          response.result.info.validated_ledger?.seq?.toLocaleString() ?? "N/A";
        return { label: "Ledger", value: ledger, unit: "" };
      });
    } catch {
      return { label: "Network", value: "Mainnet", unit: "" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    return withClient(async (client) => {
      // marker: opaque pagination token from rippled. We round-trip as a
      // base64 JSON string so callers don't need to know the inner shape.
      let marker: any = undefined;
      if (opts?.cursor) {
        try {
          marker = JSON.parse(atob(opts.cursor));
        } catch {
          /* ignore bad cursor */
        }
      }
      const resp = await client.request({
        command: "account_tx",
        account: address,
        limit,
        ledger_index_min: -1,
        ledger_index_max: -1,
        marker,
        forward: false,
      } as any);
      const txs: any[] = (resp.result as any).transactions ?? [];
      // Latest validated ledger the server searched (`ledger_index_max: -1`
      // asks for exactly that). A validated payment's confirmations are the
      // ledgers closed since its own, counting it: a real number rather than
      // `undefined`, so every surface shows "N conf" instead of guessing.
      const ledgerMax = Number((resp.result as any).ledger_index_max ?? 0);
      const items: ChainTx[] = txs
        .map((wrapper) => {
          const tx = wrapper.tx ?? wrapper.tx_json ?? {};
          const meta = wrapper.meta ?? {};
          if (tx.TransactionType !== "Payment") return null;
          const isIn = tx.Destination === address;
          const isOut = tx.Account === address;
          if (!isIn && !isOut) return null;
          // What the payment DELIVERED, in drops, or an object for an issued
          // currency (those go in `meta` for the detail drawer).
          //
          // Corrected 2026-09-29. This read `tx.Amount` only, and xrpl.js 4.x
          // speaks rippled API v2, where a Payment's `Amount` is renamed
          // `DeliverMax` — so every row read 0 and "hide zero" hid them all.
          // `meta.delivered_amount` is preferred over either: with the
          // partial-payment flag, DeliverMax is only an upper bound, and a
          // sender can set it to 1,000,000 XRP and deliver one drop. Checked
          // live against rippled that evening (`DeliverMax: "10"`,
          // `delivered_amount: "10"`, no `Amount`).
          const delivered = meta.delivered_amount;
          const asked = tx.DeliverMax ?? tx.Amount;
          const isDrops = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
          const drops = isDrops(delivered) ? delivered : isDrops(asked) ? asked : null;
          const amountXrp = drops !== null ? xrpFixed6(BigInt(drops)) : "0";
          const fee = isDrops(tx.Fee) ? xrpFixed6(BigInt(tx.Fee)) : undefined;
          const direction: ChainTx["direction"] = isOut && isIn ? "self" : isOut ? "out" : "in";
          const success =
            meta.TransactionResult === "tesSUCCESS" || !meta.TransactionResult;
          return {
            chain: "xrp",
            hash: tx.hash ?? wrapper.hash ?? "",
            direction: success ? direction : "failed",
            amount: amountXrp,
            fee: direction === "out" ? fee : undefined,
            timestamp: tx.date
              ? // rippled "date" is seconds since 2000-01-01; convert to POSIX.
                Number(tx.date) + 946_684_800
              : undefined,
            confirmations: !wrapper.validated
              ? 0
              : ledgerMax > 0 && Number(tx.ledger_index ?? wrapper.ledger_index) > 0
                ? Math.max(1, ledgerMax - Number(tx.ledger_index ?? wrapper.ledger_index) + 1)
                : undefined,
            height: tx.ledger_index ?? wrapper.ledger_index,
            counterparty: direction === "out" ? tx.Destination : tx.Account,
            meta: {
              transactionType: tx.TransactionType,
              destinationTag: tx.DestinationTag,
              transactionResult: meta.TransactionResult,
              issuedAmount:
                typeof delivered === "object" && delivered
                  ? delivered
                  : typeof asked === "object"
                    ? asked
                    : undefined,
            },
          } as ChainTx;
        })
        .filter((x): x is ChainTx => x !== null);
      const m = (resp.result as any).marker;
      const cursor = m ? btoa(JSON.stringify(m)) : undefined;
      return { items, cursor };
    });
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    return withClient(async (client) => {
      const r = await client.request({ command: "server_info" });
      const info = r.result.info as any;
      const baseXrp = Number(info.validated_ledger?.base_fee_xrp ?? 0.00001);
      const load = Number(info.load_factor ?? 1);
      // `normal` is the fee a send pays (2026-09-29): the same
      // `paymentFeeDrops` the budget note and the send's limit use, so the
      // modal shows one fee, not 0.00001 beside a refusal quoting 0.000012.
      const normalDrops = paymentFeeDrops(info);
      // No `fast` tier officially exposed; bumping by 50% is the common
      // pattern XRPL clients use to clear loaded ledgers.
      return {
        slow: { value: baseXrp.toFixed(6) },
        normal: { value: xrpFixed6(normalDrops) },
        fast: { value: xrpFixed6((normalDrops * 3n) / 2n) },
        unit: "XRP",
        fetchedAt: Date.now(),
        raw: { base_fee_xrp: baseXrp, load_factor: load },
      };
    });
  },
};
