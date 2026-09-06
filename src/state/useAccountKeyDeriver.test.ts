/**
 * The guard for the bug this file was created to end: a coin the swap-key
 * module knows how to derive, that no caller ever hands a wallet entry to.
 *
 * BCH was in that state for a day (2026-09-04 → 09-05). `ADOPTABLE_ACCOUNTS`
 * listed it, `CANDIDATES` listed it, the engine had admitted it since
 * PATCH-18 — and the three per-call-site input maps did not, so the push was
 * never even attempted and the console read `NaN BCH` with no error anywhere.
 * Nothing in the type system could see it: an input map is
 * `Record<string, …>`, so a missing key is a valid map.
 */
import { describe, it, expect } from "vitest";
import {
  ACCOUNT_KEY_CHAINS,
  accountKeyInputsFrom,
  hasAnyAccountKeyWallet,
} from "./useAccountKeyDeriver";
import { ADOPTABLE_ACCOUNTS } from "../lib/swapAccountKey";
import { SHARED_COIN_CHAINS } from "../features/swap-sidecar/sharedCoinBalance";
import type { ChainType, WalletInfo } from "../wallets/types";

function wallet(chain: ChainType, over: Partial<WalletInfo> = {}): WalletInfo {
  return {
    chain,
    address: `${chain}-address`,
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    privateKey: "",
    ...over,
  };
}

describe("the account-key input map", () => {
  it("covers every coin the deriver can adopt", () => {
    // ← the assertion that would have caught BCH on 2026-09-04.
    for (const ticker of Object.keys(ADOPTABLE_ACCOUNTS)) {
      expect(
        ACCOUNT_KEY_CHAINS[ticker],
        `${ticker} is adoptable but no wallet chain feeds it — it can never be pushed`,
      ).toBeTruthy();
    }
  });

  it("names no coin the deriver would refuse", () => {
    for (const ticker of Object.keys(ACCOUNT_KEY_CHAINS)) {
      expect(ADOPTABLE_ACCOUNTS[ticker], `${ticker} has no account path`).toBeTruthy();
    }
  });

  /**
   * The two per-coin tables must agree. `SHARED_COIN_CHAINS` decides whose
   * balance the WALLET shows for a shared coin; this one decides which coins
   * can become shared at all. A coin in one and not the other is either a key
   * pushed for a balance nobody reads, or a balance authority handed to a
   * wallet that was never adopted — and both have happened in this codebase
   * within the same week.
   */
  it("agrees with the shared-balance table, coin for coin", () => {
    expect(Object.keys(ACCOUNT_KEY_CHAINS).sort()).toEqual(
      Object.keys(SHARED_COIN_CHAINS).sort(),
    );
    for (const [ticker, chain] of Object.entries(ACCOUNT_KEY_CHAINS)) {
      expect(SHARED_COIN_CHAINS[ticker], ticker).toBe(chain);
    }
  });

  it("carries each chain's OWN mnemonic and address", () => {
    const inputs = accountKeyInputsFrom({
      bitcoin: wallet("bitcoin"),
      litecoin: wallet("litecoin"),
      "bitcoin-cash": wallet("bitcoin-cash"),
    });
    expect(inputs.BTC.address).toBe("bitcoin-address");
    expect(inputs.LTC.address).toBe("litecoin-address");
    expect(inputs.BCH.address).toBe("bitcoin-cash-address");
    expect(inputs.BCH.mnemonic).toContain("abandon");
  });

  it("drops a watch-only entry's seed rather than deriving on an empty one", () => {
    const inputs = accountKeyInputsFrom({
      "bitcoin-cash": wallet("bitcoin-cash", { watchOnly: true }),
    });
    expect(inputs.BCH.mnemonic).toBeNull();
    expect(inputs.BCH.address).toBe("bitcoin-cash-address");
  });

  it("reports every adoptable coin as absent when nothing is loaded", () => {
    const inputs = accountKeyInputsFrom({});
    for (const ticker of Object.keys(ADOPTABLE_ACCOUNTS)) {
      expect(inputs[ticker]).toEqual({ mnemonic: null, address: null });
    }
    expect(hasAnyAccountKeyWallet({})).toBe(false);
    expect(hasAnyAccountKeyWallet({ "bitcoin-cash": wallet("bitcoin-cash") })).toBe(true);
  });
});
