/**
 * NEP-141 token adapters — the NEAR half of the stablecoin registry
 * (2026-10-06; operator request 2026-10-01: "add USDT on NEAR … USDC on NEAR").
 *
 * NEAR Intents lists Tether's `usdt.tether-token.near` and Circle's USDC
 * (`17208628…6133a1`) on NEAR, and the wallet had NEAR with no token legs.
 * Each is a real `ChainType` (`usdt-near`, `usdc-near`) with balance, history,
 * send and swap, like the SPL and TRC-20 legs.
 *
 * # Key material
 *
 * The token balance lives ON the NEAR account, so a leg never derives its own
 * key: `deriveFromMnemonic` delegates to `nearAdapter` (same implicit account).
 *
 * # Reading
 *
 *  - Balance: the contract's `ft_balance_of` view (`nearViewFunction`). The
 *    standard answers "0" for an account it has never seen, so 0 is a real
 *    zero; a node that cannot be reached throws, per the `getBalance` contract.
 *  - History: NearBlocks' per-token event list (`near-history.ts`).
 *
 * # Sending
 *
 * A NEP-141 transfer is a FunctionCall to the TOKEN CONTRACT, signed by the
 * NEAR account: `ft_transfer({ receiver_id, amount })` with exactly 1
 * yoctoNEAR attached (the standard's guard against function-call access keys).
 * It fails if the recipient has no storage registered with the contract, so
 * the send adds `storage_deposit({ account_id, registration_only: true })`
 * for an unregistered recipient, in the SAME transaction — one receipt, so if
 * the transfer fails the registration is rolled back with it. That is the
 * shape NEAR wallets send (the public test seed's own USDT arrived as
 * exactly that pair, tx 8xvZKGz2…, read 2026-10-06), and what the NEAR Intents
 * contract itself does when it pays a token out to an unregistered account.
 *
 * Registering costs the recipient's storage deposit, 0.00125 NEAR for both
 * contracts (`storage_balance_bounds`, read live 2026-10-06), paid by the
 * SENDER and spent: it is shown in the Send modal before Send is pressed
 * (`getGasBudget`'s `notice`). The other choice — refusing a recipient that
 * is not registered — would block the commonest first send (to a fresh
 * implicit account) and every NEAR Intents deposit, whose deposit address is
 * a fresh implicit account; and the cost is small and visible.
 *
 * The signer is session-gated in Rust (`swap_sign_near_tx`, which signs the
 * 32-byte transaction hash it is handed), so the dashboard Send goes through
 * the app-layer override (`App.tsx` → `session-send.ts::executeNearTokenSend`
 * → `swap-sources.ts::executeNearTokenTransfer`), exactly as native NEAR does.
 * No Rust change: the transaction is built and hashed in TypeScript.
 */
import type {
  ChainAdapter,
  ChainType,
  FeeEstimate,
  GasBudget,
  NetworkInfo,
  TxHistoryPage,
  TxParties,
  TxResult,
  WalletInfo,
} from "./types";
import {
  NEAR_DECIMALS,
  isNearCause,
  nearAdapter,
  nearAvailableYocto,
  nearGasPrice,
  nearRpcCall,
  nearViewFunction,
  parseNearRecipient,
  viewNearAccount,
} from "./near-wallet";
import { NEAR_RPCS } from "./chain-rpcs";
import {
  NEARBLOCKS_HOST,
  fetchNearblocksTxn,
  fetchNep141History,
  nep141TxnParties,
} from "./near-history";
import { atomicToDecimal } from "./decimal-amount";
import { uniqueAddresses, urlHost } from "./parties-b-common";
import { errorText } from "../lib/errorText";

/** Gas attached to each FunctionCall of a token send: the near-api-js default. */
export const NEP141_CALL_GAS = 30_000_000_000_000n;

/**
 * Gas for the transaction's own fees on top of what is attached: the receipt
 * and two function-call actions cost about 2.2 Tgas at the protocol-86 fee
 * table (read via `EXPERIMENTAL_protocol_config`, 2026-10-06); 5 is the
 * allowance.
 */
export const NEP141_FEE_GAS = 5_000_000_000_000n;

/**
 * NEAR charges a transaction its ATTACHED gas at submission (unused gas is
 * refunded), so that is what the account must hold. The margin covers the
 * gas price rising while the transaction waits; it only ever makes the check
 * stricter.
 */
const GAS_PRICE_MARGIN_NUM = 6n;
const GAS_PRICE_MARGIN_DEN = 5n;

/**
 * The NEAR a token send must be able to pay, yoctoNEAR: its attached gas and
 * fees at `gasPrice` (with margin), the 1 yocto `ft_transfer` deposit, and the
 * recipient's storage deposit when it has to be registered. Exported for tests.
 */
export function nep141SendCostYocto(args: {
  gasPrice: bigint;
  /** The storage deposit to attach, or 0n when the recipient is registered. */
  storageDeposit: bigint;
}): bigint {
  const register = args.storageDeposit > 0n;
  const gas = (register ? 2n : 1n) * NEP141_CALL_GAS + NEP141_FEE_GAS;
  const gasCost = (gas * args.gasPrice * GAS_PRICE_MARGIN_NUM) / GAS_PRICE_MARGIN_DEN;
  return gasCost + 1n + args.storageDeposit;
}

/** `storage_balance_of`: null when the contract has no storage for the account. */
export async function nep141StorageBalance(
  contract: string,
  accountId: string,
  urls?: string[],
): Promise<{ total: string; available: string } | null> {
  const r = await nearViewFunction<{ total?: unknown; available?: unknown } | null>(
    contract,
    "storage_balance_of",
    { account_id: accountId },
    urls,
  );
  if (r === null) return null;
  if (typeof r?.total !== "string" || !/^\d+$/.test(r.total)) {
    throw new Error(`${contract}.storage_balance_of: unexpected answer`);
  }
  return { total: r.total, available: typeof r.available === "string" ? r.available : "0" };
}

/** `storage_balance_bounds().min`, yoctoNEAR: the deposit that registers an account. */
export async function nep141StorageMinimum(contract: string, urls?: string[]): Promise<bigint> {
  const r = await nearViewFunction<{ min?: unknown }>(contract, "storage_balance_bounds", {}, urls);
  if (typeof r?.min !== "string" || !/^\d+$/.test(r.min)) {
    throw new Error(`${contract}.storage_balance_bounds: unexpected answer`);
  }
  return BigInt(r.min);
}

/**
 * Whether `accountId` must be registered before it can receive `contract`'s
 * token: true when it has no storage, or less than the contract's minimum
 * (the near-api-js `isAccountRegistered` test).
 */
export function nep141NeedsRegistration(
  storage: { total: string } | null,
  minimum: bigint,
): boolean {
  return !storage || BigInt(storage.total) < minimum;
}

/** `ft_balance_of`, atomic units. */
export async function nep141Balance(contract: string, accountId: string, urls?: string[]): Promise<bigint> {
  const r = await nearViewFunction<unknown>(contract, "ft_balance_of", { account_id: accountId }, urls);
  if (typeof r !== "string" || !/^\d+$/.test(r)) {
    throw new Error(`${contract}.ft_balance_of: unexpected answer ${JSON.stringify(r)?.slice(0, 60)}`);
  }
  return BigInt(r);
}

const NEAR_FEE_ASSET = { ticker: "NEAR", chainName: "NEAR" } as const;

/** The Send modal asks on every keystroke; the answer barely moves in seconds. */
const BUDGET_CACHE_MS = 15_000;

/**
 * The two reads that do not depend on the recipient being typed, cached for
 * the Send modal only (a send reads both fresh): the registration minimum is
 * a contract constant in practice, the gas price moves slowly.
 */
const MINIMUM_CACHE_MS = 10 * 60_000;
const GAS_PRICE_CACHE_MS = 60_000;
const minimumCache = new Map<string, { v: bigint; at: number }>();
let gasPriceCache: { v: bigint; at: number } | null = null;
/** The Send modal's verdicts, by contract, sender and recipient. */
const budgetCache = new Map<string, { v: GasBudget; at: number }>();

async function cachedStorageMinimum(contract: string): Promise<bigint> {
  const hit = minimumCache.get(contract);
  if (hit && Date.now() - hit.at < MINIMUM_CACHE_MS) return hit.v;
  const v = await nep141StorageMinimum(contract);
  minimumCache.set(contract, { v, at: Date.now() });
  return v;
}

async function cachedGasPrice(): Promise<bigint> {
  if (gasPriceCache && Date.now() - gasPriceCache.at < GAS_PRICE_CACHE_MS) return gasPriceCache.v;
  const v = await nearGasPrice();
  gasPriceCache = { v, at: Date.now() };
  return v;
}

/** Forget the Send modal's cached reads and verdicts (after a send; tests). */
export function clearNep141Caches(): void {
  minimumCache.clear();
  gasPriceCache = null;
  budgetCache.clear();
}

/** `5510e2…e412` — enough of an account id to tell two apart in a sentence. */
function shortAccount(a: string): string {
  return a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export interface Nep141AdapterConfig {
  chain: ChainType;
  displayName: string;
  ticker: string;
  color: string;
  /** The NEP-141 contract account. Verified on chain (`ft_metadata`). */
  contract: string;
  decimals: number;
}

/**
 * The transaction a fresh own send is, from the RPC nodes (`tx`), for when
 * NearBlocks does not have it yet: the signer, and the `ft_transfer`
 * receivers in its actions. `"unknown"` for a transaction the node does not
 * know; throws when no node answered.
 */
async function nep141RpcOwnTxParties(
  hash: string,
  own: string,
  contract: string,
): Promise<TxParties | "unknown"> {
  let last: unknown = new Error("No NEAR RPC endpoints configured.");
  for (const url of NEAR_RPCS()) {
    try {
      const r = await nearRpcCall<{
        transaction?: { signer_id?: unknown; receiver_id?: unknown; actions?: unknown };
      }>(url, "tx", { tx_hash: hash, sender_account_id: own, wait_until: "NONE" });
      const t = r?.transaction;
      if (!t || typeof t.signer_id !== "string") return "unknown";
      if (t.receiver_id !== contract) return "unknown";
      const to: string[] = [];
      for (const a of Array.isArray(t.actions) ? (t.actions as any[]) : []) {
        const fc = a?.FunctionCall;
        if (fc?.method_name !== "ft_transfer" && fc?.method_name !== "ft_transfer_call") continue;
        try {
          const args = JSON.parse(Buffer.from(String(fc.args ?? ""), "base64").toString("utf8"));
          if (typeof args?.receiver_id === "string") to.push(args.receiver_id);
        } catch {
          // An action whose args do not read names no one.
        }
      }
      return { from: [t.signer_id], to: uniqueAddresses(to), source: urlHost(url) };
    } catch (e) {
      if (isNearCause(e, "UNKNOWN_TRANSACTION")) return "unknown";
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function createNep141Adapter(cfg: Nep141AdapterConfig): ChainAdapter {
  const token = { chain: cfg.chain, contract: cfg.contract, decimals: cfg.decimals };
  const leg = (w: WalletInfo): WalletInfo => ({ ...w, chain: cfg.chain });

  return {
    chain: cfg.chain,
    displayName: cfg.displayName,
    ticker: cfg.ticker,
    color: cfg.color,
    addressPlaceholder: "<NEAR account>",
    // The token lives on the NEAR account, so the path that matters is NEAR's.
    derivation: {
      kind: "bip39",
      path: "m/44'/397'/0'",
      standard: "The NEAR account's own path (NEAR CLI convention) — the token is held by that account",
      hasAlternatives: false,
    },

    // Key material is NEAR's — never derive separately (see header).
    importFromMnemonic: (m: string) => leg(nearAdapter.importFromMnemonic(m)),
    deriveFromMnemonic: (m: string) => leg(nearAdapter.deriveFromMnemonic(m)),
    importFromPrivateKey: (k: string) => leg(nearAdapter.importFromPrivateKey(k)),

    async getBalance(address: string): Promise<string> {
      return atomicToDecimal(await nep141Balance(cfg.contract, address.trim()), cfg.decimals);
    },

    // Fees — and the recipient's registration — are paid in NEAR.
    gasToken: NEAR_FEE_ASSET,

    /**
     * Can this account pay, in NEAR, for the token send being typed? And does
     * the send also register the recipient (the `notice`)?
     *
     * Never throws: an unreadable answer is `sufficient: null` (do not block
     * on a guess). An account NEAR does not know has no NEAR and no key on
     * chain, so it cannot send at all: `false`.
     */
    async getGasBudget(address: string, opts?: { to?: string; amount?: string }): Promise<GasBudget> {
      const from = address.trim();
      let recipient: string | null = null;
      try {
        const t = opts?.to?.trim();
        if (t) recipient = parseNearRecipient(t).accountId;
      } catch {
        recipient = null; // still being typed, or not an account: no verdict on it
      }
      const key = `${cfg.contract}|${from}|${recipient ?? ""}`;
      const hit = budgetCache.get(key);
      if (hit && Date.now() - hit.at < BUDGET_CACHE_MS) return hit.v;
      const unknown: GasBudget = {
        ...NEAR_FEE_ASSET,
        includesAmount: false,
        available: "0",
        required: null,
        sufficient: null,
      };
      try {
        const [view, gasPrice, storage, minimum] = await Promise.all([
          viewNearAccount(from),
          cachedGasPrice(),
          recipient ? nep141StorageBalance(cfg.contract, recipient) : Promise.resolve(null),
          recipient ? cachedStorageMinimum(cfg.contract) : Promise.resolve(0n),
        ]);
        const register = recipient ? nep141NeedsRegistration(storage, minimum) : false;
        const deposit = register ? minimum : 0n;
        const available = view ? nearAvailableYocto(view) : 0n;
        const requiredYocto = nep141SendCostYocto({ gasPrice, storageDeposit: deposit });
        const v: GasBudget = {
          ...NEAR_FEE_ASSET,
          includesAmount: false,
          available: atomicToDecimal(available, NEAR_DECIMALS),
          required: atomicToDecimal(requiredYocto, NEAR_DECIMALS),
          sufficient: available >= requiredYocto,
          ...(register && recipient
            ? {
                notice:
                  `${shortAccount(recipient)} has never held ${cfg.ticker} on NEAR, so this send also ` +
                  `registers it with the ${cfg.ticker} contract: ${atomicToDecimal(minimum, NEAR_DECIMALS)} NEAR ` +
                  `(NEAR's storage deposit), paid from this account's NEAR on top of the network fee.`,
              }
            : {}),
        };
        for (const [k, e] of budgetCache) if (Date.now() - e.at >= BUDGET_CACHE_MS) budgetCache.delete(k);
        budgetCache.set(key, { v, at: Date.now() });
        return v;
      } catch (e) {
        console.warn(`[near] ${cfg.ticker} fee check failed: ${errorText(e)}`);
        return unknown;
      }
    },

    async sendTransaction(): Promise<TxResult> {
      // Like native NEAR: the signer is session-gated in Rust, so the
      // dashboard Send goes through the app-layer override (App.tsx ->
      // `session-send.ts::executeNearTokenSend`). Reachable only if
      // something bypasses that override.
      throw new Error(
        `${cfg.ticker} on NEAR must be sent through the app-layer session override (App.tsx -> executeNearTokenSend) — the signer is session-gated.`,
      );
    },

    async getNetworkInfo(): Promise<NetworkInfo> {
      return nearAdapter.getNetworkInfo();
    },

    /** NearBlocks' event list for this token (`near-history.ts`). Throws on failure. */
    async getTransactionHistory(
      address: string,
      opts?: { limit?: number; cursor?: string },
    ): Promise<TxHistoryPage> {
      return fetchNep141History(address.trim(), token, opts);
    },

    /**
     * Who the token left and reached in one transaction: NearBlocks first,
     * then the RPC nodes for this wallet's own fresh send. `null` when neither
     * knows it as a transfer of this token.
     */
    async getTransactionParties(hash: string, ownAddress: string): Promise<TxParties | null> {
      const id = hash.trim();
      const own = ownAddress.trim();
      let indexedError: unknown = null;
      try {
        const txn = await fetchNearblocksTxn(id);
        if (txn) {
          const p = nep141TxnParties(txn, cfg.contract, own, cfg.decimals);
          if (p) return p;
        }
      } catch (e) {
        indexedError = e;
      }
      let rpc: TxParties | "unknown" = "unknown";
      try {
        if (own) rpc = await nep141RpcOwnTxParties(id, own, cfg.contract);
      } catch (e) {
        if (!indexedError) return null;
        throw new Error(
          `NEAR transaction ${id} could not be read: ${NEARBLOCKS_HOST}: ${errorText(indexedError)}; ` +
            `RPC nodes: ${errorText(e)}`,
        );
      }
      if (rpc !== "unknown") return rpc;
      if (!indexedError) return null;
      throw new Error(`NEAR transaction ${id} could not be read: ${NEARBLOCKS_HOST}: ${errorText(indexedError)}`);
    },

    async getFeeEstimate(): Promise<FeeEstimate> {
      // A token transfer burns about 4–9 Tgas (0.0004–0.0009 NEAR at today's
      // price; 8.8 Tgas for the registering pair 8xvZKGz2…). The attached gas
      // held during the send is refunded and not a fee.
      return {
        normal: { value: "0.0005" },
        unit: "NEAR",
        fetchedAt: Date.now(),
      };
    },
  };
}

// ── Shipped NEP-141 legs (2026-10-06). Contracts read live with `ft_metadata`
// from rpc.mainnet.near.org and matched to 1Click's NEAR assets.
export const usdtNearAdapter = createNep141Adapter({
  chain: "usdt-near",
  displayName: "USDT (NEAR)",
  ticker: "USDT",
  color: "#26a17b",
  contract: "usdt.tether-token.near",
  decimals: 6,
});

export const usdcNearAdapter = createNep141Adapter({
  chain: "usdc-near",
  displayName: "USDC (NEAR)",
  ticker: "USDC",
  color: "#2775ca",
  contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  decimals: 6,
});
