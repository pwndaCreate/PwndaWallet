import { createEvmAdapter } from "./evm-factory";
import {
  ETH_RPCS,
  AVAX_RPCS,
  POL_RPCS,
  FLR_RPCS,
  ARB_RPCS,
  BASE_RPCS,
  OP_RPCS,
  BSC_RPCS,
  MONAD_RPCS,
} from "./chain-rpcs";

// Blockscout instances for each EVM chain we support. All keyless. The
// `/api` suffix is intentional — those endpoints expose the Etherscan-V1
// `module=account&action=txlist|tokentx` interface used by evm-factory's
// `getTransactionHistory`. Hosts here must also live in `http_proxy.rs`'s
// `ALLOWED_HOST_SUFFIXES` (`blockscout.com`, `routescan.io`, `flare-explorer.flare.network`).
const ETH_EXPLORERS = [
  "https://eth.blockscout.com/api",
];
const AVAX_EXPLORERS = [
  "https://avalanche.blockscout.com/api",
  // Routescan exposes the same Etherscan-style API on a chain-id route.
  "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api",
];
const POLYGON_EXPLORERS = [
  "https://polygon.blockscout.com/api",
];
const FLARE_EXPLORERS = [
  // Flare's official explorer is a Blockscout fork on its own host.
  "https://flare-explorer.flare.network/api",
];
const ARB_EXPLORERS = [
  "https://arbitrum.blockscout.com/api",
];
const BASE_EXPLORERS = [
  "https://base.blockscout.com/api",
];
const OP_EXPLORERS = [
  "https://optimism.blockscout.com/api",
];
const BSC_EXPLORERS = [
  // Blockscout has a BSC mirror; Routescan also covers it via chain-id 56.
  "https://api.routescan.io/v2/network/mainnet/evm/56/etherscan/api",
];
const MONAD_EXPLORERS = [
  // Monad's primary explorer (Phase 3). Blockscout-fork shape.
  "https://explorer.monad.xyz/api",
];

// RPC URL lists — pulled from `chain-rpcs.ts` so the dashboard adapter +
// the swap broadcast path + the Settings → Network test panel all read
// from the same source. Each list is Cloudflare-/most-reliable-first
// and respects per-chain env overrides (`VITE_ETH_RPC_URL`, etc).
const ethRpcs = ETH_RPCS();
const avaxRpcs = AVAX_RPCS();
const polRpcs = POL_RPCS();
const flrRpcs = FLR_RPCS();
const arbRpcs = ARB_RPCS();
const baseRpcs = BASE_RPCS();
const opRpcs = OP_RPCS();
const bscRpcs = BSC_RPCS();
const monadRpcs = MONAD_RPCS();

// chainId on each adapter activates `staticNetwork: true` in the
// underlying JsonRpcProvider. Without this, ethers v6 tries to
// auto-detect the chain id on every fresh provider instance, which
// retries forever on CORS-blocking endpoints. Pinning it here
// eliminates the retry loop AND the wallet's chain-id is hardcoded
// per adapter anyway, so there's no value in detecting.

export const ethAdapter = createEvmAdapter({
  chain: "ethereum",
  displayName: "Ethereum",
  ticker: "ETH",
  color: "#627eea",
  chainId: 1,
  rpcUrl: ethRpcs[0],
  rpcFallbacks: ethRpcs.slice(1),
  explorerApis: ETH_EXPLORERS,
});

export const avaxAdapter = createEvmAdapter({
  chain: "avalanche",
  displayName: "Avalanche",
  ticker: "AVAX",
  color: "#e84142",
  chainId: 43114,
  rpcUrl: avaxRpcs[0],
  rpcFallbacks: avaxRpcs.slice(1),
  explorerApis: AVAX_EXPLORERS,
});

export const usdtAvaxAdapter = createEvmAdapter({
  chain: "usdt-avax",
  displayName: "USDT (AVAX)",
  ticker: "USDT",
  color: "#26a17b",
  chainId: 43114,
  rpcUrl: avaxRpcs[0],
  rpcFallbacks: avaxRpcs.slice(1),
  tokenContract: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
  tokenDecimals: 6,
  explorerApis: AVAX_EXPLORERS,
});

export const polygonAdapter = createEvmAdapter({
  chain: "polygon",
  displayName: "Polygon",
  ticker: "POL",
  color: "#8247e5",
  chainId: 137,
  rpcUrl: polRpcs[0],
  rpcFallbacks: polRpcs.slice(1),
  explorerApis: POLYGON_EXPLORERS,
});

export const flareAdapter = createEvmAdapter({
  chain: "flare",
  displayName: "Flare",
  ticker: "FLR",
  color: "#e62058",
  chainId: 14,
  rpcUrl: flrRpcs[0],
  rpcFallbacks: flrRpcs.slice(1),
  explorerApis: FLARE_EXPLORERS,
});

// Phase 4 (2026-05-08): EVM L2s + BSC ride the Ethereum key but get
// dedicated balance + history pipelines. Without separate adapters,
// users see only L1 ETH and have no way to confirm L2 receives.
export const arbitrumAdapter = createEvmAdapter({
  chain: "arbitrum",
  displayName: "Arbitrum",
  ticker: "ETH",
  color: "#28a0f0",
  chainId: 42161,
  rpcUrl: arbRpcs[0],
  rpcFallbacks: arbRpcs.slice(1),
  explorerApis: ARB_EXPLORERS,
});

export const baseAdapter = createEvmAdapter({
  chain: "base",
  displayName: "Base",
  ticker: "ETH",
  color: "#0052ff",
  chainId: 8453,
  rpcUrl: baseRpcs[0],
  rpcFallbacks: baseRpcs.slice(1),
  explorerApis: BASE_EXPLORERS,
});

export const optimismAdapter = createEvmAdapter({
  chain: "optimism",
  displayName: "Optimism",
  ticker: "ETH",
  color: "#ff0420",
  chainId: 10,
  rpcUrl: opRpcs[0],
  rpcFallbacks: opRpcs.slice(1),
  explorerApis: OP_EXPLORERS,
});

export const bscAdapter = createEvmAdapter({
  chain: "bsc",
  displayName: "BNB Smart Chain",
  ticker: "BNB",
  color: "#f3ba2f",
  chainId: 56,
  rpcUrl: bscRpcs[0],
  rpcFallbacks: bscRpcs.slice(1),
  explorerApis: BSC_EXPLORERS,
});

// Phase 3 (2026-05-08): Monad — EVM-compatible mainnet, chain id 143.
export const monadAdapter = createEvmAdapter({
  chain: "monad",
  displayName: "Monad",
  ticker: "MON",
  color: "#7c3aed",
  chainId: 143,
  rpcUrl: monadRpcs[0],
  rpcFallbacks: monadRpcs.slice(1),
  explorerApis: MONAD_EXPLORERS,
});


// ── Stablecoin legs (2026-09-02). Every contract below was verified
// on-chain (symbol/name/decimals) before it was added — see
// `wallets/stablecoins.ts`, which is the registry these mirror. Decimals
// are per-contract: BSC is 18, everywhere else 6.

export const usdtEthAdapter = createEvmAdapter({
  chain: "usdt-eth",
  displayName: "USDT (Ethereum)",
  ticker: "USDT",
  color: "#26a17b",
  chainId: 1,
  rpcUrl: ethRpcs[0],
  rpcFallbacks: ethRpcs.slice(1),
  tokenContract: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  tokenDecimals: 6,
  explorerApis: ETH_EXPLORERS,
});

export const usdtOpAdapter = createEvmAdapter({
  chain: "usdt-op",
  displayName: "USDT (Optimism)",
  ticker: "USDT",
  color: "#26a17b",
  chainId: 10,
  rpcUrl: opRpcs[0],
  rpcFallbacks: opRpcs.slice(1),
  tokenContract: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
  tokenDecimals: 6,
  explorerApis: ETH_EXPLORERS,
});

export const usdtBscAdapter = createEvmAdapter({
  chain: "usdt-bsc",
  displayName: "USDT (BNB Chain)",
  ticker: "USDT",
  color: "#26a17b",
  chainId: 56,
  rpcUrl: bscRpcs[0],
  rpcFallbacks: bscRpcs.slice(1),
  tokenContract: "0x55d398326f99059fF775485246999027B3197955",
  tokenDecimals: 18,
  explorerApis: BSC_EXPLORERS,
});

export const usdcEthAdapter = createEvmAdapter({
  chain: "usdc-eth",
  displayName: "USDC (Ethereum)",
  ticker: "USDC",
  color: "#2775ca",
  chainId: 1,
  rpcUrl: ethRpcs[0],
  rpcFallbacks: ethRpcs.slice(1),
  tokenContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  tokenDecimals: 6,
  explorerApis: ETH_EXPLORERS,
});

export const usdcArbAdapter = createEvmAdapter({
  chain: "usdc-arb",
  displayName: "USDC (Arbitrum)",
  ticker: "USDC",
  color: "#2775ca",
  chainId: 42161,
  rpcUrl: arbRpcs[0],
  rpcFallbacks: arbRpcs.slice(1),
  tokenContract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  tokenDecimals: 6,
  explorerApis: ETH_EXPLORERS,
});

export const usdcBaseAdapter = createEvmAdapter({
  chain: "usdc-base",
  displayName: "USDC (Base)",
  ticker: "USDC",
  color: "#2775ca",
  chainId: 8453,
  rpcUrl: baseRpcs[0],
  rpcFallbacks: baseRpcs.slice(1),
  tokenContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  tokenDecimals: 6,
  explorerApis: BASE_EXPLORERS,
});

export const usdcOpAdapter = createEvmAdapter({
  chain: "usdc-op",
  displayName: "USDC (Optimism)",
  ticker: "USDC",
  color: "#2775ca",
  chainId: 10,
  rpcUrl: opRpcs[0],
  rpcFallbacks: opRpcs.slice(1),
  tokenContract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  tokenDecimals: 6,
  explorerApis: ETH_EXPLORERS,
});

export const usdcPolAdapter = createEvmAdapter({
  chain: "usdc-pol",
  displayName: "USDC (Polygon)",
  ticker: "USDC",
  color: "#2775ca",
  chainId: 137,
  rpcUrl: polRpcs[0],
  rpcFallbacks: polRpcs.slice(1),
  tokenContract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  tokenDecimals: 6,
  explorerApis: POLYGON_EXPLORERS,
});

export const usdcAvaxAdapter = createEvmAdapter({
  chain: "usdc-avax",
  displayName: "USDC (Avalanche)",
  ticker: "USDC",
  color: "#2775ca",
  chainId: 43114,
  rpcUrl: avaxRpcs[0],
  rpcFallbacks: avaxRpcs.slice(1),
  tokenContract: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  tokenDecimals: 6,
  explorerApis: AVAX_EXPLORERS,
});

export const usdcBscAdapter = createEvmAdapter({
  chain: "usdc-bsc",
  displayName: "USDC (BNB Chain)",
  ticker: "USDC",
  color: "#2775ca",
  chainId: 56,
  rpcUrl: bscRpcs[0],
  rpcFallbacks: bscRpcs.slice(1),
  tokenContract: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  tokenDecimals: 18,
  explorerApis: BSC_EXPLORERS,
});

export const usdt0ArbAdapter = createEvmAdapter({
  chain: "usdt0-arb",
  displayName: "USD₮0 (Arbitrum)",
  ticker: "USDT0",
  color: "#1e9e78",
  chainId: 42161,
  rpcUrl: arbRpcs[0],
  rpcFallbacks: arbRpcs.slice(1),
  tokenContract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  tokenDecimals: 6,
  explorerApis: ETH_EXPLORERS,
});

export const usdt0PolAdapter = createEvmAdapter({
  chain: "usdt0-pol",
  displayName: "USD₮0 (Polygon)",
  ticker: "USDT0",
  color: "#1e9e78",
  chainId: 137,
  rpcUrl: polRpcs[0],
  rpcFallbacks: polRpcs.slice(1),
  tokenContract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  tokenDecimals: 6,
  explorerApis: POLYGON_EXPLORERS,
});
