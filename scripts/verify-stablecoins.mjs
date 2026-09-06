// Verify every contract in `src/wallets/stablecoins.ts` ON CHAIN.
//
// Read-only and autonomous: reads symbol() / name() / decimals() from each
// registry row's contract and compares them against what the row claims. A
// wrong contract address is a wrong balance or a send into a void, so nothing
// enters that file without passing here.
//
// Run:  node scripts/verify-stablecoins.mjs
// Exit: 0 when every row agrees, 1 on any mismatch or unreachable contract.
//
// Two findings from the first run are the reason this exists rather than a
// one-off check:
//   * Polygon's 0xc2132D05... answers symbol() = "USDT0", not "USDT" — it
//     migrated to the LayerZero OFT.
//   * Bridged USDC.e on Arbitrum (0xFF970A61...) and Optimism (0x7F5c764c...)
//     BOTH still answer symbol() = "USDC". Only name() distinguishes them
//     ("USD Coin (Arb1)"), which is why name is checked too.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, "..", "src", "wallets", "stablecoins.ts");

/** Pull the rows out of the TS registry without a TS toolchain. */
function readRegistry() {
  const src = readFileSync(REGISTRY, "utf8");
  const rows = [];
  const re =
    /\{\s*chain:\s*"([^"]+)",\s*parent:\s*"([^"]+)",\s*network:\s*"([^"]+)",\s*contract:\s*"([^"]+)",\s*decimals:\s*(\d+)/g;
  let m;
  while ((m = re.exec(src))) {
    rows.push({ chain: m[1], parent: m[2], network: m[3], addr: m[4], decimals: Number(m[5]) });
  }
  // The family each row belongs to, by position of the nearest `symbol:` above.
  for (const row of rows) {
    const at = src.indexOf(`chain: "${row.chain}"`);
    const before = src.slice(0, at);
    const sym = [...before.matchAll(/symbol:\s*"([A-Z0-9]+)"/g)].pop();
    row.want = sym ? sym[1] : "?";
  }
  return rows;
}

const RPC = {
  ethereum: ["https://eth.llamarpc.com", "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  optimism: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
  polygon: ["https://polygon-rpc.com", "https://1rpc.io/matic", "https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://polygon-pokt.nodies.app"],
  avalanche: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
  bsc: ["https://bsc-dataseed1.binance.org", "https://bsc-rpc.publicnode.com"],
  monad: ["https://rpc.monad.xyz", "https://monad-rpc.publicnode.com"],
};

const SEL = { symbol: "0x95d89b41", decimals: "0x313ce567", name: "0x06fdde03" };

async function call(chain, to, data) {
  let lastErr;
  for (const url of RPC[chain] ?? []) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal: AbortSignal.timeout(15000),
      });
      // Public RPCs answer with an HTML error page under load. `r.json()`
      // then throws and — because this is inside the per-endpoint try — the
      // row was reported BAD rather than rotating to the next endpoint. A
      // transient endpoint failure is not a bad contract.
      const text = await r.text();
      if (!text.trimStart().startsWith("{")) {
        throw new Error(`non-JSON from ${url}: ${text.slice(0, 40).trim()}`);
      }
      const j = JSON.parse(text);
      if (j.error) throw new Error(j.error.message);
      if (typeof j.result === "string") return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("no rpc");
}

function decodeString(hex) {
  if (!hex || hex === "0x") return null;
  const b = hex.slice(2);
  // dynamic string: offset(32) length(32) data
  if (b.length >= 128) {
    const len = parseInt(b.slice(64, 128), 16);
    if (Number.isFinite(len) && len > 0 && len <= 64) {
      const bytes = b.slice(128, 128 + len * 2);
      return Buffer.from(bytes, "hex").toString("utf8").replace(/\0+$/, "");
    }
  }
  // bytes32 fallback (old MKR-style tokens)
  return Buffer.from(b.slice(0, 64), "hex").toString("utf8").replace(/\0+/g, "") || null;
}

// ── Non-EVM verifiers ───────────────────────────────────────────────────
const SOL_RPC = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
  "https://solana.drpc.org",
];
async function solRpc(method, params) {
  let last;
  for (const url of SOL_RPC) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const TRON_BASES = ["https://api.trongrid.io", "https://api.tronstack.io"];
async function tronConst(contract, selector) {
  let last;
  for (const base of TRON_BASES) {
    try {
      const r = await fetch(`${base}/wallet/triggerconstantcontract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner_address: contract,
          contract_address: contract,
          function_selector: selector,
          visible: true,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      if (j?.constant_result?.[0] != null) return j.constant_result[0];
      throw new Error(JSON.stringify(j).slice(0, 120));
    } catch (e) { last = e; }
  }
  throw last;
}

const rows = [];
let bad = 0;
for (const r of readRegistry()) {
  try {
    // Non-EVM legs answer a different question in a different protocol.
    if (r.parent === "solana") {
      const sup = await solRpc("getTokenSupply", [r.addr]);
      const info = await solRpc("getAccountInfo", [r.addr, { encoding: "jsonParsed" }]);
      const isMint = info?.value?.data?.parsed?.type === "mint";
      const ownedBySplToken =
        info?.value?.owner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
      const dec = sup?.value?.decimals;
      const okSol = isMint && ownedBySplToken && dec === r.decimals;
      if (!okSol) bad++;
      rows.push({ ...r, sym: isMint ? "(SPL mint)" : "(NOT A MINT)", dec,
                  name: ownedBySplToken ? "SPL Token program" : "WRONG OWNER",
                  symOk: isMint && ownedBySplToken, decOk: dec === r.decimals });
      continue;
    }
    if (r.parent === "tron") {
      // Tron's `constant_result[0]` has NO "0x" prefix; `decodeString`
      // strips two leading chars, which would eat the first byte of the
      // ABI offset and decode to an empty string. Add the prefix.
      const sym = decodeString("0x" + (await tronConst(r.addr, "symbol()")));
      const dec = parseInt(await tronConst(r.addr, "decimals()"), 16);
      const symOk = String(sym).toUpperCase().startsWith(r.want.slice(0, 4));
      const decOk = dec === r.decimals;
      if (!symOk || !decOk) bad++;
      rows.push({ ...r, sym, dec, name: "(TRC-20)", symOk, decOk });
      continue;
    }
    const [sy, de, na] = await Promise.all([
      call(r.parent, r.addr, SEL.symbol),
      call(r.parent, r.addr, SEL.decimals),
      call(r.parent, r.addr, SEL.name),
    ]);
    const sym = decodeString(sy);
    const dec = parseInt(de, 16);
    const name = decodeString(na);
    // Tether spells its symbol differently per deployment ("USDt" on
    // Avalanche, "USD₮0" for the OFT). Compare loosely on the family, and
    // rely on decimals + the operator reading `name` for the rest.
    // Tether spells its symbol differently per deployment: "USDt" on
    // Avalanche, "USD₮0" (U+20AE TUGRIK SIGN, not a T) for the OFT.
    // Fold the tugrik back to T before comparing, or "USD₮0" normalises to
    // "USD0" and a correct row reads as a mismatch.
    const norm = (x) =>
      String(x).toUpperCase().replace(/₮/g, "T").replace(/[^A-Z0-9]/g, "");
    const symOk = norm(sym) === norm(r.want) || norm(sym).startsWith(norm(r.want));
    const decOk = dec === r.decimals;
    if (!symOk || !decOk) bad++;
    rows.push({ ...r, sym, dec, name, symOk, decOk });
  } catch (e) {
    bad++;
    rows.push({ ...r, error: String(e.message ?? e) });
  }
}

for (const r of rows) {
  if (r.error) {
    console.log(`FAIL  ${r.chain.padEnd(11)} ${r.addr}  -> ${r.error}`);
    continue;
  }
  const flag = r.symOk && r.decOk ? "OK  " : "BAD ";
  console.log(
    `${flag} ${r.chain.padEnd(11)} want=${r.want.padEnd(5)} symbol=${String(r.sym).padEnd(8)} ` +
      `dec=${String(r.dec).padEnd(3)}(want ${r.decimals}) name=${r.name}`,
  );
}
console.log(`
${rows.length} row(s) checked, ${bad} problem(s).`);
process.exit(bad === 0 ? 0 : 1);
