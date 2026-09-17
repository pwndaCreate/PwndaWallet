import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactElement } from "react";
import { capabilityFor } from "../minedAssetCapability";
import { minedAssetView } from "../minedAssetView";
import { EarnCapabilityBlock } from "../components/EarnCapabilityBlock";
import type { MiningProjection } from "../../../types/mining";

/**
 * No Mine view may advertise a conversion the mined coin cannot make.
 *
 * `minedAssetCapability.ts` is the single place that says whether a mined coin
 * has a two-hop route out of mining, and its own header says the capability is
 * consumed by "the hero, the target picker and the EARN promo". SIMPLE did
 * consult it (`canProject`, `MineSimpleView.tsx`). The LANDSCAPE PRO console
 * did not: it rendered `EarnPromoStrip` unconditionally with
 * `projection?.targetTicker ?? MINED_TICKER`, and `MINED_TICKER` is the
 * literal `"XMR"` (`components/mine-simple.tsx`). So a Xelis session read
 *
 *     turn mined XMR into BTC when you're ready
 *
 * on the same screen whose SIMPLE mode correctly says XEL has no swap route
 * out of mining.
 *
 * Found 2026-09-15 by looking at the running landscape console during the
 * Xelis visual pass — not by a test, because no test asked what the PRO view
 * CLAIMS. This is that test. It is deliberately a source-proximity check
 * rather than "the file mentions capabilityFor": an import alone would satisfy
 * the weaker form, so it could not fail for the reason it is run.
 *
 * # 2026-09-16: the gate moved into one component
 *
 * The parity audit found the same claim leaking on two more paths: landscape
 * PRO's BAL chip and per-period rows multiplied by the XMR rate with no gate
 * (a Xelis session showed XEL × XMR→BTC, labelled BTC), and portrait PRO
 * rendered no promo at all. The promo, the chips and the capability note now
 * live behind ONE gate in `components/EarnCapabilityBlock.tsx`. So the
 * proximity check runs on that component, and every view is held to the
 * STRONGER rule: it may not render `EarnPromoStrip` or the chips itself.
 */
const BLOCK = "src/features/mining/components/EarnCapabilityBlock.tsx";

const VIEWS = [
  ["simple", "src/features/mining/MineSimpleView.tsx"],
  ["landscape PRO", "src/features/mining/MineLandscapeView.tsx"],
  ["portrait PRO", "src/features/mining/MiningView.tsx"],
] as const;

/** How far back from the promo the gate may sit. */
const WINDOW = 1600;

/** Source with comments removed, so a comment can neither satisfy nor trip a check. */
function code(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function walk(node: unknown, out: string[]): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out));
    return;
  }
  if (typeof node !== "object") return;
  const el = node as ReactElement & { type?: unknown; props?: Record<string, unknown> };
  const props = (el.props ?? {}) as Record<string, unknown>;
  if (typeof el.type === "function") {
    try {
      walk((el.type as (p: unknown) => unknown)(props), out);
      return;
    } catch {
      /* hook-dependent child — fall through to its declared children */
    }
  }
  walk(props.children, out);
}

const btcProjection: MiningProjection = {
  targetTicker: "BTC",
  ratePerXmr: 0.0021,
  xmrPriceUsd: 150,
  fromEarnTarget: false,
};

function saidBy(coin: "xelis" | "monero"): string {
  const out: string[] = [];
  walk(
    EarnCapabilityBlock({
      asset: minedAssetView({ miningCoin: coin, projection: btcProjection, minedAmount: 1 }),
      onOpenEarn: () => {},
      onSelectDisplayCoin: () => {},
      compact: true,
    }),
    out,
  );
  return out.join(" ");
}

describe("EARN promo capability gate", () => {
  it("XEL is the case this guards — it has no route out of mining", () => {
    expect(capabilityFor("xelis").kind).not.toBe("route");
  });

  it("the shared block renders the EARN promo only inside a capability gate", () => {
    const src = code(BLOCK);
    for (const tag of ["<EarnPromoStrip", "<DisplayCoinChips"]) {
      const idx = src.indexOf(tag);
      expect(idx, `EarnCapabilityBlock should still render ${tag}`).toBeGreaterThan(-1);
      const preceding = src.slice(Math.max(0, idx - WINDOW), idx);
      expect(
        preceding.includes("canProject"),
        `EarnCapabilityBlock renders ${tag} with no capability gate in the ${WINDOW} ` +
          "characters before it. A coin whose capability is not `route` then " +
          'advertises "turn mined XMR into <target>" — the promo names MINED_TICKER, ' +
          "which is the literal XMR. See minedAssetCapability.ts.",
      ).toBe(true);
    }
  });

  it("a Xelis session is told why, and is never offered a conversion", () => {
    const said = saidBy("xelis");
    expect(said).toContain("XEL has no swap route out of mining");
    expect(said.toLowerCase()).not.toContain("turn mined");
    expect(said).not.toContain("BTC");
  });

  it("an XMR session is still offered EARN, in the chosen coin", () => {
    const said = saidBy("monero");
    expect(said.toLowerCase()).toContain("turn mined");
    expect(said).toContain("BTC");
    expect(said).not.toContain("no swap route");
  });

  for (const [label, rel] of VIEWS) {
    it(`${label} never renders the promo or the chips itself`, () => {
      const src = code(rel);
      for (const tag of ["<EarnPromoStrip", "<DisplayCoinChips"]) {
        expect(
          src.includes(tag),
          `${label} renders ${tag} directly. Mount <EarnCapabilityBlock> instead — ` +
            "a per-view copy of the gate is how landscape PRO advertised XMR→BTC " +
            "to a Xelis miner, and how portrait PRO offered XMR miners no EARN at all.",
        ).toBe(false);
      }
    });

    it(`${label} mounts the shared block with the capability-decided asset`, () => {
      const src = code(rel);
      expect(src).toContain("useMinedAssetView(");
      const block = src.match(/<EarnCapabilityBlock[\s\S]*?\/>/);
      expect(block, `${label} should mount <EarnCapabilityBlock>`).not.toBeNull();
      expect(block![0]).toContain("asset={asset}");
    });
  }

  for (const [label, rel] of VIEWS.slice(1)) {
    it(`${label} mounts the block in the PRO branch, not only via SIMPLE`, () => {
      const src = code(rel);
      const simpleAt = src.indexOf("<MineSimpleView");
      const blockAt = src.indexOf("<EarnCapabilityBlock");
      expect(simpleAt).toBeGreaterThan(-1);
      // The SIMPLE early return comes first in both PRO files; a block that
      // only appeared before it would be SIMPLE's, which PRO never renders.
      expect(blockAt).toBeGreaterThan(simpleAt);
      expect(src).toMatch(/onOpenEarn=\{onOpenEarn\}/);
    });
  }

  it("landscape PRO's balance chip only projects inside the gate", () => {
    const src = code("src/features/mining/MineLandscapeView.tsx");
    const bal = src.indexOf("BAL ");
    expect(bal, "landscape PRO should still render the BAL chip").toBeGreaterThan(-1);
    const preceding = src.slice(Math.max(0, bal - WINDOW), bal);
    expect(
      preceding.includes("canProject"),
      "the BAL chip projects a balance through the XMR rate; with no " +
        "`canProject` gate before it a non-XMR session shows a converted balance " +
        "it does not have.",
    ).toBe(true);
  });

  it("landscape PRO's per-period rows go through the asset view", () => {
    const src = code("src/features/mining/MineLandscapeView.tsx");
    const start = src.indexOf("const proProjectionRows");
    expect(start).toBeGreaterThan(-1);
    const rows = src.slice(start, src.indexOf("];", start));
    expect(rows).toContain("asset.formatDisplay(");
    expect(rows).not.toMatch(/ratePerXmr|projection\??\./);
  });

  it("every mineable coin without a route is covered by that gate", () => {
    for (const coin of ["xelis", "zephyr", "zano", "ravencoin", "conflux", "ergo"] as const) {
      expect(capabilityFor(coin).kind).not.toBe("route");
    }
  });
});
