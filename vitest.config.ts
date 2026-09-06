import { defineConfig } from "vitest/config";

/**
 * Vitest config — kept lean so unit tests don't pull in the production
 * Vite plugins (wasm, node-polyfills, top-level-await, react). Tests
 * mock the I/O boundary modules and exercise the swap-execute logic
 * directly; the heavier wallet adapters never load.
 *
 * Scope is limited to the swap module today. Add globs as more tests
 * land.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/*.test.ts",
      // App-level state: the account-key input map lives here, and its
      // test is the guard against a coin the deriver knows that no call
      // site feeds (the BCH `NaN` of 2026-09-05).
      "src/state/**/*.test.ts",
      "src/api/**/*.test.ts",
      "src/features/swap/**/*.test.ts",
      "src/features/swap-sidecar/**/*.test.ts",
      "src/features/onboarding/**/*.test.ts",
      "src/features/activity/**/*.test.ts",
      "src/features/mining/**/*.test.ts",
      "src/features/vault/**/*.test.ts",
      "src/features/wallet/**/*.test.ts",
      // settings + monero were absent until 2026-08-19. They host the Settings
      // DEX-coins mount and the swap node's Monero-wallet mount, and a test
      // written under a folder no glob reaches is a test that cannot fail —
      // vitest reports "No test files found" and exits 1 only when the file is
      // named explicitly, so a full `npm run test` stayed green with the file
      // never loaded.
      "src/features/settings/**/*.test.ts",
      "src/features/monero/**/*.test.ts",
      // send was absent until 2026-08-25 — the SECOND recurrence of the trap
      // described just above, found the same way (a new test file reported
      // "No test files found" only because it was named explicitly). Two
      // recurrences is a pattern, so `checkGlobCoverage` below now fails the
      // suite when any test file on disk is unreachable, rather than leaving
      // it to be rediscovered a third time.
      "src/features/send/**/*.test.ts",
      // zephyr added 2026-08-29 with the conversion-topology tests. Third
      // time this glob list has been the thing standing between a test and
      // ever running — but the FIRST time it was caught automatically:
      // `testGlobCoverage.test.ts` (added after the second recurrence) named
      // the unreachable file in its failure message before the file had ever
      // been run. The guard worked exactly as intended.
      "src/features/zephyr/**/*.test.ts",
      "src/wallets/**/*.test.ts",
      // src/lib holds the pure helpers any feature may import (CLAUDE.md's
      // layout note). bip85.ts lives there and is fund-critical — a wrong
      // derivation yields a VALID mnemonic for the wrong wallet, so its spec
      // vectors must run in CI, not just locally.
      "src/lib/**/*.test.ts",
    ],
    // Keep tests serial — they don't share state but the project is
    // small enough that the parallel-pool overhead isn't worth it.
    pool: "threads",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
