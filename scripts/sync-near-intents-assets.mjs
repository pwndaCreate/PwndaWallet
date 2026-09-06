#!/usr/bin/env node
// Regenerate src/features/swap/near-intents-assets.generated.ts from the
// live `/api/intents/tokens` response.
//
// Usage:
//   node scripts/sync-near-intents-assets.mjs                       (writes to default path)
//   node scripts/sync-near-intents-assets.mjs --proxy-url <url>     (override proxy URL)
//   node scripts/sync-near-intents-assets.mjs --out <path>          (override output path)
//   node scripts/sync-near-intents-assets.mjs --dry                 (print to stdout, do not write)
//   node scripts/sync-near-intents-assets.mjs --check               (drift report, writes nothing, exit 1 on drift)
//
// Prefer the npm aliases: `npm run sync-intents-assets` / `npm run check-intents-assets`.
//
// SCOPE: this script writes UPSTREAM FACTS ONLY. Wallet signing capability
// (SOURCE_CAPABLE_BLOCKCHAINS) is hand-owned in
// src/features/swap/intents-source-capability.ts and must never be emitted
// here again — see the note further down for the incident that established this.
//
// Why this is a script and not a Tauri command: the proxy URL ships in
// the user's env (`PWNDA_PROXY_URL` / `VITE_PROXY_URL`), so a developer
// can run this from their machine to refresh the generated map without
// running the full Tauri shell. The proxy endpoint is unauthenticated
// at the GET-tokens layer (it does require X-Client-Sig, but only the
// signed paths — the dev's local proxy reaches the upstream directly).
//
// The generated file is checked in. Run this manually when 1Click adds
// new tokens; CI does not auto-run it.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function arg(flag, fallback) {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1] != null) return args[i + 1];
  return fallback;
}

const PROXY_URL = arg(
  "--proxy-url",
  process.env.PWNDA_PROXY_URL ||
    process.env.VITE_PROXY_URL ||
    "https://wallet.pwnda.org"
);
const OUT_PATH = arg(
  "--out",
  resolve(process.cwd(), "src/features/swap/near-intents-assets.generated.ts")
);
const DRY = args.includes("--dry");
// --check: drift report only, never writes. Exits 1 when upstream has moved.
const CHECK = args.includes("--check");

// ─── Fetch ────────────────────────────────────────────────────────

const url = `${PROXY_URL.replace(/\/$/, "")}/api/intents/tokens`;
process.stderr.write(`fetching ${url}\n`);

const resp = await fetch(url, {
  headers: { accept: "application/json" },
});
if (!resp.ok) {
  process.stderr.write(`HTTP ${resp.status} from ${url}\n`);
  process.stderr.write(`Body: ${(await resp.text()).slice(0, 500)}\n`);
  process.exit(1);
}
const json = await resp.json();
const rawTokens = Array.isArray(json) ? json : json.tokens ?? json.data ?? [];
if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
  process.stderr.write(`unexpected response shape — see sample: ${JSON.stringify(json).slice(0, 500)}\n`);
  process.exit(1);
}

// ─── Normalize ────────────────────────────────────────────────────

/**
 * The proxy's tokens response is the raw 1Click shape. Tolerant of
 * field-name drift: any of `assetId` / `defuseAssetId` / `id` is the
 * NEP-141 id; any of `blockchain` / `chain` / `network` is the chain
 * tag; etc. Anything missing critical fields is filtered out.
 */
// Blockchains we keep from the 1Click catalog.
//
// The rule: keep a chain if THE WALLET CAN HOLD IT. Anything else is noise the
// UI could never offer a source address for.
//
// 2026-08-19 — this list silently cost users eight chains. It stopped at the
// EVM set + a few majors, so `normalize()` dropped every row on cardano, ltc,
// bch, dash, stellar, sui, monad and bsc even though the wallet holds all of
// them and 1Click routes all of them. The symptom was invisible: no error, the
// rows just never reached the generated catalog, so the swap UI offered no
// path for assets the user was holding. `swap-data.ts` had ALREADY been written
// against those chains (it switches on "ltc", "cardano", "sui"…), which is how
// the gap surfaced — regenerating narrowed the emitted union and broke the
// build that had been compiling against a wider, hand-maintained one.
//
// Note "bsc": the feed labels BNB Smart Chain `bsc`, while this codebase's
// IntentsBlockchain calls it `bnb` (EVM_CHAIN_IDS, BLOCKCHAIN_DISPLAY_NAME).
// Aliased below rather than renamed, so the generated union stays stable.
const SUPPORTED_BLOCKCHAINS = new Set([
  // EVM
  "eth",
  "arb",
  "base",
  "op",
  "pol",
  "avax",
  "bnb",
  "monad",
  // UTXO / bitcoin-family
  "btc",
  "ltc",
  "bch",
  "doge",
  "dash",
  // other L1s the wallet holds
  "sol",
  "near",
  "xrp",
  "tron",
  "ton",
  "cardano",
  "stellar",
  "sui",
]);

function normalize(row) {
  const assetId = row.assetId ?? row.defuseAssetId ?? row.id;
  const symbol = row.symbol ?? row.ticker ?? row.assetName;
  const decimals = Number(row.decimals ?? row.assetDecimals ?? 0);
  let blockchain = (row.blockchain ?? row.chain ?? row.network ?? "")
    .toString()
    .toLowerCase();
  // Some upstreams report "ethereum" / "polygon" — collapse to short form.
  const aliases = {
    ethereum: "eth",
    arbitrum: "arb",
    optimism: "op",
    polygon: "pol",
    avalanche: "avax",
    "bnb-chain": "bnb",
    // 1Click labels BNB Smart Chain "bsc"; our IntentsBlockchain calls it
    // "bnb". Without this alias every BSC row failed the allow-list check and
    // was dropped (2026-08-19).
    bsc: "bnb",
    bitcoin: "btc",
    solana: "sol",
    dogecoin: "doge",
    ripple: "xrp",
    "ton-chain": "ton",
  };
  if (aliases[blockchain]) blockchain = aliases[blockchain];
  const contractAddress = row.contractAddress ?? row.contract ?? undefined;
  if (!assetId || !symbol || !decimals || !SUPPORTED_BLOCKCHAINS.has(blockchain)) {
    return null;
  }
  return {
    assetId,
    symbol: String(symbol).toUpperCase(),
    displayName: row.displayName ?? row.name ?? `${symbol} (${blockchain})`,
    decimals,
    blockchain,
    ...(contractAddress ? { contractAddress } : {}),
  };
}

const normalized = rawTokens.map(normalize).filter(Boolean);
process.stderr.write(`normalized ${normalized.length} of ${rawTokens.length} rows\n`);

// Sort: native assets first (no contractAddress), then by symbol, then by chain.
const NATIVE_ORDER = [
  "ETH",
  "BTC",
  "SOL",
  "NEAR",
  "POL",
  "AVAX",
  "BNB",
  "DOGE",
  "XRP",
  "TRX",
  "TON",
];
normalized.sort((a, b) => {
  const aNative = !a.contractAddress;
  const bNative = !b.contractAddress;
  if (aNative !== bNative) return aNative ? -1 : 1;
  if (aNative && bNative) {
    const ai = NATIVE_ORDER.indexOf(a.symbol);
    const bi = NATIVE_ORDER.indexOf(b.symbol);
    if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  }
  if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
  return a.blockchain.localeCompare(b.blockchain);
});

// ─── Render ───────────────────────────────────────────────────────

const HEADER = `// UPSTREAM FACTS ONLY — safe to regenerate wholesale.
//
//   npm run sync-intents-assets          # rewrite this file from the live feed
//   npm run check-intents-assets         # report drift, change nothing (CI)
//
// Source: GET /api/intents/tokens (via the user-controlled wallet-proxy).
// Last sync: ${new Date().toISOString()}.
//
// Everything here is something only the upstream 1Click catalog can answer:
// which assets exist, on which chain, with what id and decimals.
//
// WALLET capability — which chains we can actually SIGN A DEPOSIT FROM — is
// NOT in this file. It lives in the hand-owned
// src/features/swap/intents-source-capability.ts and is never generated.
// That split is load-bearing: this file once carried both under a DO-NOT-EDIT
// header while being the only correct copy of the wallet-side set, so a
// routine regeneration on 2026-08-19 silently downgraded it and broke four
// tests. Regeneration is now mechanically safe.
`;

const TYPES_AND_TAIL = `
export type IntentsBlockchain =
  | "eth"
  | "arb"
  | "base"
  | "op"
  | "pol"
  | "avax"
  | "bnb"
  | "monad"
  | "btc"
  | "ltc"
  | "bch"
  | "doge"
  | "dash"
  | "sol"
  | "near"
  | "xrp"
  | "tron"
  | "ton"
  | "cardano"
  | "stellar"
  | "sui";

export interface IntentsAsset {
  assetId: string;
  symbol: string;
  displayName: string;
  decimals: number;
  blockchain: IntentsBlockchain;
  contractAddress?: string;
}

/**
 * NOTE — SOURCE_CAPABLE_BLOCKCHAINS is deliberately NOT emitted here.
 *
 * It encodes WALLET capability (which chains we can sign a deposit tx for),
 * which no upstream feed knows. It used to be emitted by this script with a
 * hardcoded 10-chain list, so running the documented regenerate command
 * silently downgraded the shipped set (2026-08-19: dropped ltc/bch/monad/dash/
 * stellar/sui/cardano, broke four tests). It now lives in the hand-owned
 * src/features/swap/intents-source-capability.ts and this script must never
 * write it again.
 */

export const EVM_CHAIN_IDS: Partial<Record<IntentsBlockchain, number>> = {
  eth: 1,
  arb: 42161,
  base: 8453,
  op: 10,
  pol: 137,
  avax: 43114,
  bnb: 56,
};

export const BLOCKCHAIN_DISPLAY_NAME: Record<IntentsBlockchain, string> = {
  eth: "Ethereum",
  arb: "Arbitrum",
  base: "Base",
  op: "Optimism",
  pol: "Polygon",
  avax: "Avalanche",
  bnb: "BNB Chain",
  btc: "Bitcoin",
  sol: "Solana",
  near: "NEAR",
  doge: "Dogecoin",
  xrp: "XRP",
  tron: "TRON",
  ton: "TON",
  // Added 2026-08-19 with the eight chains the allow-list had been dropping.
  // This is a TOTAL Record, so every member of the union must appear here or
  // the generated file will not compile — which is the intended tripwire.
  monad: "Monad",
  ltc: "Litecoin",
  bch: "Bitcoin Cash",
  dash: "Dash",
  cardano: "Cardano",
  stellar: "Stellar",
  sui: "Sui",
};
`;

function renderRow(r) {
  const lines = [
    "  {",
    `    assetId: ${JSON.stringify(r.assetId)},`,
    `    symbol: ${JSON.stringify(r.symbol)},`,
    `    displayName: ${JSON.stringify(r.displayName)},`,
    `    decimals: ${r.decimals},`,
    `    blockchain: ${JSON.stringify(r.blockchain)},`,
  ];
  if (r.contractAddress) {
    lines.push(`    contractAddress: ${JSON.stringify(r.contractAddress)},`);
  }
  lines.push("  },");
  return lines.join("\n");
}

const body = normalized.map(renderRow).join("\n");
const out = `${HEADER}
export const NEAR_INTENTS_ASSETS: readonly IntentsAsset[] = [
${body}
];
${TYPES_AND_TAIL}`;

// --check: report drift, write nothing, exit non-zero if the shipped catalog
// no longer matches upstream. This is the CI mode — it is what keeps the
// wallet's swappable assets current WITHOUT a human hunting for asset ids, and
// without letting an upstream change silently alter what the wallet offers.
if (CHECK) {
  // Drift report. Writes nothing; exits 1 only when there is something to act on.
  //
  // The shipped catalog is a deliberate SUBSET of upstream, not a stale mirror:
  // 1Click lists a long tail of memecoins and bridged tokens the wallet has no
  // reason to carry. A raw set-difference is therefore useless — the first
  // version of this check reported 95 "additions", none of them actionable.
  //
  // What IS actionable is scoped to the wallet:
  //   REMOVED — an asset we ship that upstream dropped. The wallet would offer
  //             a swap that now fails. Always a problem.
  //   MISSING — an asset upstream carries whose SYMBOL the wallet already
  //             holds. That is a swap we could offer and currently do not
  //             (the "do not leave supported assets out" case).
  // Everything else upstream adds is counted, not listed.
  const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : "";
  const rowsOf = (src) => {
    const m = new Map();
    const re = /assetId:\s*"([^"]+)"[\s\S]{0,200}?symbol:\s*"([^"]+)"/g;
    for (const hit of src.matchAll(re)) m.set(hit[1], hit[2].toUpperCase());
    return m;
  };
  const have = rowsOf(current);
  const want = rowsOf(out);

  // The wallet's own asset list is READ from the capability registry, never
  // duplicated here — duplicating it would just create a third list to drift.
  let walletSymbols = new Set();
  try {
    const caps = readFileSync(
      resolve(process.cwd(), "src/features/swap/asset-capabilities.ts"),
      "utf8"
    );
    const keyRe = /^ {2}([A-Z0-9]{2,10}):\s*\{/gm;
    walletSymbols = new Set([...caps.matchAll(keyRe)].map((x) => x[1]));
  } catch {
    process.stderr.write(
      "warning: could not read asset-capabilities.ts; listing all additions\n"
    );
  }

  const removed = [...have].filter(([id]) => !want.has(id));
  const addedAll = [...want].filter(([id]) => !have.has(id));
  const addedRelevant = walletSymbols.size
    ? addedAll.filter((entry) => walletSymbols.has(entry[1]))
    : addedAll;
  const noise = addedAll.length - addedRelevant.length;

  const lines = [];
  lines.push(
    `intents catalog: shipped ${have.size}, upstream ${want.size}` +
      (walletSymbols.size ? `, wallet symbols ${walletSymbols.size}` : "")
  );

  if (removed.length) {
    lines.push("");
    lines.push(
      `REMOVED UPSTREAM ${removed.length} — shipped by us, no longer offered by 1Click.`
    );
    lines.push("The wallet may present a swap that FAILS:");
    for (const [id, sym] of removed) lines.push(`  - ${sym}  ${id}`);
  }
  if (addedRelevant.length) {
    lines.push("");
    lines.push(
      `MISSING ${addedRelevant.length} — the wallet holds these symbols and 1Click routes them,`
    );
    lines.push("but the shipped catalog has no entry, so there is no swap path:");
    for (const [id, sym] of addedRelevant) lines.push(`  + ${sym}  ${id}`);
  }
  if (noise) {
    lines.push("");
    lines.push(
      `(${noise} other upstream assets ignored — symbols the wallet does not hold.)`
    );
  }

  if (!removed.length && !addedRelevant.length) {
    lines.push("");
    lines.push("in sync — nothing actionable.");
    process.exitCode = 0;
  } else {
    lines.push("");
    lines.push(
      "run `npm run sync-intents-assets` to adopt upstream, then review the diff."
    );
    lines.push(
      "Wallet SIGNING capability is unaffected by that command — it lives in"
    );
    lines.push(
      "src/features/swap/intents-source-capability.ts and is never generated."
    );
    // exitCode, not exit(): calling process.exit() while the fetch handle is
    // still closing trips a libuv assertion on Windows (UV_HANDLE_CLOSING).
    process.exitCode = 1;
  }
  process.stdout.write(lines.join("\n") + "\n");
} else if (DRY) {
  process.stdout.write(out);
} else {
  writeFileSync(OUT_PATH, out, "utf8");
  process.stderr.write(`wrote ${OUT_PATH} (${out.length} bytes)\n`);
}
