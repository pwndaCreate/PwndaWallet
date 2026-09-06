/**
 * Per-chain block-explorer deep-link builder.
 *
 * Returns a public URL where the user can inspect a transaction hash. Used
 * by the ActivityView row click and (eventually) the tx detail drawer's
 * "view on explorer" button. All URLs are publicly viewable; clicking
 * opens in the OS default browser via `tauri-plugin-opener`.
 */

import type { ChainType } from "./types";

export function explorerTxUrl(chain: ChainType, hash: string): string | null {
  const h = hash.replace(/^0x/, "");
  switch (chain) {
    case "bitcoin":
      return `https://mempool.space/tx/${h}`;
    case "ethereum":
      return `https://eth.blockscout.com/tx/0x${h}`;
    case "avalanche":
      return `https://snowtrace.io/tx/0x${h}`;
    // Stablecoin legs resolve to their PARENT chain's explorer — the tx lives
    // on that chain; only the token contract differs.
    case "usdt-avax":
    case "usdc-avax":
      return `https://snowtrace.io/tx/0x${h}`;
    case "usdt-eth":
    case "usdc-eth":
      return `https://eth.blockscout.com/tx/0x${h}`;
    case "usdc-pol":
    case "usdt0-pol":
      return `https://polygon.blockscout.com/tx/0x${h}`;
    case "polygon":
      return `https://polygon.blockscout.com/tx/0x${h}`;
    case "flare":
      return `https://flare-explorer.flare.network/tx/0x${h}`;
    case "solana":
      return `https://explorer.solana.com/tx/${hash}`;
    case "xrp":
      return `https://livenet.xrpl.org/transactions/${hash}`;
    case "tron":
      return `https://tronscan.org/#/transaction/${hash}`;
    case "cardano":
      return `https://cexplorer.io/tx/${hash}`;
    case "monero":
      return `https://xmrchain.net/tx/${hash}`;
    case "zephyr":
      return `https://explorer.zephyrprotocol.com/tx/${hash}`;
    case "zano":
      // Note the singular "transaction", not "tx" — different from every
      // other CryptoNote-family explorer here. Verified live 2026-08-27.
      return `https://explorer.zano.org/transaction/${hash}`;
    case "dogecoin":
      return `https://dogechain.info/tx/${hash}`;
    case "ravencoin":
      return `https://ravencoin.network/tx/${hash}`;
    case "conflux":
      return `https://confluxscan.io/transaction/${hash}`;
    case "hedera":
      return `https://hashscan.io/mainnet/transaction/${encodeURIComponent(hash)}`;
    case "algorand":
      return `https://allo.info/tx/${hash}`;
    case "litecoin":
      return `https://litecoinspace.org/tx/${h}`;
    case "bitcoin-cash":
      return `https://blockchair.com/bitcoin-cash/transaction/${h}`;
    default:
      return null;
  }
}
