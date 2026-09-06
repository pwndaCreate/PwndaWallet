/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Wallet-proxy base URL — the user-controlled server that fronts SwapKit
   * and NEAR Intents. Set per-build via `.env.local` or the build command.
   * Defaults to `https://wallet.pwnda.org`.
   */
  readonly VITE_PROXY_URL?: string;
  /** Default affiliate identifier (THORName / referral) to display in UI. */
  /**
   * Router live/mock flags consumed by `features/swap/router-modes.ts`.
   * Drive banner colors + confirm-modal copy. Defaults: SwapKit `false`
   * (mock), Intents `true` (live with the user's JWT). Flip when each
   * upstream becomes/leaves live.
   */
  readonly VITE_SWAPKIT_LIVE?: string;
  readonly VITE_INTENTS_LIVE?: string;
  /**
   * Per-chain RPC overrides consumed by `wallets/chain-rpcs.ts` (EVM)
   * and `features/swap/swap-data.ts` (everything else). Each falls back
   * to a Cloudflare-first defaults list when unset.
   *
   * Canonical name is `VITE_<CHAIN>_RPC_URL`; the older
   * `VITE_<CHAIN>_RPC` (without `_URL`) is honored as a back-compat
   * alias for the EVM family.
   */
  // EVM family — `_RPC_URL` canonical, `_RPC` honored as back-compat.
  readonly VITE_ETH_RPC_URL?: string;
  readonly VITE_AVAX_RPC_URL?: string;
  readonly VITE_POL_RPC_URL?: string;
  readonly VITE_FLR_RPC_URL?: string;
  readonly VITE_ARB_RPC_URL?: string;
  readonly VITE_BASE_RPC_URL?: string;
  readonly VITE_OP_RPC_URL?: string;
  readonly VITE_BSC_RPC_URL?: string;
  readonly VITE_ETH_RPC?: string;
  readonly VITE_AVAX_RPC?: string;
  readonly VITE_POL_RPC?: string;
  readonly VITE_FLR_RPC?: string;
  readonly VITE_ARB_RPC?: string;
  readonly VITE_BASE_RPC?: string;
  readonly VITE_OP_RPC?: string;
  readonly VITE_BSC_RPC?: string;
  // Other JSON-RPC chains.
  readonly VITE_SOL_RPC_URL?: string;
  readonly VITE_NEAR_RPC_URL?: string;
  readonly VITE_SOL_RPC?: string;
  readonly VITE_NEAR_RPC?: string;
  // REST API chains — `_API_URL` canonical, `_RPC`/`_API` honored.
  readonly VITE_BTC_API_URL?: string;
  readonly VITE_LTC_API_URL?: string;
  readonly VITE_DOGE_API_URL?: string;
  readonly VITE_BCH_API_URL?: string;
  readonly VITE_BTC_RPC?: string;
  readonly VITE_LTC_RPC?: string;
  readonly VITE_DOGE_RPC?: string;
  readonly VITE_BCH_RPC?: string;
  /**
   * Blockfrost (Cardano) API project key. Required for ANY ADA balance /
   * history call — Blockfrost has no anonymous tier. Without this, the
   * Cardano adapter short-circuits balance to 0 and emits a one-shot
   * grouped warn instead of producing 403s on every refresh.
   * Free tier: https://blockfrost.io
   */
  readonly VITE_BLOCKFROST_KEY?: string;
  /**
   * When `"true"`, `useSwapQuote` logs each outgoing quote-request body
   * to the console under the `[QUOTE-DEBUG]` prefix. Off by default to
   * avoid leaking addresses + amounts into the production log; flip it
   * on in `.env.local` when chasing a specific quote-flow regression.
   */
  readonly VITE_DEBUG_QUOTE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
