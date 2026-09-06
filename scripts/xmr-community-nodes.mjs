// Verify `fetchCommunityNodes` actually fetches and filters ditatompel's list.
// Run: npx tsx scripts/xmr-community-nodes.mjs

import { fetchCommunityNodes } from "../src/wallets/xmr-nodes.ts";

const nodes = await fetchCommunityNodes();
console.log(`fetched ${nodes.length} community fallback nodes`);
for (const n of nodes.slice(0, 10)) {
  console.log(`  ${n.url}  (${n.operator})`);
}
if (nodes.length === 0) {
  process.exitCode = 1;
  console.error("FAIL: no nodes returned");
} else {
  console.log("\nPASS: community fallback list is non-empty and filtered");
}
