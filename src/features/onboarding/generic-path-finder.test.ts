/**
 * Chain-agnostic derivation tools.
 *
 * The addresses asserted below were produced independently with ethers before
 * this module existed, so they're a real fixture rather than a snapshot of
 * whatever the code happens to do.
 *
 * They also document why the EVM family needed this. `hasAlternatives` was
 * originally declared `false` for every EVM chain on the reasoning that "coin
 * type 60 is universal, so there's nothing to switch". Half true: the coin
 * type IS universal (which is why Arbitrum/Base/Optimism share an address),
 * but account and index are not. Five layouts, five different addresses from
 * one seed — so a user whose funds live on MetaMask account 2 or Ledger Live
 * imported and saw an empty wallet, with the UI telling them there was
 * nothing to look for.
 */

import { describe, it, expect, vi } from "vitest";
import {
  candidatePathsFor,
  findPathForAddress,
  supportsPathSearch,
  findFundedPaths,
} from "./generic-path-finder";
import { ALL_CHAINS, getAdapter } from "../../wallets";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Verified with ethers directly, 2026-08-13. */
const EVM_VECTORS = {
  "m/44'/60'/0'/0/0": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", // MetaMask acct 1
  "m/44'/60'/0'/0/1": "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0", // MetaMask acct 2
  "m/44'/60'/0'/0/2": "0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A", // MetaMask acct 3
  "m/44'/60'/1'/0/0": "0x78839F6054d7ed13918bAe0473BA31b1Ca9D7265", // Ledger Live acct 2
  "m/44'/60'/0'/1": "0x94381955F4028159A477a107510618aDb6B79Eb7", // MEW legacy
};

describe("deriveAtPath — EVM layouts really do differ", () => {
  it.each(Object.entries(EVM_VECTORS))(
    "%s derives the expected address",
    (path, expected) => {
      const w = getAdapter("ethereum").deriveAtPath!(MNEMONIC, path);
      expect(w.address).toBe(expected);
    }
  );

  it("every EVM chain derives the SAME address for a given path", () => {
    // Coin type 60 is shared; the network is chosen by chainId. This is the
    // half of the original reasoning that was correct, and it's worth pinning
    // so nobody "fixes" it by giving each EVM chain its own coin type.
    const path = "m/44'/60'/0'/0/1";
    const evm = ["ethereum", "arbitrum", "base", "optimism", "polygon"] as const;
    const addrs = evm.map((c) => getAdapter(c).deriveAtPath!(MNEMONIC, path).address);
    expect(new Set(addrs).size, "EVM chains must share one address per path").toBe(1);
  });
});

describe("findPathForAddress — paste an address, get the path", () => {
  it.each(Object.entries(EVM_VECTORS))(
    "recovers the path for %s",
    (path, address) => {
      const hit = findPathForAddress("ethereum", MNEMONIC, address);
      expect(hit, `no path found for ${address}`).toBeTruthy();
      expect(hit!.path).toBe(path);
      expect(hit!.address).toBe(address);
    }
  );

  it("is case-insensitive (users paste non-checksummed addresses)", () => {
    const target = EVM_VECTORS["m/44'/60'/0'/0/1"];
    const hit = findPathForAddress("ethereum", MNEMONIC, target.toLowerCase());
    expect(hit?.path).toBe("m/44'/60'/0'/0/1");
  });

  it("returns null for an address this seed cannot produce", () => {
    const hit = findPathForAddress(
      "ethereum",
      MNEMONIC,
      "0x000000000000000000000000000000000000dEaD"
    );
    expect(hit).toBeNull();
  });
});

describe("candidatePathsFor — derived from each chain's own declaration", () => {
  it("puts the chain's current default first", () => {
    for (const chain of ALL_CHAINS) {
      if (!supportsPathSearch(chain)) continue;
      const d = getAdapter(chain).derivation;
      if (d.kind !== "bip39") continue;
      expect(candidatePathsFor(chain)[0].path, `${chain} default should lead`).toBe(d.path);
    }
  });

  it("produces no duplicates", () => {
    for (const chain of ALL_CHAINS) {
      if (!supportsPathSearch(chain)) continue;
      const paths = candidatePathsFor(chain).map((c) => c.path);
      expect(new Set(paths).size, `${chain} emitted duplicate paths`).toBe(paths.length);
    }
  });

  it("covers every chain that can derive at a path", () => {
    // The point of the generic tools: coverage is a property of the adapter
    // implementing deriveAtPath, not of someone hand-writing a panel.
    const supported = ALL_CHAINS.filter(supportsPathSearch);
    expect(supported.length, "expected the EVM family plus the four wired chains")
      .toBeGreaterThanOrEqual(14);
  });
});

describe("findFundedPaths — a blind sweep is not 'nothing funded'", () => {
  it("returns null when every balance probe fails", async () => {
    // Same contract the chain detectors follow. Collapsing this into "no
    // funded paths" is what sends a user to an empty derivation and tells
    // them it's correct.
    const spy = vi
      .spyOn(getAdapter("ethereum"), "getBalance")
      .mockRejectedValue(new Error("rpc down"));
    try {
      await expect(findFundedPaths("ethereum", MNEMONIC)).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns [] — not null — when probes succeed and nothing is funded", async () => {
    const spy = vi
      .spyOn(getAdapter("ethereum"), "getBalance")
      .mockResolvedValue("0.0");
    try {
      await expect(findFundedPaths("ethereum", MNEMONIC)).resolves.toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("ranks funded paths richest-first", async () => {
    const rich = EVM_VECTORS["m/44'/60'/1'/0/0"];
    const small = EVM_VECTORS["m/44'/60'/0'/0/1"];
    const spy = vi
      .spyOn(getAdapter("ethereum"), "getBalance")
      .mockImplementation(async (addr: string) =>
        addr === rich ? "9.5" : addr === small ? "0.25" : "0.0"
      );
    try {
      const found = await findFundedPaths("ethereum", MNEMONIC);
      expect(found).not.toBeNull();
      expect(found!.map((f) => f.address)).toEqual([rich, small]);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Coverage after extending `deriveAtPath` to DOGE / BCH / ERG / HBAR / NEAR /
 * Stellar / SUI (2026-08-13). The invariant that matters when adding a chain:
 * the arbitrary-path function and the chain's own `deriveFromMnemonic` must
 * agree at the default path. If they diverge, the finder reports an address
 * the wallet will never show — worse than having no finder.
 */
describe("deriveAtPath agrees with each chain's own derivation", () => {
  const supported = ALL_CHAINS.filter(supportsPathSearch);

  it("covers every chain that can vary a path", () => {
    // 21 = 10 EVM + xrp/tron/rvn/dash + doge/bch/erg/hbar/near/stellar/sui.
    // Only Monero and Zephyr are structurally excluded (own-seed chains).
    expect(supported.length).toBeGreaterThanOrEqual(21);
    for (const c of ["dogecoin", "bitcoin-cash", "ergo", "hedera", "near", "stellar", "sui"] as const) {
      expect(supported, `${c} should support path search`).toContain(c);
    }
  });

  it.each(ALL_CHAINS.filter(supportsPathSearch))(
    "%s: deriveAtPath(default) === deriveFromMnemonic",
    (chain) => {
      const a = getAdapter(chain);
      const d = a.derivation;
      if (d.kind !== "bip39") return;
      expect(a.deriveAtPath!(MNEMONIC, d.path).address).toBe(
        a.deriveFromMnemonic(MNEMONIC).address
      );
    }
  );

  it.each(ALL_CHAINS.filter(supportsPathSearch))(
    "%s: a different account yields a different address",
    (chain) => {
      // Guards against a deriveAtPath that silently ignores its path argument
      // — which would make the finder always "find" the default and report
      // that every candidate is the same address.
      const a = getAdapter(chain);
      const d = a.derivation;
      if (d.kind !== "bip39") return;
      const segs = d.path.split("/");
      if (segs.length < 4) return;
      segs[3] = "1'";
      expect(a.deriveAtPath!(MNEMONIC, segs.join("/")).address).not.toBe(
        a.deriveFromMnemonic(MNEMONIC).address
      );
    }
  );
});
