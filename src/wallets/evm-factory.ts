import { ethers } from "ethers";
import type {
  ChainType,
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  TxParties,
  FeeEstimate,
  GasBudget,
} from "./types";
import {
  decideGasSufficiency,
  fallbackGasLimit,
  gasTokenFor,
  totalNativeRequired,
  withGasMargin,
} from "./evm-gas";
import { sendEvmTransfer } from "./evm-send";
import { fetchEvmHistory, type EvmExplorer } from "./evm-history";
import { readEvmParties } from "./parties-a-evm";
import { proxyGetJson } from "./_proxy";
import { withFallback as withUrlFallback } from "./_fallback";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

export interface EvmChainConfig {
  chain: ChainType;
  displayName: string;
  ticker: string;
  color: string;
  /** Primary RPC URL */
  rpcUrl: string;
  /** Fallback RPC URLs tried in order if primary fails */
  rpcFallbacks?: string[];
  /**
   * EVM chain id. When set, the JsonRpcProvider is constructed with
   * `staticNetwork: true` so ethers SKIPS the `_detectNetwork` call
   * entirely. Without this, ethers v6 retries the network-detect call
   * forever (~1 s backoff, no max-retry default) when it fails — e.g.
   * when an RPC doesn't set `Access-Control-Allow-Origin`. This kills
   * the dev server's console with hundreds of CORS errors per minute.
   * Pass the chainId here (1 for Ethereum, 137 Polygon, etc.) to skip.
   */
  chainId?: number;
  addressPlaceholder?: string;
  /** If set, this adapter handles an ERC-20 token instead of the native coin */
  tokenContract?: string;
  /** Decimal places for the ERC-20 token (e.g. 6 for USDT, 18 for most tokens) */
  tokenDecimals?: number;
  /**
   * History sources, tried in order (`evm-history.ts`). Hosts must be on the
   * http_proxy allowlist. An EMPTY list means the chain has no history source:
   * `getTransactionHistory` then says "history not available", which until
   * 2026-09-30 it did not — it returned no rows, read as "no transactions".
   */
  explorerApis?: EvmExplorer[];
}

export function createEvmAdapter(config: EvmChainConfig): ChainAdapter {
  const {
    chain,
    displayName,
    ticker,
    color,
    rpcUrl,
    rpcFallbacks = [],
    chainId,
    addressPlaceholder = "0x...",
    tokenContract,
    tokenDecimals = 18,
    explorerApis = [],
  } = config;

  const allRpcUrls = [rpcUrl, ...rpcFallbacks];

  /**
   * Construct a JsonRpcProvider with `staticNetwork` baked in when we
   * know the chainId. This is the fix for ethers v6's infinite
   * `_detectNetwork` retry loop on CORS-blocking endpoints (the
   * 2026-05-06 `eth.merkle.io` repro).
   */
  function makeProvider(url: string): ethers.JsonRpcProvider {
    if (typeof chainId === "number") {
      const network = new ethers.Network(displayName, chainId);
      return new ethers.JsonRpcProvider(url, network, {
        staticNetwork: network,
      });
    }
    return new ethers.JsonRpcProvider(url);
  }

  /**
   * Try an async operation across all RPC endpoints until one succeeds.
   *
   * For READS only. It reruns `fn` from the top on the next endpoint after any
   * error, which is harmless for a read and was a double-send for the send
   * that used to run inside it (2026-09-29 send-safety audit; `evm-send.ts`).
   */
  async function withFallback<T>(fn: (provider: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
    let lastError: any;
    for (const url of allRpcUrls) {
      try {
        const provider = makeProvider(url);
        return await fn(provider);
      } catch (e) {
        lastError = e;
        continue;
      }
    }
    throw lastError;
  }

  const adapter: ChainAdapter = {
    chain,
    displayName,
    ticker,
    color,
    addressPlaceholder,
    derivation: {
      kind: "bip39",
      path: "m/44'/60'/0'/0/0",
      standard: "MetaMask / Trust / Rabby / Rainbow first account",
      // CORRECTED 2026-08-13. This said `false`, with a comment claiming
      // "there is nothing to switch". That conflated two separate things:
      //
      //   COIN TYPE is universal — every EVM chain uses 60, because the
      //   network is chosen by chainId, not by the path. True, and it's why
      //   Arbitrum/Base/Optimism all share one address.
      //
      //   ACCOUNT and INDEX are not. Verified against the abandon-abandon
      //   vector — five paths, five different addresses:
      //     m/44'/60'/0'/0/0  0x9858EfFD…  MetaMask account 1 (our default)
      //     m/44'/60'/0'/0/1  0x6Fac4D18…  MetaMask account 2
      //     m/44'/60'/0'/0/2  0xb6716976…  MetaMask account 3
      //     m/44'/60'/1'/0/0  0x78839F60…  Ledger Live account 2
      //     m/44'/60'/0'/1    0x94381955…  Ledger legacy / MEW / MyCrypto
      //
      // So a user whose funds sit on MetaMask's second account, or on Ledger
      // Live, imports and sees an empty wallet — exactly the Cardano failure
      // that started this thread. `false` told them there was nothing to
      // look for.
      hasAlternatives: true,
    },

    /**
     * Derive at an arbitrary HD path. Enables the generic path finder and the
     * balance sweep to cover every EVM chain without per-chain code.
     */
    deriveAtPath(mnemonic: string, path: string): WalletInfo {
      const w = ethers.HDNodeWallet.fromPhrase(mnemonic.trim(), "", path);
      return {
        chain,
        address: w.address,
        mnemonic: mnemonic.trim(),
        privateKey: w.privateKey,
      };
    },

    importFromMnemonic(mnemonic: string): WalletInfo {
      const wallet = ethers.Wallet.fromPhrase(mnemonic.trim());
      return {
        chain,
        address: wallet.address,
        mnemonic: wallet.mnemonic!.phrase,
        privateKey: wallet.privateKey,
      };
    },

    importFromPrivateKey(privateKey: string): WalletInfo {
      const wallet = new ethers.Wallet(privateKey.trim());
      return {
        chain,
        address: wallet.address,
        mnemonic: "",
        privateKey: wallet.privateKey,
      };
    },

    deriveFromMnemonic(mnemonic: string): WalletInfo {
      return adapter.importFromMnemonic(mnemonic);
    },

    async getBalance(address: string): Promise<string> {
      return withFallback(async (provider) => {
        if (tokenContract) {
          const contract = new ethers.Contract(tokenContract, ERC20_ABI, provider);
          const balance: bigint = await contract.balanceOf(address);
          return ethers.formatUnits(balance, tokenDecimals);
        } else {
          const balance = await provider.getBalance(address);
          return ethers.formatEther(balance);
        }
      });
    },

    /**
     * Sign once, broadcast the same bytes, settle by hash: `evm-send.ts`.
     *
     * 2026-09-29 send-safety audit: this ran sign + broadcast + `tx.wait()`
     * inside `withFallback`, so an error after a node had already taken the
     * transfer (a receipt read, the `eth_blockNumber` ethers batches with the
     * broadcast, a 5xx on the broadcast reply) re-ran everything on the next
     * RPC: a fresh pending nonce, a NEW signature, a second transfer. It also
     * reported a send that landed as failed, and waited for a receipt forever.
     */
    async sendTransaction(
      privateKey: string,
      to: string,
      amount: string
    ): Promise<TxResult> {
      const gas = gasTokenFor(chainId);
      return sendEvmTransfer({
        privateKey,
        to,
        amount,
        urls: allRpcUrls,
        chainId,
        // A token adapter's displayName is "USDC (Arbitrum)"; messages about
        // the network and its fee coin need "Arbitrum" and "ETH".
        chainName: gas?.chainName ?? displayName,
        ticker,
        gasTicker: gas?.ticker ?? ticker,
        tokenContract,
        decimals: tokenContract ? tokenDecimals : 18,
      });
    },

    async getNetworkInfo(): Promise<NetworkInfo> {
      try {
        return await withFallback(async (provider) => {
          const feeData = await provider.getFeeData();
          const gasPrice = feeData.gasPrice
            ? ethers.formatUnits(feeData.gasPrice, "gwei")
            : "N/A";
          return {
            label: "Gas Price",
            value: parseFloat(gasPrice).toFixed(2),
            unit: "Gwei",
          };
        });
      } catch {
        return { label: "Gas Price", value: "N/A", unit: "Gwei" };
      }
    },

    /**
     * Which explorer, how its answer is read, and why it changed (operator
     * report 2026-09-30: 17 EVM rows in error, BSC silently empty):
     * `evm-history.ts`.
     */
    async getTransactionHistory(
      address: string,
      opts?: { limit?: number; cursor?: string }
    ): Promise<TxHistoryPage> {
      return fetchEvmHistory(
        {
          chain,
          displayName,
          explorers: explorerApis,
          tokenContract,
          decimals: tokenContract ? tokenDecimals : 18,
        },
        address,
        opts,
        (url) => proxyGetJson(url),
      );
    },

    /**
     * Who sent one transaction and who received it, by hash, from this
     * adapter's own RPCs in their order (`parties-a-evm.ts`): the native
     * coin's `from` / `to`, or an ERC-20 leg's `Transfer` logs of its token.
     * Works on BSC and Monad too, which have no history source.
     */
    async getTransactionParties(hash: string, ownAddress: string): Promise<TxParties | null> {
      return readEvmParties({ chainName: displayName, urls: allRpcUrls, tokenContract }, hash, ownAddress);
    },

    /**
     * The coin that pays this adapter's fees, when that is a DIFFERENT coin
     * from the one being sent. Native adapters leave it undefined: their fee
     * comes out of the balance the modal already shows.
     */
    gasToken: tokenContract ? (gasTokenFor(chainId) ?? undefined) : undefined,

    /**
     * Can this address pay the fee for the send it is about to make?
     *
     * Two independent reads, in this order, because the second is allowed to
     * fail and the first is not:
     *
     *  1. the native balance — always obtainable, and on its own enough to
     *     settle the dominant real case (a bridged wallet holding tokens and
     *     exactly zero gas);
     *  2. an `estimateGas` on the ACTUAL transfer, priced with current fee
     *     data. This is what turns "you have no ETH" into "you need
     *     0.000060756 ETH", and it is also the read a node may refuse.
     *
     * `estimateGas` rather than a gas-limit constant is deliberate: on
     * Arbitrum the returned limit folds in the L1 calldata cost, so the same
     * ERC-20 transfer that costs ~60k gas on Optimism reports several hundred
     * thousand there. A constant would understate Arbitrum by an order of
     * magnitude, and Arbitrum is where the reported failure happened.
     *
     * Never throws. The caller is a modal that must still render.
     */
    async getGasBudget(
      address: string,
      opts?: { to?: string; amount?: string },
    ): Promise<GasBudget> {
      const token = gasTokenFor(chainId);
      const base = {
        ticker: token?.ticker ?? ticker,
        chainName: token?.chainName ?? displayName,
        // A token send needs GAS out of the native balance; a native send
        // needs gas AND the amount out of it. The UI cannot word the warning
        // correctly without knowing which number it was handed.
        includesAmount: !tokenContract,
      };

      let availableWei: bigint;
      try {
        availableWei = await withFallback((provider) => provider.getBalance(address));
      } catch (e) {
        // Could not read the balance at all. Report nothing rather than a
        // zero: "you have no gas" is a claim, and an unreachable RPC is not
        // evidence for it. Same rule as `getBalance`'s own contract.
        console.warn("[evm] gas-budget balance read failed:", e);
        return { ...base, available: "0", required: null, sufficient: null };
      }

      const available = ethers.formatEther(availableWei);

      let requiredWei: bigint | null = null;
      try {
        requiredWei = await withFallback(async (provider) => {
          const feeData = await provider.getFeeData();
          const price = feeData.maxFeePerGas ?? feeData.gasPrice;
          if (!price) throw new Error("no fee data");

          // Trimmed as the send trims them (2026-09-29): a pasted trailing
          // space used to fail the estimate as an ENS lookup.
          const to = opts?.to?.trim() ?? "";
          const amount = opts?.amount?.trim() ?? "";
          let gasLimit: bigint;
          if (to && amount) {
            // Simulate the real call, from this address, so the estimate is
            // the one the chain would actually charge.
            const parsed = ethers.parseUnits(amount, tokenDecimals);
            let estimate: bigint;
            if (tokenContract) {
              const c = new ethers.Contract(tokenContract, ERC20_ABI, provider);
              estimate = await c.transfer.estimateGas(to, parsed, {
                from: address,
              });
            } else {
              estimate = await provider.estimateGas({
                from: address,
                to,
                value: parsed,
              });
            }
            // The limit the send will sign, not the bare estimate: the node
            // checks the balance against that (`withGasMargin`).
            gasLimit = withGasMargin(estimate);
          } else {
            gasLimit = fallbackGasLimit(chainId, Boolean(tokenContract));
          }

          // `parseUnits(amount, tokenDecimals)` is correct for the native
          // leg too: `tokenDecimals` defaults to 18 and is overridden only on
          // token adapters, where the amount is not added anyway.
          const amountWei = amount ? ethers.parseUnits(amount, tokenDecimals) : 0n;
          return totalNativeRequired(
            gasLimit * price,
            amountWei,
            Boolean(tokenContract),
          );
        });
      } catch {
        // Expected, and not an error worth a console line: an empty or
        // malformed recipient, or a node declining to simulate a transfer the
        // account cannot fund — which is the very condition being tested.
        requiredWei = null;
      }

      if (requiredWei != null) {
        return {
          ...base,
          available,
          required: ethers.formatEther(requiredWei),
          // Decided in wei. The decimal strings above are for display only
          // and are never what the comparison reads.
          sufficient: decideGasSufficiency(availableWei, requiredWei),
        };
      }

      // No estimate. A zero balance still settles it: no positive fee is
      // payable from nothing, whatever the limit would have been. Anything
      // else stays undecided rather than blocking a send on a guess.
      return {
        ...base,
        available,
        required: null,
        sufficient: decideGasSufficiency(availableWei, null),
      };
    },

    async getFeeEstimate(): Promise<FeeEstimate> {
      // Prefer EIP-1559 `eth_feeHistory` against the same RPC fallback list
      // as everything else. Falls back to legacy `eth_gasPrice` for chains
      // that don't yet implement 1559.
      const r = await withUrlFallback(allRpcUrls, async (url, _signal) => {
        const provider = makeProvider(url);
        try {
          const hist: any = await provider.send("eth_feeHistory", [
            "0x14",
            "latest",
            [25, 50, 90],
          ]);
          if (hist?.baseFeePerGas?.length && hist?.reward?.length) {
            const lastBaseHex = hist.baseFeePerGas[hist.baseFeePerGas.length - 1];
            const baseFee = BigInt(lastBaseHex);
            const tipForPercentile = (idx: number) => {
              const samples = hist.reward
                .map((row: string[]) => (row?.[idx] ? BigInt(row[idx]) : 0n))
                .filter((b: bigint) => b > 0n);
              if (samples.length === 0) return 0n;
              samples.sort((a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0));
              return samples[Math.floor(samples.length / 2)];
            };
            const slowTip = tipForPercentile(0);
            const normalTip = tipForPercentile(1);
            const fastTip = tipForPercentile(2);
            return {
              slow: { value: ethers.formatUnits(baseFee + slowTip, "gwei") },
              normal: { value: ethers.formatUnits(baseFee + normalTip, "gwei") },
              fast: { value: ethers.formatUnits(baseFee + fastTip, "gwei") },
              unit: "Gwei",
              fetchedAt: Date.now(),
              raw: hist,
            } as FeeEstimate;
          }
        } catch {
          /* fall through to legacy */
        }
        const fee = await provider.getFeeData();
        const gp = fee.gasPrice;
        if (!gp) throw new Error("no gas price from " + url);
        const gpGwei = ethers.formatUnits(gp, "gwei");
        return {
          normal: { value: gpGwei },
          unit: "Gwei",
          fetchedAt: Date.now(),
          raw: fee,
        } as FeeEstimate;
      });
      return r;
    },
  };

  return adapter;
}
