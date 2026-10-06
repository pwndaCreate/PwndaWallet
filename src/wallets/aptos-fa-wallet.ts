/**
 * Aptos fungible-asset adapters — the Aptos half of the stablecoin registry
 * (2026-10-06; operator request 2026-10-01: "add USDT on … Aptos, and USDC").
 *
 * Tether's USDt and Circle's USDC on Aptos are fungible assets (FA): each is
 * a metadata OBJECT (`0x357b…dc2b`, `0xbae2…6f3b`), and an account holds it
 * in a "primary store" derived from its own address. NEAR Intents lists both
 * (`nep141:aptos-…omft.near`). Each is a real `ChainType` (`usdt-aptos`,
 * `usdc-aptos`) with balance, history, send and swap.
 *
 * # Key material
 *
 * The store belongs to the Aptos account, so a leg never derives its own key:
 * `deriveFromMnemonic` delegates to `aptAdapter`.
 *
 * # Reading
 *
 *  - Balance: the `0x1::primary_fungible_store::balance` view. It answers 0
 *    for an account that has no store yet (read live 2026-10-06 for the public
 *    test seed's address), so 0 is a real zero; any other failure throws.
 *  - History: `apt-wallet.ts::aptosAssetHistory`, the same sent+received
 *    reader APT uses, asked about this asset (`aptosFaHistoryAsset`).
 *
 * # Sending
 *
 * `0x1::primary_fungible_store::transfer<Metadata>(metadata, recipient,
 * amount)` — the payload of every live USDt/USDC transfer read on 2026-10-06.
 * It creates the recipient's store when there is none, and works for these
 * two assets, which are DISPATCHABLE (their metadata objects carry a
 * `DispatchFunctionStore`: USDC's blocklist and pause). It goes through
 * `aptosSubmitEntryFunction`, APT's own send: priced by simulation, signed
 * ONCE, submitted once, settled by hash.
 *
 * Fees are APT. Measured live (2026-10-06, real transfers, numbers only):
 * 149–153 gas units to an existing store, 5,070–5,715 when the transfer
 * creates the recipient's store (storage fee 555,200 octas). The chain makes
 * the sender hold `maxGasAmount × price` up front, which is what
 * `getGasBudget` checks.
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
  APTOS_API,
  APT_DECIMALS,
  aptAdapter,
  aptMaxGasFor,
  aptosAssetHistory,
  aptosFaHistoryAsset,
  aptosSubmitEntryFunction,
  normalizeAptosAddress,
  parseAptosRecipient,
} from "./apt-wallet";
import { atomicToDecimal, decimalToAtomic } from "./decimal-amount";
import { errorText } from "../lib/errorText";

/** The framework's fungible-asset transfer, and the type it is called with. */
export const APTOS_FA_TRANSFER = "0x1::primary_fungible_store::transfer";
export const APTOS_FA_METADATA_TYPE = "0x1::fungible_asset::Metadata";

/**
 * Gas units for one FA transfer, from the live measurements in the header:
 * an existing recipient store, and one the transfer has to create. Rounded up.
 */
export const APTOS_FA_TRANSFER_GAS = { existingStore: 160n, newStore: 6_000n } as const;

/** One Aptos view call: its result array. Throws on anything but a 200. */
async function aptosView(fn: string, typeArgs: string[], args: unknown[]): Promise<unknown[]> {
  const r = await fetch(`${APTOS_API}/view`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ function: fn, type_arguments: typeArgs, arguments: args }),
  });
  if (!r.ok) throw new Error(`Aptos node HTTP ${r.status} for ${fn}`);
  const out = await r.json();
  if (!Array.isArray(out)) throw new Error(`Aptos ${fn}: unexpected answer`);
  return out;
}

/** The account's balance of the asset, atomic units (`primary_fungible_store::balance`). */
export async function aptosFaBalance(metadata: string, owner: string): Promise<bigint> {
  const [v] = await aptosView(
    "0x1::primary_fungible_store::balance",
    [APTOS_FA_METADATA_TYPE],
    [normalizeAptosAddress(owner), metadata],
  );
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("Aptos FA balance: unexpected answer");
  return BigInt(v);
}

/** Whether the account already has a primary store of the asset. */
export async function aptosFaStoreExists(metadata: string, owner: string): Promise<boolean> {
  const [v] = await aptosView(
    "0x1::primary_fungible_store::primary_store_exists",
    [APTOS_FA_METADATA_TYPE],
    [normalizeAptosAddress(owner), metadata],
  );
  if (typeof v !== "boolean") throw new Error("Aptos primary_store_exists: unexpected answer");
  return v;
}

/** `estimate_gas_price`'s `gas_estimate`, octas per gas unit. */
async function aptosGasPrice(): Promise<bigint> {
  const r = await fetch(`${APTOS_API}/estimate_gas_price`);
  if (!r.ok) throw new Error(`Aptos node HTTP ${r.status} for estimate_gas_price`);
  const d = await r.json();
  const p = d?.gas_estimate;
  if (typeof p !== "number" && !(typeof p === "string" && /^\d+$/.test(p))) {
    throw new Error("Aptos estimate_gas_price: no estimate");
  }
  return BigInt(p);
}

/**
 * The APT an FA send needs the account to HOLD, octas: the up-front
 * `maxGasAmount × price` the chain checks, with the wallet's own gas headroom
 * (`aptMaxGasFor`). Exported for tests.
 */
export function aptosFaSendCostOctas(gasUnitPrice: bigint, newStore: boolean): bigint {
  const units = newStore ? APTOS_FA_TRANSFER_GAS.newStore : APTOS_FA_TRANSFER_GAS.existingStore;
  return aptMaxGasFor(units) * gasUnitPrice;
}

/**
 * A plain sentence for a simulation that refuses a token send. APT's own
 * wording ("Not enough APT for this amount plus the network fee") would be
 * wrong twice here: the amount is the token's, and only the fee is APT.
 * Exported for tests.
 */
export function aptosFaRefusalText(vmStatus: string, ticker: string): string {
  const s = vmStatus || "no reason given";
  if (/INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE/i.test(s)) {
    return (
      `Not enough APT to pay the network fee for this ${ticker} send (Aptos: ${s}). ` +
      `Fees on Aptos are paid in APT. Nothing was sent.`
    );
  }
  if (/EINSUFFICIENT_BALANCE|INSUFFICIENT_BALANCE/i.test(s)) {
    return `Not enough ${ticker} on Aptos for this amount (Aptos: ${s}). Nothing was sent.`;
  }
  if (/FROZEN|BLOCKLIST|PAUSED/i.test(s)) {
    return `The ${ticker} issuer's controls refuse this transfer (Aptos: ${s}). Nothing was sent.`;
  }
  return `Aptos would refuse this ${ticker} transfer (${s}). Nothing was sent.`;
}

const APT_FEE_ASSET = { ticker: "APT", chainName: "Aptos" } as const;

/** The Send modal asks on every keystroke; the answer barely moves in seconds. */
const BUDGET_CACHE_MS = 15_000;
/** Its verdicts, by asset, sender and recipient. */
const budgetCache = new Map<string, { v: GasBudget; at: number }>();

/** Forget the Send modal's cached verdicts (after a send; tests). */
export function clearAptosFaCaches(): void {
  budgetCache.clear();
}

function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export interface AptosFaAdapterConfig {
  chain: ChainType;
  displayName: string;
  ticker: string;
  color: string;
  /** The asset's metadata object. Verified on chain (`fungible_asset::Metadata`). */
  metadata: string;
  decimals: number;
}

export function createAptosFaAdapter(cfg: AptosFaAdapterConfig): ChainAdapter {
  const metadata = normalizeAptosAddress(cfg.metadata);
  const historyAsset = aptosFaHistoryAsset(cfg.chain, metadata, cfg.decimals);
  const leg = (w: WalletInfo): WalletInfo => ({ ...w, chain: cfg.chain });

  return {
    chain: cfg.chain,
    displayName: cfg.displayName,
    ticker: cfg.ticker,
    color: cfg.color,
    addressPlaceholder: "0x...",
    // The store belongs to the Aptos account, so the path is the account's.
    derivation: {
      kind: "bip39",
      path: "m/44'/637'/0'/0'/0'",
      standard: "The Aptos account's own path (Petra/Martian form) — the token is held by that account",
      hasAlternatives: false,
    },

    // Key material is Aptos's — never derive separately (see header).
    importFromMnemonic: (m: string) => leg(aptAdapter.importFromMnemonic(m)),
    deriveFromMnemonic: (m: string) => leg(aptAdapter.deriveFromMnemonic(m)),
    importFromPrivateKey: (k: string) => leg(aptAdapter.importFromPrivateKey(k)),

    async getBalance(address: string): Promise<string> {
      return atomicToDecimal(await aptosFaBalance(metadata, address), cfg.decimals);
    },

    // Fees are APT, never the token.
    gasToken: APT_FEE_ASSET,

    /**
     * Can this account pay, in APT, for the token send being typed? Never
     * throws: an unreadable answer is `sufficient: null`.
     *
     * Without a recipient yet, `false` only when even a transfer to an
     * existing store cannot be paid; `null` when only a store-creating one
     * could not (the SPL legs' rule for an unopened token account).
     */
    async getGasBudget(address: string, opts?: { to?: string }): Promise<GasBudget> {
      let recipient: string | null = null;
      try {
        const t = opts?.to?.trim();
        if (t) recipient = parseAptosRecipient(t);
      } catch {
        recipient = null;
      }
      let from: string;
      try {
        from = normalizeAptosAddress(address);
      } catch {
        return { ...APT_FEE_ASSET, includesAmount: false, available: "0", required: null, sufficient: null };
      }
      const key = `${metadata}|${from}|${recipient ?? ""}`;
      const hit = budgetCache.get(key);
      if (hit && Date.now() - hit.at < BUDGET_CACHE_MS) return hit.v;
      try {
        const [aptText, price, exists] = await Promise.all([
          aptAdapter.getBalance(from),
          aptosGasPrice(),
          recipient ? aptosFaStoreExists(metadata, recipient) : Promise.resolve(null),
        ]);
        const balance = decimalToAtomic(aptText, APT_DECIMALS, "APT balance");
        const base = { ...APT_FEE_ASSET, includesAmount: false, available: atomicToDecimal(balance, APT_DECIMALS) };
        let v: GasBudget;
        if (exists === null) {
          const cheapest = aptosFaSendCostOctas(price, false);
          const dearest = aptosFaSendCostOctas(price, true);
          v = {
            ...base,
            required: atomicToDecimal(cheapest, APT_DECIMALS),
            sufficient: balance < cheapest ? false : balance >= dearest ? true : null,
          };
        } else {
          const required = aptosFaSendCostOctas(price, !exists);
          v = {
            ...base,
            required: atomicToDecimal(required, APT_DECIMALS),
            sufficient: balance >= required,
            ...(!exists && recipient
              ? {
                  notice:
                    `${shortAddress(recipient)} has never held ${cfg.ticker} on Aptos, so this send also ` +
                    `creates its ${cfg.ticker} store: the network fee is about ` +
                    `${atomicToDecimal(APTOS_FA_TRANSFER_GAS.newStore * price, APT_DECIMALS)} APT instead of ` +
                    `about ${atomicToDecimal(APTOS_FA_TRANSFER_GAS.existingStore * price, APT_DECIMALS)} APT, ` +
                    `most of it Aptos's storage fee. Paid in APT from this account.`,
                }
              : {}),
          };
        }
        for (const [k, e] of budgetCache) if (Date.now() - e.at >= BUDGET_CACHE_MS) budgetCache.delete(k);
        budgetCache.set(key, { v, at: Date.now() });
        return v;
      } catch (e) {
        console.warn(`[aptos] ${cfg.ticker} fee check failed: ${errorText(e)}`);
        return { ...APT_FEE_ASSET, includesAmount: false, available: "0", required: null, sufficient: null };
      }
    },

    /**
     * `primary_fungible_store::transfer` through APT's own send steps
     * (`aptosSubmitEntryFunction`). The recipient is checked the way APT's
     * is: exactly 64 hex characters, never padded.
     */
    async sendTransaction(privateKey: string, to: string, amount: string): Promise<TxResult> {
      // Decided before anything is built or signed: a plain error, safe to retry.
      const recipient = parseAptosRecipient(to);
      const atomic = decimalToAtomic(amount, cfg.decimals, `${cfg.ticker} amount`);
      if (atomic <= 0n) throw new Error("Amount must be greater than zero.");
      try {
        return await aptosSubmitEntryFunction({
          privateKey,
          data: {
            function: APTOS_FA_TRANSFER,
            typeArguments: [APTOS_FA_METADATA_TYPE],
            functionArguments: [metadata, recipient, atomic],
          },
          refusalText: (s) => aptosFaRefusalText(s, cfg.ticker),
        });
      } finally {
        // Whatever happened, the APT balance the modal last saw may be stale.
        budgetCache.clear();
      }
    },

    async getNetworkInfo(): Promise<NetworkInfo> {
      return aptAdapter.getNetworkInfo();
    },

    /** Sent AND received transfers of this asset (`aptosAssetHistory`). */
    async getTransactionHistory(address: string, opts?: { limit?: number }): Promise<TxHistoryPage> {
      return aptosAssetHistory(address, opts, historyAsset);
    },

    /** The same by-hash read as APT: the payload names the FA transfer's recipient. */
    async getTransactionParties(hash: string, ownAddress: string): Promise<TxParties | null> {
      return aptAdapter.getTransactionParties!(hash, ownAddress);
    },

    async getFeeEstimate(): Promise<FeeEstimate> {
      const price = await aptosGasPrice();
      return {
        // To an existing store; a first transfer to an address costs more
        // (the Send modal says so from `getGasBudget`).
        normal: { value: atomicToDecimal(APTOS_FA_TRANSFER_GAS.existingStore * price, APT_DECIMALS), eta: "≈ 1 s" },
        unit: "APT",
        fetchedAt: Date.now(),
      };
    },
  };
}

// ── Shipped fungible-asset legs (2026-10-06). Metadata objects read live
// (`0x1::fungible_asset::Metadata`) and matched to 1Click's Aptos assets.
export const usdtAptosAdapter = createAptosFaAdapter({
  chain: "usdt-aptos",
  displayName: "USDT (Aptos)",
  ticker: "USDT",
  color: "#26a17b",
  metadata: "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b",
  decimals: 6,
});

export const usdcAptosAdapter = createAptosFaAdapter({
  chain: "usdc-aptos",
  displayName: "USDC (Aptos)",
  ticker: "USDC",
  color: "#2775ca",
  metadata: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
  decimals: 6,
});
