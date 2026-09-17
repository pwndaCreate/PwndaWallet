/**
 * Default pool of Xelis mainnet daemons.
 *
 * Every entry below ANSWERED a live `POST <url>/json_rpc {"method":"get_info"}`
 * during the P0 spike on 2026-09-15, reporting `network: "mainnet"` and a tip
 * about 12 s old. Sources and results are in
 * `wiki/queries/2026-09-15-xelis-wallet-binary-spike.md` section C.
 *
 * Two candidates were REMOVED rather than listed hopefully:
 *   - `https://sg-node.xelis.io` answered HTTP 526 (a Cloudflare TLS failure).
 *   - `https://de-node.xelis.io` does not resolve in DNS.
 * Both were guesses at a naming pattern, and neither exists. A node that is in
 * this list but never answers costs every session a probe timeout before it
 * falls through, so an unverified guess is worse than a shorter list.
 *
 * # CORS
 *
 * All three send `Access-Control-Allow-Origin: *` (from Cloudflare, not from
 * the node), and the preflight returns 204 allowing `Content-Type` and
 * `Authorization`. So the webview COULD call them directly — but the probe
 * still goes through Rust (`xelis_probe_node`), because the header is
 * Cloudflare's to withdraw and a node behind a different front-end would
 * silently stop being probeable from the renderer.
 *
 * # Not the wallet's own default
 *
 * `xelis_wallet`'s built-in default daemon is `http://127.0.0.1:8080`, which on
 * the spike machine was held by an unrelated service ("AgentService"). The
 * sidecar therefore always passes a daemon address explicitly and never relies
 * on that default. See `xelis_rpc.rs`.
 */

export interface XelisDefaultNode {
  url: string;
  operator: string;
}

export const XELIS_DEFAULT_NODES: ReadonlyArray<XelisDefaultNode> = [
  {
    // `MAINNET_NODE_URL` in the official `xelis-js-sdk` (`src/config.ts`).
    // Verified live: mainnet, version 1.25.0-a6ae4cd9.
    url: "https://node.xelis.io",
    operator: "XELIS project (official public node)",
  },
  {
    // Listed by Genesix, the official wallet app (`app_resources.dart`).
    // Verified live: mainnet, version 1.25.0-b149b57a.
    url: "https://us-node.xelis.io",
    operator: "XELIS project (US)",
  },
  {
    // Also from Genesix. Verified live: mainnet, version 1.25.0-a6ae4cd9.
    url: "https://fr-node.xelis.io",
    operator: "XELIS project (EU)",
  },
];

/**
 * The public testnet node, for a dev server running `VITE_XELIS_NETWORK=testnet`.
 *
 * NOT part of the default pool: it is a different chain, and a mainnet wallet
 * pointed at it would scan a chain its addresses do not exist on.
 *
 * Health warning recorded at the same time: the public testnet was STALLED —
 * it answered `get_info` and `p2p_status` normally, with a plausible
 * topoheight, while its top block was 803 minutes old. That is the case that
 * motivated `xelis_probe_node` reading the top block's AGE instead of trusting
 * topoheight alone.
 */
export const XELIS_TESTNET_NODE: XelisDefaultNode = {
  url: "https://testnet-node.xelis.io",
  operator: "XELIS project (testnet)",
};
