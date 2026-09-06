import type { ChainType, ChainAdapter } from "./types";
import {
  ethAdapter,
  avaxAdapter,
  usdtAvaxAdapter,
  usdtEthAdapter,
  usdtOpAdapter,
  usdtBscAdapter,
  usdcEthAdapter,
  usdcArbAdapter,
  usdcBaseAdapter,
  usdcOpAdapter,
  usdcPolAdapter,
  usdcAvaxAdapter,
  usdcBscAdapter,
  usdt0ArbAdapter,
  usdt0PolAdapter,
  polygonAdapter,
  flareAdapter,
  arbitrumAdapter,
  baseAdapter,
  optimismAdapter,
  bscAdapter,
  monadAdapter,
} from "./eth-wallet";
import { cfxAdapter } from "./cfx-wallet";
import { btcAdapter } from "./btc-wallet";
import { solAdapter } from "./sol-wallet";
import { xrpAdapter } from "./xrp-wallet";
import { trxAdapter } from "./trx-wallet";
import { adaAdapter } from "./ada-wallet";
import { xmrAdapter } from "./xmr-wallet";
import { zphAdapter } from "./zph-wallet";
import { dogeAdapter } from "./doge-wallet";
import { rvnAdapter } from "./rvn-wallet";
import { hbarAdapter } from "./hbar-wallet";
import { algoAdapter } from "./algo-wallet";
import { ltcAdapter } from "./ltc-wallet";
import { bchAdapter } from "./bch-wallet";
import { dashAdapter } from "./dash-wallet";
import { stellarAdapter } from "./stellar-wallet";
import { suiAdapter } from "./sui-wallet";

import { ergoAdapter } from "./erg-wallet";
import { nearAdapter } from "./near-wallet";
import { aptAdapter } from "./apt-wallet";
import { zanoAdapter } from "./zano-wallet";
import { usdcSolAdapter, usdtSolAdapter } from "./spl-token-wallet";
import { usdtTronAdapter } from "./trc20-wallet";

const adapters: Record<ChainType, ChainAdapter> = {
  ethereum: ethAdapter,
  avalanche: avaxAdapter,
  "usdt-avax": usdtAvaxAdapter,
  "usdt-eth": usdtEthAdapter,
  "usdt-op": usdtOpAdapter,
  "usdt-bsc": usdtBscAdapter,
  "usdc-eth": usdcEthAdapter,
  "usdc-arb": usdcArbAdapter,
  "usdc-base": usdcBaseAdapter,
  "usdc-op": usdcOpAdapter,
  "usdc-pol": usdcPolAdapter,
  "usdc-avax": usdcAvaxAdapter,
  "usdc-bsc": usdcBscAdapter,
  "usdt0-arb": usdt0ArbAdapter,
  "usdt0-pol": usdt0PolAdapter,
  "usdc-sol": usdcSolAdapter,
  "usdt-sol": usdtSolAdapter,
  "usdt-tron": usdtTronAdapter,
  polygon: polygonAdapter,
  flare: flareAdapter,
  bitcoin: btcAdapter,
  solana: solAdapter,
  xrp: xrpAdapter,
  tron: trxAdapter,
  cardano: adaAdapter,
  monero: xmrAdapter,
  zephyr: zphAdapter,
  dogecoin: dogeAdapter,
  ravencoin: rvnAdapter,
  conflux: cfxAdapter,
  hedera: hbarAdapter,
  algorand: algoAdapter,
  litecoin: ltcAdapter,
  "bitcoin-cash": bchAdapter,
  // Phase 4 (L2/BSC) + Phase 3 (Monad) + Phases 5/6/7 (new chains).
  arbitrum: arbitrumAdapter,
  base: baseAdapter,
  optimism: optimismAdapter,
  bsc: bscAdapter,
  monad: monadAdapter,
  dash: dashAdapter,
  stellar: stellarAdapter,
  sui: suiAdapter,
  ergo: ergoAdapter,
  near: nearAdapter,
  aptos: aptAdapter,
  zano: zanoAdapter,
};

export function getAdapter(chain: ChainType): ChainAdapter {
  return adapters[chain];
}

/** Alias used by feature-level hooks; identical to `getAdapter`. */
export const getAdapterByChain = getAdapter;

export const ALL_CHAINS: ChainType[] = [
  "ethereum",
  "avalanche",
  "usdt-avax",
  "usdt-eth",
  "usdt-op",
  "usdt-bsc",
  "usdc-eth",
  "usdc-arb",
  "usdc-base",
  "usdc-op",
  "usdc-pol",
  "usdc-avax",
  "usdc-bsc",
  "usdt0-arb",
  "usdt0-pol",
  "usdc-sol",
  "usdt-sol",
  "usdt-tron",
  "polygon",
  "flare",
  "bitcoin",
  "solana",
  "xrp",
  "tron",
  "cardano",
  "monero",
  "zephyr",
  "dogecoin",
  "ravencoin",
  "conflux",
  "hedera",
  "algorand",
  "litecoin",
  "bitcoin-cash",
  "arbitrum",
  "base",
  "optimism",
  "bsc",
  "monad",
  "dash",
  "stellar",
  "sui",
  "ergo",
  "near",
  "aptos",
  "zano",
];

export type {
  ChainType,
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxDirection,
  TxHistoryPage,
  FeeEstimate,
  FeeTier,
} from "./types";
