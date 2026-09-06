/**
 * TRC-20 token adapters — the Tron half of the stablecoin registry.
 *
 * USDT on Tron is one of the most-used stablecoin legs in existence and the
 * wallet had no TRC-20 reader at all: Tron was native-TRX only, so a user
 * holding USDT-TRC20 saw nothing.
 *
 * # Key material
 *
 * Delegates to `trxAdapter` — the TRC-20 holder IS the Tron account, so a
 * token leg must never derive its own key. Tron addresses are secp256k1 like
 * Ethereum's, re-encoded base58check; `trx-wallet.ts` owns that conversion and
 * this file reuses it rather than repeating it.
 *
 * # Reading a balance
 *
 * `triggerconstantcontract` with `balanceOf(address)` — the read-only variant,
 * so it costs no bandwidth/energy and needs no signature. The single ABI
 * argument is a 32-byte left-padded hex address WITHOUT the `41` Tron prefix,
 * which is the one detail that silently returns zero when you get it wrong:
 * Tron hex addresses are 21 bytes (`41` + 20), and the ABI wants the trailing
 * 20.
 *
 * # Sending
 *
 * `triggersmartcontract` with `transfer(address,uint256)` builds an unsigned
 * tx server-side; we sign its `txID` with the same secp256k1 path
 * `trxAdapter.sendTransaction` already uses for native TRX, then broadcast.
 * Keeping the signing identical to the native path is deliberate — one
 * signature convention (r ‖ s ‖ v-27) to be right about, not two.
 *
 * `fee_limit` is required and is a CAP, not a charge: unused energy is not
 * consumed. 100 TRX is the conventional ceiling for a TRC-20 transfer to an
 * address that has never held the token (which costs materially more energy
 * than one that has). Too low is the common cause of `OUT_OF_ENERGY`.
 */
import { ethers } from "ethers";
import type {
  ChainAdapter,
  ChainType,
  FeeEstimate,
  NetworkInfo,
  TxHistoryPage,
  TxResult,
} from "./types";
import {
  trxAdapter,
  tronFetch,
  ethAddressToTron,
  tronAddressToHex,
} from "./trx-wallet";
import { atomicToDecimalString, decimalStringToAtomic } from "./spl-token-wallet";

/** Tron hex address (`41` + 20 bytes) → 32-byte ABI word. */
export function addressToAbiWord(tronAddress: string): string {
  const hex = tronAddressToHex(tronAddress);
  const noPrefix = hex.startsWith("41") ? hex.slice(2) : hex;
  return noPrefix.toLowerCase().padStart(64, "0");
}

function uint256Word(v: bigint): string {
  return v.toString(16).padStart(64, "0");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Energy ceiling for a TRC-20 transfer, in SUN. A cap, not a charge. */
const FEE_LIMIT_SUN = 100_000_000;

export interface Trc20AdapterConfig {
  chain: ChainType;
  displayName: string;
  ticker: string;
  color: string;
  /** TRC-20 contract, base58 (T…). Verified on chain via `symbol()`/`decimals()`. */
  contract: string;
  decimals: number;
}

export function createTrc20Adapter(cfg: Trc20AdapterConfig): ChainAdapter {
  return {
    chain: cfg.chain,
    displayName: cfg.displayName,
    ticker: cfg.ticker,
    color: cfg.color,
    addressPlaceholder: "T...",
    // A TRC-20 leg is held by the TRX account itself, so the derivation that
    // matters is Tron's — including its TronLink quirk of using ETH coin type
    // 60 rather than TRX's own 195.
    derivation: {
      kind: "bip39",
      path: "m/44'/60'/0'/0/0",
      standard: "TronLink convention: ETH coin type 60, not TRX's own 195",
      hasAlternatives: true,
    },

    importFromMnemonic: (m: string) => ({
      ...trxAdapter.importFromMnemonic(m),
      chain: cfg.chain,
    }),
    deriveFromMnemonic: (m: string) => ({
      ...trxAdapter.deriveFromMnemonic(m),
      chain: cfg.chain,
    }),
    importFromPrivateKey: (k: string) => ({
      ...trxAdapter.importFromPrivateKey(k),
      chain: cfg.chain,
    }),

    async getBalance(address: string): Promise<string> {
      const resp = await tronFetch(`/wallet/triggerconstantcontract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_address: address,
          contract_address: cfg.contract,
          function_selector: "balanceOf(address)",
          parameter: addressToAbiWord(address),
          visible: true,
        }),
      });
      if (!resp.ok) throw new Error(`${cfg.ticker} balance lookup failed`);
      const data = await resp.json();
      const word: string | undefined = data?.constant_result?.[0];
      if (!word) {
        // An empty `constant_result` with a `result.message` is the contract
        // reverting, not an empty balance — surface it instead of showing 0.
        const msg = data?.result?.message;
        throw new Error(
          msg
            ? `${cfg.ticker}: ${Buffer.from(msg, "hex").toString("utf8")}`
            : `${cfg.ticker}: empty balanceOf response`,
        );
      }
      return atomicToDecimalString(BigInt("0x" + word), cfg.decimals);
    },

    async sendTransaction(
      privateKey: string,
      to: string,
      amount: string,
    ): Promise<TxResult> {
      const wallet = new ethers.Wallet(privateKey.trim());
      const from = ethAddressToTron(wallet.address);
      const atomic = decimalStringToAtomic(amount, cfg.decimals);

      const createResp = await tronFetch(`/wallet/triggersmartcontract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_address: from,
          contract_address: cfg.contract,
          function_selector: "transfer(address,uint256)",
          parameter: addressToAbiWord(to) + uint256Word(atomic),
          fee_limit: FEE_LIMIT_SUN,
          call_value: 0,
          visible: true,
        }),
      });
      if (!createResp.ok) throw new Error(`Failed to build ${cfg.ticker} transfer`);
      const built = await createResp.json();
      if (built?.result?.result !== true || !built?.transaction) {
        const msg = built?.result?.message;
        throw new Error(
          msg
            ? `${cfg.ticker} transfer rejected: ${Buffer.from(msg, "hex").toString("utf8")}`
            : `${cfg.ticker} transfer could not be built`,
        );
      }

      const txData = built.transaction;
      const signingKey = new ethers.SigningKey(privateKey.trim());
      const signature = signingKey.sign(hexToBytes(txData.txID));
      txData.signature = [
        signature.r.slice(2) +
          signature.s.slice(2) +
          (signature.v === 27 ? "00" : "01"),
      ];

      const broadcast = await tronFetch(`/wallet/broadcasttransaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(txData),
      });
      if (!broadcast.ok) throw new Error(`Failed to broadcast ${cfg.ticker} transfer`);
      const result = await broadcast.json();
      if (!result.result) {
        throw new Error(result.message || `${cfg.ticker} broadcast failed`);
      }
      return { hash: txData.txID };
    },

    async getNetworkInfo(): Promise<NetworkInfo> {
      return trxAdapter.getNetworkInfo();
    },

    async getTransactionHistory(
      address: string,
      opts?: { limit?: number },
    ): Promise<TxHistoryPage> {
      const limit = opts?.limit ?? 25;
      const resp = await tronFetch(
        `/v1/accounts/${address}/transactions/trc20?limit=${limit}&contract_address=${cfg.contract}`,
      ).catch(() => null);
      if (!resp || !resp.ok) return { items: [] };
      const data = await resp.json().catch(() => null);
      const rows: any[] = Array.isArray(data?.data) ? data.data : [];
      return {
        items: rows.map((r) => ({
          chain: cfg.chain,
          hash: String(r.transaction_id ?? ""),
          direction: String(r.to ?? "") === address ? ("in" as const) : ("out" as const),
          amount: atomicToDecimalString(BigInt(String(r.value ?? "0")), cfg.decimals),
          timestamp: r.block_timestamp ? Math.floor(r.block_timestamp / 1000) : undefined,
          counterparty: String(r.to ?? "") === address ? r.from : r.to,
        })),
      };
    },

    async getFeeEstimate(): Promise<FeeEstimate> {
      // Energy, not a fixed fee. Reported as the CAP so the number on screen
      // is the worst case rather than a guess that will be wrong either way.
      return {
        normal: { value: "≤ 100", eta: "≈ 3 s" },
        unit: "TRX (energy cap)",
        fetchedAt: Date.now(),
      };
    },
  } as ChainAdapter;
}

// ── Shipped TRC-20 leg. Verified on chain: symbol() = "USDT", decimals() = 6.
export const usdtTronAdapter = createTrc20Adapter({
  chain: "usdt-tron",
  displayName: "USDT (Tron)",
  ticker: "USDT",
  color: "#26a17b",
  contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  decimals: 6,
});
