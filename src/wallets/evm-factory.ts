import { ethers } from "ethers";
import type {
  ChainType,
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
} from "./types";
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
   * Blockscout-style explorer API base URLs (e.g. `https://eth.blockscout.com/api`),
   * tried in order. Endpoints must be on the http_proxy allowlist. Empty
   * list disables history fetching for this chain.
   */
  explorerApis?: string[];
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

  /** Try an async operation across all RPC endpoints until one succeeds */
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

    async sendTransaction(
      privateKey: string,
      to: string,
      amount: string
    ): Promise<TxResult> {
      return withFallback(async (provider) => {
        const wallet = new ethers.Wallet(privateKey, provider);

        if (tokenContract) {
          const contract = new ethers.Contract(tokenContract, ERC20_ABI, wallet);
          const parsedAmount = ethers.parseUnits(amount, tokenDecimals);
          const tx = await contract.transfer(to, parsedAmount);
          await tx.wait();
          return { hash: tx.hash };
        } else {
          const tx = await wallet.sendTransaction({
            to,
            value: ethers.parseEther(amount),
          });
          await tx.wait();
          return { hash: tx.hash };
        }
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

    async getTransactionHistory(
      address: string,
      opts?: { limit?: number; cursor?: string }
    ): Promise<TxHistoryPage> {
      const limit = opts?.limit ?? 25;
      if (explorerApis.length === 0) return { items: [] };

      // Blockscout exposes the Etherscan-V1 module=account interface, so the
      // same querystring works against every instance. For ERC-20 tokens we
      // hit `action=tokentx&contractaddress=...`; native coin uses `txlist`.
      const action = tokenContract ? "tokentx" : "txlist";
      const ctParam = tokenContract ? `&contractaddress=${tokenContract}` : "";
      const cursor = opts?.cursor ? Number(opts.cursor) : 0;
      const startBlock = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;

      const data = await withUrlFallback(
        explorerApis,
        async (base) =>
          await proxyGetJson<{ status: string; message: string; result: any[] | string }>(
            `${base}?module=account&action=${action}` +
              `&address=${address}` +
              `&startblock=${startBlock}` +
              `&endblock=99999999` +
              `&page=1&offset=${limit}&sort=desc` +
              ctParam
          )
      );

      // Blockscout returns `status: "0"` and `message: "No transactions found"`
      // for empty results — that's a successful zero-row answer, not an error.
      const rows = Array.isArray(data.result) ? data.result : [];
      const lower = address.toLowerCase();
      const items: ChainTx[] = rows.map((r) => {
        const from = String(r.from ?? "").toLowerCase();
        const to = String(r.to ?? "").toLowerCase();
        const direction: ChainTx["direction"] =
          from === lower && to === lower
            ? "self"
            : from === lower
              ? "out"
              : "in";
        const value = BigInt(r.value ?? "0");
        const fee = (() => {
          if (r.gasUsed && r.gasPrice) {
            try {
              return ethers.formatEther(BigInt(r.gasUsed) * BigInt(r.gasPrice));
            } catch {
              return undefined;
            }
          }
          return undefined;
        })();
        const amount = tokenContract
          ? ethers.formatUnits(value, tokenDecimals)
          : ethers.formatEther(value);
        const timestamp = r.timeStamp ? Number(r.timeStamp) : undefined;
        const confirmations = r.confirmations ? Number(r.confirmations) : undefined;
        const height = r.blockNumber ? Number(r.blockNumber) : undefined;
        return {
          chain,
          hash: String(r.hash),
          direction,
          amount,
          fee: direction === "out" ? fee : undefined,
          timestamp,
          confirmations,
          height,
          counterparty: direction === "out" ? r.to : r.from,
          meta: {
            input: r.input,
            method: r.functionName ?? r.methodId,
            tokenSymbol: r.tokenSymbol,
            contractAddress: r.contractAddress,
          },
        };
      });

      // Cursor: oldest blockNumber returned, used as `endblock` for the next
      // page. Blockscout's pagination via `page=N` is implementation-specific
      // and unreliable across instances; block-window cursors are portable.
      const cursorOut =
        items.length === limit
          ? String(Math.min(...items.map((i) => i.height ?? Number.MAX_SAFE_INTEGER)) - 1)
          : undefined;
      return { items, cursor: cursorOut };
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
