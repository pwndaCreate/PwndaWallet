// THIS FILE IS AUTO-GENERATED. DO NOT EDIT BY HAND.
//
// Regenerate with:   node scripts/sync-feather-nodes.mjs
//
// Source:   https://raw.githubusercontent.com/feather-wallet/feather-nodes/master/nodes.yaml
// Synced:   2026-09-06T07:04:51.837Z
// Entries:  10 mainnet/clearnet nodes
// 
//
// Feather's curation criteria (paraphrased from feather-wallet/feather-nodes
// README): operator contactable, no RPC payments, consistent tip sync, not on
// a non-consensus fork, community trust intact. We inherit that vetting here.

export interface FeatherNode {
  url: string;
  operator: string;
}

export const FEATHER_NODES: ReadonlyArray<FeatherNode> = [
  { url: "http://node3-us.monero.love:18081", operator: "baz" },
  { url: "http://xmr-node.cakewallet.com:18081", operator: "cakewallet" },
  { url: "http://node.monerodevs.org:18089", operator: "plowsof" },
  { url: "http://node2.monerodevs.org:18089", operator: "plowsof" },
  { url: "http://node3.monerodevs.org:18089", operator: "plowsof" },
  { url: "http://ravfx.its-a-node.org:18081", operator: "ravfx" },
  { url: "http://ravfx2.its-a-node.org:18089", operator: "ravfx" },
  { url: "http://rucknium.me:18081", operator: "rucknium" },
  { url: "http://node.sethforprivacy.com:18089", operator: "sethforprivacy" },
  { url: "http://xmr.stormycloud.org:18089", operator: "stormycloud.org" },
];
