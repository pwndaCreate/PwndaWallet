/**
 * Hand-curated default pool of Zephyr Protocol mainnet remote nodes.
 *
 * Unlike Monero (where Feather maintains `nodes.yaml` and we regenerate
 * `xmr-nodes-feather.ts` at build time), Zephyr has no Feather-equivalent
 * authoritative list. The closest thing is the dynamic directory at
 * `zeph.network/api/nodes`, which we can't pin as a build-time snapshot.
 *
 * So this file is maintained by hand. Each entry was manually verified
 * to respond to `GET /get_info` with a 200 + valid JSON height within a
 * couple of seconds, and to return `mainnet: true` in the response body.
 *
 * Regeneration process (manual, periodic): re-probe this list, drop any
 * dead entries, add anything new from `zeph.network/api/nodes` that looks
 * reliable. When the list grows unwieldy we can add a runtime fetch of
 * that API (parallel to `fetchCommunityNodes` for Monero).
 */

export interface ZphDefaultNode {
  url: string;
  operator: string;
}

/**
 * Default pool as of 2026-04-23. Confirmed-live probes:
 *   - remote-node.zephyrprotocol.com:17767  →  146 ms, HTTP 200, mainnet:true
 *   - node.zeph.network:80                  →  1.2 s,  HTTP 200, mainnet:true
 *   - node.zeph.network:443 (SSL)           →  1.3 s,  HTTP 200, mainnet:true
 *
 * Ordering is NOT a preference ranking — the session picks by measured
 * RTT via `raceBestNode`. Ordering here is only used as a tie-breaker
 * for deterministic probe sequencing in `tryNodes`.
 */
export const ZPH_DEFAULT_NODES: ReadonlyArray<ZphDefaultNode> = [
  {
    url: "http://remote-node.zephyrprotocol.com:17767",
    operator: "zephyrprotocol (official)",
  },
  {
    url: "http://node.zeph.network:80",
    operator: "zeph.network",
  },
  {
    url: "https://node.zeph.network:443",
    operator: "zeph.network (SSL)",
  },
];
