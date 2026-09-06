/**
 * Resolve sha256 pins for the LINUX Grove runtime inputs.
 *
 * A pin you did not compute from the bytes is not a pin. This downloads each
 * candidate artifact once, hashes it, and prints a table to paste into
 * `fetch-swap-runtime.mjs`. Re-run it when a Linux pin moves.
 *
 * It is deliberately separate from fetch-swap-runtime.mjs: that script VERIFIES
 * against declared hashes and must never be the thing that invents them.
 *
 *   node scripts/resolve-linux-runtime-pins.mjs [--cache=DIR]
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, statSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argVal = (f, d) => {
  const a = process.argv.find((x) => x.startsWith(`${f}=`));
  return a ? a.slice(f.length + 1) : d;
};
const CACHE = resolve(argVal("--cache", join(ROOT, ".cache", "linux-runtime-resolve")));
const LOG = "[linux-pins]";

const ARTIFACTS = [
  {
    key: "cpython",
    file: "cpython-3.12.14+20260825-x86_64-unknown-linux-gnu-install_only.tar.gz",
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260825/cpython-3.12.14%2B20260825-x86_64-unknown-linux-gnu-install_only.tar.gz",
  },
  {
    key: "particl-core",
    file: "particl-27.2.4.0-x86_64-linux-gnu.tar.gz",
    url: "https://github.com/tecnovert/particl-core/releases/download/v27.2.4.0/particl-27.2.4.0-x86_64-linux-gnu.tar.gz",
  },
  {
    key: "litecoin-core",
    file: "litecoin-0.21.5.6-x86_64-linux-gnu.tar.gz",
    url: "https://download.litecoin.org/litecoin-0.21.5.6/linux/litecoin-0.21.5.6-x86_64-linux-gnu.tar.gz",
  },
  {
    key: "monero-cli",
    file: "monero-linux-x64-v0.18.5.1.tar.bz2",
    url: "https://downloads.getmonero.org/cli/monero-linux-x64-v0.18.5.1.tar.bz2",
  },
  // Added 2026-09-02 (Grove expansion unit A2). Same URL as
  // fetch-swap-runtime.mjs's COIN_CORES "zephyr" linux entry and
  // Get-SwapCoinBinaries.ps1's $CATALOG.zephyr.linux — re-running this
  // resolver should reproduce the pin already recorded in both.
  {
    key: "zephyr-cli-linux",
    file: "zephyr-cli-linux-v2.3.0.zip",
    url: "https://github.com/ZephyrProtocol/zephyr/releases/download/v2.3.0/zephyr-cli-linux-v2.3.0.zip",
  },
  // Fulcrum is a harness-only regtest dependency (BCH electrum-mode
  // supervisor, unit A3), not part of the shipped runtime image — included
  // here anyway because it is a plain downloadable release artifact like
  // everything else in this file, and Get-SwapCoinBinaries.ps1's
  // $CATALOG.fulcrum.linux pin should stay reproducible the same way.
  {
    key: "fulcrum-linux",
    file: "Fulcrum-2.1.2-x86_64-linux.tar.gz",
    url: "https://github.com/cculianu/Fulcrum/releases/download/v2.1.2/Fulcrum-2.1.2-x86_64-linux.tar.gz",
  },
  // Zano is deliberately NOT here. There is no stock release to resolve a
  // pin from — the wallet needs unit A5's patched simplewallet build
  // (scripts/swap/zano-build/), not a downloadable artifact this resolver
  // could hash. See fetch-swap-runtime.mjs's ZANO_CORE_PLACEHOLDER and
  // Get-SwapCoinBinaries.ps1's $CATALOG.zano for the two TODO(A5) slots.
];

async function sha256(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

mkdirSync(CACHE, { recursive: true });
const out = [];
for (const a of ARTIFACTS) {
  const dest = join(CACHE, a.file);
  if (!existsSync(dest)) {
    process.stdout.write(`${LOG} downloading ${a.file} ... `);
    const r = await fetch(a.url, { redirect: "follow" });
    if (!r.ok) {
      console.log(`HTTP ${r.status}`);
      out.push({ ...a, sha256: null, error: `HTTP ${r.status}` });
      continue;
    }
    await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
    console.log(`${(statSync(dest).size / 1e6).toFixed(1)} MB`);
  } else {
    console.log(`${LOG} cached ${a.file} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
  }
  const hash = await sha256(dest);
  out.push({ ...a, sha256: hash, bytes: statSync(dest).size });
}

console.log(`\n${LOG} ── pin table ──`);
for (const a of out) {
  console.log(`  ${a.key}`);
  console.log(`    file   ${a.file}`);
  console.log(`    sha256 ${a.sha256 ?? "FAILED: " + a.error}`);
  if (a.bytes) console.log(`    bytes  ${a.bytes}`);
}
const failed = out.filter((a) => !a.sha256).length;
console.log(`\n${LOG} ${out.length - failed}/${out.length} resolved`);
process.exit(failed ? 1 : 0);
