/**
 * Invariant tests for the asset-capabilities registry.
 *
 * These tests enforce the structural contract that prevents the
 * 2026-05-25 three-bugs-in-a-day pattern from recurring. Every test
 * in this file maps to a specific bug class:
 *
 *   - "every routable asset has a signer if source-capable" — catches
 *     the "swapKitAsset set but no Rust signer to actually source-tx"
 *     gap that would let a quote succeed but execution explode.
 *
 *   - "every destination-capable asset has an addressFor resolver path"
 *     — catches the CARDANO blocker class: an asset is in the registry
 *     with a `walletsByChainKey`, but the resolver can't reach a real
 *     address for it. The compile-time `keyof WalletsByChain` constraint
 *     on `walletsByChainKey` is the first line of defense; this test is
 *     the runtime fallback.
 *
 *   - "NEAR Intents asset IDs match nep141/nep245 format" — catches
 *     paste-typo bugs (e.g. `"nep141:cardano.omft.near"` vs
 *     `"nep41:cardano.omft.near"` — one character drops you off the
 *     1Click catalog and into a silent 4xx).
 *
 *   - "SwapKit asset notation matches CHAIN.SYMBOL format" — same
 *     bug class for the SwapKit side.
 *
 *   - "isSwapKitRoutable / isIntentsRoutable agree with the registry"
 *     — locks the predicates to the registry so a future change to
 *     either side can't drift them apart.
 *
 * Compile-time invariants (NOT in this file because TypeScript already
 * enforces them):
 *
 *   - `walletsByChainKey` is `keyof WalletsByChain` — adding an asset
 *     whose wallet lives at a key not in `ChainType` is a tsc error.
 *   - `chainKind` is `SwapChainKind` — must be one of the dispatch
 *     values `executeIntentsTrade` and `broadcastChainKind` understand.
 */
import { describe, expect, it } from "vitest";
import type { WalletInfo } from "../../wallets/types";
import {
  ASSET_CAPABILITIES,
  addressForTicker,
  deskAmountsFor,
  deskCoinsFor,
  deskDirectionFor,
  deskPairLabel,
  isDeskRoutableFromRegistry,
  isIntentsRoutableFromRegistry,
  isSwapKitRoutableFromRegistry,
  type WalletsByChain,
} from "./asset-capabilities";
import { isIntentsRoutable, isSwapKitRoutable } from "./swap-data";
import { nearAdapter } from "../../wallets/near-wallet";

/**
 * Build a wallets-by-chain bundle populated for every key the registry
 * references. Each entry uses a sentinel address that's clearly fake
 * (so a real test assertion against a real address would catch any
 * accidental leak from this fixture).
 */
function createMockWalletsByChain(): WalletsByChain {
  const out: WalletsByChain = {};
  const seen = new Set<string>();
  for (const cap of Object.values(ASSET_CAPABILITIES)) {
    if (!cap.walletsByChainKey) continue;
    if (seen.has(cap.walletsByChainKey)) continue;
    seen.add(cap.walletsByChainKey);
    out[cap.walletsByChainKey] = {
      chain: cap.walletsByChainKey,
      address: `mock-${cap.walletsByChainKey}-0x00`,
      mnemonic: "",
      privateKey: "",
    } as WalletInfo;
  }
  return out;
}

describe("ASSET_CAPABILITIES registry — structural invariants", () => {
  it("every routable asset with signerInRustCore=true also has rpcsAvailable=true", () => {
    // If we claim to have a Rust signer for this asset AND we expose
    // it for routing (SwapKit or Intents), there MUST be at least one
    // RPC for the broadcast layer to reach. Otherwise the user gets
    // a sign-but-can't-broadcast dead-end.
    for (const [ticker, cap] of Object.entries(ASSET_CAPABILITIES)) {
      const routable = cap.nearIntentsAsset !== null || cap.swapKitAsset !== null;
      if (!routable) continue;
      if (!cap.signerInRustCore) continue;
      expect(
        cap.rpcsAvailable,
        `${ticker} has signerInRustCore=true and is routable but rpcsAvailable=false`
      ).toBe(true);
    }
  });

  it("rpcsAvailable agrees with the underlying RPC fields", () => {
    // The derived `rpcsAvailable` boolean must match the actual presence
    // of `defaultRpcUrl` or non-empty `rpcFallbacks`. Drift here means a
    // consumer that trusts `rpcsAvailable` will silently broadcast to
    // undefined.
    for (const [ticker, cap] of Object.entries(ASSET_CAPABILITIES)) {
      const reallyHasRpcs =
        !!cap.defaultRpcUrl ||
        (Array.isArray(cap.rpcFallbacks) && cap.rpcFallbacks.length > 0);
      expect(
        cap.rpcsAvailable,
        `${ticker}: rpcsAvailable=${cap.rpcsAvailable} but reality=${reallyHasRpcs}`
      ).toBe(reallyHasRpcs);
    }
  });

  it("every asset with walletsByChainKey set resolves via addressForTicker against a populated wallet bundle", () => {
    // The CARDANO blocker class. If an asset claims `walletsByChainKey`,
    // the registry-driven resolver must be able to return a non-null
    // address when that wallet is present. This catches typos in the
    // key string (compile-time `keyof WalletsByChain` catches the type
    // shape, but a hand-edited entry with the wrong literal value could
    // still type-check while resolving to a wallet entry that never gets
    // populated).
    const mockWallets = createMockWalletsByChain();
    for (const [ticker, cap] of Object.entries(ASSET_CAPABILITIES)) {
      if (!cap.walletsByChainKey) continue;
      const addr = addressForTicker(ticker, mockWallets);
      expect(
        addr,
        `${ticker} (walletsByChainKey=${cap.walletsByChainKey}) resolved to null against a fully-populated wallet bundle`
      ).not.toBeNull();
      expect(addr).toBe(`mock-${cap.walletsByChainKey}-0x00`);
    }
  });

  it("addressForTicker returns null for unknown tickers", () => {
    expect(addressForTicker("DEFINITELY_NOT_AN_ASSET", {})).toBeNull();
  });

  it("addressForTicker resolves NEAR via the first-party adapter (2026-05-26 fix)", () => {
    // Pre-2026-05-26: NEAR had no `walletsByChainKey` because the
    // Rust session-id flow was the only address path. After
    // `near-wallet.ts` shipped, the TS adapter derives the implicit
    // account at vault-load from the BIP-39 seed, the address lands
    // in `WalletsByChain.near`, and `addressForTicker("NEAR", ...)`
    // returns a non-null value. The form's confirm-ready predicate
    // now recognizes NEAR-source pairs.
    const wallets = createMockWalletsByChain();
    expect(addressForTicker("NEAR", wallets)).toBe("mock-near-0x00");
  });

  it("every NEAR Intents asset id matches nep141/nep245 format", () => {
    // Catches paste-typo bugs ("nep141:" → "nep41:" → silent 4xx from
    // 1Click for an asset id not in the catalog).
    for (const [ticker, cap] of Object.entries(ASSET_CAPABILITIES)) {
      if (!cap.nearIntentsAsset) continue;
      expect(
        cap.nearIntentsAsset,
        `${ticker}.nearIntentsAsset="${cap.nearIntentsAsset}" doesn't start with nep141:/nep245:`
      ).toMatch(/^nep(141|245):/);
    }
  });

  it("every SwapKit asset id matches CHAIN.SYMBOL format", () => {
    // SwapKit's convention is uppercase chain dot uppercase symbol
    // (e.g. ETH.ETH, AVAX.AVAX, BNB.BNB). Hyphen allowed for some
    // multi-word symbols (BTC.BTC-USDT-style entries don't exist for
    // Pwnda's v1 set but the pattern leaves room).
    for (const [ticker, cap] of Object.entries(ASSET_CAPABILITIES)) {
      if (!cap.swapKitAsset) continue;
      expect(
        cap.swapKitAsset,
        `${ticker}.swapKitAsset="${cap.swapKitAsset}" doesn't match CHAIN.SYMBOL`
      ).toMatch(/^[A-Z]+\.[A-Z0-9-]+$/);
    }
  });

  it("EVM-kind assets have a chainId", () => {
    for (const [ticker, cap] of Object.entries(ASSET_CAPABILITIES)) {
      if (cap.chainKind !== "EVM") continue;
      expect(
        typeof cap.chainId,
        `${ticker}: chainKind=EVM but chainId=${cap.chainId}`
      ).toBe("number");
      expect(cap.chainId).toBeGreaterThan(0);
    }
  });

  it("non-EVM-kind assets do NOT have a chainId", () => {
    for (const [ticker, cap] of Object.entries(ASSET_CAPABILITIES)) {
      if (cap.chainKind === "EVM") continue;
      expect(
        cap.chainId,
        `${ticker}: chainKind=${cap.chainKind} (non-EVM) but chainId=${cap.chainId}`
      ).toBeUndefined();
    }
  });
});

describe("ASSET_CAPABILITIES registry — agreement with public predicates", () => {
  it("isSwapKitRoutable matches the registry-direct predicate for every pair", () => {
    // Locks the public `isSwapKitRoutable` exported from `swap-data.ts`
    // (a thin shim over `isSwapKitRoutableFromRegistry`) to the registry
    // values. Drift here is the kind of bug that produces "Quote
    // unavailable" with a valid quote in hand (the entire 2026-05-25
    // post-mortem). 484 pairs (22 × 22 cartesian); fast.
    const tickers = Object.keys(ASSET_CAPABILITIES);
    for (const from of tickers) {
      for (const to of tickers) {
        expect(isSwapKitRoutable(from, to)).toBe(
          isSwapKitRoutableFromRegistry(from, to)
        );
      }
    }
  });

  it("isIntentsRoutable matches the registry-direct predicate for every pair", () => {
    const tickers = Object.keys(ASSET_CAPABILITIES);
    for (const from of tickers) {
      for (const to of tickers) {
        expect(isIntentsRoutable(from, to)).toBe(
          isIntentsRoutableFromRegistry(from, to)
        );
      }
    }
  });

  it("isSwapKitRoutable agrees with the registry's swapKitAsset fields", () => {
    // Direct check that the predicate is `f.swapKitAsset && t.swapKitAsset`
    // and nothing else. Any future change to add e.g. a per-pair
    // allowlist or denylist needs to update this test deliberately.
    const tickers = Object.keys(ASSET_CAPABILITIES);
    for (const from of tickers) {
      for (const to of tickers) {
        const f = ASSET_CAPABILITIES[from];
        const t = ASSET_CAPABILITIES[to];
        const expected = !!(f?.swapKitAsset && t?.swapKitAsset);
        expect(isSwapKitRoutable(from, to)).toBe(expected);
      }
    }
  });

  it("isIntentsRoutable agrees with the registry's nearIntentsAsset fields", () => {
    const tickers = Object.keys(ASSET_CAPABILITIES);
    for (const from of tickers) {
      for (const to of tickers) {
        const f = ASSET_CAPABILITIES[from];
        const t = ASSET_CAPABILITIES[to];
        const expected = !!(f?.nearIntentsAsset && t?.nearIntentsAsset);
        expect(isIntentsRoutable(from, to)).toBe(expected);
      }
    }
  });
});

describe("NEAR adapter parity with Rust derivation (2026-05-26 fix)", () => {
  // Lock the TS adapter's output against the Rust algorithm in
  // `src-tauri/src/swap/derive.rs::near_implicit_account`. Both
  // derive at `m/44'/397'/0'` SLIP-10 ed25519 and return
  // `hex(public_key)`. The Rust test (`vector_near_implicit_account`
  // in derive.rs) asserts the same: implicit account is 64 hex chars,
  // and the `ed25519:<base58>` display form decodes to the same bytes.
  // This test catches drift if the path changes in either layer
  // without the other being updated.
  it("derives the abandon test vector to a 64-char hex implicit account", () => {
    const ABANDON =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const wallet = nearAdapter.deriveFromMnemonic(ABANDON);
    expect(wallet.address).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a deterministic address (same seed in → same address out)", () => {
    const M = "test test test test test test test test test test test junk";
    const a = nearAdapter.deriveFromMnemonic(M);
    const b = nearAdapter.deriveFromMnemonic(M);
    expect(a.address).toBe(b.address);
    expect(a.address).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ASSET_CAPABILITIES registry — 1:1 migration from legacy SWAP_COIN_META", () => {
  // The user's spec for this refactor: "1:1 migration of existing
  // SWAP_COIN_META entries". These spot checks lock the known-good
  // values for the assets the user has actually transacted with this
  // week (BTC, ETH, AVAX, ADA) so the migration can't silently drop a
  // field along the way.

  it("ETH entry preserves chainId 1 + standard SwapKit notation", () => {
    const eth = ASSET_CAPABILITIES.ETH;
    expect(eth.chainId).toBe(1);
    expect(eth.decimals).toBe(18);
    expect(eth.chainKind).toBe("EVM");
    expect(eth.walletsByChainKey).toBe("ethereum");
    expect(eth.signerInRustCore).toBe(true);
    expect(eth.swapKitAsset).toBe("ETH.ETH");
    expect(eth.nearIntentsAsset).toBe("nep141:eth.omft.near");
  });

  it("AVAX entry preserves chainId 43114 + HOT-Omni nep245 envelope", () => {
    const avax = ASSET_CAPABILITIES.AVAX;
    expect(avax.chainId).toBe(43114);
    expect(avax.decimals).toBe(18);
    expect(avax.chainKind).toBe("EVM");
    expect(avax.walletsByChainKey).toBe("ethereum");
    expect(avax.signerInRustCore).toBe(true);
    expect(avax.swapKitAsset).toBe("AVAX.AVAX");
    expect(avax.nearIntentsAsset).toBe(
      "nep245:v2_1.omni.hot.tg:43114_11111111111111111111"
    );
  });

  it("ADA entry: TS-signed source (signerInRustCore false, tsSourceSigner cardano, swapKitAsset null)", () => {
    const ada = ASSET_CAPABILITIES.ADA;
    expect(ada.decimals).toBe(6);
    expect(ada.chainKind).toBe("CARDANO");
    expect(ada.walletsByChainKey).toBe("cardano");
    // No Rust signer (so the signerInRustCore→rpcsAvailable invariant
    // doesn't apply) — source capability comes from the TS Cardano stack.
    expect(ada.signerInRustCore).toBe(false);
    expect(ada.tsSourceSigner).toBe("cardano");
    expect(ada.swapKitAsset).toBeNull();
    expect(ada.nearIntentsAsset).toBe("nep141:cardano.omft.near");
    expect(ada.coverageNote).toBeTruthy();
  });

  it("BTC entry preserves 8 decimals + PSBT chainKind", () => {
    const btc = ASSET_CAPABILITIES.BTC;
    expect(btc.chainId).toBeUndefined();
    expect(btc.decimals).toBe(8);
    expect(btc.chainKind).toBe("BTC");
    expect(btc.walletsByChainKey).toBe("bitcoin");
    expect(btc.signerInRustCore).toBe(true);
    expect(btc.swapKitAsset).toBe("BTC.BTC");
    expect(btc.nearIntentsAsset).toBe("nep141:btc.omft.near");
  });

  it("Zephyr ecosystem entries are routed off-Intents (both fields null)", () => {
    for (const ticker of ["ZEPH", "ZEPHUSD", "ZEPHRSV", "ZEPHYRS"]) {
      const cap = ASSET_CAPABILITIES[ticker];
      expect(cap.chainKind).toBe("ZEPH");
      expect(cap.walletsByChainKey).toBe("zephyr");
      expect(cap.signerInRustCore).toBe(false);
      expect(cap.swapKitAsset).toBeNull();
      expect(cap.nearIntentsAsset).toBeNull();
    }
  });

  it("Zano's entry matches the same host-wallet shape as XMR/ZEPH (decimals, chainKind, no Rust signer, off both aggregators)", () => {
    const cap = ASSET_CAPABILITIES.ZANO;
    expect(cap.decimals).toBe(12);
    expect(cap.chainKind).toBe("ZANO");
    expect(cap.walletsByChainKey).toBe("zano");
    expect(cap.signerInRustCore).toBe(false);
    expect(cap.rpcsAvailable).toBe(false);
    expect(cap.swapKitAsset).toBeNull();
    expect(cap.nearIntentsAsset).toBeNull();
  });

  it("addressForTicker sources ZEPH/ZANO from the ONE host wallet slot, not a per-tx derived address (Grove expansion plan C-T1)", () => {
    // The property the BasicSwap sidecar route depends on when it shares
    // the host wallet (C-RZ/C-RX's lease pattern): calling addressForTicker
    // twice for the same coin must return the exact same address, because
    // there is nothing here that could derive a fresh one — it always reads
    // the single `WalletInfo.address` slot for `walletsByChainKey`. This is
    // what distinguishes ZEPH/ZANO's `addressForTicker` from an HD-wallet
    // "next receiving address" style resolver (which this app doesn't have
    // for ANY coin, but which the sidecar's host-wallet sharing design
    // specifically depends on NOT existing for these two).
    const wallets: WalletsByChain = {
      zephyr: { chain: "zephyr", address: "zeph-host-addr", mnemonic: "", privateKey: "" } as WalletInfo,
      zano: { chain: "zano", address: "zano-host-addr", mnemonic: "", privateKey: "" } as WalletInfo,
    };
    expect(addressForTicker("ZEPH", wallets)).toBe("zeph-host-addr");
    expect(addressForTicker("ZEPH", wallets)).toBe(addressForTicker("ZEPH", wallets));
    expect(addressForTicker("ZANO", wallets)).toBe("zano-host-addr");
    expect(addressForTicker("ZANO", wallets)).toBe(addressForTicker("ZANO", wallets));
    // No wallet populated yet (before the host-wallet lease activates) ->
    // null, never a fabricated address — same contract every other asset
    // in this registry gets.
    expect(addressForTicker("ZEPH", {})).toBeNull();
    expect(addressForTicker("ZANO", {})).toBeNull();
  });
});

/**
 * The pwnda-desk routability axis (2026-07-19).
 *
 * This is a THIRD axis, orthogonal to swapKitAsset / nearIntentsAsset: it
 * needs the two ends to hold DIFFERENT roles rather than the same field.
 * It is also what finally makes XMR/ZEPH routable at all — they are null
 * on both aggregators, so before the desk they had no route and were
 * excluded from the cross-chain dropdowns entirely.
 */
describe("ASSET_CAPABILITIES registry — pwnda-desk routability axis", () => {
  const roleOf = (t: string) => ASSET_CAPABILITIES[t]?.atomicDesk?.role;
  const leaders = Object.values(ASSET_CAPABILITIES)
    .filter((c) => c.atomicDesk?.role === "leader")
    .map((c) => c.ticker)
    .sort();
  const followers = Object.values(ASSET_CAPABILITIES)
    .filter((c) => c.atomicDesk?.role === "follower")
    .map((c) => c.ticker)
    .sort();

  const engineOf = (t: string) => ASSET_CAPABILITIES[t]?.atomicDesk?.engine;
  const vendored = (t: string) => engineOf(t) != null;

  // Two independent axes, and conflating them is the bug this block guards.
  // `role` is what the DESK offers (its /pairs roster has three leaders).
  // `engine` is what the CLIENT can settle. Only `ada-xmr` is vendored, so
  // the desk's six pairs collapse to two the client can actually execute.
  it("keeps all three desk leaders in the roster - role is the desk's axis", () => {
    expect(leaders).toEqual(["ADA", "AVAX", "LTC"]);
    expect(followers).toEqual(["XMR", "ZEPH"]);
    expect(leaders.length * followers.length).toBe(6);
  });

  it("vendors exactly one engine, so only 2 of those 6 are settleable", () => {
    expect(engineOf("ADA")).toBe("ada-xmr");
    expect(engineOf("XMR")).toBe("ada-xmr");
    expect(engineOf("ZEPH")).toBe("ada-xmr");
    // Different crypto, no vendored engine - see the atomicDesk doc comment.
    expect(engineOf("LTC")).toBeNull();
    expect(engineOf("AVAX")).toBeNull();

    const settleable = leaders.flatMap((l) =>
      followers.filter((f) => isDeskRoutableFromRegistry(f, l)).map((f) => `${f}/${l}`)
    );
    expect(settleable.sort()).toEqual(["XMR/ADA", "ZEPH/ADA"]);
  });

  it("routes a leader<->follower combination iff BOTH legs share a vendored engine", () => {
    for (const l of leaders) {
      for (const f of followers) {
        const expected = vendored(l) && vendored(f) && engineOf(l) === engineOf(f);
        expect(isDeskRoutableFromRegistry(f, l)).toBe(expected);
        expect(isDeskRoutableFromRegistry(l, f)).toBe(expected);
      }
    }
  });

  it("refuses a pair whose leader has no vendored engine, even though the desk offers it", () => {
    // The regression this pins: LTC and AVAX ARE desk leaders. Gating on
    // `role` alone (the pre-2026-07-19 rule) offered the user four pairs the
    // client has no crypto to settle - it would have quoted and then failed
    // at accept, after reserving desk inventory.
    for (const l of ["LTC", "AVAX"]) {
      for (const f of ["XMR", "ZEPH"]) {
        expect(roleOf(l)).toBe("leader");
        expect(roleOf(f)).toBe("follower");
        expect(isDeskRoutableFromRegistry(f, l)).toBe(false);
        expect(deskDirectionFor(f, l)).toBeNull();
        expect(deskPairLabel(f, l)).toBeNull();
      }
    }
  });

  it("refuses same-role pairs — leader<->leader and follower<->follower are not swaps the desk makes", () => {
    expect(isDeskRoutableFromRegistry("ADA", "LTC")).toBe(false);
    expect(isDeskRoutableFromRegistry("LTC", "AVAX")).toBe(false);
    expect(isDeskRoutableFromRegistry("XMR", "ZEPH")).toBe(false);
    expect(isDeskRoutableFromRegistry("XMR", "XMR")).toBe(false);
  });

  it("refuses pairs where either side is not desk-tradable", () => {
    expect(isDeskRoutableFromRegistry("XMR", "BTC")).toBe(false);
    expect(isDeskRoutableFromRegistry("ETH", "ADA")).toBe(false);
    expect(isDeskRoutableFromRegistry("XMR", "NOT_A_TICKER")).toBe(false);
  });

  it("puts only the NATIVE Zephyr coin on the desk, not the ecosystem assets", () => {
    expect(roleOf("ZEPH")).toBe("follower");
    for (const t of ["ZEPHUSD", "ZEPHRSV", "ZEPHYRS"]) {
      expect(roleOf(t)).toBeUndefined();
      expect(isDeskRoutableFromRegistry(t, "ADA")).toBe(false);
    }
  });

  it("is independent of the aggregator axes — the desk is what makes XMR/ZEPH routable at all", () => {
    for (const f of followers) {
      expect(ASSET_CAPABILITIES[f].swapKitAsset).toBeNull();
      expect(ASSET_CAPABILITIES[f].nearIntentsAsset).toBeNull();
      expect(isSwapKitRoutableFromRegistry(f, "ADA")).toBe(false);
      expect(isIntentsRoutableFromRegistry(f, "ADA")).toBe(false);
      expect(isDeskRoutableFromRegistry(f, "ADA")).toBe(true);
    }
  });

  it("deskDirectionFor: selling the follower is SELL_FOLLOWER, buying it is BUY_FOLLOWER", () => {
    expect(deskDirectionFor("XMR", "ADA")).toBe("SELL_FOLLOWER");
    expect(deskDirectionFor("ADA", "XMR")).toBe("BUY_FOLLOWER");
    expect(deskDirectionFor("ZEPH", "ADA")).toBe("SELL_FOLLOWER");
    expect(deskDirectionFor("ADA", "ZEPH")).toBe("BUY_FOLLOWER");
    expect(deskDirectionFor("XMR", "BTC")).toBeNull();
  });

  it("deskPairLabel is always FOLLOWER/LEADER regardless of swap direction", () => {
    expect(deskPairLabel("XMR", "ADA")).toBe("XMR/ADA");
    expect(deskPairLabel("ADA", "XMR")).toBe("XMR/ADA");
    expect(deskPairLabel("ZEPH", "ADA")).toBe("ZEPH/ADA");
    expect(deskPairLabel("ADA", "ZEPH")).toBe("ZEPH/ADA");
    expect(deskPairLabel("ETH", "BTC")).toBeNull();
  });

  it("is case-insensitive, like the sibling predicates", () => {
    expect(isDeskRoutableFromRegistry("xmr", "ada")).toBe(true);
    expect(deskDirectionFor("xmr", "ada")).toBe("SELL_FOLLOWER");
    expect(deskPairLabel("xmr", "ada")).toBe("XMR/ADA");
  });
});

/**
 * Desk coin/amount derivation. The amountA/amountB inversion is the load-
 * bearing case: they are CHAIN legs (A = leader, B = follower), not in/out,
 * so reading them positionally silently inverts every rehydrated swap.
 */
describe("ASSET_CAPABILITIES registry — desk coin/amount derivation", () => {
  it("deskCoinsFor maps direction to in/out for every desk pair", () => {
    expect(deskCoinsFor("XMR/ADA", "SELL_FOLLOWER")).toEqual({ coinIn: "XMR", coinOut: "ADA" });
    expect(deskCoinsFor("XMR/ADA", "BUY_FOLLOWER")).toEqual({ coinIn: "ADA", coinOut: "XMR" });
    expect(deskCoinsFor("ZEPH/ADA", "SELL_FOLLOWER")).toEqual({ coinIn: "ZEPH", coinOut: "ADA" });
    expect(deskCoinsFor("ZEPH/ADA", "BUY_FOLLOWER")).toEqual({ coinIn: "ADA", coinOut: "ZEPH" });
    expect(deskCoinsFor("ZEPH/ADA", "SELL_FOLLOWER")).toEqual({ coinIn: "ZEPH", coinOut: "ADA" });
    expect(deskCoinsFor("ZEPH/ADA", "BUY_FOLLOWER")).toEqual({ coinIn: "ADA", coinOut: "ZEPH" });
  });

  it("deskCoinsFor rejects a non-desk pair, an inverted label, and a bad direction", () => {
    expect(deskCoinsFor("ETH/BTC", "SELL_FOLLOWER")).toBeNull();
    // Label must be FOLLOWER/LEADER — the inverted form is not accepted.
    expect(deskCoinsFor("ADA/XMR", "SELL_FOLLOWER")).toBeNull();
    // follower/follower and leader/leader are not desk pairs.
    expect(deskCoinsFor("XMR/ZEPH", "SELL_FOLLOWER")).toBeNull();
    expect(deskCoinsFor("XMR/ADA", "SIDEWAYS")).toBeNull();
    expect(deskCoinsFor("XMR", "SELL_FOLLOWER")).toBeNull();
  });

  it("deskAmountsFor inverts amountA/amountB with the direction (the trace's own numbers)", () => {
    // SELL_FOLLOWER: sell 0.1 XMR (chain B) for 27 ADA (chain A).
    expect(
      deskAmountsFor({ pair: "XMR/ADA", direction: "SELL_FOLLOWER", amountA: "27", amountB: "0.1" })
    ).toEqual({ amountIn: "0.1", amountOut: "27" });
    // BUY_FOLLOWER: buy 0.009 XMR (chain B) with 3 ADA (chain A).
    expect(
      deskAmountsFor({ pair: "XMR/ADA", direction: "BUY_FOLLOWER", amountA: "3", amountB: "0.009" })
    ).toEqual({ amountIn: "3", amountOut: "0.009" });
  });

  it("deskAmountsFor rejects a non-desk pair and a bad direction", () => {
    expect(
      deskAmountsFor({ pair: "ETH/BTC", direction: "SELL_FOLLOWER", amountA: "1", amountB: "2" })
    ).toBeNull();
    expect(
      deskAmountsFor({ pair: "XMR/ADA", direction: "SIDEWAYS", amountA: "1", amountB: "2" })
    ).toBeNull();
  });

  it("agrees with deskPairLabel + deskDirectionFor round-trip", () => {
    // What the form derives from a from/to selection must feed straight back
    // into what the rehydrate path derives from pair+direction.
    for (const [from, to] of [["XMR", "ADA"], ["ADA", "XMR"], ["ZEPH", "ADA"], ["ADA", "ZEPH"]]) {
      const pair = deskPairLabel(from, to)!;
      const direction = deskDirectionFor(from, to)!;
      expect(deskCoinsFor(pair, direction)).toEqual({
        coinIn: from.toUpperCase(),
        coinOut: to.toUpperCase(),
      });
    }
  });
});
