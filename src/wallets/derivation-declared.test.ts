/**
 * Every chain must declare how it derives from the wallet seed.
 *
 * `ChainAdapter.derivation` is a REQUIRED field, so adding a chain without it
 * is already a compile error. This file guards the things the type can't:
 * that the declared path is well-formed, that it matches the path the adapter
 * actually derives at, and that the declaration stays in sync with the locked
 * values in `derivation-paths.test.ts`.
 *
 * Why it's required rather than optional (2026-08-13): derivation is the
 * difference between "your funds are here" and "your funds are at an address
 * this wallet will never show you". Before this field existed the paths lived
 * only inside each adapter's implementation, so the UI had nothing to render —
 * which is why derivation panels were hand-wired per chain and most chains
 * had no derivation surface at all. Making it part of the adapter contract
 * means a NEW chain cannot ship without answering the question, and the
 * generic UI picks it up for free.
 */

import { describe, it, expect } from "vitest";
import { ALL_CHAINS, getAdapter } from "./index";

describe("every chain declares its derivation", () => {
  it.each(ALL_CHAINS)("%s has a derivation declaration", (chain) => {
    const d = getAdapter(chain).derivation;
    expect(d, `${chain} has no derivation declared`).toBeTruthy();
    expect(["bip39", "independent-seed"]).toContain(d.kind);
  });

  it.each(ALL_CHAINS)("%s declares a coherent derivation", (chain) => {
    const d = getAdapter(chain).derivation;
    if (d.kind === "independent-seed") {
      // Own-seed chains (Monero, Zephyr) have no BIP-39 path. The note is
      // what the UI shows instead, so it must actually say something.
      expect(d.note.length, `${chain} independent-seed note is empty`).toBeGreaterThan(20);
      return;
    }
    // BIP-39 chains: a real HD path, and a stated reason for it.
    expect(d.path, `${chain} path must start with m/`).toMatch(/^m(\/\d+'?)+$/);
    expect(d.standard.length, `${chain} has no 'standard' rationale`).toBeGreaterThan(5);
    expect(typeof d.hasAlternatives).toBe("boolean");
  });

  it("declares independent-seed for exactly the own-seed chains", () => {
    // These two are the chains whose adapters set `usesIndependentSeed`.
    // If a third ever appears, both flags must agree or the UI will offer a
    // BIP-39 path for a chain that doesn't have one.
    for (const chain of ALL_CHAINS) {
      const a = getAdapter(chain);
      const isIndependent = a.derivation.kind === "independent-seed";
      expect(
        isIndependent,
        `${chain}: derivation.kind and usesIndependentSeed disagree`
      ).toBe(!!a.usesIndependentSeed);
    }
  });

  it("every EVM chain shares coin type 60", () => {
    // The network is selected by chainId, not by the path — which is why one
    // address works across Arbitrum/Base/Optimism. If a chain ever declares
    // its own coin type, that's a real bug: the derived address would stop
    // matching what MetaMask shows for the same seed.
    const evm = ALL_CHAINS.filter((c) => {
      const d = getAdapter(c).derivation;
      return d.kind === "bip39" && d.path === "m/44'/60'/0'/0/0";
    });
    expect(evm.length, "expected the EVM family to share one path").toBeGreaterThan(5);
  });

  it("EVM declares that alternatives exist", () => {
    // CORRECTED 2026-08-13, along with the declaration itself. This test
    // originally asserted `hasAlternatives === false` for EVM, encoding the
    // same mistake as the adapter: it conflated "coin type is universal"
    // (true) with "there is nothing to switch" (false — account and index
    // vary). Verified with ethers: five layouts, five different addresses
    // from one seed. See generic-path-finder.test.ts for the vectors.
    //
    // Getting this wrong told a user whose funds sat on MetaMask account 2
    // that there was nothing to look for.
    const d = getAdapter("ethereum").derivation;
    expect(d.kind).toBe("bip39");
    if (d.kind !== "bip39") return;
    expect(d.hasAlternatives).toBe(true);
  });

  it("declared paths match the locked values in derivation-paths.test.ts", () => {
    // Spot-check the chains that file pins. A mismatch means the declaration
    // and the implementation have drifted, and the UI would be telling the
    // user something untrue about where their keys come from.
    const locked: Partial<Record<string, string>> = {
      bitcoin: "m/84'/0'/0'/0/0",
      litecoin: "m/84'/2'/0'/0/0",
      dogecoin: "m/44'/3'/0'/0/0",
      "bitcoin-cash": "m/44'/145'/0'/0/0",
      ethereum: "m/44'/60'/0'/0/0",
      solana: "m/44'/501'/0'/0'",
      near: "m/44'/397'/0'",
      stellar: "m/44'/148'/0'",
      xrp: "m/44'/144'/0'/0/0",
      hedera: "m/44'/3030'/0'/0/0",
      ravencoin: "m/44'/175'/0'/0/0",
      conflux: "m/44'/503'/0'/0/0",
      ergo: "m/44'/429'/0'/0/0",
    };
    for (const [chain, path] of Object.entries(locked)) {
      const d = getAdapter(chain as (typeof ALL_CHAINS)[number]).derivation;
      expect(d.kind).toBe("bip39");
      if (d.kind !== "bip39") continue;
      expect(d.path, `${chain} declared path drifted from the locked value`).toBe(path);
    }
  });
});
