// scripts/bundleDefaultCoins.test.mjs
//
// A coin the supervisor enables BY DEFAULT must be bundled on EVERY target.
//
// The supervisor's `seedable_coins` (swap_sidecar.rs) drops any enabled coin
// whose `bin/<coin>/` directory is empty, and the per-coin toggle refuses with
// "no daemon binary is seeded" — so a default-enabled coin that the bundle
// does not ship on some platform does not fail there, it silently never
// happens there. That is what a Linux install looked like until 2026-09-11:
// `NOT_BUNDLED_FOR.linux` exempted zephyr and zano, both in
// `DEFAULT_ENABLED_COINS`, and the only trace was one line in the release log
// ("not on linux: zephyr, dogecoin, dash, zano") that a human had to read.
//
// The two facts live in two files (Rust owns the default set, the bundler owns
// the shipping set), so this test reads BOTH from source and refuses the
// combination, the same way the bundler's own v2 guard reads
// `WALLET_SIDECAR_COINS` rather than trusting its own tables.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_COINS, bundledCoinsFor, coinBinariesFor } from "./lib/bundle-coins.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUST = readFileSync(path.join(REPO, "src-tauri", "src", "swap_sidecar.rs"), "utf8");
// The target names bundledCoinsFor actually keys on. "win32" is NOT one of
// them: NOT_BUNDLED_FOR has no win32 entry, so bundledCoinsFor("win32")
// returned the FULL list and the windows case passed without testing windows.
// A test that cannot fail for its own target is worse than no test.
const TARGETS = ["windows", "linux"];

/** The string literals of a `pub const NAME: &[&str] = &[...]` in swap_sidecar.rs. */
function rustCoinList(name) {
  const m = RUST.match(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`${name} not found in swap_sidecar.rs — renamed? update this test, do not delete it`);
  const coins = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  // DEFAULT_ENABLED_COINS names particl through the MANDATORY_COIN identifier,
  // not a literal; a regex over literals would miss it.
  if (/\bMANDATORY_COIN\b/.test(m[1]) && !coins.includes("particl")) coins.unshift("particl");
  return coins;
}

const DEFAULT_ENABLED = rustCoinList("DEFAULT_ENABLED_COINS");

describe("default-enabled coins are bundled on every target", () => {
  it("reads a real default set out of swap_sidecar.rs", () => {
    expect(DEFAULT_ENABLED).toContain("particl");
    expect(DEFAULT_ENABLED).toContain("monero");
    expect(DEFAULT_ENABLED.length).toBeGreaterThanOrEqual(5);
  });

  for (const target of TARGETS) {
    it(`${target}: ships every DEFAULT_ENABLED coin`, () => {
      const shipped = bundledCoinsFor(target);
      const missing = DEFAULT_ENABLED.filter((c) => !shipped.includes(c));
      expect(
        missing,
        `default-enabled but not bundled on ${target}: [${missing.join(", ")}]. ` +
          `seedable_coins drops a coin with an empty bin/<coin>/, so on ${target} the ` +
          `default would silently never happen (2026-09-11: zephyr + zano on linux).`,
      ).toEqual([]);
    });
  }

  it("every bundled coin has a non-empty binary list on every target", () => {
    for (const target of TARGETS) {
      const lists = coinBinariesFor(target);
      for (const coin of bundledCoinsFor(target)) {
        expect(lists[coin]?.length, `${target}/${coin}`).toBeGreaterThan(0);
      }
    }
  });

  it("linux lists carry no Windows artefacts", () => {
    for (const [coin, files] of Object.entries(coinBinariesFor("linux"))) {
      for (const f of files) expect(f, `${coin}: ${f}`).not.toMatch(/\.(dll|exe)$/i);
    }
  });

  it("zano: the Windows build is dynamic (DLLs beside the exe), the Linux build is static", () => {
    expect(coinBinariesFor("win32").zano).toEqual(
      expect.arrayContaining(["zanod", "simplewallet", "libcrypto-3-x64.dll", "libssl-3-x64.dll"]),
    );
    expect(coinBinariesFor("linux").zano).toEqual(["zanod", "simplewallet"]);
  });

  it("the remaining linux gap is exactly the two opt-in full-chain coins", () => {
    // Documented state, not a target: dogecoin and dash have no lean mode, so
    // they are never default-enabled and their absence costs an opt-in. When
    // their Linux pins land, this list shrinks and the test is updated with it.
    const gap = BUNDLED_COINS.filter((c) => !bundledCoinsFor("linux").includes(c)).sort();
    expect(gap).toEqual(["dash", "dogecoin"]);
    for (const c of gap) expect(DEFAULT_ENABLED).not.toContain(c);
  });
});
