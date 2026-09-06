/**
 * PROFILE (not a gate) — where the unlock path actually spends its time.
 *
 * Run explicitly:
 *   npx vitest run src/wallets/unlock-path.profile.test.ts --reporter=basic
 *
 * It asserts almost nothing, on purpose: wall-clock thresholds on a dev
 * machine are the definition of a flaky test, and a "performance test" that
 * goes red on a busy laptop gets skipped and then deleted. It measures and
 * prints. The numbers belong in `log.md`, not in an assertion.
 *
 * ## What it measures and why that is the right thing
 *
 * `useVault.deriveAllChains` is a SYNCHRONOUS for-loop over `ALL_CHAINS`
 * calling `adapter.deriveFromMnemonic(mnemonic)` once per chain. It runs on
 * the main thread during unlock, so every millisecond here is a frozen UI —
 * unlike balance fetching, which is async and merely makes numbers appear
 * late. That makes it the first thing to measure, and the cheapest to get
 * wrong: each adapter receives the MNEMONIC, not a seed, so any adapter that
 * calls `mnemonicToSeedSync` itself pays PBKDF2-HMAC-SHA512 × 2048 rounds
 * again, for a seed every other adapter has already computed.
 */
import { describe, it } from "vitest";

import { getAdapter, ALL_CHAINS } from "./index";
import { mnemonicToSeedSync } from "@scure/bip39";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function ms(fn: () => void, runs = 1): number {
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  return (performance.now() - t0) / runs;
}

describe("unlock path profile", () => {
  it("measures per-chain derivation cost", () => {
    // Warm the JIT and any module-level lazy init so the first chain measured
    // is not charged for everyone else's setup.
    try {
      getAdapter("bitcoin").deriveFromMnemonic(MNEMONIC);
    } catch {
      /* ignore */
    }

    const seedMs = ms(() => void mnemonicToSeedSync(MNEMONIC, ""), 5);

    const rows: Array<{ chain: string; ms: number }> = [];
    let independent = 0;
    let failed = 0;

    for (const chain of ALL_CHAINS) {
      let adapter;
      try {
        adapter = getAdapter(chain);
      } catch {
        failed++;
        continue;
      }
      if (adapter.usesIndependentSeed) {
        independent++;
        continue;
      }
      try {
        rows.push({ chain, ms: ms(() => void adapter.deriveFromMnemonic(MNEMONIC)) });
      } catch {
        failed++;
      }
    }

    rows.sort((a, b) => b.ms - a.ms);
    const total = rows.reduce((n, r) => n + r.ms, 0);

    const out: string[] = [];
    out.push("");
    out.push("=".repeat(64));
    out.push(`UNLOCK PATH PROFILE — deriveAllChains over ${ALL_CHAINS.length} chains`);
    out.push("=".repeat(64));
    out.push(`  mnemonicToSeedSync (one call) : ${seedMs.toFixed(1)} ms`);
    out.push(`  chains derived               : ${rows.length}`);
    out.push(`  skipped (independent seed)   : ${independent}`);
    out.push(`  skipped (error)              : ${failed}`);
    out.push(`  TOTAL synchronous derive     : ${total.toFixed(0)} ms  <-- blocks the UI`);
    out.push("");
    out.push("  slowest 15 chains:");
    for (const r of rows.slice(0, 15)) {
      const share = total > 0 ? (r.ms / total) * 100 : 0;
      const bar = "#".repeat(Math.max(1, Math.round(share / 2)));
      out.push(
        `    ${r.chain.padEnd(18)} ${r.ms.toFixed(1).padStart(7)} ms  ${share
          .toFixed(1)
          .padStart(4)}%  ${bar}`,
      );
    }
    out.push("");
    // Seed re-derivation. NOTE the naive projection is WRONG and is kept here
    // only as the thing the A/B corrected: rows x seedMs suggested ~85% of the
    // total, while actually memoizing the seed
    // (`unlock-path-memoized.profile.test.ts`) moved 292 ms -> 203 ms, i.e. ~30%.
    // A cold single-call timing does not survive multiplication across a warm
    // loop. Measure the fix; never multiply out the projection.
    out.push(
      `  22 files call mnemonicToSeedSync with no shared cache. Naive projection:` ,
    );
    out.push(
      `  ${rows.length} x ${seedMs.toFixed(1)} ms = ${(rows.length * seedMs).toFixed(0)} ms. ` +
        `MEASURED saving from memoizing it: ~30%, not that.`,
    );

    // Duplicate derivations: many chains resolve to the SAME address (every EVM
    // chain shares one secp256k1 key), and each one pays for it separately.
    const byAddress = new Map<string, string[]>();
    for (const r of rows) {
      let addr: string | undefined;
      try {
        addr = getAdapter(r.chain as never).deriveFromMnemonic(MNEMONIC)?.address;
      } catch {
        continue;
      }
      if (!addr) continue;
      byAddress.set(addr, [...(byAddress.get(addr) ?? []), r.chain]);
    }
    const dupes = [...byAddress.entries()].filter(([, cs]) => cs.length > 1);
    const dupeCost = dupes.reduce(
      (n, [, cs]) =>
        n +
        cs
          .slice(1) // the first derivation is real work; the rest are repeats
          .reduce((m, c) => m + (rows.find((r) => r.chain === c)?.ms ?? 0), 0),
      0,
    );
    out.push("");
    out.push(
      `  DUPLICATE derivations: ${dupes.length} address(es) are derived by more than`,
    );
    out.push(
      `  one chain. Redundant cost: ${dupeCost.toFixed(0)} ms ` +
        `(${total > 0 ? ((dupeCost / total) * 100).toFixed(0) : "?"}% of the total).`,
    );
    for (const [addr, cs] of dupes.sort((a, b) => b[1].length - a[1].length).slice(0, 3)) {
      out.push(`    ${cs.length.toString().padStart(2)} chains -> ${addr.slice(0, 14)}...  ${cs.slice(0, 6).join(", ")}${cs.length > 6 ? ", ..." : ""}`);
    }
    out.push("=".repeat(64));

    // process.stdout, not console.log — vitest swallows console in this repo's
    // config, which is how an earlier profiling attempt produced no output at
    // all and read as "the code did not run".
    process.stdout.write(out.join("\n") + "\n");
  });
});
