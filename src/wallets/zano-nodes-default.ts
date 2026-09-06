/**
 * Hand-curated default pool of Zano mainnet remote nodes.
 *
 * Unlike Monero (Feather's `nodes.yaml`, regenerated at build time into
 * `xmr-nodes-feather.ts`), Zano has NO third-party curated node directory at
 * all — official, semi-official, or otherwise. `docs.zano.org/docs/build/public-nodes`
 * lists exactly ONE node, and says so explicitly: "development tools and
 * aren't meant for production services... stability and availability aren't
 * guaranteed." A survey for a second option (Phase 0, 2026-08-27) found none.
 *
 * So this pool is thin by fact, not by omission — see `zano-integration-plan.md`
 * §3 "Public node survey" for the search that produced this conclusion. The
 * node picker UI (`ZanoNodesView`, Phase 5) leads with "add your own node"
 * rather than implying a healthy default pool exists.
 *
 * VERIFIED live 2026-08-27 (not just "listed in docs"): `POST /json_rpc
 * {"method":"getinfo"}` → HTTP 200, ~300ms, `result.height` = 3,834,338 —
 * past the HF6 activation height (3,833,000), confirming the node is
 * live, synced, and past the fork.
 */

export interface ZanoDefaultNode {
  url: string;
  operator: string;
}

export const ZANO_DEFAULT_NODES: ReadonlyArray<ZanoDefaultNode> = [
  {
    url: "http://37.27.100.59:10500",
    operator: "Zano project (official dev node — not production-grade)",
  },
];
