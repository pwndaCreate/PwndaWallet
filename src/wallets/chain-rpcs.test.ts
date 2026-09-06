/**
 * Regression locks for the centralized chain RPC defaults.
 *
 * These tests don't make network calls — they just assert that the
 * `RPC_DEFAULTS` map matches `RPC_AUDIT.md`. If a future contributor
 * adds back a known-bad URL (cloudflare-eth.com, polygon-rpc.com,
 * polygon.llamarpc.com, ankr.com/<paywalled>) the build fails with a
 * clear message pointing at the audit file.
 */
import { describe, expect, it } from "vitest";
import { RPC_DEFAULTS, rpcsFor, type ChainKey } from "./chain-rpcs";

const KNOWN_BAD_URLS = [
  // -32046 "Cannot fulfill request" trap.
  "https://cloudflare-eth.com",
  // 2025 paywalls — produced -32000 "Unauthorized" in the audit.
  "https://rpc.ankr.com/eth",
  "https://rpc.ankr.com/avalanche",
  "https://rpc.ankr.com/polygon",
  "https://rpc.ankr.com/arbitrum",
  "https://rpc.ankr.com/base",
  "https://rpc.ankr.com/optimism",
  "https://rpc.ankr.com/bsc",
  // Polygon's own RPC closed the anonymous tenant in 2025.
  "https://polygon-rpc.com",
  // DNS doesn't resolve.
  "https://polygon.llamarpc.com",
  // Blast retired the "use Alchemy" message.
  "https://polygon-mainnet.public.blastapi.io",
];

describe("RPC_DEFAULTS — known-bad endpoints stay out", () => {
  it.each(KNOWN_BAD_URLS)(
    "no chain's defaults include %s",
    (badUrl) => {
      for (const chain of Object.keys(RPC_DEFAULTS) as ChainKey[]) {
        const defaults = RPC_DEFAULTS[chain].defaults;
        expect(
          defaults,
          `${chain} defaults must not contain ${badUrl} — see RPC_AUDIT.md`,
        ).not.toContain(badUrl);
      }
    },
  );
});

describe("RPC_DEFAULTS — shape invariants", () => {
  const chains = Object.keys(RPC_DEFAULTS) as ChainKey[];

  it("every chain has at least one default endpoint", () => {
    for (const c of chains) {
      expect(RPC_DEFAULTS[c].defaults.length, `${c} has no defaults`).toBeGreaterThan(0);
    }
  });

  it("every chain's env-var name is unique", () => {
    const seen = new Set<string>();
    for (const c of chains) {
      const v = RPC_DEFAULTS[c].envVar;
      expect(seen.has(v), `${c} reuses env var ${v}`).toBe(false);
      seen.add(v);
    }
  });

  it("EVM chains use _RPC_URL, REST chains use _API_URL", () => {
    const evmChains: ChainKey[] = ["ETH", "AVAX", "POL", "FLR", "ARB", "BASE", "OP", "BSC"];
    const restChains: ChainKey[] = ["BTC", "LTC", "DOGE", "BCH"];
    for (const c of evmChains) {
      expect(RPC_DEFAULTS[c].envVar).toMatch(/_RPC_URL$/);
    }
    for (const c of restChains) {
      expect(RPC_DEFAULTS[c].envVar).toMatch(/_API_URL$/);
    }
  });

  it("Cloudflare Ethereum gateway is permanently banned", () => {
    // Belt-and-suspenders — the per-URL test above covers this, but
    // having a dedicated test makes the intent un-missable when someone
    // else is reading the file.
    expect(RPC_DEFAULTS.ETH.defaults).not.toContain("https://cloudflare-eth.com");
  });
});

describe("rpcsFor — env override semantics", () => {
  it("returns the defaults when no override env is set (node env / production Tauri)", () => {
    // Vitest config: `environment: "node"` (vitest.config.ts:14). So
    // `typeof window === "undefined"` in this test, the dev-mode CORS
    // reorder doesn't fire, and the list matches the production order.
    //
    // Asserted against RPC_DEFAULTS rather than a literal URL: these tests
    // cover ORDER SEMANTICS, not which host happens to be first. Pinning the
    // URL made all three of these fail on 2026-08-13 when ETH's primary was
    // reordered after the old one started returning 521 — a config change the
    // tests should have been indifferent to.
    const list = rpcsFor("ETH");
    expect(list[0]).toBe(RPC_DEFAULTS.ETH.defaults[0]);
    expect(list).toEqual([...RPC_DEFAULTS.ETH.defaults]);
  });

  // Note: testing the override-prepend behavior would require stubbing
  // import.meta.env mid-test, which Vitest can do via stubEnv but it's
  // fragile across the import-meta cache. Skip — the resolver code is
  // simple enough to read directly.
});

describe("rpcsFor — browser-without-Tauri CORS reorder", () => {
  // Simulate the `dev:sandbox` runtime: `window` defined but no
  // `__TAURI_INTERNALS__`. The dev-mode console-spam fix lives in
  // `reorderForBrowserCors` (chain-rpcs.ts) — hoist a CORS-permissive
  // endpoint to position 0 so the browser's first ETH-balance fetch
  // doesn't trip llamarpc's missing `Access-Control-Allow-Origin` and
  // fill the console with red errors. Tauri runtime (where Rust
  // owns the RPC) is unaffected.

  function withMockWindow<T>(
    windowMock: object | undefined,
    fn: () => T
  ): T {
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    const prev = g.window;
    if (windowMock === undefined) {
      delete g.window;
    } else {
      g.window = windowMock;
    }
    try {
      return fn();
    } finally {
      if (had) {
        g.window = prev;
      } else {
        delete g.window;
      }
    }
  }

  it("browser-without-Tauri: publicnode hoisted to position 0", () => {
    const list = withMockWindow({}, () => rpcsFor("ETH"));
    expect(list[0]).toBe("https://ethereum-rpc.publicnode.com");
    // llamarpc is preserved in the fallback list (still tried after
    // publicnode), just not the primary anymore.
    expect(list).toContain("https://eth.llamarpc.com");
    // Same set of endpoints either way — no addition / removal.
    expect(new Set(list)).toEqual(new Set(RPC_DEFAULTS.ETH.defaults));
  });

  it("Tauri runtime (window.__TAURI_INTERNALS__ present): production order preserved", () => {
    const list = withMockWindow(
      { __TAURI_INTERNALS__: {} },
      () => rpcsFor("ETH")
    );
    expect(list[0]).toBe(RPC_DEFAULTS.ETH.defaults[0]);
    expect(list).toEqual([...RPC_DEFAULTS.ETH.defaults]);
  });

  it("node env (no window at all): production order preserved", () => {
    const list = withMockWindow(undefined, () => rpcsFor("ETH"));
    expect(list[0]).toBe(RPC_DEFAULTS.ETH.defaults[0]);
    expect(list).toEqual([...RPC_DEFAULTS.ETH.defaults]);
  });

  it("non-ETH chains are NOT reordered in browser-without-Tauri mode", () => {
    // The reorder is scoped to ETH because that's the only chain
    // where the user reported llamarpc-CORS console spam. Other
    // chains keep their production ordering even in the
    // dev-without-Tauri context — if a future chain's primary
    // turns CORS-hostile, add it explicitly to `reorderForBrowserCors`.
    const avaxList = withMockWindow({}, () => rpcsFor("AVAX"));
    expect(avaxList).toEqual([...RPC_DEFAULTS.AVAX.defaults]);
  });
});
