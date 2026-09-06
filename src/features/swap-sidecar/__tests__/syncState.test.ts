/**
 * DexParticlCard's source-of-truth rules for sync display.
 *
 * The stakes: during IBD the engine's `/json/wallets` times out (measured:
 * 10s, every coin `error: Timeout`) while the daemon's own `getblockchaininfo`
 * answers in milliseconds. The card therefore takes BOTH sources, and the
 * rules under test are the ones that went wrong on a live machine:
 *
 *  - engine silent + daemon alive rendered "start it from Settings" about a
 *    node that was visibly syncing — the user went chasing a fault that did
 *    not exist;
 *  - both sources reporting rendered TWO progress bars for one chain.
 */
import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { DexParticlCard } from "../DexParticlCard";
import type { SidecarBalanceRow } from "../useSidecarBalances";
import type { ChainSync } from "../../../api/basicswap";

/** Render-walk: function components are INVOKED so row internals are visible —
 *  the props-children-only walk let an earlier test pass on the intro
 *  paragraph while asserting about a row it could not see. */
function walk(node: unknown, out: { text: string[]; bars: number }): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out));
    return;
  }
  if (typeof node !== "object") return;
  const el = node as ReactElement & { type?: unknown; props?: Record<string, unknown> };
  const props = (el.props ?? {}) as Record<string, unknown>;
  if (props.role === "progressbar") out.bars += 1;
  if (typeof el.type === "function") {
    try {
      // Invoked successfully: the returned tree SUBSUMES props.children (that
      // is what rendering means), so walking both double-counts everything
      // inside — the first version tallied every progress bar twice.
      walk((el.type as (p: unknown) => unknown)(props), out);
      return;
    } catch {
      /* hooks-dependent child — fall through to its raw children */
    }
  }
  walk(props.children, out);
}

function render(props: Parameters<typeof DexParticlCard>[0]) {
  const out = { text: [] as string[], bars: 0 };
  walk(DexParticlCard(props), out);
  return { said: out.text.join(" "), bars: out.bars };
}

const chain = (over: Partial<ChainSync> = {}): ChainSync => ({
  coin: "particl",
  ticker: "PART",
  blocks: 471_999,
  headers: 2_226_740,
  verifiedPct: 18.41,
  error: null,
  ...over,
});

const row = (over: Partial<SidecarBalanceRow> = {}): SidecarBalanceRow => ({
  ticker: "PART",
  balance: "0.00000000",
  pending: "0",
  depositAddress: null,
  locked: false,
  error: null,
  blocks: 349_745,
  syncedPercent: 13.73,
  knownBlockCount: 2_226_731,
  bootstrapping: false,
  connectionType: "rpc",
  expectedSeed: true,
  ...over,
});

describe("DexParticlCard source-of-truth rules", () => {
  it("engine silent + daemon alive shows SYNC, not 'start it from Settings'", () => {
    const { said, bars } = render({ row: null, chain: chain(), optedIn: true });
    expect(said).not.toContain("Start it from");
    expect(said).toContain("471,999");
    expect(said).toContain("2,226,740");
    expect(bars).toBe(1);
  });

  it("both sources silent is the only 'node down' case", () => {
    const { said } = render({ row: null, chain: null, optedIn: true });
    expect(said).toContain("not reporting a Particl wallet");
  });

  it("both sources reporting renders EXACTLY ONE bar, from the daemon", () => {
    const { said, bars } = render({ row: row(), chain: chain(), optedIn: true });
    expect(bars).toBe(1);
    // The daemon's fresher height wins the visible line…
    expect(said).toContain("471,999");
    // …and the engine's stale height must not render beside it.
    expect(said).not.toContain("349,745");
  });

  it("no daemon read falls back to the engine's own numbers", () => {
    const { said, bars } = render({ row: row(), chain: null, optedIn: true });
    expect(said).toContain("349,745");
    expect(bars).toBe(1);
  });

  it("renders nothing before opt-in (P1)", () => {
    const { said } = render({ row: row(), chain: chain(), optedIn: false });
    expect(said).toBe("");
  });
});
